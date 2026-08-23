import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadAndValidateRegistry, validateRegistry } from "./registry.mjs";

const REQUIRED_WORKFLOW = ["search", "timeline", "get_observations"];

function requireObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value;
}

function positivePid(value, context) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${context} must be a positive PID`);
  return value;
}

function timestamp(value, context) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${context} must be an ISO timestamp`);
  }
  return Date.parse(value);
}

function oneEvent(events, type) {
  const matches = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === type);
  if (matches.length !== 1) throw new Error(`evidence must contain exactly one ${type} event`);
  return matches[0];
}

function parseArguments(value, tool) {
  if (typeof value === "string") {
    try {
      return requireObject(JSON.parse(value), `${tool} arguments`);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${tool} arguments are not valid JSON`);
      throw error;
    }
  }
  return requireObject(value, `${tool} arguments`);
}

function successfulMcpCall(item, tool) {
  if (item.server !== "mcp-search" || item.tool !== tool) return false;
  if (item.status !== undefined && !["completed", "success", "succeeded"].includes(item.status)) {
    return false;
  }
  if (item.error !== undefined && item.error !== null) return false;
  if (item.result === undefined || item.result === null) return false;
  if (item.result?.isError === true || item.result?.is_error === true) return false;
  return true;
}

function expectedReceipt(registry) {
  return {
    schemaVersion: 1,
    workflow: REQUIRED_WORKFLOW,
    checkpoints: registry.checkpoints.map(({ name, executableCheckpoint }) => ({
      name,
      path: executableCheckpoint.path,
      fingerprint: executableCheckpoint.fingerprint,
    })),
    selected: "checkout-ready",
  };
}

function exactJson(value) {
  return JSON.stringify(value);
}

function hasArgPair(argv, flag, value) {
  return argv.some((entry, index) => entry === flag && argv[index + 1] === value);
}

function requireInvocation(started) {
  if (started.command !== "codex" || !Array.isArray(started.argv)) {
    throw new Error("recall must launch codex with recorded argv");
  }
  const requiredFlags = ["exec", "--ephemeral", "--json"];
  for (const flag of requiredFlags) {
    if (!started.argv.includes(flag)) throw new Error(`recall Codex argv is missing ${flag}`);
  }
  if (!hasArgPair(started.argv, "--sandbox", "read-only")) {
    throw new Error("recall Codex must use the read-only sandbox");
  }
  if (!hasArgPair(started.argv, "--model", "gpt-5.6-sol")) {
    throw new Error("recall Codex must use gpt-5.6-sol");
  }
  if (!hasArgPair(started.argv, "--config", 'service_tier="fast"')) {
    throw new Error("recall Codex must request the fast service tier");
  }
  if (
    started.model !== "gpt-5.6-sol"
    || started.requestedServiceTier !== "fast"
    || started.sandbox !== "read-only"
    || started.ephemeral !== true
  ) {
    throw new Error("recall Codex metadata does not match its pinned invocation");
  }
}

function requireWorkflowArguments(items) {
  const search = parseArguments(items[0].arguments, "search");
  if (
    search.query !== "MOOPS_MEMORY_CHECKPOINT"
    || search.project !== "moops-food-delivery"
    || search.type !== "observations"
  ) {
    throw new Error("search must target MOOPS_MEMORY_CHECKPOINT observations in moops-food-delivery");
  }

  const timeline = parseArguments(items[1].arguments, "timeline");
  if (timeline.project !== "moops-food-delivery") {
    throw new Error("timeline must target moops-food-delivery");
  }
  if (!Number.isInteger(timeline.anchor) && typeof timeline.query !== "string") {
    throw new Error("timeline must use a search-derived anchor or query");
  }

  const observations = parseArguments(items[2].arguments, "get_observations");
  if (
    observations.project !== "moops-food-delivery"
    || !Array.isArray(observations.ids)
    || observations.ids.length === 0
    || observations.ids.some((id) => !Number.isInteger(id) || id <= 0)
  ) {
    throw new Error("get_observations must fetch positive search-derived IDs for moops-food-delivery");
  }
}

export function parseJsonl(text) {
  if (typeof text !== "string") throw new Error("JSONL evidence must be text");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`invalid JSON on evidence line ${index + 1}`);
      }
    });
}

export function verifyRecallEvidence(events, registry) {
  if (!Array.isArray(events) || events.length === 0) throw new Error("recall evidence is empty");
  validateRegistry(registry);

  const launcherMatch = oneEvent(events, "moops.recall.launcher.started");
  const codexMatch = oneEvent(events, "moops.recall.codex.started");
  const receiptMatch = oneEvent(events, "moops.recall.receipt");
  const completedMatch = oneEvent(events, "moops.recall.codex.completed");
  const launcher = requireObject(launcherMatch.event, "launcher metadata");
  const codex = requireObject(codexMatch.event, "Codex start metadata");
  const completed = requireObject(completedMatch.event, "Codex completion metadata");

  if (!(launcherMatch.index < codexMatch.index && codexMatch.index < receiptMatch.index
    && receiptMatch.index < completedMatch.index)) {
    throw new Error("recall metadata events are out of order");
  }
  if (launcher.schemaVersion !== 1 || typeof launcher.runId !== "string" || launcher.runId === "") {
    throw new Error("launcher metadata must identify schema v1 and the arm-D run");
  }
  if (
    typeof launcher.codexHome !== "string" || launcher.codexHome === ""
    || typeof launcher.claudeMemDataDir !== "string" || launcher.claudeMemDataDir === ""
  ) {
    throw new Error("launcher metadata must record inherited CODEX_HOME and Claude-Mem storage");
  }

  const callerPid = positivePid(launcher.callerPid, "callerPid");
  const launcherPid = positivePid(launcher.launcherPid, "launcherPid");
  const codexPid = positivePid(codex.codexPid, "codexPid");
  const workerPid = positivePid(codex.workerPid, "workerPid");
  if (new Set([callerPid, launcherPid, codexPid, workerPid]).size !== 4) {
    throw new Error("recall must use distinct positive PIDs for caller, launcher, Codex, and worker");
  }
  if (codex.launcherPid !== launcherPid || completed.launcherPid !== launcherPid
    || completed.codexPid !== codexPid) {
    throw new Error("recall PID metadata is internally inconsistent");
  }
  if (completed.workerPidBefore !== workerPid || completed.workerPidAfter !== workerPid) {
    throw new Error("Claude-Mem worker PID changed during fresh recall");
  }
  if (completed.callerAliveAfter !== true || completed.exitCode !== 0 || completed.signal !== null) {
    throw new Error("fresh recall did not finish cleanly while its caller stayed alive");
  }
  requireInvocation(codex);

  const times = [
    timestamp(launcher.captureCompletedAt, "captureCompletedAt"),
    timestamp(launcher.startedAt, "launcher startedAt"),
    timestamp(codex.startedAt, "Codex startedAt"),
    timestamp(receiptMatch.event.recordedAt, "receipt recordedAt"),
    timestamp(completed.completedAt, "Codex completedAt"),
  ];
  if (times.some((value, index) => index > 0 && value < times[index - 1])) {
    throw new Error("capture, helper, receipt, and completion timestamps must be monotonic");
  }

  const threadMatches = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === "thread.started");
  if (threadMatches.length !== 1 || typeof threadMatches[0].event.thread_id !== "string") {
    throw new Error("fresh ephemeral Codex must emit exactly one thread.started event");
  }
  if (!(codexMatch.index < threadMatches[0].index && threadMatches[0].index < receiptMatch.index)) {
    throw new Error("fresh Codex thread event is out of order");
  }

  const mcpItems = events
    .filter((event) => event?.type === "item.completed" && event.item?.type === "mcp_tool_call")
    .map((event) => event.item);
  const actualWorkflow = mcpItems.map(({ tool }) => tool);
  if (exactJson(actualWorkflow) !== exactJson(REQUIRED_WORKFLOW)
    || mcpItems.some(({ server }) => server !== "mcp-search")) {
    throw new Error("MCP calls must be exactly search, timeline, get_observations on mcp-search");
  }
  mcpItems.forEach((item, index) => {
    if (!successfulMcpCall(item, REQUIRED_WORKFLOW[index])) {
      throw new Error(`${REQUIRED_WORKFLOW[index]} did not succeed`);
    }
  });
  requireWorkflowArguments(mcpItems);

  const retrieved = JSON.stringify(mcpItems[2].result);
  for (const checkpoint of registry.checkpoints) {
    const expected = checkpoint.executableCheckpoint;
    for (const [field, value] of [
      ["name", checkpoint.name],
      ["path", expected.path],
      ["fingerprint", expected.fingerprint],
    ]) {
      if (!retrieved.includes(value)) {
        throw new Error(`get_observations result is missing ${checkpoint.name} ${field}`);
      }
    }
  }

  const expected = expectedReceipt(registry);
  const recordedReceipt = requireObject(receiptMatch.event.receipt, "recorded receipt");
  if (exactJson(recordedReceipt) !== exactJson(expected)) {
    throw new Error("recorded receipt does not exactly match the checkpoint registry");
  }
  const messages = events
    .filter((event) => event?.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text);
  if (messages.length === 0 || typeof messages.at(-1) !== "string") {
    throw new Error("Codex JSONL has no final agent message");
  }
  let finalReceipt;
  try {
    finalReceipt = JSON.parse(messages.at(-1));
  } catch {
    throw new Error("final agent message is not a JSON receipt");
  }
  if (exactJson(finalReceipt) !== exactJson(recordedReceipt)) {
    throw new Error("final agent message does not match the recorded receipt");
  }
  if (!events.some((event) => event?.type === "turn.completed")) {
    throw new Error("fresh Codex turn did not complete");
  }

  return {
    ok: true,
    runId: launcher.runId,
    threadId: threadMatches[0].event.thread_id,
    callerPid,
    launcherPid,
    codexPid,
    workerPid,
    captureCompletedAt: launcher.captureCompletedAt,
    startedAt: codex.startedAt,
    completedAt: completed.completedAt,
    workflow: actualWorkflow,
    receipt: recordedReceipt,
  };
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error("usage: node benchmark/claude-mem/verify-recall.mjs EVIDENCE.jsonl");
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(moduleDirectory, "../..");
  const registry = await loadAndValidateRegistry(
    resolve(moduleDirectory, "checkpoints.json"),
    repositoryRoot,
  );
  const events = parseJsonl(await readFile(resolve(process.argv[2]), "utf8"));
  process.stdout.write(`${JSON.stringify(verifyRecallEvidence(events, registry))}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
