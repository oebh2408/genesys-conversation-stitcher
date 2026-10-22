/**
 * Two stateless functions around one store. Works on any serverless platform:
 * adapt the handler signatures to your provider, the logic stays the same.
 *
 *   events stream ──► queue ──► onEvents()  ──► store
 *                                  scheduler ──► onSchedule() ──► store ──► your sink
 */
import { Pool } from "pg";
import { StoredConversationStitcher, type RawNotification } from "genesys-conversation-stitcher";
import { PostgresConversationStore } from "./postgres-store.js";

// Created once per container and reused across warm invocations.
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const stitcher = new StoredConversationStitcher(new PostgresConversationStore(db), {
  settleMs: 30_000,
  ackTimeoutMs: 60_000,
});

stitcher.onRecord(async (record) => {
  // Upsert by conversationId + revision: delivery is at-least-once.
  await db.query(
    `INSERT INTO conversations (conversation_id, revision, record) VALUES ($1, $2, $3)
     ON CONFLICT (conversation_id) DO UPDATE SET revision = EXCLUDED.revision, record = EXCLUDED.record
     WHERE conversations.revision <= EXCLUDED.revision`,
    [record.conversationId, record.revision, JSON.stringify(record)],
  );
});

/** Triggered by the queue that receives Genesys Cloud notifications, one batch at a time. */
export async function onEvents(batch: { messages: Array<{ body: string }> }): Promise<void> {
  const notifications: RawNotification[] = batch.messages.map((m) => JSON.parse(m.body));
  await stitcher.ingestAll(notifications);
}

/** Triggered on a schedule, e.g. every 10 seconds. Safe to run in parallel. */
export async function onSchedule(): Promise<void> {
  await stitcher.tick(Date.now(), 500);
}
