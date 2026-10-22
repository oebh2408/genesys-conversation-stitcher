import type { ConversationEvent, EventKind, RawNotification } from "./types.js";

const TOPIC = /^v2\.detail\.events\.conversation\.([^.]+)\.(.+)$/;

const KINDS: Record<string, EventKind> = {
  "customer.start": "customer.start",
  "customer.end": "customer.end",
  "user.start": "user.start",
  "user.end": "user.end",
  "acd.start": "acd.start",
  "acd.end": "acd.end",
  "flow.start": "flow.start",
  "flow.end": "flow.end",
  acw: "acw",
  wrapup: "wrapup",
  attributes: "attributes",
};

/** Serializes with sorted keys so equal payloads always hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** cyrb53: small, fast, non-cryptographic 53-bit hash. Good enough for de-duplication keys. */
export function hash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function fingerprint(n: RawNotification): string {
  return hash(`${n.topicName}|${stableStringify(n.eventBody)}`);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function time(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val !== undefined && val !== null) out[k] = String(val);
  }
  return out;
}

/**
 * Adapter for `v2.detail.events.conversation.{id}.{kind}` topics.
 * Returns `null` for anything it cannot place in a conversation.
 */
export function normalizeDetailEvent(n: RawNotification): ConversationEvent | null {
  const match = TOPIC.exec(n.topicName);
  const body = n.eventBody ?? {};
  const conversationId = str(body.conversationId) ?? match?.[1];
  const eventTime = time(body.eventTime);
  if (!conversationId || eventTime === undefined) return null;

  return {
    key: fingerprint(n),
    kind: (match && KINDS[match[2]]) || "other",
    conversationId,
    eventTime,
    participantId: str(body.participantId),
    sessionId: str(body.sessionId),
    mediaType: str(body.mediaType),
    direction: str(body.direction),
    purpose: str(body.participantPurpose) ?? str(body.purpose),
    userId: str(body.userId),
    queueId: str(body.queueId),
    ani: str(body.ani),
    dnis: str(body.dnis),
    disconnectType: str(body.disconnectType),
    wrapupCode: str(body.wrapupCode),
    wrapupNotes: str(body.wrapupNotes),
    attributes: stringMap(body.attributes),
    topic: n.topicName,
  };
}

const SNAPSHOT_TOPIC = /^v2\.(?:conversations|users\.[^.]+\.conversations|routing\.queues\.[^.]+\.conversations)(?:\.[^.]+)?$/;

const MEDIA: Array<[field: string, mediaType: string]> = [
  ["calls", "voice"],
  ["callbacks", "callback"],
  ["chats", "chat"],
  ["emails", "email"],
  ["messages", "message"],
];

const KIND_PREFIX: Record<string, "customer" | "user" | "acd" | "flow"> = {
  customer: "customer",
  external: "customer",
  agent: "user",
  user: "user",
  acd: "acd",
  ivr: "flow",
  workflow: "flow",
};

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => !!x) : [];
}

/**
 * Adapter for conversation snapshot topics (`v2.conversations.{id}`,
 * `v2.users.{id}.conversations`, `v2.routing.queues.{id}.conversations`),
 * which carry the whole conversation on every change.
 *
 * Each snapshot is turned into the equivalent start, end, wrap-up and
 * attribute events. Their fingerprints depend only on what they describe, so
 * the same session seen in ten snapshots is applied once and the other nine
 * are dropped as duplicates.
 */
export function normalizeConversationSnapshot(n: RawNotification): ConversationEvent[] | null {
  const body = n.eventBody ?? {};
  const conversationId = str(body.id) ?? str(body.conversationId);
  if (!conversationId || !Array.isArray(body.participants)) return null;

  const out: ConversationEvent[] = [];
  const push = (e: Omit<ConversationEvent, "key" | "topic" | "conversationId">) => {
    const event = { ...e, conversationId } as ConversationEvent;
    // The topic is left out of the fingerprint: the same session seen through a
    // user topic and a queue topic is one event.
    out.push({ ...event, topic: n.topicName, key: hash(`snapshot|${stableStringify(event)}`) });
  };

  for (const p of list(body.participants)) {
    const purpose = str(p.purpose);
    const prefix = purpose && KIND_PREFIX[purpose];
    const participantId = str(p.id);
    if (!prefix || !participantId) continue;
    const who = {
      participantId,
      purpose: prefix === "user" ? "agent" : purpose,
      userId: str(p.userId) ?? str(obj(p.user)?.id),
      queueId: str(p.queueId) ?? str(obj(p.queue)?.id),
    };
    let first: number | undefined;
    let last: number | undefined;

    for (const [field, mediaType] of MEDIA) {
      for (const m of list(p[field])) {
        const session = {
          ...who,
          sessionId: str(m.id) ?? `${participantId}:${field}`,
          mediaType,
          direction: str(m.direction),
        };
        const start = time(m.connectedTime) ?? time(m.startAlertingTime) ?? time(p.startTime);
        const end = time(m.disconnectedTime);
        if (start !== undefined) {
          push({ ...session, kind: `${prefix}.start` as EventKind, eventTime: start, ani: str(p.ani), dnis: str(p.dnis) });
          first = Math.min(first ?? start, start);
        }
        if (end !== undefined) {
          push({ ...session, kind: `${prefix}.end` as EventKind, eventTime: end, disconnectType: str(m.disconnectType) });
          last = Math.max(last ?? end, end);
        }
      }
    }

    const wrapup = obj(p.wrapup);
    const code = str(wrapup?.code) ?? str(wrapup?.name);
    const wrapupTime = time(wrapup?.endTimestamp) ?? time(p.endTime) ?? last;
    if (code && wrapupTime !== undefined) {
      push({ ...who, kind: "wrapup", eventTime: wrapupTime, wrapupCode: code, wrapupNotes: str(wrapup?.notes) });
    }

    const attributes = stringMap(p.attributes);
    const attributesTime = time(p.startTime) ?? first;
    if (attributes && Object.keys(attributes).length && attributesTime !== undefined) {
      push({ ...who, kind: "attributes", eventTime: attributesTime, attributes });
    }
  }
  return out;
}

/** Default adapter: detail event topics and conversation snapshot topics. */
export function normalizeNotification(n: RawNotification): ConversationEvent | ConversationEvent[] | null {
  if (TOPIC.test(n.topicName)) return normalizeDetailEvent(n);
  if (SNAPSHOT_TOPIC.test(n.topicName)) return normalizeConversationSnapshot(n);
  return null;
}
