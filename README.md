<img src="docs/diagram.jpg" alt="Conversation Stitcher: a noisy event stream goes in, one clean record per conversation comes out" width="100%">

# genesys-conversation-stitcher

Genesys Cloud tells you about a conversation one small event at a time: the customer connected, the call entered a queue, an agent answered, someone hung up, the agent picked a wrap-up code. Those events arrive **partial, duplicated, out of order and sometimes late**. Anything downstream (a CRM sync, a data warehouse, an analytics or AI pipeline) usually wants the opposite: **one complete, correct record per conversation, once it is over**.

This library is the piece in between. It is small, has zero runtime dependencies, and comes with a simulator so you can see it work without a Genesys account.

```
$ npx genesys-conversation-stitcher

  in   288 events for 25 conversations
       37 duplicates, 20 out of order, 2 after emission

  out  25 clean records (2 revisions)
       ✓ every record matches what actually happened
```

## Why this is harder than it looks

| What the stream does | What goes wrong if you take it at face value | What the stitcher does |
| --- | --- | --- |
| Delivers the same event twice | Double-counted transfers, two wrap-ups | Fingerprints each event by content and drops repeats |
| Delivers events out of order | An agent "answers" before the customer calls | Rebuilds the conversation by event time, not arrival time |
| Sends the customer hang-up before the agent's wrap-up | Record is written without the wrap-up code | Waits until every session has ended, then a quiet settle window |
| Sends an event after the record was written | Silent data loss | Emits a new revision of the record (or drops it, your choice) |
| Never sends the end at all | Conversation stays in memory forever | Idle timeout emits what is known, flagged as `timeout` |

## Install

```bash
npm install genesys-conversation-stitcher
```

Node 18 or later. ESM only.

## Usage

```ts
import { ConversationStitcher } from "genesys-conversation-stitcher";

const stitcher = new ConversationStitcher({
  settleMs: 30_000,        // quiet time after the last session ends
  idleTimeoutMs: 4 * 3600_000,
  lateEvents: "revise",    // or "drop"
});

stitcher.onRecord((record) => {
  // One call per conversation (plus one per revision, if late events arrive).
  saveToWarehouse(record);
});

// Feed it notifications from wherever they reach you:
// an event bridge, a queue, the notifications websocket...
for await (const message of yourQueue) {
  stitcher.ingest(JSON.parse(message.body));
}

// Something has to move time forward. Either let the stitcher do it...
const stop = stitcher.start(1_000);
// ...or call stitcher.tick() yourself after each batch.
```

The stitcher never reads the clock on its own: `ingest(event, now)` and `tick(now)` both take the time as an argument (defaulting to `Date.now()`). That is what makes it deterministic to test and replay. See [ADR 0001](docs/adr/0001-deterministic-core.md).

### What you get

```jsonc
{
  "conversationId": "conv-00490b88",
  "revision": 1,
  "closeReason": "ended",            // "ended" | "timeout" | "flushed"
  "startTime": 1767258325509,
  "endTime": 1767258655883,
  "durationMs": 330374,
  "mediaTypes": ["voice"],
  "direction": "inbound",
  "participants": [ /* customer, ivr, acd, agents, each with their sessions */ ],
  "agents": ["agent-carla", "agent-felipe"],
  "queues": [
    { "queueId": "support", "enteredAt": 1767258348267, "leftAt": 1767258431827, "waitMs": 83560 },
    { "queueId": "billing", "enteredAt": 1767258540138, "leftAt": 1767258613673, "waitMs": 73535 }
  ],
  "wrapUps": [
    { "userId": "agent-felipe", "code": "escalated", "notes": "...", "time": 1767258547323 },
    { "userId": "agent-carla", "code": "sale", "notes": "...", "time": 1767258663404 }
  ],
  "attributes": { "survey": "no", "channel": "voice" },
  "timeline": [ /* every applied event, in event-time order */ ],
  "delivery": {
    "eventsReceived": 24,
    "eventsApplied": 17,
    "duplicatesDropped": 7,
    "outOfOrderEvents": 1,
    "lateEvents": 0,
    "openSessions": 0
  }
}
```

`delivery` tells you how messy the stream was for this conversation, which is useful for monitoring the pipeline itself.

## How it decides a conversation is over

1. Every start event (`customer.start`, `flow.start`, `acd.start`, `user.start`) opens a session; the matching end closes it.
2. When every session seen so far has ended, a **settle window** starts (`settleMs`, 30 s by default).
3. Any new event for that conversation restarts the window. After-call work and wrap-up codes typically land here.
4. When the window passes quietly, the record is emitted.

A customer hanging up is not the end: the agent may still be in after-call work. Details and trade-offs in [ADR 0002](docs/adr/0002-closing-a-conversation.md).

## Try it without Genesys

The simulator generates realistic conversations (answered, transferred, abandoned in queue, messaging), then damages the stream on purpose: duplicates, reordering, latency and stragglers. It also returns the ground truth, so you can check the output.

```ts
import { ConversationStitcher, simulate, replay } from "genesys-conversation-stitcher";

const { deliveries, truth } = simulate({
  conversations: 50,
  seed: 7,             // same seed, same stream
  duplicateRate: 0.3,
  reorderRate: 0.3,
  straggleRate: 0.05,  // events that arrive after the record was emitted
});

const records = replay(new ConversationStitcher(), deliveries);
```

From the command line:

```bash
npx genesys-conversation-stitcher --conversations 100 --seed 3 --straggle 0.05
npx genesys-conversation-stitcher --json > records.json
```

## Surviving restarts

State lives in memory. To survive a deploy or a crash, persist a snapshot and restore it on boot:

```ts
await store.put("stitcher", JSON.stringify(stitcher.snapshot()));
// later
stitcher.restore(JSON.parse(await store.get("stitcher")));
```

Combined with re-delivery from your queue, duplicates are dropped by fingerprint, so replaying a few minutes of events is safe. See [ADR 0004](docs/adr/0004-in-memory-state-with-snapshots.md).

## Input format

The built-in adapter reads conversation detail event topics, `v2.detail.events.conversation.{id}.{kind}`, and these fields from `eventBody` when present: `eventTime` (epoch ms or ISO 8601), `conversationId`, `participantId`, `sessionId`, `participantPurpose`, `mediaType`, `direction`, `queueId`, `userId`, `ani`, `dnis`, `disconnectType`, `wrapupCode`, `wrapupNotes`, `attributes`.

Event payloads differ between organizations and topic versions, so treat the adapter as a starting point. Pass your own with the `normalize` option to map any other shape:

```ts
import { ConversationStitcher, normalizeDetailEvent } from "genesys-conversation-stitcher";

new ConversationStitcher({
  normalize: (n) => ({ ...normalizeDetailEvent(n)!, queueId: n.eventBody.routingQueueId as string }),
});
```

## API

| Member | Description |
| --- | --- |
| `new ConversationStitcher(options?)` | `settleMs`, `idleTimeoutMs`, `lateEvents`, `retainEmittedMs`, `normalize` |
| `ingest(notification, now?)` | Returns `{ status }`: `applied`, `duplicate`, `late`, `late-dropped` or `ignored` |
| `ingestAll(notifications, now?)` | Same, for a batch |
| `tick(now?)` | Emits ready conversations and returns them; forgets expired ones |
| `flush(now?)` | Emits everything pending, e.g. on shutdown |
| `start(intervalMs?)` | Calls `tick()` on a timer; returns a stop function |
| `onRecord(listener)` | Subscribe to emitted records; returns an unsubscribe function |
| `snapshot()` / `restore(snapshot)` | JSON-safe state for persistence |
| `size` / `pending` | Conversations in memory / waiting to be emitted |
| `consolidate(events)` | The pure folding function, if you want to bring your own buffering |
| `simulate(options?)` / `replay(stitcher, deliveries)` | Simulator and simulated-clock runner |

## Design decisions

- [0001 · A deterministic core driven by an explicit clock](docs/adr/0001-deterministic-core.md)
- [0002 · Closing a conversation: all sessions ended, then a settle window](docs/adr/0002-closing-a-conversation.md)
- [0003 · Idempotency by content fingerprint, late events as revisions](docs/adr/0003-idempotency-and-revisions.md)
- [0004 · In-memory state with snapshots, no built-in storage](docs/adr/0004-in-memory-state-with-snapshots.md)

## Development

```bash
npm install
npm test        # unit tests + property tests against the simulator's ground truth
npm run demo
```

## License

MIT © [Oscar Benavides](https://ob0.dev)

Not affiliated with or endorsed by Genesys. Genesys Cloud is a trademark of its owner.
