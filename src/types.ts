/**
 * A notification as it arrives from the Genesys Cloud event stream
 * (event bridge, notification websocket or a queue fed by either).
 * Only `topicName` and `eventBody` are required.
 */
export interface RawNotification {
  topicName: string;
  version?: string;
  eventBody: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Kinds of conversation detail events the stitcher understands. */
export type EventKind =
  | "customer.start"
  | "customer.end"
  | "user.start"
  | "user.end"
  | "acd.start"
  | "acd.end"
  | "flow.start"
  | "flow.end"
  | "acw"
  | "wrapup"
  | "attributes"
  | "other";

/** Internal, normalized shape of a single event. */
export interface ConversationEvent {
  /** Stable fingerprint used for de-duplication. */
  key: string;
  kind: EventKind;
  conversationId: string;
  /** When the event happened in Genesys (epoch ms). */
  eventTime: number;
  participantId?: string;
  sessionId?: string;
  mediaType?: string;
  direction?: string;
  purpose?: string;
  userId?: string;
  queueId?: string;
  ani?: string;
  dnis?: string;
  disconnectType?: string;
  wrapupCode?: string;
  wrapupNotes?: string;
  attributes?: Record<string, string>;
  /** Original topic, kept for traceability. */
  topic: string;
}

export interface Session {
  sessionId: string;
  mediaType?: string;
  direction?: string;
  startTime?: number;
  endTime?: number;
  disconnectType?: string;
  queueId?: string;
}

export interface Participant {
  participantId: string;
  purpose: string;
  userId?: string;
  ani?: string;
  dnis?: string;
  sessions: Session[];
}

export interface QueueVisit {
  queueId: string;
  enteredAt?: number;
  leftAt?: number;
  /** Time spent waiting in the queue, when both ends are known. */
  waitMs?: number;
}

export interface WrapUp {
  userId?: string;
  participantId?: string;
  code: string;
  notes?: string;
  time: number;
}

export interface TimelineEntry {
  time: number;
  kind: EventKind;
  participantId?: string;
}

export type CloseReason = "ended" | "timeout" | "flushed";

/** Everything that went wrong (and was fixed) on the way in. */
export interface DeliveryReport {
  eventsReceived: number;
  eventsApplied: number;
  duplicatesDropped: number;
  outOfOrderEvents: number;
  lateEvents: number;
  /** Sessions that started but never reported an end. */
  openSessions: number;
}

/** The single, clean record emitted per conversation. */
export interface ConsolidatedConversation {
  conversationId: string;
  /** 1 for the first emission, incremented for every revision. */
  revision: number;
  closeReason: CloseReason;
  startTime: number;
  endTime: number;
  durationMs: number;
  mediaTypes: string[];
  direction?: string;
  participants: Participant[];
  agents: string[];
  queues: QueueVisit[];
  wrapUps: WrapUp[];
  attributes: Record<string, string>;
  timeline: TimelineEntry[];
  delivery: DeliveryReport;
}

export type LateEventPolicy = "drop" | "revise";

export interface StitcherOptions {
  /**
   * How long to wait after the last session ends before emitting, so that
   * after-call work, wrap-up codes and stragglers can still arrive.
   * Default: 30 s.
   */
  settleMs?: number;
  /**
   * Emit a conversation anyway if nothing has been heard for this long.
   * Default: 4 h.
   */
  idleTimeoutMs?: number;
  /**
   * What to do with events for a conversation that was already emitted.
   * "revise" emits the record again with `revision + 1`. Default: "revise".
   */
  lateEvents?: LateEventPolicy;
  /** How long emitted conversations are remembered for late events. Default: 1 h. */
  retainEmittedMs?: number;
  /**
   * Stored stitcher only: how long a delivered record may stay unconfirmed
   * (listener still running, or the function crashed) before it is delivered
   * again. Default: 60 s.
   */
  ackTimeoutMs?: number;
  /** Replace the built-in topic adapter. Return `null` to ignore a notification. */
  normalize?: (n: RawNotification) => ConversationEvent | null;
}

export type RecordListener = (record: ConsolidatedConversation) => void;
