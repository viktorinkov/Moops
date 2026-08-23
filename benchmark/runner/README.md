# Four-arm benchmark runner

This directory contains the executable orchestration layer for the MOOPS demo.
It starts four isolated Codex arms behind one barrier, records an auditable live
clock, runs the identical acceptance test, and can produce a composite visual
showcase. It does not create or delete worktrees or simulators.

## Fixed arms

| ID | Visible label | Intended capability |
| --- | --- | --- |
| `codex-uitest` | `CODEX + UITEST` | UI automation only |
| `codex-previews` | `CODEX + PREVIEWS` | UI automation and SwiftUI Previews |
| `codex-injection` | `CODEX + INJECTION` | UI automation and InjectionIII |
| `codex-moops-claudemem` | `CODEX + MOOPS + CLAUDEMEM` | UI automation, MOOPS, and Claude-Mem |

The manifest admits only these IDs, labels, and ordering. It also fixes:

- model `gpt-5.6-sol`;
- service tier `fast`;
- deadline `10800` seconds;
- one baseline commit and prompt;
- one global agent command template and acceptance command template;
- four unique worktrees, simulator UDIDs, DerivedData paths, result paths, and
  loopback backend ports;
- one deterministic backend fixture revision.

Every arm gets a private `CODEX_HOME`. All four homes contain only the common
Apple Xcode MCP configuration (`/usr/bin/xcrun mcpbridge`); Arm D additionally
gets the pinned local Claude-Mem plugin. The runner scrubs inherited treatment
variables, inventories the live app-server MCP/plugin surface, and fails if A-C
expose Claude-Mem or if any arm lacks Xcode MCP.

Copy `benchmark.example.json` to a local ignored manifest and replace the four
UDID placeholders and illustrative `MCP_XCODE_PID` values. `validate` checks
the manifest and prompt without creating resources:

```sh
benchmark/runner/moops-benchmark validate benchmark/runner/benchmark.local.json
```

## Provisioning is explicit

Before `run`, provision four worktrees at the exact baseline, four dedicated
simulators with independently cloned app-data seeds, and empty dedicated
DerivedData/result directories. Boot the simulators. The runner requires every
worktree to be clean and at the resolved baseline and every simulator to be
booted before it exposes the prompt.

Open each arm's canonical project in a separate Xcode process:
`$ARM_WORKTREE/benchmark/FoodDelivery/Food Delivery.xcodeproj`. Put that
process's positive PID in the arm's `MCP_XCODE_PID`; all four values must be
distinct. The runner scrubs any inherited host PID before applying the arm
environment.

Do not share backend port `8055` across arms. The runner starts one fixture
process per declared port, checks `/healthz` for the pinned catalog revision,
records its PID, and stops only that PID's process group. Each process has an
independent in-memory order ledger and reset state.

The runner never resets a worktree, erases app data, deletes a simulator, or
removes a directory. `cleanup-plan` prints reviewable targets and commands but
does not execute them:

```sh
benchmark/runner/moops-benchmark cleanup-plan benchmark/runner/benchmark.local.json \
  --run-id RUN_ID
```

## One-command live demo (measured path)

Inspect the full plan without booting a simulator, creating a directory, or
starting a process:

```sh
benchmark/runner/moops-benchmark demo benchmark/runner/benchmark.local.json \
  --run-id take-001 --dry-run
```

After granting Terminal Screen Recording and Accessibility permissions, run the
same command without `--dry-run`. This is the intended public demo entrypoint.
In one live take it:

1. boots and opens the four already-provisioned dedicated simulators;
2. starts four independent deterministic backends;
3. launches the baseline apps with their visible labels and common clock;
4. enforces the exact 2x2 grid—UITEST top-left, PREVIEWS top-right, INJECTION
   bottom-left, and MOOPS+CLAUDEMEM bottom-right—then begins one full-region
   desktop recording and four `simctl recordVideo` recordings;
5. stages four durable Codex Goals, shows the visible 3/2/1 slate, and activates
   them at one barrier;
6. runs the common acceptance in each arm as that arm finishes;
7. relaunches each accepted app with `MOOPS_SHOW_LAST_VERIFICATION=1`, so the
   app displays its persisted real-order verification receipt after XCTest has
   terminated it; and
8. stops only the recorder process groups it started, preserving simulators,
   app data, worktrees, and evidence.

The demo is green only when all five recorder processes stop cleanly, their
outputs are non-empty regular files, and `ffmpeg` converts the full-region
source to `moops-four-arm-live.mp4`. The verified MP4 is copied without
overwrite to `results/live-demo/moops-four-arm-live.mp4`. Its run path, stable
path, converter status, PID, signal, and byte size are recorded in
`live-demo.evidence.json`.

The final relaunch cannot manufacture a green state. The app can show it only
after the real backend POST has produced the persisted verification receipt.
If that relaunch fails, the arm fails closed even if XCTest passed.

The Accessibility tiler identifies the four uniquely named Simulator devices,
places them in the fixed cells, rereads every frame, and fails closed on a
missing, duplicated, reordered, or one-pixel-misaligned target window. Unrelated
Simulator windows are ignored by title. Provision
the simulator device names exactly as `MOOPS A UITEST`, `MOOPS B PREVIEWS`,
`MOOPS C INJECTION`, and `MOOPS D MEMORY`. No alternate layout is a valid
benchmark recording. Grant the runner/Terminal Accessibility and Screen
Recording permissions before the live command; either missing permission
aborts preflight.

## Headless timed run

```sh
benchmark/runner/moops-benchmark run benchmark/runner/benchmark.local.json \
  --run-id take-001
```

Preflight and backend startup are outside the measured interval. Direct
`codex exec` is rejected as rehearsal-only. For every arm the runner speaks the
Codex app-server JSONL protocol and requires this evidence before joining the
barrier:

1. `initialize` / `initialized` succeeds with Goal protocol capability enabled;
2. a durable, non-ephemeral thread starts at the arm worktree with requested
   model `gpt-5.6-sol` and requested service tier `fast`;
3. the exact fixed feature prompt plus an identical stopping-rule suffix is
   persisted as a paused Goal;
4. both `thread/goal/updated` and `thread/goal/get` prove paused status with zero
   usage and no turn has started; and
5. `thread/settings/updated` proves approval policy `never`, the exact model and
   cwd, and a common `workspaceWrite` policy with local network access plus only
   the arm's DerivedData and results as extra writable roots.

Codex currently may report requested tier `fast` as effective tier `priority`;
the ledger preserves both. At the release, the runner sends only
`thread/goal/set {status:"active"}`—it never starts a competing explicit turn.
It then requires a matching active Goal update and turn, a terminal `complete`
update tied to a completed turn, and a final persisted `goal/get` before common
acceptance can run. `blocked`, usage-limited, budget-limited, paused, missing,
or contradictory evidence fails the arm.

Arm D has an additional fail-closed lifecycle. Before staging, the runner calls
that worktree's `benchmark/claude-mem/run-arm-d --doctor-fresh` with the unique
store ID `<run-id>-arm-d` and verifies the resulting store path and pinned
Claude-Mem `13.15.3`. It then launches the otherwise-identical `codex
app-server` argv through `run-arm-d`. After Goal completion, the wrapper's exact
worker PID/version/store shutdown receipt is parsed from trailing output, the
wrapper must exit zero, and `run-arm-d --doctor` must prove the store identity
and unused worker port before acceptance may begin. During the timed Goal, Arm
D must emit three registry packets separately, launch the fresh read-only
`recall-helper.mjs`, and run `verify-recall.mjs`. That ephemeral helper must use
exactly `search -> timeline -> get_observations`, retrieve all three executable
checkpoint paths and fingerprints, select checkout-ready, and leave a verified
JSONL receipt. The outer Goal then executes the selected MOOPS
`build-and-restore`. Missing, reordered, stale, or unverified evidence fails.

Arm C also has a fail-closed treatment gate. Before the barrier, the runner's
InjectionIII helper pins version `5.2.1`, proves one loopback host/listener,
watches the exact C worktree, and clears the control log window. Before common
acceptance, it binds the latest successful `simctl launch` PID to an established
Injection connection, loaded iOSInjection/SwiftTrace modules, and a compile or
injection log. A structural fallback is accepted only when raw Codex file-change
and successful arm-C DerivedData build events prove an added Swift source; the
runner, not the agent, authors that receipt.

Once all four paused Goals reach the barrier, stderr shows `START IN 3`, `2`,
`1`. Visual tiling, recorder startup, and stable-output admission finish before
the clock is assigned. A 120-second staging lead then keeps the exact declared
epoch available to all four app-server process environments; missing the
countdown or release window fails closed. Every arm receives the same:

- `MOOPS_BENCHMARK_START_EPOCH_MS`;
- `MOOPS_BENCHMARK_DEADLINE_EPOCH_MS`;
- `MOOPS_BENCHMARK_RUN_ID`;
- `MOOPS_BENCHMARK_PROMPT_PATH` and `MOOPS_BENCHMARK_PROMPT_SHA256`;
- `MOOPS_BENCHMARK_MODEL` and `MOOPS_BENCHMARK_SERVICE_TIER`.

Arm-specific values are `MOOPS_BENCHMARK_ARM_ID`,
`MOOPS_BENCHMARK_ARM_LABEL`, worktree, simulator, DerivedData, results, and
`MOOPS_BACKEND_BASE_URL`. Equivalent `SIMCTL_CHILD_...` values are present so
agent-issued `simctl launch` commands pass the clock, label, and backend URL to
the app. Only arm C gets `MOOPS_ENABLE_INJECTIONIII=1`. All four app-server
threads use the same fixed Goal objective; arm-specific developer instructions
state and hash the treatment policy. Runtime gates require successful Xcode MCP
in every arm. The first Xcode call must be `XcodeListWindows`; its result must
contain only that arm's exact canonical project tab, and subsequent tab-bound
calls must reuse its identifier. B additionally proves its `RenderPreview`
arguments target that tab, while every other arm forbids Preview. The Injection
receipt remains C-only and the verified recall/MOOPS chain remains D-only.

The shared acceptance test does not reliably inherit the shell environment.
For each arm the runner therefore:

1. finds the newest built `FoodDeliveryBenchmark_*.xctestrun`;
2. makes a unique copy directly beside it, preserving `__TESTROOT__`;
3. injects the exact run ID, label, arm ID, common clock, dedicated backend URL,
   and arm-C InjectionIII flag into both `EnvironmentVariables` and
   `UITargetAppEnvironmentVariables`;
4. runs the configured acceptance command against the copy;
5. removes only that temporary copy.

The source `.xctestrun` is never modified.

Each run writes a global `events.jsonl` and `summary.json`, plus dedicated arm
logs, the exact client request JSONL, raw app-server JSONL, and
`arm-result.json`. Events include ISO wall time, epoch milliseconds, monotonic
nanoseconds, sequence number, synchronized activation timestamps, one-second
heartbeats, requested/effective thread settings, every Goal status and turn,
commands, versions, commits, prompt and Goal-objective hashes, backend
PID/port/revision, deadline termination, final Goal evidence, and acceptance
result. Any failed invariant, premature turn, protocol contradiction, timeout,
backend exit, injection error, or acceptance failure makes the run fail.

Each arm result also carries measured online Goal-loop metrics: activation to
agent completion, first structured real-app feedback (successful Xcode MCP or
`simctl launch`), build and agent-verification iteration counts, common
acceptance duration/count, and total barrier-to-green time. Arm D additionally
parses the real MOOPS JSON phase timings for build/install/launch/state restore
and fresh landing verification. A missing structured observation stays `null`;
the runner does not estimate it. “Reinforcement” here means faster online
observe/edit/build/restore/verify iterations through a durable Goal, not model
weight training.

## Publish reviewable transcripts

Raw evidence remains private under `.benchmark-runs`. After a run has produced
all four transcript sets, publish a sanitized, reviewable bundle explicitly:

```sh
benchmark/runner/moops-benchmark publish-transcripts \
  benchmark/runner/benchmark.local.json --run-id take-001
```

The command writes `results/runs/take-001/` with global `summary.json` and
`events.jsonl`, plus each arm's app-server requests, app-server responses,
stderr, and `arm-result.json`. `bundle.json` records source/output hashes,
record counts, byte counts, and redaction counts without publishing private
source paths. Wall-clock and monotonic timing, Goal/tool events, exit status,
metrics, and failures remain reviewable.

Publication redacts credential-shaped fields and text, authorization material,
private-key blocks, user/temp paths, and every configured worktree,
DerivedData, result, repository, and run-root path. It requires bounded regular
files and valid JSON/JSONL for every arm, refuses unsafe run IDs and existing
destinations, and atomically exposes the bundle only after every file passes.
An empty stderr log is valid; missing or empty structured transcripts are not.

## Post-run visual replay

First inspect the exact non-mutating plan:

```sh
benchmark/runner/moops-benchmark showcase benchmark/runner/benchmark.local.json \
  --run-id take-001 --dry-run
```

Then, after granting Simulator/Terminal Screen Recording and Accessibility
permissions, run it without `--dry-run`. It boots only simulators that are not
already booted, opens four Simulator instances, restarts the four dedicated
backends, launches the app with the original common clock and visible arm label,
and records:

- `moops-four-arm-showcase.mp4` converted from the configured full-region
  recording;
- one H.264 `simctl recordVideo` MP4 per simulator;
- a visible three-second `MOOPS LIVE` slate before the showcase.

The runner records and stops only recorder PIDs it created. `SIGINT` stops the
recorders cleanly; it does not shut down simulators, terminate unrelated apps,
or delete files.

Window placement is fail-closed through the same uniquely titled window/frame
receipt. Accessibility denial or any wrong frame aborts before the slate. The
required grid is:

| | Left | Right |
| --- | --- | --- |
| Top | CODEX + UITEST | CODEX + PREVIEWS |
| Bottom | CODEX + INJECTION | CODEX + MOOPS + CLAUDEMEM |

The composite full-region MP4 and exact frame validation are implemented. This
command is a replay of an already completed run. Use `demo` for the measured
live four-arm claim.

## Fairness boundary

Dedicated resources prevent data, build, backend-receipt, credential-home, and
timing leakage. Live app-server inventory and raw tool events prove plugin
isolation and required treatment use. The benchmark still shares the checked-in
source baseline, so this is a capability/use comparison—not proof that agents
could not read another arm's public harness files.

A single four-arm hackathon take is a visual demonstration, not statistical
evidence. Use repeated counterbalanced runs for a comparative claim.

## Tests

Tests use temporary directories and fake arm/backend adapters only. They do not
create worktrees, simulators, or real recordings.

```sh
cd benchmark/runner
npm test
```
