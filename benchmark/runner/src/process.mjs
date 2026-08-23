import { spawn } from "node:child_process";
import { open } from "node:fs/promises";

const MAX_CAPTURE_BYTES = 1_048_576;

export class ProcessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProcessError";
    this.code = code;
  }
}

function killProcessGroup(child, signal) {
  if (!Number.isInteger(child.pid) || child.pid < 1) return;
  try {
    process.kill(-child.pid, signal);
  } catch (cause) {
    if (cause.code !== "ESRCH") throw cause;
  }
}

export function captureCommand(argv, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_CAPTURE_BYTES) {
        finishError(new ProcessError("E_COMMAND_OUTPUT", "command output exceeded 1 MiB"));
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (cause) => {
      finishError(new ProcessError("E_COMMAND_SPAWN", cause.message));
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr });
    });
    timer = setTimeout(() => {
      finishError(new ProcessError("E_COMMAND_TIMEOUT", "command timed out"));
    }, options.timeoutMs ?? 30_000);
    timer.unref();
  });
}

export async function runLoggedProcess(argv, options) {
  const stdoutHandle = await open(options.stdoutPath, "wx");
  const stderrHandle = await open(options.stderrPath, "wx");
  const startedEpochMs = Date.now();
  const startedMonotonicNs = process.hrtime.bigint();
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      shell: false,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", stdoutHandle.fd, stderrHandle.fd],
    });
  } catch (cause) {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: cause.message,
      startedEpochMs,
      startedMonotonicNs: startedMonotonicNs.toString(),
      endedEpochMs: Date.now(),
    };
  }

  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  options.onSpawn?.(child.pid, startedEpochMs, startedMonotonicNs.toString());

  const remainingMs = options.deadlineEpochMs - Date.now();
  let timedOut = remainingMs <= 0;
  let deadlineTimer;
  let forceTimer;
  if (timedOut) {
    killProcessGroup(child, "SIGTERM");
  } else {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      forceTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 5_000);
      forceTimer.unref();
    }, remainingMs);
    deadlineTimer.unref();
  }

  const result = await new Promise((resolve) => {
    child.on("error", (cause) => resolve({ exitCode: null, signal: null, spawnError: cause.message }));
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, spawnError: null }));
  });
  clearTimeout(deadlineTimer);
  clearTimeout(forceTimer);
  await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  const endedEpochMs = Date.now();
  return {
    ...result,
    timedOut,
    startedEpochMs,
    startedMonotonicNs: startedMonotonicNs.toString(),
    endedEpochMs,
    durationMs: endedEpochMs - startedEpochMs,
  };
}

export async function startBackgroundProcess(argv, options) {
  const stdoutHandle = await open(options.stdoutPath, "wx");
  const stderrHandle = await open(options.stderrPath, "wx");
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      shell: false,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
    });
  } catch (cause) {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    throw new ProcessError("E_COMMAND_SPAWN", cause.message);
  }

  const controller = {
    pid: child.pid,
    exited: false,
    exitResult: null,
  };
  controller.exit = new Promise((resolve) => {
    child.on("error", async (cause) => {
      controller.exited = true;
      controller.exitResult = { exitCode: null, signal: null, error: cause.message };
      await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
      resolve(controller.exitResult);
    });
    child.on("close", async (exitCode, signal) => {
      if (controller.exited) return;
      controller.exited = true;
      controller.exitResult = { exitCode, signal, error: null };
      await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
      resolve(controller.exitResult);
    });
  });
  controller.stop = async (signal = "SIGTERM") => {
    if (controller.exited) return controller.exitResult;
    killProcessGroup(child, signal);
    const forced = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!controller.exited) killProcessGroup(child, "SIGKILL");
        resolve();
      }, 5_000);
      timer.unref();
    });
    await Promise.race([controller.exit, forced]);
    return controller.exit;
  };
  return controller;
}
