// Renders the CLI demo as an animated SVG for the README: node scripts/render-demo.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const output = execFileSync("node", ["dist/cli.js"], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "" } });
const lines = output.replace(/\n+$/, "").split("\n");

const C = { bg: "#05050B", panel: "#0B0A14", line: "#1E1B2E", star: "#F4F2EC", dust: "#8B86A0", aurora: "#6FF2C6", gold: "#F2C46D", violet: "#A98BFF" };
const FONT = 14, LH = 21, PAD = 28, TOP = 64, CHAR = 8.43;
const width = Math.ceil(Math.max(...lines.map((l) => l.length)) * CHAR + PAD * 2 + 10);
const height = TOP + (lines.length + 1) * LH + PAD;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Splits one plain line into coloured spans. */
function spans(line) {
  const rules = [
    [/^(\s*)(WHAT ARRIVES|WHAT COMES OUT)$/, (m) => [[m[1], C.dust], [m[2], C.dust, 'letter-spacing="2"']]],
    [/^(\s*….*)$/, (m) => [[m[1], C.dust]]],
    [/^(\s*)(\d\d:\d\d:\d\d)(\s+)(\S+)(\s+)(\S+)(\s*)(duplicate|out of order)?$/, (m) => [
      [m[1], C.star], [m[2], C.dust], [m[3], C.star], [m[4], C.star], [m[5], C.star], [m[6], C.star], [m[7], C.star],
      ...(m[8] ? [[m[8], m[8] === "duplicate" ? C.gold : C.violet]] : []),
    ]],
    [/^(\s*)(✓)(.*)$/, (m) => [[m[1], C.star], [m[2], C.aurora], [m[3], C.star]]],
    [/^(\s*\d+ events in, \d+ records out)(.*)$/, (m) => [[m[1], C.star], [m[2], C.dust]]],
  ];
  for (const [re, f] of rules) {
    const m = line.match(re);
    if (m) return f(m);
  }
  return [[line, C.star]];
}

const CYCLE = 16; // seconds per loop
const typed = "npm run demo";
const startOut = 1.6;
const step = 0.11;
const show = (t) => {
  const a = (t / CYCLE) * 100;
  return `0%,${a.toFixed(2)}%{opacity:0}${(a + 0.8).toFixed(2)}%,94%{opacity:1}100%{opacity:0}`;
};

let css = "";
let body = "";
lines.forEach((line, i) => {
  const t = startOut + i * step;
  css += `@keyframes l${i}{${show(t)}}.l${i}{opacity:0;animation:l${i} ${CYCLE}s linear infinite}\n`;
  const tspans = spans(line)
    .map(([text, fill, extra = ""]) => `<tspan fill="${fill}" ${extra}>${esc(text)}</tspan>`)
    .join("");
  body += `<text class="l${i}" x="${PAD}" y="${TOP + (i + 1) * LH}" xml:space="preserve">${tspans}</text>\n`;
});

// Typing the command: reveal it with a growing clip.
const typeEnd = ((1.2 / CYCLE) * 100).toFixed(2);
css += `@keyframes type{0%{width:0}2%{width:0}${typeEnd}%{width:${(typed.length + 2) * CHAR}px}94%{width:${(typed.length + 2) * CHAR}px}100%{width:0}}`;
css += `.type{animation:type ${CYCLE}s steps(${typed.length + 2}) infinite}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Terminal demo: messy events go in, clean records come out">
<style>
text{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px}
${css}
</style>
<rect width="${width}" height="${height}" rx="14" fill="${C.bg}"/>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="none" stroke="${C.line}"/>
<circle cx="24" cy="22" r="5.5" fill="#2A2638"/><circle cx="42" cy="22" r="5.5" fill="#2A2638"/><circle cx="60" cy="22" r="5.5" fill="#2A2638"/>
<text x="${width / 2}" y="26" text-anchor="middle" fill="${C.dust}" style="font-size:12px">genesys-conversation-stitcher</text>
<line x1="0" y1="42" x2="${width}" y2="42" stroke="${C.line}"/>
<clipPath id="typed"><rect class="type" x="${PAD + 2 * CHAR}" y="${TOP - LH + 4}" height="${LH}" width="0"/></clipPath>
<text x="${PAD}" y="${TOP}" xml:space="preserve"><tspan fill="${C.aurora}">$</tspan></text>
<text x="${PAD + 2 * CHAR}" y="${TOP}" fill="${C.star}" clip-path="url(#typed)">${typed}</text>
${body}
</svg>
`;
writeFileSync("docs/demo.svg", svg);
console.log(`docs/demo.svg ${width}x${height}, ${lines.length} lines, ${Math.round(svg.length / 1024)} KB`);
