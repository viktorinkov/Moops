import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLAUDE_MEM_ARM_ID,
  ClaudeMemError,
  prepareClaudeMemArm,
  parseClaudeMemWorkerEvidence,
  verifyClaudeMemArm,
  verifyClaudeMemReady,
  wrapClaudeMemCommand,
} from "../src/claude-mem.mjs";

function workerReceipt(prepared, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "claude-mem-worker-startup",
    ok: true,
    dataDirectory: prepared.dataDirectory,
    host: "127.0.0.1",
    port: prepared.workerPort,
    pid: 456,
    startToken: "fixture-start-token",
    startedAt: "2026-08-23T20:00:00.000Z",
    version: "13.15.3",
    workerPath: prepared.mcpIsolation.workerScriptPath,
    readiness: { status: "ready", mcpReady: true },
    ...overrides,
  };
}

test("arm D stages a fresh run-scoped store and wraps the exact app-server command", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-mem-"));
  const worktree = join(root, "worktree");
  const resultDirectory = join(root, "results");
  const codexHome = join(root, "codex-home");
  const pluginRoot = join(
    codexHome,
    "plugins/cache/claude-mem-local/claude-mem/13.15.3",
  );
  const dataDirectory = join(worktree, "results/claude-mem/take-001-arm-d");
  await Promise.all([mkdir(worktree), mkdir(resultDirectory)]);
  await mkdir(join(worktree, "benchmark/claude-mem"), { recursive: true });
  await mkdir(join(pluginRoot, "scripts"), { recursive: true });
  await writeFile(join(pluginRoot, "scripts/mcp-server.cjs"), "// fixture\n");
  await writeFile(join(pluginRoot, "scripts/worker-service.cjs"), "// fixture\n");
  await writeFile(join(pluginRoot, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "mcp-search": {
        type: "stdio",
        command: "node",
        args: ["scripts/mcp-server.cjs"],
      },
    },
  }));
  await writeFile(join(worktree, "benchmark/claude-mem/checkpoints.json"), JSON.stringify({
    checkpoints: ["catalog-ready", "cart-ready", "checkout-ready"].map((name, index) => ({
      name,
      executableCheckpoint: {
        path: `benchmark/checkpoints/checkpoint-${index}.json`,
        fingerprint: `sha256:${String(index + 1).repeat(64)}`,
      },
    })),
  }));
  const calls = [];
  const capture = async (argv, options) => {
    calls.push({ argv, options });
    if (argv.at(-1) === "--print-environment") {
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: `${JSON.stringify({
          CLAUDE_CODE_PATH: "",
          CLAUDE_MEM_CLAUDE_AUTH_METHOD: "subscription",
          CLAUDE_MEM_DATA_DIR: dataDirectory,
          CLAUDE_MEM_EXCLUDED_PROJECTS: "",
          CLAUDE_MEM_MODEL: "claude-haiku-4-5-20251001",
          CLAUDE_MEM_MODE: "code",
          CLAUDE_MEM_PROVIDER: "claude",
          CLAUDE_MEM_QUEUE_ENGINE: "sqlite",
          CLAUDE_MEM_RUNTIME: "worker",
          CLAUDE_MEM_SEMANTIC_INJECT: "false",
          CLAUDE_MEM_SKIP_TOOLS: "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",
          CLAUDE_MEM_TIER_ROUTING_ENABLED: "false",
          CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
          CLAUDE_MEM_WORKER_PORT: "37977",
          CLAUDE_MEM_WORKER_SCRIPT_PATH: join(pluginRoot, "scripts/worker-service.cjs"),
        })}\n`,
      };
    }
    return {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: '{"claudeMemEnabled":true,"claudeMemVersion":"13.15.3","ok":true}\n',
    };
  };
  const ledgerEvents = [];
  const prepared = await prepareClaudeMemArm({
    arms: [{ id: CLAUDE_MEM_ARM_ID, worktree }],
  }, {
    runId: "take-001",
    codexHome: { home: codexHome },
    resultDirectory,
    ledger: { emit: async (...event) => ledgerEvents.push(event) },
  }, { capture });

  assert.equal(prepared.runId, "take-001-arm-d");
  assert.equal(prepared.memoryCheckpoints.length, 3);
  assert.equal(prepared.mcpIsolation.pluginRoot, pluginRoot);
  assert.equal(prepared.mcpIsolation.dataDirectory, dataDirectory);
  assert.deepEqual(calls.map(({ argv }) => argv.at(-1)), ["--print-environment", "--doctor-fresh"]);
  assert.equal(calls.every(({ options }) => (
    options.env.MOOPS_CLAUDE_MEM_RUN_ID === "take-001-arm-d"
  )), true);
  assert.deepEqual(
    wrapClaudeMemCommand(
      ["/usr/local/bin/codex", "app-server", "--enable", "goals", "--listen", "stdio://"],
      prepared,
    ),
    [prepared.wrapperPath, "app-server", "--enable", "goals", "--listen", "stdio://"],
  );
  assert.equal(ledgerEvents[0][0], "claude_mem.preflight.passed");
  const preflight = JSON.parse(await readFile(join(resultDirectory, "claude-mem-preflight.json")));
  assert.equal(preflight.runId, "take-001-arm-d");
  const generatedMcp = JSON.parse(await readFile(join(pluginRoot, ".mcp.json")));
  const search = generatedMcp.mcpServers["mcp-search"];
  assert.equal(search.command, "/usr/bin/env");
  assert.deepEqual(search.args.slice(-2), [
    process.execPath,
    join(pluginRoot, "scripts/mcp-server.cjs"),
  ]);
  assert.ok(search.args.includes(`CODEX_HOME=${codexHome}`));
  assert.ok(search.args.includes(`CLAUDE_PLUGIN_ROOT=${pluginRoot}`));
  assert.ok(search.args.includes(`PLUGIN_ROOT=${pluginRoot}`));
  assert.ok(search.args.includes(`CLAUDE_MEM_DATA_DIR=${dataDirectory}`));
  assert.ok(search.args.includes("CLAUDE_MEM_WORKER_PORT=37977"));
  assert.ok(search.args.includes(
    `CLAUDE_MEM_WORKER_SCRIPT_PATH=${join(pluginRoot, "scripts/worker-service.cjs")}`,
  ));
  assert.ok(search.args.includes("MOOPS_CLAUDE_MEM_RUN_ID=take-001-arm-d"));
});

test("arm D postflight fails closed when the wrapper reports lifecycle failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-mem-post-"));
  await mkdir(join(root, "results"));
  const prepared = {
    runId: "take-001-arm-d",
    wrapperPath: "/fixture/run-arm-d",
    dataDirectory: "/fixture/store",
  };
  await assert.rejects(
    verifyClaudeMemArm(prepared, {
      arm: { worktree: root },
      command: { serverExitCode: 1 },
      codexHome: { home: join(root, "codex-home") },
      ledger: { emit: async () => {} },
      resultDirectory: join(root, "results"),
    }, {
      capture: async () => ({
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: '{"claudeMemEnabled":true,"claudeMemVersion":"13.15.3","ok":true}\n',
      }),
    }),
    (cause) => cause instanceof ClaudeMemError && cause.code === "E_CLAUDE_MEM_SHUTDOWN",
  );
});

test("arm D readiness records the MCP-started worker before barrier arrival", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-mem-ready-"));
  const resultDirectory = join(root, "results");
  const dataDirectory = join(root, "store");
  await Promise.all([mkdir(resultDirectory), mkdir(dataDirectory)]);
  const prepared = {
    runId: "take-001-arm-d",
    wrapperPath: "/fixture/run-arm-d",
    dataDirectory,
    startupReceiptPath: join(dataDirectory, ".moops-worker-startup.json"),
    workerPort: 37977,
    mcpIsolation: { workerScriptPath: join(root, "worker-service.cjs") },
  };
  const sourceReceipt = workerReceipt(prepared);
  const events = [];
  const ready = await verifyClaudeMemReady(prepared, {
    arm: { worktree: root },
    codexHome: { home: join(root, "codex-home") },
    ledger: { emit: async (...event) => events.push(event) },
    resultDirectory,
  }, {
    capture: async (argv) => {
      assert.deepEqual(argv, [prepared.wrapperPath, "--verify-ready"]);
      await writeFile(prepared.startupReceiptPath, `${JSON.stringify(sourceReceipt)}\n`);
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: `${JSON.stringify(sourceReceipt)}\n`,
      };
    },
  });

  assert.equal(ready.startToken, "fixture-start-token");
  assert.equal(events[0][0], "claude_mem.startup.passed");
  assert.equal(
    JSON.parse(await readFile(join(resultDirectory, "claude-mem-startup.json"))).pid,
    456,
  );
});

test("arm D validates and preserves the wrapper's exact worker identity receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-mem-receipt-"));
  const resultDirectory = join(root, "results");
  await mkdir(resultDirectory);
  const prepared = {
    runId: "take-001-arm-d",
    wrapperPath: "/fixture/run-arm-d",
    dataDirectory: join(root, "store"),
    workerPort: 37977,
    mcpIsolation: { workerScriptPath: join(root, "worker-service.cjs") },
    memoryCheckpoints: [
      { name: "catalog-ready", path: "benchmark/checkpoints/catalog.json", fingerprint: `sha256:${"1".repeat(64)}` },
      { name: "cart-ready", path: "benchmark/checkpoints/cart.json", fingerprint: `sha256:${"2".repeat(64)}` },
      { name: "checkout-ready", path: "benchmark/checkpoints/checkout.json", fingerprint: `sha256:${"3".repeat(64)}` },
    ],
  };
  await mkdir(prepared.dataDirectory);
  await writeFile(
    join(prepared.dataDirectory, ".moops-worker-startup.json"),
    `${JSON.stringify(workerReceipt(prepared))}\n`,
  );
  await writeFile(join(resultDirectory, "claude-mem-recall.jsonl"), '{"type":"fixture"}\n');
  const receipt = parseClaudeMemWorkerEvidence(workerReceipt(prepared, {
    kind: "claude-mem-worker-shutdown",
    signal: "SIGTERM",
    pidClosed: true,
    portClosed: true,
  }), prepared);
  const verified = await verifyClaudeMemArm(prepared, {
    arm: { worktree: root },
    command: { serverExitCode: 0, trailingEvidence: [receipt] },
    codexHome: { home: join(root, "codex-home") },
    ledger: { emit: async () => {} },
    resultDirectory,
  }, {
    capture: async (argv) => {
      if (argv.some((value) => value.endsWith("verify-recall.mjs"))) {
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: `${JSON.stringify({
            ok: true,
            runId: prepared.runId,
            workflow: ["search", "timeline", "get_observations"],
            receipt: {
              schemaVersion: 1,
              workflow: ["search", "timeline", "get_observations"],
              checkpoints: prepared.memoryCheckpoints,
              selected: "checkout-ready",
            },
          })}\n`,
        };
      }
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: '{"claudeMemEnabled":true,"claudeMemVersion":"13.15.3","ok":true}\n',
      };
    },
  });

  assert.equal(verified.ok, true);
  assert.equal(verified.workerIdentityAtStart.pid, 456);
  assert.deepEqual(verified.workerIdentityAndShutdown, receipt);
  assert.equal(verified.recall.receipt.selected, "checkout-ready");
  assert.equal(JSON.parse(await readFile(join(resultDirectory, "claude-mem-postflight.json")))
    .workerIdentityAndShutdown.pid, 456);
});

test("arm D postflight rejects a different worker PID than the pre-release identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-mem-worker-swap-"));
  const resultDirectory = join(root, "results");
  const dataDirectory = join(root, "store");
  await Promise.all([mkdir(resultDirectory), mkdir(dataDirectory)]);
  await writeFile(
    join(dataDirectory, ".moops-worker-startup.json"),
    `${JSON.stringify(workerReceipt({
      dataDirectory,
      workerPort: 37977,
      mcpIsolation: { workerScriptPath: join(root, "worker-service.cjs") },
    }, { pid: 111 }))}\n`,
  );
  const prepared = {
    runId: "take-001-arm-d",
    wrapperPath: "/fixture/run-arm-d",
    dataDirectory,
    workerPort: 37977,
    mcpIsolation: { workerScriptPath: join(root, "worker-service.cjs") },
  };
  await assert.rejects(
    () => verifyClaudeMemArm(prepared, {
      arm: { worktree: root },
      command: {
        serverExitCode: 0,
        trailingEvidence: [{
          kind: "claude-mem-worker-shutdown",
          dataDirectory,
          host: "127.0.0.1",
          port: 37977,
          pid: 222,
          startToken: "fixture-start-token",
          version: "13.15.3",
          workerPath: join(root, "worker-service.cjs"),
        }],
      },
      codexHome: { home: join(root, "codex-home") },
      ledger: { emit: async () => {} },
      resultDirectory,
    }, {
      capture: async () => ({
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: '{"claudeMemEnabled":true,"claudeMemVersion":"13.15.3","ok":true}\n',
      }),
    }),
    (cause) => cause instanceof ClaudeMemError && cause.code === "E_CLAUDE_MEM_RECEIPT",
  );
});

test("arm D rejects a trailing worker receipt for another store", () => {
  const prepared = {
    dataDirectory: "/expected/store",
    workerPort: 37977,
    mcpIsolation: { workerScriptPath: "/isolated/worker-service.cjs" },
  };
  assert.throws(
    () => parseClaudeMemWorkerEvidence(workerReceipt(prepared, {
      kind: "claude-mem-worker-shutdown",
      dataDirectory: "/another/store",
      signal: "SIGTERM",
      pidClosed: true,
      portClosed: true,
    }), prepared),
    (cause) => cause instanceof ClaudeMemError && cause.code === "E_CLAUDE_MEM_RECEIPT",
  );
});

test("arm D rejects anything except the common Codex app-server command", () => {
  assert.throws(
    () => wrapClaudeMemCommand(["codex", "exec", "prompt"], { wrapperPath: "/wrapper" }),
    (cause) => cause instanceof ClaudeMemError && cause.code === "E_CLAUDE_MEM_COMMAND",
  );
});
