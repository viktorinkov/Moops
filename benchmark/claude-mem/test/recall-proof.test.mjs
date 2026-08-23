import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  buildCodexInvocation,
  buildRecallPrompt,
} from "../recall-helper.mjs";
import { verifyRecallEvidence } from "../verify-recall.mjs";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;
const registryPath = join(repositoryRoot, "benchmark/claude-mem/checkpoints.json");
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const checkpoints = registry.checkpoints.map(({ name, executableCheckpoint }) => ({
  name,
  path: executableCheckpoint.path,
  fingerprint: executableCheckpoint.fingerprint,
}));
const receipt = {
  schemaVersion: 1,
  workflow: ["search", "timeline", "get_observations"],
  checkpoints,
  selected: "checkout-ready",
};

function mcp(tool, result, argumentsValue = {}) {
  return {
    type: "item.completed",
    item: {
      id: `item-${tool}`,
      type: "mcp_tool_call",
      server: "mcp-search",
      tool,
      arguments: argumentsValue,
      result: { content: [{ type: "text", text: result }] },
      error: null,
      status: "completed",
    },
  };
}

function validEvents() {
  const recordedReceipt = structuredClone(receipt);
  const observationText = checkpoints
    .map(({ name, path, fingerprint }) => `${name}\n${path}\n${fingerprint}`)
    .join("\n");
  return [
    {
      type: "moops.recall.launcher.started",
      schemaVersion: 1,
      runId: "live-001-arm-d",
      callerPid: 101,
      launcherPid: 202,
      captureCompletedAt: "2026-08-23T22:00:00.000Z",
      startedAt: "2026-08-23T22:00:00.100Z",
      codexHome: "/tmp/codex-d",
      claudeMemDataDir: "/tmp/memory-d",
    },
    {
      type: "moops.recall.codex.started",
      launcherPid: 202,
      codexPid: 303,
      workerPid: 404,
      startedAt: "2026-08-23T22:00:00.200Z",
      command: "codex",
      argv: [
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox",
        "read-only",
        "--model",
        "gpt-5.6-sol",
        "--config",
        'service_tier="fast"',
      ],
      model: "gpt-5.6-sol",
      requestedServiceTier: "fast",
      sandbox: "read-only",
      ephemeral: true,
    },
    { type: "thread.started", thread_id: "fresh-thread" },
    mcp(
      "search",
      "catalog-ready #11; cart-ready #12; checkout-ready #13",
      {
        query: "MOOPS_MEMORY_CHECKPOINT",
        project: "moops-food-delivery",
        type: "observations",
        limit: 20,
      },
    ),
    mcp("timeline", "context around #13", {
      anchor: 13,
      project: "moops-food-delivery",
      depth_before: 3,
      depth_after: 3,
    }),
    mcp("get_observations", observationText, {
      ids: [11, 12, 13],
      project: "moops-food-delivery",
      orderBy: "date_asc",
    }),
    {
      type: "item.completed",
      item: { id: "answer", type: "agent_message", text: JSON.stringify(receipt) },
    },
    {
      type: "moops.recall.receipt",
      recordedAt: "2026-08-23T22:00:00.700Z",
      receipt: recordedReceipt,
    },
    { type: "turn.completed", usage: {} },
    {
      type: "moops.recall.codex.completed",
      launcherPid: 202,
      codexPid: 303,
      workerPidBefore: 404,
      workerPidAfter: 404,
      callerAliveAfter: true,
      exitCode: 0,
      signal: null,
      completedAt: "2026-08-23T22:00:00.800Z",
    },
  ];
}

test("accepts a fresh read-only recall with the exact ordered MCP workflow", () => {
  const report = verifyRecallEvidence(validEvents(), registry);

  assert.equal(report.ok, true);
  assert.equal(report.threadId, "fresh-thread");
  assert.equal(report.codexPid, 303);
  assert.equal(report.workerPid, 404);
  assert.deepEqual(report.workflow, ["search", "timeline", "get_observations"]);
  assert.deepEqual(report.receipt, receipt);
});

test("rejects an out-of-order or failed Claude-Mem MCP workflow", () => {
  const outOfOrder = validEvents();
  [outOfOrder[3], outOfOrder[4]] = [outOfOrder[4], outOfOrder[3]];
  assert.throws(
    () => verifyRecallEvidence(outOfOrder, registry),
    /MCP calls must be exactly search, timeline, get_observations/,
  );

  const failed = validEvents();
  failed[5].item.error = { message: "worker failed" };
  assert.throws(() => verifyRecallEvidence(failed, registry), /get_observations did not succeed/);
});

test("requires retrieved observations—not just the receipt—to contain every registry fingerprint", () => {
  const events = validEvents();
  events[5].item.result.content[0].text = events[5].item.result.content[0].text.replace(
    checkpoints[1].fingerprint,
    "sha256:missing",
  );

  assert.throws(
    () => verifyRecallEvidence(events, registry),
    /get_observations result is missing cart-ready fingerprint/,
  );
});

test("rejects a receipt that differs from the registry or the final agent message", () => {
  const wrongRegistryValue = validEvents();
  wrongRegistryValue[7].receipt.checkpoints[2].path = "invented.json";
  assert.throws(
    () => verifyRecallEvidence(wrongRegistryValue, registry),
    /receipt does not exactly match the checkpoint registry/,
  );

  const wrongAgentMessage = validEvents();
  wrongAgentMessage[6].item.text = JSON.stringify({ ...receipt, selected: "cart-ready" });
  assert.throws(
    () => verifyRecallEvidence(wrongAgentMessage, registry),
    /final agent message does not match the recorded receipt/,
  );
});

test("requires distinct fresh PIDs, monotonic timestamps, and one unchanged live worker", () => {
  const reusedPid = validEvents();
  reusedPid[1].codexPid = reusedPid[0].callerPid;
  assert.throws(() => verifyRecallEvidence(reusedPid, registry), /must use distinct positive PIDs/);

  const staleStart = validEvents();
  staleStart[0].startedAt = "2026-08-23T21:59:59.000Z";
  assert.throws(() => verifyRecallEvidence(staleStart, registry), /timestamps must be monotonic/);

  const restartedWorker = validEvents();
  restartedWorker.at(-1).workerPidAfter = 405;
  assert.throws(() => verifyRecallEvidence(restartedWorker, registry), /worker PID changed/);
});

test("helper invocation pins ephemeral read-only Codex 5.6 fast while inheriting arm-D environment", () => {
  const invocation = buildCodexInvocation({
    repositoryRoot,
    schemaPath: join(repositoryRoot, "benchmark/claude-mem/recall-receipt.schema.json"),
    receiptPath: "/tmp/receipt.json",
    environment: {
      CODEX_HOME: "/tmp/codex-d",
      CLAUDE_MEM_DATA_DIR: "/tmp/memory-d",
      CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
      CLAUDE_MEM_WORKER_PORT: "37977",
      MOOPS_CLAUDE_MEM_RUN_ID: "live-001-arm-d",
      SENTINEL: "inherited",
    },
  });

  assert.equal(invocation.command, "codex");
  assert.equal(invocation.environment.SENTINEL, "inherited");
  assert.deepEqual(invocation.args.slice(0, 12), [
    "exec",
    "--ephemeral",
    "--json",
    "--sandbox",
    "read-only",
    "--model",
    "gpt-5.6-sol",
    "--config",
    'service_tier="fast"',
    "--config",
    'approval_policy="never"',
    "--output-schema",
  ]);
  assert.equal(invocation.args.at(-1), "-");
});

test("recall prompt mandates search then timeline then get_observations without leaking descriptors", () => {
  const prompt = buildRecallPrompt();

  assert.match(prompt, /call exactly once, in this order: search, timeline, get_observations/);
  assert.match(prompt, /selected.*checkout-ready/s);
  for (const checkpoint of checkpoints) {
    assert.doesNotMatch(prompt, new RegExp(checkpoint.fingerprint));
    assert.doesNotMatch(prompt, new RegExp(checkpoint.path.replaceAll(".", "\\.")));
  }
});
