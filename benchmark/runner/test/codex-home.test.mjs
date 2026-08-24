import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ARM_DEFINITIONS } from "../src/config.mjs";
import {
  CodexHomeError,
  bindClaudeMemRuntime,
  prepareCodexHomes,
  scrubTreatmentEnvironment,
} from "../src/codex-home.mjs";

async function writeRuntimeFixture(root, {
  lock = "pinned-lock",
  withDependencies = true,
  zodVersion = "4.4.3",
} = {}) {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "claude-mem-plugin",
      version: "13.15.3",
    })}\n`),
    writeFile(join(root, "bun.lock"), `${lock}\n`),
  ]);
  if (withDependencies) {
    await mkdir(join(root, "node_modules/zod/v3"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "node_modules/zod/package.json"), `${JSON.stringify({
        name: "zod",
        version: zodVersion,
        exports: { "./v3": "./v3/index.js" },
      })}\n`),
      writeFile(join(root, "node_modules/zod/v3/index.js"), "export {};\n"),
    ]);
  }
}

function fixtureLockSHA256(lock = "pinned-lock") {
  return `sha256:${createHash("sha256").update(`${lock}\n`).digest("hex")}`;
}

test("scrubs inherited treatment state before applying an arm policy", () => {
  const cleaned = scrubTreatmentEnvironment({
    PATH: "/usr/bin",
    CODEX_HOME: "/contaminated",
    CLAUDE_MEM_DATA_DIR: "/wrong-store",
    CLAUDE_CONFIG_DIR: "/wrong-claude",
    CLAUDE_PLUGIN_ROOT: "/wrong-plugin",
    PLUGIN_ROOT: "/wrong-plugin",
    MOOPS_CLAUDE_MEM_RUN_ID: "old",
    MOOPS_ENABLE_MOOPS: "1",
    SIMCTL_CHILD_MOOPS_ENABLE_INJECTIONIII: "1",
    INJECTION_CONTROL_SOCKET: "/wrong.sock",
    MCP_XCODE_PID: "99999",
  });

  assert.deepEqual(cleaned, { PATH: "/usr/bin" });
});

test("binds a dependency-complete pinned runtime into an isolated Claude-Mem plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-runtime-"));
  const sourcePluginRoot = join(root, "operator/plugins/cache/claude-mem-local/claude-mem/13.15.3");
  const isolatedPluginRoot = join(root, "run/plugins/cache/claude-mem-local/claude-mem/13.15.3");
  await Promise.all([
    writeRuntimeFixture(sourcePluginRoot),
    writeRuntimeFixture(isolatedPluginRoot, { withDependencies: false }),
  ]);

  const evidence = await bindClaudeMemRuntime({
    sourcePluginRoot,
    isolatedPluginRoot,
    requiredLockSHA256: fixtureLockSHA256(),
  });

  const isolatedModules = join(isolatedPluginRoot, "node_modules");
  assert.equal((await lstat(isolatedModules)).isSymbolicLink(), true);
  assert.equal(await realpath(isolatedModules), await realpath(join(sourcePluginRoot, "node_modules")));
  assert.equal(evidence.kind, "pinned-node-modules-symlink");
  assert.equal(evidence.zodVersion, "4.4.3");
  assert.match(evidence.lockSHA256, /^sha256:[a-f0-9]{64}$/);
});

test("refuses a dependency runtime from a different Claude-Mem lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-runtime-mismatch-"));
  const sourcePluginRoot = join(root, "source");
  const isolatedPluginRoot = join(root, "isolated");
  await Promise.all([
    writeRuntimeFixture(sourcePluginRoot, { lock: "source-lock" }),
    writeRuntimeFixture(isolatedPluginRoot, { lock: "isolated-lock", withDependencies: false }),
  ]);

  await assert.rejects(
    () => bindClaudeMemRuntime({ sourcePluginRoot, isolatedPluginRoot }),
    (cause) => cause instanceof CodexHomeError && cause.code === "E_CODEX_HOME_CLAUDE_MEM_RUNTIME",
  );
});

test("refuses matching dependency locks that are not the pinned 13.15.3 lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-runtime-unpinned-"));
  const sourcePluginRoot = join(root, "source");
  const isolatedPluginRoot = join(root, "isolated");
  await Promise.all([
    writeRuntimeFixture(sourcePluginRoot, { lock: "same-but-unpinned" }),
    writeRuntimeFixture(isolatedPluginRoot, { lock: "same-but-unpinned", withDependencies: false }),
  ]);

  await assert.rejects(
    () => bindClaudeMemRuntime({ sourcePluginRoot, isolatedPluginRoot }),
    (cause) => cause instanceof CodexHomeError && cause.code === "E_CODEX_HOME_CLAUDE_MEM_RUNTIME",
  );
});

test("refuses a stale Zod runtime even when the Claude-Mem lock matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-claude-runtime-stale-zod-"));
  const sourcePluginRoot = join(root, "source");
  const isolatedPluginRoot = join(root, "isolated");
  await Promise.all([
    writeRuntimeFixture(sourcePluginRoot, { zodVersion: "4.4.2" }),
    writeRuntimeFixture(isolatedPluginRoot, { withDependencies: false }),
  ]);

  await assert.rejects(
    () => bindClaudeMemRuntime({
      sourcePluginRoot,
      isolatedPluginRoot,
      requiredLockSHA256: fixtureLockSHA256(),
    }),
    (cause) => cause instanceof CodexHomeError && cause.code === "E_CODEX_HOME_CLAUDE_MEM_RUNTIME",
  );
});

test("provisions four isolated homes with common Xcode MCP and Claude-Mem only in D", async () => {
  const root = await mkdtemp(join(tmpdir(), "moops-codex-homes-"));
  const sourceHome = join(root, "operator-codex");
  const runDirectory = join(root, "run");
  const marketplace = join(root, "marketplace");
  await Promise.all([
    mkdir(sourceHome),
    mkdir(runDirectory),
    mkdir(join(marketplace, "plugin"), { recursive: true }),
  ]);
  await writeFile(join(sourceHome, "auth.json"), "{}\n", { mode: 0o600 });
  const calls = [];
  const capture = async (argv, options) => {
    calls.push({ argv, options });
    if (argv[0] === "/usr/bin/xcrun") {
      return { exitCode: 0, signal: null, stderr: "", stdout: "mcpbridge - STDIO Bridge for Xcode MCP Tools\n" };
    }
    if (options.env.CODEX_HOME === sourceHome) {
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: `claude-mem@claude-mem-local  installed, enabled  13.15.3  ${join(marketplace, "plugin")}\n`,
      };
    }
    if (argv.includes("marketplace") || (argv[1] === "plugin" && argv[2] === "add")) {
      return { exitCode: 0, signal: null, stderr: "", stdout: '{"ok":true}\n' };
    }
    const armId = ARM_DEFINITIONS.find(({ id }) => options.env.CODEX_HOME.endsWith(id)).id;
    if (argv.at(-1) === "list" && argv[1] === "mcp") {
      const memory = armId === "codex-moops-claudemem"
        ? "mcp-search node adapter enabled Unsupported\n"
        : "";
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: `${memory}xcode /usr/bin/xcrun mcpbridge - - enabled Unsupported\n`,
      };
    }
    return {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: armId === "codex-moops-claudemem"
        ? `claude-mem@claude-mem-local installed, enabled 13.15.3 ${join(marketplace, "plugin")}\n`
        : "No plugin marketplaces configured.\n",
    };
  };
  const events = [];
  const runtimeBindings = [];
  const arms = ARM_DEFINITIONS.map((definition, index) => ({
    ...definition,
    environment: { MCP_XCODE_PID: String(50_001 + index) },
  }));
  const homes = await prepareCodexHomes({
    agentCommand: ["codex", "app-server", "--enable", "goals"],
    arms,
  }, {
    ledger: { emit: async (...event) => events.push(event) },
    runDirectory,
    runId: "take-001",
  }, {
    capture,
    sourceCodexHome: sourceHome,
    bindRuntime: async (binding) => {
      runtimeBindings.push(binding);
      return { kind: "fixture-runtime", lockSHA256: `sha256:${"a".repeat(64)}` };
    },
  });

  assert.deepEqual(Object.keys(homes), ARM_DEFINITIONS.map(({ id }) => id));
  for (const definition of ARM_DEFINITIONS) {
    const record = homes[definition.id];
    assert.equal((await lstat(record.home)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(record.home, "auth.json"))).isSymbolicLink(), true);
    const config = await readFile(join(record.home, "config.toml"), "utf8");
    assert.match(config, /command = "\/usr\/bin\/xcrun"/);
    assert.match(config, /args = \["mcpbridge"\]/);
    assert.match(config, /\[mcp_servers\.xcode\.env\]/);
    assert.match(config, new RegExp(`MCP_XCODE_PID = "${50_001 + ARM_DEFINITIONS.indexOf(definition)}"`));
    assert.equal(record.xcodeMCP.command, "/usr/bin/xcrun");
    assert.equal(record.claudeMemEnabled, definition.id === "codex-moops-claudemem");
  }
  assert.equal(calls.filter(({ argv }) => argv.includes("marketplace")).length, 1);
  assert.equal(calls.filter(({ argv }) => argv[1] === "plugin" && argv[2] === "add").length, 1);
  assert.equal(runtimeBindings.length, 1);
  assert.equal(
    runtimeBindings[0].sourcePluginRoot,
    join(sourceHome, "plugins/cache/claude-mem-local/claude-mem/13.15.3"),
  );
  assert.equal(
    runtimeBindings[0].isolatedPluginRoot,
    join(
      homes["codex-moops-claudemem"].home,
      "plugins/cache/claude-mem-local/claude-mem/13.15.3",
    ),
  );
  assert.equal(homes["codex-moops-claudemem"].claudeMemRuntime.kind, "fixture-runtime");
  assert.equal(events.filter(([name]) => name === "codex_home.provisioned").length, 4);
});
