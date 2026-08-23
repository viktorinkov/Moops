# InjectionIII evidence helper

This helper gives arm C a fail-closed, machine-readable receipt. It does not
launch InjectionIII, Xcode, Simulator, or the benchmark app. The live runner
owns those processes.

It is pinned to InjectionIII `5.2.1` and the control socket shipped by that
version, `/tmp/InjectionNext-control.sock`. The older
`/tmp/InjectionIII-control.sock` path shown in part of the bundled README is
not the path used by the shipped MCP bridge.

## One-time host setup

Enable InjectionIII's bundled ControlServer before starting the public demo,
then restart InjectionIII:

```sh
defaults write com.johnholdsworth.InjectionIII mcpServer -bool true
open -na /Applications/InjectionIII.app
```

This is host provisioning, not part of the timed feature run. The runner must
ensure that exactly one InjectionIII host is active.

## Preflight

Run preflight after the arm-C worktree and DerivedData directory exist, but
before releasing the common Goal barrier:

```sh
node benchmark/injectioniii/injectioniii-evidence.mjs preflight \
  --worktree /absolute/path/to/codex-injection \
  --derived-data /absolute/path/to/derived/codex-injection \
  --output /absolute/path/to/results/injection-preflight.json
```

Preflight requires all of the following:

- `/Applications/InjectionIII.app` reports version `5.2.1`;
- exactly one `InjectionIII` host PID exists;
- that PID listens on `127.0.0.1:8898`, not a wildcard interface;
- the ControlServer answers `status`;
- `watch_project` succeeds for the exact arm-C worktree; and
- `clear_logs` succeeds, establishing the start of the measured log window.

The CLI prints the same JSON it writes. Output files are created exclusively
with mode `0600`; an existing receipt is never overwritten.

## Postflight

Parse the app PID from the arm-C `xcrun simctl launch` result, then run:

```sh
node benchmark/injectioniii/injectioniii-evidence.mjs postflight \
  --preflight /absolute/path/to/results/injection-preflight.json \
  --app-pid 64710 \
  --output /absolute/path/to/results/injection-postflight.json
```

Postflight requires the exact app PID to have an established TCP connection
to `127.0.0.1:8898` and to have loaded both `iOSInjection` and `SwiftTrace`.
It then reads `get_logs` only from the cleared preflight window and preserves
`get_last_error`. A pass requires a compile/injection log entry.

For the benchmark's intentionally structural edit, the runner may instead
provide a structural-fallback receipt:

```json
{
  "schemaVersion": 1,
  "kind": "structural-fallback",
  "reason": "added-source-file",
  "sourcePaths": [
    "/absolute/path/to/codex-injection/DeliveryPreference.swift"
  ],
  "normalBuild": {
    "argv": [
      "/usr/bin/xcrun",
      "xcodebuild",
      "build",
      "-derivedDataPath",
      "/absolute/path/to/derived/codex-injection"
    ],
    "exitCode": 0,
    "completedEpochMs": 1700000002000
  }
}
```

Pass it with `--fallback-evidence /absolute/path/to/fallback.json`. The helper
accepts only these structural reasons:

- `added-source-file`;
- `stored-property-layout-change`; or
- `domain-model-layout-change`.

Every named source must be a regular file inside the exact arm-C worktree. The
fallback must be a successful `xcodebuild`, finish after preflight, and use the
arm-C DerivedData path. App connection and loaded-module proof remain mandatory
even when structural fallback is used.

## Runner integration

The runner should:

1. execute preflight and preserve its JSON before the synchronized barrier;
2. preserve the arm-C app PID from `simctl launch`;
3. derive any fallback receipt from raw Codex command/file events, not from an
   agent-authored assertion;
4. execute postflight before common acceptance; and
5. fail arm C unless postflight exits `0` and returns `ok: true`.

The postflight receipt includes a SHA-256 binding to the exact preflight JSON.
Setup and connection alone do not count as InjectionIII usage.

## Tests

Tests use injected process output and an in-memory socket transport. They do
not launch GUI applications:

```sh
cd benchmark/injectioniii
npm test
```
