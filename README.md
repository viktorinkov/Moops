# MOOPS

MOOPS is a three-hour iOS experiment: can an external Codex Goal finish a
rebuild-required feature faster when it can checkpoint a verified app state and
return to it after each build?

MOOPS does not embed an LLM, snapshot process memory, or compile Swift faster.
It coordinates normal Xcode builds, public UI automation, persisted application
state, and a small verified restore trace.

## Demo claim

> InjectionIII preserves runtime state when a change can be injected. MOOPS
> restores a useful verification state when a real rebuild is unavoidable.

The same feature is run from the same fixture in four isolated worktrees:

1. Codex + UI automation
2. Codex + UI automation + SwiftUI Previews
3. Codex + UI automation + InjectionIII
4. Codex Goal + UI automation + MOOPS checkpoint/restore

The task adds a persisted delivery preference to checkout. It intentionally
adds a source type and stored state, changes persistence/wiring, and extends the
real order payload—changes InjectionIII documents as requiring a rebuild.

See [the reduced specification](MOOPS_FAST_VERIFICATION_SPEC.md),
[the fixed feature prompt](benchmark/FEATURE_PROMPT.md), and
[the execution plan](tasks/plan.md).

## Repository layout

- `benchmark/FoodDelivery`: normalized SwiftUI benchmark application, derived
  from [spencer2k19/FoodDelivery](https://github.com/spencer2k19/FoodDelivery)
- `benchmark/backend`: deterministic local HTTP catalog/order backend
- `tools/moops`: checkpoint, restore, and timing host
- `benchmark/acceptance`: the shared real-app acceptance path
- `results`: ignored local run output; published summaries may be added later

The full Jerboa specification is deliberately excluded by `.gitignore`. It is
research input, not part of this minimal public implementation.

## Quick start

Prerequisites are Xcode with an iOS Simulator and Node.js 20 or newer.

```sh
node benchmark/backend/server.mjs
node --test benchmark/backend/test/*.test.mjs tools/moops/test/*.test.mjs
./tools/moops/moops doctor
```

The benchmark commands are documented as they become executable; the runtime
acceptance test remains identical across all four arms.

## Scope boundary

This hackathon build supports one app, one simulator, one checkpoint, and the
actions needed for the checkout demo. It is not the full Jerboa runner, a test
DSL, an MCP server, or a general state serializer.

## License and attribution

MOOPS is MIT licensed. The copied FoodDelivery fixture retains its upstream
copyright and is used under the MIT license stated by its upstream README.

