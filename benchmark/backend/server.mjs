import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import {
  ASSET_IDS,
  CATALOG_REVISION,
  CATEGORIES,
  DEMO_AUTH,
  FIXED_ORDER_DATE,
  FIXTURE_NAME,
  FOODS,
  LOGIN_CREDENTIALS,
  PLACEHOLDER_PNG,
  RESTAURANTS,
  TESTIMONIALS,
  USER,
} from "./fixtures.mjs";

const JSON_LIMIT_BYTES = 64 * 1024;
const FIXTURE_HEADER = {
  "x-content-type-options": "nosniff",
  "x-mooops-fixture": FIXTURE_NAME,
};

export function createFixtureServer() {
  const state = createInitialState();
  return createServer((request, response) => {
    handleRequest(request, response, state).catch((error) => {
      if (error instanceof RequestError) {
        sendError(response, error.status, error.message, error.code);
        return;
      }

      sendError(response, 500, "Internal fixture error.", "INTERNAL_SERVER_ERROR");
    });
  });
}

async function handleRequest(request, response, state) {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const { pathname, searchParams } = url;

  if (pathname === "/healthz") {
    requireMethod(method, "GET");
    sendJSON(response, 200, {
      status: "ok",
      fixture: FIXTURE_NAME,
      catalog_revision: CATALOG_REVISION,
    });
    return;
  }

  if (pathname === "/auth/login") {
    requireMethod(method, "POST");
    const input = await readJSON(request);
    const isValidLogin = LOGIN_CREDENTIALS.some(
      ({ email, password }) => input.email === email && input.password === password,
    );
    if (!isValidLogin) {
      throw new RequestError(401, "Invalid user credentials.", "INVALID_CREDENTIALS");
    }
    sendJSON(response, 200, { data: tokenData() });
    return;
  }

  if (pathname === "/auth/refresh") {
    requireMethod(method, "POST");
    const input = await readJSON(request);
    if (input.refresh_token !== DEMO_AUTH.refreshToken) {
      throw new RequestError(401, "Invalid refresh token.", "INVALID_TOKEN");
    }
    sendJSON(response, 200, { data: tokenData() });
    return;
  }

  if (pathname === "/users/me") {
    requireMethod(method, "GET");
    requireAuthorization(request);
    sendJSON(response, 200, { data: USER });
    return;
  }

  if (pathname === "/items/restaurants") {
    requireMethod(method, "GET");
    sendJSON(response, 200, { data: RESTAURANTS });
    return;
  }

  if (pathname === "/items/foods") {
    requireMethod(method, "GET");
    let foods = FOODS;
    const restaurantID = parseIntegerFilter(
      searchParams.get("filter[restaurant][id][_eq]"),
    );
    const liked = parseBooleanFilter(searchParams.get("filter[is_liked][_eq]"));

    if (restaurantID !== null) {
      foods = foods.filter(({ restaurant }) => restaurant === restaurantID);
    }
    if (liked !== null) {
      foods = foods.filter(({ is_liked: isLiked }) => isLiked === liked);
    }
    sendJSON(response, 200, { data: foods });
    return;
  }

  if (pathname === "/items/categories") {
    requireMethod(method, "GET");
    sendJSON(response, 200, { data: CATEGORIES });
    return;
  }

  if (pathname === "/items/testimonials") {
    requireMethod(method, "GET");
    const restaurantID = parseIntegerFilter(
      searchParams.get("filter[restaurant][id][_eq]"),
    );
    const testimonials = restaurantID === null
      ? TESTIMONIALS
      : TESTIMONIALS.filter(({ restaurant }) => restaurant === restaurantID);
    sendJSON(response, 200, { data: testimonials });
    return;
  }

  if (pathname === "/items/orders") {
    requireAuthorization(request);
    if (method === "GET") {
      sendJSON(response, 200, { data: state.orders });
      return;
    }
    if (method === "POST") {
      const input = await readJSON(request);
      validateOrderInput(input);
      const order = createOrder(input, state.nextOrderID);
      state.nextOrderID += 1;
      state.orders.push(order);
      state.lastReceipt = {
        request: structuredClone(input),
        order: structuredClone(order),
      };
      sendJSON(response, 200, { data: order });
      return;
    }
    throw new RequestError(405, "Method not allowed.", "METHOD_NOT_ALLOWED");
  }

  if (pathname === "/__benchmark/last-order") {
    requireMethod(method, "GET");
    sendJSON(response, 200, { data: state.lastReceipt });
    return;
  }

  if (pathname === "/__benchmark/reset") {
    requireMethod(method, "POST");
    resetState(state);
    sendJSON(response, 200, {
      data: { reset: true, next_order_id: state.nextOrderID },
    });
    return;
  }

  if (pathname.startsWith("/assets/")) {
    requireMethod(method, "GET");
    const assetID = decodeURIComponent(pathname.slice("/assets/".length));
    if (!ASSET_IDS.includes(assetID)) {
      throw new RequestError(404, "Asset not found.", "NOT_FOUND");
    }
    sendBytes(response, 200, PLACEHOLDER_PNG, "image/png");
    return;
  }

  const knownPaths = new Set([
    "/healthz",
    "/auth/login",
    "/auth/refresh",
    "/users/me",
    "/items/restaurants",
    "/items/foods",
    "/items/categories",
    "/items/testimonials",
    "/items/orders",
    "/__benchmark/last-order",
    "/__benchmark/reset",
  ]);
  if (knownPaths.has(pathname)) {
    throw new RequestError(405, "Method not allowed.", "METHOD_NOT_ALLOWED");
  }
  throw new RequestError(404, "Route not found.", "NOT_FOUND");
}

function createInitialState() {
  return { orders: [], lastReceipt: null, nextOrderID: 100 };
}

function resetState(state) {
  state.orders.length = 0;
  state.lastReceipt = null;
  state.nextOrderID = 100;
}

function validateOrderInput(input) {
  if (!Array.isArray(input.foods) || input.foods.length === 0) {
    throw new RequestError(422, "An order requires at least one food.", "INVALID_PAYLOAD");
  }

  for (const line of input.foods) {
    const food = FOODS.find(({ id }) => id === line?.id);
    const allowedModifiers = new Set(
      food?.modifier_groups.flatMap(({ options }) => options.map(({ id }) => id)) ?? [],
    );
    const validLine = line
      && typeof line === "object"
      && Number.isInteger(line.id)
      && Number.isInteger(line.quantity)
      && line.quantity > 0
      && food
      && (line.selected_modifiers === undefined
        || (Array.isArray(line.selected_modifiers)
          && line.selected_modifiers.every(
            (value) => typeof value === "string" && allowedModifiers.has(value),
          )));
    if (!validLine) {
      throw new RequestError(422, "Order contains invalid food data.", "INVALID_PAYLOAD");
    }
  }
}

function createOrder(input, orderID) {
  return {
    ...structuredClone(input),
    id: orderID,
    status: input.status ?? "published",
    sort: null,
    user_created: USER.id,
    date_created: FIXED_ORDER_DATE,
    user_updated: null,
    date_updated: null,
    order_status: input.order_status ?? "process",
    comments: input.comments ?? "",
    foods: input.foods.map((line, index) => {
      const food = FOODS.find(({ id }) => id === line.id);
      const restaurant = RESTAURANTS.find(({ id }) => id === food.restaurant);
      return {
        id: orderID * 100 + index + 1,
        quantity: line.quantity,
        selected_modifiers: line.selected_modifiers ?? [],
        foods_id: {
          id: food.id,
          price: food.price,
          price_cents: food.price_cents,
          image: food.image,
          name: food.name,
          currency: food.currency,
          restaurant,
        },
      };
    }),
  };
}

function tokenData() {
  return {
    access_token: DEMO_AUTH.accessToken,
    expires: DEMO_AUTH.expires,
    refresh_token: DEMO_AUTH.refreshToken,
  };
}

function requireAuthorization(request) {
  if (request.headers.authorization !== `Bearer ${DEMO_AUTH.accessToken}`) {
    throw new RequestError(401, "Authentication required.", "UNAUTHORIZED");
  }
}

function requireMethod(actual, expected) {
  if (actual !== expected) {
    throw new RequestError(405, "Method not allowed.", "METHOD_NOT_ALLOWED");
  }
}

function parseIntegerFilter(value) {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) {
    throw new RequestError(400, "Invalid integer filter.", "INVALID_QUERY");
  }
  return Number(value);
}

function parseBooleanFilter(value) {
  if (value === null) return null;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new RequestError(400, "Invalid boolean filter.", "INVALID_QUERY");
}

async function readJSON(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) {
      throw new RequestError(413, "Request body is too large.", "PAYLOAD_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object") {
      throw new Error("JSON object required");
    }
    return body;
  } catch {
    throw new RequestError(400, "Invalid JSON payload.", "INVALID_PAYLOAD");
  }
}

function sendJSON(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    ...FIXTURE_HEADER,
    "cache-control": "no-store",
    "content-length": bytes.length,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(bytes);
}

function sendBytes(response, status, bytes, contentType) {
  response.writeHead(status, {
    ...FIXTURE_HEADER,
    "cache-control": "public, max-age=31536000, immutable",
    "content-length": bytes.length,
    "content-type": contentType,
  });
  response.end(bytes);
}

function sendError(response, status, message, code) {
  sendJSON(response, status, {
    errors: [{ message, extensions: { code } }],
  });
}

class RequestError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portFlag = process.argv.indexOf("--port");
  const portValue = portFlag === -1 ? "8055" : process.argv[portFlag + 1];
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${portValue}`);
  }

  const server = createFixtureServer();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`MOOOPS fixture listening on http://127.0.0.1:${port}\n`);
  });
}
