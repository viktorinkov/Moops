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
  wrapClaudeMemCommand,
} from "../src/claude-mem.mjs";

test("arm D stages a fresh run-scoped store and wraps the exact app-server command", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-mem-"));
  const worktree = join(root, "worktree");
  const resultDirectory = join(root, "results");
  await Promise.all([mkdir(worktree), mkdir(resultDirectory)]);
  await mkdir(join(worktree, "benchmark/claude-mem"), { recursive: true });
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
          CLAUDE_MEM_DATA_DIR: join(worktree, "results/claude-mem/take-001-arm-d"),
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
    codexHome: { home: join(root, "codex-home") },
    resultDirectory,
    ledger: { emit: async (...event) => ledgerEvents.push(event) },
  }, { capture });

  assert.equal(prepared.runId, "take-001-arm-d");
  assert.equal(prepared.memoryCheckpoints.length, 3);
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
  assert.equal(JSON.parse(await readFile(join(resultDirectory, "claude-mem-preflight.json"))).runId,
    "take-001-arm-d");
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

test("arm D validates and preserves the wrapper's exact worker identity receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-mem-receipt-"));
  const resultDirectory = join(root, "results");
  await mkdir(resultDirectory);
  const prepared = {
    runId: "take-001-arm-d",
    wrapperPath: "/fixture/run-arm-d",
    dataDirectory: join(root, "store"),
    memoryCheckpoints: [
      { name: "catalog-ready", path: "benchmark/checkpoints/catalog.json", fingerprint: `sha256:${"1".repeat(64)}` },
      { name: "cart-ready", path: "benchmark/checkpoints/cart.json", fingerprint: `sha256:${"2".repeat(64)}` },
      { name: "checkout-ready", path: "benchmark/checkpoints/checkout.json", fingerprint: `sha256:${"3".repeat(64)}` },
    ],
  };
  await writeFile(join(resultDirectory, "claude-mem-recall.jsonl"), '{"type":"fixture"}\n');
  const receipt = parseClaudeMemWorkerEvidence({
    ok: true,
    dataDirectory: prepared.dataDirectory,
    pid: 456,
    version: "13.15.3",
  }, prepared);
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
  assert.deepEqual(verified.workerIdentityAndShutdown, receipt);
  assert.equal(verified.recall.receipt.selected, "checkout-ready");
  assert.equal(JSON.parse(await readFile(join(resultDirectory, "claude-mem-postflight.json")))
    .workerIdentityAndShutdown.pid, 456);
});

test("arm D rejects a trailing worker receipt for another store", () => {
  assert.throws(
    () => parseClaudeMemWorkerEvidence({
      ok: true,
      dataDirectory: "/another/store",
      pid: 456,
      version: "13.15.3",
    }, { dataDirectory: "/expected/store" }),
    (cause) => cause instanceof ClaudeMemError && cause.code === "E_CLAUDE_MEM_RECEIPT",
  );
});

test("arm D rejects anything except the common Codex app-server command", () => {
  assert.throws(
    () => wrapClaudeMemCommand(["codex", "exec", "prompt"], { wrapperPath: "/wrapper" }),
    (cause) => cause instanceof ClaudeMemError && cause.code === "E_CLAUDE_MEM_COMMAND",
  );
});
