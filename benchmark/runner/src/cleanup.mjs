import { join, relative } from "node:path";

function safeRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) {
    throw new Error("cleanup runId is unsafe");
  }
}

function assertInside(root, path) {
  const fragment = relative(root, path);
  if (fragment === "" || fragment === ".." || fragment.startsWith("../")) {
    throw new Error(`cleanup target is outside runRoot: ${path}`);
  }
}

export function buildCleanupPlan(manifest, runId) {
  safeRunId(runId);
  const generatedData = [
    { kind: "run-ledger", path: join(manifest.runRoot, "benchmark-runs", runId) },
    ...manifest.arms.flatMap((arm) => [
      { kind: "arm-results", armId: arm.id, path: join(arm.results, runId) },
      { kind: "derived-data", armId: arm.id, path: arm.derivedData },
    ]),
  ];
  for (const target of generatedData) assertInside(manifest.runRoot, target.path);

  return {
    planVersion: 1,
    runId,
    executed: false,
    warning: "This command does not execute cleanup. Review ownership and run each operation manually.",
    generatedData,
    worktrees: manifest.arms.map((arm) => ({
      armId: arm.id,
      path: arm.worktree,
      verifyCommand: ["/usr/bin/git", "worktree", "list", "--porcelain"],
      removeCommand: ["/usr/bin/git", "worktree", "remove", "--", arm.worktree],
    })),
    simulators: manifest.arms.map((arm) => ({
      armId: arm.id,
      udid: arm.simulatorUdid,
      verifyCommand: ["/usr/bin/xcrun", "simctl", "list", "devices", "--json"],
      deleteCommand: ["/usr/bin/xcrun", "simctl", "delete", arm.simulatorUdid],
    })),
    backends: manifest.arms.map((arm) => ({
      armId: arm.id,
      port: arm.backendPort,
      note: "The runner stops only the PID it started; verify no process remains on this port.",
    })),
  };
}
