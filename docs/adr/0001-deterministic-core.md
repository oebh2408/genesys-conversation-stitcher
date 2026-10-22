# 0001 · A deterministic core driven by an explicit clock

- Status: accepted
- Date: 2026-10-22

## Context

Almost every rule in this library is about time: how long to wait after a conversation ends, when to give up on one that never ends, how long to remember an emitted conversation. The obvious implementation uses `setTimeout` per conversation and reads `Date.now()` wherever it needs to.

That makes the interesting cases (a wrap-up arriving 29 seconds after hang-up, a straggler 2 minutes after emission, a restart halfway through a stream) hard to test, slow to test, or flaky. It also ties the library to one kind of runtime: a long-lived process with timers. Serverless functions and batch replays of a day of events don't fit that model.

## Decision

The core never reads the clock and owns no timers.

- `ingest(event, now)` and `tick(now)` receive the current time as an argument. It defaults to `Date.now()` for convenience.
- Nothing is emitted from `ingest`. Records are only produced by `tick` (or `flush`).
- `start(intervalMs)` is a thin optional wrapper that calls `tick()` on a real timer.

## Consequences

- Tests run a full day of simulated traffic in milliseconds, with exact control over every boundary (`settleMs - 1` vs `settleMs`).
- The simulator's `replay()` drives the same code path production uses, on a simulated clock.
- Replaying historical events is just a loop: pass each event's original delivery time as `now`.
- Hosts must remember to call `tick()`. Forgetting it means nothing is emitted, which is loud and easy to notice, rather than subtly wrong.
