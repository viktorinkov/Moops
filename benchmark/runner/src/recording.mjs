import { stat } from "node:fs/promises";

import { captureCommand } from "./process.mjs";

export async function convertCompositeRecording(conversion, options = {}) {
  const capture = options.capture ?? captureCommand;
  const statFile = options.statFile ?? stat;
  let command;
  let commandError = null;
  try {
    command = await capture(conversion.argv, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeoutMs: options.timeoutMs ?? 300_000,
    });
  } catch (cause) {
    commandError = cause instanceof Error ? cause.message : String(cause);
  }
  let metadata;
  let fileError = null;
  try {
    metadata = await statFile(conversion.output);
  } catch (cause) {
    fileError = cause instanceof Error ? cause.message : String(cause);
  }
  const sizeBytes = metadata?.size ?? null;
  const regularFile = metadata?.isFile?.() === true;
  const ok = commandError === null
    && command?.exitCode === 0
    && command?.signal == null
    && regularFile
    && Number.isSafeInteger(sizeBytes)
    && sizeBytes > 0;
  return {
    source: conversion.source,
    output: conversion.output,
    argv: conversion.argv,
    exitCode: command?.exitCode ?? null,
    signal: command?.signal ?? null,
    stderr: command?.stderr ?? null,
    commandError,
    fileError,
    regularFile,
    sizeBytes,
    ok,
  };
}
