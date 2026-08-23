import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { prepareAcceptanceRun } from "./acceptance.mjs";
import { armPolicy } from "./arm-policy.mjs";
import { startDedicatedBackends, stopDedicatedBackends } from "./backend.mjs";
import {
  CLAUDE_MEM_ARM_ID,
  claudeMemRunId,
  parseClaudeMemWorkerEvidence,
  prepareClaudeMemArm,
  verifyClaudeMemArm,
  wrapClaudeMemCommand,
} from "./claude-mem.mjs";
import { buildGoalObjective, runCodexGoal } from "./codex-goal.mjs";
import { prepareCodexHomes, scrubTreatmentEnvironment } from "./codex-home.mjs";
import { renderArgv } from "./config.mjs";
import { EventLedger } from "./ledger.mjs";
import {
  INJECTION_ARM_ID,
  prepareInjectionIIIArm,
  verifyInjectionIIIArm,
} from "./injectioniii.mjs";
import { preflightBenchmark } from "./preflight.mjs";
import { runLoggedProcess } from "./process.mjs";

class StartBarrier {
  constructor(size) {
    this.size = size;
    this.arrivals = 0;
    this.settled = false;
    this.allReady = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.started = new Promise((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    this.started.catch(() => {});
  }

  arrive() {
    this.arrivals += 1;
    if (this.arrivals === this.size) this.resolveReady();
    return this.started;
  }

  release(value) {
    if (this.settled) return;
    this.settled = true;
    this.resolveStarted(value);
  }

  fail(cause) {
    if (this.settled) return;
    this.settled = true;
    this.rejectReady(cause);
    this.rejectStarted(cause);
  }
}

function errorRecord(cause) {
  return {
    code: cause?.code ?? "E_INTERNAL",
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function parseMoopsReport(commands) {
  const candidate = [...(commands ?? [])].reverse().find(({ command, aggregatedOutput }) => (
    typeof command === "string"
    && command.includes("tools/moops/moops build-and-restore")
    && typeof aggregatedOutput === "string"
  ));
  if (!candidate) return null;
  const start = candidate.aggregatedOutput.indexOf("{");
  const end = candidate.aggregatedOutput.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const report = JSON.parse(candidate.aggregatedOutput.slice(start, end + 1));
    if (report?.ok !== true || report.command !== "build-and-restore" || !report.timingsMs) return null;
    return {
      source: "tools/moops/moops build-and-restore JSON report",
      timingsMs: report.timingsMs,
      phases: report.phases,
    };
  } catch {
    return null;
  }
}

function benchmarkMetrics(command, testResult, startEpochMs, completedEpochMs, passed) {
  const feedbackEpochs = [
    ...(command.mcpCalls ?? [])
      .filter(({ server, status }) => server === "xcode" && status === "completed")
      .map(({ completedEpochMs: value }) => value),
    ...(command.commands ?? [])
      .filter(({ status, command: source }) => status === "completed"
        && typeof source === "string" && /(?:^|\s)(?:\/usr\/bin\/)?xcrun\s+simctl\s+launch(?:\s|$)/.test(source))
      .map(({ completedEpochMs: value }) => value),
  ].filter((value) => Number.isSafeInteger(value) && value >= startEpochMs);
  const buildCommandIterations = (command.commands ?? []).filter(({ command: source }) => (
    typeof source === "string" && /(?:^|\s)(?:\/usr\/bin\/)?(?:xcrun\s+)?xcodebuild(?:\s|$)/.test(source)
      && !/\btest(?:-without-building)?\b/.test(source)
  )).length;
  const buildMCPIterations = (command.mcpCalls ?? []).filter(({ server, tool }) => (
    server === "xcode" && /build/i.test(tool) && !/test/i.test(tool)
  )).length;
  const agentVerificationIterations = (command.commands ?? []).filter(({ command: source }) => (
    typeof source === "string" && /xcodebuild/.test(source) && /\btest(?:-without-building)?\b/.test(source)
  )).length + (command.mcpCalls ?? []).filter(({ server, tool }) => (
    server === "xcode" && /test/i.test(tool)
  )).length;
  return {
    semantics: "online Goal-loop/tool throughput; no model weights are trained",
    goalActivatedToAgentCompletionMs: command.measuredDurationMs ?? null,
    timeToFirstRealAppFeedbackMs: feedbackEpochs.length > 0
      ? Math.min(...feedbackEpochs) - startEpochMs
      : null,
    timeToFirstRealAppFeedbackBasis: feedbackEpochs.length > 0
      ? "first successful Xcode MCP or simctl launch completion"
      : "not observed in structured app-server evidence",
    buildIterationCount: buildCommandIterations + buildMCPIterations,
    agentVerificationIterationCount: agentVerificationIterations,
    sharedAcceptanceIterationCount: testResult.status === "not_run" ? 0 : 1,
    sharedAcceptanceDurationMs: testResult.durationMs ?? null,
    stateReconstructionAndRestore: parseMoopsReport(command.commands),
    totalTimeToGreenMs: passed ? Math.max(0, completedEpochMs - startEpochMs) : null,
  };
}

function safeRunId(value) {
  if (value !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
      throw new Error("runId must use 1 through 64 safe filename characters");
    }
    return value;
  }
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export async function emitCountdown(options) {
  for (let value = options.seconds; value >= 1; value -= 1) {
    const tickStarted = Date.now();
    await options.ledger.emit("run.countdown", {
      value,
      startEpochMs: options.startEpochMs,
    });
    options.status(`START IN ${value}`);
    await options.onTick?.(value);
    await options.sleep(Math.max(0, 1_000 - (Date.now() - tickStarted)));
  }
}

function templateVariables(manifest, arm, context) {
  return {
    ARM_ID: arm.id,
    ARM_LABEL: arm.label,
    BACKEND_BASE_URL: context.backendBaseURL,
    BACKEND_FIXTURE_REVISION: manifest.backendFixtureRevision,
    BACKEND_PORT: String(arm.backendPort),
    DEADLINE_EPOCH_MS: String(context.deadlineEpochMs),
    DERIVED_DATA: arm.derivedData,
    MODEL: manifest.model,
    PROMPT_PATH: manifest.promptPath,
    PROMPT_SHA256: context.promptSHA256,
    RESULTS_DIR: context.resultDirectory,
    RUN_ID: context.runId,
    SERVICE_TIER: manifest.serviceTier,
    SIMULATOR_UDID: arm.simulatorUdid,
    START_EPOCH_MS: String(context.startEpochMs),
    WORKTREE: arm.worktree,
  };
}

function armEnvironment(manifest, arm, variables, codexHome) {
  const environment = {
    ...scrubTreatmentEnvironment(process.env),
    ...arm.environment,
    CODEX_HOME: codexHome.home,
    MOOPS_BACKEND_BASE_URL: variables.BACKEND_BASE_URL,
    MOOPS_BENCHMARK_RUN_ID: variables.RUN_ID,
    MOOPS_BENCHMARK_ARM_ID: arm.id,
    MOOPS_BENCHMARK_ARM_LABEL: arm.label,
    MOOPS_BENCHMARK_WORKTREE: arm.worktree,
    MOOPS_BENCHMARK_SIMULATOR_UDID: arm.simulatorUdid,
    MOOPS_BENCHMARK_DERIVED_DATA: arm.derivedData,
    MOOPS_BENCHMARK_RESULTS_DIR: variables.RESULTS_DIR,
    MOOPS_BENCHMARK_PROMPT_PATH: manifest.promptPath,
    MOOPS_BENCHMARK_PROMPT_SHA256: variables.PROMPT_SHA256,
    MOOPS_BENCHMARK_MODEL: manifest.model,
    MOOPS_BENCHMARK_SERVICE_TIER: manifest.serviceTier,
    MOOPS_BENCHMARK_START_EPOCH_MS: variables.START_EPOCH_MS,
    MOOPS_BENCHMARK_DEADLINE_EPOCH_MS: variables.DEADLINE_EPOCH_MS,
    SIMCTL_CHILD_MOOPS_BACKEND_BASE_URL: variables.BACKEND_BASE_URL,
    SIMCTL_CHILD_MOOPS_BENCHMARK_RUN_ID: variables.RUN_ID,
    SIMCTL_CHILD_MOOPS_BENCHMARK_ARM_ID: arm.id,
    SIMCTL_CHILD_MOOPS_BENCHMARK_ARM_LABEL: arm.label,
    SIMCTL_CHILD_MOOPS_BENCHMARK_START_EPOCH_MS: variables.START_EPOCH_MS,
    SIMCTL_CHILD_MOOPS_BENCHMARK_DEADLINE_EPOCH_MS: variables.DEADLINE_EPOCH_MS,
  };
  if (arm.id === "codex-injection") {
    environment.SIMCTL_CHILD_MOOPS_ENABLE_INJECTIONIII = "1";
  }
  if (arm.id === CLAUDE_MEM_ARM_ID) {
    environment.MOOPS_CLAUDE_MEM_RUN_ID = claudeMemRunId(variables.RUN_ID);
  }
  return environment;
}

async function runArm(manifest, arm, context) {
  const barrierValue = context.clocks;
  const variables = templateVariables(manifest, arm, {
    ...context,
    ...barrierValue,
    backendBaseURL: context.backend.baseURL,
  });
  const environment = armEnvironment(manifest, arm, variables, context.codexHome);
  const expectedWorkspace = join(
    arm.worktree,
    "benchmark/FoodDelivery/Food Delivery.xcodeproj",
  );
  const baseArgv = renderArgv(manifest.agentCommand, variables);
  const policy = armPolicy(arm.id);
  const argv = arm.id === CLAUDE_MEM_ARM_ID
    ? context.wrapClaudeMem(baseArgv, context.claudeMemPreparation)
    : baseArgv;
  context.states[arm.id] = "staging";
  await context.ledger.emit("arm.staging.started", {
    armId: arm.id,
    armLabel: arm.label,
    command: argv,
    commit: context.preflight.arms[arm.id].commit,
    promptSHA256: context.preflight.promptSHA256,
    developerInstructions: policy.instructions,
    memoryCheckpoints: arm.id === CLAUDE_MEM_ARM_ID
      ? context.claudeMemPreparation.memoryCheckpoints
      : [],
    developerInstructionsSHA256: policy.sha256,
    xcodeBinding: {
      pid: Number(environment.MCP_XCODE_PID),
      expectedWorkspace,
    },
  });
  const runGoal = context.runGoal ?? runCodexGoal;
  const command = await runGoal(argv, {
    cwd: arm.worktree,
    env: environment,
    objective: context.goalObjective,
    armId: arm.id,
    developerInstructions: policy.instructions,
    expectedWorkspace,
    memoryCheckpoints: arm.id === CLAUDE_MEM_ARM_ID
      ? context.claudeMemPreparation.memoryCheckpoints
      : [],
    model: manifest.model,
    serviceTier: manifest.serviceTier,
    writableRoots: [arm.derivedData, arm.results],
    stdoutPath: join(context.resultDirectory, "agent.stdout.jsonl"),
    stderrPath: join(context.resultDirectory, "agent.stderr.log"),
    requestsPath: join(context.resultDirectory, "agent.requests.jsonl"),
    parseTrailingOutput: arm.id === CLAUDE_MEM_ARM_ID
      ? (message) => context.parseClaudeMemEvidence(message, context.claudeMemPreparation)
      : undefined,
    gracefulShutdownMs: arm.id === CLAUDE_MEM_ARM_ID ? 15_000 : 500,
    forceShutdownMs: 2_000,
    waitForStart: async ({ threadId }) => {
      context.states[arm.id] = "ready";
      await context.ledger.emit("arm.staging.ready", { armId: arm.id, threadId });
      return context.barrier.arrive();
    },
    onStagingFailure: async (cause) => context.barrier.fail(cause),
    onEvidence: async (evidence) => {
      await context.ledger.emit(`arm.codex.${evidence.type}`, {
        armId: arm.id,
        ...Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "type")),
      });
      if (evidence.type === "goal.activating") {
        context.states[arm.id] = "goal";
        await context.ledger.emit("arm.started", {
          armId: arm.id,
          armLabel: arm.label,
          command: argv,
          commit: context.preflight.arms[arm.id].commit,
          promptSHA256: context.preflight.promptSHA256,
          startEpochMs: barrierValue.startEpochMs,
          deadlineEpochMs: barrierValue.deadlineEpochMs,
          activatedEpochMs: evidence.activatedEpochMs,
          activatedMonotonicNs: evidence.activatedMonotonicNs,
        });
      }
    },
  });
  await context.ledger.emit("arm.command.exited", {
    armId: arm.id,
    exitCode: command.exitCode,
    signal: command.signal,
    timedOut: command.timedOut,
    durationMs: command.durationMs,
    spawnError: command.spawnError,
    protocolError: command.protocolError,
    goalStatus: command.goal?.status ?? null,
  });

  let claudeMem = null;
  if (arm.id === CLAUDE_MEM_ARM_ID) {
    try {
      claudeMem = await context.verifyClaudeMem(context.claudeMemPreparation, {
        arm,
        command,
        codexHome: context.codexHome,
        ledger: context.ledger,
        resultDirectory: context.resultDirectory,
      });
    } catch (cause) {
      claudeMem = { ok: false, error: errorRecord(cause) };
      await context.ledger.emit("claude_mem.postflight.failed", {
        armId: arm.id,
        error: claudeMem.error,
      });
    }
  }

  let injectionIII = null;
  if (arm.id === INJECTION_ARM_ID) {
    try {
      injectionIII = await context.verifyInjectionIII(context.injectionPreparation, {
        arm,
        command,
        ledger: context.ledger,
        resultDirectory: context.resultDirectory,
      });
    } catch (cause) {
      injectionIII = { ok: false, error: errorRecord(cause) };
      await context.ledger.emit("injection.postflight.failed", {
        armId: arm.id,
        error: injectionIII.error,
      });
    }
  }

  const agentPassed = command.exitCode === 0
    && command.goal?.status === "complete"
    && !command.timedOut
    && command.spawnError === null
    && command.protocolError === null
    && (arm.id !== CLAUDE_MEM_ARM_ID || claudeMem?.ok === true)
    && (arm.id !== INJECTION_ARM_ID || injectionIII?.ok === true);

  let testResult = { status: "not_run", reason: "agent command did not pass" };
  if (agentPassed) {
    context.states[arm.id] = "acceptance";
    let prepared;
    try {
      prepared = await context.prepareAcceptance({
        manifest,
        arm,
        variables,
        clocks: {
          startEpochMs: barrierValue.startEpochMs,
          deadlineEpochMs: barrierValue.deadlineEpochMs,
          backendBaseURL: context.backend.baseURL,
        },
      });
      await context.ledger.emit("arm.test.prepared", {
        armId: arm.id,
        command: prepared.argv,
        xctestrunSource: prepared.xctestrunSource,
        injectedEnvironment: prepared.injectedEnvironment,
      });
      const testProcess = await runLoggedProcess(prepared.argv, {
        cwd: arm.worktree,
        env: environment,
        deadlineEpochMs: barrierValue.deadlineEpochMs,
        stdoutPath: join(context.resultDirectory, "acceptance.stdout.log"),
        stderrPath: join(context.resultDirectory, "acceptance.stderr.log"),
      });
      testResult = {
        status: testProcess.exitCode === 0 && !testProcess.timedOut ? "passed" : "failed",
        ...testProcess,
      };
      await context.ledger.emit("arm.test.exited", {
        armId: arm.id,
        status: testResult.status,
        exitCode: testProcess.exitCode,
        signal: testProcess.signal,
        timedOut: testProcess.timedOut,
        durationMs: testProcess.durationMs,
      });
      if (testResult.status === "passed" && context.afterAcceptance) {
        try {
          const visual = await context.afterAcceptance({
            arm,
            clocks: barrierValue,
            environment,
            resultDirectory: context.resultDirectory,
            variables,
          });
          testResult.visual = { status: "passed", ...visual };
          await context.ledger.emit("arm.visual.relaunched", {
            armId: arm.id,
            ...testResult.visual,
          });
        } catch (cause) {
          testResult.visual = { status: "failed", error: errorRecord(cause) };
          testResult.status = "visual_failed";
          await context.ledger.emit("arm.visual.relaunch_failed", {
            armId: arm.id,
            error: testResult.visual.error,
          });
        }
      }
    } catch (cause) {
      testResult = { status: "failed_to_prepare", error: errorRecord(cause) };
      await context.ledger.emit("arm.test.failed_to_prepare", {
        armId: arm.id,
        error: testResult.error,
      });
    } finally {
      await prepared?.cleanup?.();
    }
  }
  const armPassed = agentPassed && testResult.status === "passed";
  const completedEpochMs = Date.now();
  const metrics = benchmarkMetrics(
    command,
    testResult,
    barrierValue.startEpochMs,
    completedEpochMs,
    armPassed,
  );
  const result = {
    id: arm.id,
    label: arm.label,
    ok: armPassed,
    commit: context.preflight.arms[arm.id].commit,
    command: { argv, ...command },
    claudeMem,
    injectionIII,
    test: testResult,
    backend: {
      pid: context.backend.pid,
      port: context.backend.port,
      baseURL: context.backend.baseURL,
      fixtureRevision: context.backend.fixtureRevision,
    },
    completedEpochMs,
    metrics,
    resultsDirectory: context.resultDirectory,
  };
  context.states[arm.id] = result.ok ? "passed" : "failed";
  await writeFile(
    join(context.resultDirectory, "arm-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  await context.ledger.emit("arm.completed", {
    armId: arm.id,
    ok: result.ok,
    testStatus: result.test.status,
  });
  return result;
}

export async function runBenchmark(manifest, options = {}) {
  const runId = safeRunId(options.runId);
  const runDirectoryParent = join(manifest.runRoot, "benchmark-runs");
  await mkdir(runDirectoryParent, { recursive: true });
  const runDirectory = join(runDirectoryParent, runId);
  await mkdir(runDirectory);
  const eventsPath = join(runDirectory, "events.jsonl");
  const summaryPath = join(runDirectory, "summary.json");
  const ledger = new EventLedger(eventsPath);
  await ledger.initialize();
  await ledger.emit("run.preflight.started", { runId });

  let preflight;
  let claudeMemPreparation;
  let injectionPreparation;
  let codexHomes;
  let backends = [];
  let backendStopStatus = {};
  const resultDirectories = {};
  try {
    preflight = options.preflightData ?? await preflightBenchmark(manifest);
    preflight.goalObjective = buildGoalObjective(preflight.prompt);
    preflight.goalObjectiveSHA256 = `sha256:${createHash("sha256")
      .update(preflight.goalObjective).digest("hex")}`;
    await ledger.emit("run.preflight.passed", {
      runId,
      baselineCommit: preflight.baselineResolved,
      promptSHA256: preflight.promptSHA256,
      goalObjectiveSHA256: preflight.goalObjectiveSHA256,
      versions: preflight.versions,
    });
    for (const arm of manifest.arms) {
      const directory = join(arm.results, runId);
      await mkdir(directory);
      resultDirectories[arm.id] = directory;
    }

    const provisionCodexHomes = options.prepareCodexHomes ?? prepareCodexHomes;
    codexHomes = await provisionCodexHomes(manifest, { ledger, runDirectory, runId });
    if (Object.keys(codexHomes).length !== manifest.arms.length) {
      throw new Error("Codex-home provisioner did not return one isolated home per arm");
    }

    const prepareArmD = options.prepareArmD ?? prepareClaudeMemArm;
    claudeMemPreparation = await prepareArmD(manifest, {
      ledger,
      resultDirectory: resultDirectories[CLAUDE_MEM_ARM_ID],
      runId,
      codexHome: codexHomes[CLAUDE_MEM_ARM_ID],
    });

    const startBackends = options.startBackends ?? startDedicatedBackends;
    backends = await startBackends(manifest, { ledger, resultDirectories });
    if (backends.length !== manifest.arms.length) {
      throw new Error("backend starter did not return one backend per arm");
    }

    const prepareArmC = options.prepareArmC ?? prepareInjectionIIIArm;
    injectionPreparation = await prepareArmC(manifest, {
      ledger,
      resultDirectory: resultDirectories[INJECTION_ARM_ID],
      runId,
    });
  } catch (cause) {
    await ledger.emit("run.preflight.failed", { runId, error: errorRecord(cause) });
    if (backends.length > 0) {
      const stopBackends = options.stopBackends ?? stopDedicatedBackends;
      backendStopStatus = await stopBackends(backends, ledger);
    }
    const summary = {
      reportVersion: 1,
      runId,
      ok: false,
      eventsPath,
      error: errorRecord(cause),
      backendStopStatus,
    };
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
    await ledger.close();
    return summary;
  }

  const backendByArm = Object.fromEntries(backends.map((record) => [record.armId, record]));
  if (options.beforeClock) {
    try {
      await options.beforeClock({ ledger, resultDirectories, runDirectory, runId });
    } catch (cause) {
      await ledger.emit("run.visual.failed", { runId, error: errorRecord(cause) });
      const stopBackends = options.stopBackends ?? stopDedicatedBackends;
      backendStopStatus = await stopBackends(backends, ledger);
      const summary = {
        reportVersion: 1,
        runId,
        ok: false,
        eventsPath,
        summaryPath,
        error: errorRecord(cause),
        backendStopStatus,
      };
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
      await ledger.close();
      return summary;
    }
  }
  const countdownSeconds = options.countdownSeconds ?? 3;
  const stagingLeadMs = options.stagingLeadMs ?? 120_000;
  const startEpochMs = Date.now() + stagingLeadMs;
  const deadlineEpochMs = startEpochMs + manifest.deadlineSeconds * 1_000;
  const clocks = {
    startEpochMs,
    startMonotonicNs: "pending-until-release",
    deadlineEpochMs,
  };
  if (options.beforeArms) {
    try {
      await options.beforeArms({
        clocks,
        ledger,
        resultDirectories,
        runDirectory,
        runId,
      });
    } catch (cause) {
      await ledger.emit("run.visual.failed", { runId, error: errorRecord(cause) });
      const stopBackends = options.stopBackends ?? stopDedicatedBackends;
      backendStopStatus = await stopBackends(backends, ledger);
      const summary = {
        reportVersion: 1,
        runId,
        ok: false,
        eventsPath,
        summaryPath,
        error: errorRecord(cause),
        backendStopStatus,
      };
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
      await ledger.close();
      return summary;
    }
  }
  const barrier = new StartBarrier(manifest.arms.length);
  const states = Object.fromEntries(manifest.arms.map(({ id }) => [id, "ready"]));
  const prepareAcceptance = options.prepareAcceptance ?? prepareAcceptanceRun;
  const status = options.status ?? ((message) => process.stderr.write(`${message}\n`));
  const tasks = manifest.arms.map((arm) => runArm(manifest, arm, {
    backend: backendByArm[arm.id],
    barrier,
    ledger,
    preflight,
    prepareAcceptance,
    claudeMemPreparation,
    injectionPreparation,
    codexHome: codexHomes[arm.id],
    verifyClaudeMem: options.verifyArmD ?? verifyClaudeMemArm,
    verifyInjectionIII: options.verifyArmC ?? verifyInjectionIIIArm,
    wrapClaudeMem: options.wrapArmD ?? wrapClaudeMemCommand,
    parseClaudeMemEvidence: options.parseArmDEvidence ?? parseClaudeMemWorkerEvidence,
    afterAcceptance: options.afterAcceptance,
    goalObjective: preflight.goalObjective,
    runGoal: options.runGoal,
    promptSHA256: preflight.promptSHA256,
    resultDirectory: resultDirectories[arm.id],
    runId,
    states,
    clocks,
  }).catch((cause) => {
    barrier.fail(cause);
    throw cause;
  }));
  const allTasksSettled = Promise.allSettled(tasks);
  const sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
  let barrierFailure;
  let startMonotonicNs = "not-released";
  try {
    await barrier.allReady;
    await ledger.emit("run.barrier.ready", { runId, armCount: manifest.arms.length });
    const waitBeforeCountdownMs = startEpochMs - Date.now() - countdownSeconds * 1_000;
    if (waitBeforeCountdownMs < 0 && options.allowLateBarrier !== true) {
      throw new Error("goal staging missed the synchronized countdown window");
    }
    if (waitBeforeCountdownMs > 0) await sleep(waitBeforeCountdownMs);
    await emitCountdown({
      seconds: countdownSeconds,
      startEpochMs,
      ledger,
      status,
      sleep,
      onTick: options.onCountdown,
    });
    const releaseSkewMs = Date.now() - startEpochMs;
    if (Math.abs(releaseSkewMs) > 1_000 && options.allowLateBarrier !== true) {
      throw new Error(`synchronized release missed start epoch by ${releaseSkewMs}ms`);
    }
    startMonotonicNs = process.hrtime.bigint().toString();
    clocks.startMonotonicNs = startMonotonicNs;
    await ledger.emit("run.barrier.released", {
      runId,
      startEpochMs,
      startMonotonicNs,
      deadlineEpochMs,
      releaseSkewMs,
    });
    status(`START ${new Date(startEpochMs).toISOString()}`);
    barrier.release({ startEpochMs, startMonotonicNs, deadlineEpochMs });
  } catch (cause) {
    barrierFailure = errorRecord(cause);
    barrier.fail(cause);
    await ledger.emit("run.barrier.failed", { runId, error: barrierFailure });
  }

  let heartbeatQueue = Promise.resolve();
  const heartbeat = barrierFailure ? null : setInterval(() => {
    heartbeatQueue = heartbeatQueue.then(async () => {
      const now = Date.now();
      await ledger.emit("run.heartbeat", {
        runId,
        elapsedMs: Math.max(0, now - startEpochMs),
        remainingMs: Math.max(0, deadlineEpochMs - now),
        states: { ...states },
      });
      status(`T+${Math.floor(Math.max(0, now - startEpochMs) / 1_000)}s ${JSON.stringify(states)}`);
    });
  }, 1_000);
  heartbeat?.unref();

  const settledArms = await allTasksSettled;
  if (heartbeat) clearInterval(heartbeat);
  await heartbeatQueue;
  const arms = [];
  for (const [index, entry] of settledArms.entries()) {
    if (entry.status === "fulfilled") {
      arms.push(entry.value);
      continue;
    }
    const arm = manifest.arms[index];
    const failure = {
      id: arm.id,
      label: arm.label,
      ok: false,
      commit: preflight.arms[arm.id].commit,
      error: errorRecord(entry.reason),
      command: { argv: renderArgv(manifest.agentCommand, templateVariables(manifest, arm, {
        backendBaseURL: backendByArm[arm.id].baseURL,
        deadlineEpochMs,
        promptSHA256: preflight.promptSHA256,
        resultDirectory: resultDirectories[arm.id],
        runId,
        startEpochMs,
        startMonotonicNs,
      })) },
      test: { status: "not_run", reason: "arm orchestration crashed" },
      resultsDirectory: resultDirectories[arm.id],
    };
    states[arm.id] = "failed";
    arms.push(failure);
    await ledger.emit("arm.crashed", { armId: arm.id, error: failure.error });
    try {
      await writeFile(
        join(resultDirectories[arm.id], "arm-result.json"),
        `${JSON.stringify(failure, null, 2)}\n`,
        { flag: "wx" },
      );
    } catch {
      // The original orchestration failure remains authoritative.
    }
  }
  const unexpectedBackendExits = backends.filter(({ controller }) => controller?.exited === true);
  const stopBackends = options.stopBackends ?? stopDedicatedBackends;
  let backendStopError;
  try {
    backendStopStatus = await stopBackends(backends, ledger);
  } catch (cause) {
    backendStopError = errorRecord(cause);
    await ledger.emit("backend.stop_failed", { error: backendStopError });
  }
  const ok = arms.every((arm) => arm.ok)
    && unexpectedBackendExits.length === 0
    && backendStopError === undefined
    && barrierFailure === undefined;
  const endedEpochMs = Date.now();
  const summary = {
    reportVersion: 1,
    runId,
    ok,
    baselineCommit: preflight.baselineResolved,
    prompt: { path: manifest.promptPath, sha256: preflight.promptSHA256 },
    goalObjectiveSHA256: preflight.goalObjectiveSHA256,
    model: manifest.model,
    serviceTier: manifest.serviceTier,
    startEpochMs,
    startMonotonicNs,
    deadlineEpochMs,
    endedEpochMs,
    durationMs: endedEpochMs - startEpochMs,
    versions: preflight.versions,
    agentCommandTemplate: manifest.agentCommand,
    acceptanceCommandTemplate: manifest.acceptanceCommand,
    backendFixtureRevision: manifest.backendFixtureRevision,
    claudeMemPreflight: claudeMemPreparation,
    codexHomes,
    backendStopStatus,
    backendStopError,
    barrierFailure,
    unexpectedBackendExits: unexpectedBackendExits.map(({ armId, pid }) => ({ armId, pid })),
    arms,
    eventsPath,
    summaryPath,
  };
  await ledger.emit("run.completed", { runId, ok, durationMs: summary.durationMs });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  await ledger.close();
  return summary;
}
