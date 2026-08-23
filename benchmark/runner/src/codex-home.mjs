import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { captureCommand } from "./process.mjs";

const ARM_D = "codex-moops-claudemem";
const CLAUDE_MEM_PLUGIN = "claude-mem@claude-mem-local";
const TREATMENT_EXACT = new Set([
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CODEX_HOME",
  "INJECTION_CONTROL_SOCKET",
  "PLUGIN_ROOT",
]);
const TREATMENT_PREFIXES = [
  "CLAUDE_MEM_",
  "MOOPS_CLAUDE_MEM_",
  "MOOPS_ENABLE_",
  "SIMCTL_CHILD_MOOPS_ENABLE_",
];

export class CodexHomeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodexHomeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CodexHomeError(code, message);
}

export function scrubTreatmentEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => (
    !TREATMENT_EXACT.has(name)
    && !TREATMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
  )));
}

function commonConfig() {
  return [
    "[mcp_servers.xcode]",
    'command = "/usr/bin/xcrun"',
    'args = ["mcpbridge"]',
    "",
  ].join("\n");
}

async function successful(capture, argv, options, context) {
  const result = await capture(argv, options);
  if (result.exitCode !== 0) {
    fail("E_CODEX_HOME_COMMAND", `${context} exited with ${result.exitCode}: ${result.stderr.trim()}`);
  }
  return result;
}

function discoverClaudeMemMarketplace(pluginList) {
  const match = pluginList.match(
    /^claude-mem@claude-mem-local\s+installed,\s+enabled\s+13\.15\.3\s+(.+)$/m,
  );
  if (!match) fail("E_CODEX_HOME_CLAUDE_MEM", "operator home lacks enabled Claude-Mem 13.15.3");
  const pluginPath = resolve(match[1].trim());
  if (basename(pluginPath) !== "plugin") {
    fail("E_CODEX_HOME_CLAUDE_MEM", "Claude-Mem source is not a local marketplace plugin path");
  }
  return dirname(pluginPath);
}

function validateCLIInventory(armId, pluginList, mcpList) {
  if (!/^xcode\s+\/usr\/bin\/xcrun\s+mcpbridge\b.*\benabled\b/m.test(mcpList)) {
    fail("E_CODEX_HOME_XCODE_MCP", `${armId} did not expose /usr/bin/xcrun mcpbridge`);
  }
  const enabledPlugins = pluginList.split("\n").filter((line) => /installed,\s+enabled/.test(line));
  const hasMemoryPlugin = enabledPlugins.some((line) => line.startsWith(CLAUDE_MEM_PLUGIN));
  const hasMemoryMCP = /^mcp-search\s+/m.test(mcpList);
  if (armId === ARM_D) {
    if (!hasMemoryPlugin || !hasMemoryMCP || !pluginList.includes("13.15.3")) {
      fail("E_CODEX_HOME_CLAUDE_MEM", "arm D lacks its pinned Claude-Mem plugin or MCP server");
    }
  } else if (hasMemoryPlugin || hasMemoryMCP || enabledPlugins.length !== 0) {
    fail("E_CODEX_HOME_ISOLATION", `${armId} inherited a treatment plugin or memory MCP`);
  }
}

export async function prepareCodexHomes(manifest, context, options = {}) {
  const capture = options.capture ?? captureCommand;
  const sourceCodexHome = resolve(options.sourceCodexHome ?? join(homedir(), ".codex"));
  const sourceAuth = join(sourceCodexHome, "auth.json");
  const authMetadata = await stat(sourceAuth);
  if (!authMetadata.isFile() || (authMetadata.mode & 0o077) !== 0) {
    fail("E_CODEX_HOME_AUTH", "operator auth.json must be a private regular file");
  }
  const cleanHost = scrubTreatmentEnvironment(process.env);
  const codex = manifest.agentCommand[0];
  const bridge = await successful(
    capture,
    ["/usr/bin/xcrun", "mcpbridge", "--help"],
    { env: cleanHost, timeoutMs: 30_000 },
    "xcode MCP bridge preflight",
  );
  if (!bridge.stdout.includes("STDIO Bridge for Xcode MCP Tools")) {
    fail("E_CODEX_HOME_XCODE_MCP", "xcrun mcpbridge did not identify the Xcode MCP bridge");
  }

  const operatorPlugins = await successful(
    capture,
    [codex, "plugin", "list"],
    { env: { ...cleanHost, CODEX_HOME: sourceCodexHome }, timeoutMs: 30_000 },
    "operator Claude-Mem discovery",
  );
  const marketplace = discoverClaudeMemMarketplace(operatorPlugins.stdout);
  const homesRoot = join(context.runDirectory, "codex-homes");
  await mkdir(homesRoot, { mode: 0o700 });
  const records = {};

  for (const arm of manifest.arms) {
    const home = join(homesRoot, arm.id);
    await mkdir(home, { mode: 0o700 });
    const configPath = join(home, "config.toml");
    await writeFile(configPath, commonConfig(), { flag: "wx", mode: 0o600 });
    await symlink(sourceAuth, join(home, "auth.json"));
    const environment = { ...cleanHost, CODEX_HOME: home };

    if (arm.id === ARM_D) {
      await successful(
        capture,
        [codex, "plugin", "marketplace", "add", marketplace, "--json"],
        { cwd: arm.worktree, env: environment, timeoutMs: 60_000 },
        "arm D marketplace provisioning",
      );
      await successful(
        capture,
        [codex, "plugin", "add", CLAUDE_MEM_PLUGIN, "--json"],
        { cwd: arm.worktree, env: environment, timeoutMs: 60_000 },
        "arm D Claude-Mem provisioning",
      );
      await chmod(configPath, 0o600);
    }

    const pluginResult = await successful(
      capture,
      [codex, "plugin", "list"],
      { cwd: arm.worktree, env: environment, timeoutMs: 30_000 },
      `${arm.id} plugin inventory`,
    );
    const mcpResult = await successful(
      capture,
      [codex, "mcp", "list"],
      { cwd: arm.worktree, env: environment, timeoutMs: 30_000 },
      `${arm.id} MCP inventory`,
    );
    validateCLIInventory(arm.id, pluginResult.stdout, mcpResult.stdout);
    const config = await readFile(configPath, "utf8");
    const record = {
      home,
      configPath,
      configSHA256: `sha256:${createHash("sha256").update(config).digest("hex")}`,
      authentication: "private symlink to operator auth; contents never copied or ledgered",
      xcodeMCP: { command: "/usr/bin/xcrun", args: ["mcpbridge"], verified: true },
      claudeMemEnabled: arm.id === ARM_D,
      claudeMemVersion: arm.id === ARM_D ? "13.15.3" : null,
      cliInventory: {
        xcodeMCP: true,
        mcpSearch: /^mcp-search\s+/m.test(mcpResult.stdout),
        enabledPluginCount: pluginResult.stdout.split("\n")
          .filter((line) => /installed,\s+enabled/.test(line)).length,
      },
    };
    records[arm.id] = record;
    await context.ledger.emit("codex_home.provisioned", { armId: arm.id, ...record });
  }
  return records;
}
