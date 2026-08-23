import assert from "node:assert/strict";
import test from "node:test";

import {
  extractXCUITestResponse,
  prepareXCTestRunInjection,
  prepareXCUITestInvocation,
} from "../src/xcuitest-adapter.mjs";

function request(operation = "restore-and-inspect") {
  return {
    protocolVersion: 1,
    operation,
    target: {
      bundleId: "com.spencer..Food-Delivery",
      simulatorUdid: "SIM-1",
    },
    trace: [
      { op: "wait", selector: { by: "id", value: "screen.home" }, timeoutMs: 15_000 },
      { op: "tap", selector: { by: "id", value: "home.cart" } },
    ],
    selectors: [{ by: "id", value: "checkout.ready" }],
  };
}

test("prepares the one checked-in XCUITest adapter invocation without a shell", () => {
  const prepared = prepareXCUITestInvocation(request(), {
    xctestrunPath: "/tmp/request.xctestrun",
  });

  assert.equal(prepared.argv[0], "/usr/bin/xcrun");
  assert.equal(prepared.argv.includes("test-without-building"), true);
  assert.equal(prepared.argv.includes("/tmp/request.xctestrun"), true);
  assert.equal(prepared.argv.includes("id=SIM-1"), true);
  assert.equal(prepared.argv.includes(
    "-only-testing:FoodDeliveryBenchmarkUITests/MOOPSAdapterUITests/testMOOPSAdapterCommand",
  ), true);
  assert.equal(prepared.requestJSON, JSON.stringify(request()));
  assert.deepEqual(
    prepareXCTestRunInjection(prepared.requestJSON, "/tmp/request.xctestrun"),
    [
      "/usr/bin/plutil",
      "-insert",
      "FoodDeliveryBenchmarkUITests.EnvironmentVariables.MOOPS_UI_REQUEST",
      "-string",
      prepared.requestJSON,
      "/tmp/request.xctestrun",
    ],
  );
});

test("accepts an inspect-only request but rejects another app or operation", () => {
  const inspect = request("inspect");
  delete inspect.trace;
  assert.doesNotThrow(() => prepareXCUITestInvocation(inspect, {
    xctestrunPath: "/tmp/request.xctestrun",
  }));

  const wrongApp = request();
  wrongApp.target.bundleId = "com.example.other";
  assert.throws(
    () => prepareXCUITestInvocation(wrongApp, {
      xctestrunPath: "/tmp/request.xctestrun",
    }),
    (error) => error.code === "E_XCUITEST_REQUEST",
  );

  const perform = request("perform");
  assert.throws(
    () => prepareXCUITestInvocation(perform, {
      xctestrunPath: "/tmp/request.xctestrun",
    }),
    (error) => error.code === "E_XCUITEST_REQUEST",
  );
});

test("extracts only the XCTest response marker from noisy xcodebuild output", () => {
  const response = extractXCUITestResponse(`
Test Suite 'Selected tests' started
MOOPS_UI_RESPONSE:{"observation":{"nodes":[{"id":"checkout.ready"}]},"ok":true}
** TEST SUCCEEDED **
`);

  assert.deepEqual(response, {
    observation: { nodes: [{ id: "checkout.ready" }] },
    ok: true,
  });
});

test("fails closed when XCTest emits no response marker", () => {
  assert.throws(
    () => extractXCUITestResponse("** TEST FAILED **"),
    (error) => error.code === "E_XCUITEST_RESPONSE",
  );
});
