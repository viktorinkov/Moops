import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ARM_DEFINITIONS, normalizeManifest } from "../src/config.mjs";
import { emitCountdown, runBenchmark } from "../src/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const armFixture = join(here, "../fixtures/arm-command.mjs");

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "moops-runner-"));
  const repositoryRoot = join(root, "source");
  const runRoot = join(root, "runs");
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(runRoot, { recursive: true });
  const promptPath = join(repositoryRoot, "FEATURE_PROMPT.md");
  const prompt = "Implement the exact same feature.\n";
  await writeFile(promptPath, prompt);

  const arms = [];
  for (const [index, definition] of ARM_DEFINITIONS.entries()) {
    const arm = {
      ...definition,
      worktree: join(runRoot, "worktrees", definition.id),
      simulatorUdid: `SIM-${index + 1}`,
      backendPort: 18_055 + index,
      derivedData: join(runRoot, "derived", definition.id),
      results: join(runRoot, "results", definition.id),
      environment: {
        MCP_XCODE_PID: String(53_001 + index),
        BENCHMARK_TEST_DELAY_MS: String(options.delayMs ?? 1_150),
        ...(definition.id === "codex-moops-claudemem"
          ? { BENCHMARK_TRAILING_DELAY_MS: "650" }
          : {}),
        ...(definition.id === "codex-injection" ? { MOOPS_ENABLE_INJECTIONIII: "1" } : {}),
      },
    };
    if (options.failArm === definition.id) arm.environment.BENCHMARK_TEST_EXIT = "7";
    for (const path of [arm.worktree, arm.derivedData, arm.results]) {
      await mkdir(path, { recursive: true });
    }
    arms.push(arm);
  }

  const manifest = normalizeManifest({
    schemaVersion: 1,
    runRoot,
    repositoryRoot,
    baselineCommit: "baseline-commit",
    promptPath,
    model: "gpt-5.6-sol",
    serviceTier: "fast",
    deadlineSeconds: 10_800,
    agentCommand: [
      process.execPath,
      armFixture,
      "${MODEL}",
      "${SERVICE_TIER}",
      "${WORKTREE}",
    ],
    backendCommand: [
      process.execPath, "${WORKTREE}/backend.mjs", "--port", "${BACKEND_PORT}",
      "--fixture", "${BACKEND_FIXTURE_REVISION}",
    ],
    backendFixtureRevision: "catalog-v1",
    versionCommands: [{ name: "node", argv: [process.execPath, "--version"] }],
    acceptanceCommand: [
      process.execPath,
      "-e",
      "process.exit(0)",
      "${SIMULATOR_UDID}",
      "${XCTESTRUN}",
    ],
    appBundleId: "com.example.food",
    arms,
    showcase: {
      desktopRegion: { x: 0, y: 0, width: 1600, height: 1000 },
      recordingSeconds: 30,
    },
  }, { manifestPath: join(root, "manifest.json") });

  return {
    manifest,
    preflightData: {
      baselineResolved: "baseline-commit",
      prompt,
      promptSHA256: "sha256:prompt",
      versions: { node: process.version },
      arms: Object.fromEntries(arms.map((arm) => [arm.id, { commit: "baseline-commit" }])),
    },
  };
}

async function fakeBackends(manifest) {
  return manifest.arms.map((arm, index) => ({
    armId: arm.id,
    baseURL: `http://127.0.0.1:${arm.backendPort}`,
    port: arm.backendPort,
    fixtureRevision: manifest.backendFixtureRevision,
    pid: 10_000 + index,
    controller: { exited: false },
  }));
}

async function fakeStopBackends(records) {
  return Object.fromEntries(records.map((record) => [record.armId, {
    pid: record.pid,
    port: record.port,
    fixtureRevision: record.fixtureRevision,
    exitedBeforeStop: false,
    exitCode: 0,
    signal: "SIGTERM",
  }]));
}

function fakeArmD(options = {}) {
  return {
    prepareArmD: async (_manifest, { runId }) => ({
      runId: `${runId}-arm-d`,
      wrapperPath: "/fixture/run-arm-d",
      dataDirectory: "/fixture/claude-mem",
      doctor: { ok: true, claudeMemEnabled: true, claudeMemVersion: "13.15.3" },
      memoryCheckpoints: [
        {
          name: "catalog-ready",
          path: "benchmark/checkpoints/food-delivery-catalog-ready.json",
          fingerprint: "sha256:f69cdbb4e1b9c3a92f16be28faff2e3bae608fec41f189ff152c2bf79ef7e5b6",
        },
        {
          name: "cart-ready",
          path: "benchmark/checkpoints/food-delivery-cart-ready.json",
          fingerprint: "sha256:bce8076265e8e84b3e7c2a08f9b0317d4d02deb2a2f0be9e1a8c7ea17aada5a4",
        },
        {
          name: "checkout-ready",
          path: "benchmark/checkpoints/food-delivery-cart.json",
          fingerprint: "sha256:b4d219f9eacb7d7c0b56c94748fc656da159f8857177c88c0d9196b4b54049c0",
        },
      ],
    }),
    wrapArmD: (argv) => argv,
    parseArmDEvidence: (message) => {
      if (Object.hasOwn(message, "id") || Object.hasOwn(message, "method")) return undefined;
      return {
        kind: "claude-mem-worker-shutdown",
        dataDirectory: message.dataDirectory,
        pid: message.pid,
        version: message.version,
      };
    },
    verifyArmDReady: async (prepared) => {
      options.onReady?.();
      return {
        kind: "claude-mem-worker-startup",
        dataDirectory: prepared.dataDirectory,
        pid: 45_678,
        startToken: "fixture-start-token",
        version: "13.15.3",
      };
    },
    verifyArmD: async (prepared, { command }) => {
      if (options.failPostflight) {
        const cause = new Error("fixture worker shutdown failure");
        cause.code = "E_CLAUDE_MEM_SHUTDOWN";
        throw cause;
      }
      const workerIdentityAndShutdown = command.trailingEvidence?.find(
        ({ kind }) => kind === "claude-mem-worker-shutdown",
      );
      return {
        ok: command.serverExitCode === 0 && workerIdentityAndShutdown?.pid === 45_678,
        runId: prepared.runId,
        workerIdentityAndShutdown,
      };
    },
  };
}

function fakeCodexHomes() {
  return {
    prepareCodexHomes: async (manifest, { runId }) => Object.fromEntries(manifest.arms.map((arm) => [
      arm.id,
      {
        home: `/fixture/codex-homes/${runId}/${arm.id}`,
        configSHA256: `sha256:${arm.id}`,
        xcodeMCP: { command: "/usr/bin/xcrun", args: ["mcpbridge"], verified: true },
        claudeMemEnabled: arm.id === "codex-moops-claudemem",
      },
    ])),
  };
}

function fakeInjectionIII(options = {}) {
  return {
    prepareArmC: async (_manifest, { runId }) => ({
      reportVersion: 1,
      phase: "preflight",
      ok: true,
      runId,
      observedEpochMs: Date.now(),
    }),
    verifyArmC: async () => {
      if (options.failPostflight) {
        const cause = new Error("fixture InjectionIII proof failure");
        cause.code = "E_INJECTION_PROOF";
        throw cause;
      }
      return { reportVersion: 1, phase: "postflight", ok: true };
    },
  };
}

test("countdown emits an auditable visible 3/2/1 slate", async () => {
  const values = [];
  const statuses = [];
  await emitCountdown({
    seconds: 3,
    startEpochMs: 123_000,
    ledger: { emit: async (type, data) => values.push({ type, ...data }) },
    status: (message) => statuses.push(message),
    sleep: async () => {},
  });

  assert.deepEqual(values.map(({ value }) => value), [3, 2, 1]);
  assert.equal(values.every(({ startEpochMs }) => startEpochMs === 123_000), true);
  assert.deepEqual(statuses, ["START IN 3", "START IN 2", "START IN 1"]);
});

test("countdown release never waits for the best-effort visual slate", async () => {
  const values = [];
  const result = await Promise.race([
    emitCountdown({
      seconds: 3,
      startEpochMs: 123_000,
      ledger: { emit: async (_type, data) => values.push(data.value) },
      status: () => {},
      sleep: async () => {},
      onTick: async () => new Promise(() => {}),
    }).then(() => "released"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);

  assert.equal(result, "released");
  assert.deepEqual(values, [3, 2, 1]);
});

test("preserves an arm D wrapper cleanup failure and refuses its acceptance", async () => {
  const { manifest, preflightData } = await fixture({ delayMs: 20 });
  const accepted = [];
  const result = await runBenchmark(manifest, {
    ...fakeCodexHomes(),
    ...fakeInjectionIII(),
    ...fakeArmD({ failPostflight: true }),
    runId: "integration-arm-d-cleanup-failure",
    preflightData,
    countdownSeconds: 0,
    stagingLeadMs: 0,
    allowLateBarrier: true,
    status: () => {},
    startBackends: fakeBackends,
    stopBackends: fakeStopBackends,
    prepareAcceptance: async ({ arm, manifest: value, variables }) => {
      accepted.push(arm.id);
      return {
        argv: value.acceptanceCommand.map((argument) => argument
          .replace("${XCTESTRUN}", "/tmp/fake.xctestrun")
          .replace("${SIMULATOR_UDID}", variables.SIMULATOR_UDID)),
        cleanup: async () => {},
      };
    },
  });

  const armD = result.arms.find(({ id }) => id === "codex-moops-claudemem");
  assert.equal(result.ok, false);
  assert.equal(armD.claudeMem.ok, false);
  assert.equal(armD.claudeMem.error.code, "E_CLAUDE_MEM_SHUTDOWN");
  assert.equal(armD.test.status, "not_run");
  assert.equal(accepted.includes("codex-moops-claudemem"), false);
  assert.equal(accepted.length, 3);
});

test("fails the shared barrier instead of hanging when an arm crashes during staging", async () => {
  const { manifest, preflightData } = await fixture({ delayMs: 20 });
  const armD = fakeArmD();
  const result = await runBenchmark(manifest, {
    ...fakeCodexHomes(),
    ...fakeInjectionIII(),
    ...armD,
    wrapArmD: () => {
      const cause = new Error("fixture wrapper rejected command");
      cause.code = "E_WRAP";
      throw cause;
    },
    runId: "integration-staging-crash",
    preflightData,
    countdownSeconds: 0,
    stagingLeadMs: 0,
    allowLateBarrier: true,
    status: () => {},
    startBackends: fakeBackends,
    stopBackends: fakeStopBackends,
    prepareAcceptance: async () => {
      throw new Error("acceptance must not run");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.barrierFailure.code, "E_WRAP");
  assert.equal(result.arms.every(({ test }) => test.status === "not_run"), true);
});

test("starts all arms behind one barrier and records a common clock contract", async () => {
  const { manifest, preflightData } = await fixture();
  let visualPreflightEndedEpochMs = 0;
  const result = await runBenchmark(manifest, {
    ...fakeCodexHomes(),
    ...fakeInjectionIII(),
    ...fakeArmD(),
    runId: "integration-green",
    preflightData,
    countdownSeconds: 0,
    stagingLeadMs: 0,
    allowLateBarrier: true,
    status: () => {},
    beforeClock: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      visualPreflightEndedEpochMs = Date.now();
    },
    startBackends: fakeBackends,
    stopBackends: fakeStopBackends,
    prepareAcceptance: async ({ manifest: value, variables }) => ({
      argv: value.acceptanceCommand.map((argument) => argument.replace("${XCTESTRUN}", "/tmp/fake.xctestrun")
        .replace("${SIMULATOR_UDID}", variables.SIMULATOR_UDID)),
      cleanup: async () => {},
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.arms.every((arm) => arm.command.exitCode === 0), true);
  assert.equal(result.arms.every((arm) => arm.test.status === "passed"), true);

  const observations = await Promise.all(manifest.arms.map(async (arm) => JSON.parse(
    await readFile(join(arm.results, "integration-green", "observed-env.json"), "utf8"),
  )));
  assert.equal(new Set(observations.map((env) => env.MOOPS_BENCHMARK_START_EPOCH_MS)).size, 1);
  assert.equal(observations.every((env) => (
    Number(env.MOOPS_BENCHMARK_START_EPOCH_MS) >= visualPreflightEndedEpochMs
  )), true);
  assert.equal(new Set(observations.map((env) => env.MOOPS_BENCHMARK_DEADLINE_EPOCH_MS)).size, 1);
  assert.equal(new Set(observations.map((env) => env.MOOPS_BACKEND_BASE_URL)).size, 4);
  assert.equal(new Set(observations.map((env) => env.CODEX_HOME)).size, 4);
  assert.equal(new Set(observations.map((env) => env.MCP_XCODE_PID)).size, 4);
  assert.equal(observations.every((env) => /^[1-9][0-9]*$/.test(env.MCP_XCODE_PID)), true);
  assert.deepEqual(
    observations.map((env) => env.MOOPS_BENCHMARK_ARM_LABEL),
    ARM_DEFINITIONS.map(({ label }) => label),
  );
  assert.deepEqual(
    observations.map((env) => env.MOOPS_BENCHMARK_RUN_ID),
    ["integration-green", "integration-green", "integration-green", "integration-green"],
  );
  assert.equal(
    result.arms.find(({ id }) => id === "codex-moops-claudemem").claudeMem.ok,
    true,
  );
  assert.equal(
    result.arms.find(({ id }) => id === "codex-moops-claudemem")
      .claudeMem.workerIdentityAndShutdown.pid,
    45_678,
  );
  assert.equal(
    observations.find(({ MOOPS_BENCHMARK_ARM_ID }) => (
      MOOPS_BENCHMARK_ARM_ID === "codex-moops-claudemem"
    )).MOOPS_CLAUDE_MEM_RUN_ID,
    "integration-green-arm-d",
  );

  const eventSource = await readFile(result.eventsPath, "utf8");
  const events = eventSource.trim().split("\n").map(JSON.parse);
  assert.equal(events.some(({ type }) => type === "run.heartbeat"), true);
  assert.equal(events.every(({ wallTime, monotonicNs }) => wallTime && monotonicNs), true);
  assert.equal(events.filter(({ type }) => type === "arm.started").length, 4);
  const activations = events.filter(({ type }) => type === "arm.started")
    .map(({ activatedMonotonicNs }) => BigInt(activatedMonotonicNs));
  assert.equal(Number(activations.reduce((a, b) => (a > b ? a : b))
    - activations.reduce((a, b) => (a < b ? a : b))) < 250_000_000, true);
  for (const arm of manifest.arms) {
    const requests = (await readFile(
      join(arm.results, "integration-green", "agent.requests.jsonl"),
      "utf8",
    )).trim().split("\n").map(JSON.parse);
    assert.equal(requests.some(({ method }) => method === "turn/start"), false);
    assert.equal(requests.findIndex(({ method }) => method === "mcpServerStatus/list")
      < requests.findIndex(({ method }) => method === "thread/start"), true);
    assert.equal(requests.findIndex(({ method }) => method === "plugin/list")
      < requests.findIndex(({ method }) => method === "thread/start"), true);
    const threadStart = requests.find(({ method }) => method === "thread/start");
    assert.equal(typeof threadStart.params.developerInstructions, "string");
    assert.equal(threadStart.params.approvalPolicy, "on-request");
    assert.equal(threadStart.params.approvalsReviewer, "auto_review");
    assert.deepEqual(
      requests.filter(({ method }) => method === "thread/goal/set")
        .map(({ params }) => params.status),
      ["paused", "active"],
    );
    assert.equal(
      requests.findIndex(({ method }) => method === "thread/settings/update")
        < requests.findIndex(({ method, params }) => method === "thread/goal/set" && params.status === "active"),
      true,
    );
    const settingsUpdate = requests.find(({ method }) => method === "thread/settings/update");
    assert.equal(settingsUpdate.params.approvalPolicy, "on-request");
    assert.equal(settingsUpdate.params.approvalsReviewer, "auto_review");
  }
  assert.equal(result.prompt.sha256, "sha256:prompt");
  assert.equal(result.versions.node, process.version);
  assert.equal(result.arms.every(({ command }) => command.capabilityEvidence.xcode
    .tools.includes("RenderPreview")), true);
  assert.equal(result.arms.find(({ id }) => id === "codex-previews")
    .command.usageEvidence.renderPreviewCalls, 1);
  assert.equal(result.arms.find(({ id }) => id === "codex-moops-claudemem")
    .command.usageEvidence.selectedCheckpoint, "checkout-ready");
  assert.equal(result.arms.every(({ metrics }) => metrics.totalTimeToGreenMs >= 0), true);
  assert.equal(result.arms.every(({ metrics }) => metrics.timeToFirstRealAppFeedbackMs >= 0), true);
  assert.equal(result.arms.every(({ metrics }) => (
    metrics.semantics.includes("no model weights are trained")
  )), true);
  assert.equal(result.arms.find(({ id }) => id === "codex-moops-claudemem")
    .metrics.stateReconstructionAndRestore.timingsMs.restoreAndInspectMs, 12);
});

test("fails closed and does not run acceptance after an agent command fails", async () => {
  const { manifest, preflightData } = await fixture({
    failArm: "codex-injection",
    delayMs: 20,
  });
  const result = await runBenchmark(manifest, {
    ...fakeCodexHomes(),
    ...fakeInjectionIII(),
    ...fakeArmD(),
    runId: "integration-failure",
    preflightData,
    countdownSeconds: 0,
    stagingLeadMs: 0,
    allowLateBarrier: true,
    status: () => {},
    startBackends: fakeBackends,
    stopBackends: fakeStopBackends,
    prepareAcceptance: async ({ manifest: value, variables }) => ({
      argv: value.acceptanceCommand.map((argument) => argument.replace("${XCTESTRUN}", "/tmp/fake.xctestrun")
        .replace("${SIMULATOR_UDID}", variables.SIMULATOR_UDID)),
      cleanup: async () => {},
    }),
  });

  const failed = result.arms.find(({ id }) => id === "codex-injection");
  assert.equal(result.ok, false);
  assert.equal(failed.command.exitCode, 1);
  assert.equal(failed.command.goal.status, "blocked");
  assert.equal(failed.test.status, "not_run");
  assert.equal(failed.ok, false);
});
