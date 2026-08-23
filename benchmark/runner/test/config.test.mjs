import assert from "node:assert/strict";
import test from "node:test";

import {
  ARM_DEFINITIONS,
  ManifestError,
  normalizeManifest,
  renderArgv,
} from "../src/config.mjs";

function validManifest() {
  const runRoot = "/tmp/moops-benchmark";
  return {
    schemaVersion: 1,
    runRoot,
    repositoryRoot: "/tmp/moops-source",
    baselineCommit: "benchmark-start",
    promptPath: "/tmp/moops-source/benchmark/FEATURE_PROMPT.md",
    model: "gpt-5.6-sol",
    serviceTier: "fast",
    deadlineSeconds: 10_800,
    agentCommand: ["codex", "app-server", "--listen", "stdio://"],
    backendCommand: [
      process.execPath, "${WORKTREE}/benchmark/backend/server.mjs",
      "--port", "${BACKEND_PORT}", "--fixture", "${BACKEND_FIXTURE_REVISION}",
    ],
    backendFixtureRevision: "catalog-v1",
    versionCommands: [
      { name: "codex", argv: ["codex", "--version"] },
      { name: "xcode", argv: ["/usr/bin/xcrun", "xcodebuild", "-version"] },
    ],
    acceptanceCommand: [
      "/usr/bin/xcrun", "xcodebuild", "test-without-building",
      "-xctestrun", "${XCTESTRUN}",
      "-destination", "id=${SIMULATOR_UDID}",
    ],
    appBundleId: "com.spencer..Food-Delivery",
    arms: ARM_DEFINITIONS.map((definition, index) => ({
      ...definition,
      worktree: `${runRoot}/worktrees/${definition.id}`,
      simulatorUdid: `SIM-${index + 1}`,
      backendPort: 18_055 + index,
      derivedData: `${runRoot}/derived/${definition.id}`,
      results: `${runRoot}/results/${definition.id}`,
      environment: {
        MCP_XCODE_PID: String(50_001 + index),
        ...(index === 2 ? { MOOPS_ENABLE_INJECTIONIII: "1" } : {}),
      },
    })),
    showcase: {
      desktopRegion: { x: 0, y: 0, width: 1920, height: 1080 },
      recordingSeconds: 180,
    },
  };
}

test("accepts exactly the four fixed arms and fairness controls", () => {
  const manifest = normalizeManifest(validManifest(), { manifestPath: "/tmp/manifest.json" });

  assert.equal(manifest.model, "gpt-5.6-sol");
  assert.equal(manifest.serviceTier, "fast");
  assert.equal(manifest.deadlineSeconds, 10_800);
  assert.deepEqual(
    manifest.arms.map(({ id, label }) => ({ id, label })),
    ARM_DEFINITIONS,
  );
});

test("rejects renamed, missing, or duplicated benchmark arms", () => {
  const renamed = validManifest();
  renamed.arms[0].label = "Codex baseline";
  assert.throws(
    () => normalizeManifest(renamed, { manifestPath: "/tmp/manifest.json" }),
    (error) => error instanceof ManifestError && error.code === "E_MANIFEST_ARMS",
  );

  const duplicateSimulator = validManifest();
  duplicateSimulator.arms[1].simulatorUdid = duplicateSimulator.arms[0].simulatorUdid;
  assert.throws(
    () => normalizeManifest(duplicateSimulator, { manifestPath: "/tmp/manifest.json" }),
    (error) => error.code === "E_MANIFEST_ISOLATION",
  );

  const duplicateBackend = validManifest();
  duplicateBackend.arms[3].backendPort = duplicateBackend.arms[0].backendPort;
  assert.throws(
    () => normalizeManifest(duplicateBackend, { manifestPath: "/tmp/manifest.json" }),
    (error) => error.code === "E_MANIFEST_ISOLATION",
  );
});

test("rejects attempts to vary the fixed model, tier, or deadline", () => {
  for (const [field, value] of [
    ["model", "gpt-5.6-terra"],
    ["serviceTier", "priority"],
    ["deadlineSeconds", 10_799],
  ]) {
    const manifest = validManifest();
    manifest[field] = value;
    assert.throws(
      () => normalizeManifest(manifest, { manifestPath: "/tmp/manifest.json" }),
      (error) => error.code === "E_MANIFEST_FAIRNESS",
    );
  }
});

test("requires direct argv and rejects rehearsal-only codex exec", () => {
  const shell = validManifest();
  shell.agentCommand = "codex exec && echo unsafe";
  assert.throws(
    () => normalizeManifest(shell, { manifestPath: "/tmp/manifest.json" }),
    (error) => error.code === "E_MANIFEST_COMMAND",
  );

  const ignoresModel = validManifest();
  ignoresModel.agentCommand = ["codex", "exec", "-"];
  assert.throws(
    () => normalizeManifest(ignoresModel, { manifestPath: "/tmp/manifest.json" }),
    (error) => error.code === "E_MANIFEST_GOAL",
  );
});

test("renders only declared template variables and never invokes a shell", () => {
  assert.deepEqual(
    renderArgv(["tool", "--device=${SIMULATOR_UDID}", "${WORKTREE}"], {
      SIMULATOR_UDID: "SIM 1",
      WORKTREE: "/tmp/work tree",
    }),
    ["tool", "--device=SIM 1", "/tmp/work tree"],
  );
  assert.throws(
    () => renderArgv(["tool", "${UNDECLARED}"], {}),
    (error) => error.code === "E_TEMPLATE",
  );
});

test("requires every generated path to stay inside the dedicated run root", () => {
  const escaped = validManifest();
  escaped.arms[0].derivedData = "/tmp/shared-derived-data";
  assert.throws(
    () => normalizeManifest(escaped, { manifestPath: "/tmp/manifest.json" }),
    (error) => error.code === "E_MANIFEST_PATH",
  );
});

test("requires one distinct numeric Xcode MCP process binding per arm", () => {
  const source = validManifest();
  source.arms[0].environment.MCP_XCODE_PID = "not-a-pid";
  assert.throws(() => normalizeManifest(source, { manifestPath: "/tmp/manifest.json" }), /MCP_XCODE_PID/);

  const duplicate = validManifest();
  duplicate.arms[3].environment.MCP_XCODE_PID = duplicate.arms[2].environment.MCP_XCODE_PID;
  assert.throws(() => normalizeManifest(duplicate, { manifestPath: "/tmp/manifest.json" }), /MCP_XCODE_PID|unique/);
});
