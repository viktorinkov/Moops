# MOOPS fast verification spec

**Status:** three-hour benchmark prototype  
**Platform:** one iOS Simulator  
**Agent:** external Codex Goal; MOOPS contains no LLM

## Claim

MOOPS shortens the loop for an iOS edit that requires a normal rebuild:

> edit → build → restore the last verified app state → inspect → continue

InjectionIII is expected to win for compatible method-body and visual changes.
MOOPS targets the boundary where injection cannot preserve the process because
a new file, stored property, domain type, dependency, or app wiring requires a
rebuild. MOOPS does not make compilation or reinforcement learning faster; it
reduces repeated environment reconstruction for an externally orchestrated
agent loop.

## One benchmark task

The normalized FoodDelivery fixture uses:

- a real persisted login session;
- a real Core Data cart;
- catalog and prices from a deterministic local HTTP server;
- the app's real navigation and order submission.

Every arm receives `benchmark/FEATURE_PROMPT.md`: add a persisted
`DeliveryPreference` domain type and checkout control, extend the existing order
model, then send it to the order endpoint. The task adds Swift files and stored
view-model state, changes persistence/wiring, and must survive terminate/relaunch.

Modifiers and delivery addresses are excluded because the supplied app has
neither. The existing generic comment field is removed from the normalized
starting fixture so it cannot trivialize the task.

## Four isolated arms

| Arm | Extra iteration tool |
| --- | --- |
| UI automation | None |
| UI automation + Previews | Faithful SwiftUI previews may be created |
| UI automation + InjectionIII | InjectionIII is installed and enabled; record injection success or fallback rebuild |
| UI automation + MOOPS | A versioned checkpoint and `build-and-restore` are available |

Use fresh worktrees and simulator data cloned from the same fixture. Keep the
feature prompt, model/config, app/backend commit, hardware, runtime, and final
acceptance test identical. A Preview or injection observation is an iteration
aid; it does not replace the shared real-app acceptance test.

## Checkpoint contract

A checkpoint contains only:

- schema version and fixture/source fingerprint;
- target app, simulator, and durable-state assumptions;
- the minimal public UI trace from launch to the useful screen;
- observable landing predicates such as accessibility identifiers and values.

It never contains process memory, SwiftUI state, serialized navigation objects,
`XCUIElement` handles, or a fabricated success response.

After a rebuild, MOOPS preserves ordinary application data, launches the new
binary, replays the public route, reacquires fresh accessibility elements, and
accepts the restore only if the landing predicates pass. A stale fingerprint,
missing durable state, wrong screen, or failed predicate stops the loop.

## Minimal commands

- `moops doctor`: validate Xcode, simulator, backend, app, and checkpoint inputs.
- `moops checkpoint`: save the already verified checkout continuation.
- `moops build-and-restore`: build/install/launch, replay, verify, and time.
- `moops verify`: run the shared landing or feature assertions against fresh UI.

The implementation may be benchmark-specific. General test DSLs, MCP, CI,
physical devices, arbitrary apps, evidence portals, screen graphs, and broad
gesture support are out of scope.

## Required runtime proof

The common acceptance path must prove all of the following in the running app:

1. authenticated user reaches a backend-priced, populated checkout;
2. the delivery preference control changes to `Meet at door`;
3. terminate/relaunch retains ordinary session/cart data;
4. restoring the checkout shows `Meet at door`;
5. placing the order causes the backend to record
   `delivery_preference: "Meet at door"`.

## Measurements

Primary: total time from prompt receipt to passing common acceptance.

Per meaningful iteration record:

- edit complete time;
- build duration;
- install/launch duration;
- state restore/setup duration;
- fresh inspection/verification duration;
- whether Preview or InjectionIII helped;
- whether InjectionIII required a rebuild fallback.

Report median edit-to-verified-observation latency, total verification-loop
time, number of iterations, and end-to-end completion time. Do not claim a win
without repeated runs.

## Success

The prototype succeeds when a structural edit triggers a real rebuild and MOOPS
reliably returns the new binary to the previously verified checkout state with
a fresh UI observation, while the same final acceptance path remains available
to every benchmark arm.

**Demo line:** InjectionIII keeps state by avoiding a rebuild; MOOPS restores the
verification state when the rebuild is unavoidable.
