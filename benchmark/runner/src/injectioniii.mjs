import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { captureCommand } from "./process.mjs";

export const INJECTION_ARM_ID = "codex-injection";

export class InjectionRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InjectionRunnerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new InjectionRunnerError(code, message);
}

function inside(root, target) {
  const fragment = relative(resolve(root), resolve(target));
  return fragment !== "" && fragment !== ".." && !fragment.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(fragment);
}

async function requireReceipt(path, expectedPhase) {
  let source;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size === 0) fail("E_INJECTION_RECEIPT", `${expectedPhase} receipt is not a non-empty regular file`);
    source = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof InjectionRunnerError) throw cause;
    fail("E_INJECTION_RECEIPT", `cannot read ${expectedPhase} receipt: ${cause.message}`);
  }
  let receipt;
  try {
    receipt = JSON.parse(source);
  } catch (cause) {
    fail("E_INJECTION_RECEIPT", `${expectedPhase} receipt is invalid JSON: ${cause.message}`);
  }
  if (receipt?.ok !== true || receipt.phase !== expectedPhase || receipt.reportVersion !== 1) {
    fail("E_INJECTION_RECEIPT", `${expectedPhase} did not return a passing v1 receipt`);
  }
  return receipt;
}

function requireCommandSuccess(result, context) {
  if (result?.exitCode !== 0 || result?.signal != null || result?.timedOut || result?.spawnError) {
    fail("E_INJECTION_COMMAND", `${context} failed: ${result?.stderr?.trim?.() ?? "unknown error"}`);
  }
}

export async function prepareInjectionIIIArm(manifest, context, options = {}) {
  const arm = manifest.arms.find(({ id }) => id === INJECTION_ARM_ID);
  if (!arm) fail("E_INJECTION_ARM", "arm C is missing");
  const outputPath = join(context.resultDirectory, "injection-preflight.json");
  const helperPath = join(arm.worktree, "benchmark/injectioniii/injectioniii-evidence.mjs");
  const argv = [
    process.execPath, helperPath, "preflight",
    "--worktree", arm.worktree,
    "--derived-data", arm.derivedData,
    "--output", outputPath,
  ];
  const capture = options.capture ?? captureCommand;
  const result = await capture(argv, { cwd: arm.worktree, env: process.env, timeoutMs: 30_000 });
  requireCommandSuccess(result, "InjectionIII preflight");
  const receipt = await requireReceipt(outputPath, "preflight");
  if (resolve(receipt.worktree ?? "") !== resolve(arm.worktree)
    || resolve(receipt.derivedData ?? "") !== resolve(arm.derivedData)
    || receipt.injectionIII?.version !== "5.2.1") {
    fail("E_INJECTION_RECEIPT", "preflight receipt does not bind arm C and InjectionIII 5.2.1");
  }
  const prepared = { ...receipt, outputPath, helperPath };
  await context.ledger.emit("injection.preflight.passed", {
    armId: arm.id,
    outputPath,
    host: receipt.host,
    control: receipt.control,
    injectionIII: receipt.injectionIII,
  });
  return prepared;
}

function latestAppPID(commands) {
  let pid = null;
  for (const command of commands ?? []) {
    if (command.status !== "completed" || command.exitCode !== 0
      || typeof command.command !== "string"
      || !/(?:^|\s)(?:\/usr\/bin\/)?xcrun\s+simctl\s+launch(?:\s|$)/.test(command.command)) continue;
    const matches = [...String(command.aggregatedOutput ?? "").matchAll(/(?:^|\n)[^\n]*:\s*([1-9][0-9]*)\s*(?=\n|$)/g)];
    if (matches.length > 0) pid = Number(matches.at(-1)[1]);
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    fail("E_INJECTION_APP_PID", "arm C has no successful simctl launch receipt with an app PID");
  }
  return pid;
}

async function deriveStructuralFallback(prepared, context) {
  const addedSources = [];
  for (const item of context.command.fileChanges ?? []) {
    if (item.status !== "completed") continue;
    for (const change of item.changes ?? []) {
      if (change.kind?.type !== "add" || typeof change.path !== "string" || !change.path.endsWith(".swift")) continue;
      const path = isAbsolute(change.path) ? resolve(change.path) : resolve(context.arm.worktree, change.path);
      if (inside(context.arm.worktree, path)) addedSources.push(path);
    }
  }
  if (addedSources.length === 0) return null;
  const build = [...(context.command.commands ?? [])].reverse().find((command) => (
    command.status === "completed"
    && command.exitCode === 0
    && Number.isSafeInteger(command.completedEpochMs)
    && command.completedEpochMs >= prepared.observedEpochMs
    && typeof command.command === "string"
    && /(?:^|\s)(?:\/usr\/bin\/)?xcrun\s+xcodebuild(?:\s|$)|(?:^|\s)xcodebuild(?:\s|$)/.test(command.command)
    && command.command.includes("-derivedDataPath")
    && command.command.includes(context.arm.derivedData)
  ));
  if (!build) return null;
  const fallback = {
    schemaVersion: 1,
    kind: "structural-fallback",
    reason: "added-source-file",
    sourcePaths: [...new Set(addedSources)],
    normalBuild: {
      argv: ["/usr/bin/xcrun", "xcodebuild", "build", "-derivedDataPath", context.arm.derivedData],
      exitCode: 0,
      completedEpochMs: build.completedEpochMs,
    },
  };
  const path = join(context.resultDirectory, "injection-structural-fallback.json");
  await writeFile(path, `${JSON.stringify(fallback, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { path, receipt: fallback, rawBuildCommand: build.command };
}

export async function verifyInjectionIIIArm(prepared, context, options = {}) {
  const appPid = latestAppPID(context.command.commands);
  const fallback = await deriveStructuralFallback(prepared, context);
  const outputPath = join(context.resultDirectory, "injection-postflight.json");
  const argv = [
    process.execPath, prepared.helperPath, "postflight",
    "--preflight", prepared.outputPath,
    "--app-pid", String(appPid),
    ...(fallback ? ["--fallback-evidence", fallback.path] : []),
    "--output", outputPath,
  ];
  const capture = options.capture ?? captureCommand;
  const result = await capture(argv, { cwd: context.arm.worktree, env: process.env, timeoutMs: 30_000 });
  requireCommandSuccess(result, "InjectionIII postflight");
  const receipt = await requireReceipt(outputPath, "postflight");
  if (receipt.app?.pid !== appPid) fail("E_INJECTION_RECEIPT", "postflight receipt belongs to another app PID");
  const evidence = {
    ...receipt,
    outputPath,
    preflightPath: prepared.outputPath,
    fallback: fallback ? {
      path: fallback.path,
      reason: fallback.receipt.reason,
      sourcePaths: fallback.receipt.sourcePaths,
      rawBuildCommand: fallback.rawBuildCommand,
    } : null,
  };
  await context.ledger.emit("injection.postflight.passed", {
    armId: context.arm.id,
    outputPath,
    app: receipt.app,
    proof: receipt.proof,
    fallback: evidence.fallback,
  });
  return evidence;
}

