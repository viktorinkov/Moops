# Claude-Mem in arm D

Arm D is **Codex + UI automation + MOOPS + Claude-Mem**. This is a combined
treatment: the four-arm experiment cannot attribute an improvement to MOOPS or
Claude-Mem individually without adding another ablation arm.

Claude-Mem is an external, searchable history. It may help a fresh Codex
session find a useful checkpoint, but it never restores the simulator and its
database is not executable truth. The fingerprinted MOOPS file must still pass
`moops checkpoint`, and the running app must still pass `moops
build-and-restore`.

## Pinned dependency

- Package: `claude-mem@13.15.3`
- Official source: <https://github.com/thedotmack/claude-mem>
- Source commit: `e2d1df569a8f04075d40e92461128ece7cf04c82`

That source includes the
[Codex installer](https://github.com/thedotmack/claude-mem/blob/e2d1df569a8f04075d40e92461128ece7cf04c82/src/services/integrations/CodexCliInstaller.ts),
[Codex plugin manifest](https://github.com/thedotmack/claude-mem/blob/e2d1df569a8f04075d40e92461128ece7cf04c82/plugin/.codex-plugin/plugin.json),
[native hooks](https://github.com/thedotmack/claude-mem/blob/e2d1df569a8f04075d40e92461128ece7cf04c82/plugin/hooks/codex-hooks.json),
and the
[`mem-search` workflow](https://github.com/thedotmack/claude-mem/blob/e2d1df569a8f04075d40e92461128ece7cf04c82/plugin/skills/mem-search/SKILL.md).
On a clean benchmark machine, install the pin before the timed run:

```sh
DO_NOT_TRACK=1 npx claude-mem@13.15.3 install \
  --ide codex-cli --runtime worker --provider claude --no-auto-start
```

The install is machine setup, like installing Xcode or InjectionIII. The
arm-D memory directory must be empty when the timed task starts.

## Local benchmark profile

Always start arm D through:

```sh
export MOOPS_CLAUDE_MEM_RUN_ID=arm-d-run-001
benchmark/claude-mem/run-arm-d --doctor-fresh
benchmark/claude-mem/run-arm-d <the same Codex flags used by every arm>
```

The run ID selects `results/claude-mem/<run-id>`; capture and recall must use
the same value. `--doctor-fresh` refuses an existing directory, preventing
memory leakage from development or an earlier benchmark, and also refuses an
existing listener on the pinned worker port. It atomically creates a private
store and run-identity marker. The launcher pins loopback worker port 37977,
worker runtime, observer model `claude-haiku-4-5-20251001`, the Claude
subscription provider, local SQLite search, native Codex
hooks only (global transcript ingestion is disabled), `DO_NOT_TRACK=1`, and
explicit telemetry/error-telemetry/cloud-sync kill switches. Its doctor also
fails unless the enabled Codex plugin reports version 13.15.3.
`results/claude-mem` is ignored by Git. No cloud-sync credentials are allowed
in this arm. Claude-Mem's observer model still receives the session content
needed to produce summaries; “local” describes memory storage and search, not
an offline LLM claim. When Codex exits, the launcher verifies the live worker's
version and exact store/settings identity, requests graceful shutdown, and
fails the run unless it observes the worker stop.

The plugin hooks are loaded when Codex starts. Installing or enabling the
plugin does not retrofit hooks into an already-running process, so every
capture and recall run below starts with `run-arm-d`.

## Three checkpoint memories

`benchmark/claude-mem/checkpoints.json` names:

| Name | Memory role | Executable restore |
| --- | --- | --- |
| `catalog-ready` | Authenticated Home; deterministic catalog loaded | `benchmark/checkpoints/food-delivery-catalog-ready.json` |
| `cart-ready` | Exactly two real persisted cart items visible on Home | `benchmark/checkpoints/food-delivery-cart-ready.json` |
| `checkout-ready` | Rebuild and public Home-to-Cart restore | `benchmark/checkpoints/food-delivery-cart.json` |

All three are fingerprinted schema-v1 MOOPS checkpoints using only public
accessibility IDs. They are progressively deeper, and none fabricates app
state: `catalog-ready` requires an existing authenticated session,
`cart-ready` additionally requires the fixed baseline's public `home.cart`
value to equal `2 items`, while `checkout-ready` additionally replays the
public Home-to-Cart tap. A clean or
empty simulator must fail the corresponding precondition rather than being
silently seeded.

Validate the registry and its three referenced fingerprints with:

```sh
node benchmark/claude-mem/registry.mjs
```

## Capture and recall proof

In capture session 1, run each command separately so Claude-Mem sees three
distinct checkpoint packets:

```sh
node benchmark/claude-mem/registry.mjs --packet catalog-ready
node benchmark/claude-mem/registry.mjs --packet cart-ready
node benchmark/claude-mem/registry.mjs --packet checkout-ready
tools/moops/moops checkpoint benchmark/checkpoints/food-delivery-catalog-ready.json
tools/moops/moops checkpoint benchmark/checkpoints/food-delivery-cart-ready.json
tools/moops/moops checkpoint benchmark/checkpoints/food-delivery-cart.json
```

End the Codex session normally so Claude-Mem's Stop hook can summarize it.
Start a **fresh** Codex process with `run-arm-d`, then ask it to use the
Claude-Mem `search → timeline → get_observations` workflow to retrieve all
three `MOOPS_MEMORY_CHECKPOINT` names and select the deepest state required for
the current verification. For the feature acceptance path, that is
`checkout-ready`. Finally run:

```sh
tools/moops/moops checkpoint benchmark/checkpoints/food-delivery-cart.json
tools/moops/moops build-and-restore \
  benchmark/checkpoints/food-delivery-cart.json \
  --output results/arm-d-build-and-restore.json
```

The recall demonstration passes only if the fresh session retrieves all three
names with their distinct paths and fingerprints, chooses `checkout-ready` for
the feature acceptance path, and MOOPS verifies the live checkout landing.
Record the memory search IDs, session restart time, and MOOPS report in the raw
arm-D result. Memory indexing, recall, and restart time all count toward the
benchmark.

## Tests

```sh
node --test benchmark/claude-mem/test/*.test.mjs
```
