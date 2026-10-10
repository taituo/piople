/**
 * A harder recall benchmark for long histories. Where scripts/live-compaction.ts has 4 salient facts in 70 messages
 * (small enough that nothing needs to be forgotten), this one has 24 fine-grained facts (hex tokens, ports, thresholds,
 * owners) in 600 messages, near-duplicates that differ only in a number, and corrections that supersede an earlier
 * value, and asks for exact values. The history is delivered in bursts (BATCH messages per agent delivery), the way a
 * busy channel reaches a long-lived agent.
 *   none     whole transcript, a big window (the recall ceiling; costs the most input)
 *   pi       Pi's own automatic compaction in a modest window (linear summaries, summaries of summaries)
 *   optchat  the case memory (hierarchical summaries + ZOOM), every delivery fresh
 *   LIVE_API_KEY=... LIVE_BASE_URL=... LIVE_MODEL=openai/gpt-4.1-mini  node scripts/bench-recall.ts [none|pi|optchat ...]
 * Env: SEED (1), HISTORY (600), BATCH (10), WINDOW (24000), SUM_* (summariser; defaults to the agent), QUESTIONS (all).
 * Costs real tokens: a few dollars at gpt-4.1-mini prices for all three arms. Not part of `npm test`.
 */
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import { modelSummarizer } from "../src/harnesses/memory.ts";

const apiKey = process.env.LIVE_API_KEY ?? process.env.OPENROUTER_API_KEY;
const modelId = process.env.LIVE_MODEL;
if (!apiKey || !modelId) { console.error("set LIVE_API_KEY (or OPENROUTER_API_KEY) and LIVE_MODEL"); process.exit(2); }
const baseUrl = process.env.LIVE_BASE_URL ?? "https://openrouter.ai/api/v1";
const sumBase = process.env.SUM_BASE_URL ?? baseUrl;
const sum = { apiKey: process.env.SUM_API_KEY ?? apiKey, baseUrl: sumBase, modelId: process.env.SUM_MODEL ?? modelId, headers: sumBase.includes("opencode.ai") ? { "x-opencode-session": "piople-bench-recall" } : undefined };
const arms = (process.argv.slice(2).length ? process.argv.slice(2) : ["none", "pi", "optchat"]) as Array<"none" | "pi" | "optchat">;
const SEED = Number(process.env.SEED ?? 1), HISTORY = Number(process.env.HISTORY ?? 600), BATCH = Number(process.env.BATCH ?? 10), WINDOW = Number(process.env.WINDOW ?? 24000);

// ---- a deterministic scenario -------------------------------------------------------------------------------------
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(SEED);
const int = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");
const pick = <T,>(xs: T[]) => xs[int(0, xs.length - 1)]!;
const NAMES = ["Tuula", "Mikko", "Aino", "Eero", "Sari", "Jukka", "Liisa", "Pekka", "Noora", "Ville"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

type Fact = { id: string; text: string; question: string; answer: string; kind: string; correction?: { text: string; answer: string } };
const facts: Fact[] = [];
const used = new Set<number>();
const unique = (lo: number, hi: number) => { let n: number; do n = int(lo, hi); while (used.has(n)); used.add(n); return n; };
for (let i = 0; i < 8; i++) { const svc = unique(10, 99), tok = `${hex(4)}-${hex(4)}`; facts.push({ id: `tok${svc}`, kind: "token", text: `Heads up: the api token prefix for service-${svc} is ${tok}.`, question: `What is the api token prefix for service-${svc}?`, answer: tok }); }
for (let i = 0; i < 6; i++) { const h = unique(100, 199), port = int(20000, 59999); facts.push({ id: `port${h}`, kind: "port", text: `Note: host-${h} listens on port ${port} for the metrics endpoint.`, question: `Which port does host-${h} listen on for the metrics endpoint?`, answer: String(port) }); }
for (let i = 0; i < 5; i++) { const a = unique(200, 299), th = `${int(2, 9)}.${int(1, 9)}`; facts.push({ id: `alert${a}`, kind: "threshold", text: `Alert A-${a} fires above ${th} percent error rate.`, question: `At what error rate in percent does alert A-${a} fire?`, answer: th }); }
for (let i = 0; i < 5; i++) { const svc = unique(300, 399), who = pick(NAMES), day = pick(DAYS); facts.push({ id: `own${svc}`, kind: "owner", text: `On-call for service-${svc} is ${who}, handover every ${day}.`, question: `Who is on call for service-${svc}, and which day is the handover?`, answer: `${who}|${day}` }); }
// four of them are corrected later; the current value is the one asked for
const toCorrect = new Set([0, 9, 15, 20]);
facts.forEach((f, i) => {
  if (!toCorrect.has(i)) return;
  if (f.kind === "token") { const old = f.answer, nw = `${hex(4)}-${hex(4)}`; f.correction = { text: `Correction: the api token prefix I gave for ${f.question.match(/service-\d+/)![0]} was wrong, the right one is ${nw} (not ${old}).`, answer: nw }; }
  if (f.kind === "port") { const nw = String(int(20000, 59999)); f.correction = { text: `Correction: ${f.question.match(/host-\d+/)![0]} now listens on port ${nw} for metrics, the old port is retired.`, answer: nw }; }
  if (f.kind === "threshold") { const nw = `${int(2, 9)}.${int(1, 9)}`; f.correction = { text: `Update: ${f.question.match(/A-\d+/)![0]} threshold changed to ${nw} percent.`, answer: nw }; }
  if (f.kind === "owner") { const who = pick(NAMES.filter((n) => !f.answer.startsWith(n))), day = pick(DAYS); f.correction = { text: `Swap: ${f.question.match(/service-\d+/)![0]} on-call is now ${who}, handover every ${day}.`, answer: `${who}|${day}` }; }
});
// near-duplicate distractors: same shapes, other numbers, never asked about
const distractors: string[] = [];
for (let i = 0; i < 40; i++) {
  const k = i % 4;
  distractors.push(k === 0 ? `Heads up: the api token prefix for service-${unique(400, 499)} is ${hex(4)}-${hex(4)}.` : k === 1 ? `Note: host-${unique(500, 599)} listens on port ${int(20000, 59999)} for the metrics endpoint.` : k === 2 ? `Alert A-${unique(600, 699)} fires above ${int(2, 9)}.${int(1, 9)} percent error rate.` : `On-call for service-${unique(700, 799)} is ${pick(NAMES)}, handover every ${pick(DAYS)}.`);
}
const FILLER = ["deploy of service-%a finished, took %b s", "p95 latency on service-%a is %b ms right now", "cache hit rate looks like %b percent on node %a", "lint is red on branch feature-%a again, %b warnings", "restarted worker-%a, uptime was %b h", "disk usage on host-%a at %b percent, nothing to do yet", "retry budget for service-%a raised to %b", "dashboard %a shows %b errors per minute, within normal", "ack, will look at ticket INC-%a after lunch", "rollout %a is at %b percent, watching"];
const filler = () => pick(FILLER).replace("%a", String(int(800, 990))).replace("%b", String(int(3, 90)));

// place: facts in the first ~85% of the history, corrections later than their fact but still before the last 12%
const slots: Array<string | undefined> = Array(HISTORY).fill(undefined);
const place = (text: string, lo: number, hi: number) => { for (let tries = 0; tries < 1000; tries++) { const i = int(lo, hi); if (slots[i] === undefined) { slots[i] = text; return i; } } throw new Error("no slot"); };
const factAt = new Map<string, number>();
for (const f of facts) factAt.set(f.id, place(f.text, 2, Math.floor(HISTORY * 0.72)));
for (const f of facts) if (f.correction) place(f.correction.text, Math.max(factAt.get(f.id)! + 40, Math.floor(HISTORY * 0.55)), Math.floor(HISTORY * 0.88));
for (const d of distractors) place(d, 2, Math.floor(HISTORY * 0.9));
for (let i = 0; i < HISTORY; i++) if (slots[i] === undefined) slots[i] = filler();

const questions = facts.map((f) => ({ id: f.id, kind: f.kind, q: f.question, want: (f.correction?.answer ?? f.answer), stale: f.correction ? f.answer : undefined, corrected: !!f.correction, depth: factAt.get(f.id)! / HISTORY }));
const limit = process.env.QUESTIONS ? Number(process.env.QUESTIONS) : questions.length;
const asked = [...questions].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);

/** Exact value present, and (for corrected facts) the stale value not given as the answer. */
function score(q: (typeof questions)[number], answer: string): { ok: boolean; stale: boolean } {
  const norm = (s: string) => s.toLowerCase();
  const a = norm(answer);
  const has = (v: string) => v.split("|").every((part) => a.includes(norm(part)));
  return { ok: has(q.want) && !/don'?t (know|have)|do not (know|have)|cannot (find|tell|retrieve)|can'?t find|no (information|record)|not (in|mentioned|included)/.test(a), stale: !!q.stale && has(q.stale) && !has(q.want) };
}

/** The newest event number in a case (eventsSince returns at most a page, so count by paging). */
function lastSeq(store: Store, context: string): number {
  let after = 0;
  for (;;) { const page = store.eventsSince(context, after, 1000); if (!page.length) return after; after = page.at(-1)!.seq; }
}

async function runArm(arm: "none" | "pi" | "optchat") {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  const summarizer = arm === "optchat" ? modelSummarizer({ ...sum, maxWords: 140 }) : undefined;
  const pi = await PiHarness.open({
    actor: "agent:recall", dir: ":memory:", provider: { baseUrl, apiKey }, modelId, maxTokens: 900, maxRounds: 10,
    onReply: process.env.TRACE ? (e) => { if (e.reply !== "NOOP") console.log(`   [${e.requestId.split("#").at(-1)}] ${JSON.stringify(e.reply.slice(0, 200))}`); } : undefined,
    role: "You follow a long-running ops channel. Do not reply to ordinary chatter: reply NOOP. When a person asks you a question, answer in one short sentence with the exact value from the history. The history can contain corrections: give the CURRENT value. If your view only shows summaries, use ZOOM to read the original lines before you say you do not know. Never guess.",
    ...(arm === "optchat" ? { memory: { summarizer: summarizer!, k: 8, recent: 20, budgetTokens: 1500 } } : {}),
    ...(arm === "pi" ? { context: { contextWindow: WINDOW, compaction: { enabled: true, reserveTokens: Math.floor(WINDOW / 3), keepRecentTokens: Math.floor(WINDOW / 8), backgroundTokens: Math.floor(WINDOW / 12) } } } : {}),
  });
  const host = new Host(core);
  const errors: string[] = [];
  host.onError = (e) => errors.push(e.error instanceof Error ? e.error.message : String(e.error));
  await host.add({ actor: "agent:recall", harness: pi });
  await alice("create", { id: "c1", title: "Platform ops" });
  await alice("join", { context: "c1", actor: "agent:recall", caps: "read,write" });

  const t0 = Date.now();
  for (let i = 0; i < HISTORY; i++) {
    await alice("post", { context: "c1", text: slots[i]! });
    if ((i + 1) % BATCH === 0 || i === HISTORY - 1) { await host.settle(); if (process.env.PROGRESS) console.log(`   ${i + 1}/${HISTORY}`); }
  }
  const history = { ms: Date.now() - t0, spend: await pi.spend() };
  const compactions = await pi.compactions("c1");

  const rows: Array<{ q: (typeof questions)[number]; answer: string; ok: boolean; stale: boolean }> = [];
  for (const q of asked) {
    const before = lastSeq(store, "c1");
    await alice("post", { context: "c1", text: `agent:recall: ${q.q}` });
    await host.settle();
    // the first thing the agent said in reply: later posts may restate earlier answers
    const answer = String(store.eventsSince("c1", before, 1000).find((e) => e.actorId === "agent:recall" && e.type === "message.posted")?.data.text ?? "").replace(/\s+/g, " ").trim();
    rows.push({ q, answer, ...score(q, answer) });
  }
  const total = await pi.spend();
  const summ = summarizer ? { ...(summarizer as any).stats } : { calls: 0, input: 0, output: 0 };
  const r = { arm, compactions: arm === "pi" ? compactions : undefined, rows, history, total, summ, ms: Date.now() - t0, memoryErrors: pi.memoryErrors, hostErrors: errors.length };
  await host.close();
  store.close();
  return r;
}

console.log(`scenario: seed ${SEED}, ${HISTORY} messages in bursts of ${BATCH}, ${facts.length} facts (${facts.filter((f) => f.correction).length} corrected), ${distractors.length} near-duplicate distractors, ${asked.length} questions; agent ${modelId}`);
const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
const results = [];
for (const arm of arms) {
  console.log(`\n=== arm: ${arm} ===`);
  const r = await runArm(arm);
  for (const row of r.rows) console.log(`${row.ok ? "OK  " : "MISS"} [${row.q.kind.padEnd(9)} depth ${(row.q.depth * 100).toFixed(0).padStart(2)}%${row.q.corrected ? ", corrected" : ""}] want ${row.q.want}${row.stale ? "  (gave the STALE value)" : ""}\n       -> ${row.answer.slice(0, 160) || "(no answer)"}`);
  const ok = r.rows.filter((x) => x.ok).length;
  console.log(`${ok}/${r.rows.length} exact | Pi's books: ${k(r.total.input)} in / ${k(r.total.output)} out${r.compactions !== undefined ? `, ${r.compactions} compactions` : ""} | case-memory summariser: ${r.summ.calls} calls ${k(r.summ.input)}/${k(r.summ.output)} | ${(r.ms / 1000).toFixed(0)} s | errors: memory ${r.memoryErrors}, host ${r.hostErrors}`);
  results.push(r);
}
console.log("\n=== summary ===");
const band = (rows: typeof results[number]["rows"], f: (r: (typeof rows)[number]) => boolean) => { const s = rows.filter(f); return s.length ? `${s.filter((x) => x.ok).length}/${s.length}` : "-"; };
console.log("arm        exact   early(<1/3) mid    late(>2/3)  corrected  stale-given   all-in tokens");
for (const r of results) {
  const all = r.total.input + r.total.output + r.summ.input + r.summ.output;
  console.log(`${r.arm.padEnd(10)} ${band(r.rows, () => true).padEnd(7)} ${band(r.rows, (x) => x.q.depth < 1 / 3).padEnd(12)} ${band(r.rows, (x) => x.q.depth >= 1 / 3 && x.q.depth < 2 / 3).padEnd(6)} ${band(r.rows, (x) => x.q.depth >= 2 / 3).padEnd(11)} ${band(r.rows, (x) => x.q.corrected).padEnd(10)} ${String(r.rows.filter((x) => x.stale).length).padEnd(13)} ${k(all)}`);
}
