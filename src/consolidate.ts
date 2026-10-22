import type {
  ConversationEvent,
  EventKind,
  Participant,
  QueueVisit,
  TimelineEntry,
  WrapUp,
} from "./types.js";

const START: ReadonlySet<EventKind> = new Set(["customer.start", "user.start", "acd.start", "flow.start"]);
const END: ReadonlySet<EventKind> = new Set(["customer.end", "user.end", "acd.end", "flow.end"]);

const PURPOSE_BY_PREFIX: Record<string, string> = {
  customer: "customer",
  user: "agent",
  acd: "acd",
  flow: "ivr",
  acw: "agent",
  wrapup: "agent",
};

/** Within the same millisecond, starts go before data events, which go before ends. */
function rank(kind: EventKind): number {
  if (START.has(kind)) return 0;
  if (END.has(kind)) return 2;
  return 1;
}

export function compareEvents(a: ConversationEvent, b: ConversationEvent): number {
  return a.eventTime - b.eventTime || rank(a.kind) - rank(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export function isStart(kind: EventKind): boolean {
  return START.has(kind);
}

export function isEnd(kind: EventKind): boolean {
  return END.has(kind);
}

export interface Consolidated {
  startTime: number;
  endTime: number;
  mediaTypes: string[];
  direction?: string;
  participants: Participant[];
  agents: string[];
  queues: QueueVisit[];
  wrapUps: WrapUp[];
  attributes: Record<string, string>;
  timeline: TimelineEntry[];
  timelineDropped: number;
  openSessions: number;
}

/**
 * The running result of folding events, as plain JSON. It can be stored as a
 * checkpoint and folded further later, which is how long conversations are
 * compacted.
 */
export interface Accumulator {
  startTime?: number;
  lastEventTime?: number;
  lastEnd?: number;
  direction?: string;
  mediaTypes: Record<string, true>;
  agents: Record<string, true>;
  attributes: Record<string, string>;
  participants: Record<string, Participant>;
  /** sessionId -> participantId */
  sessionOwners: Record<string, string>;
  queues: Record<string, QueueVisit>;
  wrapUps: Record<string, WrapUp>;
  timeline: TimelineEntry[];
  /** Timeline entries dropped by compaction to keep it bounded. */
  timelineDropped?: number;
}

export function createAccumulator(): Accumulator {
  return {
    mediaTypes: {},
    agents: {},
    attributes: {},
    participants: {},
    sessionOwners: {},
    queues: {},
    wrapUps: {},
    timeline: [],
  };
}

/** Folds one event into the accumulator, in place. */
export function accumulate(acc: Accumulator, e: ConversationEvent): void {
  acc.startTime = Math.min(acc.startTime ?? e.eventTime, e.eventTime);
  acc.lastEventTime = Math.max(acc.lastEventTime ?? e.eventTime, e.eventTime);
  acc.timeline.push({ time: e.eventTime, kind: e.kind, participantId: e.participantId });
  if (e.mediaType) acc.mediaTypes[e.mediaType] = true;
  acc.direction ??= e.direction;
  if (e.attributes) Object.assign(acc.attributes, e.attributes);
  if (e.userId && (e.kind.startsWith("user.") || e.kind === "acw" || e.kind === "wrapup")) acc.agents[e.userId] = true;

  if (e.participantId) {
    let p = acc.participants[e.participantId];
    if (!p) {
      p = {
        participantId: e.participantId,
        purpose: e.purpose ?? PURPOSE_BY_PREFIX[e.kind.split(".")[0]] ?? "unknown",
        sessions: [],
      };
      acc.participants[e.participantId] = p;
    }
    p.userId ??= e.userId;
    p.ani ??= e.ani;
    p.dnis ??= e.dnis;

    if (isStart(e.kind) || isEnd(e.kind)) {
      const sid = e.sessionId ?? e.participantId;
      const owner = acc.participants[acc.sessionOwners[sid] ?? e.participantId];
      let s = owner.sessions.find((x) => x.sessionId === sid);
      if (!s) {
        s = { sessionId: sid };
        p.sessions.push(s);
        acc.sessionOwners[sid] = p.participantId;
      }
      s.mediaType ??= e.mediaType;
      s.direction ??= e.direction;
      s.queueId ??= e.queueId;
      if (isStart(e.kind)) s.startTime = Math.min(s.startTime ?? e.eventTime, e.eventTime);
      if (isEnd(e.kind)) {
        s.endTime = Math.max(s.endTime ?? e.eventTime, e.eventTime);
        s.disconnectType ??= e.disconnectType;
        acc.lastEnd = Math.max(acc.lastEnd ?? e.eventTime, e.eventTime);
      }
    }
  }

  if ((e.kind === "acd.start" || e.kind === "acd.end") && e.queueId) {
    const id = `${e.sessionId ?? e.participantId ?? ""}|${e.queueId}`;
    const q = acc.queues[id] ?? { queueId: e.queueId };
    if (e.kind === "acd.start") q.enteredAt = e.eventTime;
    else q.leftAt = e.eventTime;
    if (q.enteredAt !== undefined && q.leftAt !== undefined) q.waitMs = q.leftAt - q.enteredAt;
    acc.queues[id] = q;
  }

  if ((e.kind === "wrapup" || e.kind === "acw") && e.wrapupCode) {
    const id = `${e.participantId ?? e.userId ?? ""}|${e.wrapupCode}`;
    const prev = acc.wrapUps[id];
    acc.wrapUps[id] = {
      userId: e.userId ?? prev?.userId,
      participantId: e.participantId ?? prev?.participantId,
      code: e.wrapupCode,
      notes: e.wrapupNotes ?? prev?.notes,
      time: prev?.time ?? e.eventTime,
    };
  }
}

/** Folds events in event-time order on top of an optional checkpoint. */
export function fold(events: Iterable<ConversationEvent>, base?: Accumulator): Accumulator {
  const acc = base ? structuredClone(base) : createAccumulator();
  for (const e of [...events].sort(compareEvents)) accumulate(acc, e);
  return acc;
}

export function finish(acc: Accumulator): Consolidated {
  let openSessions = 0;
  for (const p of Object.values(acc.participants)) {
    for (const s of p.sessions) if (s.endTime === undefined) openSessions++;
  }
  return {
    startTime: acc.startTime ?? 0,
    endTime: acc.lastEnd ?? acc.lastEventTime ?? 0,
    mediaTypes: Object.keys(acc.mediaTypes).sort(),
    direction: acc.direction,
    participants: Object.values(acc.participants),
    agents: Object.keys(acc.agents).sort(),
    queues: Object.values(acc.queues).sort((a, b) => (a.enteredAt ?? 0) - (b.enteredAt ?? 0)),
    wrapUps: Object.values(acc.wrapUps).sort((a, b) => a.time - b.time),
    attributes: acc.attributes,
    // Stable sort: same-time entries keep fold order.
    timeline: [...acc.timeline].sort((a, b) => a.time - b.time),
    timelineDropped: acc.timelineDropped ?? 0,
    openSessions,
  };
}

/**
 * Folds a set of events into one conversation. Pure and order-independent:
 * the events are sorted first, so any arrival order yields the same result.
 */
export function consolidate(input: Iterable<ConversationEvent>, base?: Accumulator): Consolidated {
  return finish(fold(input, base));
}

/**
 * True when there is at least one session and every one has ended, looking at
 * a checkpoint plus raw events. Same answer as folding them, without the copy.
 */
export function sessionsEnded(base: Accumulator | undefined, events: Iterable<ConversationEvent> = []): boolean {
  const ended = new Map<string, boolean>();
  for (const p of Object.values(base?.participants ?? {})) {
    for (const s of p.sessions) ended.set(s.sessionId, s.endTime !== undefined);
  }
  for (const e of events) {
    if (!e.participantId || !(isStart(e.kind) || isEnd(e.kind))) continue;
    const sid = e.sessionId ?? e.participantId;
    if (isEnd(e.kind)) ended.set(sid, true);
    else if (!ended.has(sid)) ended.set(sid, false);
  }
  if (ended.size === 0) return false;
  for (const done of ended.values()) if (!done) return false;
  return true;
}

/**
 * A conversation is over when it has at least one session and every session
 * that has been seen has also reported its end.
 */
export function allSessionsEnded(events: Iterable<ConversationEvent>): boolean {
  return sessionsEnded(undefined, events);
}
