import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { ConversationStitcher, StoredConversationStitcher, replay, replayStored, simulate } from "../src/index.js";
import { PostgresConversationStore, SCHEMA } from "../examples/postgres-store.js";

function database() {
  const db = newDb();
  db.public.none(SCHEMA);
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

describe("PostgresConversationStore example", () => {
  it("passes the same end-to-end simulation as the in-memory stitcher", async () => {
    const { deliveries } = simulate({ seed: 5, conversations: 8, duplicateRate: 0.3, reorderRate: 0.3 });
    const store = new PostgresConversationStore(database());
    const stored = await replayStored(new StoredConversationStitcher(store), deliveries, { tickEveryMs: 5_000 });
    const memory = replay(new ConversationStitcher(), deliveries, { tickEveryMs: 5_000 });
    const byId = (rs: typeof memory) => new Map(rs.map((r) => [r.conversationId, { ...r, delivery: undefined, revision: undefined }]));
    expect(byId(stored)).toEqual(byId(memory));
  });

  it("rejects a write based on a stale version", async () => {
    const store = new PostgresConversationStore(database());
    const state = { conversationId: "c", events: {}, lastReceivedAt: 0, revision: 0, dirty: false, received: 0, duplicates: 0, outOfOrder: 0, late: 0 };
    expect(await store.save(state, 10, 0)).toBe(true);
    expect(await store.save(state, 10, 0)).toBe(false);
    expect(await store.save(state, 20, 1)).toBe(true);
    expect(await store.save(state, 30, 1)).toBe(false);
    expect(await store.load("c")).toMatchObject({ version: 2 });
    expect(await store.due(25, 10)).toEqual(["c"]);
    expect(await store.delete("c", 1)).toBe(false);
    expect(await store.delete("c", 2)).toBe(true);
  });
});
