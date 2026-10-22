# Changelog

## 0.3.0

- Compaction of long conversations: older events are folded into a checkpoint, so state stays bounded (about 300 KB for a 100,000-event conversation). New options `compactAfterEvents`, `compactLagMs`, `maxTimelineEntries`; new `delivery.compactedEvents` and `delivery.timelineEntriesDropped`. See ADR 0006.
- Conversation snapshot topics (`v2.conversations.{id}`, user and queue conversation topics) are supported by the default adapter, `normalizeNotification`. See ADR 0007.
- `normalize` may return several events per notification.
- The fold is exposed as `createAccumulator`, `accumulate`, `fold` and `finish`.
- Simulator: `format: "snapshot"`.
- Animated terminal demo in the README, rendered from the real demo output (`npm run demo:svg`).

## 0.2.0

- `StoredConversationStitcher`: the same stitching rules with state kept per conversation in a `ConversationStore`, for serverless functions. Optimistic concurrency, a due index for the scheduler and at-least-once delivery with claims. See ADR 0005.
- `MemoryConversationStore` reference store, and a tested PostgreSQL store under `examples/`.
- `replayStored()` runs the simulator against the stored stitcher with parallel writers.
- The stitching rules now live in pure functions over a JSON `ConversationState`, shared by both stitchers.
- Snapshot format is now version 2.

## 0.1.0

- First release: in-memory `ConversationStitcher`, event simulator, CLI demo.
