#!/usr/bin/env node
import { ConversationStitcher } from "./stitcher.js";
import { replay, simulate } from "./simulator.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

const conversations = arg("conversations", 25);
const seed = arg("seed", 7);
const straggleRate = arg("straggle", 0.02);
const json = process.argv.includes("--json");

const { deliveries, truth } = simulate({ conversations, seed, straggleRate });
const stitcher = new ConversationStitcher({ settleMs: 30_000 });
const records = replay(stitcher, deliveries);

const latest = new Map(records.map((r) => [r.conversationId, r]));
const raw = truth.reduce((n, t) => n + t.eventCount, 0);
const dupes = deliveries.length - raw;
const sum = (f: (r: (typeof records)[number]) => number) => [...latest.values()].reduce((n, r) => n + f(r), 0);

let mismatches = 0;
for (const t of truth) {
  const r = latest.get(t.conversationId);
  const ok =
    r &&
    r.startTime === t.startTime &&
    r.endTime === t.endTime &&
    r.agents.join() === t.agents.join() &&
    r.queues.map((q) => q.queueId).join() === t.queues.join() &&
    r.wrapUps.map((w) => w.code).join() === t.wrapUpCodes.join();
  if (!ok) mismatches++;
}

if (json) {
  process.stdout.write(JSON.stringify([...latest.values()], null, 2) + "\n");
  process.exit(mismatches ? 1 : 0);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const ok = (s: string) => `\x1b[38;2;111;242;198m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[38;2;242;196;109m${s}\x1b[0m`;

console.log(`
  ${dim("in")}   ${deliveries.length} events for ${truth.length} conversations
       ${warn(String(dupes))} duplicates, ${warn(String(sum((r) => r.delivery.outOfOrderEvents)))} out of order, ${warn(String(sum((r) => r.delivery.lateEvents)))} after emission

  ${dim("out")}  ${latest.size} clean records ${dim(`(${records.length - latest.size} revisions)`)}
       ${mismatches === 0 ? ok("✓ every record matches what actually happened") : warn(`✗ ${mismatches} records differ from ground truth`)}
`);

const sample = [...latest.values()].find((r) => r.queues.length > 1) ?? records[0];
console.log(dim("  sample record:\n"));
console.log(
  JSON.stringify({ ...sample, timeline: `[${sample.timeline.length} entries]`, participants: `[${sample.participants.length} participants]` }, null, 2)
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n"),
);
process.exit(mismatches ? 1 : 0);
