import type { ConsolidatedConversation, RawNotification } from "./types.js";
import type { ConversationStitcher } from "./stitcher.js";
import type { StoredConversationStitcher } from "./stored-stitcher.js";

/**
 * Generates realistic conversation event streams, then damages them the way a
 * real event stream does: duplicates, reordering, latency and stragglers.
 * No Genesys Cloud account needed.
 */

export type Scenario = "answered" | "transferred" | "abandoned" | "chat";

export interface SimulationOptions {
  /** How many conversations to generate. Default 20. */
  conversations?: number;
  /** Seed for the pseudo-random generator; same seed, same stream. Default 42. */
  seed?: number;
  /** Simulated start time (epoch ms). Default 2026-01-01T09:00:00Z. */
  startTime?: number;
  /** Mix of scenarios to draw from. Default: all of them. */
  scenarios?: Scenario[];
  /** Probability that an event is delivered twice. Default 0.15. */
  duplicateRate?: number;
  /** Probability that an event is held back and arrives out of order. Default 0.2. */
  reorderRate?: number;
  /** Maximum extra delay for a held-back event. Default 8 s. */
  reorderWindowMs?: number;
  /** Probability that an event arrives very late (after the settle window). Default 0. */
  straggleRate?: number;
  /** Delay for straggling events. Default 2 min. */
  straggleMs?: number;
  /**
   * "detail": one small event per change (default).
   * "snapshot": the whole conversation on every change, as conversation topics deliver it.
   */
  format?: "detail" | "snapshot";
}

export interface Delivery {
  /** Simulated wall-clock time at which the event reaches the consumer. */
  at: number;
  notification: RawNotification;
}

/** What actually happened, so the stitched output can be checked against it. */
export interface GroundTruth {
  conversationId: string;
  scenario: Scenario;
  mediaType: string;
  startTime: number;
  endTime: number;
  agents: string[];
  queues: string[];
  wrapUpCodes: string[];
  eventCount: number;
}

export interface Simulation {
  deliveries: Delivery[];
  truth: GroundTruth[];
}

/** mulberry32: tiny seeded PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QUEUES = ["sales", "support", "billing", "retention"];
const AGENTS = ["agent-ana", "agent-bruno", "agent-carla", "agent-diego", "agent-elena", "agent-felipe"];
const WRAPUPS = ["resolved", "follow-up", "sale", "escalated", "info-only"];

export function simulate(options: SimulationOptions = {}): Simulation {
  const seed = options.seed ?? 42;
  // Separate generators: changing the noise settings never changes the conversations themselves.
  const rand = prng(seed);
  const noise = prng(seed ^ 0x9e3779b9);
  const count = options.conversations ?? 20;
  const scenarios = options.scenarios ?? ["answered", "transferred", "abandoned", "chat"];
  const duplicateRate = options.duplicateRate ?? 0.15;
  const reorderRate = options.reorderRate ?? 0.2;
  const reorderWindowMs = options.reorderWindowMs ?? 8000;
  const straggleRate = options.straggleRate ?? 0;
  const straggleMs = options.straggleMs ?? 120_000;

  const int = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const id = (prefix: string) => `${prefix}-${Math.floor(rand() * 0xffffffff).toString(16).padStart(8, "0")}`;

  const deliveries: Delivery[] = [];
  const truth: GroundTruth[] = [];
  let clock = options.startTime ?? Date.UTC(2026, 0, 1, 9, 0, 0);

  for (let i = 0; i < count; i++) {
    clock += int(2_000, 45_000);
    const scenario = pick(scenarios);
    const conversationId = id("conv");
    const mediaType = scenario === "chat" ? "message" : "voice";
    const direction = "inbound";
    const ani = `tel:+1555010${String(int(0, 999)).padStart(3, "0")}`;
    const dnis = "tel:+15550199000";
    const events: RawNotification[] = [];
    const agents: string[] = [];
    const queues: string[] = [];
    const wrapUpCodes: string[] = [];
    let t = clock;

    const emit = (kind: string, body: Record<string, unknown>) =>
      events.push({
        topicName: `v2.detail.events.conversation.${conversationId}.${kind}`,
        version: "1",
        eventBody: { eventTime: t, conversationId, mediaType, direction, ...body },
      });

    const customer = { participantId: id("p"), sessionId: id("s") };
    emit("customer.start", { ...customer, participantPurpose: "customer", ani, dnis });

    if (mediaType === "voice") {
      const ivr = { participantId: id("p"), sessionId: id("s") };
      emit("flow.start", { ...ivr, participantPurpose: "ivr" });
      t += int(5_000, 40_000);
      emit("flow.end", { ...ivr, disconnectType: "transfer" });
    }

    const enterQueue = () => {
      const queueId = pick(QUEUES.filter((q) => !queues.includes(q)));
      queues.push(queueId);
      const acd = { participantId: id("p"), sessionId: id("s"), queueId };
      t += 200;
      emit("acd.start", { ...acd, participantPurpose: "acd" });
      return acd;
    };

    const serve = (acd: { participantId: string; sessionId: string; queueId: string }) => {
      const userId = pick(AGENTS.filter((a) => !agents.includes(a)));
      agents.push(userId);
      t += int(4_000, 90_000);
      emit("acd.end", { ...acd, disconnectType: "transfer" });
      const agent = { participantId: id("p"), sessionId: id("s"), userId, queueId: acd.queueId };
      t += 300;
      emit("user.start", { ...agent, participantPurpose: "agent" });
      return agent;
    };

    const finish = (agent: { participantId: string; sessionId: string; userId: string }, by: string) => {
      emit("user.end", { ...agent, disconnectType: by });
      const code = pick(WRAPUPS);
      wrapUpCodes.push(code);
      t += int(3_000, 15_000);
      emit("acw", { ...agent, wrapupCode: code });
      emit("wrapup", { ...agent, wrapupCode: code, wrapupNotes: `notes for ${code}` });
    };

    const acd = enterQueue();
    let endTime: number;

    if (scenario === "abandoned") {
      t += int(10_000, 120_000);
      endTime = t;
      emit("customer.end", { ...customer, disconnectType: "client" });
      emit("acd.end", { ...acd, disconnectType: "client" });
    } else {
      let agent = serve(acd);
      if (scenario === "transferred") {
        t += int(30_000, 240_000);
        const second = enterQueue();
        finish(agent, "transfer");
        agent = serve(second);
      }
      t += int(30_000, 400_000);
      endTime = t;
      emit("customer.end", { ...customer, disconnectType: "client" });
      emit("attributes", { attributes: { survey: pick(["yes", "no"]), channel: mediaType } });
      finish(agent, "peer");
    }

    truth.push({
      conversationId,
      scenario,
      mediaType,
      startTime: clock,
      endTime,
      agents: [...agents].sort(),
      queues,
      wrapUpCodes,
      eventCount: events.length,
    });

    const stream = options.format === "snapshot" ? toSnapshots(conversationId, events) : events;
    for (const [i, notification] of stream.entries()) {
      // Snapshots are built one per detail event, so the times line up.
      const happened = events[i].eventBody.eventTime as number;
      const jitter = (min: number, max: number) => Math.floor(min + noise() * (max - min + 1));
      let at = happened + jitter(40, 600);
      if (noise() < reorderRate) at += jitter(500, reorderWindowMs);
      if (noise() < straggleRate) at += straggleMs;
      deliveries.push({ at, notification });
      if (noise() < duplicateRate) {
        deliveries.push({ at: at + jitter(10, 5_000), notification: structuredClone(notification) });
      }
    }
  }

  deliveries.sort((a, b) => a.at - b.at);
  return { deliveries, truth };
}

export interface ReplayOptions {
  /** How often the simulated clock calls `tick()`. Default 1 s. */
  tickEveryMs?: number;
  /** Keep ticking this long after the last delivery. Default 10 min. */
  drainMs?: number;
}

/**
 * Feeds deliveries into a stitcher on a simulated clock and returns everything
 * it emitted, in emission order.
 */
export function replay(
  stitcher: ConversationStitcher,
  deliveries: readonly Delivery[],
  options: ReplayOptions = {},
): ConsolidatedConversation[] {
  const step = options.tickEveryMs ?? 1000;
  const drain = options.drainMs ?? 10 * 60_000;
  const out: ConsolidatedConversation[] = [];
  if (deliveries.length === 0) return out;

  let now = deliveries[0].at;
  for (const d of deliveries) {
    while (now + step <= d.at) {
      now += step;
      out.push(...stitcher.tick(now));
    }
    stitcher.ingest(d.notification, d.at);
  }
  const end = deliveries[deliveries.length - 1].at + drain;
  while (now < end) {
    now += step;
    out.push(...stitcher.tick(now));
  }
  return out;
}

/**
 * Like {@link replay}, for a {@link StoredConversationStitcher}. Deliveries
 * that fall within the same tick are ingested as parallel calls, the way
 * concurrent function invocations would hit the store.
 */
export async function replayStored(
  stitcher: StoredConversationStitcher,
  deliveries: readonly Delivery[],
  options: ReplayOptions = {},
): Promise<ConsolidatedConversation[]> {
  const step = options.tickEveryMs ?? 1000;
  const drain = options.drainMs ?? 10 * 60_000;
  const out: ConsolidatedConversation[] = [];
  if (deliveries.length === 0) return out;

  let now = deliveries[0].at;
  let i = 0;
  const end = deliveries[deliveries.length - 1].at + drain;
  while (now < end) {
    const batch: Delivery[] = [];
    while (i < deliveries.length && deliveries[i].at <= now) batch.push(deliveries[i++]);
    await Promise.all(batch.map((d) => stitcher.ingest(d.notification, d.at)));
    out.push(...(await stitcher.tick(now, Infinity)));
    now += step;
  }
  return out;
}

const MEDIA_FIELD: Record<string, string> = { voice: "calls", message: "messages" };

/** Replays detail events into the sequence of full snapshots a conversation topic would send. */
function toSnapshots(conversationId: string, events: RawNotification[]): RawNotification[] {
  const iso = (t: number) => new Date(t).toISOString();
  const participants = new Map<string, Record<string, any>>();
  const out: RawNotification[] = [];

  for (const { topicName, eventBody: b } of events) {
    const kind = topicName.slice(topicName.indexOf(conversationId) + conversationId.length + 1);
    const t = b.eventTime as number;
    if (kind === "attributes") {
      const customer = [...participants.values()].find((p) => p.purpose === "customer");
      if (customer) customer.attributes = { ...customer.attributes, ...(b.attributes as object) };
    } else if (b.participantId) {
      const id = b.participantId as string;
      const p = participants.get(id) ?? { id, purpose: b.participantPurpose, userId: b.userId, queueId: b.queueId };
      participants.set(id, p);
      if (b.ani) p.ani = b.ani;
      if (b.dnis) p.dnis = b.dnis;
      const field = MEDIA_FIELD[b.mediaType as string];
      p[field] ??= [];
      let media = p[field].find((m: any) => m.id === b.sessionId);
      if (!media && kind.endsWith(".start")) {
        media = { id: b.sessionId, direction: b.direction, state: "connected", connectedTime: iso(t) };
        p[field].push(media);
      }
      if (media && kind.endsWith(".end")) {
        Object.assign(media, { state: "disconnected", disconnectedTime: iso(t), disconnectType: b.disconnectType });
      }
      if (kind === "wrapup") p.wrapup = { code: b.wrapupCode, notes: b.wrapupNotes, endTimestamp: iso(t) };
    }
    out.push({
      topicName: `v2.conversations.${conversationId}`,
      version: "2",
      eventBody: { id: conversationId, participants: structuredClone([...participants.values()]) },
    });
  }
  return out;
}
