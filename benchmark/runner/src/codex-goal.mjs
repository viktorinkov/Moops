import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import { validateArmUsage, validateRuntimeCapabilities } from "./arm-policy.mjs";

const MAX_PROTOCOL_LINE_BYTES = 16_777_216;
const TERMINAL_GOAL_STATUSES = new Set([
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
const GOAL_CONTROL_SUFFIX = [
  "",
  "MOOPS DURABLE GOAL CONTROL (identical in every benchmark arm):",
  "Continue independently until the full task and its shared real-app acceptance path pass.",
  "Do not treat a partial implementation, Preview-only proof, or intermediate turn as completion.",
  "Mark this Goal complete only after the shared acceptance passes; otherwise keep the Goal active,",
  "or mark it blocked only when the Goal protocol's blocking threshold is genuinely satisfied.",
].join("\n");

export function buildGoalObjective(prompt) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new CodexGoalError("E_GOAL_OBJECTIVE", "feature prompt must be non-empty");
  }
  const objective = `${prompt.trimEnd()}\n${GOAL_CONTROL_SUFFIX}`;
  if ([...objective].length > 4_000) {
    throw new CodexGoalError("E_GOAL_OBJECTIVE", "feature prompt plus Goal control exceeds 4,000 characters");
  }
  return objective;
}

export class CodexGoalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodexGoalError";
    this.code = code;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, reject, resolve };
}

function killProcessGroup(child, signal) {
  if (!Number.isInteger(child.pid) || child.pid < 1) return;
  try {
    process.kill(-child.pid, signal);
  } catch (cause) {
    if (cause.code !== "ESRCH") throw cause;
  }
}

function requireGoal(goal, objective, context) {
  if (!goal || goal.objective !== objective || typeof goal.status !== "string") {
    throw new CodexGoalError(
      "E_GOAL_EVIDENCE",
      `${context} did not return the exact configured goal`,
    );
  }
  return goal;
}

async function openExclusive(paths) {
  const handles = [];
  try {
    for (const path of paths) handles.push(await open(path, "wx"));
    return handles;
  } catch (cause) {
    await Promise.allSettled(handles.map((handle) => handle.close()));
    throw cause;
  }
}

export async function runCodexGoal(argv, options) {
  const startedEpochMs = Date.now();
  const startedMonotonicNs = process.hrtime.bigint().toString();
  const [stdoutHandle, stderrHandle, requestsHandle] = await openExclusive([
    options.stdoutPath,
    options.stderrPath,
    options.requestsPath,
  ]);
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (cause) {
    await Promise.all([stdoutHandle.close(), stderrHandle.close(), requestsHandle.close()]);
    return {
      exitCode: null,
      signal: null,
      serverExitCode: null,
      timedOut: false,
      spawnError: cause.message,
      protocolError: null,
      startedEpochMs,
      startedMonotonicNs,
      endedEpochMs: Date.now(),
      goal: null,
      threadId: null,
      turns: [],
      trailingEvidence: [],
    };
  }

  let requestId = 0;
  let protocolError = null;
  let timedOut = false;
  let closing = false;
  let threadId = null;
  let terminalGoal = null;
  let terminalGoalNotification = null;
  let activatedEpochMs = null;
  let activatedMonotonicNs = null;
  let activationRequested = false;
  let activeGoalObserved = false;
  let activeTurnObserved = false;
  let activeGoalTurnId = null;
  let capabilityEvidence = null;
  let usageEvidence = null;
  const pending = new Map();
  const activeTurns = new Set();
  const startedTurnIds = new Set();
  const turns = [];
  const trailingEvidence = [];
  const mcpCalls = [];
  const commands = [];
  const fileChanges = [];
  const completion = deferred();
  const activationEvidence = deferred();
  const settingsEvidence = deferred();
  const pausedGoalEvidence = deferred();
  const protocolFailure = deferred();
  protocolFailure.promise.catch(() => {});

  const failProtocol = (cause) => {
    if (protocolError) return;
    protocolError = cause instanceof CodexGoalError
      ? cause
      : new CodexGoalError("E_GOAL_PROTOCOL", cause instanceof Error ? cause.message : String(cause));
    protocolFailure.reject(protocolError);
    for (const waiter of pending.values()) waiter.reject(protocolError);
    pending.clear();
    killProcessGroup(child, "SIGTERM");
  };

  const closeState = deferred();
  let spawnError = null;
  child.on("error", (cause) => {
    spawnError = cause.message;
    if (!closing) failProtocol(new CodexGoalError("E_GOAL_SPAWN", cause.message));
  });
  child.on("close", (exitCode, signal) => {
    closeState.resolve({ exitCode, signal });
    if (!closing && !terminalGoal) {
      failProtocol(new CodexGoalError(
        "E_GOAL_EARLY_EXIT",
        `Codex app-server exited before terminal goal evidence (exit ${exitCode}, signal ${signal})`,
      ));
    }
  });

  const stderrWrites = [];
  child.stderr.on("data", (chunk) => {
    stderrWrites.push(stderrHandle.write(chunk));
  });

  const emitEvidence = async (type, data) => {
    await options.onEvidence?.({ type, ...data });
  };

  const maybeComplete = () => {
    if (terminalGoal && activeTurns.size === 0) completion.resolve(terminalGoal);
  };

  const maybeConfirmActivation = () => {
    if (activationRequested
      && activeGoalObserved
      && activeTurnObserved
      && typeof activeGoalTurnId === "string"
      && startedTurnIds.has(activeGoalTurnId)) {
      activationEvidence.resolve();
    }
  };

  const handleNotification = async (message) => {
    if (message.method === "item/completed") {
      const item = message.params?.item;
      if (message.params?.threadId !== threadId || !item || typeof item.type !== "string") {
        throw new CodexGoalError("E_GOAL_PROTOCOL", "item/completed omitted thread item evidence");
      }
      if (item.type === "mcpToolCall") {
        const resultText = JSON.stringify(item.result ?? {});
        const argumentsText = JSON.stringify(item.arguments ?? {});
        const record = {
          turnId: message.params.turnId,
          server: item.server,
          tool: item.tool,
          status: item.status,
          completedEpochMs: message.params.completedAtMs ?? null,
          durationMs: item.durationMs ?? null,
          error: item.error ?? null,
          argumentsText: argumentsText.length <= 65_536
            ? argumentsText
            : argumentsText.slice(0, 65_536),
          resultText: resultText.length <= 262_144 ? resultText : resultText.slice(0, 262_144),
        };
        mcpCalls.push(record);
        await emitEvidence("mcp.completed", {
          threadId,
          ...Object.fromEntries(Object.entries(record).filter(([key]) => (
            key !== "resultText" && key !== "argumentsText"
          ))),
          argumentsSHA256: `sha256:${createHash("sha256").update(argumentsText).digest("hex")}`,
          resultSHA256: `sha256:${createHash("sha256").update(resultText).digest("hex")}`,
        });
      }
      if (item.type === "commandExecution") {
        const aggregatedOutput = String(item.aggregatedOutput ?? "");
        const record = {
          turnId: message.params.turnId,
          command: item.command,
          status: item.status,
          exitCode: item.exitCode ?? null,
          cwd: item.cwd ?? null,
          completedEpochMs: message.params.completedAtMs ?? null,
          aggregatedOutput: aggregatedOutput.length <= 262_144
            ? aggregatedOutput
            : aggregatedOutput.slice(-262_144),
        };
        commands.push(record);
        await emitEvidence("command.completed", {
          threadId,
          ...Object.fromEntries(Object.entries(record).filter(([key]) => key !== "aggregatedOutput")),
          outputSHA256: `sha256:${createHash("sha256").update(aggregatedOutput).digest("hex")}`,
        });
      }
      if (item.type === "fileChange") {
        const record = {
          turnId: message.params.turnId,
          status: item.status,
          completedEpochMs: message.params.completedAtMs ?? null,
          changes: (item.changes ?? []).map(({ path, kind }) => ({ path, kind })),
        };
        fileChanges.push(record);
        await emitEvidence("file_change.completed", { threadId, ...record });
      }
      return;
    }
    if (message.method === "thread/settings/updated") {
      const settings = message.params?.threadSettings;
      const policy = settings?.sandboxPolicy;
      const observedRoots = Array.isArray(policy?.writableRoots) ? policy.writableRoots : [];
      const requiredSiblingRoots = options.writableRoots.filter((root) => root !== options.cwd);
      const rootsMatch = requiredSiblingRoots.every((root) => observedRoots.includes(root))
        && observedRoots.every((root) => options.writableRoots.includes(root));
      if (message.params?.threadId !== threadId
        || settings?.cwd !== options.cwd
        || settings?.model !== options.model
        || settings?.approvalPolicy !== "on-request"
        || settings?.approvalsReviewer !== "auto_review"
        || !new Set(["fast", "priority"]).has(settings?.serviceTier)
        || policy?.type !== "workspaceWrite"
        || policy?.networkAccess !== true
        || !rootsMatch) {
        throw new CodexGoalError(
          "E_GOAL_SETTINGS",
          "thread/settings/updated did not confirm the common model, cwd, or sandbox policy",
        );
      }
      settingsEvidence.resolve(settings);
      await emitEvidence("settings.verified", {
        threadId,
        requestedServiceTier: options.serviceTier,
        effectiveServiceTier: settings.serviceTier,
        settings,
      });
      return;
    }
    if (message.method === "turn/started") {
      if (!activationRequested) {
        throw new CodexGoalError(
          "E_GOAL_PREMATURE_TURN",
          "Codex started work before the synchronized Goal activation barrier",
        );
      }
      const turn = message.params?.turn;
      if (message.params?.threadId !== threadId || !turn || typeof turn.id !== "string") {
        throw new CodexGoalError("E_GOAL_PROTOCOL", "turn/started omitted turn.id");
      }
      activeTurns.add(turn.id);
      startedTurnIds.add(turn.id);
      if (activationRequested) activeTurnObserved = true;
      await emitEvidence("turn.started", { threadId, turnId: turn.id, status: turn.status });
      maybeConfirmActivation();
      return;
    }
    if (message.method === "turn/completed") {
      const turn = message.params?.turn;
      if (message.params?.threadId !== threadId
        || !turn
        || typeof turn.id !== "string"
        || typeof turn.status !== "string") {
        throw new CodexGoalError("E_GOAL_PROTOCOL", "turn/completed omitted turn evidence");
      }
      activeTurns.delete(turn.id);
      turns.push({
        id: turn.id,
        status: turn.status,
        durationMs: turn.durationMs ?? null,
        error: turn.error ?? null,
      });
      await emitEvidence("turn.completed", {
        threadId,
        turnId: turn.id,
        status: turn.status,
        durationMs: turn.durationMs ?? null,
        error: turn.error ?? null,
      });
      maybeComplete();
      return;
    }
    if (message.method === "thread/goal/updated") {
      const goal = requireGoal(message.params?.goal, options.objective, "goal update notification");
      if (message.params?.threadId !== threadId || goal.threadId !== threadId) {
        throw new CodexGoalError("E_GOAL_EVIDENCE", "goal update belongs to another thread");
      }
      await emitEvidence("goal.updated", {
        threadId,
        turnId: message.params?.turnId ?? null,
        goal,
      });
      if (!activationRequested && goal.status === "paused") {
        if (message.params?.turnId !== null) {
          throw new CodexGoalError("E_GOAL_EVIDENCE", "paused Goal update unexpectedly belonged to a turn");
        }
        pausedGoalEvidence.resolve(goal);
      }
      if (activationRequested && goal.status === "active") {
        activeGoalObserved = true;
        activeGoalTurnId = message.params?.turnId ?? null;
      }
      maybeConfirmActivation();
      if (TERMINAL_GOAL_STATUSES.has(goal.status)) {
        terminalGoal = goal;
        terminalGoalNotification = message;
        maybeComplete();
      }
    }
  };

  let messageQueue = Promise.resolve();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    messageQueue = messageQueue.then(async () => {
      if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
        throw new CodexGoalError("E_GOAL_PROTOCOL", "app-server protocol line exceeded 16 MiB");
      }
      await stdoutHandle.write(`${line}\n`);
      let message;
      try {
        message = JSON.parse(line);
      } catch (cause) {
        throw new CodexGoalError("E_GOAL_PROTOCOL", `app-server emitted invalid JSON: ${cause.message}`);
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new CodexGoalError("E_GOAL_PROTOCOL", "app-server emitted a non-object message");
      }
      if (closing && options.parseTrailingOutput) {
        const evidence = options.parseTrailingOutput(message);
        if (evidence !== undefined) {
          trailingEvidence.push(evidence);
          await emitEvidence("wrapper.evidence", { threadId, evidence });
          return;
        }
      }
      if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
        const waiter = pending.get(message.id);
        if (!waiter) throw new CodexGoalError("E_GOAL_PROTOCOL", `unexpected response id ${message.id}`);
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(new CodexGoalError(
            "E_GOAL_RPC",
            `app-server ${waiter.method} failed: ${JSON.stringify(message.error)}`,
          ));
        } else {
          waiter.resolve(message.result);
        }
        return;
      }
      if (Object.hasOwn(message, "id") && typeof message.method === "string") {
        throw new CodexGoalError(
          "E_GOAL_SERVER_REQUEST",
          `unattended benchmark cannot answer server request ${message.method}`,
        );
      }
      if (typeof message.method !== "string") {
        throw new CodexGoalError("E_GOAL_PROTOCOL", "app-server message omitted method or response id");
      }
      await handleNotification(message);
    }).catch(failProtocol);
  });

  async function send(message) {
    if (protocolError) throw protocolError;
    const source = `${JSON.stringify(message)}\n`;
    await requestsHandle.write(source);
    await new Promise((resolve, reject) => {
      child.stdin.write(source, (cause) => (cause ? reject(cause) : resolve()));
    });
  }

  async function request(method, params) {
    const id = ++requestId;
    const response = deferred();
    pending.set(id, { ...response, method });
    try {
      await send({ method, id, params });
    } catch (cause) {
      pending.delete(id);
      throw cause;
    }
    return response.promise;
  }

  const deadline = deferred();
  let deadlineTimer;
  const stagingTimer = setTimeout(() => {
    failProtocol(new CodexGoalError("E_GOAL_STAGING_TIMEOUT", "goal staging exceeded 60 seconds"));
  }, options.stagingTimeoutMs ?? 60_000);
  stagingTimer.unref();

  let persistedGoal = null;
  try {
    const initialize = await request("initialize", {
      clientInfo: {
        name: "moops_benchmark_runner",
        title: "MOOPS Benchmark Runner",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    await emitEvidence("initialized", { initialize });
    await send({ method: "initialized", params: {} });

    const mcpResult = await request("mcpServerStatus/list", {
      detail: "toolsAndAuthOnly",
      limit: 100,
    });
    const pluginResult = await request("plugin/list", {
      cwds: [options.cwd],
      forceRefetch: false,
      marketplaceKinds: ["local"],
    });
    try {
      capabilityEvidence = validateRuntimeCapabilities(options.armId, mcpResult, pluginResult);
    } catch (cause) {
      throw new CodexGoalError(cause.code ?? "E_CAPABILITY_INVENTORY", cause.message);
    }
    await emitEvidence("capabilities.verified", {
      armId: options.armId,
      capabilityEvidence,
    });

    const threadResult = await request("thread/start", {
      cwd: options.cwd,
      model: options.model,
      serviceTier: options.serviceTier,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
      ephemeral: false,
      developerInstructions: options.developerInstructions,
      serviceName: "moops_benchmark_runner",
    });
    threadId = threadResult?.thread?.id;
    if (typeof threadId !== "string" || threadId === "") {
      throw new CodexGoalError("E_GOAL_EVIDENCE", "thread/start omitted thread.id");
    }
    await emitEvidence("thread.started", {
      threadId,
      model: options.model,
      serviceTier: options.serviceTier,
      effectiveModel: threadResult.model ?? null,
      effectiveServiceTier: threadResult.serviceTier ?? null,
      effectiveApprovalPolicy: threadResult.approvalPolicy ?? null,
      effectiveSandbox: threadResult.sandbox ?? null,
      cwd: options.cwd,
    });

    const setResult = await request("thread/goal/set", {
      threadId,
      objective: options.objective,
      status: "paused",
    });
    const configuredGoal = requireGoal(setResult?.goal, options.objective, "thread/goal/set");
    if (configuredGoal.threadId !== threadId || configuredGoal.status !== "paused") {
      throw new CodexGoalError("E_GOAL_EVIDENCE", "thread/goal/set did not stage a paused thread goal");
    }
    await emitEvidence("goal.staged", {
      threadId,
      goal: configuredGoal,
      objectiveBytes: Buffer.byteLength(options.objective),
    });

    const getResult = await request("thread/goal/get", { threadId });
    const verifiedGoal = requireGoal(getResult?.goal, options.objective, "thread/goal/get");
    if (verifiedGoal.threadId !== threadId
      || verifiedGoal.status !== "paused"
      || verifiedGoal.tokensUsed !== 0
      || verifiedGoal.timeUsedSeconds !== 0) {
      throw new CodexGoalError(
        "E_GOAL_EVIDENCE",
        "persisted staged goal was not paused with zero usage before the barrier",
      );
    }
    const pausedNotificationGoal = await Promise.race([
      pausedGoalEvidence.promise,
      protocolFailure.promise,
    ]);
    if (pausedNotificationGoal.status !== "paused") {
      throw new CodexGoalError("E_GOAL_EVIDENCE", "paused goal notification was not observed");
    }
    await emitEvidence("goal.verified_paused", { threadId, goal: verifiedGoal });
    await request("thread/settings/update", {
      threadId,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      cwd: options.cwd,
      model: options.model,
      serviceTier: options.serviceTier,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: options.writableRoots,
        networkAccess: true,
      },
    });
    await Promise.race([settingsEvidence.promise, protocolFailure.promise]);
    clearTimeout(stagingTimer);
    const clocks = await Promise.race([
      options.waitForStart({ threadId, goal: verifiedGoal }),
      protocolFailure.promise,
    ]);
    if (!clocks || !Number.isSafeInteger(clocks.deadlineEpochMs)) {
      throw new CodexGoalError("E_GOAL_BARRIER", "start barrier omitted the common deadline");
    }
    const remainingMs = Math.max(0, clocks.deadlineEpochMs - Date.now());
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      deadline.resolve();
      killProcessGroup(child, "SIGTERM");
    }, remainingMs);
    deadlineTimer.unref();

    activationRequested = true;
    activatedEpochMs = Date.now();
    activatedMonotonicNs = process.hrtime.bigint().toString();
    await emitEvidence("goal.activating", {
      threadId,
      startEpochMs: clocks.startEpochMs,
      startMonotonicNs: clocks.startMonotonicNs,
      deadlineEpochMs: clocks.deadlineEpochMs,
      activatedEpochMs,
      activatedMonotonicNs,
    });
    const activeResult = await request("thread/goal/set", { threadId, status: "active" });
    const activeGoal = requireGoal(activeResult?.goal, options.objective, "activating thread/goal/set");
    if (activeGoal.threadId !== threadId || activeGoal.status !== "active") {
      throw new CodexGoalError("E_GOAL_EVIDENCE", "barrier activation did not return an active goal");
    }
    await emitEvidence("goal.activation_accepted", { threadId, goal: activeGoal });
    await Promise.race([
      activationEvidence.promise,
      protocolFailure.promise,
      deadline.promise.then(() => {
        throw new CodexGoalError("E_GOAL_DEADLINE", "goal activation evidence missed the deadline");
      }),
    ]);
    await emitEvidence("goal.activation_verified", { threadId });

    await Promise.race([
      completion.promise,
      protocolFailure.promise,
      deadline.promise.then(() => {
        throw new CodexGoalError("E_GOAL_DEADLINE", "goal did not reach a terminal state before deadline");
      }),
    ]);
    if (!terminalGoalNotification) {
      throw new CodexGoalError("E_GOAL_EVIDENCE", "terminal goal notification was not observed");
    }
    const finalResult = await request("thread/goal/get", { threadId });
    persistedGoal = requireGoal(finalResult?.goal, options.objective, "final thread/goal/get");
    if (persistedGoal.threadId !== threadId || persistedGoal.status !== terminalGoal.status) {
      throw new CodexGoalError("E_GOAL_EVIDENCE", "terminal goal was not persisted consistently");
    }
    try {
      usageEvidence = validateArmUsage(
        options.armId,
        mcpCalls,
        commands,
        options.memoryCheckpoints,
        options.expectedWorkspace,
        {
          simulatorUdid: options.env?.MOOPS_BENCHMARK_SIMULATOR_UDID,
          derivedData: options.env?.MOOPS_BENCHMARK_DERIVED_DATA,
        },
      );
    } catch (cause) {
      throw new CodexGoalError(cause.code ?? "E_ARM_USAGE", cause.message);
    }
    await emitEvidence("usage.verified", { threadId, armId: options.armId, usageEvidence });
    await emitEvidence("goal.final", { threadId, goal: persistedGoal, turns });
  } catch (cause) {
    if (!protocolError) {
      protocolError = cause instanceof CodexGoalError
        ? cause
        : new CodexGoalError("E_GOAL_PROTOCOL", cause instanceof Error ? cause.message : String(cause));
    }
    if (!activationRequested) await options.onStagingFailure?.(protocolError);
  } finally {
    clearTimeout(stagingTimer);
    clearTimeout(deadlineTimer);
    closing = true;
    child.stdin.end();
    const graceful = await Promise.race([
      closeState.promise.then(() => true),
      delay(options.gracefulShutdownMs ?? 500, undefined, { ref: false }).then(() => false),
    ]);
    if (!graceful) killProcessGroup(child, "SIGTERM");
    const terminated = await Promise.race([
      closeState.promise.then(() => true),
      delay(options.forceShutdownMs ?? 1_000, undefined, { ref: false }).then(() => false),
    ]);
    if (!terminated) killProcessGroup(child, "SIGKILL");
  }

  const serverExit = await closeState.promise;
  await messageQueue.catch(() => {});
  await Promise.allSettled(stderrWrites);
  lines.close();
  await Promise.all([stdoutHandle.close(), stderrHandle.close(), requestsHandle.close()]);
  const endedEpochMs = Date.now();
  const completed = persistedGoal?.status === "complete"
    && terminalGoal?.status === "complete"
    && serverExit.exitCode === 0
    && serverExit.signal === null
    && spawnError === null
    && protocolError === null
    && turns.length > 0
    && turns.every(({ status }) => status === "completed")
    && typeof terminalGoalNotification?.params?.turnId === "string"
    && turns.some(({ id, status }) => id === terminalGoalNotification.params.turnId
      && status === "completed");
  return {
    exitCode: completed ? 0 : 1,
    signal: serverExit.signal,
    serverExitCode: serverExit.exitCode,
    timedOut,
    spawnError,
    protocolError: protocolError ? { code: protocolError.code, message: protocolError.message } : null,
    startedEpochMs,
    startedMonotonicNs,
    endedEpochMs,
    durationMs: endedEpochMs - startedEpochMs,
    measuredDurationMs: activatedEpochMs === null ? null : endedEpochMs - activatedEpochMs,
    activatedEpochMs,
    activatedMonotonicNs,
    threadId,
    goal: persistedGoal ?? terminalGoal,
    turns,
    capabilityEvidence,
    usageEvidence,
    mcpCalls: mcpCalls.map(({ resultText: _resultText, ...call }) => call),
    commands,
    fileChanges,
    trailingEvidence,
    completionEvidence: terminalGoalNotification ? {
      notificationMethod: terminalGoalNotification.method,
      notificationTurnId: terminalGoalNotification.params?.turnId ?? null,
      persistedStatus: persistedGoal?.status ?? null,
      objectiveSHA256: `sha256:${createHash("sha256").update(options.objective).digest("hex")}`,
    } : null,
  };
}
