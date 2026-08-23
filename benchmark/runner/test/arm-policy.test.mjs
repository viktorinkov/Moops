import assert from "node:assert/strict";
import test from "node:test";

import {
  armPolicy,
  validateArmUsage,
  validateRuntimeCapabilities,
} from "../src/arm-policy.mjs";

const memoryCheckpoints = [
  { name: "catalog-ready", path: "benchmark/checkpoints/catalog.json", fingerprint: "sha256:catalog" },
  { name: "cart-ready", path: "benchmark/checkpoints/cart.json", fingerprint: "sha256:cart" },
  { name: "checkout-ready", path: "benchmark/checkpoints/checkout.json", fingerprint: "sha256:checkout" },
];
const expectedWorkspace = "/tmp/codex-uitest/benchmark/FoodDelivery/Food Delivery.xcodeproj";
const expectedTab = "windowtab-workspace";

function capabilities(armId) {
  const data = [
    { name: "codex_apps", pluginId: null, tools: { "github.search": {} } },
    {
      name: "xcode",
      pluginId: null,
      tools: { XcodeListWindows: {}, RenderPreview: {}, BuildProject: {} },
    },
  ];
  const marketplaces = [];
  if (armId === "codex-moops-claudemem") {
    data.push({
      name: "mcp-search",
      pluginId: "claude-mem@claude-mem-local",
      tools: { search: {}, timeline: {}, get_observations: {} },
    });
    marketplaces.push({
      name: "claude-mem-local",
      plugins: [{
        id: "claude-mem@claude-mem-local",
        enabled: true,
        installed: true,
        localVersion: "13.15.3",
        version: "13.15.3",
      }],
    });
  }
  return {
    mcp: { data, nextCursor: null },
    plugins: { marketplaces, marketplaceLoadErrors: [] },
  };
}

test("all arm policies share Xcode MCP while only B requires RenderPreview", () => {
  const ids = ["codex-uitest", "codex-previews", "codex-injection", "codex-moops-claudemem"];
  const policies = ids.map(armPolicy);
  assert.equal(policies.every(({ instructions }) => instructions.includes("Apple Xcode MCP")), true);
  assert.equal(policies[1].instructions.includes("RenderPreview"), true);
  assert.equal(new Set(policies.map(({ sha256 }) => sha256)).size, 4);
});

test("runtime inventory requires Xcode everywhere and Claude-Mem only in D", () => {
  for (const id of ["codex-uitest", "codex-previews", "codex-injection", "codex-moops-claudemem"]) {
    const inventory = capabilities(id);
    assert.equal(validateRuntimeCapabilities(id, inventory.mcp, inventory.plugins).xcode.tools
      .includes("RenderPreview"), true);
    assert.deepEqual(
      validateRuntimeCapabilities(id, inventory.mcp, inventory.plugins).ambientServers,
      ["codex_apps"],
    );
  }
  const contaminated = capabilities("codex-moops-claudemem");
  assert.throws(
    () => validateRuntimeCapabilities("codex-uitest", contaminated.mcp, contaminated.plugins),
    /Claude-Mem|capability isolation/,
  );
});

test("usage gate requires Xcode in every arm, RenderPreview only in B, and D fresh recall plus MOOPS", () => {
  const xcode = {
    server: "xcode",
    tool: "XcodeListWindows",
    status: "completed",
    argumentsText: "{}",
    resultText: JSON.stringify({
      content: [{ type: "text", text: `tabIdentifier: ${expectedTab}\nworkspacePath: ${expectedWorkspace}` }],
    }),
  };
  assert.doesNotThrow(() => validateArmUsage("codex-uitest", [xcode], [], [], expectedWorkspace));
  assert.throws(
    () => validateArmUsage("codex-previews", [xcode], [], [], expectedWorkspace),
    /RenderPreview/,
  );
  assert.doesNotThrow(() => validateArmUsage("codex-previews", [
    xcode,
    {
      server: "xcode",
      tool: "RenderPreview",
      status: "completed",
      argumentsText: JSON.stringify({ tabIdentifier: expectedTab }),
      resultText: "preview",
    },
  ], [], [], expectedWorkspace));
  assert.throws(
    () => validateArmUsage("codex-uitest", [
      xcode,
      {
        server: "xcode",
        tool: "RenderPreview",
        status: "completed",
        argumentsText: JSON.stringify({ tabIdentifier: expectedTab }),
        resultText: "preview",
      },
    ], [], [], expectedWorkspace),
    /forbids RenderPreview/,
  );
  assert.throws(
    () => validateArmUsage("codex-uitest", [{ ...xcode, resultText: "another workspace" }], [], [], expectedWorkspace),
    /XcodeListWindows|workspace/i,
  );
  assert.throws(
    () => validateArmUsage("codex-uitest", [{
      ...xcode,
      resultText: JSON.stringify({
        content: [{
          type: "text",
          text: `tabIdentifier: ${expectedTab}\nworkspacePath: ${expectedWorkspace}\ntabIdentifier: wrong\nworkspacePath: /tmp/other/Food Delivery.xcodeproj`,
        }],
      }),
    }], [], [], expectedWorkspace),
    /another workspace/i,
  );
  assert.throws(
    () => validateArmUsage("codex-previews", [
      xcode,
      {
        server: "xcode",
        tool: "RenderPreview",
        status: "completed",
        argumentsText: JSON.stringify({ tabIdentifier: "another-tab" }),
        resultText: "preview",
      },
    ], [], [], expectedWorkspace),
    /tab|workspace/i,
  );

  const commands = [
    "node benchmark/claude-mem/registry.mjs --packet catalog-ready",
    "node benchmark/claude-mem/registry.mjs --packet cart-ready",
    "node benchmark/claude-mem/registry.mjs --packet checkout-ready",
    "node benchmark/claude-mem/recall-helper.mjs --output \"$MOOPS_BENCHMARK_RESULTS_DIR/claude-mem-recall.jsonl\" --capture-completed-at \"$(node -p 'new Date().toISOString()')\" --caller-pid \"$$\"",
    "node benchmark/claude-mem/verify-recall.mjs \"$MOOPS_BENCHMARK_RESULTS_DIR/claude-mem-recall.jsonl\"",
    "tools/moops/moops build-and-restore benchmark/checkpoints/food-delivery-cart.json",
  ].map((command) => ({ command, status: "completed", exitCode: 0 }));
  assert.doesNotThrow(() => validateArmUsage(
    "codex-moops-claudemem",
    [xcode],
    commands,
    memoryCheckpoints,
    expectedWorkspace,
  ));
  assert.throws(
    () => validateArmUsage(
      "codex-moops-claudemem",
      [xcode],
      commands.filter(({ command }) => !command.includes("recall-helper.mjs")),
      memoryCheckpoints,
      expectedWorkspace,
    ),
    /recall helper/,
  );
});
