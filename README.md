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

## Results

The result has two parts that should not be conflated:

1. MOOPS demonstrates an executable, fail-closed way to name, recall, rebuild,
   and reacquire real-app context.
2. The recorded four-arm take demonstrates the benchmark's synchronized staging
   and evidence machinery, but it does **not** provide comparative completion
   times or a winning arm.

### Demonstrated: checkpointed context is an executable contract

The repository contains three progressively deeper, fingerprinted checkpoints:

| Checkpoint | Durable context it expects | Fresh evidence it requires |
| --- | --- | --- |
| [`catalog-ready`](benchmark/checkpoints/food-delivery-catalog-ready.json) | Authenticated app at Home with the deterministic catalog available | `screen.home` and `home.catalogReady` exist |
| [`cart-ready`](benchmark/checkpoints/food-delivery-cart-ready.json) | The same session and catalog plus the persisted two-item cart | Home and catalog exist; `home.cart` reports exactly `2 items` |
| [`checkout-ready`](benchmark/checkpoints/food-delivery-cart.json) | The same installed app and cart, ready to resume checkout | Public UI replay opens Cart; `screen.cart`, `checkout.ready`, and `checkout.total` exist; `checkout.placeOrder` is enabled |

These files are not screenshots, serialized Swift objects, or claims that a
screen once existed. Each one pins a fixture revision, bundle ID, simulator
binding, build/install/launch argv, public UI trace, landing predicates, and a
SHA-256 fingerprint over the canonical descriptor. MOOPS rejects a changed
fingerprint, unsupported action, private selector, shell command, missing
predicate, wrong app, or failed phase before later work can run.

That is the main capability MOOPS demonstrated: runtime context can be exposed
to an agent as a small, reviewable resume contract while ownership remains in
the real systems. The installed app still owns the authenticated session and
Core Data cart. The deterministic HTTP process still owns catalog data and
prices. Navigation is reconstructed through public UI actions after launch.
The final accessibility tree is queried again; it is not copied from the
checkpoint. If any of those real preconditions is missing, restoration fails
instead of manufacturing substitute state.

The host-side implementation covers the whole control path:

```text
validate fingerprint and schema
→ build for the selected simulator
→ install the new binary without uninstalling app data
→ launch the real bundle
→ replay the shortest public route
→ obtain a fresh accessibility observation
→ evaluate every landing predicate
```

The XCUITest adapter reacquires elements after relaunch and runs replay plus
inspection in one test session. This matters because stale `XCUIElement`
handles and process-local navigation objects cannot be treated as saved state.
The result is a versioned JSON report with phase timings and a stable first
failure, suitable for the external Goal to use as its next observation.

### Demonstrated: context can be recalled by a fresh agent

MOOPS checkpoints are also usable across agent-process boundaries. The tracked
Claude-Mem registry names all three checkpoint files and fingerprints. The
recall proof requires a fresh helper process, a run-scoped local store, and the
ordered workflow `search → timeline → get_observations`. It rejects a stale
fingerprint, wrong order, reused process, mismatched store, missing observation,
or unverified worker shutdown. Only after that proof may the agent select the
deepest useful checkpoint and invoke MOOPS.

This separates three concerns that are often collapsed into “memory”:

- Claude-Mem recalls **which** validated context is useful.
- MOOPS validates **how** to rebuild and reacquire it.
- The running app, backend, and fresh UI observation prove **whether** it is
  still true.

The checkpoint therefore survives a fresh Codex process without pretending
that an LLM memory record contains simulator state.

### Capability comparison: what MOOPS did better

The demonstrated advantage is coverage of the recovery contract, not a measured
speed ratio:

| Benchmark treatment | Uses the real installed app as truth | Carries context across a structural rebuild | Provides a named, fingerprinted resume artifact | Revalidates the landing state after relaunch |
| --- | --- | --- | --- | --- |
| UI automation alone | Yes | It can rebuild, but the benchmark baseline must recreate and navigate the preconditions | No | Yes, after replaying the baseline journey |
| Xcode Preview | No; it constructs separate preview context | It can render after structural edits | No real-app resume artifact | No real session, store, navigation stack, or order receipt |
| InjectionIII | Yes, for a compatible edit in the current process | No for this task's new file and stored/domain-model shape changes; it must fall back to a build | No durable cross-process resume artifact | Not after the process-preserving path is lost |
| MOOPS + Claude-Mem | Yes | Yes: replace the binary while retaining durable app data, then reconstruct navigation | Yes | Yes, with fresh public accessibility predicates |

In that specific sense, MOOPS outperformed the other treatments: it is the only
implemented arm that combines external recall, tamper-evident checkpoint
identity, structural-rebuild compatibility, real installed state, public route
replay, and fresh landing verification. This is an architectural capability
result. It does not show that MOOPS completed the feature faster than UI tests,
Previews, or InjectionIII.

### Verified host evidence

The current host suite contains **118 passing contract tests**, rerun for this
submission:

- 25 MOOPS tests cover schema and fingerprint validation, literal argv
  execution, bounded inputs, fixed phase order, XCUITest response parsing,
  fresh inspection, and fail-closed restoration;
- 10 backend tests cover the immutable catalog fixture, authentication
  envelopes, deterministic assets, validated orders, inspectable receipts, and
  reset behavior;
- 24 Claude-Mem tests cover registry identity, all three executable checkpoint
  fingerprints, fresh recall, store isolation, ordered MCP use, and worker
  lifecycle;
- 13 InjectionIII tests cover the pinned 5.2.1 treatment, watcher identity,
  runtime connection, injection-attempt evidence, and honest structural
  fallback; and
- 46 runner tests cover four-arm isolation, common controls, durable Goal
  staging, Xcode MCP binding, the synchronized barrier, acceptance environment,
  recording, transcript publication, cleanup, and failure propagation.

These tests demonstrate the contracts and failure boundaries. They are not a
substitute for a completed timed simulator run.

### What the recorded four-arm take actually shows

The [take-4 staging recording](results/live-demo/moops-four-arm-staging-take4.mp4) is a
123.12-second, 1920×1080 H.264 composite of the four labeled simulator feeds.
The [sanitized evidence bundle](results/runs/final-20260823-4/) contains the
[summary](results/runs/final-20260823-4/summary.json),
[70-event monotonic/wall-clock ledger](results/runs/final-20260823-4/events.jsonl),
four request transcripts, four app-server transcripts, stderr, and per-arm
results. Its [bundle manifest](results/runs/final-20260823-4/bundle.json) records
189 redactions and hashes both source and published evidence.

The ledger establishes that the following live setup completed:

- the common baseline, prompt hash, model request, and fixture were checked;
- four isolated Codex homes and four distinct Xcode MCP bindings were
  provisioned;
- four independent deterministic backends became ready;
- InjectionIII and Claude-Mem preflight gates passed;
- all four Codex app servers initialized and exposed their required treatment
  capabilities;
- four durable threads were created with the identical Goal;
- every Goal was persisted in `paused` state with zero token and time usage;
- every arm's settings were verified; and
- all four arms reached `staging.ready`, allowing the shared barrier to become
  ready.

The take then failed during the visible countdown. The ledger contains the
`3` event followed by `E_COMMAND_TIMEOUT`; it contains no `2`, no `1`, and no
`run.barrier.released`. Because activation never happened, every arm correctly
records:

- `activatedEpochMs: null`;
- zero Goal turns;
- zero Xcode MCP/tool calls during a turn;
- zero code changes, builds, or agent verification iterations;
- `not_run` for shared acceptance; and
- no time-to-green or state-restoration timing.

The runner stopped the arms and backends and retained the failed evidence. The
recording and ledger together document the visual layout, isolated live setup,
durable paused Goals, and fail-closed orchestration. They are **not** evidence
that any arm implemented the delivery-preference feature or reached the green
verification screen.

### Not yet measured

This submission does not yet contain a successful four-arm comparison, so it
does not support claims about:

- which arm finishes first;
- relative time to first real-app feedback;
- MOOPS restore time versus full UI journey recreation;
- the number of edit/build/verification loops saved;
- end-to-end time to the green acceptance screen; or
- completion of the benchmark feature within the three-hour limit.

A timing claim requires a new take in which the barrier releases, all four Goals
run from the same timestamp, each arm reaches the same XCUITest/backend receipt
gate, and the measured phase data is preserved. Repeated, counterbalanced takes
would then be needed for a comparative performance conclusion.

The defensible conclusion today is narrower: MOOPS implements and verifies the
missing checkpoint/context-restoration capability for a real stateful iOS app,
and the benchmark harness can stage that capability alongside the three
baselines with auditable isolation and failure evidence. Comparative speed
remains unmeasured.

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

The host-side suite tests checkpoint validation, recall, phase order, and
evidence handling. It does not prove faster verification or better model
weights. The live simulator proof is still pending.

## Attribution

MOOPS is MIT licensed. The FoodDelivery fixture is a modified benchmark copy of
[spencer2k19/FoodDelivery](https://github.com/spencer2k19/FoodDelivery) at
commit `f4c8974029bfd019c126b3db1c2cddf3b6f78ae5`. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for attribution.
