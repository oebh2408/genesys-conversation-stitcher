import { describe, expect, it } from "vitest";
import {
  ConversationStitcher,
  MemoryConversationStore,
  StoredConversationStitcher,
  replay,
  replayStored,
  simulate,
  type ConsolidatedConversation,
  type ConversationState,
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
    ev(id, "user.start", T0 + 5_100, agent),
    ev(id, "customer.end", T0 + 60_000, customer),
    ev(id, "user.end", T0 + 60_000, agent),
    ev(id, "wrapup", T0 + 70_000, { ...agent, wrapupCode: "resolved" }),
  ];
}

/** Memory store that counts write conflicts. */
class CountingStore extends MemoryConversationStore {
  conflicts = 0;
  override async save(state: ConversationState, dueAt: number, expectedVersion: number) {
    const ok = await super.save(state, dueAt, expectedVersion);
    if (!ok) this.conflicts++;
    return ok;
  }
}

const latest = (records: ConsolidatedConversation[]) => new Map(records.map((r) => [r.conversationId, r]));
const content = ({ delivery, revision, ...rest }: ConsolidatedConversation) => rest;

describe("StoredConversationStitcher", () => {
  it("matches the truth and the in-memory stitcher, with parallel writers", async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { deliveries, truth } = simulate({ seed, conversations: 12, duplicateRate: 0.4, reorderRate: 0.4 });
      const store = new CountingStore();
      const stored = latest(await replayStored(new StoredConversationStitcher(store), deliveries));
      const memory = latest(replay(new ConversationStitcher(), deliveries));

      expect(stored.size).toBe(truth.length);
      for (const t of truth) {
        const r = stored.get(t.conversationId)!;
        expect(r.endTime).toBe(t.endTime);
        expect(r.agents).toEqual(t.agents);
        expect(r.wrapUps.map((w) => w.code)).toEqual(t.wrapUpCodes);
        expect(r.delivery.eventsApplied).toBe(t.eventCount);
        expect(content(r)).toEqual(content(memory.get(t.conversationId)!));
      }
    }
  });

  it("keeps every event when many invocations write the same conversation at once", async () => {
    const store = new CountingStore();
    const s = new StoredConversationStitcher(store);
    const events = shortCall();
    const calls = [...events, ...events, ...events].map((e) => s.ingest(structuredClone(e), T0));
    const results = await Promise.all(calls);

    expect(store.conflicts).toBeGreaterThan(0);
    expect(results.filter((r) => r.status === "applied")).toHaveLength(5);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(10);
    const [record] = await s.tick(T0 + 60_000);
    expect(record.delivery).toMatchObject({ eventsReceived: 15, eventsApplied: 5, duplicatesDropped: 10 });
  });

  it("delivers a revision only once even when two schedulers tick together", async () => {
    const store = new MemoryConversationStore();
    const a = new StoredConversationStitcher(store);
    const b = new StoredConversationStitcher(store);
    const seen: number[] = [];
    a.onRecord((r) => void seen.push(r.revision));
    b.onRecord((r) => void seen.push(r.revision));
    await a.ingestAll(shortCall(), T0);
    await Promise.all([a.tick(T0 + 30_000), b.tick(T0 + 30_000)]);
    expect(seen).toEqual([1]);
  });

  it("redelivers the same revision when a listener fails", async () => {
    const store = new MemoryConversationStore();
    const s = new StoredConversationStitcher(store, { settleMs: 1_000, ackTimeoutMs: 10_000 });
    let failures = 1;
    const delivered: number[] = [];
    s.onRecord(async (r) => {
      if (failures-- > 0) throw new Error("warehouse unavailable");
      delivered.push(r.revision);
    });

    await s.ingestAll(shortCall(), T0);
    await expect(s.tick(T0 + 1_000)).rejects.toThrow(AggregateError);
    expect(await s.tick(T0 + 5_000)).toHaveLength(0); // still inside the ack timeout
    const [again] = await s.tick(T0 + 11_000);
    expect(again.revision).toBe(1);
    expect(delivered).toEqual([1]);
    expect(await s.tick(T0 + 30_000)).toHaveLength(0); // confirmed, not delivered again
  });

  it("recovers when the function dies mid-delivery", async () => {
    const store = new MemoryConversationStore();
    const crashing = new StoredConversationStitcher(store, { settleMs: 1_000, ackTimeoutMs: 10_000 });
    crashing.onRecord(() => new Promise(() => {})); // never finishes: the invocation is killed
    await crashing.ingestAll(shortCall(), T0);
    void crashing.tick(T0 + 1_000);
    await new Promise((r) => setTimeout(r, 5));

    const fresh = new StoredConversationStitcher(store, { settleMs: 1_000, ackTimeoutMs: 10_000 });
    expect(await fresh.tick(T0 + 5_000)).toHaveLength(0);
    const [record] = await fresh.tick(T0 + 11_000);
    expect(record).toMatchObject({ conversationId: "c1", revision: 1 });
  });

  it("emits a revision for late events and forgets after retention", async () => {
    const store = new MemoryConversationStore();
    const s = new StoredConversationStitcher(store, { settleMs: 1_000, retainEmittedMs: 60_000 });
    await s.ingestAll(shortCall().slice(0, 4), T0);
    expect((await s.tick(T0 + 1_000))[0].wrapUps).toHaveLength(0);
    expect((await s.ingest(shortCall()[4], T0 + 5_000)).status).toBe("late");
    const [rev] = await s.tick(T0 + 6_000);
    expect(rev).toMatchObject({ revision: 2, wrapUps: [expect.objectContaining({ code: "resolved" })] });
    expect(store.size).toBe(1);
    await s.tick(T0 + 66_000);
    expect(store.size).toBe(0);
  });

  it("only loads conversations that are due", async () => {
    const store = new MemoryConversationStore();
    const s = new StoredConversationStitcher(store, { settleMs: 1_000 });
    await s.ingestAll([...shortCall("done"), ...shortCall("open").slice(0, 2)], T0);
    expect(await store.due(T0 + 1_000, 10)).toEqual(["done"]);
  });
});
