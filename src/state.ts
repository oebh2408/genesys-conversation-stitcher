import { accumulate, compareEvents, createAccumulator, finish, fold, isEnd, isStart, type Accumulator } from "./consolidate.js";
import type {
  CloseReason,
  ConsolidatedConversation,
  ConversationEvent,
  LateEventPolicy,
  StitcherOptions,
} from "./types.js";

/**
 * Everything known about one conversation, as plain JSON. This is the unit
 * that gets stored, loaded and versioned; the functions below are the only
 * things that change it.
 */
export interface ConversationState {
  conversationId: string;
  /** Applied events by fingerprint, not yet compacted. */
  events: Record<string, ConversationEvent>;
  /** Number of entries in `events`, kept to avoid counting on every event. */
  rawCount?: number;
  /** Raw count right after the last compaction, so compaction runs in batches. */
  rawAfterCompaction?: number;
  /** Every session seen, and whether it has ended. */
  sessions?: Record<string, boolean>;
  /** Older events already folded into a summary, see {@link compact}. */
  checkpoint?: Accumulator;
  /** Fingerprints of recently compacted events (with their event time), to drop their duplicates. */
  compactedKeys?: Record<string, number>;
  compactedCount?: number;
  maxEventTime?: number;
  lastReceivedAt: number;
  /** When the conversation will be emitted unless something else arrives. */
  settleDeadline?: number;
  revision: number;
  emittedAt?: number;
  /** Set when a late event arrives after emission and a revision is pending. */
  dirty: boolean;
  closeReason?: CloseReason;
  /**
   * Set while an emitted record has not been confirmed as delivered
   * (stored stitcher only). If it is still set after `ackTimeoutMs`, the
   * same revision is delivered again.
   */
  deliveringSince?: number;
  received: number;
  duplicates: number;
  outOfOrder: number;
  late: number;
}

export interface Policy {
  settleMs: number;
  idleTimeoutMs: number;
  lateEvents: LateEventPolicy;
  retainEmittedMs: number;
  ackTimeoutMs: number;
  compactAfterEvents: number;
  compactLagMs: number;
  maxTimelineEntries: number;
}

export type IngestStatus = "applied" | "duplicate" | "late" | "late-dropped" | "ignored";

export type Decision =
  | { action: "emit"; reason: CloseReason }
  | { action: "redeliver" }
  | { action: "forget" }
  | { action: "wait" };

const SECOND = 1000;
const HOUR = 3600 * SECOND;

export function resolvePolicy(options: StitcherOptions = {}): Policy {
  return {
    settleMs: options.settleMs ?? 30 * SECOND,
    idleTimeoutMs: options.idleTimeoutMs ?? 4 * HOUR,
    lateEvents: options.lateEvents ?? "revise",
    retainEmittedMs: options.retainEmittedMs ?? HOUR,
    ackTimeoutMs: options.ackTimeoutMs ?? 60 * SECOND,
    compactAfterEvents: options.compactAfterEvents ?? 500,
    compactLagMs: options.compactLagMs ?? 15 * 60 * SECOND,
    maxTimelineEntries: options.maxTimelineEntries ?? 1000,
  };
}

export function newState(conversationId: string, now: number): ConversationState {
  return {
    conversationId,
    events: {},
    lastReceivedAt: now,
    revision: 0,
    dirty: false,
    received: 0,
    duplicates: 0,
    outOfOrder: 0,
    late: 0,
  };
}

function isPending(state: ConversationState): boolean {
  return state.emittedAt === undefined || state.dirty;
}

/** Applies one event to the state in place and says what happened to it. */
export function applyEvent(
  state: ConversationState,
  event: ConversationEvent,
  now: number,
  policy: Policy,
): IngestStatus {
  state.received++;
  state.lastReceivedAt = now;

  if (state.events[event.key] || state.compactedKeys?.[event.key]) {
    state.duplicates++;
    return "duplicate";
  }

  const emitted = state.emittedAt !== undefined;
  if (emitted) {
    state.late++;
    if (policy.lateEvents === "drop") return "late-dropped";
  }

  if (state.maxEventTime !== undefined && event.eventTime < state.maxEventTime) state.outOfOrder++;
  state.maxEventTime = Math.max(state.maxEventTime ?? event.eventTime, event.eventTime);
  state.events[event.key] = event;
  state.rawCount = (state.rawCount ?? Object.keys(state.events).length - 1) + 1;
  trackSession(state, event);
  compact(state, policy);

  if (emitted) {
    state.dirty = true;
    state.settleDeadline = now + policy.settleMs;
    return "late";
  }

  state.settleDeadline = allEnded(state) ? now + policy.settleMs : undefined;
  return "applied";
}

/**
 * Keeps long conversations bounded. Once more than `compactAfterEvents` raw
 * events are held, the ones older than `compactLagMs` behind the newest event
 * are folded into the checkpoint and dropped; only their fingerprints remain.
 * Recent events stay raw, so normal reordering is still handled exactly.
 */
/** Session flags, rebuilt from the events for state saved before they were tracked. */
function sessionsOf(state: ConversationState): Record<string, boolean> {
  if (!state.sessions) {
    state.sessions = {};
    for (const p of Object.values(state.checkpoint?.participants ?? {})) {
      for (const s of p.sessions) state.sessions[s.sessionId] = s.endTime !== undefined;
    }
    for (const e of Object.values(state.events).sort(compareEvents)) trackSession(state, e);
  }
  return state.sessions;
}

function trackSession(state: ConversationState, e: ConversationEvent): void {
  if (!e.participantId || !(isStart(e.kind) || isEnd(e.kind))) return;
  const sessions = sessionsOf(state);
  const sid = e.sessionId ?? e.participantId;
  if (isEnd(e.kind)) sessions[sid] = true;
  else sessions[sid] ??= false;
}

/** At least one session, and every session seen has ended. */
function allEnded(state: ConversationState): boolean {
  const flags = Object.values(sessionsOf(state));
  return flags.length > 0 && flags.every(Boolean);
}

export function compact(state: ConversationState, policy: Policy): void {
  const raw = state.rawCount ?? Object.keys(state.events).length;
  if (raw <= policy.compactAfterEvents || state.maxEventTime === undefined) return;
  // Run in batches of a tenth of the threshold, not on every event.
  if (raw - (state.rawAfterCompaction ?? 0) < Math.max(1, policy.compactAfterEvents / 10)) return;
  const events = Object.values(state.events);
  const horizon = state.maxEventTime - policy.compactLagMs;
  const old = events.filter((e) => e.eventTime < horizon).sort(compareEvents);
  if (old.length === 0) {
    state.rawAfterCompaction = raw;
    return;
  }

  const checkpoint = (state.checkpoint ??= createAccumulator());
  const keys = (state.compactedKeys ??= {});
  for (const e of old) {
    accumulate(checkpoint, e);
    keys[e.key] = e.eventTime;
    delete state.events[e.key];
  }
  state.compactedCount = (state.compactedCount ?? 0) + old.length;
  state.rawCount = raw - old.length;
  state.rawAfterCompaction = state.rawCount;

  // Keep the timeline bounded too: the first entry and the most recent ones.
  const excess = checkpoint.timeline.length - policy.maxTimelineEntries;
  if (excess > 0) {
    checkpoint.timeline.splice(1, excess);
    checkpoint.timelineDropped = (checkpoint.timelineDropped ?? 0) + excess;
  }

  // Duplicates of events far behind the horizon are not worth remembering
  // forever. Pruning scans every key, so do it once per `compactAfterEvents`.
  if (state.compactedCount % policy.compactAfterEvents < old.length) {
    const forget = horizon - 4 * policy.compactLagMs;
    for (const [key, time] of Object.entries(keys)) if (time < forget) delete keys[key];
  }
}

/** What should happen to this conversation at `now`. Does not change the state. */
export function decide(state: ConversationState, now: number, policy: Policy): Decision {
  if (isPending(state)) {
    if (state.settleDeadline !== undefined && now >= state.settleDeadline) {
      return { action: "emit", reason: state.closeReason ?? "ended" };
    }
    if (now - state.lastReceivedAt >= policy.idleTimeoutMs) {
      return { action: "emit", reason: state.closeReason ?? "timeout" };
    }
    return { action: "wait" };
  }
  if (state.deliveringSince !== undefined) {
    return now - state.deliveringSince >= policy.ackTimeoutMs ? { action: "redeliver" } : { action: "wait" };
  }
  return now - state.emittedAt! >= policy.retainEmittedMs ? { action: "forget" } : { action: "wait" };
}

/**
 * The earliest time at which {@link decide} will return something other than
 * "wait". Stores index on this so a scheduler only loads what is due.
 */
export function nextDueAt(state: ConversationState, policy: Policy): number {
  if (isPending(state)) {
    return Math.min(state.settleDeadline ?? Infinity, state.lastReceivedAt + policy.idleTimeoutMs);
  }
  if (state.deliveringSince !== undefined) return state.deliveringSince + policy.ackTimeoutMs;
  return state.emittedAt! + policy.retainEmittedMs;
}

/** Marks the state as emitted (new revision), in place, and returns the record. */
export function emitRecord(state: ConversationState, reason: CloseReason, now: number): ConsolidatedConversation {
  state.revision++;
  state.emittedAt = now;
  state.dirty = false;
  state.closeReason = reason;
  state.settleDeadline = undefined;
  return buildRecord(state);
}

/** The record for the state's current revision. Does not change the state. */
export function buildRecord(state: ConversationState): ConsolidatedConversation {
  const body = finish(fold(Object.values(state.events), state.checkpoint));
  return {
    conversationId: state.conversationId,
    revision: state.revision,
    closeReason: state.closeReason ?? "ended",
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
      eventsReceived: state.received,
      eventsApplied: Object.keys(state.events).length + (state.compactedCount ?? 0),
      duplicatesDropped: state.duplicates,
      outOfOrderEvents: state.outOfOrder,
      lateEvents: state.late,
      openSessions: body.openSessions,
      compactedEvents: state.compactedCount ?? 0,
      timelineEntriesDropped: body.timelineDropped,
    },
  };
}

const PRIORITY: IngestStatus[] = ["applied", "late", "late-dropped", "duplicate", "ignored"];

/** One notification can carry several events (snapshots); report the most significant outcome. */
export function combineStatus(statuses: IngestStatus[]): IngestStatus {
  for (const status of PRIORITY) if (statuses.includes(status)) return status;
  return "ignored";
}

export function toEvents(value: ConversationEvent | ConversationEvent[] | null): ConversationEvent[] {
  return value === null ? [] : Array.isArray(value) ? value : [value];
}
