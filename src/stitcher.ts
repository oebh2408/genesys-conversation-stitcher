import { normalizeNotification } from "./normalize.js";
import {
  applyEvent,
  combineStatus,
  decide,
  emitRecord,
  newState,
  resolvePolicy,
  toEvents,
  type ConversationState,
  type IngestStatus,
  type Policy,
} from "./state.js";
import type {
  ConsolidatedConversation,
  ConversationEvent,
  RawNotification,
  RecordListener,
  StitcherOptions,
} from "./types.js";

/** JSON-safe copy of the stitcher's state, see {@link ConversationStitcher.snapshot}. */
export interface StitcherSnapshot {
  version: 2;
  conversations: ConversationState[];
}

export interface IngestResult {
  status: IngestStatus;
  conversationId?: string;
}

/**
 * Groups conversation events, repairs duplicates and ordering, waits for the
 * conversation to close and emits one consolidated record per conversation.
 *
 * This is the in-memory variant for long-running processes. For serverless
 * functions, see {@link StoredConversationStitcher}.
 *
 * The stitcher never reads the wall clock on its own: every method takes the
 * current time as an argument (defaulting to `Date.now()`), and nothing is
 * emitted until {@link tick} is called. That keeps it deterministic and easy
 * to test, replay and host anywhere.
 */
export class ConversationStitcher {
  private readonly policy: Policy;
  private readonly normalize: (n: RawNotification) => ConversationEvent | ConversationEvent[] | null;
  private readonly listeners = new Set<RecordListener>();
  private readonly conversations = new Map<string, ConversationState>();

  constructor(options: StitcherOptions = {}) {
    this.policy = resolvePolicy(options);
    this.normalize = options.normalize ?? normalizeNotification;
  }

  /** Subscribes to emitted records. Returns an unsubscribe function. */
  onRecord(listener: RecordListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Number of conversations currently held in memory (pending or retained). */
  get size(): number {
    return this.conversations.size;
  }

  /** Number of conversations still waiting to be emitted. */
  get pending(): number {
    let n = 0;
    for (const c of this.conversations.values()) if (c.emittedAt === undefined || c.dirty) n++;
    return n;
  }

  ingest(notification: RawNotification, now: number = Date.now()): IngestResult {
    const events = toEvents(this.normalize(notification));
    if (events.length === 0) return { status: "ignored" };

    const statuses = events.map((event) => {
      let state = this.conversations.get(event.conversationId);
      if (!state) {
        state = newState(event.conversationId, now);
        this.conversations.set(state.conversationId, state);
      }
      return applyEvent(state, event, now, this.policy);
    });
    return { status: combineStatus(statuses), conversationId: events[0].conversationId };
  }

  /** Convenience for feeding a batch, e.g. one message from a queue. */
  ingestAll(notifications: Iterable<RawNotification>, now: number = Date.now()): IngestResult[] {
    const out: IngestResult[] = [];
    for (const n of notifications) out.push(this.ingest(n, now));
    return out;
  }

  /**
   * Emits every conversation that is ready at `now` and forgets the ones whose
   * retention has expired. Call it on a timer, or after each batch.
   */
  tick(now: number = Date.now()): ConsolidatedConversation[] {
    const out: ConsolidatedConversation[] = [];
    for (const state of this.conversations.values()) {
      const decision = decide(state, now, this.policy);
      if (decision.action === "emit") out.push(this.emit(state, decision.reason, now));
      else if (decision.action === "forget") this.conversations.delete(state.conversationId);
    }
    return out;
  }

  /** Emits everything still pending, e.g. on shutdown. */
  flush(now: number = Date.now()): ConsolidatedConversation[] {
    const out: ConsolidatedConversation[] = [];
    for (const state of this.conversations.values()) {
      if (state.emittedAt === undefined || state.dirty) {
        out.push(this.emit(state, state.closeReason ?? "flushed", now));
      }
    }
    return out;
  }

  /** Runs {@link tick} on an interval using the real clock. Returns a stop function. */
  start(intervalMs = 1000): () => void {
    const timer = setInterval(() => this.tick(), intervalMs);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }

  /** Serializable copy of all in-memory state, to survive restarts. */
  snapshot(): StitcherSnapshot {
    return { version: 2, conversations: structuredClone([...this.conversations.values()]) };
  }

  /** Loads a snapshot taken with {@link snapshot}, replacing current state. */
  restore(snapshot: StitcherSnapshot): void {
    if (snapshot.version !== 2) throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
    this.conversations.clear();
    for (const state of structuredClone(snapshot.conversations)) this.conversations.set(state.conversationId, state);
  }

  private emit(state: ConversationState, reason: Parameters<typeof emitRecord>[1], now: number) {
    const record = emitRecord(state, reason, now);
    for (const listener of this.listeners) listener(record);
    return record;
  }
}
