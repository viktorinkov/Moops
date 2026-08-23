import { performance } from "node:perf_hooks";

import { validateCheckpoint } from "./checkpoint.mjs";

const TEMPLATE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export class WorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.details = details;
  }
}

function error(code, message, details) {
  return new WorkflowError(code, message, details);
}

function expandString(value, env) {
  const missing = new Set();
  const expanded = value.replace(TEMPLATE, (_, name) => {
    if (typeof env[name] !== "string" || env[name] === "") {
      missing.add(name);
      return "";
    }
    return env[name];
  });
  if (missing.size > 0) {
    throw error("E_ADAPTER_ENV", `missing environment variable(s): ${[...missing].join(", ")}`);
  }
  return expanded;
}

export function expandArgv(argv, env = process.env) {
  return argv.map((argument) => expandString(argument, env));
}

function selectorMatches(node, selector) {
  return node[selector.by] === selector.value;
}

export function evaluateLandingPredicates(predicates, observation) {
  if (observation === null || typeof observation !== "object" || !Array.isArray(observation.nodes)) {
    throw error("E_UI_PROTOCOL", "inspect response must contain observation.nodes as an array");
  }
  const results = predicates.map((predicate) => {
    const matches = observation.nodes.filter(
      (node) => node !== null && typeof node === "object" && selectorMatches(node, predicate.selector),
    );
    const passed = predicate.kind === "exists"
      ? matches.length > 0
      : matches.some((node) => node[predicate.field] === predicate.expected);
    return {
      kind: predicate.kind,
      selector: predicate.selector,
      passed,
      matchedCount: matches.length,
    };
  });
  return { ok: results.every((entry) => entry.passed), results };
}

function parseUIResponse(result) {
  if (result.exitCode !== 0) {
    throw error("E_ADAPTER_FAILED", `UI adapter exited with status ${result.exitCode}`);
  }
  let response;
  try {
    response = JSON.parse(result.stdout.trim());
  } catch {
    throw error("E_UI_PROTOCOL", "UI adapter stdout must be exactly one JSON value");
  }
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw error("E_UI_PROTOCOL", "UI adapter response must be an object");
  }
  if (response.ok !== true) {
    throw error("E_UI_REJECTED", "UI adapter did not acknowledge the requested operation");
  }
  return response;
}

function failureRecord(cause, phase) {
  return {
    code: cause?.code ?? "E_INTERNAL",
    phase,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

export async function runWorkflow(action, checkpoint, options = {}) {
  const env = options.env ?? process.env;
  const runCommand = options.runCommand;
  if (typeof runCommand !== "function") {
    throw new TypeError("runWorkflow requires a runCommand adapter");
  }
  validateCheckpoint(checkpoint);

  const now = options.now ?? (() => performance.now());
  const started = now();
  const report = {
    reportVersion: 1,
    command: action,
    ok: false,
    checkpoint: {
      name: checkpoint.name,
      fixtureVersion: checkpoint.fixtureVersion,
      fingerprint: checkpoint.fingerprint,
    },
    phases: [],
    timingsMs: {},
  };

  let activePhase = "admission";
  const phase = async (name, operation) => {
    activePhase = name;
    const phaseStarted = now();
    try {
      const value = await operation();
      const elapsedMs = Math.max(0, now() - phaseStarted);
      report.phases.push({ name, ok: true, elapsedMs });
      report.timingsMs[`${name}Ms`] = elapsedMs;
      return value;
    } catch (cause) {
      const elapsedMs = Math.max(0, now() - phaseStarted);
      report.phases.push({ name, ok: false, elapsedMs });
      report.timingsMs[`${name}Ms`] = elapsedMs;
      throw cause;
    }
  };

  const runArgv = async (argv, timeoutMs) => {
    const resolved = expandArgv(argv, env);
    const result = await runCommand(resolved, {
      cwd: options.cwd,
      env,
      timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw error("E_ADAPTER_FAILED", `adapter exited with status ${result.exitCode}`);
    }
    return result;
  };

  const target = () => ({
    bundleId: checkpoint.app.bundleId,
    simulatorUdid: expandString(checkpoint.simulator.udid, env),
  });

  const runUI = async (request) => {
    const argv = [...expandArgv(checkpoint.adapters.ui, env), JSON.stringify(request)];
    const result = await runCommand(argv, {
      cwd: options.cwd,
      env,
      timeoutMs: 120_000,
    });
    return parseUIResponse(result);
  };

  try {
    if (action === "doctor") {
      await phase("doctor", async () => {
        for (const argv of checkpoint.adapters.doctor) {
          await runArgv(argv, 30_000);
        }
      });
    } else if (action === "verify") {
      const inspected = await phase("inspect", () => runUI({
        protocolVersion: 1,
        operation: "inspect",
        target: target(),
      }));
      await phase("landing", async () => {
        const landing = evaluateLandingPredicates(
          checkpoint.landingPredicates,
          inspected.observation,
        );
        report.landing = landing;
        if (!landing.ok) {
          throw error("E_LANDING_FAILED", "fresh observation did not satisfy every landing predicate");
        }
      });
    } else if (action === "build-and-restore") {
      await phase("build", () => runArgv(checkpoint.adapters.build, 900_000));
      await phase("install", () => runArgv(checkpoint.adapters.install, 120_000));
      await phase("launch", () => runArgv(checkpoint.adapters.launch, 120_000));
      await phase("restore", async () => {
        for (const step of checkpoint.trace) {
          await runUI({
            protocolVersion: 1,
            operation: "perform",
            target: target(),
            step,
          });
        }
      });
      const inspected = await phase("inspect", () => runUI({
        protocolVersion: 1,
        operation: "inspect",
        target: target(),
      }));
      await phase("landing", async () => {
        const landing = evaluateLandingPredicates(
          checkpoint.landingPredicates,
          inspected.observation,
        );
        report.landing = landing;
        if (!landing.ok) {
          throw error("E_LANDING_FAILED", "restored state did not satisfy every landing predicate");
        }
      });
    } else {
      throw error("E_BAD_COMMAND", `unsupported workflow command ${JSON.stringify(action)}`);
    }
    report.ok = true;
  } catch (cause) {
    report.error = failureRecord(cause, activePhase);
  }
  report.timingsMs.totalMs = Math.max(0, now() - started);
  return report;
}
