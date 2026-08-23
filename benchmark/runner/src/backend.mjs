import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { renderArgv } from "./config.mjs";
import { startBackgroundProcess } from "./process.mjs";

export class BackendError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BackendError(code, message);
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new BackendError(
      "E_BACKEND_PORT",
      `backend port ${port} is already in use`,
    )));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

async function awaitReadiness(record, expectedRevision) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (record.controller.exited) {
      fail(
        "E_BACKEND_EXIT",
        `${record.armId} backend exited before readiness with ${record.controller.exitResult?.exitCode}`,
      );
    }
    try {
      const response = await fetch(`${record.baseURL}/healthz`, {
        signal: AbortSignal.timeout(1_000),
        cache: "no-store",
      });
      if (response.ok) {
        const body = await response.json();
        if (body.catalog_revision !== expectedRevision) {
          fail(
            "E_BACKEND_FIXTURE",
            `${record.armId} reported ${body.catalog_revision}, expected ${expectedRevision}`,
          );
        }
        record.fixtureName = body.fixture;
        return;
      }
    } catch (cause) {
      if (cause instanceof BackendError) throw cause;
    }
    await delay(100);
  }
  fail("E_BACKEND_READY", `${record.armId} backend did not become ready`);
}

export async function startDedicatedBackends(manifest, context) {
  await Promise.all(manifest.arms.map(({ backendPort }) => assertPortAvailable(backendPort)));
  const records = [];
  try {
    for (const arm of manifest.arms) {
      const baseURL = `http://127.0.0.1:${arm.backendPort}`;
      const variables = {
        ARM_ID: arm.id,
        BACKEND_FIXTURE_REVISION: manifest.backendFixtureRevision,
        BACKEND_PORT: String(arm.backendPort),
        WORKTREE: arm.worktree,
      };
      const argv = renderArgv(manifest.backendCommand, variables);
      const resultDirectory = context.resultDirectories[arm.id];
      const controller = await startBackgroundProcess(argv, {
        cwd: arm.worktree,
        env: {
          ...process.env,
          MOOPS_BACKEND_FIXTURE_REVISION: manifest.backendFixtureRevision,
          MOOPS_BACKEND_PORT: String(arm.backendPort),
        },
        stdoutPath: join(resultDirectory, "backend.stdout.log"),
        stderrPath: join(resultDirectory, "backend.stderr.log"),
      });
      const record = {
        armId: arm.id,
        argv,
        baseURL,
        port: arm.backendPort,
        fixtureRevision: manifest.backendFixtureRevision,
        pid: controller.pid,
        controller,
      };
      records.push(record);
      await context.ledger.emit("backend.started", {
        armId: arm.id,
        command: argv,
        pid: controller.pid,
        port: arm.backendPort,
        fixtureRevision: manifest.backendFixtureRevision,
      });
    }
    await Promise.all(records.map((record) => awaitReadiness(
      record,
      manifest.backendFixtureRevision,
    )));
    for (const record of records) {
      await context.ledger.emit("backend.ready", {
        armId: record.armId,
        pid: record.pid,
        port: record.port,
        fixtureRevision: record.fixtureRevision,
      });
    }
    return records;
  } catch (cause) {
    await Promise.allSettled(records.map(({ controller }) => controller.stop()));
    throw cause;
  }
}

export async function stopDedicatedBackends(records, ledger) {
  const status = {};
  for (const record of records) {
    const exitedBeforeStop = record.controller.exited;
    const result = await record.controller.stop();
    status[record.armId] = {
      pid: record.pid,
      port: record.port,
      fixtureRevision: record.fixtureRevision,
      exitedBeforeStop,
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
    };
    await ledger.emit("backend.stopped", { armId: record.armId, ...status[record.armId] });
  }
  return status;
}
