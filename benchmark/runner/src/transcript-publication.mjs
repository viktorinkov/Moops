import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JSONL_TRANSCRIPTS = ["agent.requests.jsonl", "agent.stdout.jsonl"];
const PLAIN_TRANSCRIPTS = ["agent.stderr.log"];
const ARM_RESULT = "arm-result.json";
const SENSITIVE_KEYS = new Set([
  "apikey",
  "authorization",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "privatekey",
]);

export class TranscriptPublicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TranscriptPublicationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TranscriptPublicationError(code, message);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isSensitiveKey(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_KEYS.has(normalized);
}

function replaceCount(value, expression, replacement, counter) {
  return value.replace(expression, (...args) => {
    counter.count += 1;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
}

function sanitizeText(source, context, counter) {
  let value = source;
  for (const secret of context.secretValues) {
    if (!value.includes(secret)) continue;
    const fragments = value.split(secret);
    counter.count += fragments.length - 1;
    value = fragments.join("<REDACTED>");
  }
  for (const mapping of context.pathMappings) {
    if (!mapping.from || !value.includes(mapping.from)) continue;
    const fragments = value.split(mapping.from);
    counter.count += fragments.length - 1;
    value = fragments.join(mapping.to);
  }

  value = replaceCount(
    value,
    /\/Users\/[A-Za-z0-9._-]+(?=\/|\b)/g,
    "<HOME>",
    counter,
  );
  value = replaceCount(
    value,
    /\/(?:private\/)?tmp\/[^\s"'\\]+/g,
    (match) => `<TMP>/${basename(match)}`,
    counter,
  );
  value = replaceCount(
    value,
    /\/(?:private\/)?var\/folders\/[^\s"'\\]+/g,
    (match) => `<TMP>/${basename(match)}`,
    counter,
  );
  value = replaceCount(
    value,
    /\/(?:opt\/homebrew|Volumes)\/[^\s"'\\]+/g,
    (match) => `<MACHINE_PATH>/${basename(match)}`,
    counter,
  );
  value = replaceCount(
    value,
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
    "<REDACTED>",
    counter,
  );
  value = replaceCount(
    value,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    "Bearer <REDACTED>",
    counter,
  );
  value = replaceCount(
    value,
    /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_=-]{6,}/g,
    "<REDACTED>",
    counter,
  );
  value = replaceCount(
    value,
    /\b((?:OPENAI_API_KEY|ANTHROPIC_API_KEY|API[_-]?KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|TOKEN|AUTHORIZATION|PASSWORD|PASSWD|CLIENT_SECRET|CLIENTSECRET|SECRET|COOKIE)["']?\s*[:=]\s*)(["']?)([^\s"',}\]]+)/gi,
    (_match, prefix, quote) => `${prefix}${quote}<REDACTED>`,
    counter,
  );
  return value;
}

function sanitizeValue(value, context, counter, key = null) {
  if (key !== null && isSensitiveKey(key)) {
    counter.count += 1;
    return "<REDACTED>";
  }
  if (typeof value === "string") return sanitizeText(value, context, counter);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, context, counter));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      sanitizeValue(entry, context, counter, entryKey),
    ]));
  }
  return value;
}

function assertSanitized(value, context, label) {
  const forbiddenPaths = context.pathMappings.map(({ from }) => from).filter(Boolean);
  const assignment = /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|API[_-]?KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|TOKEN|AUTHORIZATION|PASSWORD|PASSWD|CLIENT_SECRET|CLIENTSECRET|SECRET|COOKIE)["']?\s*[:=]\s*["']?([^\s"',}\]]+)/gi;
  const unsafeAssignment = [...value.matchAll(assignment)]
    .some((match) => match[1] !== "<REDACTED>");
  if (context.secretValues.some((secret) => value.includes(secret))
    || forbiddenPaths.some((path) => value.includes(path))
    || /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/.test(value)
    || /\/(?:private\/)?(?:tmp|var\/folders)\//.test(value)
    || /\/(?:opt\/homebrew|Volumes)\//.test(value)
    || /-----BEGIN [^-\r\n]*PRIVATE KEY-----/.test(value)
    || /\bBearer\s+(?!<REDACTED>)[A-Za-z0-9._~+/=-]+/i.test(value)
    || /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_=-]{6,}/.test(value)
    || unsafeAssignment) {
    fail("E_TRANSCRIPT_REDACTION", `${label} retained sensitive or machine-specific content`);
  }
}

async function readBounded(path, label, options = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    fail("E_TRANSCRIPT_SOURCE", `${label} is unavailable: ${cause.message}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SOURCE_BYTES) {
    fail("E_TRANSCRIPT_SOURCE", `${label} must be a bounded regular file`);
  }
  if (metadata.size === 0 && options.allowEmpty !== true) {
    fail("E_TRANSCRIPT_EMPTY", `${label} is empty`);
  }
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents) > MAX_SOURCE_BYTES) {
    fail("E_TRANSCRIPT_SOURCE", `${label} changed while being read or exceeded the size limit`);
  }
  return contents;
}

function parseJSON(value, label) {
  try {
    return JSON.parse(value);
  } catch (cause) {
    fail("E_TRANSCRIPT_FORMAT", `${label} is not valid JSON: ${cause.message}`);
  }
}

function sanitizeJSON(value, context, label) {
  const counter = { count: 0 };
  const sanitized = sanitizeValue(parseJSON(value, label), context, counter);
  const output = `${JSON.stringify(sanitized, null, 2)}\n`;
  assertSanitized(output, context, label);
  return { output, redactions: counter.count };
}

function sanitizeJSONL(value, context, label) {
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.trim() === "")) {
    fail("E_TRANSCRIPT_FORMAT", `${label} contains an empty JSONL record`);
  }
  const counter = { count: 0 };
  const sanitized = lines.map((line, index) => {
    const parsed = parseJSON(line, `${label} line ${index + 1}`);
    return JSON.stringify(sanitizeValue(parsed, context, counter));
  }).join("\n");
  const output = `${sanitized}\n`;
  assertSanitized(output, context, label);
  return { output, redactions: counter.count, records: lines.length };
}

function sanitizePlain(value, context, label) {
  const counter = { count: 0 };
  const output = sanitizeText(value, context, counter);
  assertSanitized(output, context, label);
  return { output, redactions: counter.count };
}

function pathContext(manifest, runId, environment) {
  const runDirectory = join(manifest.runRoot, "benchmark-runs", runId);
  const mappings = [
    ...manifest.arms.flatMap((arm) => [
      { from: join(arm.results, runId), to: `<ARM_RUN:${arm.id}>` },
      { from: arm.derivedData, to: `<DERIVED_DATA:${arm.id}>` },
      { from: arm.worktree, to: `<WORKTREE:${arm.id}>` },
      { from: arm.results, to: `<ARM_RESULTS:${arm.id}>` },
    ]),
    { from: runDirectory, to: "<PRIVATE_RUN>" },
    { from: manifest.runRoot, to: "<RUN_ROOT>" },
    { from: manifest.repositoryRoot, to: "<REPOSITORY>" },
  ];
  mappings.sort((left, right) => right.from.length - left.from.length);
  const secretValues = Object.entries(environment ?? {})
    .filter(([name, value]) => (
      /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTHORIZATION|COOKIE|CREDENTIAL|PRIVATE_KEY)/i.test(name)
      && typeof value === "string"
      && value.length >= 8
    ))
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  return { pathMappings: mappings, runDirectory, secretValues: [...new Set(secretValues)] };
}

function assertManifest(manifest) {
  if (typeof manifest?.repositoryRoot !== "string"
    || typeof manifest?.runRoot !== "string"
    || !Array.isArray(manifest?.arms)
    || manifest.arms.length !== 4) {
    fail("E_TRANSCRIPT_MANIFEST", "publication requires a normalized four-arm manifest");
  }
  for (const arm of manifest.arms) {
    if (typeof arm.id !== "string"
      || !SAFE_RUN_ID.test(arm.id)
      || typeof arm.label !== "string"
      || typeof arm.results !== "string"
      || typeof arm.worktree !== "string"
      || typeof arm.derivedData !== "string") {
      fail("E_TRANSCRIPT_MANIFEST", "publication manifest omitted an arm evidence path");
    }
  }
  if (new Set(manifest.arms.map(({ id }) => id)).size !== manifest.arms.length) {
    fail("E_TRANSCRIPT_MANIFEST", "publication manifest contains duplicate arm IDs");
  }
}

async function assertDestinationAbsent(destination) {
  try {
    await lstat(destination);
  } catch (cause) {
    if (cause?.code === "ENOENT") return;
    fail("E_TRANSCRIPT_DESTINATION", `cannot inspect public bundle destination: ${cause.message}`);
  }
  fail("E_TRANSCRIPT_EXISTS", `public transcript bundle already exists for ${basename(destination)}`);
}

async function writePublishedFile(root, relativePath, source, sanitized, metadata = {}) {
  const destination = join(root, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, sanitized.output, { flag: "wx", mode: 0o644 });
  return {
    path: relativePath,
    bytes: Buffer.byteLength(sanitized.output),
    records: metadata.records ?? sanitized.records ?? null,
    redactions: sanitized.redactions,
    sourceSHA256: sha256(source),
    publishedSHA256: sha256(sanitized.output),
  };
}

export async function publishTranscripts(manifest, runId, options = {}) {
  assertManifest(manifest);
  if (!SAFE_RUN_ID.test(runId ?? "")) {
    fail("E_TRANSCRIPT_RUN_ID", "runId must use 1 through 64 safe filename characters");
  }
  const context = pathContext(manifest, runId, options.environment ?? process.env);
  const publicParent = join(manifest.repositoryRoot, "results", "runs");
  const destination = join(publicParent, runId);
  await mkdir(publicParent, { recursive: true });
  await assertDestinationAbsent(destination);

  const temporary = join(publicParent, `.publish-${runId}-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  const files = [];
  const arms = [];
  try {
    const summarySource = await readBounded(join(context.runDirectory, "summary.json"), "run summary");
    const summaryParsed = parseJSON(summarySource, "run summary");
    if (summaryParsed?.runId !== runId) fail("E_TRANSCRIPT_FORMAT", "run summary ID does not match runId");
    files.push(await writePublishedFile(
      temporary,
      "summary.json",
      summarySource,
      sanitizeJSON(summarySource, context, "run summary"),
    ));

    const eventsSource = await readBounded(join(context.runDirectory, "events.jsonl"), "run events");
    files.push(await writePublishedFile(
      temporary,
      "events.jsonl",
      eventsSource,
      sanitizeJSONL(eventsSource, context, "run events"),
    ));

    for (const arm of manifest.arms) {
      const sourceDirectory = join(arm.results, runId);
      const armFiles = [];
      for (const name of JSONL_TRANSCRIPTS) {
        const source = await readBounded(join(sourceDirectory, name), `${arm.id} ${name}`);
        const published = await writePublishedFile(
          temporary,
          join("arms", arm.id, name),
          source,
          sanitizeJSONL(source, context, `${arm.id} ${name}`),
        );
        files.push(published);
        armFiles.push(published.path);
      }
      for (const name of PLAIN_TRANSCRIPTS) {
        const source = await readBounded(
          join(sourceDirectory, name),
          `${arm.id} ${name}`,
          { allowEmpty: true },
        );
        const published = await writePublishedFile(
          temporary,
          join("arms", arm.id, name),
          source,
          sanitizePlain(source, context, `${arm.id} ${name}`),
        );
        files.push(published);
        armFiles.push(published.path);
      }
      const resultSource = await readBounded(join(sourceDirectory, ARM_RESULT), `${arm.id} ${ARM_RESULT}`);
      const resultParsed = parseJSON(resultSource, `${arm.id} ${ARM_RESULT}`);
      if (resultParsed?.id !== arm.id) {
        fail("E_TRANSCRIPT_FORMAT", `${arm.id} arm result belongs to another arm`);
      }
      const publishedResult = await writePublishedFile(
        temporary,
        join("arms", arm.id, ARM_RESULT),
        resultSource,
        sanitizeJSON(resultSource, context, `${arm.id} ${ARM_RESULT}`),
      );
      files.push(publishedResult);
      armFiles.push(publishedResult.path);
      arms.push({ id: arm.id, label: arm.label, files: armFiles });
    }

    const bundle = {
      bundleVersion: 1,
      runId,
      sanitized: true,
      preserves: ["wall-clock timing", "monotonic timing", "failures", "tool and Goal events"],
      redacts: ["credential-shaped values", "authorization material", "machine-specific paths"],
      arms,
      files,
      totalRedactions: files.reduce((sum, file) => sum + file.redactions, 0),
    };
    const bundleOutput = `${JSON.stringify(bundle, null, 2)}\n`;
    assertSanitized(bundleOutput, context, "public bundle manifest");
    await writeFile(join(temporary, "bundle.json"), bundleOutput, { flag: "wx", mode: 0o644 });

    await assertDestinationAbsent(destination);
    try {
      await rename(temporary, destination);
    } catch (cause) {
      if (["EEXIST", "ENOTEMPTY"].includes(cause?.code)) {
        fail("E_TRANSCRIPT_EXISTS", `public transcript bundle already exists for ${runId}`);
      }
      throw cause;
    }
    return {
      ok: true,
      runId,
      outputDirectory: destination,
      bundlePath: join(destination, "bundle.json"),
      arms,
      fileCount: files.length + 1,
      totalRedactions: bundle.totalRedactions,
    };
  } catch (cause) {
    await rm(temporary, { recursive: true, force: true });
    throw cause;
  }
}
