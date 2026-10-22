import { allSessionsEnded, consolidate } from "./consolidate.js";
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
  /** Applied events by fingerprint. */
  events: Record<string, ConversationEvent>;
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

  if (state.events[event.key]) {
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

  if (emitted) {
    state.dirty = true;
    state.settleDeadline = now + policy.settleMs;
    return "late";
  }

  state.settleDeadline = allSessionsEnded(Object.values(state.events)) ? now + policy.settleMs : undefined;
  return "applied";
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
  const events = Object.values(state.events);
  const body = consolidate(events);
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
      eventsApplied: events.length,
      duplicatesDropped: state.duplicates,
      outOfOrderEvents: state.outOfOrder,
      lateEvents: state.late,
      openSessions: body.openSessions,
    },
  };
}
