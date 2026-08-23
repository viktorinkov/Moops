import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareInjectionIIIArm,
  verifyInjectionIIIArm,
} from "../src/injectioniii.mjs";

test("arm C preflight and postflight bind the exact worktree, PID, and runner-derived fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-injection-runner-"));
  const worktree = join(root, "worktree");
  const derivedData = join(root, "derived");
  const resultDirectory = join(root, "results");
  await Promise.all([mkdir(worktree), mkdir(derivedData), mkdir(resultDirectory)]);
  const sourcePath = join(worktree, "DeliveryPreference.swift");
  await writeFile(sourcePath, "enum DeliveryPreference {}\n");
  const preflight = {
    reportVersion: 1,
    phase: "preflight",
    ok: true,
    observedEpochMs: 1_700_000_000_000,
    worktree,
    derivedData,
    injectionIII: { version: "5.2.1" },
    host: { pid: 321, listener: "127.0.0.1:8898" },
    control: { socketPath: "/tmp/InjectionNext-control.sock" },
  };
  const calls = [];
  const capture = async (argv) => {
    calls.push(argv);
    const output = argv[argv.indexOf("--output") + 1];
    const report = argv.includes("preflight")
      ? preflight
      : { reportVersion: 1, phase: "postflight", ok: true, app: { pid: 4_567 } };
    await writeFile(output, `${JSON.stringify(report)}\n`, { flag: "wx" });
    return { exitCode: 0, signal: null, stdout: `${JSON.stringify(report)}\n`, stderr: "" };
  };
  const arm = { id: "codex-injection", worktree, derivedData };
  const prepared = await prepareInjectionIIIArm({ arms: [arm] }, {
    resultDirectory,
    ledger: { emit: async () => {} },
  }, { capture });
  assert.equal(prepared.worktree, worktree);

  const verified = await verifyInjectionIIIArm(prepared, {
    arm,
    resultDirectory,
    ledger: { emit: async () => {} },
    command: {
      commands: [
        {
          command: "/usr/bin/xcrun simctl launch SIM com.example.food",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: "com.example.food: 4567\n",
          completedEpochMs: 1_700_000_001_000,
        },
        {
          command: `/usr/bin/xcrun xcodebuild build -derivedDataPath ${derivedData}`,
          status: "completed",
          exitCode: 0,
          completedEpochMs: 1_700_000_002_000,
        },
      ],
      fileChanges: [{
        status: "completed",
        changes: [{ path: sourcePath, kind: { type: "add" } }],
      }],
    },
  }, { capture });

  assert.equal(verified.ok, true);
  assert.equal(verified.app.pid, 4_567);
  assert.equal(calls[1].includes("--app-pid"), true);
  assert.equal(calls[1][calls[1].indexOf("--app-pid") + 1], "4567");
  assert.equal(calls[1].includes("--fallback-evidence"), true);
});

