#!/usr/bin/env node
import { ConversationStitcher } from "./stitcher.js";
import { normalizeDetailEvent } from "./normalize.js";
import { replay, simulate } from "./simulator.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

const conversations = arg("conversations", 25);
const seed = arg("seed", 19);
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

const color = process.stdout.isTTY || process.env.FORCE_COLOR ? true : false;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const ok = paint("38;2;111;242;198");
const warn = paint("38;2;242;196;109");
const violet = paint("38;2;169;139;255");
const clock = (t: number) => new Date(t).toISOString().slice(11, 19);

// A taste of what arrives: the first deliveries, tagged with what is wrong with them.
const seen = new Set<string>();
const newest = new Map<string, number>();
console.log(`\n  ${dim("WHAT ARRIVES")}\n`);
for (const { at, notification } of deliveries.slice(0, 9)) {
  const e = normalizeDetailEvent(notification)!;
  let tag = "";
  if (seen.has(e.key)) tag = warn("duplicate");
  else if (e.eventTime < (newest.get(e.conversationId) ?? -Infinity)) tag = violet("out of order");
  seen.add(e.key);
  newest.set(e.conversationId, Math.max(newest.get(e.conversationId) ?? 0, e.eventTime));
  console.log(`  ${dim(clock(at))}  ${e.conversationId}  ${e.kind.padEnd(15)} ${tag}`);
}
console.log(dim(`  … ${deliveries.length - 9} more`));

console.log(`\n  ${dim("WHAT COMES OUT")}\n`);
const minutes = (ms: number) => `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
for (const r of [...latest.values()].slice(0, 6)) {
  const path = r.queues.length ? r.queues.map((q) => q.queueId).join(" → ") : "—";
  const wraps = r.wrapUps.map((w) => w.code).join(", ") || "abandoned";
  console.log(`  ${ok("✓")} ${r.conversationId}  ${r.mediaTypes.join("").padEnd(7)} ${minutes(r.durationMs).padStart(7)}  ${path.padEnd(22)} ${wraps}`);
}
console.log(dim(`  … ${latest.size - 6} more`));

console.log(`
  ${deliveries.length} events in, ${latest.size} records out ${dim(`(${dupes} duplicates, ${sum((r) => r.delivery.outOfOrderEvents)} out of order, ${records.length - latest.size} ${records.length - latest.size === 1 ? "revision" : "revisions"})`)}
  ${mismatches === 0 ? ok("✓ every record matches what actually happened") : warn(`✗ ${mismatches} records differ from what happened`)}
`);
process.exit(mismatches ? 1 : 0);
