import { constants } from "node:fs";
import { copyFile, lstat, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { layoutPlan } from "./showcase.mjs";
import { prepareAcceptanceRun } from "./acceptance.mjs";
import { captureCommand, runLoggedProcess, startBackgroundProcess } from "./process.mjs";
import { convertCompositeRecording } from "./recording.mjs";
import { runBenchmark } from "./run.mjs";

export { convertCompositeRecording } from "./recording.mjs";

const SHOWCASE_TEST = "FoodDeliveryBenchmarkUITests/BenchmarkFlowUITests/test4PersistedVerificationShowcase";

export class DemoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DemoError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DemoError(code, message);
}

async function requireSuccess(argv, options = {}) {
  const result = await captureCommand(argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  if (result.exitCode !== 0) {
    fail("E_DEMO_COMMAND", `${argv[0]} exited with ${result.exitCode}: ${result.stderr.trim()}`);
  }
  return result;
}

function launchEnvironment(arm, clocks, options = {}) {
  const environment = {
    SIMCTL_CHILD_MOOPS_BACKEND_BASE_URL: `http://127.0.0.1:${arm.backendPort}`,
    SIMCTL_CHILD_MOOPS_BENCHMARK_RUN_ID: options.runId,
    SIMCTL_CHILD_MOOPS_BENCHMARK_ARM_ID: arm.id,
    SIMCTL_CHILD_MOOPS_BENCHMARK_ARM_LABEL: arm.label,
    SIMCTL_CHILD_MOOPS_BENCHMARK_START_EPOCH_MS: String(clocks.startEpochMs),
    SIMCTL_CHILD_MOOPS_BENCHMARK_DEADLINE_EPOCH_MS: String(clocks.deadlineEpochMs),
  };
  if (arm.id === "codex-injection") {
    environment.SIMCTL_CHILD_MOOPS_ENABLE_INJECTIONIII = "1";
  }
  if (options.showLastVerification) {
    environment.SIMCTL_CHILD_MOOPS_SHOW_LAST_VERIFICATION = "1";
  }
  return environment;
}

export function buildLiveDemoPlan(manifest, options) {
  const runDirectory = join(manifest.runRoot, "benchmark-runs", options.runId);
  const demoDirectory = join(runDirectory, "live-demo");
  const labels = manifest.arms.map(({ label }) => label).join("\n");
  const launches = manifest.arms.map((arm) => ({
    armId: arm.id,
    label: arm.label,
    environment: launchEnvironment(arm, options.clocks, { runId: options.runId }),
    argv: [
      "/usr/bin/xcrun", "simctl", "launch", "--terminate-running-process",
      arm.simulatorUdid, manifest.appBundleId,
    ],
  }));
  return {
    planVersion: 1,
    mode: "live-measured-goals",
    runId: options.runId,
    runDirectory,
    demoDirectory,
    clocks: options.clocks,
    boots: manifest.arms.map((arm) => ({
      armId: arm.id,
      udid: arm.simulatorUdid,
      boot: ["/usr/bin/xcrun", "simctl", "boot", arm.simulatorUdid],
      bootstatus: ["/usr/bin/xcrun", "simctl", "bootstatus", arm.simulatorUdid, "-b"],
      open: ["/usr/bin/open", "-na", "Simulator", "--args", "-CurrentDeviceUDID", arm.simulatorUdid],
    })),
    launches,
    finalLaunches: launches.map((launch, index) => ({
      ...launch,
      environment: launchEnvironment(manifest.arms[index], options.clocks, {
        runId: options.runId,
        showLastVerification: true,
      }),
    })),
    layout: layoutPlan(manifest, { outputPath: join(demoDirectory, "simulator-layout.json") }),
    simulatorRecordings: manifest.arms.map((arm) => ({
      armId: arm.id,
      output: join(demoDirectory, `${arm.id}.mp4`),
      argv: [
        "/usr/bin/xcrun", "simctl", "io", arm.simulatorUdid,
        "recordVideo", "--codec=h264", join(demoDirectory, `${arm.id}.mp4`),
      ],
    })),
    desktopRecording: {
      output: join(demoDirectory, "moops-four-arm-live.source.mov"),
      argv: [
        "/usr/sbin/screencapture",
        "-v",
        `-R${manifest.showcase.desktopRegion.x},${manifest.showcase.desktopRegion.y},${manifest.showcase.desktopRegion.width},${manifest.showcase.desktopRegion.height}`,
        `-V${manifest.deadlineSeconds + 600}`,
        "-k",
        join(demoDirectory, "moops-four-arm-live.source.mov"),
      ],
    },
    compositeRecording: {
      source: join(demoDirectory, "moops-four-arm-live.source.mov"),
      output: join(demoDirectory, "moops-four-arm-live.mp4"),
      argv: [
        "/usr/bin/env", "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-n", "-i", join(demoDirectory, "moops-four-arm-live.source.mov"),
        "-map", "0:v:0", "-c:v", "copy", "-movflags", "+faststart",
        join(demoDirectory, "moops-four-arm-live.mp4"),
      ],
    },
    slate: [3, 2, 1].map((value) => ({
      value,
      argv: [
        "/usr/bin/osascript",
        "-e",
        `display dialog "MOOPS LIVE GOAL BENCHMARK\\nSTART IN ${value}\\n\\n${labels}" buttons {" "} default button 1 giving up after 1 with title "MOOPS LIVE"`,
      ],
    })),
    layoutGuarantee: "fail-closed exact 2x2 receipt from the titled-window Accessibility probe",
  };
}

export async function collectRecordingEvidence(recordings, options = {}) {
  const statFile = options.statFile ?? stat;
  return Promise.all(recordings.map(async ({ output, controller }) => {
    let stopped = null;
    let stopError = null;
    try {
      stopped = await controller.stop("SIGINT");
    } catch (cause) {
      stopError = cause instanceof Error ? cause.message : String(cause);
    }

    let sizeBytes = null;
    let regularFile = false;
    let fileError = null;
    try {
      const metadata = await statFile(output);
      sizeBytes = metadata.size;
      regularFile = metadata.isFile();
    } catch (cause) {
      fileError = cause instanceof Error ? cause.message : String(cause);
    }

    const cleanStop = stopError === null
      && stopped?.error == null
      && ((stopped?.exitCode === 0 && stopped?.signal == null) || stopped?.signal === "SIGINT");
    return {
      output,
      pid: controller.pid,
      exitCode: stopped?.exitCode ?? null,
      signal: stopped?.signal ?? null,
      sizeBytes,
      regularFile,
      stopError,
      fileError,
      ok: cleanStop && regularFile && Number.isSafeInteger(sizeBytes) && sizeBytes > 0,
    };
  }));
}

export async function publishCompositeRecording(manifest, composite, options = {}) {
  if (composite?.ok !== true || typeof composite.output !== "string") {
    fail("E_DEMO_PUBLISH", "only a verified composite MP4 may be published");
  }
  const output = join(manifest.repositoryRoot, "results/live-demo/moops-four-arm-live.mp4");
  try {
    await mkdir(dirname(output), { recursive: true });
    await copyFile(composite.output, output, constants.COPYFILE_EXCL);
    const metadata = await stat(output);
    if (!metadata.isFile() || metadata.size <= 0) {
      fail("E_DEMO_PUBLISH", "published composite is not a non-empty regular file");
    }
    return {
      ok: true,
      runId: options.runId,
      source: composite.output,
      output,
      sizeBytes: metadata.size,
      overwritePolicy: "exclusive; an existing stable artifact is never replaced",
    };
  } catch (cause) {
    if (cause instanceof DemoError) throw cause;
    fail("E_DEMO_PUBLISH", `could not publish stable composite without overwrite: ${cause.message}`);
  }
}

export async function preflightCompositePublication(manifest, options = {}) {
  const output = join(manifest.repositoryRoot, "results/live-demo/moops-four-arm-live.mp4");
  const inspect = options.lstatFile ?? lstat;
  try {
    await inspect(output);
  } catch (cause) {
    if (cause?.code === "ENOENT") return { ok: true, output, absent: true };
    fail("E_DEMO_PUBLISH", `could not preflight stable composite path: ${cause.message}`);
  }
  fail(
    "E_DEMO_PUBLISH",
    `stable composite already exists and will not be overwritten: ${output}`,
  );
}

function simulatorMap(raw) {
  const result = new Map();
  for (const devices of Object.values(raw.devices ?? {})) {
    for (const device of devices) result.set(device.udid, device);
  }
  return result;
}

export async function runLiveDemo(manifest, options = {}) {
  const runId = options.runId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId ?? "")) {
    fail("E_DEMO_RUN_ID", "demo requires a safe explicit --run-id");
  }
  const provisionalNow = Date.now();
  const provisionalClocks = {
    startEpochMs: provisionalNow + 15_000,
    startMonotonicNs: "assigned-at-release",
    deadlineEpochMs: provisionalNow + 15_000 + manifest.deadlineSeconds * 1_000,
  };
  if (options.dryRun) {
    return { ok: true, dryRun: true, plan: buildLiveDemoPlan(manifest, { runId, clocks: provisionalClocks }) };
  }

  const ffmpeg = await requireSuccess(["/usr/bin/env", "ffmpeg", "-version"], { timeoutMs: 30_000 });
  const videoToolEvidence = {
    command: ["/usr/bin/env", "ffmpeg", "-version"],
    exitCode: ffmpeg.exitCode,
    version: ffmpeg.stdout.split(/\r?\n/, 1)[0],
  };

  const devicesResult = await requireSuccess(
    ["/usr/bin/xcrun", "simctl", "list", "devices", "--json"],
    { timeoutMs: 30_000 },
  );
  const devices = simulatorMap(JSON.parse(devicesResult.stdout));
  const bootEvidence = [];
  const staticPlan = buildLiveDemoPlan(manifest, { runId, clocks: provisionalClocks });
  for (const boot of staticPlan.boots) {
    const device = devices.get(boot.udid);
    if (!device) fail("E_DEMO_DEVICE", `${boot.armId} simulator does not exist`);
    if (device.name !== staticPlan.layout.titles[boot.armId]) {
      fail("E_DEMO_DEVICE", `${boot.armId} simulator must be named ${staticPlan.layout.titles[boot.armId]}`);
    }
    if (device.state !== "Booted") await requireSuccess(boot.boot);
    await requireSuccess(boot.bootstatus);
    await requireSuccess(boot.open, { timeoutMs: 30_000 });
    bootEvidence.push({ armId: boot.armId, udid: boot.udid, name: device.name, initialState: device.state });
  }

  let plan;
  let recordings = [];
  let recordingEvidence = [];
  let compositeRecordingEvidence = null;
  let publishedComposite = null;
  let layoutEvidence = null;
  let screenRecordingPreflight = null;
  let summary;
  try {
    summary = await runBenchmark(manifest, {
      runId,
      beforeClock: async ({ runDirectory }) => {
        plan = buildLiveDemoPlan(manifest, { runId, clocks: provisionalClocks });
        if (plan.runDirectory !== runDirectory) fail("E_DEMO_PATH", "runner and demo run directories diverged");
        await preflightCompositePublication(manifest);
        await mkdir(plan.demoDirectory);
        const layout = await requireSuccess(plan.layout.argv, { timeoutMs: 30_000 });
        const layoutReceipt = JSON.parse(layout.stdout);
        if (layoutReceipt?.ok !== true || layoutReceipt.layout !== "2x2"
          || layoutReceipt.assignments?.length !== 4) {
          fail("E_DEMO_LAYOUT", "visual helper did not verify the exact four-window 2x2 grid");
        }
        layoutEvidence = {
          mode: plan.layout.mode,
          exitCode: layout.exitCode,
          receipt: layoutReceipt,
        };
        const preflightImage = join(plan.demoDirectory, "screen-recording-preflight.png");
        const region = manifest.showcase.desktopRegion;
        const screenCapture = await requireSuccess([
          "/usr/sbin/screencapture", "-x",
          `-R${region.x},${region.y},${region.width},${region.height}`,
          preflightImage,
        ], { timeoutMs: 30_000 });
        const preflightMetadata = await stat(preflightImage);
        if (!preflightMetadata.isFile() || preflightMetadata.size <= 0) {
          fail("E_DEMO_SCREEN_RECORDING", "screen-capture permission preflight produced no image");
        }
        screenRecordingPreflight = {
          ok: true,
          exitCode: screenCapture.exitCode,
          output: preflightImage,
          sizeBytes: preflightMetadata.size,
        };
        const recordingPlans = [plan.desktopRecording, ...plan.simulatorRecordings];
        for (const [index, recording] of recordingPlans.entries()) {
          const controller = await startBackgroundProcess(recording.argv, {
            cwd: plan.demoDirectory,
            env: process.env,
            stdoutPath: join(plan.demoDirectory, `recording-${index}.stdout.log`),
            stderrPath: join(plan.demoDirectory, `recording-${index}.stderr.log`),
          });
          recordings.push({ ...recording, controller });
        }
        await delay(500);
        if (recordings.some(({ controller }) => controller.exited)) {
          fail("E_DEMO_RECORDING", "a live recorder exited during preflight");
        }
      },
      beforeArms: async ({ clocks, runDirectory }) => {
        plan = buildLiveDemoPlan(manifest, { runId, clocks });
        if (plan.runDirectory !== runDirectory) fail("E_DEMO_PATH", "runner and demo run directories diverged");
        await Promise.all(plan.launches.map((launch) => requireSuccess(launch.argv, {
          env: { ...process.env, ...launch.environment },
          timeoutMs: 30_000,
        })));
      },
      onCountdown: async (value) => {
        const slate = plan?.slate.find((candidate) => candidate.value === value);
        if (!slate) fail("E_DEMO_SLATE", `missing slate ${value}`);
        await requireSuccess(slate.argv, { timeoutMs: 5_000 });
      },
      afterAcceptance: async ({ arm, clocks, environment, resultDirectory, variables }) => {
        let proof;
        try {
          proof = await prepareAcceptanceRun({
            manifest,
            arm,
            variables,
            clocks: {
              startEpochMs: clocks.startEpochMs,
              deadlineEpochMs: clocks.deadlineEpochMs,
              backendBaseURL: `http://127.0.0.1:${arm.backendPort}`,
            },
            onlyTesting: SHOWCASE_TEST,
          });
          const proofResult = await runLoggedProcess(proof.argv, {
            cwd: arm.worktree,
            env: environment,
            deadlineEpochMs: clocks.deadlineEpochMs,
            stdoutPath: join(resultDirectory, "showcase-proof.stdout.log"),
            stderrPath: join(resultDirectory, "showcase-proof.stderr.log"),
          });
          if (proofResult.exitCode !== 0 || proofResult.timedOut || proofResult.spawnError) {
            fail(
              "E_DEMO_VISUAL_PROOF",
              `persisted verification XCTest failed for ${arm.id}`,
            );
          }
        } finally {
          await proof?.cleanup?.();
        }
        const launch = plan.finalLaunches.find(({ armId }) => arm.id === armId);
        const result = await requireSuccess(launch.argv, {
          env: { ...process.env, ...launch.environment },
          timeoutMs: 30_000,
        });
        return {
          launchExitCode: result.exitCode,
          proofTest: SHOWCASE_TEST,
          proofExitCode: 0,
          showsPersistedVerification: true,
        };
      },
    });
  } finally {
    recordingEvidence = await collectRecordingEvidence(recordings);
    if (plan?.compositeRecording) {
      compositeRecordingEvidence = await convertCompositeRecording(plan.compositeRecording, {
        cwd: plan.demoDirectory,
      });
    }
  }

  const expectedRecordingCount = plan ? 1 + plan.simulatorRecordings.length : 0;
  const recordingsOK = recordingEvidence.length === expectedRecordingCount
    && expectedRecordingCount === 5
    && recordingEvidence.every(({ ok }) => ok)
    && compositeRecordingEvidence?.ok === true;
  if (summary.ok === true && recordingsOK) {
    publishedComposite = await publishCompositeRecording(manifest, compositeRecordingEvidence, { runId });
  }
  const evidence = {
    evidenceVersion: 1,
    ok: summary.ok === true && recordingsOK && publishedComposite?.ok === true,
    runId,
    bootEvidence,
    layoutEvidence,
    screenRecordingPreflight,
    recordings: recordingEvidence,
    compositeRecording: compositeRecordingEvidence,
    canonicalCompositeMP4: compositeRecordingEvidence?.output ?? null,
    publishedComposite,
    videoToolEvidence,
    finalVisualStates: summary.arms?.map((arm) => ({
      armId: arm.id,
      acceptance: arm.test?.status,
      persistedVerificationRelaunch: arm.test?.visual?.status ?? "not_run",
    })) ?? [],
    safeStop: "only recorder process groups created by this demo were signaled; simulators and data were preserved",
  };
  if (plan) {
    await writeFile(
      join(plan.demoDirectory, "live-demo.evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  return { ...summary, ok: evidence.ok, liveDemo: evidence };
}
