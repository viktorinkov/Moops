import { once } from "node:events";
import { createInterface } from "node:readline";
import { access, open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { loadAndValidateRegistry } from "./registry.mjs";
import { parseJsonl, verifyRecallEvidence } from "./verify-recall.mjs";

const MODEL = "gpt-5.6-sol";
const SERVICE_TIER = "fast";
const WORKER_VERSION = "13.15.3";

function requireArmDEnvironment(environment) {
  for (const key of ["CODEX_HOME", "CLAUDE_MEM_DATA_DIR", "MOOPS_CLAUDE_MEM_RUN_ID"]) {
    if (typeof environment[key] !== "string" || environment[key].trim() === "") {
      throw new Error(`recall-helper: inherited arm-D ${key} is required`);
    }
  }
  if (!isAbsolute(environment.CODEX_HOME) || !isAbsolute(environment.CLAUDE_MEM_DATA_DIR)) {
    throw new Error("recall-helper: inherited CODEX_HOME and CLAUDE_MEM_DATA_DIR must be absolute");
  }
  if (
    environment.CLAUDE_MEM_WORKER_HOST !== "127.0.0.1"
    || environment.CLAUDE_MEM_WORKER_PORT !== "37977"
  ) {
    throw new Error("recall-helper: arm D must use the isolated loopback worker at 127.0.0.1:37977");
  }
}

export function buildCodexInvocation({
  repositoryRoot,
  schemaPath,
  receiptPath,
  environment,
}) {
  requireArmDEnvironment(environment);
  return {
    command: "codex",
    args: [
      "exec",
      "--ephemeral",
      "--json",
      "--sandbox",
      "read-only",
      "--model",
      MODEL,
      "--config",
      'service_tier="fast"',
      "--config",
      'approval_policy="never"',
      "--output-schema",
      schemaPath,
      "--output-last-message",
      receiptPath,
      "--cd",
      repositoryRoot,
      "-",
    ],
    environment,
  };
}

export function buildRecallPrompt() {
  return [
    "You are a fresh, read-only MOOPS recall verifier.",
    "Use only the installed Claude-Mem MCP server named mcp-search. Do not use shell, files, web, or any other tool.",
    "You must call exactly once, in this order: search, timeline, get_observations.",
    "1. search for query MOOPS_MEMORY_CHECKPOINT with project moops-food-delivery, type observations, limit 20.",
    "2. timeline the most relevant returned observation in project moops-food-delivery.",
    "3. get_observations in one batch for the positive observation IDs needed to retrieve all three packets, with project moops-food-delivery.",
    "The retrieved observations—not guesses—must supply the exact name, executable checkpoint path, and sha256 fingerprint for catalog-ready, cart-ready, and checkout-ready.",
    "Return only the schema-constrained JSON receipt. Set workflow to search, timeline, get_observations in that order; order checkpoints catalog-ready, cart-ready, checkout-ready; and set selected to checkout-ready.",
    "If Claude-Mem does not return all three exact descriptors, do not invent them.",
  ].join("\n");
}

function parseOptions(argv) {
  const options = { callerPid: process.ppid };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`recall-helper: ${flag} requires a value`);
    if (flag === "--output") options.output = value;
    else if (flag === "--capture-completed-at") options.captureCompletedAt = value;
    else if (flag === "--caller-pid") options.callerPid = Number(value);
    else throw new Error(`recall-helper: unknown option ${flag}`);
  }
  if (typeof options.output !== "string" || options.output === "") {
    throw new Error("recall-helper: --output is required");
  }
  if (
    typeof options.captureCompletedAt !== "string"
    || !Number.isFinite(Date.parse(options.captureCompletedAt))
  ) {
    throw new Error("recall-helper: --capture-completed-at must be an ISO timestamp");
  }
  if (!Number.isInteger(options.callerPid) || options.callerPid <= 0) {
    throw new Error("recall-helper: --caller-pid must be a positive PID");
  }
  return options;
}

async function requireFreshPath(path, context) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`recall-helper: ${context} already exists: ${path}`);
}

async function workerHealth(environment, fetchImplementation = fetch) {
  const url = `http://${environment.CLAUDE_MEM_WORKER_HOST}:${environment.CLAUDE_MEM_WORKER_PORT}/api/health`;
  let response;
  try {
    response = await fetchImplementation(url, { signal: AbortSignal.timeout(1_500) });
  } catch (error) {
    throw new Error(`recall-helper: Claude-Mem worker is not alive at ${url}`, { cause: error });
  }
  if (!response.ok) throw new Error(`recall-helper: Claude-Mem worker health returned ${response.status}`);
  const health = await response.json();
  if (health?.version !== WORKER_VERSION || !Number.isInteger(health?.pid) || health.pid <= 0) {
    throw new Error(`recall-helper: expected live Claude-Mem ${WORKER_VERSION} health with a PID`);
  }
  return health;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(moduleDirectory, "../..");
  const schemaPath = resolve(moduleDirectory, "recall-receipt.schema.json");
  const registryPath = resolve(moduleDirectory, "checkpoints.json");
  const outputPath = resolve(options.output);
  const receiptPath = `${outputPath}.receipt.json`;

  requireArmDEnvironment(process.env);
  const outputParent = await stat(dirname(outputPath));
  if (!outputParent.isDirectory()) throw new Error("recall-helper: output parent is not a directory");
  await requireFreshPath(outputPath, "evidence file");
  await requireFreshPath(receiptPath, "receipt file");
  const registry = await loadAndValidateRegistry(registryPath, repositoryRoot);
  const before = await workerHealth(process.env);
  const launcherStartedAt = new Date().toISOString();
  if (Date.parse(options.captureCompletedAt) > Date.parse(launcherStartedAt)) {
    throw new Error("recall-helper: capture completion cannot be after helper start");
  }

  const invocation = buildCodexInvocation({
    repositoryRoot,
    schemaPath,
    receiptPath,
    environment: process.env,
  });
  const handle = await open(outputPath, "wx", 0o600);
  const events = [];
  const writeEvent = async (event) => {
    events.push(event);
    const line = `${JSON.stringify(event)}\n`;
    await handle.write(line);
    process.stdout.write(line);
  };

  await writeEvent({
    type: "moops.recall.launcher.started",
    schemaVersion: 1,
    runId: process.env.MOOPS_CLAUDE_MEM_RUN_ID,
    callerPid: options.callerPid,
    launcherPid: process.pid,
    captureCompletedAt: new Date(options.captureCompletedAt).toISOString(),
    startedAt: launcherStartedAt,
    codexHome: process.env.CODEX_HOME,
    claudeMemDataDir: process.env.CLAUDE_MEM_DATA_DIR,
  });

  const child = spawn(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    env: invocation.environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  const codexStartedAt = new Date().toISOString();
  await writeEvent({
    type: "moops.recall.codex.started",
    launcherPid: process.pid,
    codexPid: child.pid,
    workerPid: before.pid,
    startedAt: codexStartedAt,
    command: invocation.command,
    argv: invocation.args,
    model: MODEL,
    requestedServiceTier: SERVICE_TIER,
    sandbox: "read-only",
    ephemeral: true,
  });

  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const exitPromise = once(child, "exit");
  child.stdin.end(buildRecallPrompt());
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      child.kill("SIGTERM");
      throw new Error("recall-helper: codex --json emitted a non-JSON line");
    }
    await writeEvent(event);
  }
  const [exitCode, signal] = await exitPromise;

  let receipt;
  if (exitCode === 0 && signal === null) {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await writeEvent({
      type: "moops.recall.receipt",
      recordedAt: new Date().toISOString(),
      receipt,
    });
  }
  const after = await workerHealth(process.env);
  await writeEvent({
    type: "moops.recall.codex.completed",
    launcherPid: process.pid,
    codexPid: child.pid,
    workerPidBefore: before.pid,
    workerPidAfter: after.pid,
    callerAliveAfter: pidAlive(options.callerPid),
    exitCode,
    signal,
    completedAt: new Date().toISOString(),
  });
  await handle.close();

  if (exitCode !== 0 || signal !== null) {
    throw new Error(`recall-helper: fresh Codex failed with exit=${exitCode} signal=${signal}`);
  }
  const report = verifyRecallEvidence(
    parseJsonl(await readFile(outputPath, "utf8")),
    registry,
  );
  process.stderr.write(`recall-helper: verified ${JSON.stringify(report)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
