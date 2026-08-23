#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  VisualTilerError,
  tileSimulatorWindows,
} from "./tile.mjs";

const OPTION_NAMES = new Map([
  ["--x", "x"],
  ["--y", "y"],
  ["--width", "width"],
  ["--height", "height"],
  ["--a-title", "aTitle"],
  ["--b-title", "bTitle"],
  ["--c-title", "cTitle"],
  ["--d-title", "dTitle"],
  ["--output", "outputPath"],
]);

function fail(message) {
  throw new VisualTilerError("E_VISUAL_CLI", message);
}

function integerOption(parsed, option, { positive = false } = {}) {
  const value = parsed[OPTION_NAMES.get(option)];
  const pattern = positive ? /^[1-9][0-9]*$/ : /^-?(?:0|[1-9][0-9]*)$/;
  if (!pattern.test(value ?? "")) fail(`${option} must be an integer${positive ? " greater than zero" : ""}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail(`${option} must be an integer`);
  return number;
}

export function parseArguments(argv) {
  if (!Array.isArray(argv)) fail("arguments must be an array");
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const key = OPTION_NAMES.get(option);
    if (!key) fail(`unknown option ${JSON.stringify(option)}`);
    if (Object.hasOwn(parsed, key)) fail(`${option} may be provided only once`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(`${option} requires one value`);
    }
    parsed[key] = value;
    index += 1;
  }

  for (const option of [
    "--x",
    "--y",
    "--width",
    "--height",
    "--a-title",
    "--b-title",
    "--c-title",
    "--d-title",
  ]) {
    if (!Object.hasOwn(parsed, OPTION_NAMES.get(option))) fail(`requires ${option}`);
  }

  return {
    region: {
      x: integerOption(parsed, "--x"),
      y: integerOption(parsed, "--y"),
      width: integerOption(parsed, "--width", { positive: true }),
      height: integerOption(parsed, "--height", { positive: true }),
    },
    titles: {
      "codex-uitest": parsed.aTitle,
      "codex-previews": parsed.bTitle,
      "codex-injection": parsed.cTitle,
      "codex-moops-claudemem": parsed.dTitle,
    },
    ...(parsed.outputPath ? { outputPath: parsed.outputPath } : {}),
  };
}

function errorReport(cause) {
  return {
    schemaVersion: 1,
    ok: false,
    error: {
      code: typeof cause?.code === "string" ? cause.code : "E_VISUAL_INTERNAL",
      message: cause instanceof Error ? cause.message : String(cause),
    },
  };
}

export async function runCLI(argv, dependencies = {}) {
  const tile = dependencies.tile ?? tileSimulatorWindows;
  const writeReceipt = dependencies.writeFile ?? writeFile;
  const stdout = dependencies.stdout ?? ((source) => process.stdout.write(source));
  try {
    const parsed = parseArguments(argv);
    const report = await tile({ region: parsed.region, titles: parsed.titles });
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
    stdout(`${JSON.stringify(errorReport(cause), null, 2)}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCLI(process.argv.slice(2));
}
