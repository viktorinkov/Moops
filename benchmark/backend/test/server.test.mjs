import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createFixtureServer } from "../server.mjs";

let baseURL;
let server;

before(async () => {
  server = createFixtureServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  baseURL = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function request(path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, options);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  return { body, response };
}

async function login() {
  const { body, response } = await request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "demo@moops.local",
      password: "moops-demo",
    }),
  });

  assert.equal(response.status, 200);
  return body.data;
}

function bearer(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

test("healthz identifies the immutable fixture", async () => {
  const { body, response } = await request("/healthz");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(body, {
    status: "ok",
    fixture: "mooops-food-delivery-v1",
    catalog_revision: "catalog-v1",
  });
});

test("login, refresh, and users/me use stable Directus envelopes", async () => {
  const token = await login();

  assert.deepEqual(token, {
    access_token: "mooops-access-token-v1",
    expires: 900000,
    refresh_token: "mooops-refresh-token-v1",
  });

  const refreshed = await request("/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      refresh_token: token.refresh_token,
      mode: "json",
    }),
  });
  assert.equal(refreshed.response.status, 200);
  assert.deepEqual(refreshed.body.data, token);

  const me = await request("/users/me", {
    headers: bearer(token.access_token),
  });
  assert.equal(me.response.status, 200);
  assert.deepEqual(me.body, {
    data: {
      id: "39c5986b-92c1-45f1-b832-83a6e445706a",
      first_name: "Spencer",
      last_name: "Demo",
      email: "demo@moops.local",
      status: "active",
    },
  });
});

test("authentication failures use the Directus error envelope", async () => {
  const invalidLogin = await request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "demo@moops.local",
      password: "wrong",
    }),
  });
  assert.equal(invalidLogin.response.status, 401);
  assert.deepEqual(invalidLogin.body, {
    errors: [
      {
        message: "Invalid user credentials.",
        extensions: { code: "INVALID_CREDENTIALS" },
      },
    ],
  });

  const unauthorized = await request("/users/me");
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.body.errors[0].extensions.code, "UNAUTHORIZED");
});

test("the original app login remains a documented compatibility alias", async () => {
  const legacyLogin = await request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "spencer@gmail.com",
      password: "directus",
    }),
  });

  assert.equal(legacyLogin.response.status, 200);
  assert.equal(legacyLogin.body.data.access_token, "mooops-access-token-v1");
});

test("catalog endpoints return fixed Directus data in fixed order", async () => {
  const restaurants = await request("/items/restaurants");
  assert.equal(restaurants.response.status, 200);
  assert.deepEqual(
    restaurants.body.data.map(({ id, name }) => ({ id, name })),
    [
      { id: 1, name: "Mcdonald's" },
      { id: 2, name: "Wendy’s" },
    ],
  );

  const foods = await request("/items/foods");
  assert.equal(foods.response.status, 200);
  assert.deepEqual(
    foods.body.data.map(({ id, name, price, price_cents, restaurant }) => ({
      id,
      name,
      price,
      price_cents,
      restaurant,
    })),
    [
      {
        id: 1,
        name: "Cheese Burger",
        price: 4,
        price_cents: 400,
        restaurant: 2,
      },
      {
        id: 2,
        name: "Chicken Sandwich",
        price: 3.59,
        price_cents: 359,
        restaurant: 1,
      },
      {
        id: 3,
        name: "Pizza",
        price: 12.45,
        price_cents: 1245,
        restaurant: 2,
      },
      {
        id: 4,
        name: "Salad",
        price: 13.29,
        price_cents: 1329,
        restaurant: 1,
      },
    ],
  );

  const categories = await request("/items/categories");
  assert.deepEqual(
    categories.body.data.map(({ id, name }) => ({ id, name })),
    [
      { id: 1, name: "Desserts" },
      { id: 2, name: "Meat" },
      { id: 3, name: "Fruits" },
    ],
  );
});

test("Directus bracket filters work for restaurants, favorites, and testimonials", async () => {
  const restaurantFoods = await request(
    "/items/foods?filter%5Brestaurant%5D%5Bid%5D%5B_eq%5D=1",
  );
  assert.deepEqual(
    restaurantFoods.body.data.map(({ id }) => id),
    [2, 4],
  );

  const favorites = await request(
    "/items/foods?filter%5Bis_liked%5D%5B_eq%5D=true",
  );
  assert.deepEqual(
    favorites.body.data.map(({ id }) => id),
    [1, 2, 4],
  );

  const testimonials = await request(
    "/items/testimonials?filter%5Brestaurant%5D%5Bid%5D%5B_eq%5D=2",
  );
  assert.deepEqual(
    testimonials.body.data.map(({ id, author_name }) => ({ id, author_name })),
    [{ id: 3, author_name: "Adem Bennett" }],
  );
});

test("known assets are stable PNGs and unknown assets return 404", async () => {
  const first = await request(
    "/assets/c036980b-67ec-43be-a3ec-2c78affa6ea3",
  );
  const second = await request(
    "/assets/c036980b-67ec-43be-a3ec-2c78affa6ea3",
  );

  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get("content-type"), "image/png");
  assert.equal(
    first.response.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.deepEqual(first.body, second.body);
  assert.deepEqual([...first.body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(first.body.length > 100_000, "catalog images must be visible fixtures, not 1px placeholders");

  const pizza = await request(
    "/assets/c9901f01-1efe-4dfb-8262-43a5151a6988",
  );
  assert.equal(pizza.response.status, 200);
  assert.notDeepEqual(first.body, pizza.body);

  const missing = await request("/assets/not-a-fixture-asset");
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.errors[0].extensions.code, "NOT_FOUND");
});

test("orders produce a deterministic inspectable receipt and reset cleanly", async () => {
  const token = await login();
  const headers = {
    ...bearer(token.access_token),
    "content-type": "application/json",
  };

  const reset = await request("/__benchmark/reset", { method: "POST" });
  assert.equal(reset.response.status, 200);
  assert.deepEqual(reset.body, {
    data: { reset: true, next_order_id: 100 },
  });

  const orderInput = {
    status: "published",
    order_status: "process",
    delivery_preference: "Meet at door",
    comments: "Leave at the side gate",
    delivery_address_id: "home",
    foods: [
      {
        id: 1,
        quantity: 2,
        selected_modifiers: ["large", "no-onions"],
      },
    ],
  };
  const created = await request("/items/orders", {
    method: "POST",
    headers,
    body: JSON.stringify(orderInput),
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.data.id, 100);
  assert.equal(created.body.data.date_created, "2026-08-23T12:00:00.000Z");

  const receipt = await request("/__benchmark/last-order");
  assert.equal(receipt.response.status, 200);
  assert.deepEqual(receipt.body.data.request, orderInput);
  assert.deepEqual(receipt.body.data.order, created.body.data);

  const receiptMutation = await request("/__benchmark/last-order", { method: "POST" });
  assert.equal(receiptMutation.response.status, 405);

  const orders = await request(
    "/items/orders?fields=*,foods.foods_id.restaurant.*,foods.quantity",
    { headers: bearer(token.access_token) },
  );
  assert.equal(orders.response.status, 200);
  assert.equal(orders.body.data.length, 1);
  assert.equal(orders.body.data[0].foods[0].quantity, 2);
  assert.equal(orders.body.data[0].foods[0].foods_id.id, 1);
  assert.equal(orders.body.data[0].foods[0].foods_id.restaurant.id, 2);

  await request("/__benchmark/reset", { method: "POST" });
  const emptyReceipt = await request("/__benchmark/last-order");
  assert.deepEqual(emptyReceipt.body, { data: null });

  const recreated = await request("/items/orders", {
    method: "POST",
    headers,
    body: JSON.stringify(orderInput),
  });
  assert.equal(recreated.body.data.id, 100);
});

test("orders reject malformed or unknown food data without changing the receipt", async () => {
  const token = await login();
  await request("/__benchmark/reset", { method: "POST" });

  const malformed = await request("/items/orders", {
    method: "POST",
    headers: {
      ...bearer(token.access_token),
      "content-type": "application/json",
    },
    body: "{",
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.errors[0].extensions.code, "INVALID_PAYLOAD");

  const unknownFood = await request("/items/orders", {
    method: "POST",
    headers: {
      ...bearer(token.access_token),
      "content-type": "application/json",
    },
    body: JSON.stringify({ foods: [{ id: 999, quantity: 1 }] }),
  });
  assert.equal(unknownFood.response.status, 422);
  assert.equal(unknownFood.body.errors[0].extensions.code, "INVALID_PAYLOAD");

  const unknownModifier = await request("/items/orders", {
    method: "POST",
    headers: {
      ...bearer(token.access_token),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      foods: [
        { id: 1, quantity: 1, selected_modifiers: ["not-on-the-menu"] },
      ],
    }),
  });
  assert.equal(unknownModifier.response.status, 422);
  assert.equal(unknownModifier.body.errors[0].extensions.code, "INVALID_PAYLOAD");

  const missingDeliveryPreference = await request("/items/orders", {
    method: "POST",
    headers: {
      ...bearer(token.access_token),
      "content-type": "application/json",
    },
    body: JSON.stringify({ foods: [{ id: 1, quantity: 1 }] }),
  });
  assert.equal(missingDeliveryPreference.response.status, 422);
  assert.equal(
    missingDeliveryPreference.body.errors[0].extensions.code,
    "INVALID_PAYLOAD",
  );

  const unknownDeliveryPreference = await request("/items/orders", {
    method: "POST",
    headers: {
      ...bearer(token.access_token),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      delivery_preference: "Hand it to the dog",
      foods: [{ id: 1, quantity: 1 }],
    }),
  });
  assert.equal(unknownDeliveryPreference.response.status, 422);
  assert.equal(
    unknownDeliveryPreference.body.errors[0].extensions.code,
    "INVALID_PAYLOAD",
  );

  const receipt = await request("/__benchmark/last-order");
  assert.deepEqual(receipt.body, { data: null });
});

test("unknown routes and unsupported methods fail predictably", async () => {
  const unknown = await request("/not-a-route");
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.errors[0].extensions.code, "NOT_FOUND");

  const wrongMethod = await request("/items/foods", { method: "POST" });
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.body.errors[0].extensions.code, "METHOD_NOT_ALLOWED");
});
