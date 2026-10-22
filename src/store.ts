import type { ConversationState } from "./state.js";

export interface StoredConversation {
  state: ConversationState;
  /** Incremented on every successful save; used for optimistic concurrency. */
  version: number;
}

/**
 * Where the {@link StoredConversationStitcher} keeps one record per
 * conversation. Any database that can do a conditional write works: SQL,
 * a key-value store with compare-and-set, a document store with ETags.
 *
 * Every write is conditional on the version that was read. When two function
 * invocations touch the same conversation at once, one write wins and the
 * other returns `false`, reloads and tries again.
 */
export interface ConversationStore {
  load(conversationId: string): Promise<StoredConversation | undefined>;
  /**
   * Writes the state only if the stored version still equals `expectedVersion`
   * (0 means "must not exist yet"); the new version is `expectedVersion + 1`.
   * `dueAt` is when the conversation next needs attention, and must be
   * indexed so that {@link due} is cheap. Returns `false` on conflict.
   */
  save(state: ConversationState, dueAt: number, expectedVersion: number): Promise<boolean>;
  /** Deletes only if the stored version equals `expectedVersion`. Returns `false` on conflict. */
  delete(conversationId: string, expectedVersion: number): Promise<boolean>;
  /** Ids of conversations with `dueAt <= now`, earliest first, at most `limit`. */
  due(now: number, limit: number): Promise<string[]>;
}

/**
 * Reference implementation kept in process memory. Useful for tests and local
 * development, and as a template for a real store. It serializes on every
 * write, like a database would, and yields between calls so that concurrent
 * callers really do interleave.
 */
export class MemoryConversationStore implements ConversationStore {
  private readonly rows = new Map<string, { json: string; version: number; dueAt: number }>();

  /** Number of conversations stored. */
  get size(): number {
    return this.rows.size;
  }

  async load(conversationId: string): Promise<StoredConversation | undefined> {
    await yieldToOthers();
    const row = this.rows.get(conversationId);
    return row && { state: JSON.parse(row.json), version: row.version };
  }

  async save(state: ConversationState, dueAt: number, expectedVersion: number): Promise<boolean> {
    await yieldToOthers();
    const current = this.rows.get(state.conversationId)?.version ?? 0;
    if (current !== expectedVersion) return false;
    this.rows.set(state.conversationId, { json: JSON.stringify(state), version: current + 1, dueAt });
    return true;
  }

  async delete(conversationId: string, expectedVersion: number): Promise<boolean> {
    await yieldToOthers();
    const row = this.rows.get(conversationId);
    if (!row || row.version !== expectedVersion) return false;
    this.rows.delete(conversationId);
    return true;
  }

  async due(now: number, limit: number): Promise<string[]> {
    await yieldToOthers();
    return [...this.rows.entries()]
      .filter(([, row]) => row.dueAt <= now)
      .sort((a, b) => a[1].dueAt - b[1].dueAt)
      .slice(0, limit)
      .map(([id]) => id);
  }
}

function yieldToOthers(): Promise<void> {
  return Promise.resolve();
}
