import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { startDedicatedBackends, stopDedicatedBackends } from "./backend.mjs";
import { ARM_DEFINITIONS, renderArgv } from "./config.mjs";
import { EventLedger } from "./ledger.mjs";
import { captureCommand, startBackgroundProcess } from "./process.mjs";
import { convertCompositeRecording } from "./recording.mjs";

export class ShowcaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ShowcaseError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ShowcaseError(code, message);
}

function strictDescendant(root, target) {
  const fragment = relative(root, target);
  return fragment !== ""
    && fragment !== ".."
    && !fragment.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(fragment);
}

function validateSummary(manifest, summary) {
  if (summary?.ok !== true || !Array.isArray(summary.arms) || summary.arms.length !== 4) {
    fail("E_SHOWCASE_RESULTS", "showcase requires one successful four-arm run summary");
  }
  for (const [index, expected] of ARM_DEFINITIONS.entries()) {
    const arm = summary.arms[index];
    if (arm.id !== expected.id || arm.ok !== true || arm.test?.status !== "passed") {
      fail("E_SHOWCASE_RESULTS", `${expected.id} did not pass the common acceptance test`);
    }
  }
  if (!Number.isFinite(summary.startEpochMs) || !Number.isFinite(summary.deadlineEpochMs)) {
    fail("E_SHOWCASE_RESULTS", "summary is missing the shared benchmark clock");
  }
  if (typeof summary.summaryPath !== "string" || summary.summaryPath === "") {
    fail("E_SHOWCASE_RESULTS", "summaryPath is required for showcase artifacts");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(summary.runId ?? "")) {
    fail("E_SHOWCASE_RESULTS", "summary runId is not a safe result-directory name");
  }
  const expected = resolve(manifest.runRoot, "benchmark-runs", summary.runId, "summary.json");
  const actual = resolve(summary.summaryPath);
  if (actual !== expected
    || !strictDescendant(resolve(manifest.runRoot, "benchmark-runs"), actual)) {
    fail("E_SHOWCASE_RESULTS", "summaryPath must be the selected run's summary inside runRoot");
  }
}

export function layoutPlan(manifest, options = {}) {
  const { x, y, width, height } = manifest.showcase.desktopRegion;
  const windowWidth = Math.floor(width / 2);
  const windowHeight = Math.floor(height / 2);
  const grid = manifest.arms.map((arm, index) => ({
    armId: arm.id,
    label: arm.label,
    position: index === 0 ? "top-left"
      : index === 1 ? "top-right"
        : index === 2 ? "bottom-left"
          : "bottom-right",
    frame: {
      x: x + (index % 2) * windowWidth,
      y: y + Math.floor(index / 2) * windowHeight,
      width: windowWidth,
      height: windowHeight,
    },
  }));
  const titles = {
    "codex-uitest": "MOOPS A UITEST",
    "codex-previews": "MOOPS B PREVIEWS",
    "codex-injection": "MOOPS C INJECTION",
    "codex-moops-claudemem": "MOOPS D MEMORY",
  };
  return {
    mode: "verified-2x2",
    reason: "the visual helper rereads exact titled Simulator frames and fails closed on any mismatch",
    grid,
    titles,
    argv: [
      process.execPath,
      join(manifest.repositoryRoot, "benchmark/visual/tile-simulators.mjs"),
      "--x", String(x), "--y", String(y),
      "--width", String(width), "--height", String(height),
      "--a-title", titles["codex-uitest"],
      "--b-title", titles["codex-previews"],
      "--c-title", titles["codex-injection"],
      "--d-title", titles["codex-moops-claudemem"],
      ...(options.outputPath ? ["--output", options.outputPath] : []),
    ],
  };
}

export function buildShowcasePlan(manifest, summary, options = {}) {
  validateSummary(manifest, summary);
  const recordingSeconds = options.recordingSeconds ?? manifest.showcase.recordingSeconds;
  if (!Number.isInteger(recordingSeconds) || recordingSeconds < 5 || recordingSeconds > 10_800) {
    fail("E_SHOWCASE_DURATION", "recording duration must be 5 through 10800 seconds");
  }
  const showcaseDirectory = join(dirname(summary.summaryPath), "showcase");
  const labels = manifest.arms.map(({ label }) => label).join("\n");
  const launches = manifest.arms.map((arm) => {
    const environment = {
      SIMCTL_CHILD_MOOPS_BACKEND_BASE_URL: `http://127.0.0.1:${arm.backendPort}`,
      SIMCTL_CHILD_MOOPS_BENCHMARK_ARM_ID: arm.id,
      SIMCTL_CHILD_MOOPS_BENCHMARK_ARM_LABEL: arm.label,
      SIMCTL_CHILD_MOOPS_BENCHMARK_START_EPOCH_MS: String(summary.startEpochMs),
      SIMCTL_CHILD_MOOPS_BENCHMARK_DEADLINE_EPOCH_MS: String(summary.deadlineEpochMs),
    };
    if (arm.id === "codex-injection") {
      environment.SIMCTL_CHILD_MOOPS_ENABLE_INJECTIONIII = "1";
    }
    return {
      armId: arm.id,
      label: arm.label,
      udid: arm.simulatorUdid,
      argv: [
        "/usr/bin/xcrun", "simctl", "launch", "--terminate-running-process",
        arm.simulatorUdid, manifest.appBundleId,
      ],
      environment,
    };
  });
  return {
    planVersion: 1,
    runId: summary.runId,
    showcaseDirectory,
    recordingSeconds,
    commonClock: {
      startEpochMs: summary.startEpochMs,
      deadlineEpochMs: summary.deadlineEpochMs,
    },
    boots: manifest.arms.map((arm) => ({
      armId: arm.id,
      udid: arm.simulatorUdid,
      boot: ["/usr/bin/xcrun", "simctl", "boot", arm.simulatorUdid],
      bootstatus: ["/usr/bin/xcrun", "simctl", "bootstatus", arm.simulatorUdid, "-b"],
      open: ["/usr/bin/open", "-na", "Simulator", "--args", "-CurrentDeviceUDID", arm.simulatorUdid],
    })),
    backendCommands: manifest.arms.map((arm) => ({
      armId: arm.id,
      port: arm.backendPort,
      fixtureRevision: manifest.backendFixtureRevision,
      argv: renderArgv(manifest.backendCommand, {
        BACKEND_FIXTURE_REVISION: manifest.backendFixtureRevision,
        BACKEND_PORT: String(arm.backendPort),
        WORKTREE: arm.worktree,
      }),
    })),
    launches,
    layout: layoutPlan(manifest, { outputPath: join(showcaseDirectory, "simulator-layout.json") }),
    simulatorRecordings: manifest.arms.map((arm) => ({
      armId: arm.id,
      output: join(showcaseDirectory, `${arm.id}.mp4`),
      argv: [
        "/usr/bin/xcrun", "simctl", "io", arm.simulatorUdid,
        "recordVideo", "--codec=h264", join(showcaseDirectory, `${arm.id}.mp4`),
      ],
    })),
    desktopRecording: {
      output: join(showcaseDirectory, "moops-four-arm-showcase.source.mov"),
      argv: [
        "/usr/sbin/screencapture",
        "-v",
        `-R${manifest.showcase.desktopRegion.x},${manifest.showcase.desktopRegion.y},${manifest.showcase.desktopRegion.width},${manifest.showcase.desktopRegion.height}`,
        `-V${recordingSeconds}`,
        "-k",
        join(showcaseDirectory, "moops-four-arm-showcase.source.mov"),
      ],
    },
    compositeRecording: {
      source: join(showcaseDirectory, "moops-four-arm-showcase.source.mov"),
      output: join(showcaseDirectory, "moops-four-arm-showcase.mp4"),
      argv: [
        "/usr/bin/env", "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-n", "-i", join(showcaseDirectory, "moops-four-arm-showcase.source.mov"),
        "-map", "0:v:0", "-c:v", "copy", "-movflags", "+faststart",
        join(showcaseDirectory, "moops-four-arm-showcase.mp4"),
      ],
    },
    slate: [3, 2, 1].map((value) => ({
      value,
      argv: [
        "/usr/bin/osascript",
        "-e",
        `display dialog "MOOPS FOUR-ARM BENCHMARK\\nSTART IN ${value}\\n\\n${labels}" buttons {" "} default button 1 giving up after 1 with title "MOOPS LIVE"`,
      ],
    })),
  };
}

function simulatorMap(raw) {
  const result = new Map();
  for (const devices of Object.values(raw.devices ?? {})) {
    for (const device of devices) result.set(device.udid, device);
  }
  return result;
}

async function requireSuccess(argv, options = {}) {
  const result = await captureCommand(argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  if (result.exitCode !== 0) {
    fail("E_SHOWCASE_COMMAND", `${argv[0]} exited with ${result.exitCode}: ${result.stderr.trim()}`);
  }
  return result;
}

export async function runShowcase(manifest, summary, options = {}) {
  const plan = buildShowcasePlan(manifest, summary, options);
  if (options.dryRun) return { ok: true, dryRun: true, plan };

  await requireSuccess(["/usr/bin/env", "ffmpeg", "-version"], { timeoutMs: 30_000 });

  await mkdir(plan.showcaseDirectory);
  const resultDirectories = {};
  for (const arm of manifest.arms) {
    resultDirectories[arm.id] = join(plan.showcaseDirectory, arm.id);
    await mkdir(resultDirectories[arm.id]);
  }
  const ledger = new EventLedger(join(plan.showcaseDirectory, "showcase.events.jsonl"));
  await ledger.initialize();
  await ledger.emit("showcase.preflight.started", { runId: summary.runId });
  let recordings = [];
  let recordingStops = [];
  let backends = [];
  let interruptedBy = null;
  try {
    const devicesResult = await requireSuccess(
      ["/usr/bin/xcrun", "simctl", "list", "devices", "--json"],
      { timeoutMs: 30_000 },
    );
    const devices = simulatorMap(JSON.parse(devicesResult.stdout));
    for (const boot of plan.boots) {
      const device = devices.get(boot.udid);
      if (!device) fail("E_SHOWCASE_DEVICE", `${boot.armId} simulator does not exist`);
      if (device.name !== plan.layout.titles[boot.armId]) {
        fail("E_SHOWCASE_DEVICE", `${boot.armId} simulator must be named ${plan.layout.titles[boot.armId]}`);
      }
      if (device.state !== "Booted") await requireSuccess(boot.boot, { timeoutMs: 60_000 });
      await requireSuccess(boot.bootstatus, { timeoutMs: 120_000 });
      await requireSuccess(boot.open, { timeoutMs: 30_000 });
      await ledger.emit("showcase.simulator.ready", { armId: boot.armId, udid: boot.udid });
    }

    backends = await startDedicatedBackends(manifest, { ledger, resultDirectories });
    for (const launch of plan.launches) {
      await requireSuccess(launch.argv, {
        env: { ...process.env, ...launch.environment },
        timeoutMs: 30_000,
      });
      await ledger.emit("showcase.app.launched", {
        armId: launch.armId,
        label: launch.label,
        startEpochMs: summary.startEpochMs,
        deadlineEpochMs: summary.deadlineEpochMs,
      });
    }

    const layoutResult = await requireSuccess(plan.layout.argv, { timeoutMs: 30_000 });
    const layoutReceipt = JSON.parse(layoutResult.stdout);
    if (layoutReceipt?.ok !== true || layoutReceipt.layout !== "2x2"
      || layoutReceipt.assignments?.length !== 4) {
      fail("E_SHOWCASE_LAYOUT", "visual helper did not verify the exact four-window 2x2 grid");
    }
    await ledger.emit("showcase.layout.verified", {
      mode: plan.layout.mode,
      exitCode: layoutResult.exitCode,
      receipt: layoutReceipt,
    });

    const recordingPlans = [plan.desktopRecording, ...plan.simulatorRecordings];
    for (const [index, recording] of recordingPlans.entries()) {
      const controller = await startBackgroundProcess(recording.argv, {
        cwd: plan.showcaseDirectory,
        env: process.env,
        stdoutPath: join(plan.showcaseDirectory, `recording-${index}.stdout.log`),
        stderrPath: join(plan.showcaseDirectory, `recording-${index}.stderr.log`),
      });
      recordings.push({ ...recording, controller });
    }
    const recordingStartedEpochMs = Date.now();
    await ledger.emit("showcase.recording.started", {
      pids: recordings.map(({ controller }) => controller.pid),
      desktopOutput: plan.desktopRecording.output,
      simulatorOutputs: plan.simulatorRecordings.map(({ output }) => output),
    });
    await delay(500);
    const earlyExit = recordings.find(({ controller }) => controller.exited);
    if (earlyExit) fail("E_SHOWCASE_RECORDING", "a recorder exited before the slate");

    for (const slate of plan.slate) {
      await ledger.emit("showcase.countdown", {
        value: slate.value,
        startEpochMs: summary.startEpochMs,
        deadlineEpochMs: summary.deadlineEpochMs,
      });
      await requireSuccess(slate.argv, { timeoutMs: 5_000 });
    }

    const signal = new Promise((resolve) => {
      const onInterrupt = () => resolve("SIGINT");
      const onTerminate = () => resolve("SIGTERM");
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onTerminate);
    });
    const remaining = Math.max(0, plan.recordingSeconds * 1_000 - (Date.now() - recordingStartedEpochMs));
    interruptedBy = await Promise.race([delay(remaining).then(() => null), signal]);
  } catch (cause) {
    await ledger.emit("showcase.failed", {
      error: { code: cause?.code ?? "E_INTERNAL", message: cause.message },
    });
    throw cause;
  } finally {
    recordingStops = await Promise.allSettled(recordings.map(({ controller }) => controller.stop("SIGINT")));
    if (backends.length > 0) await stopDedicatedBackends(backends, ledger);
    await ledger.emit("showcase.stopped", { interruptedBy });
    await ledger.close();
  }

  const recordersStopped = recordingStops.length === 5 && recordingStops.every((entry) => (
    entry.status === "fulfilled"
    && entry.value?.error == null
    && ((entry.value?.exitCode === 0 && entry.value?.signal == null) || entry.value?.signal === "SIGINT")
  ));
  if (!recordersStopped) fail("E_SHOWCASE_RECORDING", "one or more showcase recorders did not stop cleanly");
  const composite = await convertCompositeRecording(plan.compositeRecording, {
    cwd: plan.showcaseDirectory,
  });
  if (!composite.ok) fail("E_SHOWCASE_RECORDING", "showcase composite MP4 conversion failed");

  const result = {
    reportVersion: 1,
    ok: true,
    runId: summary.runId,
    interruptedBy,
    desktopRecordingSource: plan.desktopRecording.output,
    desktopRecording: composite.output,
    compositeRecording: composite,
    simulatorRecordings: plan.simulatorRecordings.map(({ armId, output }) => ({ armId, output })),
    layout: plan.layout,
  };
  await writeFile(
    join(plan.showcaseDirectory, "showcase-summary.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx" },
  );
  return result;
}
