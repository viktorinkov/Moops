import { createHash } from "node:crypto";

export const CHECKPOINT_SCHEMA_VERSION = 1;

const PUBLIC_SELECTOR_CHANNELS = new Set(["id", "label", "text", "value"]);
const ADAPTER_NAMES = ["doctor", "build", "install", "launch", "ui"];
const MAX_TRACE_STEPS = 32;
const MAX_LANDING_PREDICATES = 32;
const MAX_DOCTOR_COMMANDS = 8;
const MAX_ARGV_LENGTH = 128;
const MAX_ARGUMENT_BYTES = 16_384;

export class CheckpointError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CheckpointError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value, expected, code, context) {
  if (!isObject(value)) {
    fail(code, `${context} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function requireNonEmptyString(value, code, context) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${context} must be a non-empty string`);
  }
}

function validateSelector(selector, code, context) {
  requireExactKeys(selector, ["by", "value"], code, context);
  if (!PUBLIC_SELECTOR_CHANNELS.has(selector.by)) {
    fail(code, `${context}.by must be id, label, text, or value`);
  }
  requireNonEmptyString(selector.value, code, `${context}.value`);
}

function validateArgv(argv, code, context) {
  if (!Array.isArray(argv) || argv.length === 0) {
    fail(code, `${context} must be a non-empty argv array`);
  }
  if (argv.length > MAX_ARGV_LENGTH) {
    fail(code, `${context} must contain at most ${MAX_ARGV_LENGTH} arguments`);
  }
  argv.forEach((argument, index) => {
    requireNonEmptyString(argument, code, `${context}[${index}]`);
    if (Buffer.byteLength(argument) > MAX_ARGUMENT_BYTES) {
      fail(code, `${context}[${index}] exceeds ${MAX_ARGUMENT_BYTES} bytes`);
    }
  });
}

function validateAdapters(adapters) {
  requireExactKeys(adapters, ADAPTER_NAMES, "E_CHECKPOINT_ADAPTER", "adapters");
  if (!Array.isArray(adapters.doctor) || adapters.doctor.length === 0) {
    fail("E_CHECKPOINT_ADAPTER", "adapters.doctor must contain at least one argv array");
  }
  if (adapters.doctor.length > MAX_DOCTOR_COMMANDS) {
    fail(
      "E_CHECKPOINT_ADAPTER",
      `adapters.doctor must contain at most ${MAX_DOCTOR_COMMANDS} commands`,
    );
  }
  adapters.doctor.forEach((argv, index) => {
    validateArgv(argv, "E_CHECKPOINT_ADAPTER", `adapters.doctor[${index}]`);
  });
  for (const name of ADAPTER_NAMES.filter((value) => value !== "doctor")) {
    validateArgv(adapters[name], "E_CHECKPOINT_ADAPTER", `adapters.${name}`);
  }
}

function validateTrace(trace) {
  if (!Array.isArray(trace) || trace.length === 0) {
    fail("E_CHECKPOINT_TRACE", "trace must contain at least one public UI step");
  }
  if (trace.length > MAX_TRACE_STEPS) {
    fail("E_CHECKPOINT_TRACE", `trace must contain at most ${MAX_TRACE_STEPS} public UI steps`);
  }
  trace.forEach((step, index) => {
    const context = `trace[${index}]`;
    if (!isObject(step)) {
      fail("E_CHECKPOINT_TRACE", `${context} must be an object`);
    }
    if (step.op === "tap") {
      requireExactKeys(step, ["op", "selector"], "E_CHECKPOINT_TRACE", context);
      validateSelector(step.selector, "E_CHECKPOINT_TRACE", `${context}.selector`);
      return;
    }
    if (step.op === "wait") {
      requireExactKeys(step, ["op", "selector", "timeoutMs"], "E_CHECKPOINT_TRACE", context);
      validateSelector(step.selector, "E_CHECKPOINT_TRACE", `${context}.selector`);
      if (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 60_000) {
        fail("E_CHECKPOINT_TRACE", `${context}.timeoutMs must be an integer from 1 through 60000`);
      }
      return;
    }
    fail("E_CHECKPOINT_TRACE", `${context}.op must be wait or tap`);
  });
}

function validateLandingPredicates(predicates) {
  if (!Array.isArray(predicates) || predicates.length === 0) {
    fail("E_CHECKPOINT_LANDING", "landingPredicates must not be empty");
  }
  if (predicates.length > MAX_LANDING_PREDICATES) {
    fail(
      "E_CHECKPOINT_LANDING",
      `landingPredicates must contain at most ${MAX_LANDING_PREDICATES} entries`,
    );
  }
  predicates.forEach((predicate, index) => {
    const context = `landingPredicates[${index}]`;
    if (!isObject(predicate)) {
      fail("E_CHECKPOINT_LANDING", `${context} must be an object`);
    }
    if (predicate.kind === "exists") {
      requireExactKeys(predicate, ["kind", "selector"], "E_CHECKPOINT_LANDING", context);
      validateSelector(predicate.selector, "E_CHECKPOINT_LANDING", `${context}.selector`);
      return;
    }
    if (predicate.kind === "equals") {
      requireExactKeys(
        predicate,
        ["expected", "field", "kind", "selector"],
        "E_CHECKPOINT_LANDING",
        context,
      );
      validateSelector(predicate.selector, "E_CHECKPOINT_LANDING", `${context}.selector`);
      if (!["id", "label", "text", "value", "enabled"].includes(predicate.field)) {
        fail("E_CHECKPOINT_LANDING", `${context}.field is not a public node field`);
      }
      if (!["string", "number", "boolean"].includes(typeof predicate.expected)) {
        fail("E_CHECKPOINT_LANDING", `${context}.expected must be a scalar`);
      }
      return;
    }
    fail("E_CHECKPOINT_LANDING", `${context}.kind must be exists or equals`);
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function fingerprintCheckpoint(checkpoint) {
  if (!isObject(checkpoint)) {
    fail("E_CHECKPOINT_FORMAT", "checkpoint must be an object");
  }
  const payload = { ...checkpoint };
  delete payload.fingerprint;
  const canonicalJSON = JSON.stringify(canonicalize(payload));
  return `sha256:${createHash("sha256").update(canonicalJSON).digest("hex")}`;
}

export function validateCheckpoint(checkpoint) {
  requireExactKeys(
    checkpoint,
    [
      "adapters",
      "app",
      "fingerprint",
      "fixtureVersion",
      "landingPredicates",
      "name",
      "schemaVersion",
      "simulator",
      "trace",
    ],
    "E_CHECKPOINT_FORMAT",
    "checkpoint",
  );
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    fail(
      "E_CHECKPOINT_VERSION",
      `unsupported checkpoint schema version ${JSON.stringify(checkpoint.schemaVersion)}`,
    );
  }
  requireNonEmptyString(checkpoint.fixtureVersion, "E_CHECKPOINT_FORMAT", "fixtureVersion");
  requireNonEmptyString(checkpoint.name, "E_CHECKPOINT_FORMAT", "name");
  requireExactKeys(checkpoint.app, ["bundleId"], "E_CHECKPOINT_FORMAT", "app");
  requireNonEmptyString(checkpoint.app.bundleId, "E_CHECKPOINT_FORMAT", "app.bundleId");
  requireExactKeys(checkpoint.simulator, ["udid"], "E_CHECKPOINT_FORMAT", "simulator");
  requireNonEmptyString(checkpoint.simulator.udid, "E_CHECKPOINT_FORMAT", "simulator.udid");
  validateAdapters(checkpoint.adapters);
  validateTrace(checkpoint.trace);
  validateLandingPredicates(checkpoint.landingPredicates);

  if (!/^sha256:[a-f0-9]{64}$/.test(checkpoint.fingerprint)) {
    fail("E_CHECKPOINT_FINGERPRINT", "fingerprint must be a lowercase sha256 digest");
  }
  const expected = fingerprintCheckpoint(checkpoint);
  if (checkpoint.fingerprint !== expected) {
    fail("E_CHECKPOINT_FINGERPRINT", "checkpoint fingerprint does not match its payload");
  }
  return checkpoint;
}
