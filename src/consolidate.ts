import type {
  ConversationEvent,
  EventKind,
  Participant,
  QueueVisit,
  Session,
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
  openSessions: number;
}

/**
 * Folds a set of events into one conversation. Pure and order-independent:
 * the events are sorted first, so any arrival order yields the same result.
 */
export function consolidate(input: Iterable<ConversationEvent>): Consolidated {
  const events = [...input].sort(compareEvents);
  const participants = new Map<string, Participant>();
  const sessions = new Map<string, Session>();
  const queues = new Map<string, QueueVisit>();
  const wrapUps = new Map<string, WrapUp>();
  const mediaTypes = new Set<string>();
  const agents = new Set<string>();
  const attributes: Record<string, string> = {};
  let direction: string | undefined;
  let lastEnd: number | undefined;

  for (const e of events) {
    if (e.mediaType) mediaTypes.add(e.mediaType);
    if (!direction && e.direction) direction = e.direction;
    if (e.attributes) Object.assign(attributes, e.attributes);
    if (e.userId && (e.kind.startsWith("user.") || e.kind === "acw" || e.kind === "wrapup")) agents.add(e.userId);

    if (e.participantId) {
      let p = participants.get(e.participantId);
      if (!p) {
        p = {
          participantId: e.participantId,
          purpose: e.purpose ?? PURPOSE_BY_PREFIX[e.kind.split(".")[0]] ?? "unknown",
          sessions: [],
        };
        participants.set(e.participantId, p);
      }
      p.userId ??= e.userId;
      p.ani ??= e.ani;
      p.dnis ??= e.dnis;

      if (isStart(e.kind) || isEnd(e.kind)) {
        const sid = e.sessionId ?? e.participantId;
        let s = sessions.get(sid);
        if (!s) {
          s = { sessionId: sid };
          sessions.set(sid, s);
          p.sessions.push(s);
        }
        s.mediaType ??= e.mediaType;
        s.direction ??= e.direction;
        s.queueId ??= e.queueId;
        if (isStart(e.kind)) s.startTime = Math.min(s.startTime ?? e.eventTime, e.eventTime);
        if (isEnd(e.kind)) {
          s.endTime = Math.max(s.endTime ?? e.eventTime, e.eventTime);
          s.disconnectType ??= e.disconnectType;
          lastEnd = Math.max(lastEnd ?? e.eventTime, e.eventTime);
        }
      }
    }

    if ((e.kind === "acd.start" || e.kind === "acd.end") && e.queueId) {
      const id = `${e.sessionId ?? e.participantId ?? ""}|${e.queueId}`;
      const q = queues.get(id) ?? { queueId: e.queueId };
      if (e.kind === "acd.start") q.enteredAt = e.eventTime;
      else q.leftAt = e.eventTime;
      if (q.enteredAt !== undefined && q.leftAt !== undefined) q.waitMs = q.leftAt - q.enteredAt;
      queues.set(id, q);
    }

    if ((e.kind === "wrapup" || e.kind === "acw") && e.wrapupCode) {
      const id = `${e.participantId ?? e.userId ?? ""}|${e.wrapupCode}`;
      const prev = wrapUps.get(id);
      wrapUps.set(id, {
        userId: e.userId ?? prev?.userId,
        participantId: e.participantId ?? prev?.participantId,
        code: e.wrapupCode,
        notes: e.wrapupNotes ?? prev?.notes,
        time: prev?.time ?? e.eventTime,
      });
    }
  }

  const startTime = events.length ? events[0].eventTime : 0;
  const endTime = lastEnd ?? (events.length ? events[events.length - 1].eventTime : 0);
  let openSessions = 0;
  for (const s of sessions.values()) if (s.endTime === undefined) openSessions++;

  return {
    startTime,
    endTime,
    mediaTypes: [...mediaTypes].sort(),
    direction,
    participants: [...participants.values()],
    agents: [...agents].sort(),
    queues: [...queues.values()].sort((a, b) => (a.enteredAt ?? 0) - (b.enteredAt ?? 0)),
    wrapUps: [...wrapUps.values()].sort((a, b) => a.time - b.time),
    attributes,
    timeline: events.map((e) => ({ time: e.eventTime, kind: e.kind, participantId: e.participantId })),
    openSessions,
  };
}

/**
 * A conversation is over when it has at least one session and every session
 * that has been seen has also reported its end.
 */
export function allSessionsEnded(events: Iterable<ConversationEvent>): boolean {
  const open = new Map<string, boolean>();
  for (const e of events) {
    if (!e.participantId || !(isStart(e.kind) || isEnd(e.kind))) continue;
    const sid = e.sessionId ?? e.participantId;
    if (isEnd(e.kind)) open.set(sid, false);
    else if (!open.has(sid)) open.set(sid, true);
  }
  if (open.size === 0) return false;
  for (const isOpen of open.values()) if (isOpen) return false;
  return true;
}
