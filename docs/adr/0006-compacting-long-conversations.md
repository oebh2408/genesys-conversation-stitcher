# 0006 · Compacting long conversations

- Status: accepted
- Date: 2026-10-22

## Context

Until now a conversation's state held every event it had received, because the record is rebuilt by folding all events in event-time order ([0002](0002-closing-a-conversation.md), [0003](0003-idempotency-and-revisions.md)). For a phone call that is a few dozen events. A messaging conversation can stay open for days and collect thousands.

That growth hurts twice. In memory it is unbounded. In serverless mode ([0005](0005-serverless-store-and-optimistic-concurrency.md)) the whole state is read and written on every batch, so cost grows with the conversation's age.

The fold is order-dependent only for a few fields (first value wins for direction and participant details, last value wins for attributes). Everything else is a min, a max or a set union.

## Decision

Split the state into a **checkpoint** and a **window of raw events**.

- The fold is an explicit, JSON-serializable accumulator (`createAccumulator`, `accumulate`, `finish`). Folding the checkpoint and then the raw events gives the same result as folding everything, as long as no raw event is older than the checkpoint.
- When a conversation holds more than `compactAfterEvents` raw events (default 500), events older than `compactLagMs` (default 15 min) behind the newest event are folded into the checkpoint and dropped. Compaction runs in batches of a tenth of the threshold, not on every event.
- The fingerprints of compacted events are kept so their duplicates are still dropped. Fingerprints far behind the horizon (four lag windows) are forgotten.
- Session open/closed flags are tracked incrementally, so deciding whether a conversation has ended no longer scans every event.
- The record's timeline keeps its first entry and the most recent ones, up to `maxTimelineEntries` (default 1000); `delivery.timelineEntriesDropped` says how many were left out.

## Consequences

- State size is bounded by the threshold, the lag window and the timeline cap, not by the conversation's length. In the test suite a 100,000-event conversation stays around 300 KB and is processed in about 1.3 s.
- An event that arrives more than `compactLagMs` behind the newest one is applied on top of the checkpoint instead of in its exact place. For most fields that changes nothing; for attributes, an old value could overwrite a newer one. `compactLagMs` should be comfortably larger than the worst reordering you see.
- A duplicate of an event older than four lag windows is applied again. Applying an event twice is harmless for every field except the timeline, which gets one extra entry.
- Short conversations never reach the threshold and behave exactly as before. Tests check that compacted and uncompacted runs produce identical records.
