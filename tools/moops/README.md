# MOOPS host

This is the complete host surface for the three-hour pilot. It runs one fingerprinted,
versioned FoodDelivery checkpoint and deliberately contains no model loop,
daemon, test language, or private application-state access.

## Commands

From the repository root:

```sh
export MOOPS_SIMULATOR_UDID=<booted-simulator-udid>
export MOOPS_DERIVED_DATA=/tmp/moops-derived-data

tools/moops/moops checkpoint
tools/moops/moops doctor
tools/moops/moops verify --output results/verify.json
tools/moops/moops build-and-restore --output results/build-and-restore.json
```

`checkpoint` validates the schema and SHA-256 fingerprint. The fingerprint
detects drift; it is not a signature. Because a checkpoint declares executable
argv, only run checkpoints from a trusted repository. `doctor` checks the
declared command adapters. `verify` requests one fresh observation and evaluates
all landing predicates. `build-and-restore` runs build, install-without-uninstall,
launch, batched public trace replay plus fresh inspection, and landing validation
in that fixed order. Every command emits one JSON report and returns nonzero on
failure.

An alternate checkpoint path may follow the command. `--output PATH` writes the
same report that is emitted on stdout.

## UI adapter boundary

The checked-in XCUITest adapter is executed directly, without a shell. The final
argv value is one JSON request. Restore and inspection are intentionally batched
into one XCUITest session so app/navigation state cannot be lost between test
runner processes:

```json
{
  "protocolVersion": 1,
  "operation": "restore-and-inspect",
  "target": {
    "bundleId": "com.spencer..Food-Delivery",
    "simulatorUdid": "..."
  },
  "trace": [
    { "op": "tap", "selector": { "by": "id", "value": "home.cart" } }
  ],
  "selectors": [
    { "by": "id", "value": "checkout.ready" }
  ]
}
```

`restore-and-inspect` and `inspect` return exactly one JSON object on stdout:
`{"ok":true,"observation":{"nodes":[...]}}`.
Nodes expose only public accessibility fields (`id`, `label`, `text`, `value`,
and `enabled`). Logs belong on stderr. A nonzero exit, malformed JSON, negative
acknowledgement, missing observation, or failed predicate is a hard failure.

The checked-in checkpoint is a UI restore recipe plus public landing predicates.
It is not a process, SwiftUI, XCTest-element, or application-data snapshot.
Its precondition is deliberate: the selected simulator already contains the
logged-in session and nonempty persisted cart. Installation preserves that data;
MOOPS does not fabricate it, and a clean or empty simulator fails closed.

## Tests

```sh
cd tools/moops
npm test
```
