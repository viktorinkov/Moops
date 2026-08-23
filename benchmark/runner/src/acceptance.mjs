import { randomUUID } from "node:crypto";
import { copyFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { renderArgv } from "./config.mjs";
import { captureCommand } from "./process.mjs";

const ENVIRONMENT_PLIST_PREFIXES = [
  "FoodDeliveryBenchmarkUITests.EnvironmentVariables",
  "FoodDeliveryBenchmarkUITests.UITargetAppEnvironmentVariables",
];

export class AcceptanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AcceptanceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AcceptanceError(code, message);
}

export function acceptanceEnvironmentForArm(arm, clocks, runId) {
  if (typeof runId !== "string" || runId === "") {
    fail("E_ACCEPTANCE_RUN_ID", "acceptance requires the exact benchmark run ID");
  }
  const environment = {
    MOOPS_BENCHMARK_RUN_ID: runId,
    MOOPS_BENCHMARK_ARM_ID: arm.id,
    MOOPS_BENCHMARK_ARM_LABEL: arm.label,
    MOOPS_BENCHMARK_START_EPOCH_MS: String(clocks.startEpochMs),
    MOOPS_BENCHMARK_DEADLINE_EPOCH_MS: String(clocks.deadlineEpochMs),
    MOOPS_BACKEND_BASE_URL: clocks.backendBaseURL,
  };
  if (arm.id === "codex-injection" && arm.environment.MOOPS_ENABLE_INJECTIONIII === "1") {
    environment.MOOPS_ENABLE_INJECTIONIII = "1";
  }
  return environment;
}

export function buildXCTestRunInjections(environment, xctestrunPath) {
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  return ENVIRONMENT_PLIST_PREFIXES.flatMap((prefix) => entries.map(([name, value]) => [
    "/usr/bin/plutil",
    "-insert",
    `${prefix}.${name}`,
    "-string",
    value,
    xctestrunPath,
  ]));
}

export function temporaryXCTestRunPath(source, id = randomUUID()) {
  return join(dirname(source), `.moops-benchmark-${id}-${basename(source)}`);
}

export function renderAcceptanceCommand(manifest, variables, xctestrunPath, onlyTesting) {
  const argv = renderArgv(manifest.acceptanceCommand, {
    ...variables,
    XCTESTRUN: xctestrunPath,
  });
  if (onlyTesting === undefined) return argv;
  const indexes = argv.flatMap((argument, index) => (
    argument.startsWith("-only-testing:") ? [index] : []
  ));
  if (indexes.length !== 1 || typeof onlyTesting !== "string" || onlyTesting === "") {
    fail("E_ACCEPTANCE_SELECTOR", "acceptance command must have one replaceable -only-testing selector");
  }
  argv[indexes[0]] = `-only-testing:${onlyTesting}`;
  return argv;
}

async function newestXCTestRun(derivedData) {
  const products = join(derivedData, "Build/Products");
  let names;
  try {
    names = await readdir(products);
  } catch (cause) {
    fail("E_ACCEPTANCE_XCTESTRUN", `cannot inspect ${products}: ${cause.message}`);
  }
  const candidates = names.filter(
    (name) => name.startsWith("FoodDeliveryBenchmark_") && name.endsWith(".xctestrun"),
  );
  if (candidates.length === 0) {
    fail("E_ACCEPTANCE_XCTESTRUN", `no FoodDeliveryBenchmark .xctestrun exists in ${products}`);
  }
  const records = await Promise.all(candidates.map(async (name) => {
    const path = join(products, name);
    return { path, modifiedMs: (await stat(path)).mtimeMs };
  }));
  records.sort((left, right) => right.modifiedMs - left.modifiedMs);
  return records[0].path;
}

export async function prepareAcceptanceRun({ manifest, arm, variables, clocks, onlyTesting }) {
  const source = await newestXCTestRun(arm.derivedData);
  const copy = temporaryXCTestRunPath(source);
  await copyFile(source, copy);
  try {
    const environment = acceptanceEnvironmentForArm(arm, clocks, variables.RUN_ID);
    for (const argv of buildXCTestRunInjections(environment, copy)) {
      const result = await captureCommand(argv, {
        cwd: arm.worktree,
        env: process.env,
        timeoutMs: 10_000,
      });
      if (result.exitCode !== 0) {
        fail("E_ACCEPTANCE_INJECTION", `plutil exited with status ${result.exitCode}`);
      }
    }
    return {
      argv: renderAcceptanceCommand(manifest, variables, copy, onlyTesting),
      xctestrunSource: source,
      xctestrunCopy: copy,
      injectedEnvironment: environment,
      cleanup: () => rm(copy, { force: true }),
    };
  } catch (cause) {
    await rm(copy, { force: true });
    throw cause;
  }
}
