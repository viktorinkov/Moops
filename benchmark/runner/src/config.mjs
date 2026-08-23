import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export const ARM_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "codex-uitest", label: "CODEX + UITEST" }),
  Object.freeze({ id: "codex-previews", label: "CODEX + PREVIEWS" }),
  Object.freeze({ id: "codex-injection", label: "CODEX + INJECTION" }),
  Object.freeze({ id: "codex-moops-claudemem", label: "CODEX + MOOPS + CLAUDEMEM" }),
]);

const TOP_LEVEL_KEYS = [
  "acceptanceCommand",
  "agentCommand",
  "appBundleId",
  "arms",
  "backendCommand",
  "backendFixtureRevision",
  "baselineCommit",
  "deadlineSeconds",
  "model",
  "promptPath",
  "repositoryRoot",
  "runRoot",
  "schemaVersion",
  "serviceTier",
  "showcase",
  "versionCommands",
];
const ARM_KEYS = [
  "derivedData",
  "backendPort",
  "environment",
  "id",
  "label",
  "results",
  "simulatorUdid",
  "worktree",
];
const MAX_MANIFEST_BYTES = 262_144;
const MAX_ARGV = 128;
const MAX_ARGUMENT_BYTES = 16_384;
const TEMPLATE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export class ManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ManifestError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value, expected, code, context) {
  if (!isObject(value)) fail(code, `${context} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function nonEmptyString(value, code, context) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${context} must be a non-empty string`);
  }
  if (Buffer.byteLength(value) > MAX_ARGUMENT_BYTES) {
    fail(code, `${context} exceeds ${MAX_ARGUMENT_BYTES} bytes`);
  }
  return value;
}

function validateArgv(argv, context) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV) {
    fail("E_MANIFEST_COMMAND", `${context} must contain 1 through ${MAX_ARGV} argv values`);
  }
  argv.forEach((argument, index) => {
    nonEmptyString(argument, "E_MANIFEST_COMMAND", `${context}[${index}]`);
  });
  return [...argv];
}

function resolveConfiguredPath(value, manifestDirectory, context) {
  nonEmptyString(value, "E_MANIFEST_PATH", context);
  return resolve(manifestDirectory, value);
}

function isStrictDescendant(root, target) {
  const fragment = relative(root, target);
  return fragment !== "" && fragment !== ".." && !fragment.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(fragment);
}

function assertUnique(values, context) {
  if (new Set(values).size !== values.length) {
    fail("E_MANIFEST_ISOLATION", `${context} must be unique for every arm`);
  }
}

function validateEnvironment(environment, context) {
  if (!isObject(environment)) {
    fail("E_MANIFEST_ENV", `${context} must be an object`);
  }
  const output = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      fail("E_MANIFEST_ENV", `${context}.${name} is not an environment variable name`);
    }
    if (name.startsWith("MOOPS_BENCHMARK_") || name.startsWith("SIMCTL_CHILD_MOOPS_BENCHMARK_")) {
      fail("E_MANIFEST_ENV", `${context}.${name} is reserved by the runner`);
    }
    output[name] = nonEmptyString(value, "E_MANIFEST_ENV", `${context}.${name}`);
  }
  return output;
}

function validateShowcase(showcase) {
  requireExactKeys(
    showcase,
    ["desktopRegion", "recordingSeconds"],
    "E_MANIFEST_SHOWCASE",
    "showcase",
  );
  requireExactKeys(
    showcase.desktopRegion,
    ["height", "width", "x", "y"],
    "E_MANIFEST_SHOWCASE",
    "showcase.desktopRegion",
  );
  const { x, y, width, height } = showcase.desktopRegion;
  if (![x, y, width, height].every(Number.isInteger) || width < 320 || height < 320) {
    fail("E_MANIFEST_SHOWCASE", "showcase desktop region must use integer coordinates and a usable size");
  }
  if (!Number.isInteger(showcase.recordingSeconds)
    || showcase.recordingSeconds < 5
    || showcase.recordingSeconds > 10_800) {
    fail("E_MANIFEST_SHOWCASE", "showcase.recordingSeconds must be 5 through 10800");
  }
  return {
    desktopRegion: { x, y, width, height },
    recordingSeconds: showcase.recordingSeconds,
  };
}

export function renderArgv(argv, variables) {
  return argv.map((argument) => argument.replace(TEMPLATE, (_, name) => {
    if (typeof variables[name] !== "string") {
      fail("E_TEMPLATE", `missing template variable ${name}`);
    }
    return variables[name];
  }));
}

export function normalizeManifest(raw, options = {}) {
  requireExactKeys(raw, TOP_LEVEL_KEYS, "E_MANIFEST_FORMAT", "manifest");
  if (raw.schemaVersion !== 1) {
    fail("E_MANIFEST_VERSION", `unsupported manifest schema ${JSON.stringify(raw.schemaVersion)}`);
  }
  if (raw.model !== "gpt-5.6-sol"
    || raw.serviceTier !== "fast"
    || raw.deadlineSeconds !== 10_800) {
    fail(
      "E_MANIFEST_FAIRNESS",
      "model, serviceTier, and deadlineSeconds must be gpt-5.6-sol, fast, and 10800",
    );
  }

  const manifestPath = resolve(options.manifestPath ?? "benchmark-manifest.json");
  const manifestDirectory = dirname(manifestPath);
  const runRoot = resolveConfiguredPath(raw.runRoot, manifestDirectory, "runRoot");
  const repositoryRoot = resolveConfiguredPath(
    raw.repositoryRoot,
    manifestDirectory,
    "repositoryRoot",
  );
  const promptPath = resolveConfiguredPath(raw.promptPath, manifestDirectory, "promptPath");
  if (runRoot === resolve("/")) fail("E_MANIFEST_PATH", "runRoot cannot be the filesystem root");

  const agentCommand = validateArgv(raw.agentCommand, "agentCommand");
  if (basename(agentCommand[0]) === "codex" && agentCommand[1] === "exec") {
    fail(
      "E_MANIFEST_GOAL",
      "codex exec is rehearsal-only; measured runs require the app-server Goal protocol",
    );
  }
  const acceptanceCommand = validateArgv(raw.acceptanceCommand, "acceptanceCommand");
  const acceptanceTemplate = acceptanceCommand.join("\u0000");
  for (const required of ["${SIMULATOR_UDID}", "${XCTESTRUN}"]) {
    if (!acceptanceTemplate.includes(required)) {
      fail("E_MANIFEST_FAIRNESS", `acceptanceCommand must consume ${required}`);
    }
  }
  const backendCommand = validateArgv(raw.backendCommand, "backendCommand");
  const backendTemplate = backendCommand.join("\u0000");
  for (const required of ["${BACKEND_PORT}", "${WORKTREE}"]) {
    if (!backendTemplate.includes(required)) {
      fail("E_MANIFEST_FAIRNESS", `backendCommand must consume ${required}`);
    }
  }
  const backendFixtureRevision = nonEmptyString(
    raw.backendFixtureRevision,
    "E_MANIFEST_FAIRNESS",
    "backendFixtureRevision",
  );

  if (!Array.isArray(raw.versionCommands) || raw.versionCommands.length < 1 || raw.versionCommands.length > 8) {
    fail("E_MANIFEST_COMMAND", "versionCommands must contain 1 through 8 commands");
  }
  const versionCommands = raw.versionCommands.map((entry, index) => {
    requireExactKeys(entry, ["argv", "name"], "E_MANIFEST_COMMAND", `versionCommands[${index}]`);
    return {
      name: nonEmptyString(entry.name, "E_MANIFEST_COMMAND", `versionCommands[${index}].name`),
      argv: validateArgv(entry.argv, `versionCommands[${index}].argv`),
    };
  });
  assertUnique(versionCommands.map(({ name }) => name), "version command names");

  if (!Array.isArray(raw.arms) || raw.arms.length !== ARM_DEFINITIONS.length) {
    fail("E_MANIFEST_ARMS", "manifest must contain exactly four arms");
  }
  const arms = raw.arms.map((arm, index) => {
    requireExactKeys(arm, ARM_KEYS, "E_MANIFEST_ARMS", `arms[${index}]`);
    const expected = ARM_DEFINITIONS[index];
    if (arm.id !== expected.id || arm.label !== expected.label) {
      fail(
        "E_MANIFEST_ARMS",
        `arms[${index}] must be ${expected.id} / ${expected.label}`,
      );
    }
    const normalized = {
      id: arm.id,
      label: arm.label,
      worktree: resolveConfiguredPath(arm.worktree, manifestDirectory, `arms[${index}].worktree`),
      simulatorUdid: nonEmptyString(
        arm.simulatorUdid,
        "E_MANIFEST_ISOLATION",
        `arms[${index}].simulatorUdid`,
      ),
      derivedData: resolveConfiguredPath(
        arm.derivedData,
        manifestDirectory,
        `arms[${index}].derivedData`,
      ),
      results: resolveConfiguredPath(arm.results, manifestDirectory, `arms[${index}].results`),
      environment: validateEnvironment(arm.environment, `arms[${index}].environment`),
      backendPort: arm.backendPort,
    };
    if (!Number.isInteger(normalized.backendPort)
      || normalized.backendPort < 1024
      || normalized.backendPort > 65_535) {
      fail("E_MANIFEST_ISOLATION", `${normalized.id}.backendPort must be 1024 through 65535`);
    }
    for (const field of ["worktree", "derivedData", "results"]) {
      if (!isStrictDescendant(runRoot, normalized[field])) {
        fail("E_MANIFEST_PATH", `${normalized.id}.${field} must be inside runRoot`);
      }
    }
    return normalized;
  });

  assertUnique(arms.map(({ worktree }) => worktree), "worktree paths");
  assertUnique(arms.map(({ simulatorUdid }) => simulatorUdid), "simulator UDIDs");
  assertUnique(arms.map(({ derivedData }) => derivedData), "DerivedData paths");
  assertUnique(arms.map(({ results }) => results), "results paths");
  assertUnique(arms.map(({ backendPort }) => backendPort), "backend ports");
  for (const arm of arms) {
    if (!/^[1-9][0-9]*$/.test(arm.environment.MCP_XCODE_PID ?? "")
      || !Number.isSafeInteger(Number(arm.environment.MCP_XCODE_PID))) {
      fail(
        "E_MANIFEST_XCODE_BINDING",
        `${arm.id}.environment.MCP_XCODE_PID must be a positive numeric Xcode process ID`,
      );
    }
  }
  assertUnique(
    arms.map(({ environment }) => environment.MCP_XCODE_PID),
    "MCP_XCODE_PID values",
  );
  const everyGeneratedPath = arms.flatMap(({ worktree, derivedData, results }) => [
    worktree,
    derivedData,
    results,
  ]);
  assertUnique(everyGeneratedPath, "all generated resource paths");
  for (const arm of arms) {
    for (const other of arms) {
      if (isStrictDescendant(other.worktree, arm.derivedData)
        || isStrictDescendant(other.worktree, arm.results)) {
        fail("E_MANIFEST_ISOLATION", "DerivedData and results must live outside every worktree");
      }
    }
  }
  for (const arm of arms) {
    const injectionEnabled = arm.environment.MOOPS_ENABLE_INJECTIONIII === "1";
    if ((arm.id === "codex-injection") !== injectionEnabled) {
      fail(
        "E_MANIFEST_FAIRNESS",
        "MOOPS_ENABLE_INJECTIONIII=1 must be present only on codex-injection",
      );
    }
  }

  return {
    schemaVersion: 1,
    manifestPath,
    runRoot,
    repositoryRoot,
    baselineCommit: nonEmptyString(raw.baselineCommit, "E_MANIFEST_FAIRNESS", "baselineCommit"),
    promptPath,
    model: raw.model,
    serviceTier: raw.serviceTier,
    deadlineSeconds: raw.deadlineSeconds,
    agentCommand,
    backendCommand,
    backendFixtureRevision,
    versionCommands,
    acceptanceCommand,
    appBundleId: nonEmptyString(raw.appBundleId, "E_MANIFEST_FORMAT", "appBundleId"),
    arms,
    showcase: validateShowcase(raw.showcase),
  };
}

export async function loadManifest(path) {
  const manifestPath = resolve(path);
  let metadata;
  try {
    metadata = await stat(manifestPath);
  } catch (cause) {
    fail("E_MANIFEST_READ", `cannot stat manifest: ${cause.message}`);
  }
  if (!metadata.isFile()) fail("E_MANIFEST_READ", "manifest is not a regular file");
  if (metadata.size > MAX_MANIFEST_BYTES) {
    fail("E_MANIFEST_SIZE", `manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  let raw;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    fail("E_MANIFEST_JSON", `manifest is not valid JSON: ${cause.message}`);
  }
  return normalizeManifest(raw, { manifestPath });
}
