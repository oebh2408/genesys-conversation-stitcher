import { allSessionsEnded, consolidate } from "./consolidate.js";
import { normalizeDetailEvent } from "./normalize.js";
import type {
  CloseReason,
  ConsolidatedConversation,
  ConversationEvent,
  LateEventPolicy,
  RawNotification,
  RecordListener,
  StitcherOptions,
} from "./types.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

interface ConversationState {
  conversationId: string;
  events: Map<string, ConversationEvent>;
  maxEventTime: number;
  lastReceivedAt: number;
  /** When the conversation will be emitted unless something else arrives. */
  settleDeadline?: number;
  revision: number;
  emittedAt?: number;
  /** Set when a late event arrives after emission and a revision is pending. */
  dirty: boolean;
  closeReason?: CloseReason;
  received: number;
  duplicates: number;
  outOfOrder: number;
  late: number;
}

/** JSON-safe copy of the stitcher's state, see {@link ConversationStitcher.snapshot}. */
export interface StitcherSnapshot {
  version: 1;
  conversations: Array<Omit<ConversationState, "events"> & { events: ConversationEvent[] }>;
}

export interface IngestResult {
  status: "applied" | "duplicate" | "late" | "late-dropped" | "ignored";
  conversationId?: string;
}

/**
 * Groups conversation events, repairs duplicates and ordering, waits for the
 * conversation to close and emits one consolidated record per conversation.
 *
 * The stitcher never reads the wall clock on its own: every method takes the
 * current time as an argument (defaulting to `Date.now()`), and nothing is
 * emitted until {@link tick} is called. That keeps it deterministic and easy
 * to test, replay and host anywhere.
 */
export class ConversationStitcher {
  private readonly settleMs: number;
  private readonly idleTimeoutMs: number;
  private readonly lateEvents: LateEventPolicy;
  private readonly retainEmittedMs: number;
  private readonly normalize: (n: RawNotification) => ConversationEvent | null;
  private readonly listeners = new Set<RecordListener>();
  private readonly conversations = new Map<string, ConversationState>();

  constructor(options: StitcherOptions = {}) {
    this.settleMs = options.settleMs ?? 30 * SECOND;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 4 * HOUR;
    this.lateEvents = options.lateEvents ?? "revise";
    this.retainEmittedMs = options.retainEmittedMs ?? HOUR;
    this.normalize = options.normalize ?? normalizeDetailEvent;
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
    const event = this.normalize(notification);
    if (!event) return { status: "ignored" };

    let c = this.conversations.get(event.conversationId);
    if (!c) {
      c = {
        conversationId: event.conversationId,
        events: new Map(),
        maxEventTime: -Infinity,
        lastReceivedAt: now,
        revision: 0,
        dirty: false,
        received: 0,
        duplicates: 0,
        outOfOrder: 0,
        late: 0,
      };
      this.conversations.set(c.conversationId, c);
    }

    c.received++;
    c.lastReceivedAt = now;
    const conversationId = c.conversationId;

    if (c.events.has(event.key)) {
      c.duplicates++;
      return { status: "duplicate", conversationId };
    }

    const emitted = c.emittedAt !== undefined;
    if (emitted) {
      c.late++;
      if (this.lateEvents === "drop") return { status: "late-dropped", conversationId };
    }

    if (event.eventTime < c.maxEventTime) c.outOfOrder++;
    c.maxEventTime = Math.max(c.maxEventTime, event.eventTime);
    c.events.set(event.key, event);

    if (emitted) {
      c.dirty = true;
      c.settleDeadline = now + this.settleMs;
      return { status: "late", conversationId };
    }

    c.settleDeadline = allSessionsEnded(c.events.values()) ? now + this.settleMs : undefined;
    return { status: "applied", conversationId };
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
    for (const c of this.conversations.values()) {
      const waiting = c.emittedAt === undefined || c.dirty;
      if (waiting) {
        if (c.settleDeadline !== undefined && now >= c.settleDeadline) {
          out.push(this.emit(c, c.closeReason ?? "ended", now));
        } else if (now - c.lastReceivedAt >= this.idleTimeoutMs) {
          out.push(this.emit(c, c.closeReason ?? "timeout", now));
        }
      } else if (now - c.emittedAt! >= this.retainEmittedMs) {
        this.conversations.delete(c.conversationId);
      }
    }
    return out;
  }

  /** Emits everything still pending, e.g. on shutdown. */
  flush(now: number = Date.now()): ConsolidatedConversation[] {
    const out: ConsolidatedConversation[] = [];
    for (const c of this.conversations.values()) {
      if (c.emittedAt === undefined || c.dirty) out.push(this.emit(c, c.closeReason ?? "flushed", now));
    }
    return out;
  }

  /** Runs {@link tick} on an interval using the real clock. Returns a stop function. */
  start(intervalMs = SECOND): () => void {
    const timer = setInterval(() => this.tick(), intervalMs);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }

  /** Serializable copy of all in-memory state, to survive restarts. */
  snapshot(): StitcherSnapshot {
    return {
      version: 1,
      conversations: [...this.conversations.values()].map((c) => ({ ...c, events: [...c.events.values()] })),
    };
  }

  /** Loads a snapshot taken with {@link snapshot}, replacing current state. */
  restore(snapshot: StitcherSnapshot): void {
    if (snapshot.version !== 1) throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
    this.conversations.clear();
    for (const c of snapshot.conversations) {
      this.conversations.set(c.conversationId, {
        ...c,
        maxEventTime: c.maxEventTime ?? -Infinity,
        events: new Map(c.events.map((e) => [e.key, e])),
      });
    }
  }

  private emit(c: ConversationState, reason: CloseReason, now: number): ConsolidatedConversation {
    const { openSessions, ...body } = consolidate(c.events.values());
    c.revision++;
    c.emittedAt = now;
    c.dirty = false;
    c.closeReason = reason;
    c.settleDeadline = undefined;

    const record: ConsolidatedConversation = {
      conversationId: c.conversationId,
      revision: c.revision,
      closeReason: reason,
      startTime: body.startTime,
      endTime: body.endTime,
      durationMs: body.endTime - body.startTime,
      mediaTypes: body.mediaTypes,
      direction: body.direction,
      participants: body.participants,
      agents: body.agents,
      queues: body.queues,
      wrapUps: body.wrapUps,
      attributes: body.attributes,
      timeline: body.timeline,
      delivery: {
        eventsReceived: c.received,
        eventsApplied: c.events.size,
        duplicatesDropped: c.duplicates,
        outOfOrderEvents: c.outOfOrder,
        lateEvents: c.late,
        openSessions,
      },
    };
    for (const listener of this.listeners) listener(record);
    return record;
  }
}
