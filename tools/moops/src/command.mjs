import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 1_048_576;

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export function executeCommand(argv, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let completed = false;
    let timer;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finishWithError = (cause) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(cause);
    };

    const append = (stream, chunk) => {
      const next = stream + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        finishWithError(new CommandError("E_ADAPTER_OUTPUT", "adapter output exceeded 1 MiB"));
        return stream;
      }
      return next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (cause) => {
      finishWithError(new CommandError("E_ADAPTER_SPAWN", cause.message));
    });
    child.on("close", (exitCode) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });

    const timeoutMs = options.timeoutMs ?? 120_000;
    timer = setTimeout(() => {
      finishWithError(new CommandError("E_ADAPTER_TIMEOUT", `adapter exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });
}
