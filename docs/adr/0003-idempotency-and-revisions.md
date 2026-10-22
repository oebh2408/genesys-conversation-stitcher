# 0003 · Idempotency by content fingerprint, late events as revisions

- Status: accepted
- Date: 2026-10-22

## Context

Event streams in this space are at-least-once. The same event can arrive twice from the source, and again when a consumer crashes and the queue re-delivers. There is no event id that is guaranteed to be present and stable across every transport.

Separately, some events will arrive after the conversation has already been emitted, no matter how long the settle window is.

## Decision

**Duplicates.** Each event gets a key: a hash of its topic plus its body serialized with sorted keys. Two deliveries with the same content collapse to one; property order and transport metadata do not matter. Applying an event is therefore idempotent, and re-processing a batch is always safe.

**Late events.** An event for a conversation that was already emitted is handled by the `lateEvents` policy:

- `"revise"` (default): apply it, restart the settle window, and emit the record again with `revision + 1`.
- `"drop"`: count it in `delivery.lateEvents` and ignore it.

Emitted conversations are remembered for `retainEmittedMs` (default 1 h) so that late events and late duplicates can still be recognized.

## Consequences

- Consumers must upsert by `conversationId` and keep the highest `revision`. That is a small requirement and makes the whole pipeline converge to the correct state.
- Two genuinely different events with byte-identical bodies would be merged. In practice detail events carry an event time and participant or session ids, so this does not happen; if your source can produce such events, supply a `normalize` function that sets a different `key`.
- The hash is non-cryptographic (53 bits). It is a de-duplication key, not a security boundary.
- After `retainEmittedMs`, a very late event starts a new, partial conversation. The record's `delivery` and `closeReason` make that visible.
