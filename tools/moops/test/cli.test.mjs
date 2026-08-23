import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { fingerprintCheckpoint } from "../src/checkpoint.mjs";
import { executeCommand } from "../src/command.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../moops");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "moops-cli-"));
  const adapter = join(directory, "ui-adapter.mjs");
  await writeFile(adapter, `
const request = JSON.parse(process.argv[2]);
if (["inspect", "restore-and-inspect"].includes(request.operation)) {
  process.stdout.write(JSON.stringify({
    ok: true,
    observation: { nodes: [{ text: "My cart" }] }
  }));
} else {
  process.stdout.write(JSON.stringify({ ok: true }));
}
`);
  const checkpoint = {
    schemaVersion: 1,
    fixtureVersion: "food-delivery-v1",
    name: "cart-ready",
    app: { bundleId: "com.example.food" },
    simulator: { udid: "SIM-1" },
    adapters: {
      doctor: [["/usr/bin/true"]],
      build: ["/usr/bin/true"],
      install: ["/usr/bin/true"],
      launch: ["/usr/bin/true"],
      ui: [process.execPath, adapter],
    },
    trace: [
      { op: "wait", selector: { by: "text", value: "Home" }, timeoutMs: 1000 },
      { op: "tap", selector: { by: "label", value: "Cart" } },
    ],
    landingPredicates: [
      { kind: "exists", selector: { by: "text", value: "My cart" } },
    ],
  };
  checkpoint.fingerprint = fingerprintCheckpoint(checkpoint);
  const checkpointPath = join(directory, "checkpoint.json");
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return { checkpoint, checkpointPath, directory };
}

test("process adapter preserves argv literally and never invokes a shell", async () => {
  const marker = "$(printf should-not-run)";
  const result = await executeCommand(
    [process.execPath, "-e", "process.stdout.write(process.argv[1])", marker],
    { timeoutMs: 1000 },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, marker);
});

test("checkpoint command validates and identifies the fingerprinted checkpoint", async () => {
  const { checkpoint, checkpointPath } = await fixture();
  const result = spawnSync(process.execPath, [cli, "checkpoint", checkpointPath], {
    encoding: "utf8",
  });
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(report.ok, true);
  assert.equal(report.command, "checkpoint");
  assert.equal(report.checkpoint.fingerprint, checkpoint.fingerprint);
});

test("verify emits a successful fresh-observation report", async () => {
  const { checkpointPath } = await fixture();
  const result = spawnSync(process.execPath, [cli, "verify", checkpointPath], {
    encoding: "utf8",
  });
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(report.ok, true);
  assert.deepEqual(report.phases.map((phase) => phase.name), ["inspect", "landing"]);
});

test("build-and-restore writes the same JSON report to an explicit output", async () => {
  const { checkpointPath, directory } = await fixture();
  const output = join(directory, "result.json");
  const result = spawnSync(
    process.execPath,
    [cli, "build-and-restore", checkpointPath, "--output", output],
    { encoding: "utf8" },
  );
  const stdoutReport = JSON.parse(result.stdout);
  const fileReport = JSON.parse(await readFile(output, "utf8"));

  assert.equal(result.status, 0);
  assert.equal(stdoutReport.ok, true);
  assert.deepEqual(fileReport, stdoutReport);
});

test("tampered checkpoints fail closed with JSON and a nonzero status", async () => {
  const { checkpoint, checkpointPath } = await fixture();
  checkpoint.name = "tampered";
  await writeFile(checkpointPath, JSON.stringify(checkpoint));

  const result = spawnSync(process.execPath, [cli, "doctor", checkpointPath], {
    encoding: "utf8",
  });
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "E_CHECKPOINT_FINGERPRINT");
});

test("refuses an oversized checkpoint before parsing it", async () => {
  const { checkpointPath } = await fixture();
  await writeFile(checkpointPath, " ".repeat(262_145));

  const result = spawnSync(process.execPath, [cli, "checkpoint", checkpointPath], {
    encoding: "utf8",
  });
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(report.error.code, "E_CHECKPOINT_SIZE");
});
