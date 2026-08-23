# MOOPS four-arm benchmark protocol

## Question under test

For one iOS feature that necessarily changes stored memory layout and adds a
source file, does checkpointed post-build restoration reduce Codex's total
verification-loop time?

This is a workflow benchmark, not a claim about model training or compiler
performance.

## Controlled input

Each arm starts from the Git tag `benchmark-start` in a fresh worktree and gets
only `FEATURE_PROMPT.md`. Use the same:

- Codex model, reasoning effort, permissions, and empty conversation context;
- real external durable Codex Goal, including its exact objective and stopping
  condition;
- Xcode and Swift package versions;
- `MOOPS iPhone` device type/runtime and cloned clean app-data seed;
- deterministic backend fixture revision;
- wall-clock start rule and three-hour maximum;
- final `BenchmarkFlowUITests/test3DeliveryPreferenceAcceptance` test.

Do not copy source edits, previews, traces, results, or agent conversation from
one arm into another.

Every arm starts with an empty conversation. Before release, the runner creates
all four Codex threads and installs the identical Goal while keeping every arm
paused. The shared barrier activates those Goals together. Goal continuation is
therefore a controlled factor and must not be attributed to MOOPS or
Claude-Mem.

Arm D also starts with an empty, local Claude-Mem directory; it may retain only
observations created during its own timed run. Arms A through C run without
Claude-Mem.

## Arms

### A — `CODEX + UITEST`

Codex may build, launch, inspect, and drive the app with the shared XCUITest
surface. It receives no saved MOOPS checkpoint and must establish checkout
preconditions using ordinary UI automation after a rebuild.

### B — `CODEX + PREVIEWS`

Arm A plus Xcode SwiftUI Previews. Codex may create mocks or preview wiring, but
all time spent reproducing session/cart/backend/navigation context counts. The
same real-app acceptance test is still the finish line.

### C — `CODEX + INJECTION`

Arm A plus InjectionIII 5.2.1, with:

- `MOOPS_ENABLE_INJECTIONIII=1` in the app launch environment;
- Debug `EMIT_FRONTEND_COMMAND_LINES=YES`;
- Debug linker flags `-Xlinker -interposable`;
- the official iOS injection bundle loaded at app startup.

Record each attempted injection and whether it succeeded. A fallback normal
build is allowed and counted. Do not silently categorize a fallback as a hot
reload.

The official InjectionIII documentation says it cannot inject stored-property
layout changes and does not cope well with added, renamed, or deleted files.
Those are required by this fixed task.

### D — `CODEX + MOOPS + CLAUDEMEM`

Arm A plus three progressively deeper versioned checkpoints and
`moops build-and-restore`.
Like every arm, Codex operates under the common external durable Goal. MOOPS
itself has no LLM and may restore navigation only through the shared public UI
route. Claude-Mem 13.15.3 is pinned to source commit
`e2d1df569a8f04075d40e92461128ece7cf04c82` and runs under the local,
no-telemetry profile in `CLAUDE_MEM.md`, with the Claude subscription provider
and worker port 37977 pinned for both capture and recall.

During the timed run, arm D records the three named memory descriptors
`catalog-ready`, `cart-ready`, and `checkout-ready`, ends that capture session,
and starts a fresh Codex process. The fresh process must retrieve all three via
Claude-Mem's `search → timeline → get_observations` workflow. Each descriptor
maps to a distinct executable MOOPS checkpoint, with `checkout-ready` as the
deepest feature-verification state. Memory retrieval merely selects a
candidate, which MOOPS must fingerprint and verify against fresh running-app
state.

This arm measures the combined MOOPS + Claude-Mem workflow. With no MOOPS-only
or Claude-Mem-only arm, the result must not be reported as either component's
isolated causal effect.

## Published live-demo procedure

The measured demonstration has one entry point:

```sh
moops-benchmark demo
```

`demo` owns the complete take. Separate lower-level `run` and `showcase`
commands may be used to diagnose or rehearse, but joining their outputs is not
a valid published live run.

The command must perform these phases in order:

1. Preflight the pinned source, four isolated worktrees, identical simulator
   clones, four isolated backend ports and data stores, agent configuration,
   recording capability, and output paths.
2. Open four visible Simulator windows and arrange them in an exact 2×2 grid:
   A (`CODEX + UITEST`) top-left, B (`CODEX + PREVIEWS`) top-right, C
   (`CODEX + INJECTION`) bottom-left, and D
   (`CODEX + MOOPS + CLAUDEMEM`) bottom-right. Validate the four returned
   window frames before continuing. Launch the actual app in each with its
   exact arm label and a live `HH:MM:SS` HUD driven from the same run epoch.
3. Start the composite desktop recording and all four per-simulator recordings
   before displaying the shared `3 / 2 / 1` barrier.
4. At zero, publish the fixed prompt and activate all four previously paused
   Goals from the same monotonic release point. Each arm receives the same
   three-hour deadline.
5. Run each arm's independent copy of the shared XCUITest acceptance journey
   and verify that arm's received order against only its deterministic backend
   receipt. No backend or receipt may be shared across arms.
6. Persist the accepted verification receipt with the run identity, then
   relaunch each successful actual app with
   `MOOPS_SHOW_LAST_VERIFICATION=1`. The app may show its green
   `FEATURE VERIFIED` result only when that persisted receipt belongs to the
   current run. Leave the four result screens visible before stopping the
   recordings.

The runner fails closed if it cannot prove the exact 2×2 frame arrangement; a
1×4 row or any other ordering is not a valid published run. It also fails on a
missing agent, premature Goal release, backend collision, recording failure,
acceptance failure, missing receipt, or mismatched run identity. The visual
green screen is a presentation of independently collected evidence, not the
evidence source.

The recordings must make the setup, synchronized start, live elapsed time, and
final state legible in one take. One take is a demo, not statistical evidence;
comparative claims require repeated counterbalanced runs.

## Why this task is diagnostic

| Edit required by the prompt | Preview | InjectionIII | MOOPS after rebuild |
| --- | --- | --- | --- |
| New `DeliveryPreference.swift` file | Rebuilds preview; update mock/wiring | Documented weak boundary | Builds, then restores |
| New stored view-model state | Preview can reconstruct a model | Cannot inject changed memory layout | Builds, then restores |
| Changed `Order` stored layout | Preview can update its mock | Cannot inject changed memory layout | Builds, then restores |
| Persistence/service wiring | Preview needs an equivalent configured store | Structural change needs rebuild | Uses the real installed app store |
| Real session/cart/navigation | Must be reproduced explicitly | Preserved only until required rebuild | Durable state plus verified UI trace |
| Real POST and relaunch proof | Preview cannot prove the journey | Hot code covers only part | Shared end-to-end acceptance |

## Timing

Start total task time immediately before the feature prompt becomes visible to
Codex. In the live command, this is the barrier's shared zero point. Stop an
arm's completion clock only after both the common acceptance test and its
isolated backend receipt check pass; keep the recording running through the
verified-app relaunch.

For every meaningful source-edit iteration record monotonic timestamps for:

1. source edit complete;
2. build complete (or verified injection complete);
3. app launched;
4. checkout state established/restored;
5. fresh observation verified.

Report raw runs plus:

- total task completion time;
- median edit-to-verified-observation latency;
- total build/injection time;
- total setup/restore time;
- verification iteration and failure counts;
- InjectionIII injection and fallback counts.
- arm-D memory indexing, session restart, recall, and wrong-checkpoint counts.

Use repeated counterbalanced runs before making a comparative claim. A single
hackathon run is a demo, not statistical evidence.

## Validity rules

- Every landing assertion reads a fresh accessibility hierarchy.
- No arm may use test-only data that bypasses the production cart/order path.
- The backend may expose its last received order as independent evidence, but
  may not fabricate app state. Each arm must use a separate backend instance
  and receipt namespace.
- Installing a rebuilt app must not uninstall/erase ordinary application data.
- A MOOPS restore that lands on the wrong screen is a failure.
- Claude-Mem recall is not a restore; a recalled descriptor must still pass
  the checked-in registry, MOOPS fingerprint, and fresh landing predicates.
- The three MOOPS checkpoints may validate existing session/cart state but may
  not seed or fabricate it; missing authentication or an empty cart must fail.
- Arm D must use a fresh Codex process for recall, and its local memory store
  must contain no observations from an earlier benchmark run.
- A displayed green result must be reconstructed from a persisted successful
  receipt for the current run after relaunch with
  `MOOPS_SHOW_LAST_VERIFICATION=1`; labels or launch flags alone cannot create
  success.
- A Preview screenshot alone and an InjectionIII log alone are insufficient for
  final acceptance.
