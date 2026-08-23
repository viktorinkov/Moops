import assert from "node:assert/strict";
import test from "node:test";

import { commitObjectExpression } from "../src/preflight.mjs";

test("baseline refs are peeled to commits before comparing worktree HEADs", () => {
  assert.equal(commitObjectExpression("benchmark-start"), "benchmark-start^{commit}");
});
