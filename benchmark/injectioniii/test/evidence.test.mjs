import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InjectionEvidenceError,
  collectPostflightEvidence,
  collectPreflightEvidence,
  sendControlCommand,
} from "../evidence.mjs";

const WORKTREE = "/private/tmp/moops-run/worktrees/codex-injection";
const DERIVED_DATA = "/private/tmp/moops-run/derived/codex-injection";
const INJECTION_APP = "/Applications/InjectionIII.app";
const CONTROL_SOCKET = "/private/tmp/InjectionNext-control.sock";

function successful(stdout = "") {
  return { exitCode: 0, signal: null, stdout, stderr: "" };
}

function preflightCapture(argv) {
  if (argv[0] === "/usr/bin/plutil") return successful("5.2.1\n");
  if (argv[0] === "/usr/sbin/lsof" && argv.includes("-Fpc")) {
    return successful("p64052\ncInjectionIII\nf9\n");
  }
  if (argv[0] === "/usr/sbin/lsof") {
    return successful(
      "Injection 64052 user 5u IPv4 0x0 0t0 TCP 127.0.0.1:8898 (LISTEN)\n",
    );
  }
  throw new Error(`unexpected command: ${JSON.stringify(argv)}`);
}

function postflightCapture(argv) {
  if (argv.includes("-iTCP@127.0.0.1:8898")) {
    return successful(
      "Food Delivery 64710 user 6u IPv4 0x0 0t0 TCP 127.0.0.1:62496->127.0.0.1:8898 (ESTABLISHED)\n",
    );
  }
  if (argv[0] === "/usr/sbin/lsof" && argv.includes("64710")) {
    return successful([
      "Food Delivery 64710 user txt REG 1,17 1 1 /Applications/InjectionIII.app/Contents/Resources/iOSInjection.bundle/iOSInjection",
      "Food Delivery 64710 user txt REG 1,17 1 2 /Applications/InjectionIII.app/Contents/Resources/iOSInjection.bundle/Frameworks/SwiftTrace.framework/Versions/A/SwiftTrace",
      "",
    ].join("\n"));
  }
  throw new Error(`unexpected command: ${JSON.stringify(argv)}`);
}

async function successfulControl(_socketPath, payload) {
  if (payload.action === "status") {
    return { success: true, data: { connectedClients: 1 } };
  }
  if (payload.action === "watch_project") {
    return { success: true, data: { path: payload.path } };
  }
  if (payload.action === "clear_logs") return { success: true };
  if (payload.action === "get_logs") {
    return {
      success: true,
      data: {
        count: 2,
        logs: [
          { timestamp: 1_700_000_001, level: "info", message: "Compiling CartView.swift for injection" },
          { timestamp: 1_700_000_002, level: "error", message: "Injection failed: layout changed" },
        ],
      },
    };
  }
  if (payload.action === "get_last_error") {
    return { success: true, data: { message: "stored property layout changed" } };
  }
  throw new Error(`unexpected control action: ${payload.action}`);
}

async function preflightEvidence(overrides = {}) {
  return collectPreflightEvidence({
    worktree: WORKTREE,
    derivedData: DERIVED_DATA,
    injectionAppPath: INJECTION_APP,
    controlSocketPath: CONTROL_SOCKET,
    now: () => 1_700_000_000_500,
    ...overrides,
  }, {
    captureCommand: preflightCapture,
    controlCommand: successfulControl,
  });
}

test("preflight proves InjectionIII 5.2.1, one loopback listener, and resets the exact arm-C watcher", async () => {
  const actions = [];
  const report = await collectPreflightEvidence({
    worktree: WORKTREE,
    derivedData: DERIVED_DATA,
    injectionAppPath: INJECTION_APP,
    controlSocketPath: CONTROL_SOCKET,
    now: () => 1_700_000_000_500,
  }, {
    captureCommand: preflightCapture,
    controlCommand: async (socketPath, payload) => {
      actions.push({ socketPath, payload });
      return successfulControl(socketPath, payload);
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.phase, "preflight");
  assert.equal(report.injectionIII.version, "5.2.1");
  assert.equal(report.host.pid, 64052);
  assert.equal(report.host.listener, "127.0.0.1:8898");
  assert.equal(report.control.logSinceEpochSeconds, 1_700_000_000);
  assert.deepEqual(actions.map(({ payload }) => payload), [
    { action: "status" },
    { action: "watch_project", path: WORKTREE },
    { action: "clear_logs" },
  ]);
});

test("preflight rejects any InjectionIII version other than the benchmark pin", async () => {
  await assert.rejects(
    () => collectPreflightEvidence({
      worktree: WORKTREE,
      derivedData: DERIVED_DATA,
      injectionAppPath: INJECTION_APP,
      controlSocketPath: CONTROL_SOCKET,
    }, {
      captureCommand: async (argv) => argv[0] === "/usr/bin/plutil"
        ? successful("5.2.0\n")
        : preflightCapture(argv),
      controlCommand: successfulControl,
    }),
    (error) => error instanceof InjectionEvidenceError && error.code === "E_INJECTION_VERSION",
  );
});

test("preflight rejects a timed-out process probe even if it reports exit zero", async () => {
  await assert.rejects(
    () => collectPreflightEvidence({
      worktree: WORKTREE,
      derivedData: DERIVED_DATA,
      injectionAppPath: INJECTION_APP,
      controlSocketPath: CONTROL_SOCKET,
    }, {
      captureCommand: async (argv) => argv[0] === "/usr/bin/plutil"
        ? { ...successful("5.2.1\n"), timedOut: true }
        : preflightCapture(argv),
      controlCommand: successfulControl,
    }),
    (error) => error instanceof InjectionEvidenceError && error.code === "E_INJECTION_COMMAND",
  );
});

test("postflight proves the arm-C process connection, loaded modules, and an actual injection attempt", async () => {
  const preflight = await preflightEvidence();
  const report = await collectPostflightEvidence({
    preflight,
    appPid: 64710,
    now: () => 1_700_000_003_000,
  }, {
    captureCommand: postflightCapture,
    controlCommand: successfulControl,
  });

  assert.equal(report.ok, true);
  assert.equal(report.phase, "postflight");
  assert.equal(report.proof.kind, "injection-attempt");
  assert.equal(report.app.pid, 64710);
  assert.equal(report.app.connection, "127.0.0.1:8898");
  assert.deepEqual(report.app.loadedModules, ["iOSInjection", "SwiftTrace"]);
  assert.match(report.proof.logs[0].message, /Compiling CartView/);
  assert.equal(report.control.lastError.data.message, "stored property layout changed");
});

test("postflight accepts a validated structural fallback when InjectionIII logs contain no attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-injection-fallback-"));
  const worktree = join(root, "worktree");
  const derivedData = join(root, "derived");
  const sourcePath = join(worktree, "DeliveryPreference.swift");
  await mkdir(worktree, { recursive: true });
  await mkdir(derivedData, { recursive: true });
  await writeFile(sourcePath, "struct DeliveryPreference {}\n");
  const preflight = await preflightEvidence({ worktree, derivedData });

  const report = await collectPostflightEvidence({
    preflight,
    appPid: 64710,
    fallbackEvidence: {
      schemaVersion: 1,
      kind: "structural-fallback",
      reason: "added-source-file",
      sourcePaths: [sourcePath],
      normalBuild: {
        argv: [
          "/usr/bin/xcrun", "xcodebuild", "build",
          "-derivedDataPath", derivedData,
        ],
        exitCode: 0,
        completedEpochMs: 1_700_000_002_000,
      },
    },
    now: () => 1_700_000_003_000,
  }, {
    captureCommand: postflightCapture,
    controlCommand: async (socketPath, payload) => {
      if (payload.action === "get_logs") {
        return { success: true, data: { count: 1, logs: [
          { timestamp: 1_700_000_001, level: "info", message: "Watching project" },
        ] } };
      }
      return successfulControl(socketPath, payload);
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.proof.kind, "structural-fallback");
  assert.equal(report.proof.reason, "added-source-file");
  assert.deepEqual(report.proof.sourcePaths, [sourcePath]);
});

test("postflight fails closed without an injection attempt or structural fallback", async () => {
  const preflight = await preflightEvidence();
  await assert.rejects(
    () => collectPostflightEvidence({ preflight, appPid: 64710 }, {
      captureCommand: postflightCapture,
      controlCommand: async (socketPath, payload) => {
        if (payload.action === "get_logs") {
          return { success: true, data: { count: 0, logs: [] } };
        }
        return successfulControl(socketPath, payload);
      },
    }),
    (error) => error instanceof InjectionEvidenceError && error.code === "E_INJECTION_PROOF",
  );
});

test("postflight rejects an app without both the InjectionIII connection and loaded runtime modules", async () => {
  const preflight = await preflightEvidence();
  await assert.rejects(
    () => collectPostflightEvidence({ preflight, appPid: 64710 }, {
      captureCommand: async (argv) => argv.includes("-iTCP@127.0.0.1:8898")
        ? successful("")
        : successful("/Applications/InjectionIII.app/Contents/Resources/iOSInjection.bundle/iOSInjection\n"),
      controlCommand: successfulControl,
    }),
    (error) => error instanceof InjectionEvidenceError && error.code === "E_INJECTION_CONNECTION",
  );
});

test("control client exchanges one newline-delimited JSON response over the configured Unix transport", async () => {
  const socketPath = "/private/tmp/moops-injection-control.sock";
  const writes = [];
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  socket.write = (source) => {
    writes.push(source);
    const body = JSON.parse(source.trim());
    queueMicrotask(() => socket.emit(
      "data",
      Buffer.from(`${JSON.stringify({ success: true, data: body })}\n`),
    ));
  };

  const response = await sendControlCommand(
    socketPath,
    { action: "watch_project", path: WORKTREE },
    {
      timeoutMs: 1_000,
      createConnection: ({ path }) => {
        assert.equal(path, socketPath);
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    },
  );

  assert.deepEqual(writes, [`${JSON.stringify({
    action: "watch_project",
    path: WORKTREE,
  })}\n`]);
  assert.deepEqual(response, {
    success: true,
    data: { action: "watch_project", path: WORKTREE },
  });
});
