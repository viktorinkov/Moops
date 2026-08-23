import assert from "node:assert/strict";
import test from "node:test";

import {
  parseArguments,
  runCLI,
} from "../tile-simulators.mjs";

const ARGV = [
  "--x", "20",
  "--y", "40",
  "--width", "1600",
  "--height", "1000",
  "--a-title", "MOOPS A — CODEX + UITEST",
  "--b-title", "MOOPS B — CODEX + PREVIEWS",
  "--c-title", "MOOPS C — CODEX + INJECTION",
  "--d-title", "MOOPS D — CODEX + MOOPS + CLAUDEMEM",
  "--output", "/results/simulator-layout.json",
];

test("parseArguments maps strict CLI flags to the four fixed arms", () => {
  assert.deepEqual(parseArguments(ARGV), {
    region: { x: 20, y: 40, width: 1600, height: 1000 },
    titles: {
      "codex-uitest": "MOOPS A — CODEX + UITEST",
      "codex-previews": "MOOPS B — CODEX + PREVIEWS",
      "codex-injection": "MOOPS C — CODEX + INJECTION",
      "codex-moops-claudemem": "MOOPS D — CODEX + MOOPS + CLAUDEMEM",
    },
    outputPath: "/results/simulator-layout.json",
  });
});

test("parseArguments accepts signed display coordinates but rejects non-integers", () => {
  const parsed = parseArguments(ARGV.with(1, "-1920"));
  assert.equal(parsed.region.x, -1920);
  assert.throws(() => parseArguments(ARGV.with(1, "20.5")), /--x must be an integer/);
});

test("parseArguments rejects missing, repeated, and unknown flags", () => {
  assert.throws(() => parseArguments(ARGV.slice(0, 2)), /requires --y/);
  assert.throws(() => parseArguments([...ARGV, "--width", "1600"]), /only once/);
  assert.throws(() => parseArguments([...ARGV, "--layout", "1x4"]), /unknown option/);
});

test("runCLI writes one exclusive mode-0600 receipt and prints the same JSON", async () => {
  const calls = [];
  let printed = "";
  const report = {
    schemaVersion: 1,
    ok: true,
    layout: "2x2",
    assignments: [{ arm: "A", position: "top-left" }],
  };
  const exitCode = await runCLI(ARGV, {
    tile: async (config) => {
      calls.push({ kind: "tile", config });
      return report;
    },
    writeFile: async (...args) => calls.push({ kind: "write", args }),
    stdout: (source) => { printed += source; },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls[0].kind, "tile");
  assert.equal(calls[0].config.titles["codex-injection"], "MOOPS C — CODEX + INJECTION");
  assert.equal(calls[1].kind, "write");
  assert.equal(calls[1].args[0], "/results/simulator-layout.json");
  assert.deepEqual(calls[1].args[2], { encoding: "utf8", flag: "wx", mode: 0o600 });
  assert.deepEqual(JSON.parse(printed), report);
  assert.equal(calls[1].args[1], printed);
});

test("runCLI emits machine-readable fail-closed evidence", async () => {
  let printed = "";
  const exitCode = await runCLI(ARGV, {
    tile: async () => {
      const error = new Error("one Simulator is missing");
      error.code = "E_VISUAL_WINDOW_SET";
      throw error;
    },
    stdout: (source) => { printed += source; },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(printed), {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "E_VISUAL_WINDOW_SET",
      message: "one Simulator is missing",
    },
  });
});
