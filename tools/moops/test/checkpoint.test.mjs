import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointError,
  fingerprintCheckpoint,
  validateCheckpoint,
} from "../src/checkpoint.mjs";

function validCheckpoint() {
  const checkpoint = {
    schemaVersion: 1,
    fixtureVersion: "food-delivery-v1",
    name: "cart-ready",
    app: { bundleId: "com.example.food" },
    simulator: { udid: "${MOOPS_SIMULATOR_UDID}" },
    adapters: {
      doctor: [["/usr/bin/true"]],
      build: ["/usr/bin/true"],
      install: ["/usr/bin/true"],
      launch: ["/usr/bin/true"],
      ui: ["${MOOPS_UI_ADAPTER}"],
    },
    trace: [
      {
        op: "wait",
        selector: { by: "text", value: "Home" },
        timeoutMs: 10_000,
      },
      { op: "tap", selector: { by: "label", value: "Cart" } },
    ],
    landingPredicates: [
      { kind: "exists", selector: { by: "text", value: "My cart" } },
    ],
  };
  checkpoint.fingerprint = fingerprintCheckpoint(checkpoint);
  return checkpoint;
}

test("accepts the one supported checkpoint contract", () => {
  assert.doesNotThrow(() => validateCheckpoint(validCheckpoint()));
});

test("rejects unsupported schema versions before any adapter can run", () => {
  const checkpoint = validCheckpoint();
  checkpoint.schemaVersion = 2;

  assert.throws(
    () => validateCheckpoint(checkpoint),
    (error) => error instanceof CheckpointError && error.code === "E_CHECKPOINT_VERSION",
  );
});

test("rejects a checkpoint whose fingerprinted payload changed", () => {
  const checkpoint = validCheckpoint();
  checkpoint.app.bundleId = "com.example.tampered";

  assert.throws(
    () => validateCheckpoint(checkpoint),
    (error) => error instanceof CheckpointError && error.code === "E_CHECKPOINT_FINGERPRINT",
  );
});

test("allows only public selectors in trace steps", () => {
  const checkpoint = validCheckpoint();
  checkpoint.trace[0].selector.by = "coordinate";
  checkpoint.fingerprint = fingerprintCheckpoint(checkpoint);

  assert.throws(
    () => validateCheckpoint(checkpoint),
    (error) => error instanceof CheckpointError && error.code === "E_CHECKPOINT_TRACE",
  );
});

test("rejects private route and unsupported mutation steps", () => {
  const checkpoint = validCheckpoint();
  checkpoint.trace.push({ op: "deep-link", url: "fixture://checkout" });
  checkpoint.fingerprint = fingerprintCheckpoint(checkpoint);

  assert.throws(
    () => validateCheckpoint(checkpoint),
    (error) => error instanceof CheckpointError && error.code === "E_CHECKPOINT_TRACE",
  );
});

test("requires at least one landing predicate", () => {
  const checkpoint = validCheckpoint();
  checkpoint.landingPredicates = [];
  checkpoint.fingerprint = fingerprintCheckpoint(checkpoint);

  assert.throws(
    () => validateCheckpoint(checkpoint),
    (error) => error instanceof CheckpointError && error.code === "E_CHECKPOINT_LANDING",
  );
});

test("rejects shell strings in every command adapter", () => {
  const checkpoint = validCheckpoint();
  checkpoint.adapters.build = "xcodebuild && echo unsafe";
  checkpoint.fingerprint = fingerprintCheckpoint(checkpoint);

  assert.throws(
    () => validateCheckpoint(checkpoint),
    (error) => error instanceof CheckpointError && error.code === "E_CHECKPOINT_ADAPTER",
  );
});

test("bounds checkpoint-controlled command and replay work", () => {
  const checkpoint = validCheckpoint();
  checkpoint.trace = Array.from({ length: 33 }, () => ({
    op: "tap",
    selector: { by: "text", value: "Cart" },
  }));
  checkpoint.fingerprint = fingerprintCheckpoint(checkpoint);

  assert.throws(
    () => validateCheckpoint(checkpoint),
    (error) => error instanceof CheckpointError && error.code === "E_CHECKPOINT_TRACE",
  );
});
