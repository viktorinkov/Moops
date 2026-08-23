#!/usr/bin/env node

import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  InjectionEvidenceError,
  collectPostflightEvidence,
  collectPreflightEvidence,
} from "./evidence.mjs";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const OPTION_NAMES = new Map([
  ["--worktree", "worktree"],
  ["--derived-data", "derivedData"],
  ["--injection-app", "injectionAppPath"],
  ["--control-socket", "controlSocketPath"],
  ["--output", "outputPath"],
  ["--preflight", "preflightPath"],
  ["--app-pid", "appPid"],
  ["--fallback-evidence", "fallbackPath"],
]);

function fail(message) {
  throw new InjectionEvidenceError("E_INJECTION_CLI", message);
}

function requireOnly(parsed, permitted) {
  for (const key of Object.keys(parsed)) {
    if (key !== "command" && !permitted.has(key)) {
      fail(`${key} is not valid for ${parsed.command}`);
    }
  }
}

export function parseArguments(argv) {
  if (!Array.isArray(argv) || (argv[0] !== "preflight" && argv[0] !== "postflight")) {
    fail("expected preflight or postflight");
  }
  const parsed = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const key = OPTION_NAMES.get(option);
    if (!key) fail(`unknown option ${JSON.stringify(option)}`);
    if (Object.hasOwn(parsed, key)) fail(`${option} may be provided only once`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value === "" || value.startsWith("--")) {
      fail(`${option} requires one value`);
    }
    parsed[key] = value;
    index += 1;
  }

  if (parsed.command === "preflight") {
    requireOnly(parsed, new Set([
      "worktree", "derivedData", "injectionAppPath", "controlSocketPath", "outputPath",
    ]));
    if (!parsed.worktree) fail("preflight requires --worktree");
    return parsed;
  }

  requireOnly(parsed, new Set(["preflightPath", "appPid", "fallbackPath", "outputPath"]));
  if (!parsed.preflightPath) fail("postflight requires --preflight");
  if (!/^[1-9][0-9]*$/.test(parsed.appPid ?? "")) {
    fail("--app-pid must be a positive integer");
  }
  parsed.appPid = Number(parsed.appPid);
  if (!Number.isSafeInteger(parsed.appPid)) fail("--app-pid must be a positive integer");
  return parsed;
}

export async function readJSONReceipt(path) {
  const target = resolve(path);
  let metadata;
  try {
    metadata = await stat(target);
  } catch (cause) {
    fail(`cannot stat ${target}: ${cause.message}`);
  }
  if (!metadata.isFile()) fail(`${target} is not a regular file`);
  if (metadata.size > MAX_RECEIPT_BYTES) fail(`${target} exceeds 1 MiB`);
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (cause) {
    fail(`${target} is not valid JSON: ${cause.message}`);
  }
}

function errorReport(command, cause) {
  return {
    reportVersion: 1,
    phase: command === "preflight" || command === "postflight" ? command : "admission",
    ok: false,
    error: {
      code: typeof cause?.code === "string" ? cause.code : "E_INJECTION_INTERNAL",
      message: cause instanceof Error ? cause.message : String(cause),
    },
  };
}

export async function runCLI(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? ((source) => process.stdout.write(source));
  const collectPreflight = dependencies.collectPreflight ?? collectPreflightEvidence;
  const collectPostflight = dependencies.collectPostflight ?? collectPostflightEvidence;
  const readJSON = dependencies.readJSON ?? readJSONReceipt;
  const writeReceipt = dependencies.writeFile ?? writeFile;
  let parsed;
  try {
    parsed = parseArguments(argv);
    let report;
    if (parsed.command === "preflight") {
      report = await collectPreflight({
        worktree: parsed.worktree,
        ...(parsed.derivedData ? { derivedData: parsed.derivedData } : {}),
        ...(parsed.injectionAppPath ? { injectionAppPath: parsed.injectionAppPath } : {}),
        ...(parsed.controlSocketPath ? { controlSocketPath: parsed.controlSocketPath } : {}),
      });
    } else {
      const preflight = await readJSON(parsed.preflightPath);
      const fallbackEvidence = parsed.fallbackPath
        ? await readJSON(parsed.fallbackPath)
        : undefined;
      report = await collectPostflight({
        preflight,
        appPid: parsed.appPid,
        ...(fallbackEvidence ? { fallbackEvidence } : {}),
      });
    }
    const source = `${JSON.stringify(report, null, 2)}\n`;
    if (parsed.outputPath) {
      await writeReceipt(parsed.outputPath, source, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    stdout(source);
    return 0;
  } catch (cause) {
    stdout(`${JSON.stringify(errorReport(parsed?.command ?? argv?.[0], cause), null, 2)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCLI(process.argv.slice(2));
}
