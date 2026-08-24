import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

const COMMON = [
  "Use the Apple Xcode MCP exposed as server `xcode` by `/usr/bin/xcrun mcpbridge`.",
  "Your first Xcode MCP call must be XcodeListWindows. Use only the tab for the exact canonical workspace `$MOOPS_BENCHMARK_WORKTREE/benchmark/FoodDelivery/Food Delivery.xcodeproj`; ignore every other tab.",
  "The runner binds this arm's bridge to its dedicated Xcode process through MCP_XCODE_PID.",
  "For every shell xcodebuild build or test, pass `-destination \"id=$MOOPS_BENCHMARK_SIMULATOR_UDID\"`; never use another destination.",
  "Also pass `-derivedDataPath \"$MOOPS_BENCHMARK_DERIVED_DATA\"`, except test-without-building may instead use `-xctestrun \"$MOOPS_BENCHMARK_DERIVED_DATA/...xctestrun\"`; never use another DerivedData or xctestrun path.",
  "Complete at least one successful Xcode MCP call and keep the real app as the source of truth.",
];

const POLICY_LINES = Object.freeze({
  "codex-uitest": [
    ...COMMON,
    "Use UI automation/XCUITest only for feedback; do not call RenderPreview.",
    "Do not use InjectionIII, MOOPS checkpoints, or Claude-Mem/mcp-search.",
  ],
  "codex-previews": [
    ...COMMON,
    "Call Xcode MCP RenderPreview successfully at least once and use that Preview as feedback.",
    "Do not use InjectionIII, MOOPS checkpoints, or Claude-Mem/mcp-search.",
  ],
  "codex-injection": [
    ...COMMON,
    "Use the provisioned InjectionIII treatment and preserve its runtime evidence; do not call RenderPreview.",
    "After editing, launch the real app with /usr/bin/xcrun simctl launch so the runner can bind its PID to InjectionIII.",
    "If the edit adds a Swift source or changes stored layout, also complete a normal xcodebuild using $MOOPS_BENCHMARK_DERIVED_DATA.",
    "Do not use MOOPS checkpoints or Claude-Mem/mcp-search.",
  ],
  "codex-moops-claudemem": [
    ...COMMON,
    "Do not call RenderPreview.",
    "Run these commands separately and in this exact order:",
    "node benchmark/claude-mem/registry.mjs --packet catalog-ready",
    "node benchmark/claude-mem/registry.mjs --packet cart-ready",
    "node benchmark/claude-mem/registry.mjs --packet checkout-ready",
    "node benchmark/claude-mem/recall-helper.mjs --output \"$MOOPS_BENCHMARK_RESULTS_DIR/claude-mem-recall.jsonl\" --capture-completed-at \"$(node -p 'new Date().toISOString()')\" --caller-pid \"$$\"",
    "node benchmark/claude-mem/verify-recall.mjs \"$MOOPS_BENCHMARK_RESULTS_DIR/claude-mem-recall.jsonl\"",
    "tools/moops/moops build-and-restore benchmark/checkpoints/food-delivery-cart.json",
    "The fresh recall helper—not this outer Goal—must call mcp-search in the order search, timeline, get_observations and select checkout-ready.",
  ],
});

export class ArmPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArmPolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ArmPolicyError(code, message);
}

export function armPolicy(armId) {
  const lines = POLICY_LINES[armId];
  if (!lines) fail("E_ARM_POLICY", `unknown benchmark arm ${armId}`);
  const instructions = lines.join("\n");
  return {
    instructions,
    sha256: `sha256:${createHash("sha256").update(instructions).digest("hex")}`,
  };
}

export function validateRuntimeCapabilities(armId, mcpResult, pluginResult) {
  if (!Array.isArray(mcpResult?.data) || mcpResult.nextCursor != null) {
    fail("E_CAPABILITY_INVENTORY", "MCP inventory was missing or paginated");
  }
  const servers = new Map(mcpResult.data.map((server) => [server.name, server]));
  const ambientApps = servers.get("codex_apps");
  if (ambientApps && ambientApps.pluginId != null) {
    fail("E_CAPABILITY_INVENTORY", `${armId} exposed codex_apps through a treatment plugin`);
  }
  const treatmentServers = new Map(
    [...servers].filter(([name]) => name !== "codex_apps"),
  );
  const xcode = treatmentServers.get("xcode");
  const xcodeTools = Object.keys(xcode?.tools ?? {}).sort();
  if (!xcode || xcode.pluginId != null || !xcodeTools.includes("RenderPreview")) {
    fail("E_XCODE_MCP", `${armId} lacks the common Xcode MCP/RenderPreview inventory`);
  }
  const memory = treatmentServers.get("mcp-search");
  const enabledPlugins = (pluginResult?.marketplaces ?? []).flatMap(({ plugins = [] }) => plugins)
    .filter(({ enabled, installed }) => enabled && installed);
  if ((pluginResult?.marketplaceLoadErrors ?? []).length !== 0) {
    fail("E_CAPABILITY_INVENTORY", `${armId} had plugin marketplace load errors`);
  }
  if (armId === "codex-moops-claudemem") {
    const memoryTools = Object.keys(memory?.tools ?? {});
    const plugin = enabledPlugins.find(({ id }) => id === "claude-mem@claude-mem-local");
    if (!memory
      || memory.pluginId !== "claude-mem@claude-mem-local"
      || !["search", "timeline", "get_observations"].every((tool) => memoryTools.includes(tool))
      || !plugin
      || plugin.localVersion !== "13.15.3"
      || (plugin.version != null && plugin.version !== "13.15.3")
      || enabledPlugins.length !== 1
      || treatmentServers.size !== 2) {
      fail("E_CLAUDE_MEM_CAPABILITY", "arm D lacks its exact Claude-Mem 13.15.3 capability set");
    }
  } else if (memory || enabledPlugins.length !== 0 || treatmentServers.size !== 1) {
    fail("E_CAPABILITY_ISOLATION", `${armId} violated Claude-Mem capability isolation`);
  }
  return {
    xcode: { server: "xcode", pluginId: xcode.pluginId ?? null, tools: xcodeTools },
    claudeMem: memory ? {
      server: memory.name,
      pluginId: memory.pluginId,
      tools: Object.keys(memory.tools).sort(),
      version: "13.15.3",
    } : null,
    enabledPlugins: enabledPlugins.map(({ id, localVersion, version }) => ({ id, localVersion, version })),
    ambientServers: ambientApps ? ["codex_apps"] : [],
  };
}

function evidenceValues(source) {
  let value = source;
  if (typeof source === "string") {
    try { value = JSON.parse(source); } catch { value = source; }
  }
  const strings = [];
  const tabIdentifiers = [];
  const visit = (candidate, key = null) => {
    if (typeof candidate === "string") {
      strings.push(candidate);
      if (key === "tabIdentifier") tabIdentifiers.push(candidate);
      for (const match of candidate.matchAll(/\btabIdentifier["']?\s*[=:]\s*["']?([A-Za-z0-9._:-]+)/g)) {
        tabIdentifiers.push(match[1]);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => visit(entry));
      return;
    }
    if (candidate && typeof candidate === "object") {
      Object.entries(candidate).forEach(([entryKey, entry]) => visit(entry, entryKey));
    }
  };
  visit(value);
  return { strings, tabIdentifiers: [...new Set(tabIdentifiers)] };
}

function xcodebuildSegments(command) {
  if (typeof command !== "string") return [];
  const starts = [...command.matchAll(
    /(?<![A-Za-z0-9_.-])xcodebuild(?=["']?(?:\s|$))/g,
  )].map(({ index }) => index);
  return starts.map((start, index) => command.slice(start, starts[index + 1] ?? command.length))
    .filter((segment) => (
      /(?:^|\s)(?:build|test|build-for-testing|test-without-building)(?=\s|["';|&]|$)/
        .test(segment)
    ));
}

function optionValues(command, option) {
  const pattern = new RegExp(
    `(?:^|\\s)${option}(?:\\s+|=)(?:"([^"]*)"|'([^']*)'|([^\\s;&|]+))`,
    "g",
  );
  return [...command.matchAll(pattern)].map((match) => ({
    quote: match[1] !== undefined ? "double" : match[2] !== undefined ? "single" : null,
    value: match[1] ?? match[2] ?? match[3],
  }));
}

function normalizedShellValue(value) {
  return value.replaceAll("\"", "").replaceAll("'", "").replaceAll("\\ ", " ").trim();
}

function isAllowedValue(candidate, expected, environmentName) {
  const normalized = normalizedShellValue(candidate.value);
  if (normalized === expected) return true;
  if (candidate.quote === "single") return false;
  return normalized === `$${environmentName}` || normalized === `\${${environmentName}}`;
}

function isAllowedArtifact(candidate, expectedRoot, environmentName) {
  const normalized = normalizedShellValue(candidate.value);
  if (candidate.quote !== "single") {
    for (const prefix of [`$${environmentName}`, `\${${environmentName}}`]) {
      if (normalized === prefix) return true;
      if (normalized.startsWith(`${prefix}/`)) {
        return !normalized.slice(prefix.length + 1).split("/").includes("..");
      }
    }
  }
  if (!isAbsolute(normalized)) return false;
  const descendant = relative(resolve(expectedRoot), resolve(normalized));
  return descendant === ""
    || (descendant !== ".." && !descendant.startsWith(`..${sep}`) && !isAbsolute(descendant));
}

function validateXcodeCommandBindings(armId, commands, expectedBinding) {
  const bindingAssignment = /\b(?:MOOPS_BENCHMARK_SIMULATOR_UDID|MOOPS_BENCHMARK_DERIVED_DATA)\b["']?\s*\+?=(?!=)/;
  if (commands.some(({ command } = {}) => (
    typeof command === "string" && bindingAssignment.test(command)
  ))) {
    fail("E_XCODE_BINDING_OVERRIDE", `${armId} reassigned a runner-owned Xcode binding`);
  }
  const segments = commands.flatMap(({ command } = {}) => xcodebuildSegments(command));
  if (segments.length === 0) return { shellBuildOrTestCommands: 0 };
  if (typeof expectedBinding?.simulatorUdid !== "string"
    || expectedBinding.simulatorUdid === ""
    || typeof expectedBinding?.derivedData !== "string"
    || expectedBinding.derivedData === "") {
    fail("E_XCODE_BINDING", `${armId} omitted its assigned simulator or DerivedData binding`);
  }
  for (const segment of segments) {
    const destinations = optionValues(segment, "-destination");
    const destinationMatches = destinations.length > 0 && destinations.every((candidate) => {
      const identifier = normalizedShellValue(candidate.value).split(",")
        .map((component) => component.trim())
        .find((component) => component.startsWith("id="));
      if (!identifier) return false;
      return isAllowedValue(
        { ...candidate, value: identifier.slice(3) },
        expectedBinding.simulatorUdid,
        "MOOPS_BENCHMARK_SIMULATOR_UDID",
      );
    });
    if (!destinationMatches) {
      fail("E_XCODE_DESTINATION", `${armId} xcodebuild did not target its assigned recorded simulator`);
    }
    const derivedDataPaths = optionValues(segment, "-derivedDataPath");
    const derivedDataMatches = derivedDataPaths.every((candidate) => isAllowedValue(
      candidate,
      expectedBinding.derivedData,
      "MOOPS_BENCHMARK_DERIVED_DATA",
    ));
    const testWithoutBuilding = /(?:^|\s)test-without-building(?=\s|["';|&]|$)/.test(segment);
    if (testWithoutBuilding) {
      const xctestrunPaths = optionValues(segment, "-xctestrun");
      if (xctestrunPaths.length === 0 || !xctestrunPaths.every((candidate) => isAllowedArtifact(
        candidate,
        expectedBinding.derivedData,
        "MOOPS_BENCHMARK_DERIVED_DATA",
      ))) {
        fail("E_XCODE_XCTESTRUN", `${armId} xcodebuild used an xctestrun outside its DerivedData`);
      }
      if (!derivedDataMatches) {
        fail("E_XCODE_DERIVED_DATA", `${armId} xcodebuild did not use its isolated DerivedData`);
      }
    } else if (derivedDataPaths.length === 0 || !derivedDataMatches) {
      fail("E_XCODE_DERIVED_DATA", `${armId} xcodebuild did not use its isolated DerivedData`);
    }
  }
  return {
    shellBuildOrTestCommands: segments.length,
    simulatorUdid: expectedBinding.simulatorUdid,
    derivedData: expectedBinding.derivedData,
  };
}

function validateXcodeWorkspaceBinding(armId, xcodeCalls, expectedWorkspace) {
  if (typeof expectedWorkspace !== "string" || expectedWorkspace === "") {
    fail("E_XCODE_WORKSPACE", `${armId} omitted its expected canonical Xcode workspace`);
  }
  const first = xcodeCalls[0];
  if (!first || first.tool !== "XcodeListWindows" || first.status !== "completed") {
    fail("E_XCODE_WORKSPACE", `${armId} first Xcode MCP call was not a successful XcodeListWindows`);
  }
  const listing = evidenceValues(first.resultText);
  if (!listing.strings.some((value) => value.includes(expectedWorkspace))) {
    fail("E_XCODE_WORKSPACE", `${armId} XcodeListWindows did not contain ${expectedWorkspace}`);
  }
  const listedWorkspaces = [...new Set(listing.strings.flatMap((value) => (
    [...value.replaceAll("\\/", "/").matchAll(/\/[^\n\r"']+?\.xcodeproj/g)]
      .map((match) => match[0])
  )))];
  if (listedWorkspaces.some((workspace) => workspace !== expectedWorkspace)) {
    fail("E_XCODE_WORKSPACE", `${armId} XcodeListWindows exposed another workspace tab`);
  }
  if (listing.tabIdentifiers.length === 0) {
    fail("E_XCODE_WORKSPACE", `${armId} XcodeListWindows omitted the canonical tab identifier`);
  }
  for (const call of xcodeCalls.slice(1)) {
    const argumentTabs = evidenceValues(call.argumentsText).tabIdentifiers;
    if (argumentTabs.some((tab) => !listing.tabIdentifiers.includes(tab))) {
      fail("E_XCODE_WORKSPACE", `${armId} ${call.tool} targeted a tab outside its canonical workspace`);
    }
    if (call.tool === "RenderPreview" && argumentTabs.length === 0) {
      fail("E_PREVIEW_WORKSPACE", "RenderPreview omitted the canonical workspace tabIdentifier");
    }
  }
  return { expectedWorkspace, tabIdentifiers: listing.tabIdentifiers };
}

export function validateArmUsage(
  armId,
  mcpCalls,
  commands,
  memoryCheckpoints = [],
  expectedWorkspace,
  expectedXcodeBinding,
) {
  const xcodeCalls = mcpCalls.filter(({ server }) => server === "xcode");
  const workspaceBinding = validateXcodeWorkspaceBinding(armId, xcodeCalls, expectedWorkspace);
  const xcodeCommandBinding = validateXcodeCommandBindings(
    armId,
    commands,
    expectedXcodeBinding,
  );
  const successfulXcode = xcodeCalls.filter(({ status }) => (
    status === "completed"
  ));
  if (successfulXcode.length === 0) fail("E_XCODE_MCP_USE", `${armId} did not use Xcode MCP successfully`);
  const previewCalls = mcpCalls.filter(({ server, tool }) => server === "xcode" && tool === "RenderPreview");
  if (armId === "codex-previews") {
    if (!previewCalls.some(({ status }) => status === "completed")) {
      fail("E_PREVIEW_USE", "preview arm did not complete RenderPreview");
    }
  } else if (previewCalls.length !== 0) {
    fail("E_PREVIEW_ISOLATION", `${armId} forbids RenderPreview`);
  }

  const memoryCalls = mcpCalls.filter(({ server }) => server === "mcp-search");
  if (armId !== "codex-moops-claudemem") {
    if (memoryCalls.length !== 0) fail("E_MEMORY_ISOLATION", `${armId} used Claude-Mem`);
    return {
      xcodeCalls: successfulXcode.length,
      renderPreviewCalls: previewCalls.length,
      workspaceBinding,
      xcodeCommandBinding,
    };
  }
  if (memoryCalls.length !== 0) {
    fail("E_MEMORY_USE", "arm D outer Goal must delegate fresh recall to recall-helper");
  }
  if (memoryCheckpoints.length !== 3) fail("E_MEMORY_RECEIPT", "arm D checkpoint evidence was missing");
  const successfulCommands = commands.filter(({ status, exitCode }) => status === "completed" && exitCode === 0);
  const orderedCommands = [
    {
      code: "E_MEMORY_PACKET",
      label: "catalog-ready packet",
      matches: (command) => command.includes("benchmark/claude-mem/registry.mjs")
        && command.includes("--packet catalog-ready"),
    },
    {
      code: "E_MEMORY_PACKET",
      label: "cart-ready packet",
      matches: (command) => command.includes("benchmark/claude-mem/registry.mjs")
        && command.includes("--packet cart-ready"),
    },
    {
      code: "E_MEMORY_PACKET",
      label: "checkout-ready packet",
      matches: (command) => command.includes("benchmark/claude-mem/registry.mjs")
        && command.includes("--packet checkout-ready"),
    },
    {
      code: "E_MEMORY_RECALL",
      label: "fresh recall helper",
      matches: (command) => command.includes("benchmark/claude-mem/recall-helper.mjs")
        && command.includes("--output")
        && command.includes("claude-mem-recall.jsonl")
        && command.includes("--capture-completed-at")
        && command.includes("--caller-pid"),
    },
    {
      code: "E_MEMORY_RECALL",
      label: "recall verifier",
      matches: (command) => command.includes("benchmark/claude-mem/verify-recall.mjs")
        && command.includes("claude-mem-recall.jsonl"),
    },
    {
      code: "E_MOOPS_USE",
      label: "checkout-ready MOOPS restore",
      matches: (command) => command.includes("tools/moops/moops build-and-restore")
        && command.includes("benchmark/checkpoints/food-delivery-cart.json"),
    },
  ];
  let previousIndex = -1;
  for (const required of orderedCommands) {
    const index = successfulCommands.findIndex(({ command }, candidate) => (
      candidate > previousIndex && required.matches(command)
    ));
    if (index < 0) fail(required.code, `arm D did not complete ordered ${required.label}`);
    previousIndex = index;
  }
  return {
    xcodeCalls: successfulXcode.length,
    renderPreviewCalls: 0,
    memoryWorkflow: ["search", "timeline", "get_observations"],
    recallEvidencePath: "claude-mem-recall.jsonl",
    selectedCheckpoint: "checkout-ready",
    recalledCheckpoints: memoryCheckpoints,
    workspaceBinding,
    xcodeCommandBinding,
  };
}
