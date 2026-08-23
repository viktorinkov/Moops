import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ARM_DEFINITIONS } from "../src/config.mjs";
import {
  prepareCodexHomes,
  scrubTreatmentEnvironment,
} from "../src/codex-home.mjs";

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
  }, { capture, sourceCodexHome: sourceHome });

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
  assert.equal(events.filter(([name]) => name === "codex_home.provisioned").length, 4);
});
