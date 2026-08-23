const APP_BUNDLE_ID = "com.spencer..Food-Delivery";
const TEST_IDENTIFIER =
  "FoodDeliveryBenchmarkUITests/MOOPSAdapterUITests/testMOOPSAdapterCommand";
const REQUEST_PLIST_KEY =
  "FoodDeliveryBenchmarkUITests.EnvironmentVariables.MOOPS_UI_REQUEST";
const SELECTOR_CHANNELS = new Set(["id", "label", "text", "value"]);

export class XCUITestAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "XCUITestAdapterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new XCUITestAdapterError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value, keys, context) {
  if (!isObject(value)) fail("E_XCUITEST_REQUEST", `${context} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("E_XCUITEST_REQUEST", `${context} has an unsupported shape`);
  }
}

function validateSelector(selector, context) {
  requireExactKeys(selector, ["by", "value"], context);
  if (!SELECTOR_CHANNELS.has(selector.by)) {
    fail("E_XCUITEST_REQUEST", `${context}.by is not public accessibility data`);
  }
  if (typeof selector.value !== "string" || selector.value.length === 0) {
    fail("E_XCUITEST_REQUEST", `${context}.value must be a non-empty string`);
  }
}

function validateRequest(request) {
  if (!isObject(request) || request.protocolVersion !== 1) {
    fail("E_XCUITEST_REQUEST", "request must use protocolVersion 1");
  }
  const isRestore = request.operation === "restore-and-inspect";
  if (!isRestore && request.operation !== "inspect") {
    fail("E_XCUITEST_REQUEST", "operation must be inspect or restore-and-inspect");
  }
  requireExactKeys(
    request,
    isRestore
      ? ["operation", "protocolVersion", "selectors", "target", "trace"]
      : ["operation", "protocolVersion", "selectors", "target"],
    "request",
  );
  requireExactKeys(request.target, ["bundleId", "simulatorUdid"], "request.target");
  if (request.target.bundleId !== APP_BUNDLE_ID) {
    fail("E_XCUITEST_REQUEST", `unsupported bundle identifier ${request.target.bundleId}`);
  }
  if (typeof request.target.simulatorUdid !== "string" || request.target.simulatorUdid === "") {
    fail("E_XCUITEST_REQUEST", "request.target.simulatorUdid must be a non-empty string");
  }
  if (!Array.isArray(request.selectors) || request.selectors.length < 1 || request.selectors.length > 32) {
    fail("E_XCUITEST_REQUEST", "selectors must contain 1 through 32 selectors");
  }
  request.selectors.forEach((selector, index) => validateSelector(selector, `selectors[${index}]`));

  if (isRestore) {
    if (!Array.isArray(request.trace) || request.trace.length < 1 || request.trace.length > 32) {
      fail("E_XCUITEST_REQUEST", "trace must contain 1 through 32 steps");
    }
    request.trace.forEach((step, index) => {
      const context = `trace[${index}]`;
      if (!isObject(step) || !["wait", "tap"].includes(step.op)) {
        fail("E_XCUITEST_REQUEST", `${context}.op must be wait or tap`);
      }
      requireExactKeys(
        step,
        step.op === "wait" ? ["op", "selector", "timeoutMs"] : ["op", "selector"],
        context,
      );
      validateSelector(step.selector, `${context}.selector`);
      if (step.op === "wait" && (
        !Number.isInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 60_000
      )) {
        fail("E_XCUITEST_REQUEST", `${context}.timeoutMs is out of range`);
      }
    });
  }
  return request;
}

export function prepareXCUITestInvocation(request, options) {
  validateRequest(request);
  if (typeof options?.xctestrunPath !== "string" || options.xctestrunPath === "") {
    fail("E_XCUITEST_ENV", "xctestrunPath is required");
  }

  return {
    argv: [
      "/usr/bin/xcrun",
      "xcodebuild",
      "test-without-building",
      "-xctestrun",
      options.xctestrunPath,
      "-destination",
      `id=${request.target.simulatorUdid}`,
      `-only-testing:${TEST_IDENTIFIER}`,
    ],
    requestJSON: JSON.stringify(request),
  };
}

export function prepareXCTestRunInjection(requestJSON, xctestrunPath) {
  if (typeof requestJSON !== "string" || requestJSON === "") {
    fail("E_XCUITEST_REQUEST", "request JSON is required for xctestrun injection");
  }
  if (typeof xctestrunPath !== "string" || xctestrunPath === "") {
    fail("E_XCUITEST_ENV", "xctestrunPath is required for xctestrun injection");
  }
  return [
    "/usr/bin/plutil",
    "-insert",
    REQUEST_PLIST_KEY,
    "-string",
    requestJSON,
    xctestrunPath,
  ];
}

export function extractXCUITestResponse(output) {
  const prefix = "MOOPS_UI_RESPONSE:";
  let encoded;
  for (const line of output.split(/\r?\n/)) {
    const marker = line.indexOf(prefix);
    if (marker !== -1) encoded = line.slice(marker + prefix.length).trim();
  }
  if (encoded === undefined) {
    fail("E_XCUITEST_RESPONSE", "XCTest emitted no MOOPS UI response marker");
  }
  try {
    const response = JSON.parse(encoded);
    if (!isObject(response) || typeof response.ok !== "boolean") {
      fail("E_XCUITEST_RESPONSE", "XCTest response is not an acknowledgement object");
    }
    return response;
  } catch (cause) {
    if (cause instanceof XCUITestAdapterError) throw cause;
    fail("E_XCUITEST_RESPONSE", "XCTest response marker is not valid JSON");
  }
}
