# 0007 · Snapshot topics as events

- Status: accepted
- Date: 2026-10-22

## Context

Genesys Cloud offers two ways to follow conversations. Detail event topics send one small event per change. Conversation topics (per conversation, per user or per queue) send a **snapshot of the whole conversation** on every change: all participants, their media sessions with connected and disconnected times, wrap-up and attributes.

Many integrations already subscribe to the snapshot topics. They have their own version of the same problems: the same conversation arrives many times, snapshots can arrive out of order, and a later snapshot can be missing a participant that an earlier one had.

Two designs were possible: a second consolidation path that merges snapshots, or translating snapshots into the event model the library already handles.

## Decision

Translate. `normalizeConversationSnapshot` turns each snapshot into the events it implies: a start and possibly an end per media session, a wrap-up per participant that has one, and an attributes event. `normalize` may now return several events for one notification.

The fingerprint of each derived event is computed from what it describes (conversation, participant, session, kind, time and payload), not from the snapshot it came from, and not from the topic. So:

- the same session seen in ten snapshots collapses to one start and one end;
- the same conversation seen through a user topic and a queue topic is still one conversation;
- an older snapshot arriving late adds nothing new.

`normalizeNotification`, the new default, routes each topic family to its adapter.

## Consequences

- One code path for both families: every guarantee (ordering, settle window, revisions, compaction, serverless) applies to snapshots unchanged.
- The simulator can emit snapshots (`format: "snapshot"`), and the same ground-truth tests run against them.
- Snapshot payloads carry no explicit event time for wrap-ups and attributes; the adapter uses the wrap-up's `endTimestamp`, the participant's end, or its last disconnect. The record is correct, but those timeline entries are approximate.
- If a later snapshot reports a different value for a session (for example a disconnect type that changed), it yields a new event rather than a duplicate. The fold keeps the earliest value, which matches what the detail topics would have said.
- Mixing detail and snapshot topics for the same conversation is not supported: the two can report the same moment a few milliseconds apart, which would look like two different events.
