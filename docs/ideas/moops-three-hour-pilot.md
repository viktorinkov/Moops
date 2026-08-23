# MOOPS three-hour pilot

## The question

Can a coding agent complete the same structural iOS feature faster when every
normal rebuild returns it to a previously verified, stateful checkout screen?

## What survives refinement

- Codex is orchestrated externally with a durable Goal; MOOPS embeds no model.
- The fixture uses only state the app already owns: authenticated session,
  persistent cart, backend catalog/prices, and navigation.
- The local HTTP backend is deterministic and serves the same fixture to every
  arm.
- A checkpoint is a versioned UI restore recipe plus landing predicates. It is
  not an `XCUIElement`, SwiftUI, heap, or process snapshot.
- All arms pass the same end-to-end runtime acceptance test.

## The deliberately nasty feature

Add a saved delivery preference to checkout:

- introduce a new `DeliveryPreference` source/domain type;
- add stored view-model state;
- extend the existing order domain model;
- persist the selection across a real relaunch;
- wire an accessible checkout control;
- send `delivery_preference` to the real local order endpoint.

This is small enough to finish but spans the specific InjectionIII boundary:
new files and changed stored-property layouts require rebuilding. Previews can
help design the control, but a faithful preview must recreate the session, cart,
backend, navigation, and persistence context.

## Rejected variants

- **Cosmetic checkout change:** too favorable to both Previews and injection.
- **Free-form delivery instructions:** the supplied app already has a generic
  comments field and payload, weakening the comparison.
- **Modifiers and delivery addresses:** credible product features, but absent
  from the fixture and too expensive for this experiment.
- **Full Jerboa port:** too much protocol, replay, evidence, and runner surface
  for one three-hour claim.

## Honest result language

MOOPS is expected to reduce repeated state reconstruction after unavoidable
rebuilds. It does not accelerate model training, reinforcement learning, or
Swift compilation. The Codex Goal supplies the independent iteration loop;
checkpoints make that loop cheaper and more deterministic.
