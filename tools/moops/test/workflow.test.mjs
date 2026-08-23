import assert from "node:assert/strict";
import test from "node:test";

import { fingerprintCheckpoint } from "../src/checkpoint.mjs";
import {
  evaluateLandingPredicates,
  expandArgv,
  runWorkflow,
} from "../src/workflow.mjs";

function validCheckpoint() {
  const checkpoint = {
    schemaVersion: 1,
    fixtureVersion: "food-delivery-v1",
    name: "cart-ready",
    app: { bundleId: "com.example.food" },
    simulator: { udid: "${MOOPS_SIMULATOR_UDID}" },
    adapters: {
      doctor: [["doctor-tool", "${MOOPS_SIMULATOR_UDID}"]],
      build: ["build-tool"],
      install: ["install-tool", "${MOOPS_APP_PATH}"],
      launch: ["launch-tool", "${MOOPS_SIMULATOR_UDID}"],
      ui: ["${MOOPS_UI_ADAPTER}", "--json"],
    },
    trace: [
      {
        op: "wait",
        selector: { by: "text", value: "Home" },
        timeoutMs: 10_000,
      },
      { op: "tap", selector: { by: "label", value: "Cart" } },
    ],
    landingPredicates: [
      { kind: "exists", selector: { by: "text", value: "My cart" } },
      {
        kind: "equals",
        selector: { by: "id", value: "checkout.ready" },
        field: "enabled",
        expected: true,
      },
    ],
  };
  checkpoint.fingerprint = fingerprintCheckpoint(checkpoint);
  return checkpoint;
}

const testEnvironment = {
  MOOPS_APP_PATH: "/tmp/Food Delivery.app",
  MOOPS_SIMULATOR_UDID: "SIM-1",
  MOOPS_UI_ADAPTER: "/tmp/moops-ui-adapter",
};

function successfulRunner(calls) {
  return async (argv) => {
    calls.push(argv);
    if (argv[0] === testEnvironment.MOOPS_UI_ADAPTER) {
      const request = JSON.parse(argv.at(-1));
      if (request.operation === "inspect") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            observation: {
              nodes: [
                { text: "My cart" },
                { id: "checkout.ready", enabled: true },
              ],
            },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("expands environment templates as argv values without a shell", () => {
  assert.deepEqual(
    expandArgv(["tool", "--device=${DEVICE}"], { DEVICE: "SIM 1" }),
    ["tool", "--device=SIM 1"],
  );
  assert.throws(
    () => expandArgv(["tool", "${MISSING}"], {}),
    (error) => error.code === "E_ADAPTER_ENV",
  );
});

test("evaluates every landing predicate against one fresh observation", () => {
  const predicates = validCheckpoint().landingPredicates;
  const result = evaluateLandingPredicates(predicates, {
    nodes: [
      { text: "My cart" },
      { id: "checkout.ready", enabled: true },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.results.every((entry) => entry.passed), true);
});

test("verify performs one fresh inspect and no restore mutation", async () => {
  const calls = [];
  const report = await runWorkflow("verify", validCheckpoint(), {
    env: testEnvironment,
    runCommand: successfulRunner(calls),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.phases.map((phase) => phase.name), ["inspect", "landing"]);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].at(-1)).operation, "inspect");
});

test("build-and-restore runs fixed adapters, public trace, then fresh inspect", async () => {
  const calls = [];
  const report = await runWorkflow("build-and-restore", validCheckpoint(), {
    env: testEnvironment,
    runCommand: successfulRunner(calls),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.phases.map((phase) => phase.name), [
    "build",
    "install",
    "launch",
    "restore",
    "inspect",
    "landing",
  ]);
  assert.deepEqual(calls.slice(0, 3).map((argv) => argv[0]), [
    "build-tool",
    "install-tool",
    "launch-tool",
  ]);
  assert.deepEqual(
    calls.slice(3).map((argv) => JSON.parse(argv.at(-1)).operation),
    ["perform", "perform", "inspect"],
  );
  assert.equal(Object.values(report.timingsMs).every(Number.isFinite), true);
});

test("stops before install when build fails", async () => {
  const calls = [];
  const report = await runWorkflow("build-and-restore", validCheckpoint(), {
    env: testEnvironment,
    runCommand: async (argv) => {
      calls.push(argv);
      return { exitCode: 65, stdout: "", stderr: "compile failed" };
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.error.code, "E_ADAPTER_FAILED");
  assert.equal(report.error.phase, "build");
  assert.equal(calls.length, 1);
});

test("fails closed when a UI adapter prints non-JSON output", async () => {
  const report = await runWorkflow("verify", validCheckpoint(), {
    env: testEnvironment,
    runCommand: async () => ({ exitCode: 0, stdout: "runner ready", stderr: "" }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.error.code, "E_UI_PROTOCOL");
  assert.equal(report.error.phase, "inspect");
});

test("fails when any landing predicate is absent", async () => {
  const report = await runWorkflow("verify", validCheckpoint(), {
    env: testEnvironment,
    runCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, observation: { nodes: [{ text: "My cart" }] } }),
      stderr: "",
    }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.error.code, "E_LANDING_FAILED");
  assert.equal(report.landing.ok, false);
  assert.deepEqual(report.landing.results.map((entry) => entry.passed), [true, false]);
});
