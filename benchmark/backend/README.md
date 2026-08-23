# MOOOPS benchmark backend

This is the deterministic local HTTP fixture for the MOOOPS iOS benchmark. It
uses only Node.js built-ins, keeps the catalog immutable, and preserves the
Directus paths and JSON envelopes consumed by the benchmark app.

It is a loopback-only test fixture, not a production authentication service.
The credentials and tokens below are public fixture constants, not secrets.

## Run

Node.js 18 or newer is required. There are no packages to install.

```sh
npm start
```

The CLI binds `127.0.0.1:8055`. An alternate port can be used for local
diagnostics:

```sh
npm start -- --port 18055
```

Readiness is reported by `GET /healthz`. A successful response identifies both
the fixture and catalog revision so a benchmark run can record what it used.

## Directus-compatible API

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/auth/login` | Returns the fixed demo access and refresh tokens. |
| `POST` | `/auth/refresh` | Exchanges the fixed refresh token for the same stable token set. |
| `GET` | `/users/me` | Returns the fixed demo user; bearer token required. |
| `GET` | `/items/restaurants` | Returns restaurants ordered by numeric ID. |
| `GET` | `/items/foods` | Returns menu items ordered by numeric ID. |
| `GET` | `/items/categories` | Returns categories ordered by numeric ID. |
| `GET` | `/items/testimonials` | Returns testimonials ordered by numeric ID. |
| `GET` | `/items/orders` | Returns orders submitted since the last reset; bearer token required. |
| `POST` | `/items/orders` | Creates an in-memory deterministic order; bearer token required. |
| `GET` | `/assets/<id>` | Returns stable local PNG bytes for fixture asset IDs. |

The app's existing Directus filters are supported:

- `filter[restaurant][id][_eq]=<integer>` on foods and testimonials
- `filter[is_liked][_eq]=true|false` on foods
- `fields=...` on orders is accepted and the fixture always returns the nested
  shape the app decodes

Demo login:

```text
email: demo@moops.local
password: moops-demo
```

For compatibility with the unmodified upstream app, the fixture also accepts
`spencer@gmail.com` / `directus`. Both pairs return the same deterministic demo
identity and token; neither is a real credential or security boundary.

Catalog responses are public and read-only. User and order routes require:

```text
Authorization: Bearer mooops-access-token-v1
```

Prices retain the app's `price` field and also expose additive integer
`price_cents` and modifier `price_delta_cents` fields for exact benchmark
arithmetic.

## Benchmark controls

The only mutable state is the in-memory list of submitted orders.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/__benchmark/last-order` | Read-only receipt containing the exact request and normalized order. |
| `POST` | `/__benchmark/reset` | Clears receipts/orders and resets the next order ID to `100`. |

Restarting the process performs the same reset. These routes are intentionally
available only on the fixture, which the CLI binds to loopback.

## Test

```sh
npm test
```

The contract suite starts the real HTTP server on an ephemeral loopback port
and verifies authentication, catalog ordering and filtering, assets, Directus
error envelopes, order receipts, malformed input, and deterministic reset.
