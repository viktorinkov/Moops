import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../moops-benchmark");
const manifest = join(here, "../benchmark.example.json");

function invoke(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("cleanup plan accepts a run id without executing destructive commands", () => {
  const result = invoke(["cleanup-plan", manifest, "--run-id", "take-001"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.executed, false);
});

test("demo dry-run exposes the complete live plan without touching simulators", () => {
  const result = invoke(["demo", manifest, "--run-id", "take-001", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true);
  assert.equal(output.plan.mode, "live-measured-goals");
});
