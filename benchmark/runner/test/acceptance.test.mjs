import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";

import { ARM_DEFINITIONS } from "../src/config.mjs";
import {
  acceptanceEnvironmentForArm,
  buildXCTestRunInjections,
  renderAcceptanceCommand,
  temporaryXCTestRunPath,
} from "../src/acceptance.mjs";

function arm(definition) {
  return {
    ...definition,
    environment: definition.id === "codex-injection"
      ? { MOOPS_ENABLE_INJECTIONIII: "1" }
      : {},
  };
}

test("injects the common start clock and exact label into every acceptance runner", () => {
  const clocks = {
    startEpochMs: 123_456,
    deadlineEpochMs: 9_999_999,
    backendBaseURL: "http://127.0.0.1:18055",
  };
  const environments = ARM_DEFINITIONS.map((definition) => acceptanceEnvironmentForArm(
    arm(definition),
    clocks,
    "take-001",
  ));

  assert.equal(new Set(environments.map((value) => value.MOOPS_BENCHMARK_START_EPOCH_MS)).size, 1);
  assert.equal(new Set(environments.map((value) => value.MOOPS_BENCHMARK_DEADLINE_EPOCH_MS)).size, 1);
  assert.deepEqual(
    environments.map((value) => value.MOOPS_BENCHMARK_ARM_LABEL),
    ARM_DEFINITIONS.map(({ label }) => label),
  );
  assert.deepEqual(
    environments.map((value) => value.MOOPS_BENCHMARK_RUN_ID),
    ["take-001", "take-001", "take-001", "take-001"],
  );
});

test("replaces the measured acceptance selector with the persisted showcase proof", () => {
  const manifest = {
    acceptanceCommand: [
      "xcodebuild",
      "test-without-building",
      "-xctestrun",
      "${XCTESTRUN}",
      "-destination",
      "id=${SIMULATOR_UDID}",
      "-only-testing:FoodDeliveryBenchmarkUITests/BenchmarkFlowUITests/test3DeliveryPreferenceAcceptance",
    ],
  };
  const argv = renderAcceptanceCommand(manifest, {
    SIMULATOR_UDID: "SIM-1",
  }, "/derived/copy.xctestrun",
  "FoodDeliveryBenchmarkUITests/BenchmarkFlowUITests/test4PersistedVerificationShowcase");

  assert.deepEqual(argv.slice(-1), [
    "-only-testing:FoodDeliveryBenchmarkUITests/BenchmarkFlowUITests/test4PersistedVerificationShowcase",
  ]);
  assert.equal(argv.includes("/derived/copy.xctestrun"), true);
});

test("injects InjectionIII only into arm C", () => {
  const environments = ARM_DEFINITIONS.map((definition) => acceptanceEnvironmentForArm(
    arm(definition),
    { startEpochMs: 1, deadlineEpochMs: 2, backendBaseURL: "http://127.0.0.1:18055" },
    "take-001",
  ));
  assert.deepEqual(
    environments.map((value) => value.MOOPS_ENABLE_INJECTIONIII ?? null),
    [null, null, "1", null],
  );
});

test("uses direct plist argv against a unique colocated xctestrun copy", () => {
  const source = "/tmp/derived/Build/Products/FoodDeliveryBenchmark_iphone.xctestrun";
  const copy = temporaryXCTestRunPath(source, "fixed-id");
  const commands = buildXCTestRunInjections(
    {
      MOOPS_BENCHMARK_ARM_LABEL: "CODEX + UITEST",
      MOOPS_BENCHMARK_RUN_ID: "take-001",
      MOOPS_BENCHMARK_START_EPOCH_MS: "123",
    },
    copy,
  );

  assert.equal(dirname(copy), dirname(source));
  assert.notEqual(copy, source);
  assert.equal(commands.length, 6);
  assert.deepEqual(commands[0].slice(0, 3), ["/usr/bin/plutil", "-insert", "FoodDeliveryBenchmarkUITests.EnvironmentVariables.MOOPS_BENCHMARK_ARM_LABEL"]);
  assert.equal(commands.every((argv) => argv.at(-1) === copy), true);
  assert.equal(commands.some((argv) => argv[2].includes("UITargetAppEnvironmentVariables")), true);
  assert.equal(commands.filter((argv) => (
    argv[2].endsWith(".MOOPS_BENCHMARK_RUN_ID") && argv[4] === "take-001"
  )).length, 2);
});
