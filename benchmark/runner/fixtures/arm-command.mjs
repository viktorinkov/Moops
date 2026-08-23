import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const threadId = `thread-${process.env.MOOPS_BENCHMARK_ARM_ID}`;
const turnId = `turn-${process.env.MOOPS_BENCHMARK_ARM_ID}`;
let objective = null;
let goalStatus = null;
let tokensUsed = 0;
let timeUsedSeconds = 0;

function goal() {
  return {
    threadId,
    objective,
    status: goalStatus,
    tokenBudget: null,
    tokensUsed,
    timeUsedSeconds,
    createdAt: 1,
    updatedAt: 1,
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function completedItem(item) {
  send({
    method: "item/completed",
    params: {
      completedAtMs: Date.now(),
      item,
      threadId,
      turnId,
    },
  });
}

async function recordObserved(threadParams) {
  const names = [
    "MOOPS_BENCHMARK_RUN_ID",
    "CODEX_HOME",
    "MOOPS_CLAUDE_MEM_RUN_ID",
    "MOOPS_BENCHMARK_ARM_ID",
    "MOOPS_BENCHMARK_ARM_LABEL",
    "MOOPS_BENCHMARK_WORKTREE",
    "MOOPS_BENCHMARK_SIMULATOR_UDID",
    "MOOPS_BENCHMARK_DERIVED_DATA",
    "MOOPS_BENCHMARK_RESULTS_DIR",
    "MOOPS_BENCHMARK_PROMPT_PATH",
    "MOOPS_BENCHMARK_PROMPT_SHA256",
    "MOOPS_BENCHMARK_MODEL",
    "MOOPS_BENCHMARK_SERVICE_TIER",
    "MOOPS_BENCHMARK_START_EPOCH_MS",
    "MOOPS_BENCHMARK_DEADLINE_EPOCH_MS",
    "MOOPS_BACKEND_BASE_URL",
  ];
  const observed = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  observed.protocolThreadStart = threadParams;
  await writeFile(
    `${process.env.MOOPS_BENCHMARK_RESULTS_DIR}/observed-env.json`,
    `${JSON.stringify(observed, null, 2)}\n`,
  );
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") continue;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex-app-server/1" } });
    continue;
  }
  if (message.method === "thread/start") {
    await recordObserved(message.params);
    send({
      id: message.id,
      result: {
        thread: {
          id: threadId,
          ephemeral: false,
        },
        model: message.params.model,
        serviceTier: message.params.serviceTier === "fast" ? "priority" : message.params.serviceTier,
        approvalPolicy: message.params.approvalPolicy,
        sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
        cwd: message.params.cwd,
        modelProvider: "openai",
        approvalsReviewer: "user",
      },
    });
    send({ method: "thread/started", params: { thread: { id: threadId } } });
    continue;
  }
  if (message.method === "mcpServerStatus/list") {
    const data = [{
      authStatus: "unsupported",
      name: "xcode",
      pluginId: null,
      resourceTemplates: [],
      resources: [],
      tools: { BuildProject: {}, RenderPreview: {}, XcodeListWindows: {} },
    }];
    if (process.env.MOOPS_BENCHMARK_ARM_ID === "codex-moops-claudemem") {
      data.push({
        authStatus: "unsupported",
        name: "mcp-search",
        pluginId: "claude-mem@claude-mem-local",
        resourceTemplates: [],
        resources: [],
        tools: { get_observations: {}, search: {}, timeline: {} },
      });
    }
    send({ id: message.id, result: { data, nextCursor: null } });
    continue;
  }
  if (message.method === "plugin/list") {
    const marketplaces = process.env.MOOPS_BENCHMARK_ARM_ID === "codex-moops-claudemem"
      ? [{
        name: "claude-mem-local",
        plugins: [{
          id: "claude-mem@claude-mem-local",
          enabled: true,
          installed: true,
          localVersion: "13.15.3",
          version: "13.15.3",
        }],
      }]
      : [];
    send({ id: message.id, result: { marketplaces, marketplaceLoadErrors: [] } });
    continue;
  }
  if (message.method === "thread/goal/get") {
    send({ id: message.id, result: { goal: goal() } });
    continue;
  }
  if (message.method === "thread/settings/update") {
    send({ id: message.id, result: {} });
    send({
      method: "thread/settings/updated",
      params: {
        threadId,
        threadSettings: {
          approvalPolicy: message.params.approvalPolicy,
          approvalsReviewer: "user",
          collaborationMode: { mode: "default", settings: { model: message.params.model } },
          cwd: message.params.cwd,
          effort: null,
          model: message.params.model,
          modelProvider: "openai",
          multiAgentMode: "explicitRequestOnly",
          personality: null,
          sandboxPolicy: message.params.sandboxPolicy,
          serviceTier: message.params.serviceTier === "fast" ? "priority" : message.params.serviceTier,
          summary: null,
        },
      },
    });
    continue;
  }
  if (message.method === "thread/goal/set" && message.params.objective) {
    objective = message.params.objective;
    goalStatus = message.params.status;
    send({ id: message.id, result: { goal: goal() } });
    send({ method: "thread/goal/updated", params: { threadId, turnId: null, goal: goal() } });
    continue;
  }
  if (message.method === "thread/goal/set" && message.params.status === "active") {
    goalStatus = "active";
    send({ id: message.id, result: { goal: goal() } });
    send({ method: "thread/goal/updated", params: { threadId, turnId, goal: goal() } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
    completedItem({
      id: `xcode-${turnId}`,
      type: "mcpToolCall",
      server: "xcode",
      tool: "XcodeListWindows",
      status: "completed",
      arguments: {},
      result: { content: [{ type: "text", text: "window" }] },
    });
    if (process.env.MOOPS_BENCHMARK_ARM_ID === "codex-previews") {
      completedItem({
        id: `preview-${turnId}`,
        type: "mcpToolCall",
        server: "xcode",
        tool: "RenderPreview",
        status: "completed",
        arguments: {},
        result: { content: [{ type: "text", text: "preview rendered" }] },
      });
    }
    if (process.env.MOOPS_BENCHMARK_ARM_ID === "codex-moops-claudemem") {
      for (const name of ["catalog-ready", "cart-ready", "checkout-ready"]) {
        completedItem({
          id: `packet-${name}`,
          type: "commandExecution",
          command: `node benchmark/claude-mem/registry.mjs --packet ${name}`,
          commandActions: [],
          cwd: process.cwd(),
          status: "completed",
          exitCode: 0,
        });
      }
      completedItem({
        id: "fresh-recall",
        type: "commandExecution",
        command: "node benchmark/claude-mem/recall-helper.mjs --output \"$MOOPS_BENCHMARK_RESULTS_DIR/claude-mem-recall.jsonl\" --capture-completed-at \"$(node -p 'new Date().toISOString()')\" --caller-pid \"$$\"",
        commandActions: [],
        cwd: process.cwd(),
        status: "completed",
        exitCode: 0,
      });
      completedItem({
        id: "verify-recall",
        type: "commandExecution",
        command: "node benchmark/claude-mem/verify-recall.mjs \"$MOOPS_BENCHMARK_RESULTS_DIR/claude-mem-recall.jsonl\"",
        commandActions: [],
        cwd: process.cwd(),
        status: "completed",
        exitCode: 0,
      });
      completedItem({
        id: "moops-restore",
        type: "commandExecution",
        command: "tools/moops/moops build-and-restore benchmark/checkpoints/food-delivery-cart.json",
        commandActions: [],
        cwd: process.cwd(),
        status: "completed",
        exitCode: 0,
        aggregatedOutput: JSON.stringify({
          reportVersion: 1,
          command: "build-and-restore",
          ok: true,
          phases: [{ name: "restore-and-inspect", ok: true, elapsedMs: 12 }],
          timingsMs: { buildMs: 40, restoreAndInspectMs: 12, totalMs: 52 },
        }, null, 2),
      });
    }
    await delay(Number(process.env.BENCHMARK_TEST_DELAY_MS ?? "25"));
    const failing = Number(process.env.BENCHMARK_TEST_EXIT ?? "0") !== 0;
    goalStatus = failing ? "blocked" : "complete";
    tokensUsed = 100;
    timeUsedSeconds = 1;
    send({ method: "thread/goal/updated", params: { threadId, turnId, goal: goal() } });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          status: failing ? "failed" : "completed",
          durationMs: Number(process.env.BENCHMARK_TEST_DELAY_MS ?? "25"),
          error: failing ? { message: "fixture failure" } : null,
          items: [],
        },
      },
    });
  }
}

if (process.env.MOOPS_BENCHMARK_ARM_ID === "codex-moops-claudemem") {
  await delay(Number(process.env.BENCHMARK_TRAILING_DELAY_MS ?? "0"));
  send({
    ok: true,
    dataDirectory: "/fixture/claude-mem",
    pid: 45_678,
    version: "13.15.3",
  });
}
