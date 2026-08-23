import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { ARM_DEFINITIONS, normalizeManifest } from "../src/config.mjs";
import { buildCleanupPlan } from "../src/cleanup.mjs";
import { buildShowcasePlan } from "../src/showcase.mjs";

function fixture() {
  const runRoot = "/tmp/moops-showcase";
  const arms = ARM_DEFINITIONS.map((definition, index) => ({
    ...definition,
    worktree: `${runRoot}/worktrees/${definition.id}`,
    simulatorUdid: `SIM-${index + 1}`,
    backendPort: 18_055 + index,
    derivedData: `${runRoot}/derived/${definition.id}`,
    results: `${runRoot}/results/${definition.id}`,
    environment: definition.id === "codex-injection"
      ? { MOOPS_ENABLE_INJECTIONIII: "1" }
      : {},
  }));
  const manifest = normalizeManifest({
    schemaVersion: 1,
    runRoot,
    repositoryRoot: "/tmp/moops-source",
    baselineCommit: "benchmark-start",
    promptPath: "/tmp/moops-source/benchmark/FEATURE_PROMPT.md",
    model: "gpt-5.6-sol",
    serviceTier: "fast",
    deadlineSeconds: 10_800,
    agentCommand: ["codex", "${MODEL}", "${SERVICE_TIER}", "${WORKTREE}"],
    backendCommand: [
      "node", "${WORKTREE}/benchmark/backend/server.mjs", "--port", "${BACKEND_PORT}",
      "--fixture", "${BACKEND_FIXTURE_REVISION}",
    ],
    backendFixtureRevision: "catalog-v1",
    versionCommands: [{ name: "codex", argv: ["codex", "--version"] }],
    acceptanceCommand: ["xcodebuild", "-xctestrun", "${XCTESTRUN}", "id=${SIMULATOR_UDID}"],
    appBundleId: "com.example.food",
    arms,
    showcase: {
      desktopRegion: { x: 20, y: 40, width: 1600, height: 1000 },
      recordingSeconds: 60,
    },
  }, { manifestPath: "/tmp/manifest.json" });
  const runDirectory = join(runRoot, "benchmark-runs", "demo-run");
  const summary = {
    reportVersion: 1,
    runId: "demo-run",
    ok: true,
    startEpochMs: 100_000,
    deadlineEpochMs: 10_900_000,
    summaryPath: join(runDirectory, "summary.json"),
    arms: arms.map((arm) => ({ id: arm.id, ok: true, test: { status: "passed" } })),
  };
  return { manifest, summary };
}

test("plans four labeled simulator launches with the exact shared benchmark clock", () => {
  const { manifest, summary } = fixture();
  const plan = buildShowcasePlan(manifest, summary);

  assert.equal(plan.launches.length, 4);
  assert.equal(new Set(plan.launches.map(({ environment }) => environment.SIMCTL_CHILD_MOOPS_BENCHMARK_START_EPOCH_MS)).size, 1);
  assert.equal(new Set(plan.launches.map(({ environment }) => environment.SIMCTL_CHILD_MOOPS_BENCHMARK_DEADLINE_EPOCH_MS)).size, 1);
  assert.equal(new Set(plan.launches.map(({ environment }) => environment.SIMCTL_CHILD_MOOPS_BACKEND_BASE_URL)).size, 4);
  assert.deepEqual(
    plan.launches.map(({ environment }) => environment.SIMCTL_CHILD_MOOPS_BENCHMARK_ARM_LABEL),
    ARM_DEFINITIONS.map(({ label }) => label),
  );
  assert.deepEqual(
    plan.launches.map(({ environment }) => environment.SIMCTL_CHILD_MOOPS_ENABLE_INJECTIONIII ?? null),
    [null, null, "1", null],
  );
});

test("records all simulators plus the full desktop region and a visible slate", () => {
  const { manifest, summary } = fixture();
  const plan = buildShowcasePlan(manifest, summary);

  assert.equal(plan.simulatorRecordings.length, 4);
  assert.deepEqual(plan.desktopRecording.argv.slice(0, 3), [
    "/usr/sbin/screencapture", "-v", "-R20,40,1600,1000",
  ]);
  assert.equal(plan.compositeRecording.output.endsWith("moops-four-arm-showcase.mp4"), true);
  assert.equal(plan.slate.length, 3);
  assert.deepEqual(plan.slate.map(({ value }) => value), [3, 2, 1]);
  assert.equal(plan.layout.mode, "verified-2x2");
  assert.deepEqual(plan.layout.grid.map(({ armId }) => armId), ARM_DEFINITIONS.map(({ id }) => id));
  assert.deepEqual(plan.layout.grid.map(({ position }) => position), [
    "top-left", "top-right", "bottom-left", "bottom-right",
  ]);
  assert.equal(new Set(plan.layout.grid.map(({ frame }) => frame.x)).size, 2);
  assert.equal(new Set(plan.layout.grid.map(({ frame }) => frame.y)).size, 2);
});

test("refuses a final showcase unless all four common acceptance tests passed", () => {
  const { manifest, summary } = fixture();
  summary.arms[2].test.status = "failed";
  assert.throws(
    () => buildShowcasePlan(manifest, summary),
    (error) => error.code === "E_SHOWCASE_RESULTS",
  );
});

test("refuses a forged summary path outside the selected run directory", () => {
  const { manifest, summary } = fixture();
  summary.summaryPath = "/tmp/forged-summary.json";
  assert.throws(
    () => buildShowcasePlan(manifest, summary),
    (error) => error.code === "E_SHOWCASE_RESULTS",
  );
});

test("cleanup is a reviewable plan and never an implicit destructive action", () => {
  const { manifest } = fixture();
  const plan = buildCleanupPlan(manifest, "demo-run");

  assert.equal(plan.executed, false);
  assert.equal(plan.worktrees.length, 4);
  assert.equal(plan.simulators.length, 4);
  assert.equal(plan.generatedData.every(({ path }) => path.startsWith(manifest.runRoot)), true);
  assert.equal(plan.warning.includes("does not execute"), true);
});
