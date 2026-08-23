import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ARM_DEFINITIONS, normalizeManifest } from "../src/config.mjs";
import {
  buildLiveDemoPlan,
  collectRecordingEvidence,
  convertCompositeRecording,
  preflightCompositePublication,
  publishCompositeRecording,
  runLiveDemo,
} from "../src/demo.mjs";

function manifestFixture() {
  const runRoot = "/tmp/moops-live-demo";
  return normalizeManifest({
    schemaVersion: 1,
    runRoot,
    repositoryRoot: "/tmp/moops-source",
    baselineCommit: "benchmark-start",
    promptPath: "/tmp/moops-source/benchmark/FEATURE_PROMPT.md",
    model: "gpt-5.6-sol",
    serviceTier: "fast",
    deadlineSeconds: 10_800,
    agentCommand: ["codex", "app-server", "--enable", "goals", "--listen", "stdio://"],
    backendCommand: ["node", "${WORKTREE}/server.mjs", "--port", "${BACKEND_PORT}"],
    backendFixtureRevision: "catalog-v1",
    versionCommands: [{ name: "codex", argv: ["codex", "--version"] }],
    acceptanceCommand: ["xcodebuild", "-xctestrun", "${XCTESTRUN}", "id=${SIMULATOR_UDID}"],
    appBundleId: "com.example.food",
    arms: ARM_DEFINITIONS.map((definition, index) => ({
      ...definition,
      worktree: `${runRoot}/worktrees/${definition.id}`,
      simulatorUdid: `SIM-${index + 1}`,
      backendPort: 18_055 + index,
      derivedData: `${runRoot}/derived/${definition.id}`,
      results: `${runRoot}/results/${definition.id}`,
      environment: {
        MCP_XCODE_PID: String(51_001 + index),
        ...(index === 2 ? { MOOPS_ENABLE_INJECTIONIII: "1" } : {}),
      },
    })),
    showcase: {
      desktopRegion: { x: 0, y: 0, width: 1920, height: 1080 },
      recordingSeconds: 180,
    },
  }, { manifestPath: "/tmp/demo-manifest.json" });
}

test("live demo plans one synchronized visual run, not a post-run replay", () => {
  const manifest = manifestFixture();
  const clocks = {
    startEpochMs: 100_000,
    startMonotonicNs: "123",
    deadlineEpochMs: 10_900_000,
  };
  const plan = buildLiveDemoPlan(manifest, { runId: "take-live", clocks });

  assert.equal(plan.mode, "live-measured-goals");
  assert.equal(plan.launches.length, 4);
  assert.equal(plan.simulatorRecordings.length, 4);
  assert.equal(plan.desktopRecording.output.endsWith("moops-four-arm-live.source.mov"), true);
  assert.equal(plan.compositeRecording.output.endsWith("moops-four-arm-live.mp4"), true);
  assert.equal(plan.compositeRecording.argv.includes("-c:v"), true);
  assert.equal(plan.layout.mode, "verified-2x2");
  assert.equal(plan.layout.argv.includes("tile-simulators.mjs"), false);
  assert.equal(plan.layout.argv.some((entry) => entry.endsWith("benchmark/visual/tile-simulators.mjs")), true);
  assert.deepEqual(plan.slate.map(({ value }) => value), [3, 2, 1]);
  assert.equal(new Set(plan.launches.map(({ environment }) => (
    environment.SIMCTL_CHILD_MOOPS_BENCHMARK_START_EPOCH_MS
  ))).size, 1);
  assert.equal(plan.launches.every(({ environment }) => (
    environment.SIMCTL_CHILD_MOOPS_BENCHMARK_RUN_ID === "take-live"
  )), true);
  assert.equal(plan.launches.every(({ environment }) => (
    environment.SIMCTL_CHILD_MOOPS_SHOW_LAST_VERIFICATION === undefined
  )), true);
  assert.equal(plan.finalLaunches.every(({ environment }) => (
    environment.SIMCTL_CHILD_MOOPS_SHOW_LAST_VERIFICATION === "1"
  )), true);
});

test("publishes the verified composite to the stable repository MP4 path without overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-publish-video-"));
  const sourceDirectory = join(root, "run");
  await mkdir(sourceDirectory);
  const source = join(sourceDirectory, "moops-four-arm-live.mp4");
  await writeFile(source, "video-bytes");
  assert.equal((await preflightCompositePublication({ repositoryRoot: root })).absent, true);
  const published = await publishCompositeRecording({ repositoryRoot: root }, {
    ok: true,
    output: source,
  }, { runId: "take-001" });
  assert.equal(published.output, join(root, "results/live-demo/moops-four-arm-live.mp4"));
  assert.equal(await readFile(published.output, "utf8"), "video-bytes");
  await assert.rejects(
    preflightCompositePublication({ repositoryRoot: root }),
    /already exists|overwrite/i,
  );
  await assert.rejects(
    publishCompositeRecording({ repositoryRoot: root }, { ok: true, output: source }, { runId: "take-002" }),
    /publish|exist|overwrite/i,
  );
});

test("composite conversion requires a clean command and a non-empty MP4", async () => {
  const conversion = {
    source: "/recordings/source.mov",
    output: "/recordings/moops-four-arm-live.mp4",
    argv: ["/usr/bin/env", "ffmpeg", "-i", "/recordings/source.mov", "/recordings/moops-four-arm-live.mp4"],
  };
  const good = await convertCompositeRecording(conversion, {
    capture: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    statFile: async () => ({ isFile: () => true, size: 4_096 }),
  });
  assert.equal(good.ok, true);
  assert.equal(good.output, conversion.output);
  assert.equal(good.sizeBytes, 4_096);

  const empty = await convertCompositeRecording(conversion, {
    capture: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    statFile: async () => ({ isFile: () => true, size: 0 }),
  });
  assert.equal(empty.ok, false);
});

test("recording evidence requires a clean recorder stop and a non-empty regular file", async () => {
  const recordings = [
    {
      output: "/recordings/good.mp4",
      controller: {
        pid: 101,
        stop: async () => ({ exitCode: 0, signal: null, error: null }),
      },
    },
    {
      output: "/recordings/empty.mp4",
      controller: {
        pid: 102,
        stop: async () => ({ exitCode: null, signal: "SIGINT", error: null }),
      },
    },
    {
      output: "/recordings/crashed.mp4",
      controller: {
        pid: 103,
        stop: async () => ({ exitCode: 9, signal: null, error: null }),
      },
    },
  ];
  const sizes = new Map([
    ["/recordings/good.mp4", 42],
    ["/recordings/empty.mp4", 0],
    ["/recordings/crashed.mp4", 42],
  ]);
  const evidence = await collectRecordingEvidence(recordings, {
    statFile: async (path) => ({ isFile: () => true, size: sizes.get(path) }),
  });

  assert.deepEqual(evidence.map(({ ok }) => ok), [true, false, false]);
  assert.deepEqual(evidence.map(({ sizeBytes }) => sizeBytes), [42, 0, 42]);
});

test("live demo dry-run performs no simulator or filesystem work", async () => {
  const result = await runLiveDemo(manifestFixture(), {
    runId: "dry-run",
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.boots.length, 4);
});
