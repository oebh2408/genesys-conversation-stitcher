# 0005 · Serverless: per-conversation store and optimistic concurrency

- Status: accepted
- Date: 2026-10-22
- Amends: [0004](0004-in-memory-state-with-snapshots.md)

## Context

[0004](0004-in-memory-state-with-snapshots.md) keeps all state in one process and persists it as a single snapshot. That breaks down on serverless platforms, where most event pipelines now run:

- Invocations are stateless, so every invocation would load and save the whole snapshot.
- The platform runs many invocations in parallel, and two of them saving the same snapshot overwrite each other's events.
- An invocation can be killed at any moment, including after a record was built but before it reached its destination.

## Decision

Add a second entry point, `StoredConversationStitcher`, that applies exactly the same rules as the in-memory one. The rules were extracted into pure functions over a JSON `ConversationState` (`applyEvent`, `decide`, `emitRecord`), so both entry points share them and cannot drift apart.

**One record per conversation.** State lives in a `ConversationStore`, keyed by conversation id. An invocation only touches the conversations present in its batch, and a batch is grouped so each conversation is loaded and saved once.

**Optimistic concurrency.** Every stored row has a version. `save` and `delete` succeed only if the version is still the one that was read. On conflict the stitcher reloads and reapplies the change. Applying an event is idempotent ([0003](0003-idempotency-and-revisions.md)), so a reapply is always safe. We chose this over locks because locks need a lease, a timeout and cleanup after crashes, and conflicts on one conversation are rare.

**A due index.** Each save also stores `dueAt`, the earliest time the conversation needs attention (settle deadline, idle timeout, delivery retry or end of retention). The scheduled `tick` asks the store only for rows with `dueAt <= now`.

**At-least-once delivery with a claim.** When a conversation is ready, `tick` first saves it as emitted with `deliveringSince = now`, then runs the listeners, then clears the claim. The claim is a conditional write, so two schedulers running in parallel never both deliver the same revision. If a listener throws, or the invocation dies before confirming, the claim expires after `ackTimeoutMs` and the same revision is delivered again.

The store contract is four methods, so it maps onto any database with a conditional write. We ship an in-memory store for tests and a PostgreSQL store as a tested example, not as a dependency.

## Consequences

- The serverless path costs one read and one conditional write per conversation per batch, plus the same on each delivery.
- Consumers must upsert by `conversationId` and keep the highest `revision`; the same revision may arrive more than once.
- A record can be delivered late by up to `ackTimeoutMs` after a failure, in exchange for never being lost.
- `tick` should run every few seconds. Running it more often, or in parallel, is safe.
- A conversation that receives a very large number of events in parallel will see more conflicts. `maxAttempts` bounds the retries, and grouping events by conversation in the queue removes the contention entirely.
