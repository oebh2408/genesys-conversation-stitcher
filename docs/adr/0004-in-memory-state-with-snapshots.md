# 0004 · In-memory state with snapshots, no built-in storage

- Status: accepted, amended by [0005](0005-serverless-store-and-optimistic-concurrency.md) for serverless deployments
- Date: 2026-10-22

## Context

Open conversations must be kept somewhere until they close. Options range from a plain in-process map to a database or key-value store per conversation.

Bundling a storage engine would force a choice of database, driver and runtime on every user, and add latency to every event for a problem (restarts) that happens rarely.

## Decision

State is held in memory. The library ships no storage adapters and has zero runtime dependencies.

For durability, `snapshot()` returns a JSON-safe copy of all state and `restore()` loads it. The host decides where to put it and how often: on shutdown, on an interval, or after each batch.

## Consequences

- The hot path is a map lookup; throughput is bounded by the host, not by I/O.
- Memory grows with the number of open conversations plus those retained for late events. Each holds its raw normalized events until it is forgotten; `size` and `pending` expose this for monitoring.
- A crash between snapshots loses the events received since the last one. Pairing snapshots with an at-least-once queue covers that: re-delivered events are de-duplicated by fingerprint ([0003](0003-idempotency-and-revisions.md)), so replaying a window of events is safe.
- Horizontal scaling requires routing all events of a conversation to the same instance, e.g. partitioning the queue by `conversationId`. This is documented rather than solved in the library.
