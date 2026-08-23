import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, runCLI } from "../injectioniii-evidence.mjs";

test("parses the complete preflight command without accepting shell strings", () => {
  assert.deepEqual(parseArguments([
    "preflight",
    "--worktree", "/tmp/worktree",
    "--derived-data", "/tmp/derived",
    "--injection-app", "/Applications/InjectionIII.app",
    "--control-socket", "/tmp/InjectionNext-control.sock",
    "--output", "/tmp/preflight.json",
  ]), {
    command: "preflight",
    worktree: "/tmp/worktree",
    derivedData: "/tmp/derived",
    injectionAppPath: "/Applications/InjectionIII.app",
    controlSocketPath: "/tmp/InjectionNext-control.sock",
    outputPath: "/tmp/preflight.json",
  });
});

test("preflight CLI emits and exclusively writes the same machine-readable receipt", async () => {
  const report = { reportVersion: 1, phase: "preflight", ok: true };
  const writes = [];
  let stdout = "";
  const exitCode = await runCLI([
    "preflight", "--worktree", "/tmp/worktree", "--output", "/tmp/preflight.json",
  ], {
    collectPreflight: async (options) => {
      assert.equal(options.worktree, "/tmp/worktree");
      return report;
    },
    writeFile: async (...args) => writes.push(args),
    stdout: (source) => { stdout += source; },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout), report);
  assert.deepEqual(writes, [[
    "/tmp/preflight.json",
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  ]]);
});

test("postflight CLI reads preflight and optional fallback receipts before collecting evidence", async () => {
  const preflight = { reportVersion: 1, phase: "preflight", ok: true };
  const fallback = { schemaVersion: 1, kind: "structural-fallback" };
  const report = { reportVersion: 1, phase: "postflight", ok: true };
  const reads = [];
  let stdout = "";
  const exitCode = await runCLI([
    "postflight",
    "--preflight", "/tmp/preflight.json",
    "--app-pid", "64710",
    "--fallback-evidence", "/tmp/fallback.json",
  ], {
    readJSON: async (path) => {
      reads.push(path);
      return path.endsWith("fallback.json") ? fallback : preflight;
    },
    collectPostflight: async (options) => {
      assert.deepEqual(options, { preflight, fallbackEvidence: fallback, appPid: 64710 });
      return report;
    },
    stdout: (source) => { stdout += source; },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(reads, ["/tmp/preflight.json", "/tmp/fallback.json"]);
  assert.deepEqual(JSON.parse(stdout), report);
});

test("CLI fails closed with one JSON error receipt", async () => {
  let stdout = "";
  const exitCode = await runCLI([
    "preflight", "--worktree", "/tmp/worktree",
  ], {
    collectPreflight: async () => {
      const error = new Error("host is absent");
      error.code = "E_INJECTION_HOST";
      throw error;
    },
    stdout: (source) => { stdout += source; },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stdout), {
    reportVersion: 1,
    phase: "preflight",
    ok: false,
    error: { code: "E_INJECTION_HOST", message: "host is absent" },
  });
});

test("rejects duplicate, unknown, and incomplete CLI arguments", () => {
  assert.throws(
    () => parseArguments(["preflight", "--worktree", "/tmp/a", "--worktree", "/tmp/b"]),
    /may be provided only once/,
  );
  assert.throws(
    () => parseArguments(["postflight", "--preflight", "/tmp/p", "--app-pid", "nope"]),
    /positive integer/,
  );
  assert.throws(
    () => parseArguments(["preflight", "--worktree", "/tmp/a", "--mystery", "x"]),
    /unknown option/,
  );
});
