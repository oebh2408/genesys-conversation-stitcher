# 0002 · Closing a conversation: all sessions ended, then a settle window

- Status: accepted
- Date: 2026-10-22

## Context

There is no single "conversation finished" event that can be trusted:

- The customer hanging up is not the end. The agent is usually still in after-call work and the wrap-up code arrives seconds or minutes later.
- On a transfer, the first agent's end arrives while the conversation is very much alive.
- Any end event can itself arrive out of order, before events that happened earlier.

Emitting on the first "end-looking" event produces records without wrap-ups, and emitting too late keeps conversations in memory and delays everything downstream.

## Decision

A conversation is considered closed when **every session seen so far has reported its end**, where a session is opened by `customer.start`, `flow.start`, `acd.start` or `user.start` and closed by the matching `.end`.

Closed is not emitted immediately. It starts a **settle window** (`settleMs`, default 30 s). Any new event for the conversation restarts the window, and also re-evaluates whether it is still closed (a late `user.start` reopens it). The record is emitted when the window passes with nothing new.

Two safety nets cover what the rule cannot:

- `idleTimeoutMs` (default 4 h): if nothing has been heard for that long, emit what is known with `closeReason: "timeout"` and the count of `openSessions`.
- Events after emission are handled by revisions, see [0003](0003-idempotency-and-revisions.md).

## Consequences

- Records are emitted about `settleMs` after the last real activity. That latency is the price for completeness and is configurable.
- A conversation that trickles events slowly keeps postponing itself. That is intended: it is still active.
- An end event that arrives before its start still closes the session, so out-of-order delivery does not leave phantom open sessions.
- Choosing `settleMs` is a trade-off per deployment. The `delivery.lateEvents` counter on each record shows whether it is too short.
