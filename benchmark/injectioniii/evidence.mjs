import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import net from "node:net";
import { basename, isAbsolute, relative, resolve } from "node:path";

export const PINNED_INJECTIONIII_VERSION = "5.2.1";
export const DEFAULT_INJECTIONIII_APP = "/Applications/InjectionIII.app";
export const DEFAULT_CONTROL_SOCKET = "/tmp/InjectionNext-control.sock";

const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
const STRUCTURAL_FALLBACK_REASONS = new Set([
  "added-source-file",
  "stored-property-layout-change",
  "domain-model-layout-change",
]);
const INJECTION_ATTEMPT = /\b(?:compil(?:e|ed|ing|ation)|recompil(?:e|ed|ing|ation)|inject(?:ion|ed|ing)?)\b/i;

export class InjectionEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InjectionEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new InjectionEvidenceError(code, message);
}

function requireAbsolutePath(value, context) {
  if (typeof value !== "string" || value === "" || !isAbsolute(value)) {
    fail("E_INJECTION_ARGUMENT", `${context} must be an absolute path`);
  }
  return resolve(value);
}

function successful(result, context) {
  if (!result || result.exitCode !== 0) {
    const detail = typeof result?.stderr === "string" ? result.stderr.trim() : "";
    fail(
      "E_INJECTION_COMMAND",
      `${context} exited with ${result?.exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}`,
    );
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

function successfulControl(result, action) {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.success !== true) {
    const detail = typeof result?.error === "string" ? `: ${result.error}` : "";
    fail("E_INJECTION_CONTROL", `InjectionIII control action ${action} failed${detail}`);
  }
  return result;
}

function parseOnePid(source) {
  const values = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0])) {
    fail("E_INJECTION_HOST", "exactly one InjectionIII host process must be running");
  }
  const pid = Number(values[0]);
  if (!Number.isSafeInteger(pid)) fail("E_INJECTION_HOST", "InjectionIII host PID is invalid");
  return pid;
}

function normalizeLogs(response, since) {
  const logs = response?.data?.logs;
  if (!Array.isArray(logs)) {
    fail("E_INJECTION_CONTROL", "get_logs did not return a log array");
  }
  return logs.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.message !== "string"
      || typeof entry.timestamp !== "number"
      || !Number.isFinite(entry.timestamp)) {
      fail("E_INJECTION_CONTROL", `get_logs entry ${index} is malformed`);
    }
    return {
      timestamp: entry.timestamp,
      level: typeof entry.level === "string" ? entry.level : "info",
      message: entry.message,
    };
  }).filter(({ timestamp }) => timestamp >= since);
}

function inside(root, target) {
  const fragment = relative(root, target);
  return fragment !== ""
    && fragment !== ".."
    && !fragment.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(fragment);
}

function isNormalXcodeBuild(argv) {
  return Array.isArray(argv)
    && ((basename(argv[0] ?? "") === "xcrun" && argv[1] === "xcodebuild")
      || basename(argv[0] ?? "") === "xcodebuild");
}

async function validateStructuralFallback(fallback, preflight, now, statFile) {
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)
    || fallback.schemaVersion !== 1
    || fallback.kind !== "structural-fallback"
    || !STRUCTURAL_FALLBACK_REASONS.has(fallback.reason)) {
    fail("E_INJECTION_FALLBACK", "structural fallback has an invalid schema or reason");
  }
  if (!Array.isArray(fallback.sourcePaths) || fallback.sourcePaths.length === 0) {
    fail("E_INJECTION_FALLBACK", "structural fallback must name at least one source file");
  }
  const sourcePaths = [...new Set(fallback.sourcePaths.map((path, index) => {
    const source = requireAbsolutePath(path, `fallback sourcePaths[${index}]`);
    if (!inside(preflight.worktree, source)) {
      fail("E_INJECTION_FALLBACK", "fallback source files must stay inside the arm-C worktree");
    }
    return source;
  }))];
  for (const source of sourcePaths) {
    let metadata;
    try {
      metadata = await statFile(source);
    } catch (cause) {
      fail("E_INJECTION_FALLBACK", `cannot stat fallback source ${source}: ${cause.message}`);
    }
    if (!metadata.isFile()) fail("E_INJECTION_FALLBACK", `${source} is not a regular file`);
  }

  const build = fallback.normalBuild;
  if (!build || typeof build !== "object" || Array.isArray(build)
    || !isNormalXcodeBuild(build.argv)
    || build.exitCode !== 0
    || !Number.isSafeInteger(build.completedEpochMs)
    || build.completedEpochMs < preflight.observedEpochMs
    || build.completedEpochMs > now) {
    fail("E_INJECTION_FALLBACK", "structural fallback requires a successful timed xcodebuild");
  }
  if (preflight.derivedData) {
    const derivedIndex = build.argv.indexOf("-derivedDataPath");
    if (derivedIndex < 0
      || resolve(build.argv[derivedIndex + 1] ?? "") !== resolve(preflight.derivedData)) {
      fail("E_INJECTION_FALLBACK", "fallback xcodebuild must use arm C's DerivedData path");
    }
  }
  return {
    kind: "structural-fallback",
    reason: fallback.reason,
    sourcePaths,
    normalBuild: {
      argv: [...build.argv],
      exitCode: build.exitCode,
      completedEpochMs: build.completedEpochMs,
    },
  };
}

export async function captureCommand(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string")) {
    fail("E_INJECTION_ARGUMENT", "command must be a non-empty argv array");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolveCapture) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let spawnError = null;
    let timedOut = false;
    const append = (current, chunk) => {
      const combined = Buffer.concat([current, chunk]);
      return combined.length <= MAX_COMMAND_OUTPUT_BYTES
        ? combined
        : combined.subarray(combined.length - MAX_COMMAND_OUTPUT_BYTES);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (cause) => { spawnError = cause.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveCapture({
        exitCode,
        signal,
        timedOut,
        spawnError,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

export function sendControlCommand(socketPath, payload, options = {}) {
  const target = requireAbsolutePath(socketPath, "control socket");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || typeof payload.action !== "string" || payload.action === "") {
    fail("E_INJECTION_ARGUMENT", "control payload must include an action");
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  const createConnection = options.createConnection ?? ((configuration) => net.createConnection(configuration));
  return new Promise((resolveCommand, rejectCommand) => {
    let settled = false;
    let source = "";
    const socket = createConnection({ path: target });
    const finish = (cause, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (cause) rejectCommand(cause);
      else resolveCommand(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      source += chunk.toString("utf8");
      if (Buffer.byteLength(source) > MAX_CONTROL_RESPONSE_BYTES) {
        finish(new InjectionEvidenceError(
          "E_INJECTION_CONTROL",
          "InjectionIII control response exceeded 1 MiB",
        ));
        return;
      }
      const newline = source.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(source.slice(0, newline));
        if (!response || typeof response !== "object" || Array.isArray(response)) {
          throw new Error("response is not an object");
        }
        finish(null, response);
      } catch (cause) {
        finish(new InjectionEvidenceError(
          "E_INJECTION_CONTROL",
          `InjectionIII control returned invalid JSON: ${cause.message}`,
        ));
      }
    });
    socket.on("timeout", () => finish(new InjectionEvidenceError(
      "E_INJECTION_CONTROL",
      `InjectionIII control timed out after ${timeoutMs}ms`,
    )));
    socket.on("error", (cause) => finish(new InjectionEvidenceError(
      "E_INJECTION_CONTROL",
      `cannot connect to InjectionIII control socket: ${cause.message}`,
    )));
    socket.on("close", () => {
      if (!settled) finish(new InjectionEvidenceError(
        "E_INJECTION_CONTROL",
        "InjectionIII control closed before a JSON response",
      ));
    });
  });
}

export async function collectPreflightEvidence(options, dependencies = {}) {
  const worktree = requireAbsolutePath(options?.worktree, "worktree");
  const derivedData = options?.derivedData === undefined
    ? null
    : requireAbsolutePath(options.derivedData, "DerivedData");
  const injectionAppPath = requireAbsolutePath(
    options?.injectionAppPath ?? DEFAULT_INJECTIONIII_APP,
    "InjectionIII app",
  );
  const controlSocketPath = requireAbsolutePath(
    options?.controlSocketPath ?? DEFAULT_CONTROL_SOCKET,
    "control socket",
  );
  const now = options?.now ?? Date.now;
  const capture = dependencies.captureCommand ?? captureCommand;
  const control = dependencies.controlCommand ?? sendControlCommand;

  const version = successful(await capture([
    "/usr/bin/plutil", "-extract", "CFBundleShortVersionString", "raw",
    `${injectionAppPath}/Contents/Info.plist`,
  ]), "InjectionIII version check").trim();
  if (version !== PINNED_INJECTIONIII_VERSION) {
    fail(
      "E_INJECTION_VERSION",
      `InjectionIII must be ${PINNED_INJECTIONIII_VERSION}, got ${JSON.stringify(version)}`,
    );
  }

  const hostPid = parseOnePid(successful(
    await capture(["/usr/bin/pgrep", "-x", "InjectionIII"]),
    "InjectionIII host lookup",
  ));
  const listener = successful(await capture([
    "/usr/sbin/lsof", "-nP", "-a", "-p", String(hostPid),
    "-iTCP:8898", "-sTCP:LISTEN",
  ]), "InjectionIII listener check");
  if (!/TCP\s+127\.0\.0\.1:8898\s+\(LISTEN\)(?:\r?$)/m.test(listener)) {
    fail("E_INJECTION_LISTENER", "InjectionIII must listen on 127.0.0.1:8898");
  }

  const status = successfulControl(
    await control(controlSocketPath, { action: "status" }),
    "status",
  );
  const watch = successfulControl(
    await control(controlSocketPath, { action: "watch_project", path: worktree }),
    "watch_project",
  );
  successfulControl(
    await control(controlSocketPath, { action: "clear_logs" }),
    "clear_logs",
  );
  const observedEpochMs = now();
  if (!Number.isSafeInteger(observedEpochMs) || observedEpochMs <= 0) {
    fail("E_INJECTION_CLOCK", "preflight clock must return a positive epoch millisecond value");
  }

  return {
    reportVersion: 1,
    phase: "preflight",
    ok: true,
    observedEpochMs,
    worktree,
    derivedData,
    injectionIII: {
      appPath: injectionAppPath,
      version,
    },
    host: {
      pid: hostPid,
      listener: "127.0.0.1:8898",
    },
    control: {
      socketPath: controlSocketPath,
      status: status.data ?? null,
      watchedProject: worktree,
      watchResponse: watch.data ?? null,
      logsCleared: true,
      logSinceEpochSeconds: Math.floor(observedEpochMs / 1_000),
    },
  };
}

export async function collectPostflightEvidence(options, dependencies = {}) {
  const preflight = options?.preflight;
  if (!preflight || preflight.reportVersion !== 1 || preflight.phase !== "preflight"
    || preflight.ok !== true || preflight.injectionIII?.version !== PINNED_INJECTIONIII_VERSION
    || typeof preflight.control?.socketPath !== "string"
    || !Number.isInteger(preflight.control?.logSinceEpochSeconds)) {
    fail("E_INJECTION_PREFLIGHT", "postflight requires a valid pinned preflight receipt");
  }
  const appPid = Number(options.appPid);
  if (!Number.isSafeInteger(appPid) || appPid <= 0) {
    fail("E_INJECTION_ARGUMENT", "app PID must be a positive integer");
  }
  const nowClock = options?.now ?? Date.now;
  const observedEpochMs = nowClock();
  if (!Number.isSafeInteger(observedEpochMs) || observedEpochMs < preflight.observedEpochMs) {
    fail("E_INJECTION_CLOCK", "postflight clock precedes preflight");
  }
  const capture = dependencies.captureCommand ?? captureCommand;
  const control = dependencies.controlCommand ?? sendControlCommand;
  const statFile = dependencies.statFile ?? stat;

  const connection = successful(await capture([
    "/usr/sbin/lsof", "-nP", "-a", "-p", String(appPid),
    "-iTCP@127.0.0.1:8898", "-sTCP:ESTABLISHED",
  ]), "arm-C InjectionIII connection check");
  if (!/->127\.0\.0\.1:8898\s+\(ESTABLISHED\)(?:\r?$)/m.test(connection)) {
    fail("E_INJECTION_CONNECTION", "arm-C app is not connected to InjectionIII on port 8898");
  }
  const modules = successful(
    await capture(["/usr/sbin/lsof", "-nP", "-p", String(appPid)]),
    "arm-C loaded-module check",
  );
  const loadedModules = [];
  if (modules.includes("/iOSInjection.bundle/iOSInjection")) loadedModules.push("iOSInjection");
  if (modules.includes("/SwiftTrace.framework/")) loadedModules.push("SwiftTrace");
  if (loadedModules.length !== 2) {
    fail("E_INJECTION_MODULES", "arm-C app must load both iOSInjection and SwiftTrace");
  }

  const logsResponse = successfulControl(await control(preflight.control.socketPath, {
    action: "get_logs",
    since: preflight.control.logSinceEpochSeconds,
    limit: 500,
  }), "get_logs");
  const lastError = successfulControl(
    await control(preflight.control.socketPath, { action: "get_last_error" }),
    "get_last_error",
  );
  const logs = normalizeLogs(logsResponse, preflight.control.logSinceEpochSeconds);
  const attemptLogs = logs.filter(({ message }) => INJECTION_ATTEMPT.test(message));
  const proof = attemptLogs.length > 0
    ? { kind: "injection-attempt", logs: attemptLogs }
    : options.fallbackEvidence
      ? await validateStructuralFallback(
        options.fallbackEvidence,
        preflight,
        observedEpochMs,
        statFile,
      )
      : null;
  if (!proof) {
    fail(
      "E_INJECTION_PROOF",
      "postflight found neither an InjectionIII compile/injection attempt nor structural fallback",
    );
  }

  return {
    reportVersion: 1,
    phase: "postflight",
    ok: true,
    observedEpochMs,
    preflightSHA256: `sha256:${createHash("sha256")
      .update(JSON.stringify(preflight)).digest("hex")}`,
    app: {
      pid: appPid,
      connection: "127.0.0.1:8898",
      loadedModules,
    },
    control: {
      socketPath: preflight.control.socketPath,
      logsSinceEpochSeconds: preflight.control.logSinceEpochSeconds,
      logCount: logs.length,
      lastError,
    },
    proof,
  };
}
