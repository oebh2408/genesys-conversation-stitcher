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
 * Default adapter for `v2.detail.events.conversation.{id}.{kind}` topics.
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
