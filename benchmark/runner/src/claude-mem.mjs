import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";

import { captureCommand } from "./process.mjs";
import { scrubTreatmentEnvironment } from "./codex-home.mjs";

export const CLAUDE_MEM_ARM_ID = "codex-moops-claudemem";
const CLAUDE_MEM_VERSION = "13.15.3";
const CLAUDE_MEM_CACHE_PATH = `plugins/cache/claude-mem-local/claude-mem/${CLAUDE_MEM_VERSION}`;

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
  if (body?.ok !== true || body.claudeMemEnabled !== true || body.claudeMemVersion !== CLAUDE_MEM_VERSION) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_DOCTOR",
      `${context} did not prove claude-mem ${CLAUDE_MEM_VERSION}`,
    );
  }
  return body;
}

async function requireRegularFile(path, context) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    throw new ClaudeMemError("E_CLAUDE_MEM_MCP", `${context} is unavailable: ${cause.message}`);
  }
  if (!metadata.isFile()) {
    throw new ClaudeMemError("E_CLAUDE_MEM_MCP", `${context} must be a regular file`);
  }
}

async function configureRunScopedMcp({ codexHome, dataDirectory, printed, runId }) {
  if (printed.CLAUDE_MEM_WORKER_HOST !== "127.0.0.1"
    || printed.CLAUDE_MEM_WORKER_PORT !== "37977"
    || printed.CLAUDE_MEM_RUNTIME !== "worker") {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_ENV",
      "run-arm-d did not select the required loopback worker identity",
    );
  }
  const pluginRoot = resolve(codexHome, CLAUDE_MEM_CACHE_PATH);
  const configPath = join(pluginRoot, ".mcp.json");
  const serverPath = join(pluginRoot, "scripts/mcp-server.cjs");
  const workerScriptPath = join(pluginRoot, "scripts/worker-service.cjs");
  await Promise.all([
    requireRegularFile(configPath, "run-scoped Claude-Mem MCP config"),
    requireRegularFile(serverPath, "run-scoped Claude-Mem MCP server"),
    requireRegularFile(workerScriptPath, "run-scoped Claude-Mem worker"),
  ]);
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (cause) {
    throw new ClaudeMemError("E_CLAUDE_MEM_MCP", `Claude-Mem MCP config is invalid: ${cause.message}`);
  }
  if (!config?.mcpServers?.["mcp-search"]) {
    throw new ClaudeMemError("E_CLAUDE_MEM_MCP", "Claude-Mem MCP config lacks mcp-search");
  }
  const treatment = {
    CODEX_HOME: resolve(codexHome),
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    PLUGIN_ROOT: pluginRoot,
    MOOPS_CLAUDE_MEM_RUN_ID: runId,
  };
  for (const [key, value] of Object.entries(printed)) {
    if (key === "CLAUDE_CODE_PATH" || key === "DO_NOT_TRACK" || key.startsWith("CLAUDE_MEM_")) {
      if (typeof value !== "string") {
        throw new ClaudeMemError("E_CLAUDE_MEM_ENV", `run-arm-d ${key} must be a string`);
      }
      treatment[key] = value;
    }
  }
  if (resolve(treatment.CLAUDE_MEM_DATA_DIR ?? "") !== resolve(dataDirectory)) {
    throw new ClaudeMemError("E_CLAUDE_MEM_ENV", "MCP memory store does not match arm D");
  }
  if (resolve(treatment.CLAUDE_MEM_WORKER_SCRIPT_PATH ?? "") !== workerScriptPath) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_ENV",
      "MCP worker path does not pin the isolated Claude-Mem 13.15.3 bundle",
    );
  }
  const assignments = Object.entries(treatment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  config.mcpServers["mcp-search"] = {
    type: "stdio",
    command: "/usr/bin/env",
    args: [...assignments, process.execPath, serverPath],
  };
  const source = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(configPath, source, { mode: 0o600 });
  return {
    configPath,
    configSHA256: `sha256:${createHash("sha256").update(source).digest("hex")}`,
    pluginRoot,
    serverPath,
    workerScriptPath,
    command: "/usr/bin/env",
    nodeExecutable: process.execPath,
    dataDirectory: resolve(dataDirectory),
    workerEndpoint: "127.0.0.1:37977",
    injectedEnvironmentKeys: Object.keys(treatment).sort(),
  };
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
    || message.kind !== "claude-mem-worker-shutdown"
    || message.schemaVersion !== 1
    || message.version !== CLAUDE_MEM_VERSION
    || !Number.isInteger(message.pid)
    || message.pid <= 0
    || typeof message.startToken !== "string"
    || message.startToken === ""
    || message.signal !== "SIGTERM"
    || message.pidClosed !== true
    || message.portClosed !== true
    || message.host !== "127.0.0.1"
    || message.port !== prepared.workerPort
    || resolve(message.workerPath ?? "") !== resolve(prepared.mcpIsolation?.workerScriptPath ?? "")
    || resolve(message.dataDirectory ?? "") !== resolve(prepared.dataDirectory)) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_RECEIPT",
      "run-arm-d returned an invalid worker identity/shutdown receipt",
    );
  }
  return {
    kind: "claude-mem-worker-shutdown",
    ok: true,
    dataDirectory: resolve(message.dataDirectory),
    host: message.host,
    port: message.port,
    pid: message.pid,
    pidClosed: true,
    portClosed: true,
    schemaVersion: 1,
    signal: message.signal,
    startToken: message.startToken,
    startedAt: message.startedAt,
    version: message.version,
    workerPath: resolve(message.workerPath),
  };
}

function parseWorkerStartupReceipt(message, prepared) {
  if (message?.ok !== true
    || message.kind !== "claude-mem-worker-startup"
    || message.schemaVersion !== 1
    || message.version !== CLAUDE_MEM_VERSION
    || !Number.isInteger(message.pid)
    || message.pid <= 0
    || typeof message.startToken !== "string"
    || message.startToken === ""
    || !Number.isFinite(Date.parse(message.startedAt))
    || message.host !== "127.0.0.1"
    || message.port !== prepared.workerPort
    || message.readiness?.status !== "ready"
    || message.readiness?.mcpReady !== true
    || resolve(message.workerPath ?? "") !== resolve(prepared.mcpIsolation?.workerScriptPath ?? "")
    || resolve(message.dataDirectory ?? "") !== resolve(prepared.dataDirectory)) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_RECEIPT",
      "run-arm-d did not preserve the exact pre-release worker identity receipt",
    );
  }
  return {
    kind: "claude-mem-worker-startup",
    ok: true,
    dataDirectory: resolve(message.dataDirectory),
    host: message.host,
    port: message.port,
    pid: message.pid,
    schemaVersion: 1,
    startToken: message.startToken,
    startedAt: message.startedAt,
    version: message.version,
    workerPath: resolve(message.workerPath),
    readiness: { status: "ready", mcpReady: true },
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
  const mcpIsolation = await configureRunScopedMcp({
    codexHome: context.codexHome.home,
    dataDirectory: expectedDataDirectory,
    printed,
    runId,
  });
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
    mcpIsolation,
    memoryCheckpoints,
    workerPort: 37977,
    startupReceiptPath: join(expectedDataDirectory, ".moops-worker-startup.json"),
    lifecycleContract: "MCP auto-start; barrier requires exact run identity; wrapper exit requires token-proven SIGTERM and closed PID/port",
  };
  await writeFile(
    join(context.resultDirectory, "claude-mem-preflight.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: "wx" },
  );
  await context.ledger.emit("claude_mem.preflight.passed", evidence);
  return evidence;
}

export async function verifyClaudeMemReady(prepared, context, options = {}) {
  const capture = options.capture ?? captureCommand;
  if (!context.codexHome?.home) {
    throw new ClaudeMemError("E_CLAUDE_MEM_HOME", "arm D readiness requires its isolated Codex home");
  }
  const result = await capture([prepared.wrapperPath, "--verify-ready"], {
    cwd: context.arm.worktree,
    env: {
      ...scrubTreatmentEnvironment(process.env),
      CODEX_HOME: context.codexHome.home,
      MOOPS_CLAUDE_MEM_RUN_ID: prepared.runId,
    },
    timeoutMs: 45_000,
  });
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_READY",
      `run-arm-d --verify-ready did not prove the worker: ${result.stderr.trim()}`,
    );
  }
  let receipt;
  try {
    receipt = parseWorkerStartupReceipt(JSON.parse(result.stdout.trim()), prepared);
    const metadata = await lstat(prepared.startupReceiptPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()
      || metadata.size === 0 || metadata.size > 4_096) {
      throw new Error("startup receipt must be a small non-symlink regular file");
    }
    const persisted = parseWorkerStartupReceipt(
      JSON.parse(await readFile(prepared.startupReceiptPath, "utf8")),
      prepared,
    );
    if (JSON.stringify(persisted) !== JSON.stringify(receipt)) {
      throw new Error("persisted startup receipt differs from verifier output");
    }
  } catch (cause) {
    if (cause instanceof ClaudeMemError) throw cause;
    throw new ClaudeMemError("E_CLAUDE_MEM_RECEIPT", cause.message);
  }
  await writeFile(
    join(context.resultDirectory, "claude-mem-startup.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  await context.ledger.emit("claude_mem.startup.passed", receipt);
  return receipt;
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
    || workerReceipts[0].version !== CLAUDE_MEM_VERSION
    || !Number.isInteger(workerReceipts[0].pid)
    || workerReceipts[0].pid <= 0) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_RECEIPT",
      "run-arm-d did not preserve one exact worker identity/shutdown receipt",
    );
  }
  const startupReceiptPath = prepared.startupReceiptPath
    ?? join(prepared.dataDirectory, ".moops-worker-startup.json");
  let workerIdentityAtStart;
  try {
    const metadata = await lstat(startupReceiptPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()
      || metadata.size === 0 || metadata.size > 4_096) {
      throw new Error("startup receipt must be a small non-empty non-symlink regular file");
    }
    workerIdentityAtStart = parseWorkerStartupReceipt(
      JSON.parse(await readFile(startupReceiptPath, "utf8")),
      prepared,
    );
  } catch (cause) {
    if (cause instanceof ClaudeMemError) throw cause;
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_RECEIPT",
      `worker startup identity is unavailable: ${cause.message}`,
    );
  }
  if (workerIdentityAtStart.pid !== workerReceipts[0].pid
    || workerIdentityAtStart.startToken !== workerReceipts[0].startToken
    || workerIdentityAtStart.host !== workerReceipts[0].host
    || workerIdentityAtStart.port !== workerReceipts[0].port
    || workerIdentityAtStart.workerPath !== workerReceipts[0].workerPath) {
    throw new ClaudeMemError(
      "E_CLAUDE_MEM_RECEIPT",
      "Claude-Mem worker identity changed between pre-release verification and shutdown",
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
    workerIdentityAtStart,
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
