import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import { bindClaudeMemRuntime } from "../../runner/src/codex-home.mjs";
import {
  verifyWorkerIdentityAndShutdown,
  verifyWorkerReady,
} from "../worker-lifecycle.mjs";

const versionPath = "plugins/cache/claude-mem-local/claude-mem/13.15.3";
const sourcePluginRoot = process.env.MOOPS_CLAUDE_MEM_SMOKE_PLUGIN_ROOT
  ?? join(homedir(), ".codex", versionPath);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((cause) => (
    cause ? reject(cause) : resolve()
  )));
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const runtimeAvailable = await Promise.all([
  exists(join(sourcePluginRoot, "scripts/mcp-server.cjs")),
  exists(join(sourcePluginRoot, "scripts/worker-service.cjs")),
  exists(join(sourcePluginRoot, "node_modules/zod/v3/index.js")),
]).then((checks) => checks.every(Boolean));

test("the pinned MCP bundle auto-starts and token-safely stops its isolated worker", {
  skip: runtimeAvailable ? false : "Claude-Mem 13.15.3 dependency runtime is not installed",
  timeout: 60_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-runtime-smoke-"));
  const codexHome = join(root, "codex-home");
  const isolatedPluginRoot = join(codexHome, versionPath);
  const sourceModules = join(sourcePluginRoot, "node_modules");
  const dataDirectory = join(root, "memory");
  const workerScriptPath = join(isolatedPluginRoot, "scripts/worker-service.cjs");
  let port;
  try {
    port = await unusedPort();
  } catch (cause) {
    if (cause?.code === "EPERM" || cause?.code === "EACCES") {
      context.skip("sandbox does not permit an isolated loopback listener");
      return;
    }
    throw cause;
  }
  await mkdir(isolatedPluginRoot, { recursive: true });
  await cp(sourcePluginRoot, isolatedPluginRoot, {
    recursive: true,
    filter: (source) => source !== sourceModules && !source.startsWith(`${sourceModules}${sep}`),
  });
  const runtime = await bindClaudeMemRuntime({ sourcePluginRoot, isolatedPluginRoot });
  assert.equal(runtime.kind, "pinned-node-modules-symlink");

  const environment = {
    ...process.env,
    CODEX_HOME: codexHome,
    CLAUDE_CODE_PATH: "",
    CLAUDE_MEM_CLAUDE_AUTH_METHOD: "subscription",
    CLAUDE_MEM_DATA_DIR: dataDirectory,
    CLAUDE_MEM_EXCLUDED_PROJECTS: "",
    CLAUDE_MEM_MODEL: "claude-haiku-4-5-20251001",
    CLAUDE_MEM_MODE: "code",
    CLAUDE_MEM_MODES_DIR: "",
    CLAUDE_MEM_PROVIDER: "claude",
    CLAUDE_MEM_QUEUE_ENGINE: "sqlite",
    CLAUDE_MEM_RUNTIME: "worker",
    CLAUDE_MEM_SEMANTIC_INJECT: "false",
    CLAUDE_MEM_SKIP_TOOLS: "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",
    CLAUDE_MEM_TIER_ROUTING_ENABLED: "false",
    CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: join(dataDirectory, "transcript-watch.json"),
    CLAUDE_MEM_TRANSCRIPTS_ENABLED: "false",
    CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION: "false",
    CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
    CLAUDE_MEM_WORKER_PORT: String(port),
    CLAUDE_MEM_WORKER_SCRIPT_PATH: workerScriptPath,
    CLAUDE_MEM_CHROMA_ENABLED: "false",
    CLAUDE_MEM_TELEGRAM_ENABLED: "false",
    CLAUDE_PLUGIN_ROOT: isolatedPluginRoot,
    PLUGIN_ROOT: isolatedPluginRoot,
    DO_NOT_TRACK: "1",
  };
  const mcp = spawn(process.execPath, [join(isolatedPluginRoot, "scripts/mcp-server.cjs")], {
    env: environment,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderrTail = "";
  mcp.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-16_384);
  });
  mcp.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "moops-runtime-smoke", version: "1" },
    },
  })}\n`);
  let startup;
  try {
    try {
      startup = await verifyWorkerReady({
        expectedDataDirectory: dataDirectory,
        expectedWorkerScriptPath: workerScriptPath,
        host: "127.0.0.1",
        port,
      });
    } catch (cause) {
      throw new Error(`${cause.message}\nMCP stderr tail:\n${stderrTail}`, { cause });
    }
    assert.ok(startup.pid > 0);
    assert.equal(startup.workerPath, workerScriptPath);
    await writeFile(
      join(dataDirectory, ".moops-worker-startup.json"),
      `${JSON.stringify(startup)}\n`,
      { flag: "wx", mode: 0o600 },
    );

    const shutdown = await verifyWorkerIdentityAndShutdown({
      expectedDataDirectory: dataDirectory,
      expectedWorkerScriptPath: workerScriptPath,
      host: "127.0.0.1",
      port,
    });
    assert.equal(shutdown.pid, startup.pid);
    assert.equal(shutdown.startToken, startup.startToken);
    assert.equal(shutdown.pidClosed, true);
    assert.equal(shutdown.portClosed, true);
  } finally {
    if (startup) {
      try {
        await verifyWorkerIdentityAndShutdown({
          expectedDataDirectory: dataDirectory,
          expectedWorkerScriptPath: workerScriptPath,
          host: "127.0.0.1",
          port,
          readinessTimeoutMs: 1_000,
          shutdownTimeoutMs: 2_000,
        });
      } catch {
        // The primary assertion path already proved the worker and port closed.
      }
    }
    await stopChild(mcp);
  }
});
