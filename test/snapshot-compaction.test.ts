import { describe, expect, it } from "vitest";
import {
  ConversationStitcher,
  MemoryConversationStore,
  StoredConversationStitcher,
  normalizeConversationSnapshot,
  normalizeDetailEvent,
  replay,
  replayStored,
  simulate,
  type ConsolidatedConversation,
  type RawNotification,
} from "../src/index.js";

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const latest = (records: ConsolidatedConversation[]) => new Map(records.map((r) => [r.conversationId, r]));

describe("conversation snapshot topics", () => {
  it("reconstructs every conversation from noisy snapshots", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { deliveries, truth } = simulate({ seed, conversations: 12, format: "snapshot", duplicateRate: 0.3, reorderRate: 0.4 });
      const out = latest(replay(new ConversationStitcher(), deliveries));
      expect(out.size).toBe(truth.length);
      for (const t of truth) {
        const r = out.get(t.conversationId)!;
        expect(r.startTime).toBe(t.startTime);
        expect(r.endTime).toBe(t.endTime);
        expect(r.agents).toEqual(t.agents);
        expect(r.queues.map((q) => q.queueId)).toEqual(t.queues);
        expect(r.wrapUps.map((w) => w.code)).toEqual(t.wrapUpCodes);
        expect(r.delivery.openSessions).toBe(0);
      }
    }
  });

  it("works the same through the stored stitcher", async () => {
    const { deliveries, truth } = simulate({ seed: 4, conversations: 10, format: "snapshot" });
    const out = latest(await replayStored(new StoredConversationStitcher(new MemoryConversationStore()), deliveries));
    for (const t of truth) expect(out.get(t.conversationId)!.wrapUps.map((w) => w.code)).toEqual(t.wrapUpCodes);
  });

  it("turns repeated snapshots into the same events", () => {
    const snapshot: RawNotification = {
      topicName: "v2.conversations.c1",
      eventBody: {
        id: "c1",
        participants: [
          { id: "p1", purpose: "customer", calls: [{ id: "s1", connectedTime: "2026-01-01T09:00:00Z" }] },
          {
            id: "p2", purpose: "agent", userId: "u1",
            calls: [{ id: "s2", connectedTime: "2026-01-01T09:01:00Z", disconnectedTime: "2026-01-01T09:05:00Z" }],
            wrapup: { code: "resolved", notes: "ok" },
          },
          { id: "p3", purpose: "voicemail", calls: [{ id: "s3" }] },
        ],
      },
    };
    const a = normalizeConversationSnapshot(snapshot)!;
    const b = normalizeConversationSnapshot({ ...structuredClone(snapshot), topicName: "v2.users.u1.conversations" })!;
    expect(a.map((e) => e.kind)).toEqual(["customer.start", "user.start", "user.end", "wrapup"]);
    expect(a.map((e) => e.key)).toEqual(b.map((e) => e.key));
    expect(a[3]).toMatchObject({ wrapupCode: "resolved", eventTime: T0 + 5 * 60_000, userId: "u1" });

    const s = new ConversationStitcher();
    expect(s.ingest(snapshot, T0).status).toBe("applied");
    expect(s.ingest(structuredClone(snapshot), T0).status).toBe("duplicate");
  });
});

describe("compaction of long conversations", () => {
  /** A messaging conversation that lasts hours, with one message event every 30 s. */
  function longChat(id: string, minutes: number): RawNotification[] {
    const ev = (kind: string, at: number, body: Record<string, unknown>) => ({
      topicName: `v2.detail.events.conversation.${id}.${kind}`,
      eventBody: { conversationId: id, eventTime: at, mediaType: "message", ...body },
    });
    const customer = { participantId: "c", sessionId: "cs" };
    const agent = { participantId: "a", sessionId: "as", userId: "u1" };
    const out: RawNotification[] = [ev("customer.start", T0, customer), ev("user.start", T0 + 1_000, agent)];
    for (let i = 1; i < minutes * 2; i++) out.push(ev("attributes", T0 + i * 30_000, { attributes: { [`k${i % 50}`]: String(i) } }));
    const end = T0 + minutes * 60_000;
    out.push(ev("customer.end", end, customer), ev("user.end", end, agent), ev("wrapup", end + 5_000, { ...agent, wrapupCode: "done" }));
    return out;
  }

  it("keeps the raw event count bounded and the result identical", () => {
    const events = longChat("long", 600); // 10 hours, ~1200 events
    const compacting = new ConversationStitcher({ compactAfterEvents: 100, compactLagMs: 10 * 60_000, idleTimeoutMs: Infinity, maxTimelineEntries: Infinity });
    const plain = new ConversationStitcher({ compactAfterEvents: Infinity, idleTimeoutMs: Infinity });
    let maxRaw = 0;
    for (const e of events) {
      const at = e.eventBody.eventTime as number;
      compacting.ingest(e, at);
      plain.ingest(structuredClone(e), at);
      maxRaw = Math.max(maxRaw, Object.keys(compacting.snapshot().conversations[0].events).length);
    }
    expect(maxRaw).toBeLessThanOrEqual(101);
    const [a] = compacting.flush(T0);
    const [b] = plain.flush(T0);
    expect(a.delivery.compactedEvents).toBeGreaterThan(1000);
    expect(a.delivery.eventsApplied).toBe(events.length);
    const { delivery: _a, ...ra } = a;
    const { delivery: _b, ...rb } = b;
    expect(ra).toEqual(rb);
  });

  it("still drops duplicates of compacted events", () => {
    const events = longChat("dup", 120);
    const s = new ConversationStitcher({ compactAfterEvents: 20, compactLagMs: 5 * 60_000 });
    for (const e of events) s.ingest(e, e.eventBody.eventTime as number);
    const state = s.snapshot().conversations[0];
    // A compacted event about ten minutes old is still recognized.
    const recent = events[events.length - 25];
    expect(state.events[normalizeDetailEvent(recent)!.key]).toBeUndefined();
    expect(s.ingest(structuredClone(recent), T0).status).toBe("duplicate");
  });

  it("still handles reordering inside the lag window", () => {
    const events = longChat("ooo", 120);
    const shuffled = [...events];
    // Swap neighbours: every event arrives at most one step out of order.
    for (let i = 0; i + 1 < shuffled.length; i += 2) [shuffled[i], shuffled[i + 1]] = [shuffled[i + 1], shuffled[i]];
    const a = new ConversationStitcher({ compactAfterEvents: 20, compactLagMs: 5 * 60_000 });
    const b = new ConversationStitcher({ compactAfterEvents: Infinity });
    for (const e of shuffled) a.ingest(e, e.eventBody.eventTime as number);
    for (const e of events) b.ingest(structuredClone(e), e.eventBody.eventTime as number);
    const { delivery: _a, ...ra } = a.flush(T0)[0];
    const { delivery: _b, ...rb } = b.flush(T0)[0];
    expect(ra).toEqual(rb);
  });

  it("keeps stored state bounded no matter how long the conversation runs", () => {
    const s = new ConversationStitcher({ idleTimeoutMs: Infinity });
    const sizes: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      s.ingest({ topicName: "v2.detail.events.conversation.big.attributes", eventBody: { conversationId: "big", eventTime: T0 + i * 1000, attributes: { n: String(i) } } }, T0 + i * 1000);
      if (i % 5_000 === 4_999) sizes.push(JSON.stringify(s.snapshot()).length);
    }
    expect(Math.max(...sizes)).toBeLessThan(500_000);
    expect(sizes[3] / sizes[1]).toBeLessThan(1.1);
  });
});
