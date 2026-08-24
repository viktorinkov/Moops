import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  PINNED_CLAUDE_MEM_COMMIT,
  PINNED_CLAUDE_MEM_VERSION,
  loadAndValidateRegistry,
  renderMemoryPackets,
  validateRegistry,
} from "../registry.mjs";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;
const registryPath = join(repositoryRoot, "benchmark/claude-mem/checkpoints.json");

test("the checked-in registry pins Claude-Mem and names all three memory checkpoints", async () => {
  const registry = await loadAndValidateRegistry(registryPath, repositoryRoot);

  assert.equal(registry.claudeMem.version, PINNED_CLAUDE_MEM_VERSION);
  assert.equal(registry.claudeMem.sourceCommit, PINNED_CLAUDE_MEM_COMMIT);
  assert.equal(registry.claudeMem.provider, "claude-subscription");
  assert.equal(registry.claudeMem.workerPort, 37977);
  assert.deepEqual(
    registry.checkpoints.map(({ name }) => name),
    ["catalog-ready", "cart-ready", "checkout-ready"],
  );
});

test("all three memory descriptors point at executable MOOPS checkpoints", async () => {
  const registry = await loadAndValidateRegistry(registryPath, repositoryRoot);
  assert.deepEqual(
    registry.checkpoints.map(({ executableCheckpoint }) => executableCheckpoint.path),
    [
      "benchmark/checkpoints/food-delivery-catalog-ready.json",
      "benchmark/checkpoints/food-delivery-cart-ready.json",
      "benchmark/checkpoints/food-delivery-cart.json",
    ],
  );
});

test("cart-ready proves the fixed two-item persisted-cart baseline", async () => {
  const checkpoint = JSON.parse(
    await readFile(
      join(repositoryRoot, "benchmark/checkpoints/food-delivery-cart-ready.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    checkpoint.landingPredicates.find(
      ({ kind, selector }) => kind === "equals" && selector.value === "home.cart",
    ),
    {
      kind: "equals",
      selector: { by: "id", value: "home.cart" },
      field: "value",
      expected: "2 items",
    },
  );
  assert.equal(
    checkpoint.landingPredicates.some(
      ({ selector }) => selector.value === "home.cart.itemCount",
    ),
    false,
  );
});

test("memory packets name all three executable checkpoint files", async () => {
  const registry = await loadAndValidateRegistry(registryPath, repositoryRoot);
  const packets = renderMemoryPackets(registry);

  assert.match(
    packets,
    /MOOPS_MEMORY_CHECKPOINT catalog-ready[\s\S]*Executable restore: benchmark\/checkpoints\/food-delivery-catalog-ready\.json/,
  );
  assert.match(
    packets,
    /MOOPS_MEMORY_CHECKPOINT cart-ready[\s\S]*Executable restore: benchmark\/checkpoints\/food-delivery-cart-ready\.json/,
  );
  assert.match(
    packets,
    /MOOPS_MEMORY_CHECKPOINT cart-ready[\s\S]*exactly two real persisted cart items/,
  );
  assert.match(
    packets,
    /MOOPS_MEMORY_CHECKPOINT checkout-ready[\s\S]*Executable restore: benchmark\/checkpoints\/food-delivery-cart\.json/,
  );
  assert.match(packets, /MOOPS checkpoint files remain executable truth/);
});

test("descriptors cannot contain unvalidated restore actions", async () => {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.checkpoints[0].restoreActions = [{ op: "tap", id: "home.cart" }];
  assert.throws(() => validateRegistry(registry), /unexpected key restoreActions/);
});

test("every executable descriptor must match its checkpoint fingerprint on disk", async () => {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.checkpoints[0].executableCheckpoint.fingerprint = `sha256:${"0".repeat(64)}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "moops-memory-registry-"));
  const copiedRegistry = join(temporaryRoot, "checkpoints.json");
  await writeFile(copiedRegistry, `${JSON.stringify(registry, null, 2)}\n`);

  await assert.rejects(
    () => loadAndValidateRegistry(copiedRegistry, repositoryRoot),
    /catalog-ready descriptor fingerprint does not match its executable checkpoint/,
  );
});

test("the MOOPS CLI validates every named executable checkpoint", async () => {
  const registry = await loadAndValidateRegistry(registryPath, repositoryRoot);

  for (const descriptor of registry.checkpoints) {
    const result = spawnSync(
      join(repositoryRoot, "tools/moops/moops"),
      ["checkpoint", descriptor.executableCheckpoint.path],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${descriptor.name}: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.checkpoint.fingerprint, descriptor.executableCheckpoint.fingerprint);
  }
});

test("arm-D launcher forces local storage, no cloud sync, and no telemetry", async () => {
  const localData = join(tmpdir(), "moops-claude-mem-test-data");
  const result = spawnSync(
    join(repositoryRoot, "benchmark/claude-mem/run-arm-d"),
    ["--print-environment"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_CODE_PATH: "/tmp/inherited-claude",
        CLAUDE_MEM_EXCLUDED_PROJECTS: "*",
        CLAUDE_MEM_MODEL: "inherited-model-must-not-win",
        CLAUDE_MEM_MODE: "inherited-mode",
        CLAUDE_MEM_RUNTIME: "server",
        CLAUDE_MEM_SEMANTIC_INJECT: "true",
        CLAUDE_MEM_SKIP_TOOLS: "Bash",
        CLAUDE_MEM_WORKER_HOST: "0.0.0.0",
        MOOPS_CLAUDE_MEM_DATA_DIR: localData,
        MOOPS_CLAUDE_MEM_TEST_ONLY_ALLOW_DATA_DIR: "1",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    CLAUDE_CODE_PATH: "",
    CLAUDE_MEM_CHROMA_ENABLED: "false",
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: "",
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: "",
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: "",
    CLAUDE_MEM_CLAUDE_AUTH_METHOD: "subscription",
    CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION: "false",
    CLAUDE_MEM_DATA_DIR: localData,
    CLAUDE_MEM_EXCLUDED_PROJECTS: "",
    CLAUDE_MEM_MODEL: "claude-haiku-4-5-20251001",
    CLAUDE_MEM_MODE: "code",
    CLAUDE_MEM_PROVIDER: "claude",
    CLAUDE_MEM_QUEUE_ENGINE: "sqlite",
    CLAUDE_MEM_RUNTIME: "worker",
    CLAUDE_MEM_SEMANTIC_INJECT: "false",
    CLAUDE_MEM_SKIP_TOOLS: "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",
    CLAUDE_MEM_TELEGRAM_ENABLED: "false",
    CLAUDE_MEM_TELEMETRY: "0",
    CLAUDE_MEM_TELEMETRY_ERRORS: "0",
    CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: join(localData, "transcript-watch.json"),
    CLAUDE_MEM_TRANSCRIPTS_ENABLED: "false",
    CLAUDE_MEM_TIER_ROUTING_ENABLED: "false",
    CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
    CLAUDE_MEM_WORKER_PORT: "37977",
    CLAUDE_MEM_WORKER_SCRIPT_PATH: "",
    DO_NOT_TRACK: "1",
  });
});

test("arm-D launcher refuses an ambiguous or reused benchmark store", async () => {
  const environment = { ...process.env };
  delete environment.MOOPS_CLAUDE_MEM_DATA_DIR;
  delete environment.MOOPS_CLAUDE_MEM_RUN_ID;

  const missingRun = spawnSync(
    join(repositoryRoot, "benchmark/claude-mem/run-arm-d"),
    ["--print-environment"],
    { cwd: repositoryRoot, encoding: "utf8", env: environment },
  );
  assert.notEqual(missingRun.status, 0);
  assert.match(missingRun.stderr, /MOOPS_CLAUDE_MEM_RUN_ID is required/);

  const unrestrictedData = join(tmpdir(), "moops-unrestricted-memory");
  const unrestrictedRun = spawnSync(
    join(repositoryRoot, "benchmark/claude-mem/run-arm-d"),
    ["--print-environment"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, MOOPS_CLAUDE_MEM_DATA_DIR: unrestrictedData },
    },
  );
  assert.notEqual(unrestrictedRun.status, 0);
  assert.match(unrestrictedRun.stderr, /TEST_ONLY_ALLOW_DATA_DIR=1/);

  const reusedData = await mkdtemp(join(tmpdir(), "moops-reused-memory-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "moops-fake-codex-freshness-"));
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(
    fakeCodex,
    "#!/bin/sh\nprintf '%s\\n' 'claude-mem@claude-mem-local  installed, enabled  13.15.3  /tmp/plugin'\n",
  );
  await chmod(fakeCodex, 0o755);

  const reusedRun = spawnSync(
    join(repositoryRoot, "benchmark/claude-mem/run-arm-d"),
    ["--doctor-fresh"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MOOPS_CLAUDE_MEM_DATA_DIR: reusedData,
        MOOPS_CLAUDE_MEM_TEST_ONLY_ALLOW_DATA_DIR: "1",
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );
  assert.notEqual(reusedRun.status, 0);
  assert.match(reusedRun.stderr, /fresh memory directory/);
});

test("arm-D doctor requires the pinned Claude-Mem plugin to be enabled", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "moops-fake-codex-"));
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(
    fakeCodex,
    "#!/bin/sh\nprintf '%s\\n' 'claude-mem@claude-mem-local  installed, enabled  13.15.3  /tmp/plugin'\n",
  );
  await chmod(fakeCodex, 0o755);
  const fakeLsof = join(fakeBin, "lsof");
  await writeFile(fakeLsof, "#!/bin/sh\nexit 1\n");
  await chmod(fakeLsof, 0o755);

  const result = spawnSync(join(repositoryRoot, "benchmark/claude-mem/run-arm-d"), ["--doctor-fresh"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MOOPS_CLAUDE_MEM_DATA_DIR: join(fakeBin, "fresh-data"),
      MOOPS_CLAUDE_MEM_TEST_ONLY_ALLOW_DATA_DIR: "1",
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    claudeMemEnabled: true,
    claudeMemVersion: "13.15.3",
    ok: true,
  });

  const dataDirectory = join(fakeBin, "fresh-data");
  assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
  assert.equal(
    await readFile(join(dataDirectory, ".moops-arm-d-store"), "utf8"),
    "test-only\n",
  );
  assert.equal(
    (await stat(join(dataDirectory, ".moops-arm-d-store"))).mode & 0o777,
    0o600,
  );
});

test("arm-D fresh doctor performs setup checks before consuming the store", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "moops-fake-codex-preflight-"));
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(
    fakeCodex,
    "#!/bin/sh\nprintf '%s\\n' 'claude-mem@claude-mem-local  installed, disabled  13.15.2  /tmp/plugin'\n",
  );
  await chmod(fakeCodex, 0o755);
  const fakeLsof = join(fakeBin, "lsof");
  await writeFile(fakeLsof, "#!/bin/sh\nexit 1\n");
  await chmod(fakeLsof, 0o755);
  const dataDirectory = join(fakeBin, "must-not-exist");

  const result = spawnSync(join(repositoryRoot, "benchmark/claude-mem/run-arm-d"), ["--doctor-fresh"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MOOPS_CLAUDE_MEM_DATA_DIR: dataDirectory,
      MOOPS_CLAUDE_MEM_TEST_ONLY_ALLOW_DATA_DIR: "1",
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires enabled claude-mem 13\.15\.3/);
  await assert.rejects(() => access(dataDirectory), /ENOENT/);
});

test("arm-D doctor rejects a disabled or wrong-version Claude-Mem plugin", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "moops-fake-codex-wrong-"));
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(
    fakeCodex,
    "#!/bin/sh\nprintf '%s\\n' 'claude-mem@claude-mem-local  installed, disabled  13.15.2  /tmp/plugin'\n",
  );
  await chmod(fakeCodex, 0o755);

  const result = spawnSync(join(repositoryRoot, "benchmark/claude-mem/run-arm-d"), ["--doctor"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MOOPS_CLAUDE_MEM_DATA_DIR: join(fakeBin, "data"),
      MOOPS_CLAUDE_MEM_TEST_ONLY_ALLOW_DATA_DIR: "1",
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires enabled claude-mem 13\.15\.3/);
});

test("registry CLI usage documents both packet modes", () => {
  const result = spawnSync(
    process.execPath,
    ["benchmark/claude-mem/registry.mjs", "--unsupported"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--packets/);
  assert.match(result.stderr, /--packet NAME/);
});

async function workerFixture(port = 48123) {
  const root = await mkdtemp(join(tmpdir(), "moops-worker-lifecycle-"));
  const dataDirectory = join(root, "store");
  const workerScriptPath = join(root, "plugin/scripts/worker-service.cjs");
  await mkdir(join(root, "plugin/scripts"), { recursive: true });
  await mkdir(dataDirectory);
  await writeFile(workerScriptPath, "// fixture worker\n");
  await writeFile(join(dataDirectory, "worker.pid"), JSON.stringify({
    pid: 4242,
    port,
    startedAt: "2026-08-23T20:00:00.000Z",
    startToken: "fixture-start-token",
  }));

  const fetchImplementation = async (url) => {
    const path = new URL(url).pathname;
    const bodies = {
      "/api/readiness": { status: "ready", mcpReady: true },
      "/api/health": {
        initialized: true,
        mcpReady: true,
        pid: 4242,
        version: "13.15.3",
        workerPath: workerScriptPath,
      },
      "/api/settings": {
        CLAUDE_CODE_PATH: "",
        CLAUDE_MEM_CLAUDE_AUTH_METHOD: "subscription",
        CLAUDE_MEM_DATA_DIR: dataDirectory,
        CLAUDE_MEM_EXCLUDED_PROJECTS: "",
        CLAUDE_MEM_MODEL: "claude-haiku-4-5-20251001",
        CLAUDE_MEM_MODE: "code",
        CLAUDE_MEM_PROVIDER: "claude",
        CLAUDE_MEM_QUEUE_ENGINE: "sqlite",
        CLAUDE_MEM_RUNTIME: "worker",
        CLAUDE_MEM_SEMANTIC_INJECT: "false",
        CLAUDE_MEM_SKIP_TOOLS: "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",
        CLAUDE_MEM_TIER_ROUTING_ENABLED: "false",
        CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
        CLAUDE_MEM_WORKER_PORT: String(port),
      },
    };
    const body = bodies[path];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: async () => body ?? {},
    };
  };
  return { dataDirectory, fetchImplementation, port, workerScriptPath };
}

test("worker readiness proves the exact MCP-started process and run-store receipt", async () => {
  const { verifyWorkerReady } = await import("../worker-lifecycle.mjs");
  const fixture = await workerFixture();
  let readinessCalls = 0;
  const fetchImplementation = async (url, options) => {
    if (new URL(url).pathname === "/api/readiness" && readinessCalls++ === 0) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ status: "initializing" }),
      };
    }
    return fixture.fetchImplementation(url, options);
  };

  const receipt = await verifyWorkerReady({
    expectedDataDirectory: fixture.dataDirectory,
    expectedWorkerScriptPath: fixture.workerScriptPath,
    fetchImplementation,
    port: fixture.port,
    delayImplementation: async () => {},
    processStartTokenImplementation: async () => "fixture-start-token",
  });

  assert.equal(readinessCalls, 2);
  assert.equal(receipt.kind, "claude-mem-worker-startup");
  assert.equal(receipt.pid, 4242);
  assert.equal(receipt.startToken, "fixture-start-token");
  assert.equal(receipt.workerPath, fixture.workerScriptPath);
  assert.deepEqual(receipt.readiness, { status: "ready", mcpReady: true });
});

test("worker shutdown re-proves the start token and directly closes the PID and port", async () => {
  const { verifyWorkerIdentityAndShutdown, verifyWorkerReady } =
    await import("../worker-lifecycle.mjs");
  const fixture = await workerFixture(48124);
  const startup = await verifyWorkerReady({
    expectedDataDirectory: fixture.dataDirectory,
    expectedWorkerScriptPath: fixture.workerScriptPath,
    fetchImplementation: fixture.fetchImplementation,
    port: fixture.port,
    processStartTokenImplementation: async () => "fixture-start-token",
  });
  await writeFile(
    join(fixture.dataDirectory, ".moops-worker-startup.json"),
    JSON.stringify(startup),
  );

  let alive = true;
  const signals = [];
  const shutdown = await verifyWorkerIdentityAndShutdown({
    expectedDataDirectory: fixture.dataDirectory,
    expectedWorkerScriptPath: fixture.workerScriptPath,
    fetchImplementation: fixture.fetchImplementation,
    port: fixture.port,
    processStartTokenImplementation: async () => "fixture-start-token",
    processAliveImplementation: async () => alive,
    portClosedImplementation: async () => !alive,
    signalImplementation: (pid, signal) => {
      signals.push([pid, signal]);
      alive = false;
    },
  });

  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
  assert.equal(shutdown.kind, "claude-mem-worker-shutdown");
  assert.equal(shutdown.startToken, "fixture-start-token");
  assert.equal(shutdown.pidClosed, true);
  assert.equal(shutdown.portClosed, true);
});

test("staging cleanup closes an exactly proven worker after readiness fails", async () => {
  const { verifyWorkerIdentityAndShutdown, verifyWorkerReady } =
    await import("../worker-lifecycle.mjs");
  const fixture = await workerFixture(48126);
  const fetchImplementation = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/readiness") {
      return {
        ok: false,
        status: 503,
        json: async () => ({ status: "initializing", mcpReady: false }),
      };
    }
    if (path === "/api/health") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          initialized: false,
          mcpReady: false,
          pid: 4242,
          version: "13.15.3",
          workerPath: fixture.workerScriptPath,
        }),
      };
    }
    return fixture.fetchImplementation(url, options);
  };
  await assert.rejects(
    () => verifyWorkerReady({
      expectedDataDirectory: fixture.dataDirectory,
      expectedWorkerScriptPath: fixture.workerScriptPath,
      fetchImplementation,
      port: fixture.port,
      readinessTimeoutMs: 0,
      processStartTokenImplementation: async () => "fixture-start-token",
    }),
    /readiness was not proven/,
  );

  let alive = true;
  const signals = [];
  const shutdown = await verifyWorkerIdentityAndShutdown({
    expectedDataDirectory: fixture.dataDirectory,
    expectedWorkerScriptPath: fixture.workerScriptPath,
    fetchImplementation,
    port: fixture.port,
    processStartTokenImplementation: async () => "fixture-start-token",
    processAliveImplementation: async () => alive,
    portClosedImplementation: async () => !alive,
    signalImplementation: (pid, signal) => {
      signals.push([pid, signal]);
      alive = false;
    },
  });

  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
  assert.equal(shutdown.stagingCleanup, true);
  assert.equal(shutdown.pidClosed, true);
  assert.equal(shutdown.portClosed, true);
});

test("worker shutdown refuses a changed process start token before signaling", async () => {
  const { verifyWorkerIdentityAndShutdown } = await import("../worker-lifecycle.mjs");
  const fixture = await workerFixture(48125);
  let tokenReads = 0;
  let signaled = false;
  await assert.rejects(
    () => verifyWorkerIdentityAndShutdown({
      expectedDataDirectory: fixture.dataDirectory,
      expectedWorkerScriptPath: fixture.workerScriptPath,
      fetchImplementation: fixture.fetchImplementation,
      port: fixture.port,
      processStartTokenImplementation: async () => (
        tokenReads++ === 0 ? "fixture-start-token" : "reused-pid-token"
      ),
      processAliveImplementation: async () => true,
      signalImplementation: () => { signaled = true; },
    }),
    /ownership changed before SIGTERM/,
  );
  assert.equal(signaled, false);
});

test("arm-D launcher retains control until worker identity and shutdown are verified", async () => {
  const launcher = await readFile(
    join(repositoryRoot, "benchmark/claude-mem/run-arm-d"),
    "utf8",
  );
  const codexInvocation = launcher.indexOf('codex "$@"');
  const lifecycleInvocation = launcher.indexOf(
    'node "$SCRIPT_DIR/worker-lifecycle.mjs" --verify-and-shutdown',
  );
  const exitTrap = launcher.indexOf("trap cleanup_worker EXIT");

  assert.ok(codexInvocation >= 0);
  assert.ok(lifecycleInvocation >= 0);
  assert.ok(exitTrap >= 0 && exitTrap < codexInvocation);
  assert.match(launcher, /CLAUDE_MEM_WORKER_SCRIPT_PATH=.*13\.15\.3\/scripts\/worker-service\.cjs/);
  assert.match(launcher, /worker-lifecycle\.mjs" --verify-ready/);
  assert.doesNotMatch(launcher, /--start-and-verify/);
  assert.doesNotMatch(launcher, /^exec codex/m);
});
