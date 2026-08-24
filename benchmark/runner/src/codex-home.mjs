import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { captureCommand } from "./process.mjs";

const ARM_D = "codex-moops-claudemem";
const CLAUDE_MEM_PLUGIN = "claude-mem@claude-mem-local";
const CLAUDE_MEM_VERSION = "13.15.3";
const CLAUDE_MEM_CACHE_PATH = `plugins/cache/claude-mem-local/claude-mem/${CLAUDE_MEM_VERSION}`;
const CLAUDE_MEM_LOCK_SHA256 = "sha256:f2838926f106d16a128d3aeb3a3adc7ecc72e92dfd4f12fb3f1c9a9255ed11c6";
const CLAUDE_MEM_ZOD_VERSION = "4.4.3";
const TREATMENT_EXACT = new Set([
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CODEX_HOME",
  "INJECTION_CONTROL_SOCKET",
  "MCP_XCODE_PID",
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

async function runtimeMetadata(pluginRoot, context) {
  let packageBody;
  let lock;
  try {
    [packageBody, lock] = await Promise.all([
      readFile(join(pluginRoot, "package.json"), "utf8"),
      readFile(join(pluginRoot, "bun.lock")),
    ]);
  } catch (cause) {
    fail("E_CODEX_HOME_CLAUDE_MEM_RUNTIME", `${context} metadata is unavailable: ${cause.message}`);
  }
  let packageJson;
  try {
    packageJson = JSON.parse(packageBody);
  } catch (cause) {
    fail("E_CODEX_HOME_CLAUDE_MEM_RUNTIME", `${context} package.json is invalid: ${cause.message}`);
  }
  if (packageJson.name !== "claude-mem-plugin" || packageJson.version !== CLAUDE_MEM_VERSION) {
    fail(
      "E_CODEX_HOME_CLAUDE_MEM_RUNTIME",
      `${context} must be claude-mem-plugin ${CLAUDE_MEM_VERSION}`,
    );
  }
  return {
    lockSHA256: `sha256:${createHash("sha256").update(lock).digest("hex")}`,
  };
}

async function validateDependencyRoot(pluginRoot, context) {
  const nodeModules = join(pluginRoot, "node_modules");
  let modulesMetadata;
  try {
    modulesMetadata = await lstat(nodeModules);
  } catch (cause) {
    fail("E_CODEX_HOME_CLAUDE_MEM_RUNTIME", `${context} node_modules is unavailable: ${cause.message}`);
  }
  if (!modulesMetadata.isDirectory() && !modulesMetadata.isSymbolicLink()) {
    fail("E_CODEX_HOME_CLAUDE_MEM_RUNTIME", `${context} node_modules is not a directory binding`);
  }
  let modulesRealPath;
  let zodV3Entry;
  let zodPackage;
  try {
    modulesRealPath = await realpath(nodeModules);
    const runtimeRequire = createRequire(join(pluginRoot, ".moops-runtime-probe.cjs"));
    zodV3Entry = await realpath(runtimeRequire.resolve("zod/v3"));
    zodPackage = JSON.parse(await readFile(join(modulesRealPath, "zod/package.json"), "utf8"));
  } catch (cause) {
    fail(
      "E_CODEX_HOME_CLAUDE_MEM_RUNTIME",
      `${context} cannot resolve the required zod/v3 runtime: ${cause.message}`,
    );
  }
  if (!zodV3Entry.startsWith(`${modulesRealPath}${sep}`)
    || zodPackage.name !== "zod"
    || zodPackage.version !== CLAUDE_MEM_ZOD_VERSION) {
    fail(
      "E_CODEX_HOME_CLAUDE_MEM_RUNTIME",
      `${context} did not resolve pinned zod/v3 ${CLAUDE_MEM_ZOD_VERSION}`,
    );
  }
  return { nodeModules, modulesRealPath, zodV3Entry, zodVersion: zodPackage.version };
}

export async function bindClaudeMemRuntime({
  sourcePluginRoot,
  isolatedPluginRoot,
  requiredLockSHA256 = CLAUDE_MEM_LOCK_SHA256,
} = {}) {
  if (typeof sourcePluginRoot !== "string"
    || typeof isolatedPluginRoot !== "string"
    || resolve(sourcePluginRoot) !== sourcePluginRoot
    || resolve(isolatedPluginRoot) !== isolatedPluginRoot
    || sourcePluginRoot === isolatedPluginRoot) {
    fail(
      "E_CODEX_HOME_CLAUDE_MEM_RUNTIME",
      "distinct absolute source and isolated Claude-Mem plugin roots are required",
    );
  }
  const [sourceMetadata, isolatedMetadata] = await Promise.all([
    runtimeMetadata(sourcePluginRoot, "operator Claude-Mem runtime"),
    runtimeMetadata(isolatedPluginRoot, "isolated Claude-Mem plugin"),
  ]);
  if (sourceMetadata.lockSHA256 !== isolatedMetadata.lockSHA256) {
    fail(
      "E_CODEX_HOME_CLAUDE_MEM_RUNTIME",
      "operator and isolated Claude-Mem bun.lock fingerprints differ",
    );
  }
  if (sourceMetadata.lockSHA256 !== requiredLockSHA256) {
    fail(
      "E_CODEX_HOME_CLAUDE_MEM_RUNTIME",
      `Claude-Mem bun.lock must match the pinned ${CLAUDE_MEM_VERSION} fingerprint`,
    );
  }
  const source = await validateDependencyRoot(sourcePluginRoot, "operator Claude-Mem runtime");
  const isolatedNodeModules = join(isolatedPluginRoot, "node_modules");
  let kind = "isolated-node-modules";
  try {
    await lstat(isolatedNodeModules);
  } catch (cause) {
    if (cause.code !== "ENOENT") {
      fail("E_CODEX_HOME_CLAUDE_MEM_RUNTIME", `cannot inspect isolated node_modules: ${cause.message}`);
    }
    await symlink(source.modulesRealPath, isolatedNodeModules, "dir");
    kind = "pinned-node-modules-symlink";
  }
  const isolated = await validateDependencyRoot(isolatedPluginRoot, "isolated Claude-Mem runtime");
  if (isolated.modulesRealPath !== source.modulesRealPath && kind === "pinned-node-modules-symlink") {
    fail("E_CODEX_HOME_CLAUDE_MEM_RUNTIME", "isolated dependency binding resolved unexpectedly");
  }
  if (isolated.zodVersion !== source.zodVersion) {
    fail("E_CODEX_HOME_CLAUDE_MEM_RUNTIME", "isolated zod version differs from the pinned runtime");
  }
  return {
    kind,
    version: CLAUDE_MEM_VERSION,
    lockSHA256: sourceMetadata.lockSHA256,
    sourcePluginRoot,
    sourceNodeModules: source.modulesRealPath,
    isolatedPluginRoot,
    isolatedNodeModules,
    zodV3Entry: isolated.zodV3Entry,
    zodVersion: isolated.zodVersion,
  };
}

export function scrubTreatmentEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => (
    !TREATMENT_EXACT.has(name)
    && !TREATMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
  )));
}

function commonConfig(xcodePid) {
  if (!/^[1-9][0-9]*$/.test(xcodePid ?? "")) {
    fail("E_CODEX_HOME_XCODE_PID", "each arm requires a positive MCP_XCODE_PID");
  }
  return [
    "[mcp_servers.xcode]",
    'command = "/usr/bin/xcrun"',
    'args = ["mcpbridge"]',
    "",
    "[mcp_servers.xcode.env]",
    `MCP_XCODE_PID = "${xcodePid}"`,
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
  const bindRuntime = options.bindRuntime ?? bindClaudeMemRuntime;
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
    await writeFile(configPath, commonConfig(arm.environment?.MCP_XCODE_PID), { flag: "wx", mode: 0o600 });
    await symlink(sourceAuth, join(home, "auth.json"));
    const environment = { ...cleanHost, CODEX_HOME: home };
    let claudeMemRuntime = null;

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
      claudeMemRuntime = await bindRuntime({
        sourcePluginRoot: join(sourceCodexHome, CLAUDE_MEM_CACHE_PATH),
        isolatedPluginRoot: join(home, CLAUDE_MEM_CACHE_PATH),
      });
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
      xcodeMCP: {
        command: "/usr/bin/xcrun",
        args: ["mcpbridge"],
        processId: Number(arm.environment.MCP_XCODE_PID),
        verified: true,
      },
      claudeMemEnabled: arm.id === ARM_D,
      claudeMemVersion: arm.id === ARM_D ? "13.15.3" : null,
      claudeMemRuntime,
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
