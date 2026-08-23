import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateCheckpoint } from "../../tools/moops/src/checkpoint.mjs";

export const PINNED_CLAUDE_MEM_VERSION = "13.15.3";
export const PINNED_CLAUDE_MEM_COMMIT = "e2d1df569a8f04075d40e92461128ece7cf04c82";

const CHECKPOINT_NAMES = ["catalog-ready", "cart-ready", "checkout-ready"];
const EXECUTABLE_PATHS = new Map([
  ["catalog-ready", "benchmark/checkpoints/food-delivery-catalog-ready.json"],
  ["cart-ready", "benchmark/checkpoints/food-delivery-cart-ready.json"],
  ["checkout-ready", "benchmark/checkpoints/food-delivery-cart.json"],
]);
const CHECKPOINT_KEYS = [
  "executableCheckpoint",
  "kind",
  "name",
  "publicLandingIds",
  "searchTerms",
  "summary",
];

function requireObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
}

function requireExactKeys(value, expected, context) {
  requireObject(value, context);
  const actual = Object.keys(value);
  const unexpected = actual.filter((key) => !expected.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${context} has unexpected key ${unexpected[0]}`);
  }
  const missing = expected.filter((key) => !actual.includes(key));
  if (missing.length > 0) {
    throw new Error(`${context} is missing key ${missing[0]}`);
  }
}

function requireString(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function requireUniqueStrings(value, context) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array`);
  }
  value.forEach((entry, index) => requireString(entry, `${context}[${index}]`));
  if (new Set(value).size !== value.length) {
    throw new Error(`${context} must not contain duplicates`);
  }
}

export function validateRegistry(registry) {
  requireExactKeys(
    registry,
    ["schemaVersion", "project", "xcodeScheme", "claudeMem", "checkpoints"],
    "registry",
  );
  if (registry.schemaVersion !== 1) throw new Error("registry.schemaVersion must be 1");
  if (registry.project !== "moops-food-delivery") {
    throw new Error("registry.project must be moops-food-delivery");
  }
  if (registry.xcodeScheme !== "FoodDeliveryBenchmark") {
    throw new Error("registry.xcodeScheme must be FoodDeliveryBenchmark");
  }

  requireExactKeys(
    registry.claudeMem,
    [
      "version",
      "sourceRepository",
      "sourceCommit",
      "provider",
      "workerPort",
      "storage",
      "telemetry",
      "cloudSync",
    ],
    "registry.claudeMem",
  );
  if (registry.claudeMem.version !== PINNED_CLAUDE_MEM_VERSION) {
    throw new Error(`Claude-Mem must be pinned to ${PINNED_CLAUDE_MEM_VERSION}`);
  }
  if (registry.claudeMem.sourceCommit !== PINNED_CLAUDE_MEM_COMMIT) {
    throw new Error(`Claude-Mem source must be pinned to ${PINNED_CLAUDE_MEM_COMMIT}`);
  }
  if (registry.claudeMem.sourceRepository !== "https://github.com/thedotmack/claude-mem") {
    throw new Error("Claude-Mem source repository must be the official repository");
  }
  if (
    registry.claudeMem.provider !== "claude-subscription" ||
    registry.claudeMem.workerPort !== 37977
  ) {
    throw new Error("Claude-Mem benchmark provider and worker port do not match arm D");
  }
  if (
    registry.claudeMem.storage !== "local-sqlite" ||
    registry.claudeMem.telemetry !== "disabled" ||
    registry.claudeMem.cloudSync !== "disabled"
  ) {
    throw new Error("Claude-Mem benchmark policy must keep storage local with telemetry and cloud sync disabled");
  }

  if (!Array.isArray(registry.checkpoints)) {
    throw new Error("registry.checkpoints must be an array");
  }
  const names = registry.checkpoints.map((entry) => entry?.name);
  if (JSON.stringify(names) !== JSON.stringify(CHECKPOINT_NAMES)) {
    throw new Error(`registry.checkpoints must be ordered as ${CHECKPOINT_NAMES.join(", ")}`);
  }

  registry.checkpoints.forEach((entry, index) => {
    const context = `registry.checkpoints[${index}]`;
    requireExactKeys(entry, CHECKPOINT_KEYS, context);
    requireString(entry.summary, `${context}.summary`);
    requireUniqueStrings(entry.searchTerms, `${context}.searchTerms`);
    requireUniqueStrings(entry.publicLandingIds, `${context}.publicLandingIds`);
    if (!entry.searchTerms.includes(entry.name)) {
      throw new Error(`${context}.searchTerms must include ${entry.name}`);
    }

    if (entry.kind !== "executable-checkpoint") {
      throw new Error(`${entry.name} must be an executable-checkpoint`);
    }
    requireExactKeys(
      entry.executableCheckpoint,
      ["path", "fingerprint"],
      `${entry.name} executableCheckpoint`,
    );
    if (entry.executableCheckpoint.path !== EXECUTABLE_PATHS.get(entry.name)) {
      throw new Error(`${entry.name} must reference its supported FoodDelivery checkpoint`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(entry.executableCheckpoint.fingerprint)) {
      throw new Error(`${entry.name} fingerprint must be a lowercase SHA-256 digest`);
    }
  });

  return registry;
}

function resolveInsideRoot(repositoryRoot, relativePath) {
  const root = resolve(repositoryRoot);
  const target = resolve(root, relativePath);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === "" || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "..") {
    throw new Error("executable checkpoint path must stay inside the repository");
  }
  return target;
}

export async function loadAndValidateRegistry(registryPath, repositoryRoot) {
  const registry = validateRegistry(JSON.parse(await readFile(registryPath, "utf8")));
  for (const descriptor of registry.checkpoints) {
    const executablePath = resolveInsideRoot(
      repositoryRoot,
      descriptor.executableCheckpoint.path,
    );
    const executable = JSON.parse(await readFile(executablePath, "utf8"));
    validateCheckpoint(executable);

    if (descriptor.executableCheckpoint.fingerprint !== executable.fingerprint) {
      throw new Error(
        `${descriptor.name} descriptor fingerprint does not match its executable checkpoint`,
      );
    }

    const executableLandingIds = new Set(
      executable.landingPredicates
        .map((predicate) => predicate.selector)
        .filter((selector) => selector.by === "id")
        .map((selector) => selector.value),
    );
    for (const publicId of descriptor.publicLandingIds) {
      if (!executableLandingIds.has(publicId)) {
        throw new Error(
          `${descriptor.name} public ID ${publicId} is not an executable landing predicate`,
        );
      }
    }
  }
  return registry;
}

function renderMemoryPacket(entry) {
  return [
    `MOOPS_MEMORY_CHECKPOINT ${entry.name}`,
    `Kind: ${entry.kind}`,
    `Summary: ${entry.summary}`,
    `Public landing IDs: ${entry.publicLandingIds.join(", ")}`,
    `Search terms: ${entry.searchTerms.join(" | ")}`,
    `Executable restore: ${entry.executableCheckpoint.path}`,
    `MOOPS fingerprint: ${entry.executableCheckpoint.fingerprint}`,
  ].join("\n");
}

export function renderMemoryPackets(registry) {
  validateRegistry(registry);
  const rendered = registry.checkpoints.map((entry) => {
    return renderMemoryPacket(entry);
  });
  return [
    "MOOPS checkpoint files remain executable truth; Claude-Mem is only a searchable index.",
    ...rendered,
    "",
  ].join("\n\n");
}

async function main() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(moduleDirectory, "../..");
  const registryPath = resolve(moduleDirectory, "checkpoints.json");
  const registry = await loadAndValidateRegistry(registryPath, repositoryRoot);
  const [command, name] = process.argv.slice(2);

  if (command === "--packets") {
    process.stdout.write(renderMemoryPackets(registry));
    return;
  }
  if (command === "--packet") {
    const entry = registry.checkpoints.find((checkpoint) => checkpoint.name === name);
    if (!entry) throw new Error(`unknown memory checkpoint ${JSON.stringify(name)}`);
    process.stdout.write(
      `MOOPS checkpoint files remain executable truth; Claude-Mem is only a searchable index.\n\n${renderMemoryPacket(entry)}\n`,
    );
    return;
  }
  if (command !== undefined) {
    throw new Error(
      "usage: node benchmark/claude-mem/registry.mjs [--packets | --packet NAME]",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, checkpointCount: registry.checkpoints.length, executableCount: 3 })}\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
