import assert from "node:assert/strict";
import test from "node:test";

import {
  ARM_LAYOUT,
  VisualTilerError,
  buildGrid,
  tileSimulatorWindows,
} from "../tile.mjs";

const TITLES = Object.freeze({
  "codex-uitest": "MOOPS A — CODEX + UITEST",
  "codex-previews": "MOOPS B — CODEX + PREVIEWS",
  "codex-injection": "MOOPS C — CODEX + INJECTION",
  "codex-moops-claudemem": "MOOPS D — CODEX + MOOPS + CLAUDEMEM",
});

const REGION = Object.freeze({ x: 20, y: 40, width: 1600, height: 1000 });

function successfulProbe(overrides = {}) {
  const assignments = buildGrid(REGION, TITLES);
  return {
    schemaVersion: 1,
    accessibility: { checked: true, trusted: true },
    screenRecording: { checked: true, granted: true },
    discoveredWindows: assignments.map((assignment, index) => ({
      processId: 100 + index,
      windowIndex: 0,
      title: assignment.title,
      frame: assignment.expectedFrame,
    })),
    ...overrides,
  };
}

function fakeExecutor(result) {
  const calls = [];
  return {
    calls,
    execute: async (file, args) => {
      calls.push({ file, args });
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(result)}\n`,
        stderr: "",
      };
    },
  };
}

function assertCode(code) {
  return (error) => error instanceof VisualTilerError && error.code === code;
}

test("buildGrid fixes A/B/C/D into an exact equal 2x2 region", () => {
  assert.deepEqual(buildGrid(REGION, TITLES), [
    {
      arm: "A",
      armId: "codex-uitest",
      label: "CODEX + UITEST",
      position: "top-left",
      title: TITLES["codex-uitest"],
      expectedFrame: { x: 20, y: 40, width: 800, height: 500 },
    },
    {
      arm: "B",
      armId: "codex-previews",
      label: "CODEX + PREVIEWS",
      position: "top-right",
      title: TITLES["codex-previews"],
      expectedFrame: { x: 820, y: 40, width: 800, height: 500 },
    },
    {
      arm: "C",
      armId: "codex-injection",
      label: "CODEX + INJECTION",
      position: "bottom-left",
      title: TITLES["codex-injection"],
      expectedFrame: { x: 20, y: 540, width: 800, height: 500 },
    },
    {
      arm: "D",
      armId: "codex-moops-claudemem",
      label: "CODEX + MOOPS + CLAUDEMEM",
      position: "bottom-right",
      title: TITLES["codex-moops-claudemem"],
      expectedFrame: { x: 820, y: 540, width: 800, height: 500 },
    },
  ]);
  assert.equal(ARM_LAYOUT.length, 4);
});

test("buildGrid rejects odd regions instead of leaving a pixel or unequal arms", () => {
  assert.throws(
    () => buildGrid({ x: 0, y: 0, width: 1599, height: 1000 }, TITLES),
    assertCode("E_VISUAL_REGION"),
  );
});

test("tileSimulatorWindows invokes JXA without a shell and verifies the receipt", async () => {
  const fake = fakeExecutor(successfulProbe());
  const receipt = await tileSimulatorWindows(
    { region: REGION, titles: TITLES },
    { execute: fake.execute, scriptPath: "/repo/benchmark/visual/tile-simulators.jxa" },
  );

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].file, "/usr/bin/osascript");
  assert.deepEqual(fake.calls[0].args.slice(0, 3), [
    "-l",
    "JavaScript",
    "/repo/benchmark/visual/tile-simulators.jxa",
  ]);
  const payload = JSON.parse(fake.calls[0].args[3]);
  assert.deepEqual(payload.region, REGION);
  assert.equal(payload.assignments.length, 4);
  assert.equal(payload.assignments[2].armId, "codex-injection");
  assert.equal(receipt.ok, true);
  assert.equal(receipt.layout, "2x2");
  assert.equal(receipt.assignments[3].position, "bottom-right");
  assert.deepEqual(receipt.assignments[3].actualFrame, {
    x: 820,
    y: 540,
    width: 800,
    height: 500,
  });
  assert.deepEqual(receipt.preconditions.screenRecording, { checked: true, granted: true });
});

test("tileSimulatorWindows fails closed when an expected window is missing", async () => {
  const probe = successfulProbe();
  probe.discoveredWindows.pop();
  const fake = fakeExecutor(probe);
  await assert.rejects(
    tileSimulatorWindows({ region: REGION, titles: TITLES }, { execute: fake.execute }),
    assertCode("E_VISUAL_WINDOW_SET"),
  );
});

test("tileSimulatorWindows fails closed when a title is duplicated", async () => {
  const probe = successfulProbe();
  probe.discoveredWindows[3].title = probe.discoveredWindows[2].title;
  const fake = fakeExecutor(probe);
  await assert.rejects(
    tileSimulatorWindows({ region: REGION, titles: TITLES }, { execute: fake.execute }),
    assertCode("E_VISUAL_WINDOW_SET"),
  );
});

test("tileSimulatorWindows fails closed when the returned frame differs by one pixel", async () => {
  const probe = successfulProbe();
  probe.discoveredWindows[0].frame = { ...probe.discoveredWindows[0].frame, width: 799 };
  const fake = fakeExecutor(probe);
  await assert.rejects(
    tileSimulatorWindows({ region: REGION, titles: TITLES }, { execute: fake.execute }),
    assertCode("E_VISUAL_FRAME"),
  );
});

test("tileSimulatorWindows rejects a 1x4 row even when all four titles are present", async () => {
  const probe = successfulProbe();
  probe.discoveredWindows.forEach((window, index) => {
    window.frame = { x: 20 + index * 400, y: 40, width: 400, height: 1000 };
  });
  const fake = fakeExecutor(probe);
  await assert.rejects(
    tileSimulatorWindows({ region: REGION, titles: TITLES }, { execute: fake.execute }),
    assertCode("E_VISUAL_FRAME"),
  );
});

test("tileSimulatorWindows fails with a useful Accessibility precondition", async () => {
  const fake = fakeExecutor(successfulProbe({
    accessibility: { checked: true, trusted: false },
  }));
  await assert.rejects(
    tileSimulatorWindows({ region: REGION, titles: TITLES }, { execute: fake.execute }),
    assertCode("E_VISUAL_ACCESSIBILITY"),
  );
});

test("duplicate configured titles are rejected before invoking osascript", async () => {
  const fake = fakeExecutor(successfulProbe());
  const duplicateTitles = { ...TITLES, "codex-previews": TITLES["codex-uitest"] };
  await assert.rejects(
    tileSimulatorWindows({ region: REGION, titles: duplicateTitles }, { execute: fake.execute }),
    assertCode("E_VISUAL_TITLE"),
  );
  assert.equal(fake.calls.length, 0);
});
