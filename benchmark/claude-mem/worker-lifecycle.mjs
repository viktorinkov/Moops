import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_VERSION = "13.15.3";
const EXPECTED_MODEL = "claude-haiku-4-5-20251001";

async function fetchJson(url, options, fetchImplementation) {
  let response;
  try {
    response = await fetchImplementation(url, {
      ...options,
      signal: AbortSignal.timeout(1_000),
    });
  } catch (error) {
    throw new Error(`Claude-Mem worker is unreachable at ${url}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Claude-Mem worker returned HTTP ${response.status} at ${url}`);
  }
  return response.json();
}

function requireSetting(settings, key, expected) {
  if (settings?.[key] !== expected) {
    const actual = JSON.stringify(settings?.[key]);
    throw new Error(
      `live worker ${key} does not match current run: expected ${JSON.stringify(expected)}, got ${actual}`,
    );
  }
}

function isConnectionRefused(error) {
  let current = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (current.code === "ECONNREFUSED") return true;
    current = current.cause;
  }
  return false;
}

async function workerHasStopped(url, fetchImplementation) {
  try {
    await fetchImplementation(url, { signal: AbortSignal.timeout(1_000) });
    return false;
  } catch (error) {
    return isConnectionRefused(error);
  }
}

export async function verifyWorkerIdentityAndShutdown({
  expectedDataDirectory,
  fetchImplementation = fetch,
  host = "127.0.0.1",
  port = 37977,
  shutdownTimeoutMs = 10_000,
} = {}) {
  if (typeof expectedDataDirectory !== "string" || expectedDataDirectory === "") {
    throw new Error("expectedDataDirectory is required");
  }

  const baseUrl = `http://${host}:${port}`;
  const health = await fetchJson(`${baseUrl}/api/health`, {}, fetchImplementation);
  if (health?.version !== EXPECTED_VERSION) {
    throw new Error(
      `live worker version must be ${EXPECTED_VERSION}, got ${JSON.stringify(health?.version)}`,
    );
  }
  if (!Number.isInteger(health?.pid) || health.pid <= 0) {
    throw new Error("live worker health must include a positive pid");
  }

  const settings = await fetchJson(`${baseUrl}/api/settings`, {}, fetchImplementation);
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

  await fetchJson(`${baseUrl}/api/admin/shutdown`, { method: "POST" }, fetchImplementation);
  const deadline = Date.now() + shutdownTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    if (await workerHasStopped(`${baseUrl}/api/health`, fetchImplementation)) {
      return {
        dataDirectory: expectedDataDirectory,
        pid: health.pid,
        version: health.version,
      };
    }
  }
  throw new Error(
    `Claude-Mem worker pid ${health.pid} did not stop within ${shutdownTimeoutMs}ms`,
  );
}

async function main() {
  if (process.argv[2] !== "--verify-and-shutdown" || process.argv.length !== 3) {
    throw new Error("usage: node benchmark/claude-mem/worker-lifecycle.mjs --verify-and-shutdown");
  }
  const result = await verifyWorkerIdentityAndShutdown({
    expectedDataDirectory: process.env.CLAUDE_MEM_DATA_DIR,
    host: process.env.CLAUDE_MEM_WORKER_HOST,
    port: Number(process.env.CLAUDE_MEM_WORKER_PORT),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
