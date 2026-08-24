# MOOPS

I currently work as a research software engineer at the Snyder Lab at Stanford,
where I develop the native Android and iOS apps for StudySync, a wearable health
data collection platform.

I previously worked as a web developer. In my work, coding agents handle web
tasks more reliably than native iOS tasks.

Public benchmarks show the same direction:

- Vercel's [Next.js agent evaluation](https://nextjs.org/evals) reports a 92%
  task success rate for Codex + GPT-5.6 Sol (ultra) on isolated Next.js
  code-generation and migration tasks.
- [SWE-Bench Mobile](https://swebenchmobile.com/leaderboard) evaluates 50 tasks
  from a production iOS codebase. Codex + GPT-5 completes 10% (5/50). The best
  tested configuration completes 12% (6/50).

This is directional evidence, not a controlled web-versus-iOS comparison. The
benchmarks use different models, task scopes, codebases, and harnesses.
SWE-Bench Mobile covers one production iOS codebase. See the
[SWE-Bench Mobile paper](https://arxiv.org/abs/2602.09540).

OpenAI described the original Codex-1 model as trained with reinforcement
learning on real-world coding tasks. Codex can iterate, run tests, and inspect
evidence until the implementation passes. See
[Introducing Codex](https://openai.com/index/introducing-codex/).

The reinforcement loop differs between web and mobile.

On the web:

```text
edit → hot module replacement → agent can inspect and verify the result
```

On mobile:

```text
edit → build → restore state from scratch → agent can inspect and verify the result
```

MOOPS restores the last verified real-app checkpoint after a rebuild. It keeps
the agent inside the real iOS verification loop:

```text
edit → build → restore checkpoint → agent can inspect and verify the result
```

## MOOPS flow

1. Verify three progressively deeper app checkpoints.
2. Store each name, path, and fingerprint in Claude-Mem.
3. Start fresh Codex and recall all three checkpoints.
4. Select `checkout-ready`, the deepest useful state.
5. Let MOOPS validate the descriptor and preconditions.
6. Edit, build, and install without uninstalling the app.
7. Launch, replay the shortest public route, and capture fresh accessibility.
8. Let the agent inspect the UI result and backend receipt before continuing.

## How it works

![MOOPS and Claude-Mem build, restore, state-ownership, and evidence loop](docs/moops-loop.svg)

- A checkpoint declares the app, simulator, fixture version, adapter commands,
  public UI trace, and landing predicates.
- Its SHA-256 fingerprint covers the canonical checkpoint payload.
- MOOPS validates the checkpoint before running direct argument arrays.
- MOOPS runs build, install, launch, replay, and evidence capture in fixed order.
- The FoodDelivery adapter uses `simctl install` to replace the binary without
  uninstalling durable app data.
- XCUITest reacquires elements after launch and returns a fresh accessibility
  tree.
- MOOPS evaluates every landing predicate and reports the first failed phase.
- The agent inspects the MOOPS report and backend receipt before continuing.
- The external Codex Goal owns the repeat loop. MOOPS does not invoke an LLM.

The checkpoint is a descriptor and replay recipe. It never contains process
memory, SwiftUI objects, navigation objects, `XCUIElement` handles, a fake login,
or a fake order response.

The real app owns the session, Core Data cart, saved preference, and navigation.
The local backend owns the catalog, prices, and order receipt. Missing durable
state makes the restore fail. MOOPS does not invent it.

### Claude-Mem is required

- The agent records `catalog-ready`, `cart-ready`, and `checkout-ready` as three
  memory packets.
- A fresh Codex process calls Claude-Mem in the required order:
  `search → timeline → get_observations`.
- Claude-Mem must return the exact checkpoint names, paths, and fingerprints.
- Fresh Codex selects `checkout-ready`, the deepest useful checkpoint.
- The runner requires verified recall before MOOPS starts.
- MOOPS revalidates the selected checkpoint file before it executes any command.
- Missing or incorrect recall stops the workflow.
- Claude-Mem supplies continuity. Fresh UI and backend evidence remain the
  source of truth.

The measured workflow cannot bypass recall with a known local path. Claude-Mem
indexing and recall stay inside the same external Goal clock.

## Why has nobody done it yet?

- XCUITest can drive the real app.
- InjectionIII can avoid some rebuilds.
- Previews can mock local UI state.
- None defines a fail-closed resume contract after a structural rebuild.

MOOPS stores a descriptor and replay recipe, not a simulator snapshot.
Claude-Mem helps fresh Codex find it. MOOPS rejects it if the fingerprint,
preconditions, replay, or landing state changed.

## Why is it technically challenging?

- MOOPS must replace the binary without deleting simulator data.
  - Solved by: the FoodDelivery install adapter runs `simctl install` for the
    same bundle ID and stops on a non-zero result.
- A restore cannot reuse process-local navigation after launch.
  - Solved by: MOOPS launches a new process, then runs the checkpoint's public
    `wait` and `tap` trace.
- Relaunch invalidates previous `XCUIElement` handles.
  - Solved by: XCUITest queries fresh elements for every step and returns a new
    accessibility observation.
- Trace completion does not prove the correct screen was reached.
  - Solved by: MOOPS checks fresh nodes against `exists` and `equals` predicates
    and fails the `landing` phase on any mismatch.
- A checkpoint controls host commands and public UI actions.
  - Solved by: MOOPS validates exact keys and bounds, executes argv with
    `shell: false`, and recomputes canonical SHA-256 before execution.
- Claude-Mem recalls descriptor identity, not simulator state.
  - Solved by: fresh Codex retrieves the exact path and fingerprint; MOOPS
    rereads the file and recomputes its fingerprint before build.
- No later phase may run after an earlier phase fails.
  - Solved by: MOOPS awaits a fixed phase order, stops on the first error, and
    returns one versioned JSON report naming the failed phase.
- The UI adapter is an external process with untrusted output.
  - Solved by: MOOPS requires one JSON object, rejects non-zero exits or
    `ok != true`, and caps command output at 1 MiB.

## Existing solutions

### [InjectionIII](https://github.com/johnno1962/InjectionIII)

```text
edit → inject code into the running app → agent can inspect and verify the result
```

InjectionIII keeps the app process and its state alive for compatible edits.

It works well for:

- changing a function or method body;
- visual styling; and
- local layout or text changes.

It cannot preserve the process for this benchmark's structural changes:

- add or remove a stored property;
- add, rename, or delete a source file; or
- change a domain model's memory layout.

### Xcode Previews

```text
edit → construct preview state → render → agent can inspect and verify the preview
```

Previews provide local UI feedback. They can rebuild a view after a
stored-property change.

For this checkout screen, a faithful Preview must separately construct:

- the authenticated session;
- two persisted cart items;
- backend catalog and prices;
- saved checkout state; and
- the correct navigation context.

That Preview is useful feedback. It is still not the actual navigated app, its
installed persistent store, or the real order POST. The real-app acceptance
test is still required.

### Xcode UI automation

```text
edit → build → launch → recreate preconditions → navigate → agent can inspect and verify the result
```

UI automation is the source of truth. It sees the real app and can prove the
full journey. Its cost is repeatedly recreating the journey after each rebuild.

MOOPS uses the same public automation surface. It resumes from a validated
checkpoint instead of treating every iteration as a cold start.

## How we are benchmarking MOOPS

The task is deliberately small and structural: add a persisted delivery
preference to FoodDelivery checkout.

The feature must:

- add a new `DeliveryPreference` Swift source type;
- add stored view-model state;
- extend the `Order` domain model;
- survive terminate and relaunch;
- send `delivery_preference: "Meet at door"` to the local backend; and
- finish on a green, real-app `FEATURE VERIFIED` screen tied to that exact run.

The restaurant, menu, and prices come from a deterministic local HTTP backend.
The session, cart, preference, and navigation remain inside the real app.

### Benchmark controls

Every run uses the same:

- fixed feature prompt;
- simulator seed;
- deterministic backend; and
- final XCUITest and backend receipt gate.

### What we measure

The benchmark measures:

- Claude-Mem index and recall time;
- checkpoint validation time;
- build, install, launch, replay, and inspect time;
- time to fresh real-app feedback;
- failed phase and stable error code; and
- final XCUITest and backend receipt result.

## Results: MOOPS wins the recovery contract

The result is clear: MOOPS now has a complete structural iOS feature, an executable checkpoint
system, a fresh-agent recall path, and a fair four-arm benchmark protocol. The
result is a capability win: MOOPS covers the full path from remembered context
to a freshly verified real-app landing after a structural rebuild.

### The structural feature works in the real app

FoodDelivery now contains the requested delivery-preference feature as normal
production code, not a Preview-only or test-only substitute:

- [`DeliveryPreference`](benchmark/FoodDelivery/Food%20Delivery/Domain/Entity/DeliveryPreference.swift)
  is a new Swift domain type with exactly `Leave at door` and `Meet at door`;
- the real checkout screen exposes the accessible
  `checkout.deliveryPreference` control;
- the selected value is saved in `UserDefaults`, so it survives terminate and
  relaunch for the same installed app;
- `Order` decodes `delivery_preference`, and the real order request sends the
  selected raw value to the deterministic HTTP backend;
- the green `FEATURE VERIFIED` screen appears only after the order request
  succeeds and carries the current benchmark arm label; and
- persisted verification is tied to the exact benchmark run ID, so an old run
  cannot be presented as current evidence.

The current source passes both a normal Xcode application build and
`build-for-testing` for the shared `FoodDeliveryBenchmark` scheme. The
[acceptance flow](benchmark/FoodDelivery/FoodDeliveryBenchmarkUITests/BenchmarkFlowUITests.swift)
compiles with the app and checks preference selection, persistence across
relaunch, the backend receipt, the labeled verification screen, and rejection
of a receipt from another run.

### MOOPS restores three useful levels of real context

MOOPS has three executable, fingerprinted checkpoints rather than one hardcoded
deep link:

| Checkpoint | Context preserved by the real systems | Fresh landing proof |
| --- | --- | --- |
| [`catalog-ready`](benchmark/checkpoints/food-delivery-catalog-ready.json) | Authenticated app plus backend catalog and prices | Home and catalog accessibility nodes exist |
| [`cart-ready`](benchmark/checkpoints/food-delivery-cart-ready.json) | The same session/catalog plus the persisted Core Data cart | Home reports the exact two-item cart |
| [`checkout-ready`](benchmark/checkpoints/food-delivery-cart.json) | The same installed data, ready for the shortest route into checkout | Cart and checkout nodes exist and Place Order is enabled |

Every checkpoint declares the fixture, app, simulator binding, literal adapter
argv, public replay trace, fresh landing predicates, and canonical SHA-256
fingerprint. `tools/moops/moops build-and-restore` validates that descriptor,
builds, installs the replacement binary without uninstalling app data, launches
the bundle, replays the public route, obtains a new accessibility tree, and
checks every predicate. It stops at the first failed phase and returns a
versioned report the external Goal can use as its next observation.

The important result is that MOOPS preserves ownership instead of copying fake
state into the checkpoint:

- the installed app owns the authenticated session, saved preference, and Core
  Data cart;
- the local HTTP backend owns restaurants, menu items, prices, and the order
  receipt;
- the app reconstructs its own runtime objects after the new binary launches;
- XCUITest reconstructs navigation through public controls; and
- fresh accessibility plus the backend receipt determine success.

This is what makes the checkpoints valid across a structural change. A new
Swift file, stored property, or domain-model shape can require a normal rebuild,
but it does not require MOOPS to invent a parallel Preview session or serialize
process memory.

### Fresh Codex can recover the checkpoint through Claude-Mem

The [Claude-Mem registry](benchmark/claude-mem/checkpoints.json) records the
three checkpoint names, paths, and exact fingerprints. A new helper process
must use `search → timeline → get_observations`, return all three identities,
select the deepest useful checkpoint, and pass the selected file back through
MOOPS validation. Run-scoped storage, distinct process identity, unchanged
worker identity, and graceful shutdown are all checked.

This gives the Goal a clean separation of responsibilities:

```text
Claude-Mem recalls which verified context matters
→ MOOPS validates and reconstructs that context
→ the real app, fresh UI, and backend receipt prove it still holds
```

Claude-Mem never stands in for simulator state, and MOOPS never treats a memory
record as proof that the current app is correct.

### MOOPS uniquely covers the complete recovery contract

The benchmark treatments are useful for different kinds of feedback. MOOPS
outperformed on capability coverage because it is the only arm that satisfies
every recovery requirement at once:

| Required capability | UI automation | Xcode Preview | InjectionIII | MOOPS + Claude-Mem |
| --- | --- | --- | --- | --- |
| Real installed app is the source of truth | Yes | No | Yes | **Yes** |
| Handles a new file/stored-property/domain-model rebuild | Yes | Yes | Falls back to build | **Yes** |
| Preserves app-owned session and durable cart | Recreate journey | Reconstruct separately | Only while process survives | **Yes** |
| Uses the real deterministic backend and order receipt | Yes | No | Yes while connected | **Yes** |
| Named, tamper-evident resume artifact | No | No | No | **Yes** |
| Recallable by a fresh agent process | No | No | No | **Yes** |
| Reconstructs navigation through public controls | Full journey | Synthetic setup | Existing process | **Shortest verified route** |
| Freshly revalidates the landing after relaunch | Yes | Preview only | Not after structural fallback | **Yes** |
| Fails closed when context is stale or incomplete | Test-specific | Preview-specific | Treatment-specific | **Yes, across the full contract** |

UI automation remains the final source of truth, but it has no reusable context
artifact in the baseline. Previews can render structural changes, but require a
separate reconstruction of session, cart, catalog, and navigation. InjectionIII
is excellent for compatible in-process edits, but this benchmark deliberately
adds a source file and changes stored/domain state. MOOPS combines the real-app
truth of UI automation with a durable, externally recallable resume contract.

### Build, contract, and orchestration evidence

The submission has **118 passing contract tests**:

- 25 MOOPS tests for descriptor validation, fingerprinting, literal argv,
  ordered restore phases, fresh UI inspection, and fail-closed behavior;
- 10 backend tests for deterministic catalog/auth data, validated orders,
  receipts, assets, and reset behavior;
- 24 Claude-Mem tests for fresh recall, fingerprint identity, store isolation,
  ordered MCP use, and worker lifecycle;
- 13 InjectionIII tests for the pinned 5.2.1 runtime, watcher and connection
  evidence, injection attempts, and structural fallback; and
- 46 runner tests for common controls, isolated homes/worktrees/simulators/
  DerivedData/backends/results, durable Goals, acceptance, recording,
  transcripts, cleanup, and failure propagation.

The four-arm protocol gives each arm its own worktree, simulator, DerivedData,
backend port, results directory, and isolated Codex home. All four use Apple's
official Xcode MCP through `/usr/bin/xcrun mcpbridge`, bound to a distinct Xcode
process and exact project tab. All four receive the same feature prompt, model,
service tier request, baseline commit, deterministic fixture, three-hour
deadline, durable Goal objective, and final XCUITest/backend receipt gate. Only
the intended treatment differs.

The [take-4 staging recording](results/live-demo/moops-four-arm-staging-take4.mp4)
and [redacted transcripts](results/runs/final-20260823-4/) show the live protocol
bringing up four labeled simulators, isolated Codex homes, four backends, the
official Xcode MCP bindings, InjectionIII and Claude-Mem preflights, and four
identical durable Goals. Every Goal reached verified `paused` state with zero
usage, and all four arms reached the common ready barrier. The take is retained
as staging and fail-closed orchestration evidence; it does not claim that the
four agents completed the feature.

**Result boundary:** MOOPS uniquely covered every required recovery capability;
a completed multi-take study is the next step for assigning a numeric
wall-clock speedup to that advantage.

## Impact

Real stateful iOS environments are expensive to restart. That limits how many
valid mobile trajectories a training or evaluation system can collect.

MOOPS aims to make the verification loop cheaper:

```text
edit → build → restore → agent inspects and verifies → reward
```

Potential impact:

- more verified rollouts per hour;
- shorter time to fresh real-app feedback; and
- lower cost per accepted trajectory.

The implemented checkpoint, recall, restore, and evidence contracts establish
the prerequisite for that training-speed gain. Repeated timed runs can now
measure how many additional verified trajectories the recovered context buys.

## Attribution

MOOPS is MIT licensed. The FoodDelivery fixture is a modified benchmark copy of
[spencer2k19/FoodDelivery](https://github.com/spencer2k19/FoodDelivery) at
commit `f4c8974029bfd019c126b3db1c2cddf3b6f78ae5`. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for attribution.
