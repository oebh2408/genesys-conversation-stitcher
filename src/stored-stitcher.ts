import { normalizeDetailEvent } from "./normalize.js";
import {
  applyEvent,
  buildRecord,
  decide,
  emitRecord,
  newState,
  nextDueAt,
  resolvePolicy,
  type ConversationState,
  type Policy,
} from "./state.js";
import type { IngestResult } from "./stitcher.js";
import type { ConversationStore } from "./store.js";
import type { ConsolidatedConversation, ConversationEvent, RawNotification, StitcherOptions } from "./types.js";

export type AsyncRecordListener = (record: ConsolidatedConversation) => void | Promise<void>;

export interface StoredStitcherOptions extends StitcherOptions {
  /** How many times a conflicting write is retried before giving up. Default 20. */
  maxAttempts?: number;
}

export class ConcurrencyError extends Error {
  constructor(conversationId: string, attempts: number) {
    super(`Gave up on conversation ${conversationId} after ${attempts} conflicting writes`);
    this.name = "ConcurrencyError";
  }
}

/**
 * The same stitching rules as {@link ConversationStitcher}, with state kept
 * per conversation in a {@link ConversationStore} instead of in memory.
 * Built for serverless functions: each invocation is stateless, many can run
 * in parallel, and a crash at any point loses nothing.
 *
 * Typical wiring:
 * - a queue-triggered function calls {@link ingestAll} with each batch;
 * - a scheduled function calls {@link tick} every few seconds and delivers
 *   finished conversations to the listeners.
 *
 * Delivery is at-least-once. A record is marked as being delivered before the
 * listeners run and confirmed after they succeed; if a listener throws or the
 * function dies in between, the same revision is delivered again after
 * `ackTimeoutMs`. Consumers should upsert by `conversationId` + `revision`.
 */
export class StoredConversationStitcher {
  private readonly policy: Policy;
  private readonly normalize: (n: RawNotification) => ConversationEvent | null;
  private readonly maxAttempts: number;
  private readonly listeners = new Set<AsyncRecordListener>();

  constructor(
    private readonly store: ConversationStore,
    options: StoredStitcherOptions = {},
  ) {
    this.policy = resolvePolicy(options);
    this.normalize = options.normalize ?? normalizeDetailEvent;
    this.maxAttempts = options.maxAttempts ?? 20;
  }

  /** Subscribes to delivered records. Listeners may be async. Returns an unsubscribe function. */
  onRecord(listener: AsyncRecordListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ingest(notification: RawNotification, now: number = Date.now()): Promise<IngestResult> {
    const [result] = await this.ingestAll([notification], now);
    return result;
  }

  /**
   * Applies a batch. Events are grouped by conversation so each conversation
   * is loaded and saved once; different conversations are written in parallel.
   */
  async ingestAll(notifications: Iterable<RawNotification>, now: number = Date.now()): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    const groups = new Map<string, Array<{ index: number; event: ConversationEvent }>>();
    for (const n of notifications) {
      const index = results.length;
      const event = this.normalize(n);
      results.push({ status: "ignored" });
      if (!event) continue;
      const group = groups.get(event.conversationId) ?? [];
      group.push({ index, event });
      groups.set(event.conversationId, group);
    }

    await Promise.all(
      [...groups].map(([conversationId, group]) =>
        this.update(conversationId, now, (state) => {
          for (const { index, event } of group) {
            results[index] = { status: applyEvent(state, event, now, this.policy), conversationId };
          }
        }),
      ),
    );
    return results;
  }

  /**
   * Delivers every conversation that is due at `now` (up to `limit`) and
   * forgets expired ones. Returns the records that were delivered. If any
   * listener throws, the rest still run and an AggregateError is thrown at the
   * end; the failed records are retried after `ackTimeoutMs`.
   */
  async tick(now: number = Date.now(), limit = 100): Promise<ConsolidatedConversation[]> {
    const ids = await this.store.due(now, limit);
    const errors: unknown[] = [];
    const delivered: ConsolidatedConversation[] = [];
    await Promise.all(
      ids.map(async (id) => {
        try {
          const record = await this.process(id, now);
          if (record) delivered.push(record);
        } catch (error) {
          errors.push(error);
        }
      }),
    );
    if (errors.length) throw new AggregateError(errors, `${errors.length} conversation(s) failed to deliver`);
    return delivered;
  }

  private async process(conversationId: string, now: number): Promise<ConsolidatedConversation | undefined> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const loaded = await this.store.load(conversationId);
      if (!loaded) return undefined;
      const { state, version } = loaded;
      const decision = decide(state, now, this.policy);

      if (decision.action === "wait") return undefined;
      if (decision.action === "forget") {
        if (await this.store.delete(conversationId, version)) return undefined;
        continue;
      }

      const record = decision.action === "emit" ? emitRecord(state, decision.reason, now) : buildRecord(state);
      // Claim the delivery first, so a crash during the listeners is retried
      // and two parallel ticks never both deliver the same revision.
      state.deliveringSince = now;
      if (!(await this.store.save(state, nextDueAt(state, this.policy), version))) continue;

      for (const listener of this.listeners) await listener(record);
      await this.confirm(conversationId, record.revision, now);
      return record;
    }
    throw new ConcurrencyError(conversationId, this.maxAttempts);
  }

  private async confirm(conversationId: string, revision: number, claimedAt: number): Promise<void> {
    await this.update(conversationId, claimedAt, (state) => {
      // Only clear our own claim; a newer revision or redelivery owns it now.
      if (state.revision === revision && state.deliveringSince === claimedAt) state.deliveringSince = undefined;
    }, false);
  }

  /** Load, change, conditional save; retried on conflict. */
  private async update(
    conversationId: string,
    now: number,
    change: (state: ConversationState) => void,
    create = true,
  ): Promise<void> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const loaded = await this.store.load(conversationId);
      if (!loaded && !create) return;
      const state = loaded?.state ?? newState(conversationId, now);
      change(state);
      if (await this.store.save(state, nextDueAt(state, this.policy), loaded?.version ?? 0)) return;
    }
    throw new ConcurrencyError(conversationId, this.maxAttempts);
  }
}
