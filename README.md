# MOOPS

**MOOPS speeds the iOS coding-agent reinforcement/Goal loop by checkpointing the
real mobile environment.**

It reduces reset and state-reconstruction cost after a rebuild. In a fixed
three-hour Goal, that means more:

```text
build → restore → observe → verify
```

cycles against the real app.

This demo does not update model weights. MOOPS increases
environment-interaction throughput—the mechanism that can make future mobile
reinforcement-learning training faster. It does not compile Swift faster.

I currently work as a research software engineer at the Snyder Lab at Stanford,
where I develop the native Android and iOS apps for StudySync, a wearable health
data collection platform.

I previously worked as a web developer. Current coding-agent benchmarks and
agents thrive on the web. On native iOS, they fail because the feedback loop is
slower and stateful.

On the web:

```text
edit → hot module replacement → inspect → verify
```

On mobile:

```text
edit → build → relaunch → reconstruct runtime state → navigate → inspect → verify
```

The build is only part of the cost. The agent also loses the screen and runtime
context it needed to verify the edit.

MOOPS changes the mobile loop to:

```text
edit → build → restore the last verified real-app state → inspect → verify
```

> InjectionIII keeps state by avoiding a rebuild. MOOPS restores useful state
> when the rebuild is unavoidable.

![MOOPS mobile verification loop](docs/moops-loop.svg)

The editable Draw.io source is
[`docs/moops-loop.drawio`](docs/moops-loop.drawio).

## Impact: cheaper real iOS reinforcement

Real stateful iOS environments are expensive to restart. That limits how many
valid mobile trajectories a training or evaluation system can collect.

If MOOPS makes those environments cheap to resume, the same hour and dollar can
contain more real:

```text
edit → build → restore → observe → reward
```

trajectories. Under a fixed training-compute budget, more high-quality feedback
can improve future Codex mobile performance.

That is the future training and business value:

- more verified rollouts per hour;
- lower reset latency;
- shorter time to first reward;
- more successful iterations per three-hour run; and
- lower cost per accepted trajectory.

The current demo does not prove that model weights improve. It proves the
feedback/reset mechanism: a rebuilt real iOS app can return to useful state,
produce a fresh observation, and continue an external Goal loop.

The next benchmark is an equal-compute training experiment with and without
MOOPS. It should compare held-out pass@1, total time to green, real-flow
correctness, verified rollouts per hour, and cost per accepted trajectory.

## MOOPS flow

1. Drive the real app to a useful state and verify it.
2. Validate a versioned checkpoint for that state.
3. Let the external Codex Goal edit the application.
4. Run the normal Xcode build and install the new binary without erasing app
   data.
5. Launch the rebuilt app.
6. Replay the shortest public UI route back to the checkpoint.
7. Read a fresh accessibility hierarchy.
8. Continue only when every landing predicate passes.

The current prototype uses small checked-in checkpoint files. A checkpoint
contains:

- the app and simulator identity;
- a fixture/source fingerprint;
- durable-state assumptions;
- a public accessibility trace; and
- fresh landing predicates.

It does not contain process memory, SwiftUI objects, navigation objects,
`XCUIElement` handles, a fake login, or a fake order response.

The real app still owns the logged-in session, Core Data cart, saved delivery
preference, and navigation. A deterministic local HTTP backend owns the catalog,
prices, and independently inspectable order receipt. Missing session or cart
state makes the restore fail. MOOPS does not invent it.

## How it works

- [`tools/moops`](tools/moops) validates checkpoint fingerprints and runs the
  build, install, launch, replay, and inspection phases.
- [`benchmark/checkpoints`](benchmark/checkpoints) contains three progressively
  deeper FoodDelivery checkpoints.
- An XCUITest adapter performs the public UI trace and returns a fresh,
  machine-readable observation.
- Landing predicates use accessibility identifiers and values from the rebuilt
  app.
- Every phase records elapsed time and stops on the first invalid assumption.
- The external Codex Goal owns the repeat-until-done loop. MOOPS does not embed
  or invoke an LLM.

The reduced three-hour contract is in
[`MOOPS_FAST_VERIFICATION_SPEC.md`](MOOPS_FAST_VERIFICATION_SPEC.md).

## Existing solutions

### InjectionIII

```text
edit → inject code into the running app → inspect → verify
```

InjectionIII is excellent for compatible edits because the app process and its
state stay alive.

It works well for:

- changing a function or method body;
- visual styling; and
- local layout or text changes.

It cannot preserve the process for this benchmark's structural changes:

- add or remove a stored property;
- add, rename, or delete a source file; or
- change a domain model's memory layout.

Arm C uses the official
[InjectionIII 5.2.1 release](https://github.com/johnno1962/InjectionIII/releases/tag/5.2.1RC5).
The harness proves the app connection and loaded injection runtime. It records
an injection attempt or an honest normal-build fallback. Setup alone does not
count as usage.

### Xcode Previews

```text
edit → construct preview state → render → inspect
```

Previews are excellent for local UI feedback. They can rebuild a view after a
stored-property change.

For this checkout screen, a faithful Preview must separately construct:

- the authenticated session;
- two persisted cart items;
- backend catalog and prices;
- saved checkout state; and
- the correct navigation context.

That Preview is useful feedback. It is still not the actual navigated app, its
installed persistent store, or the real order POST. Arm B must render a Preview
and must still pass the same real-app acceptance test.

### Xcode UI automation

```text
edit → build → launch → recreate preconditions → navigate → inspect → verify
```

UI automation is the source of truth for all four arms. It sees the real app and
can prove the full journey. Its cost is repeatedly recreating the journey after
each rebuild.

MOOPS uses the same public automation surface. It resumes from a validated
checkpoint instead of treating every iteration as a cold start.

## The benchmark

The task is deliberately small and structural: add a persisted delivery
preference to FoodDelivery checkout.

The feature must:

- add a new `DeliveryPreference` Swift source type;
- add stored view-model state;
- extend the `Order` domain model;
- survive terminate and relaunch;
- send `delivery_preference: "Meet at door"` to the local backend; and
- finish on a green, real-app `FEATURE VERIFIED` screen tied to that exact run.

This crosses the InjectionIII boundary but remains small enough for a fixed
three-hour benchmark. Modifiers and delivery addresses are excluded because
the supplied app has neither.

The restaurant, menu, and prices come from a deterministic local HTTP backend.
The session, cart, preference, and navigation remain inside the real app.

The fixed prompt is
[`benchmark/FEATURE_PROMPT.md`](benchmark/FEATURE_PROMPT.md).

### Four isolated arms

| Arm | Extra feedback available during the same task |
| --- | --- |
| `CODEX + UITEST` | Real app and UI automation |
| `CODEX + PREVIEWS` | UI automation plus Xcode Previews |
| `CODEX + INJECTION` | UI automation plus InjectionIII |
| `CODEX + MOOPS + CLAUDEMEM` | UI automation plus MOOPS checkpoints and Claude-Mem |

Every arm uses:

- the same `gpt-5.6-sol` model and fast service request;
- the same external durable Codex Goal;
- the same fixed prompt and 10,800-second deadline;
- a fresh worktree at the same baseline;
- an identically cloned simulator seed;
- its own backend, DerivedData, result directory, and Codex home; and
- the same final XCUITest and backend-receipt gate.

The runner stages every Goal while paused. One visible `3 / 2 / 1` barrier
activates all four. The prompt, live clock, and deadline are shared.

### Official Xcode MCP is common

All four isolated Codex homes expose Apple's official Xcode MCP through:

```text
/usr/bin/xcrun mcpbridge
```

Preflight verifies that exact bridge. Every arm must make at least one successful
Xcode MCP call. Only the Preview arm is required to call `RenderPreview`.

Xcode MCP is a controlled baseline, not a treatment variable.

The complete fairness and evidence contract is in
[`benchmark/BENCHMARK_PROTOCOL.md`](benchmark/BENCHMARK_PROTOCOL.md).

## Claude-Mem: remembering what worked

Arm D integrates
[Claude-Mem](https://github.com/thedotmack/claude-mem) `13.15.3` as a searchable
checkpoint and evidence index.

During the timed run:

1. The agent records `catalog-ready`, `cart-ready`, and `checkout-ready` as three
   separate memory packets.
2. A fresh, ephemeral, read-only Codex process calls Claude-Mem in the required
   order: `search → timeline → get_observations`.
3. It retrieves the exact checkpoint names, paths, and fingerprints.
4. It selects `checkout-ready` as the deepest useful state.
5. MOOPS validates that descriptor and restores the real app.

Claude-Mem remembers which checkpoint and evidence worked across fresh Codex
processes. MOOPS proves that the checkpoint is executable against the current
app. Memory is never accepted as app-state truth.

The recall helper records fresh process IDs and timestamps. It proves the same
local Claude-Mem worker stayed alive across recall. Storage is isolated per run
in local SQLite; telemetry and cloud sync are disabled. Memory indexing and
recall time remain inside arm D's clock.

This is a memory-as-speed experiment: less rediscovery should leave more time
for real build/restore/observe/verify cycles. The arm combines MOOPS and
Claude-Mem, so this four-arm design cannot claim the isolated causal effect of
either component.

See [`benchmark/CLAUDE_MEM.md`](benchmark/CLAUDE_MEM.md) for the exact boundary
and commands.

## Live demo

The public demo is one exact 2×2 recording:

| | Left | Right |
| --- | --- | --- |
| Top | `CODEX + UITEST` | `CODEX + PREVIEWS` |
| Bottom | `CODEX + INJECTION` | `CODEX + MOOPS + CLAUDEMEM` |

Every simulator shows the same live timer. Recording begins before the common
Goal barrier and ends only after the verified real-app screens are visible.

Run the measured take with:

```sh
benchmark/runner/moops-benchmark demo \
  benchmark/runner/benchmark.local.json \
  --run-id take-001
```

The command:

1. preflights the four isolated arms and common inputs;
2. opens the four real apps in the exact 2×2 layout;
3. starts one desktop recording and four simulator recordings;
4. releases all Goals at the same countdown;
5. runs the same acceptance journey against four isolated backends; and
6. relaunches each successful app on its persisted green verification screen.

A green screen is presentation, not evidence. Acceptance also requires the
real UI journey, the isolated backend receipt, and the exact run identity.

The runner does not create or delete worktrees or simulator seeds. Those are
explicit provisioning steps. Before timing or recording begins, the runner
requires a validated receipt proving the exact 2×2 window layout. If it cannot
prove that layout, the live run aborts.

See [`benchmark/runner/README.md`](benchmark/runner/README.md) for provisioning,
dry-run, recording permissions, and failure behavior.

### Live recording

The verified 2×2 composite will be published at:

[`results/live-demo/moops-four-arm-live.mp4`](results/live-demo/moops-four-arm-live.mp4)

The live runner first writes the private raw file under
`.benchmark-runs/.../live-demo/moops-four-arm-live.mp4`. After a verified run,
that exact file is published to the path above. It is never silently
overwritten. The public MP4 does not exist until the rehearsal passes.

## What we measure

Success alone is not the thesis. The benchmark measures feedback throughput:

- checkpoint restore time;
- time to first real-app feedback after an edit;
- build-to-restored-observation latency;
- number of verified environment-interaction cycles;
- total time to the green acceptance screen;
- build, injection, restore, and failed-iteration counts; and
- Claude-Mem indexing, fresh-process recall, and wrong-checkpoint counts.

All of those costs stay inside the common three-hour Goal window.

## Results

No comparative timing result is published yet.

The current worktree has a passing host-side contract suite for:

- the deterministic backend;
- checkpoint schema and restore sequencing;
- Claude-Mem isolation and recall verification;
- InjectionIII evidence collection;
- official Xcode MCP and per-arm policy enforcement; and
- synchronized Goal, recording, and acceptance orchestration.

Run it with:

```sh
node --test \
  benchmark/backend/test/*.test.mjs \
  tools/moops/test/*.test.mjs \
  benchmark/claude-mem/test/*.test.mjs \
  benchmark/injectioniii/test/*.test.mjs \
  benchmark/runner/test/*.test.mjs
```

These host tests do not substitute for the live four-simulator run.

| Artifact | Current status |
| --- | --- |
| Deterministic app/backend and shared acceptance path | Implemented |
| MOOPS checkpoint/build-and-restore harness | Implemented and host-tested |
| Four-arm Goal and recording runner | Implemented and host-tested |
| Claude-Mem fresh-process recall verifier | Implemented and host-tested |
| Measured four-agent live take | Pending |
| Canonical 2×2 demo MP4 | Pending |
| Repeated, counterbalanced timing result | Pending |

After the measured take, this section will link the video, raw summaries, and a
short account of where each Codex arm struggled based on its actual conversation
and command logs.

A single live take is a demo. A performance claim requires repeated,
counterbalanced runs.

## Jerboa lineage

MOOPS comes from [Jerboa](https://github.com/yasenhorozov/jerboa): an
agent-friendly mobile automation project built around external intelligence,
public observations, deterministic actions, and replayable traces.

MOOPS is not the full Jerboa iOS runner. The full specification includes a
daemon, SDK, scheduling, evidence, device support, and a much wider command
surface. That is the wrong scope for this focused benchmark.

MOOPS keeps one idea:

```text
external agent chooses → deterministic mobile tool acts → fresh state verifies
```

It applies that idea only to rebuild-and-resume verification for one iOS app.
The full local Jerboa specification remains excluded by `.gitignore`; it is
research input, not part of this minimal open-source implementation.

## Open-source setup

Requirements:

- macOS with Xcode, an iOS Simulator runtime, and `xcrun mcpbridge`;
- Node.js 20 or newer;
- four pre-provisioned simulator clones;
- [InjectionIII 5.2.1](https://github.com/johnno1962/InjectionIII/releases/tag/5.2.1RC5)
  for arm C; and
- Claude-Mem `13.15.3` plus a Claude subscription for arm D.

Clone and run the host checks:

```sh
git clone https://github.com/viktorinkov/Moops.git
cd Moops

node --test \
  benchmark/backend/test/*.test.mjs \
  tools/moops/test/*.test.mjs \
  benchmark/claude-mem/test/*.test.mjs \
  benchmark/injectioniii/test/*.test.mjs \
  benchmark/runner/test/*.test.mjs
```

Validate one executable checkpoint:

```sh
./tools/moops/moops checkpoint \
  benchmark/checkpoints/food-delivery-cart.json
```

Prepare the ignored local manifest:

```sh
cp benchmark/runner/benchmark.example.json \
  benchmark/runner/benchmark.local.json

benchmark/runner/moops-benchmark validate \
  benchmark/runner/benchmark.local.json
```

Replace the four simulator UDIDs and provision the clean worktrees described in
the runner guide. Then inspect the live plan without starting anything:

```sh
benchmark/runner/moops-benchmark demo \
  benchmark/runner/benchmark.local.json \
  --run-id rehearsal-001 \
  --dry-run
```

## Scope and attribution

This repository is a focused prototype for one benchmark app. It is not a
general state serializer, a replacement for XCUITest, an MCP server, a compiler
cache, or the complete Jerboa runner.

MOOPS is MIT licensed. The FoodDelivery fixture is a modified benchmark copy of
[spencer2k19/FoodDelivery](https://github.com/spencer2k19/FoodDelivery) at
commit `f4c8974029bfd019c126b3db1c2cddf3b6f78ae5`. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for attribution.
