# Three-hour execution plan

## Outcome

Produce one runnable, honest four-arm benchmark in which MOOPS restores a real
checkout verification state after a structural Swift rebuild.

## Milestone 1 — reproducible fixture

Acceptance:

- Public repository ignores the full local Jerboa specification.
- Local backend starts without external services and returns fixed catalog data.
- App builds for one named iOS Simulator against that backend.
- Normalized start removes the pre-existing generic comments shortcut.

## Milestone 2 — checkpoint loop

Acceptance:

- Checkpoint schema records fixture fingerprint, public restore steps, and
  observable landing predicates.
- Invalid or stale checkpoints fail closed.
- `build-and-restore` measures build, launch, restore, and verification phases.
- Every post-relaunch lookup reacquires the live accessibility hierarchy.

## Milestone 3 — common acceptance path

Acceptance:

- One UI path establishes session/cart/checkout state using the real app.
- It changes `checkout.deliveryPreference`, terminates/relaunches, returns to
  checkout, and observes the persisted choice.
- It places the order and independently queries the backend receipt.

## Milestone 4 — four-arm protocol

Acceptance:

- Same start commit, feature prompt, Codex configuration, simulator, fixture,
  and final acceptance test for all arms.
- Preview and InjectionIII are enabled only in their named arms.
- Injection attempts and rebuild fallbacks are recorded, not inferred.
- Results separate total task time from edit-to-verified-observation time.

## Definition of done

- Unit/contract tests pass.
- Simulator build succeeds.
- Real runtime path is exercised, or any environmental blocker is reported with
  the exact successful lower-level evidence.
- README and benchmark protocol match the executable behavior.

