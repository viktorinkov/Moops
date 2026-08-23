import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { captureCommand } from "./process.mjs";

export class PreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreflightError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PreflightError(code, message);
}

async function requireDirectory(path, context) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (cause) {
    fail("E_PREFLIGHT_PATH", `${context} is unavailable: ${cause.message}`);
  }
  if (!metadata.isDirectory()) fail("E_PREFLIGHT_PATH", `${context} must be a directory`);
}

async function successful(argv, options = {}) {
  const result = await captureCommand(argv, options);
  if (result.exitCode !== 0) {
    fail(
      "E_PREFLIGHT_COMMAND",
      `${argv[0]} exited with status ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function simulatorIndex(raw) {
  const index = new Map();
  for (const devices of Object.values(raw.devices ?? {})) {
    for (const device of devices) index.set(device.udid, device);
  }
  return index;
}

export async function preflightBenchmark(manifest) {
  await Promise.all([
    requireDirectory(manifest.runRoot, "runRoot"),
    requireDirectory(manifest.repositoryRoot, "repositoryRoot"),
    ...manifest.arms.flatMap((arm) => [
      requireDirectory(arm.worktree, `${arm.id} worktree`),
      requireDirectory(arm.derivedData, `${arm.id} DerivedData`),
      requireDirectory(arm.results, `${arm.id} results`),
    ]),
  ]);

  let prompt;
  try {
    prompt = await readFile(manifest.promptPath, "utf8");
  } catch (cause) {
    fail("E_PREFLIGHT_PROMPT", `cannot read prompt: ${cause.message}`);
  }
  if (prompt.length === 0) fail("E_PREFLIGHT_PROMPT", "prompt cannot be empty");
  const promptSHA256 = `sha256:${createHash("sha256").update(prompt).digest("hex")}`;

  const baselineResolved = await successful(
    ["/usr/bin/git", "-C", manifest.repositoryRoot, "rev-parse", manifest.baselineCommit],
    { timeoutMs: 30_000 },
  );
  const versions = {};
  for (const command of manifest.versionCommands) {
    versions[command.name] = await successful(command.argv, {
      cwd: manifest.repositoryRoot,
      timeoutMs: 30_000,
    });
  }

  const armRecords = {};
  for (const arm of manifest.arms) {
    const commit = await successful(
      ["/usr/bin/git", "-C", arm.worktree, "rev-parse", "HEAD"],
      { timeoutMs: 30_000 },
    );
    if (commit !== baselineResolved) {
      fail("E_PREFLIGHT_BASELINE", `${arm.id} is at ${commit}, expected ${baselineResolved}`);
    }
    const dirty = await successful(
      ["/usr/bin/git", "-C", arm.worktree, "status", "--porcelain=v1", "--untracked-files=all"],
      { timeoutMs: 30_000 },
    );
    if (dirty !== "") fail("E_PREFLIGHT_DIRTY", `${arm.id} worktree is not clean`);
    armRecords[arm.id] = { commit };
  }

  const simulatorJSON = await successful(
    ["/usr/bin/xcrun", "simctl", "list", "devices", "--json"],
    { timeoutMs: 30_000 },
  );
  let simulators;
  try {
    simulators = simulatorIndex(JSON.parse(simulatorJSON));
  } catch {
    fail("E_PREFLIGHT_SIMULATOR", "simctl returned malformed device JSON");
  }
  for (const arm of manifest.arms) {
    const simulator = simulators.get(arm.simulatorUdid);
    if (!simulator) fail("E_PREFLIGHT_SIMULATOR", `${arm.id} simulator does not exist`);
    if (simulator.state !== "Booted") {
      fail("E_PREFLIGHT_SIMULATOR", `${arm.id} simulator must be Booted before the start barrier`);
    }
    armRecords[arm.id].simulatorName = simulator.name;
    armRecords[arm.id].simulatorState = simulator.state;
  }

  return {
    baselineResolved,
    prompt,
    promptSHA256,
    versions,
    arms: armRecords,
  };
}
