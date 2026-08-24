import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_VERSION = "13.15.3";
const EXPECTED_MODEL = "claude-haiku-4-5-20251001";
const POLL_INTERVAL_MS = 100;
const RECEIPT_LIMIT_BYTES = 4_096;

const delay = (milliseconds) => new Promise((resolveDelay) => {
  setTimeout(resolveDelay, milliseconds);
});

async function fetchJson(url, fetchImplementation) {
  let response;
  try {
    response = await fetchImplementation(url, { signal: AbortSignal.timeout(1_000) });
  } catch (cause) {
    throw new Error(`Claude-Mem worker is unreachable at ${url}`, { cause });
  }
  if (!response.ok) {
    throw new Error(`Claude-Mem worker returned HTTP ${response.status} at ${url}`);
  }
  return response.json();
}

async function waitForReadiness({
  fetchImplementation,
  host,
  port,
  timeoutMs,
  delayImplementation,
}) {
  const url = `http://${host}:${port}/api/readiness`;
  const deadline = Date.now() + timeoutMs;
  let lastObservation = "not observed";

  do {
    try {
      const response = await fetchImplementation(url, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      lastObservation = `HTTP ${response.status}: ${JSON.stringify(body)}`;
      if (response.ok && body?.status === "ready" && body.mcpReady === true) return body;
    } catch (cause) {
      lastObservation = cause instanceof Error ? cause.message : String(cause);
    }
    if (Date.now() < deadline) await delayImplementation(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);

  throw new Error(
    `Claude-Mem readiness was not proven within ${timeoutMs}ms: ${lastObservation}`,
  );
}

async function readSafeJson(path, context) {
  const pathMetadata = await lstat(path);
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
    || pathMetadata.size < 2 || pathMetadata.size > RECEIPT_LIMIT_BYTES) {
    throw new Error(`${context} must be a small, non-symlink regular file: ${path}`);
  }

  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()
      || openedMetadata.dev !== pathMetadata.dev
      || openedMetadata.ino !== pathMetadata.ino) {
      throw new Error(`${context} changed while it was being opened: ${path}`);
    }
    try {
      return JSON.parse(await handle.readFile("utf8"));
    } catch (cause) {
      throw new Error(`${context} is not valid JSON: ${path}`, { cause });
    }
  } finally {
    await handle.close();
  }
}

async function writeStartupReceipt(path, receipt) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireRegularScript(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`worker script must be a non-symlink regular file: ${path}`);
  }
  return realpath(path);
}

function requireSetting(settings, key, expected) {
  if (settings?.[key] !== expected) {
    throw new Error(
      `live worker ${key} does not match current run: expected ${JSON.stringify(expected)}, got ${JSON.stringify(settings?.[key])}`,
    );
  }
}

export async function captureProcessStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("worker PID must be positive");
  if (process.platform === "linux") {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = source.lastIndexOf(") ");
    const token = closingParenthesis < 0
      ? ""
      : source.slice(closingParenthesis + 2).split(" ")[19];
    if (/^\d+$/.test(token ?? "")) return token;
  } else if (process.platform !== "win32") {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    });
    const token = result.status === 0 ? result.stdout.trim() : "";
    if (token !== "") return token;
  }
  throw new Error(`could not capture a start token for worker PID ${pid}`);
}

function requirePidReceipt(receipt, { expectedDataDirectory, port }) {
  if (!Number.isInteger(receipt?.pid) || receipt.pid <= 0
    || receipt.port !== port
    || !Number.isFinite(Date.parse(receipt.startedAt))
    || typeof receipt.startToken !== "string"
    || receipt.startToken === "") {
    throw new Error(
      `worker PID receipt does not prove ${expectedDataDirectory} on port ${port}`,
    );
  }
  return receipt;
}

function requireAbsolute(path, context) {
  if (typeof path !== "string" || path === "" || resolve(path) !== path) {
    throw new Error(`${context} must be an absolute path`);
  }
}

async function proveWorkerIdentity({
  expectedDataDirectory,
  expectedWorkerScriptPath,
  fetchImplementation = fetch,
  host = "127.0.0.1",
  port = 37977,
  readinessTimeoutMs = 30_000,
  delayImplementation = delay,
  processStartTokenImplementation = captureProcessStartToken,
  requireReadiness = false,
} = {}) {
  requireAbsolute(expectedDataDirectory, "expectedDataDirectory");
  requireAbsolute(expectedWorkerScriptPath, "expectedWorkerScriptPath");
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("worker endpoint must be an exact loopback host and valid port");
  }
  const expectedRealWorkerPath = await requireRegularScript(expectedWorkerScriptPath);
  const readiness = requireReadiness
    ? await waitForReadiness({
      fetchImplementation,
      host,
      port,
      timeoutMs: readinessTimeoutMs,
      delayImplementation,
    })
    : undefined;
  const baseUrl = `http://${host}:${port}`;
  const [health, settings, pidReceipt] = await Promise.all([
    fetchJson(`${baseUrl}/api/health`, fetchImplementation),
    fetchJson(`${baseUrl}/api/settings`, fetchImplementation),
    readSafeJson(join(expectedDataDirectory, "worker.pid"), "worker PID receipt"),
  ]);

  const liveWorkerPath = typeof health?.workerPath === "string" ? health.workerPath : "";
  if (health?.version !== EXPECTED_VERSION
    || !Number.isInteger(health.pid)
    || health.pid <= 0
    || (requireReadiness && (health.initialized !== true || health.mcpReady !== true))
    || liveWorkerPath === ""
    || await realpath(liveWorkerPath) !== expectedRealWorkerPath) {
    throw new Error(
      `live worker health does not prove the exact isolated Claude-Mem runtime: ${JSON.stringify({
        initialized: health?.initialized,
        mcpReady: health?.mcpReady,
        pid: health?.pid,
        version: health?.version,
        workerPath: health?.workerPath,
      })}`,
    );
  }

  requirePidReceipt(pidReceipt, { expectedDataDirectory, port });
  if (pidReceipt.pid !== health.pid) {
    throw new Error("worker PID receipt does not match live health");
  }
  const currentStartToken = await processStartTokenImplementation(health.pid);
  if (currentStartToken !== pidReceipt.startToken) {
    throw new Error(`worker PID ${health.pid} start token does not match its run-store receipt`);
  }

  const expectedSettings = {
    CLAUDE_CODE_PATH: "",
    CLAUDE_MEM_CLAUDE_AUTH_METHOD: "subscription",
    CLAUDE_MEM_DATA_DIR: expectedDataDirectory,
    CLAUDE_MEM_EXCLUDED_PROJECTS: "",
    CLAUDE_MEM_MODEL: EXPECTED_MODEL,
    CLAUDE_MEM_MODE: "code",
    CLAUDE_MEM_PROVIDER: "claude",
    CLAUDE_MEM_QUEUE_ENGINE: "sqlite",
    CLAUDE_MEM_RUNTIME: "worker",
    CLAUDE_MEM_SEMANTIC_INJECT: "false",
    CLAUDE_MEM_SKIP_TOOLS: "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",
    CLAUDE_MEM_TIER_ROUTING_ENABLED: "false",
    CLAUDE_MEM_WORKER_HOST: host,
    CLAUDE_MEM_WORKER_PORT: String(port),
  };
  for (const [key, expected] of Object.entries(expectedSettings)) {
    requireSetting(settings, key, expected);
  }

  return {
    schemaVersion: 1,
    kind: "claude-mem-worker-startup",
    ok: true,
    dataDirectory: expectedDataDirectory,
    host,
    port,
    pid: health.pid,
    startToken: pidReceipt.startToken,
    startedAt: pidReceipt.startedAt,
    version: health.version,
    workerPath: expectedWorkerScriptPath,
    ...(readiness ? {
      readiness: { status: readiness.status, mcpReady: readiness.mcpReady },
    } : {}),
  };
}

export async function verifyWorkerReady(options = {}) {
  return proveWorkerIdentity({ ...options, requireReadiness: true });
}

function sameWorker(left, right) {
  return left?.pid === right?.pid
    && left?.startToken === right?.startToken
    && left?.version === right?.version
    && left?.host === right?.host
    && left?.port === right?.port
    && resolve(left?.dataDirectory ?? "") === resolve(right?.dataDirectory ?? "")
    && resolve(left?.workerPath ?? "") === resolve(right?.workerPath ?? "");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause?.code === "ESRCH") return false;
    if (cause?.code === "EPERM") return true;
    throw cause;
  }
}

function portIsClosed(host, port) {
  return new Promise((resolveClosed) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveClosed(closed);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (cause) => finish(cause?.code === "ECONNREFUSED"));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function verifyWorkerIdentityAndShutdown({
  expectedDataDirectory,
  expectedWorkerScriptPath,
  startupReceiptPath = join(expectedDataDirectory ?? "", ".moops-worker-startup.json"),
  fetchImplementation = fetch,
  host = "127.0.0.1",
  port = 37977,
  readinessTimeoutMs = 5_000,
  shutdownTimeoutMs = 15_000,
  delayImplementation = delay,
  processStartTokenImplementation = captureProcessStartToken,
  processAliveImplementation = processIsAlive,
  portClosedImplementation = portIsClosed,
  signalImplementation = (pid, signal) => process.kill(pid, signal),
} = {}) {
  let startup;
  let stagingCleanup = false;
  try {
    startup = await readSafeJson(startupReceiptPath, "worker startup receipt");
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
    stagingCleanup = true;
  }
  if (!stagingCleanup
    && (startup?.kind !== "claude-mem-worker-startup" || startup.ok !== true)) {
    throw new Error("worker startup receipt is not a verified MOOPS receipt");
  }
  const live = await proveWorkerIdentity({
    expectedDataDirectory,
    expectedWorkerScriptPath,
    fetchImplementation,
    host,
    port,
    readinessTimeoutMs,
    delayImplementation,
    processStartTokenImplementation,
    requireReadiness: !stagingCleanup,
  });
  if (!stagingCleanup && !sameWorker(startup, live)) {
    throw new Error("worker identity changed between the start barrier and shutdown");
  }
  if (!await processAliveImplementation(live.pid)
    || await processStartTokenImplementation(live.pid) !== live.startToken) {
    throw new Error(`worker PID ${live.pid} ownership changed before SIGTERM`);
  }

  signalImplementation(live.pid, "SIGTERM");
  const deadline = Date.now() + shutdownTimeoutMs;
  do {
    const [pidAlive, portClosed] = await Promise.all([
      processAliveImplementation(live.pid),
      portClosedImplementation(host, port),
    ]);
    if (!pidAlive && portClosed) {
      return {
        ...live,
        kind: "claude-mem-worker-shutdown",
        signal: "SIGTERM",
        stagingCleanup,
        pidClosed: true,
        portClosed: true,
      };
    }
    if (Date.now() < deadline) await delayImplementation(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  throw new Error(
    `Claude-Mem worker PID ${live.pid} and port ${port} did not both close within ${shutdownTimeoutMs}ms`,
  );
}

function commandContext() {
  const expectedPluginRoot = resolve(
    process.env.CODEX_HOME ?? "",
    "plugins/cache/claude-mem-local/claude-mem/13.15.3",
  );
  const expectedWorkerScriptPath = join(expectedPluginRoot, "scripts/worker-service.cjs");
  if (resolve(process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH ?? "") !== expectedWorkerScriptPath) {
    throw new Error("CLAUDE_MEM_WORKER_SCRIPT_PATH must pin the isolated 13.15.3 worker");
  }
  return {
    expectedDataDirectory: resolve(process.env.CLAUDE_MEM_DATA_DIR ?? ""),
    expectedWorkerScriptPath,
    host: process.env.CLAUDE_MEM_WORKER_HOST,
    port: Number(process.env.CLAUDE_MEM_WORKER_PORT),
  };
}

async function main() {
  const mode = process.argv[2];
  if (!["--verify-ready", "--verify-and-shutdown"].includes(mode)
    || process.argv.length !== 3) {
    throw new Error(
      "usage: node benchmark/claude-mem/worker-lifecycle.mjs --verify-ready|--verify-and-shutdown",
    );
  }
  const context = commandContext();
  let receipt;
  if (mode === "--verify-ready") {
    receipt = await verifyWorkerReady(context);
    await writeStartupReceipt(
      join(context.expectedDataDirectory, ".moops-worker-startup.json"),
      receipt,
    );
  } else {
    receipt = await verifyWorkerIdentityAndShutdown(context);
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
