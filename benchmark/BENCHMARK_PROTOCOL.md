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
- Xcode and Swift package versions;
- `MOOPS iPhone` device type/runtime and cloned clean app-data seed;
- deterministic backend fixture revision;
- wall-clock start rule and three-hour maximum;
- final `BenchmarkFlowUITests/test3DeliveryPreferenceAcceptance` test.

Do not copy source edits, previews, traces, results, or agent conversation from
one arm into another.

## Arms

### A — UI automation

Codex may build, launch, inspect, and drive the app with the shared XCUITest
surface. It receives no saved MOOPS checkpoint and must establish checkout
preconditions using ordinary UI automation after a rebuild.

### B — UI automation plus Previews

Arm A plus Xcode SwiftUI Previews. Codex may create mocks or preview wiring, but
all time spent reproducing session/cart/backend/navigation context counts. The
same real-app acceptance test is still the finish line.

### C — UI automation plus InjectionIII

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

### D — UI automation plus MOOPS

Arm A plus the versioned checkout checkpoint and `moops build-and-restore`.
Codex operates under an external durable Goal. MOOPS itself has no LLM and may
restore navigation only through the shared public UI route.

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
Codex. Stop only after the common acceptance test passes.

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

Use repeated counterbalanced runs before making a comparative claim. A single
hackathon run is a demo, not statistical evidence.

## Validity rules

- Every landing assertion reads a fresh accessibility hierarchy.
- No arm may use test-only data that bypasses the production cart/order path.
- The backend may expose its last received order as independent evidence, but
  may not fabricate app state.
- Installing a rebuilt app must not uninstall/erase ordinary application data.
- A MOOPS restore that lands on the wrong screen is a failure.
- A Preview screenshot alone and an InjectionIII log alone are insufficient for
  final acceptance.
