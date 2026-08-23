import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";

import { captureCommand } from "./process.mjs";
import { scrubTreatmentEnvironment } from "./codex-home.mjs";

export const CLAUDE_MEM_ARM_ID = "codex-moops-claudemem";

export class ClaudeMemError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClaudeMemError";
    this.code = code;
  }
}

function parseDoctor(result, context) {
  if (result.exitCode !== 0) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_DOCTOR",
      `${context} exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  let body;
  try {
    body = JSON.parse(result.stdout.trim());
  } catch (cause) {
    throw new ClaudeMemError("E_CLAUDE_MEM_DOCTOR", `${context} returned invalid JSON: ${cause.message}`);
  }
  if (body?.ok !== true || body.claudeMemEnabled !== true || body.claudeMemVersion !== "13.15.3") {
    throw new ClaudeMemError("E_CLAUDE_MEM_DOCTOR", `${context} did not prove claude-mem 13.15.3`);
  }
  return body;
}

export function claudeMemRunId(runId) {
  return `${runId}-arm-d`;
}

export function wrapClaudeMemCommand(argv, prepared) {
  if (!prepared?.wrapperPath || basename(argv[0]) !== "codex" || argv[1] !== "app-server") {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_COMMAND",
      "arm D must launch the same codex app-server argv through run-arm-d",
    );
  }
  return [prepared.wrapperPath, ...argv.slice(1)];
}

export function parseClaudeMemWorkerEvidence(message, prepared) {
  if (Object.hasOwn(message, "id") || Object.hasOwn(message, "method")) return undefined;
  if (message?.ok !== true
    || message.version !== "13.15.3"
    || !Number.isInteger(message.pid)
    || message.pid <= 0
    || resolve(message.dataDirectory ?? "") !== resolve(prepared.dataDirectory)) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_RECEIPT",
      "run-arm-d returned an invalid worker identity/shutdown receipt",
    );
  }
  return {
    kind: "claude-mem-worker-shutdown",
    dataDirectory: resolve(message.dataDirectory),
    pid: message.pid,
    version: message.version,
  };
}

export async function prepareClaudeMemArm(manifest, context, options = {}) {
  const arm = manifest.arms.find(({ id }) => id === CLAUDE_MEM_ARM_ID);
  if (!arm) throw new ClaudeMemError("E_CLAUDE_MEM_ARM", "arm D is missing");
  const wrapperPath = join(arm.worktree, "benchmark/claude-mem/run-arm-d");
  const runId = claudeMemRunId(context.runId);
  if (!context.codexHome?.home) {
    throw new ClaudeMemError("E_CLAUDE_MEM_HOME", "arm D requires its isolated Codex home");
  }
  const environment = {
    ...scrubTreatmentEnvironment(process.env),
    CODEX_HOME: context.codexHome.home,
    MOOPS_CLAUDE_MEM_RUN_ID: runId,
  };
  const capture = options.capture ?? captureCommand;
  const printResult = await capture([wrapperPath, "--print-environment"], {
    cwd: arm.worktree,
    env: environment,
    timeoutMs: 30_000,
  });
  if (printResult.exitCode !== 0) {
    throw new ClaudeMemError("E_CLAUDE_MEM_ENV", `run-arm-d environment failed: ${printResult.stderr.trim()}`);
  }
  let printed;
  try {
    printed = JSON.parse(printResult.stdout.trim());
  } catch (cause) {
    throw new ClaudeMemError("E_CLAUDE_MEM_ENV", `run-arm-d environment was invalid JSON: ${cause.message}`);
  }
  const expectedDataDirectory = resolve(arm.worktree, "results/claude-mem", runId);
  if (resolve(printed.CLAUDE_MEM_DATA_DIR ?? "") !== expectedDataDirectory) {
    throw new ClaudeMemError("E_CLAUDE_MEM_ENV", "run-arm-d selected an unexpected memory store");
  }
  const doctorResult = await capture([wrapperPath, "--doctor-fresh"], {
    cwd: arm.worktree,
    env: environment,
    timeoutMs: 60_000,
  });
  const doctor = parseDoctor(doctorResult, "run-arm-d --doctor-fresh");
  const registryPath = join(arm.worktree, "benchmark/claude-mem/checkpoints.json");
  let registry;
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (cause) {
    throw new ClaudeMemError("E_CLAUDE_MEM_REGISTRY", `cannot read checkpoint registry: ${cause.message}`);
  }
  const memoryCheckpoints = (registry.checkpoints ?? []).map((entry) => ({
    name: entry.name,
    path: entry.executableCheckpoint?.path,
    fingerprint: entry.executableCheckpoint?.fingerprint,
  }));
  if (memoryCheckpoints.length !== 3 || memoryCheckpoints.some((entry) => (
    typeof entry.name !== "string"
    || typeof entry.path !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(entry.fingerprint ?? "")
  ))) {
    throw new ClaudeMemError("E_CLAUDE_MEM_REGISTRY", "checkpoint recall registry is incomplete");
  }
  const evidence = {
    runId,
    wrapperPath,
    dataDirectory: expectedDataDirectory,
    doctor,
    memoryCheckpoints,
    workerPort: 37977,
    lifecycleContract: "wrapper exit 0 requires exact worker/store verification and graceful shutdown",
  };
  await writeFile(
    join(context.resultDirectory, "claude-mem-preflight.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: "wx" },
  );
  await context.ledger.emit("claude_mem.preflight.passed", evidence);
  return evidence;
}

export async function verifyClaudeMemArm(prepared, context, options = {}) {
  const capture = options.capture ?? captureCommand;
  if (!context.codexHome?.home) {
    throw new ClaudeMemError("E_CLAUDE_MEM_HOME", "arm D postflight requires its isolated Codex home");
  }
  const environment = {
    ...scrubTreatmentEnvironment(process.env),
    CODEX_HOME: context.codexHome.home,
    MOOPS_CLAUDE_MEM_RUN_ID: prepared.runId,
  };
  const result = await capture([prepared.wrapperPath, "--doctor"], {
    cwd: context.arm.worktree,
    env: environment,
    timeoutMs: 60_000,
  });
  const doctor = parseDoctor(result, "run-arm-d --doctor postflight");
  if (context.command.serverExitCode !== 0) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_SHUTDOWN",
      "run-arm-d did not exit successfully, so worker lifecycle proof is invalid",
    );
  }
  const workerReceipts = (context.command.trailingEvidence ?? [])
    .filter(({ kind }) => kind === "claude-mem-worker-shutdown");
  if (workerReceipts.length !== 1
    || resolve(workerReceipts[0].dataDirectory) !== resolve(prepared.dataDirectory)
    || workerReceipts[0].version !== "13.15.3"
    || !Number.isInteger(workerReceipts[0].pid)
    || workerReceipts[0].pid <= 0) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_RECEIPT",
      "run-arm-d did not preserve one exact worker identity/shutdown receipt",
    );
  }
  const recallPath = join(context.resultDirectory, "claude-mem-recall.jsonl");
  let recallSource;
  try {
    const metadata = await lstat(recallPath);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error("recall evidence must be a non-empty regular file");
    }
    recallSource = await readFile(recallPath);
  } catch (cause) {
    throw new ClaudeMemError("E_CLAUDE_MEM_RECALL", `recall evidence is unavailable: ${cause.message}`);
  }
  const recallVerification = await capture([
    process.execPath,
    join(context.arm.worktree, "benchmark/claude-mem/verify-recall.mjs"),
    recallPath,
  ], {
    cwd: context.arm.worktree,
    env: environment,
    timeoutMs: 60_000,
  });
  if (recallVerification.exitCode !== 0 || recallVerification.signal !== null) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_RECALL",
      `verify-recall failed: ${recallVerification.stderr.trim()}`,
    );
  }
  let recall;
  try {
    recall = JSON.parse(recallVerification.stdout.trim());
  } catch (cause) {
    throw new ClaudeMemError("E_CLAUDE_MEM_RECALL", `verify-recall returned invalid JSON: ${cause.message}`);
  }
  const expectedReceipt = {
    schemaVersion: 1,
    workflow: ["search", "timeline", "get_observations"],
    checkpoints: prepared.memoryCheckpoints,
    selected: "checkout-ready",
  };
  if (recall?.ok !== true
    || recall.runId !== prepared.runId
    || JSON.stringify(recall.workflow) !== JSON.stringify(expectedReceipt.workflow)
    || JSON.stringify(recall.receipt) !== JSON.stringify(expectedReceipt)) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_RECALL",
      "verified recall did not match this run's exact checkpoint registry",
    );
  }
  const evidence = {
    ok: true,
    runId: prepared.runId,
    dataDirectory: prepared.dataDirectory,
    doctor,
    wrapperExitCode: context.command.serverExitCode,
    workerPortUnused: true,
    workerIdentityAndShutdown: workerReceipts[0],
    recall: {
      ...recall,
      evidencePath: recallPath,
      evidenceSHA256: `sha256:${createHash("sha256").update(recallSource).digest("hex")}`,
    },
  };
  await writeFile(
    join(context.resultDirectory, "claude-mem-postflight.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: "wx" },
  );
  await context.ledger.emit("claude_mem.postflight.passed", evidence);
  return evidence;
}
