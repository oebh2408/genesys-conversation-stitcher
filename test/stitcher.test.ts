import { describe, expect, it } from "vitest";
import {
  ConversationStitcher,
  normalizeDetailEvent,
  replay,
  simulate,
  type ConsolidatedConversation,
  type RawNotification,
} from "../src/index.js";

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);

function ev(conversationId: string, kind: string, at: number, body: Record<string, unknown> = {}): RawNotification {
  return {
    topicName: `v2.detail.events.conversation.${conversationId}.${kind}`,
    eventBody: { conversationId, eventTime: at, mediaType: "voice", ...body },
  };
}

function shortCall(id = "c1"): RawNotification[] {
  const customer = { participantId: "p-cust", sessionId: "s-cust" };
  const agent = { participantId: "p-agent", sessionId: "s-agent", userId: "u1" };
  return [
    ev(id, "customer.start", T0, customer),
    ev(id, "acd.start", T0 + 100, { participantId: "p-acd", sessionId: "s-acd", queueId: "q1" }),
    ev(id, "acd.end", T0 + 5_000, { participantId: "p-acd", sessionId: "s-acd", queueId: "q1" }),
    ev(id, "user.start", T0 + 5_100, agent),
    ev(id, "customer.end", T0 + 60_000, customer),
    ev(id, "user.end", T0 + 60_000, agent),
    ev(id, "wrapup", T0 + 70_000, { ...agent, wrapupCode: "resolved" }),
  ];
}

const latest = (records: ConsolidatedConversation[]) => new Map(records.map((r) => [r.conversationId, r]));
const withoutDelivery = ({ delivery, revision, ...rest }: ConsolidatedConversation) => rest;

describe("ConversationStitcher", () => {
  it("reconstructs every simulated conversation despite duplicates and reordering", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { deliveries, truth } = simulate({ seed, conversations: 15, duplicateRate: 0.3, reorderRate: 0.4 });
      const out = latest(replay(new ConversationStitcher(), deliveries));
      expect(out.size).toBe(truth.length);
      for (const t of truth) {
        const r = out.get(t.conversationId)!;
        expect(r.startTime).toBe(t.startTime);
        expect(r.endTime).toBe(t.endTime);
        expect(r.agents).toEqual(t.agents);
        expect(r.queues.map((q) => q.queueId)).toEqual(t.queues);
        expect(r.wrapUps.map((w) => w.code)).toEqual(t.wrapUpCodes);
        expect(r.delivery.eventsApplied).toBe(t.eventCount);
        expect(r.delivery.openSessions).toBe(0);
        expect(r.closeReason).toBe("ended");
      }
    }
  });

  it("converges to the truth through revisions when events straggle in very late", () => {
    const { deliveries, truth } = simulate({ seed: 11, conversations: 30, straggleRate: 0.1 });
    const records = replay(new ConversationStitcher({ settleMs: 30_000 }), deliveries);
    const out = latest(records);
    expect(records.length).toBeGreaterThan(out.size);
    for (const t of truth) {
      const r = out.get(t.conversationId)!;
      expect(r.endTime).toBe(t.endTime);
      expect(r.wrapUps.map((w) => w.code)).toEqual(t.wrapUpCodes);
      expect(r.delivery.eventsApplied).toBe(t.eventCount);
    }
  });

  it("produces the same record from a clean stream and a damaged one", () => {
    const clean = simulate({ seed: 9, duplicateRate: 0, reorderRate: 0 });
    const noisy = simulate({ seed: 9, duplicateRate: 0.5, reorderRate: 0.5 });
    const a = latest(replay(new ConversationStitcher(), clean.deliveries));
    const b = latest(replay(new ConversationStitcher(), noisy.deliveries));
    for (const [id, r] of a) expect(withoutDelivery(b.get(id)!)).toEqual(withoutDelivery(r));
  });

  it("drops duplicates and counts them", () => {
    const s = new ConversationStitcher();
    const events = shortCall();
    for (const e of [...events, ...events, events[0]]) s.ingest(structuredClone(e), T0);
    const [r] = s.flush(T0);
    expect(r.delivery).toMatchObject({ eventsReceived: 15, eventsApplied: 7, duplicatesDropped: 8 });
  });

  it("waits for the settle window before emitting", () => {
    const s = new ConversationStitcher({ settleMs: 30_000 });
    s.ingestAll(shortCall().slice(0, 6), T0 + 61_000);
    expect(s.tick(T0 + 61_000 + 29_999)).toHaveLength(0);
    s.ingest(shortCall()[6], T0 + 80_000); // wrap-up arrives inside the window and restarts it
    expect(s.tick(T0 + 109_999)).toHaveLength(0);
    const out = s.tick(T0 + 110_000);
    expect(out).toHaveLength(1);
    expect(out[0].wrapUps).toEqual([expect.objectContaining({ code: "resolved", userId: "u1" })]);
  });

  it("does not consider a conversation closed while a session is open", () => {
    const s = new ConversationStitcher({ settleMs: 1_000 });
    const events = shortCall();
    s.ingestAll(events.filter((e) => !e.topicName.endsWith("user.end")), T0);
    expect(s.tick(T0 + 60_000)).toHaveLength(0);
    s.ingest(events[5], T0 + 60_000);
    expect(s.tick(T0 + 61_000)).toHaveLength(1);
  });

  it("orders events by event time, not arrival time", () => {
    const s = new ConversationStitcher();
    s.ingestAll([...shortCall()].reverse(), T0);
    const [r] = s.flush(T0);
    expect(r.timeline.map((t) => t.kind)).toEqual([
      "customer.start", "acd.start", "acd.end", "user.start", "customer.end", "user.end", "wrapup",
    ]);
    expect(r.delivery.outOfOrderEvents).toBe(6);
    expect(r.queues).toEqual([{ queueId: "q1", enteredAt: T0 + 100, leftAt: T0 + 5_000, waitMs: 4_900 }]);
    expect(r.durationMs).toBe(60_000);
  });

  it("emits a revision when a late event arrives after emission", () => {
    const s = new ConversationStitcher({ settleMs: 1_000 });
    s.ingestAll(shortCall().slice(0, 6), T0);
    expect(s.tick(T0 + 1_000)[0].revision).toBe(1);
    expect(s.ingest(shortCall()[6], T0 + 5_000).status).toBe("late");
    const [rev] = s.tick(T0 + 6_000);
    expect(rev.revision).toBe(2);
    expect(rev.wrapUps).toHaveLength(1);
    expect(rev.delivery.lateEvents).toBe(1);
  });

  it("can drop late events instead", () => {
    const s = new ConversationStitcher({ settleMs: 1_000, lateEvents: "drop" });
    s.ingestAll(shortCall().slice(0, 6), T0);
    s.tick(T0 + 1_000);
    expect(s.ingest(shortCall()[6], T0 + 5_000).status).toBe("late-dropped");
    expect(s.tick(T0 + 10_000)).toHaveLength(0);
  });

  it("emits on idle timeout when the end never arrives", () => {
    const s = new ConversationStitcher({ idleTimeoutMs: 60_000 });
    s.ingestAll(shortCall().slice(0, 4), T0);
    expect(s.tick(T0 + 59_999)).toHaveLength(0);
    const [r] = s.tick(T0 + 60_000);
    expect(r.closeReason).toBe("timeout");
    expect(r.delivery.openSessions).toBe(2);
  });

  it("forgets emitted conversations after the retention period", () => {
    const s = new ConversationStitcher({ settleMs: 1_000, retainEmittedMs: 10_000 });
    s.ingestAll(shortCall(), T0);
    s.tick(T0 + 1_000);
    expect(s.size).toBe(1);
    s.tick(T0 + 11_000);
    expect(s.size).toBe(0);
  });

  it("survives a restart through snapshot and restore", () => {
    const { deliveries } = simulate({ seed: 3, conversations: 10 });
    const half = Math.floor(deliveries.length / 2);
    const reference = latest(replay(new ConversationStitcher(), deliveries));

    const first = new ConversationStitcher();
    const before = replay(first, deliveries.slice(0, half), { drainMs: 0 });
    const snap = JSON.parse(JSON.stringify(first.snapshot()));
    const second = new ConversationStitcher();
    second.restore(snap);
    const after = replay(second, deliveries.slice(half));
    const resumed = latest([...before, ...after]);

    expect(resumed.size).toBe(reference.size);
    for (const [id, r] of reference) expect(withoutDelivery(resumed.get(id)!)).toEqual(withoutDelivery(r));
  });

  it("notifies listeners", () => {
    const s = new ConversationStitcher();
    const seen: string[] = [];
    const off = s.onRecord((r) => seen.push(r.conversationId));
    s.ingestAll(shortCall("a"), T0);
    s.flush(T0);
    off();
    s.ingestAll(shortCall("b"), T0);
    s.flush(T0);
    expect(seen).toEqual(["a"]);
  });
});

describe("normalizeDetailEvent", () => {
  it("accepts ISO timestamps and reads the id from the topic", () => {
    const e = normalizeDetailEvent({
      topicName: "v2.detail.events.conversation.abc.user.start",
      eventBody: { eventTime: "2026-01-01T09:00:00.000Z", participantId: "p" },
    });
    expect(e).toMatchObject({ conversationId: "abc", kind: "user.start", eventTime: T0 });
  });

  it("keeps unknown kinds as 'other' and rejects events without a conversation", () => {
    expect(normalizeDetailEvent(ev("x", "something.new", T0))?.kind).toBe("other");
    expect(normalizeDetailEvent({ topicName: "v2.users.1.presence", eventBody: { eventTime: T0 } })).toBeNull();
  });

  it("gives equal payloads the same key regardless of property order", () => {
    const a = normalizeDetailEvent(ev("x", "acw", T0, { a: 1, b: 2 }))!;
    const b = normalizeDetailEvent({ topicName: "v2.detail.events.conversation.x.acw", eventBody: { b: 2, a: 1, eventTime: T0, mediaType: "voice", conversationId: "x" } })!;
    expect(a.key).toBe(b.key);
  });
});
