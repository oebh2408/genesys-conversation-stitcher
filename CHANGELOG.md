# Changelog

## 0.2.0

- `StoredConversationStitcher`: the same stitching rules with state kept per conversation in a `ConversationStore`, for serverless functions. Optimistic concurrency, a due index for the scheduler and at-least-once delivery with claims. See ADR 0005.
- `MemoryConversationStore` reference store, and a tested PostgreSQL store under `examples/`.
- `replayStored()` runs the simulator against the stored stitcher with parallel writers.
- The stitching rules now live in pure functions over a JSON `ConversationState`, shared by both stitchers.
- Snapshot format is now version 2.

## 0.1.0

- First release: in-memory `ConversationStitcher`, event simulator, CLI demo.
