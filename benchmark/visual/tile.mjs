import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ARM_LAYOUT = Object.freeze([
  Object.freeze({
    arm: "A",
    armId: "codex-uitest",
    label: "CODEX + UITEST",
    position: "top-left",
    column: 0,
    row: 0,
  }),
  Object.freeze({
    arm: "B",
    armId: "codex-previews",
    label: "CODEX + PREVIEWS",
    position: "top-right",
    column: 1,
    row: 0,
  }),
  Object.freeze({
    arm: "C",
    armId: "codex-injection",
    label: "CODEX + INJECTION",
    position: "bottom-left",
    column: 0,
    row: 1,
  }),
  Object.freeze({
    arm: "D",
    armId: "codex-moops-claudemem",
    label: "CODEX + MOOPS + CLAUDEMEM",
    position: "bottom-right",
    column: 1,
    row: 1,
  }),
]);

export class VisualTilerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "VisualTilerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new VisualTilerError(code, message, details);
}

function validateRegion(region) {
  if (!region || typeof region !== "object" || Array.isArray(region)) {
    fail("E_VISUAL_REGION", "desktop region must be an object");
  }
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isSafeInteger(region[key])) {
      fail("E_VISUAL_REGION", `desktop region ${key} must be a safe integer`);
    }
  }
  if (region.width <= 0 || region.height <= 0) {
    fail("E_VISUAL_REGION", "desktop region width and height must be positive");
  }
  if (region.width % 2 !== 0 || region.height % 2 !== 0) {
    fail("E_VISUAL_REGION", "desktop region width and height must be even for an exact equal 2x2 grid");
  }
  return {
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  };
}

function validateTitles(titles) {
  if (!titles || typeof titles !== "object" || Array.isArray(titles)) {
    fail("E_VISUAL_TITLE", "titles must map every benchmark arm id to an exact window title");
  }
  const validated = {};
  for (const { armId } of ARM_LAYOUT) {
    const title = titles[armId];
    if (typeof title !== "string" || title.length === 0 || title.trim() !== title) {
      fail("E_VISUAL_TITLE", `${armId} requires a non-empty exact window title without surrounding whitespace`);
    }
    validated[armId] = title;
  }
  const values = Object.values(validated);
  if (new Set(values).size !== ARM_LAYOUT.length) {
    fail("E_VISUAL_TITLE", "all four configured Simulator window titles must be unique");
  }
  return validated;
}

export function buildGrid(region, titles) {
  const checkedRegion = validateRegion(region);
  const checkedTitles = validateTitles(titles);
  const width = checkedRegion.width / 2;
  const height = checkedRegion.height / 2;
  return ARM_LAYOUT.map(({ column, row, ...arm }) => ({
    ...arm,
    title: checkedTitles[arm.armId],
    expectedFrame: {
      x: checkedRegion.x + column * width,
      y: checkedRegion.y + row * height,
      width,
      height,
    },
  }));
}

function executeProcess(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({
      exitCode: exitCode ?? 1,
      signal,
      stdout,
      stderr,
    }));
  });
}

function parseProbe(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") {
    fail("E_VISUAL_RECEIPT", "JXA tiler returned no JSON evidence");
  }
  try {
    return JSON.parse(stdout.trim());
  } catch (cause) {
    fail("E_VISUAL_RECEIPT", "JXA tiler returned malformed JSON evidence", {
      cause: cause.message,
    });
  }
}

function isIntegerFrame(frame) {
  return frame
    && ["x", "y", "width", "height"].every((key) => Number.isSafeInteger(frame[key]));
}

function sameFrame(left, right) {
  return ["x", "y", "width", "height"].every((key) => left[key] === right[key]);
}

function validateProbe(probe, assignments) {
  if (!probe || typeof probe !== "object" || probe.schemaVersion !== 1) {
    fail("E_VISUAL_RECEIPT", "JXA tiler receipt has an unsupported schema");
  }
  if (probe.accessibility?.checked !== true || probe.accessibility?.trusted !== true) {
    fail(
      "E_VISUAL_ACCESSIBILITY",
      "Accessibility access is required for osascript/System Events to position Simulator windows",
      { accessibility: probe.accessibility ?? null },
    );
  }
  if (probe.operation?.ok === false) {
    const allowedCode = [
      "E_VISUAL_WINDOW_SET",
      "E_VISUAL_FRAME",
      "E_VISUAL_JXA",
    ].includes(probe.operation.code)
      ? probe.operation.code
      : "E_VISUAL_JXA";
    fail(allowedCode, probe.operation.message || "JXA tiler rejected the Simulator window set", {
      operation: probe.operation,
      discoveredWindows: probe.discoveredWindows ?? null,
    });
  }
  if (!Array.isArray(probe.discoveredWindows) || probe.discoveredWindows.length !== assignments.length) {
    fail("E_VISUAL_WINDOW_SET", "exactly four Simulator windows must be visible", {
      count: Array.isArray(probe.discoveredWindows) ? probe.discoveredWindows.length : null,
    });
  }

  const expectedTitles = new Set(assignments.map(({ title }) => title));
  const actualTitles = probe.discoveredWindows.map(({ title }) => title);
  const identities = probe.discoveredWindows.map(({ processId, windowIndex }) => `${processId}:${windowIndex}`);
  if (
    new Set(actualTitles).size !== assignments.length
    || new Set(identities).size !== assignments.length
    || actualTitles.some((title) => !expectedTitles.has(title))
  ) {
    fail("E_VISUAL_WINDOW_SET", "Simulator windows must uniquely and exactly match the four configured titles", {
      expectedTitles: [...expectedTitles],
      actualTitles,
    });
  }

  return assignments.map((assignment) => {
    const window = probe.discoveredWindows.find(({ title }) => title === assignment.title);
    if (!window || !isIntegerFrame(window.frame)) {
      fail("E_VISUAL_RECEIPT", `${assignment.arm} returned an invalid window frame`);
    }
    if (window.title !== assignment.title) {
      fail("E_VISUAL_WINDOW_SET", `${assignment.arm} window title changed during layout`);
    }
    if (!sameFrame(window.frame, assignment.expectedFrame)) {
      fail("E_VISUAL_FRAME", `${assignment.arm} Simulator frame does not match its exact ${assignment.position} cell`, {
        expected: assignment.expectedFrame,
        actual: window.frame,
      });
    }
    return {
      ...assignment,
      processId: window.processId,
      windowIndex: window.windowIndex,
      actualFrame: window.frame,
    };
  });
}

const DEFAULT_SCRIPT_PATH = fileURLToPath(new URL("./tile-simulators.jxa", import.meta.url));

export async function tileSimulatorWindows(config, options = {}) {
  const region = validateRegion(config?.region);
  const assignments = buildGrid(region, config?.titles);
  const execute = options.execute ?? executeProcess;
  const scriptPath = options.scriptPath ?? DEFAULT_SCRIPT_PATH;
  const payload = {
    schemaVersion: 1,
    region,
    assignments,
  };
  let execution;
  try {
    execution = await execute("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      scriptPath,
      JSON.stringify(payload),
    ]);
  } catch (cause) {
    fail("E_VISUAL_JXA", `could not start osascript: ${cause.message}`);
  }
  if (!execution || execution.exitCode !== 0) {
    fail("E_VISUAL_JXA", "osascript could not tile Simulator windows", {
      exitCode: execution?.exitCode ?? null,
      signal: execution?.signal ?? null,
      stderr: execution?.stderr?.trim() || null,
    });
  }
  const probe = parseProbe(execution.stdout);
  const verifiedAssignments = validateProbe(probe, assignments);
  return {
    schemaVersion: 1,
    ok: true,
    layout: "2x2",
    region,
    preconditions: {
      accessibility: probe.accessibility,
      screenRecording: probe.screenRecording ?? {
        checked: false,
        granted: null,
        error: "CoreGraphics screen-capture preflight was unavailable",
      },
    },
    assignments: verifiedAssignments,
  };
}
