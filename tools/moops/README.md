# MOOPS

MOOPS is a working, MIT-licensed command-line developer tool for restoring a
useful iOS Simulator verification state after a rebuild. It is designed for the
inner loop used by coding agents and developers:

```text
edit -> build -> install without uninstalling -> launch -> replay navigation
     -> inspect fresh public UI state -> require every landing predicate
```

The Node host is app-agnostic. An app integrates through a versioned JSON
checkpoint and a small executable UI adapter. The checked-in FoodDelivery
checkpoint and XCUITest adapter are the working reference integration, not a
limit on which app can use MOOPS.

MOOPS does not embed an agent, daemon, SDK, screen-capture system, or private
application-state reader.

## How state restoration works

MOOPS deliberately separates two kinds of state:

- **Durable app state** stays in the installed app's Simulator data container.
  The app creates and owns this state through its normal code paths. The
  install adapter replaces the bundle without uninstalling it, so persisted
  session and model data can survive the rebuild.
- **Ephemeral UI state**—the process, view hierarchy, navigation stack, and
  XCTest elements—does not survive. A checkpoint stores a minimal public
  `wait`/`tap` trace that reconstructs the route after launch.

After replay, the UI adapter returns a new accessibility observation. MOOPS
accepts the restore only when every declared predicate matches that fresh
observation. A checkpoint is therefore a restore recipe and evidence contract,
not a heap, SwiftUI, navigation, `XCUIElement`, or app-data snapshot.

```text
checkpoint JSON
      |
      v
Node 18 host --direct argv--> build -> replacement install -> launch
      |                                              |
      |                                              v
      +---- JSON protocol v1 <---- UI adapter -> public trace + observation
      |
      v
fail-closed predicates -> versioned JSON report + process exit status
```

## Current technical stack

| Layer | Current implementation |
| --- | --- |
| Host | Node.js 18+ ESM using built-in `fs`, `crypto`, `child_process`, and timing APIs; no runtime npm dependencies |
| Build and device control | Checkpoint-defined executable argv; the reference integration uses `xcrun`, `xcodebuild`, and `simctl` |
| UI automation | Public JSON adapter protocol; the reference implementation bridges it to XCUITest |
| State | App-owned durable data plus a bounded public accessibility trace; no private memory access |
| Evidence | Fresh accessibility nodes, strict landing predicates, per-phase timings, and one JSON report |

## Commands

Run the executable from the repository root:

```sh
tools/moops/moops <command> [checkpoint.json] [--output report.json]
```

| Command | Behavior |
| --- | --- |
| `checkpoint` | Validates an existing checkpoint's exact schema and SHA-256 fingerprint. It does not capture or generate state. |
| `doctor` | Validates the checkpoint, then runs each declared prerequisite command. |
| `verify` | Requests one fresh `inspect` observation and evaluates every landing predicate. The target app must already be in the state expected by its UI adapter. |
| `build-and-restore` | Runs `build`, `install`, `launch`, `restore-and-inspect`, and landing validation in that order. |

Every command writes one report to stdout and exits nonzero when `ok` is false.
`--output` writes the same report to a file. If no checkpoint path is supplied,
the CLI uses the working FoodDelivery checkpoint at
[`benchmark/checkpoints/food-delivery-cart.json`](../../benchmark/checkpoints/food-delivery-cart.json).

## Use MOOPS in your iOS app

1. Install Node.js 18+ and Xcode, boot an iOS Simulator, and clone this
   repository. MOOPS itself has no package-install step or runtime dependency.
2. Put the app into a useful state through real app behavior. Persist everything
   that must survive terminate/relaunch, and expose stable accessibility
   identifiers for the route and landing evidence.
3. Copy the
   [FoodDelivery checkpoint](../../benchmark/checkpoints/food-delivery-cart.json)
   and change the app, Simulator, commands, trace, and predicates for your app.
4. Define `install` as a replacement install. For Simulator apps, the reference
   command is `xcrun simctl install <udid> <app-path>` with no preceding
   `uninstall`.
5. Provide a UI adapter executable that implements protocol v1 below. XCUITest
   is one implementation option; any executable that honors the protocol works.
6. Recompute the checkpoint fingerprint after every edit, then validate it:

   ```sh
   node --input-type=module -e '
   import { readFile, writeFile } from "node:fs/promises";
   import { fingerprintCheckpoint } from "./tools/moops/src/checkpoint.mjs";
   const path = process.argv[1];
   const checkpoint = JSON.parse(await readFile(path, "utf8"));
   checkpoint.fingerprint = fingerprintCheckpoint(checkpoint);
   await writeFile(path, JSON.stringify(checkpoint, null, 2) + "\n");
   ' path/to/my-app.checkpoint.json

   tools/moops/moops checkpoint path/to/my-app.checkpoint.json
   ```

7. Export any variables referenced by the checkpoint and run the workflow:

   ```sh
   export MOOPS_SIMULATOR_UDID=<booted-simulator-udid>
   export MOOPS_DERIVED_DATA=/tmp/my-app-derived-data

   tools/moops/moops doctor path/to/my-app.checkpoint.json
   tools/moops/moops build-and-restore path/to/my-app.checkpoint.json \
     --output results/my-app-restore.json
   ```

The fingerprint detects checkpoint drift; it is not a signature. A checkpoint
declares executable commands, so only run checkpoints from repositories you
trust.

## Checkpoint contract

Schema version 1 requires exactly these top-level fields:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `fixtureVersion` | Integration-controlled nonempty revision included in reports; update it when fixture assumptions change. |
| `name` | Nonempty checkpoint name reported by the CLI. |
| `app.bundleId` | Target application bundle identifier. |
| `simulator.udid` | Target Simulator UDID; environment expansion is allowed. |
| `adapters.doctor` | One to eight prerequisite argv arrays. |
| `adapters.build`, `install`, `launch`, `ui` | One nonempty argv array for each extension point. |
| `trace` | One to 32 `wait` or `tap` steps over public selectors. |
| `landingPredicates` | One to 32 `exists` or `equals` predicates. |
| `fingerprint` | Lowercase `sha256:` digest of the canonical checkpoint payload excluding this field. |

Commands are executed directly with `shell: false`; checkpoint values are not
shell scripts. There is no globbing, piping, command substitution, or shell
quoting layer. MOOPS expands only `${UPPER_SNAKE_CASE}` templates inside argv
strings and `simulator.udid`. A missing or empty referenced variable fails the
workflow instead of running a partially expanded command.

The host runs commands from the repository root. `doctor` is an array because
an integration normally checks several prerequisites; every other adapter is a
single command. This is the primary extension surface for changing the Xcode
project, scheme, build system, app path, launch flags, or UI automation backend.

Trace selectors have this shape:

```json
{ "by": "id", "value": "checkout.ready" }
```

`by` must be `id`, `label`, `text`, or `value`. A `tap` contains `op` and
`selector`. A `wait` also contains an integer `timeoutMs` from 1 through 60000.

Landing predicates are evaluated with strict equality against the new node
list:

```json
{ "kind": "exists", "selector": { "by": "id", "value": "screen.checkout" } }
```

```json
{
  "kind": "equals",
  "selector": { "by": "id", "value": "checkout.placeOrder" },
  "field": "enabled",
  "expected": true
}
```

An `equals` field may be `id`, `label`, `text`, `value`, or `enabled`; its
expected value must be a string, number, or boolean.

## Public UI adapter protocol

MOOPS launches the checkpoint's `adapters.ui` argv directly and appends exactly
one final argument containing the JSON request. `verify` sends `inspect`;
`build-and-restore` sends `restore-and-inspect`:

```json
{
  "protocolVersion": 1,
  "operation": "restore-and-inspect",
  "target": {
    "bundleId": "com.example.MyApp",
    "simulatorUdid": "00000000-0000-0000-0000-000000000000"
  },
  "trace": [
    {
      "op": "wait",
      "selector": { "by": "id", "value": "screen.home" },
      "timeoutMs": 15000
    },
    { "op": "tap", "selector": { "by": "id", "value": "home.checkout" } }
  ],
  "selectors": [
    { "by": "id", "value": "screen.checkout" },
    { "by": "id", "value": "checkout.placeOrder" }
  ]
}
```

For `inspect`, the request has the same `protocolVersion`, `operation`,
`target`, and `selectors`, with no `trace`.

The adapter must write exactly one JSON object to stdout:

```json
{
  "ok": true,
  "observation": {
    "nodes": [
      {
        "id": "checkout.placeOrder",
        "label": "Place order",
        "text": "Place order",
        "value": "",
        "enabled": true
      }
    ]
  }
}
```

Return enough nodes to evaluate all requested selectors. Adapter diagnostics
belong on stderr so stdout remains valid protocol output. Keeping replay and
inspection in one invocation prevents a test-runner boundary from discarding
the navigation state or returning stale element handles.

The host fails closed on a command spawn error, timeout, nonzero status,
oversized output, malformed UI JSON, `ok` other than `true`, a missing
`observation.nodes` array, or any failed landing predicate. Later phases do not
run after an earlier failure. The JSON report identifies the failed phase and
includes elapsed time for each completed or failed phase.

## Working reference integration

FoodDelivery demonstrates the full integration with a real persisted session,
Core Data cart state, and public XCUITest navigation:

- [checkpoint](../../benchmark/checkpoints/food-delivery-cart.json)
- [host-to-XCUITest executable](adapters/xcuitest)
- [XCUITest protocol implementation](<../../benchmark/FoodDelivery/FoodDeliveryBenchmarkUITests/BenchmarkFlowUITests.swift>)

That adapter contains FoodDelivery-specific bundle, scheme, and test-target
details. Use it as a protocol reference and provide an app-specific adapter for
another project. The comparative benchmark and its methodology are maintained
separately in
[`benchmark/BENCHMARK_PROTOCOL.md`](../../benchmark/BENCHMARK_PROTOCOL.md).

## Tests

```sh
cd tools/moops
npm test
```
