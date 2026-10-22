import type { ConversationState, ConversationStore, StoredConversation } from "genesys-conversation-stitcher";

/** The subset of a PostgreSQL client this store needs (node-postgres `Pool` fits). */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS stitcher_conversations (
    conversation_id TEXT PRIMARY KEY,
    version         INTEGER NOT NULL,
    due_at          BIGINT  NOT NULL,
    state           JSONB   NOT NULL
  );
  CREATE INDEX IF NOT EXISTS stitcher_conversations_due_at ON stitcher_conversations (due_at);
`;

const UNIQUE_VIOLATION = "23505";

/**
 * One row per conversation. Every write is conditional on `version`, so
 * parallel function invocations never overwrite each other.
 */
export class PostgresConversationStore implements ConversationStore {
  constructor(private readonly db: SqlClient) {}

  async load(conversationId: string): Promise<StoredConversation | undefined> {
    const { rows } = await this.db.query(
      "SELECT state, version FROM stitcher_conversations WHERE conversation_id = $1",
      [conversationId],
    );
    if (!rows.length) return undefined;
    const state = typeof rows[0].state === "string" ? JSON.parse(rows[0].state) : rows[0].state;
    return { state, version: Number(rows[0].version) };
  }

  async save(state: ConversationState, dueAt: number, expectedVersion: number): Promise<boolean> {
    const json = JSON.stringify(state);
    if (expectedVersion === 0) {
      try {
        await this.db.query(
          "INSERT INTO stitcher_conversations (conversation_id, version, due_at, state) VALUES ($1, 1, $2, $3)",
          [state.conversationId, dueAt, json],
        );
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return false;
        throw error;
      }
    }
    const result = await this.db.query(
      `UPDATE stitcher_conversations SET version = version + 1, due_at = $2, state = $3
       WHERE conversation_id = $1 AND version = $4 RETURNING version`,
      [state.conversationId, dueAt, json, expectedVersion],
    );
    return result.rows.length === 1;
  }

  async delete(conversationId: string, expectedVersion: number): Promise<boolean> {
    const result = await this.db.query(
      "DELETE FROM stitcher_conversations WHERE conversation_id = $1 AND version = $2 RETURNING version",
      [conversationId, expectedVersion],
    );
    return result.rows.length === 1;
  }

  async due(now: number, limit: number): Promise<string[]> {
    const { rows } = await this.db.query(
      "SELECT conversation_id FROM stitcher_conversations WHERE due_at <= $1 ORDER BY due_at LIMIT $2",
      [now, Number.isFinite(limit) ? limit : 1000],
    );
    return rows.map((r) => r.conversation_id);
  }
}
