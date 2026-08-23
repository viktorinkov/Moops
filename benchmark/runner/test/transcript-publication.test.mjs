import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ARM_DEFINITIONS } from "../src/config.mjs";
import {
  TranscriptPublicationError,
  publishTranscripts,
} from "../src/transcript-publication.mjs";

const RUN_ID = "take-public-001";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "moops-transcripts-"));
  const repositoryRoot = join(root, "repo");
  const runRoot = join(root, "private-runs");
  const runDirectory = join(runRoot, "benchmark-runs", RUN_ID);
  const arms = ARM_DEFINITIONS.map((definition) => ({
    ...definition,
    worktree: join(runRoot, "worktrees", definition.id),
    derivedData: join(runRoot, "derived", definition.id),
    results: join(runRoot, "arm-results", definition.id),
  }));
  const manifest = { repositoryRoot, runRoot, arms };
  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(runDirectory, { recursive: true }),
    ...arms.map((arm) => mkdir(join(arm.results, RUN_ID), { recursive: true })),
  ]);

  await writeFile(join(runDirectory, "summary.json"), `${JSON.stringify({
    reportVersion: 1,
    runId: RUN_ID,
    ok: false,
    startEpochMs: 1_700_000_000_000,
    endedEpochMs: 1_700_000_004_200,
    error: { code: "E_ACCEPTANCE", message: `failed in ${arms[0].worktree}` },
    summaryPath: join(runDirectory, "summary.json"),
  })}\n`);
  await writeFile(join(runDirectory, "events.jsonl"), `${JSON.stringify({
    type: "arm.completed",
    armId: arms[0].id,
    ok: false,
    epochMs: 1_700_000_004_200,
    monotonicNs: "900000004200",
    sequence: 42,
  })}\n`);

  for (const [index, arm] of arms.entries()) {
    const armDirectory = join(arm.results, RUN_ID);
    await writeFile(join(armDirectory, "agent.requests.jsonl"), `${JSON.stringify({
      id: index + 1,
      method: "thread/start",
      params: {
        cwd: arm.worktree,
        apiKey: `sk-live-secret-${index}`,
        epochMs: 1_700_000_000_000 + index,
      },
    })}\n`);
    await writeFile(join(armDirectory, "agent.stdout.jsonl"), `${JSON.stringify({
      method: "turn/completed",
      params: {
        armId: arm.id,
        status: index === 0 ? "failed" : "completed",
        message: `Authorization: Bearer live-token-${index} at ${arm.derivedData}`,
      },
    })}\n`);
    await writeFile(
      join(armDirectory, "agent.stderr.log"),
      `OPENAI_API_KEY=secret-${index}\npassword=hunter${index}\n"clientSecret": "quoted-secret-${index}"\nopaque-runtime-value-123\n/private/tmp/moops-${index}/trace.log\n/Users/alice/Library/Logs/run.log\n`,
    );
    await writeFile(join(armDirectory, "arm-result.json"), `${JSON.stringify({
      id: arm.id,
      ok: index !== 0,
      completedEpochMs: 1_700_000_004_200 + index,
      metrics: { totalTimeToGreenMs: index === 0 ? null : 4_200 + index },
      error: index === 0 ? { code: "E_ACCEPTANCE", message: `failed at ${arm.worktree}` } : null,
    })}\n`);
  }
  return { manifest, arms, runDirectory, root };
}

test("publishes a reviewable four-arm bundle with timing and failure evidence", async () => {
  const { manifest, arms, runDirectory, root } = await fixture();

  const receipt = await publishTranscripts(manifest, RUN_ID, {
    environment: { BENCHMARK_SECRET: "opaque-runtime-value-123" },
  });

  const expected = join(manifest.repositoryRoot, "results", "runs", RUN_ID);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.outputDirectory, expected);
  assert.equal(receipt.arms.length, 4);
  assert.equal(receipt.fileCount, 19);
  assert.equal((await stat(join(expected, "bundle.json"))).isFile(), true);

  const events = await readFile(join(expected, "events.jsonl"), "utf8");
  const summary = await readFile(join(expected, "summary.json"), "utf8");
  const requests = await readFile(
    join(expected, "arms", arms[0].id, "agent.requests.jsonl"),
    "utf8",
  );
  const stdout = await readFile(
    join(expected, "arms", arms[0].id, "agent.stdout.jsonl"),
    "utf8",
  );
  const stderr = await readFile(join(expected, "arms", arms[0].id, "agent.stderr.log"), "utf8");
  const armResult = await readFile(join(expected, "arms", arms[0].id, "arm-result.json"), "utf8");
  const published = [events, summary, requests, stdout, stderr, armResult].join("\n");

  assert.match(events, /"epochMs":1700000004200/);
  assert.match(events, /"monotonicNs":"900000004200"/);
  assert.match(stdout, /"status":"failed"/);
  assert.match(armResult, /"code": "E_ACCEPTANCE"/);
  assert.match(requests, /<WORKTREE:codex-uitest>/);
  assert.match(stderr, /<TMP>\/trace\.log/);
  assert.match(stderr, /<HOME>\/Library\/Logs\/run\.log/);

  for (const forbidden of [
    root,
    runDirectory,
    "sk-live-secret",
    "live-token",
    "secret-0",
    "hunter0",
    "quoted-secret-0",
    "opaque-runtime-value-123",
    "/Users/alice",
    "/private/tmp",
  ]) {
    assert.equal(published.includes(forbidden), false, `published ${forbidden}`);
  }
  assert.match(requests, /<REDACTED>/);
  assert.equal((await readFile(join(arms[0].results, RUN_ID, "agent.stderr.log"), "utf8"))
    .includes("hunter0"), true, "source evidence must remain untouched");
});

test("fails atomically when a required transcript is missing", async () => {
  const { manifest, arms } = await fixture();
  const missing = join(arms[2].results, RUN_ID, "agent.stdout.jsonl");
  await writeFile(missing, "", { flag: "w" });

  await assert.rejects(
    publishTranscripts(manifest, RUN_ID),
    (error) => error instanceof TranscriptPublicationError && error.code === "E_TRANSCRIPT_EMPTY",
  );
  await assert.rejects(stat(join(manifest.repositoryRoot, "results", "runs", RUN_ID)));
  assert.deepEqual(await readdir(join(manifest.repositoryRoot, "results", "runs")), []);
});

test("rejects malformed JSONL rather than publishing an unverifiable transcript", async () => {
  const { manifest, arms } = await fixture();
  await writeFile(join(arms[1].results, RUN_ID, "agent.stdout.jsonl"), "not-json\n");

  await assert.rejects(
    publishTranscripts(manifest, RUN_ID),
    (error) => error instanceof TranscriptPublicationError && error.code === "E_TRANSCRIPT_FORMAT",
  );
  await assert.rejects(stat(join(manifest.repositoryRoot, "results", "runs", RUN_ID)));
});

test("refuses unsafe run IDs and never overwrites a public bundle", async () => {
  const { manifest } = await fixture();
  await assert.rejects(
    publishTranscripts(manifest, "../escape"),
    (error) => error instanceof TranscriptPublicationError && error.code === "E_TRANSCRIPT_RUN_ID",
  );

  await publishTranscripts(manifest, RUN_ID);
  await assert.rejects(
    publishTranscripts(manifest, RUN_ID),
    (error) => error instanceof TranscriptPublicationError && error.code === "E_TRANSCRIPT_EXISTS",
  );
});
