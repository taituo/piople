/**
 * Live run: Pi's own compaction against the case memory (OptChat), on the same long history, fed the way a long-lived
 * agent sees it: one message at a time, an agent step for each, then five questions about facts buried in it.
 *   none    no memory, a big window: the whole transcript stays (the recall ceiling, and the cost to beat)
 *   pi      no memory; Pi's own compaction (one linear summary of the older part, newest ~1200 tokens kept) run once, by hand,
 *           after the history (a tiny window to force it automatically starves Pi's output budget, measured)
 *   optchat memory (hierarchical summaries + ZOOM), every delivery fresh
 *   LIVE_API_KEY=... LIVE_BASE_URL=... LIVE_MODEL=glm-5.3-flash \
 *   SUM_API_KEY=... SUM_BASE_URL=... SUM_MODEL=openai/gpt-4.1-mini  node scripts/live-compaction.ts [none|pi|optchat ...]
 * Costs real tokens (cents to a euro). Not part of `npm test`. Spend is read from Pi's own accounting, so Pi's
 * compaction calls are counted; the case memory's summariser is counted from its own responses.
 */
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import { modelSummarizer } from "../src/harnesses/memory.ts";
import { PLANT, QUESTIONS_ALL, filler, isCorrect } from "./scenario.ts";

const apiKey = process.env.LIVE_API_KEY ?? process.env.OPENROUTER_API_KEY;
const modelId = process.env.LIVE_MODEL;
if (!apiKey || !modelId) { console.error("set LIVE_API_KEY (or OPENROUTER_API_KEY) and LIVE_MODEL"); process.exit(2); }
const baseUrl = process.env.LIVE_BASE_URL ?? "https://openrouter.ai/api/v1";
const sumBase = process.env.SUM_BASE_URL ?? baseUrl;
const sum = { apiKey: process.env.SUM_API_KEY ?? apiKey, baseUrl: sumBase, modelId: process.env.SUM_MODEL ?? modelId, headers: sumBase.includes("opencode.ai") ? { "x-opencode-session": "piople-live-compaction" } : undefined };
const arms = (process.argv.slice(2).length ? process.argv.slice(2) : ["none", "pi", "optchat"]) as Array<"none" | "pi" | "optchat">;
const HISTORY = Number(process.env.LIVE_HISTORY ?? 70);

async function runArm(arm: "none" | "pi" | "optchat") {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  const summarizer = arm === "optchat" ? modelSummarizer({ ...sum, maxWords: 90 }) : undefined;
  const pi = await PiHarness.open({
    actor: "agent:recall", dir: ":memory:", onReply: process.env.LIVE_TRACE ? (e) => console.log(`   [${e.requestId.split("#").at(-1)}] prompt=${e.prompt.length}ch reply=${JSON.stringify(e.reply.slice(0, 140))}`) : undefined, provider: { baseUrl, apiKey }, modelId, maxTokens: 900, maxRounds: 8,
    role: "You follow a long-running case. Read what is new. Do not reply to ordinary chatter: reply NOOP. When a person asks you a question, answer it in one short sentence using the case history (use ZOOM if you have it). If you do not know, say so; never guess.",
    ...(arm === "optchat" ? { memory: { summarizer: summarizer!, k: 6, recent: 10, budgetTokens: 1200 } } : {}),
    ...(arm === "pi" ? { context: { compaction: { keepRecentTokens: Number(process.env.PI_KEEP ?? 1200) } } } : {}), // a normal window: compaction is triggered once, by hand, below
  });
  const host = new Host(core);
  const errors: string[] = [];
  host.onError = (e) => errors.push(e.error instanceof Error ? e.error.message : String(e.error));
  await host.add({ actor: "agent:recall", harness: pi });
  await alice("create", { id: "c1", title: "Platform ops" });
  await alice("join", { context: "c1", actor: "agent:recall", caps: "read,write" });

  const t0 = Date.now();
  for (let i = 1; i <= HISTORY; i++) {
    await alice("post", { context: "c1", text: PLANT[i] ?? filler(i) });
    if (i === 28) await alice("decision-request", { context: "c1", id: "d-redis", question: "Move the session cache to Redis?" });
    if (i === 30) await alice("decide", { context: "c1", decision: "d-redis", answer: "no" });
    await host.settle(); // one delivery per message
  }
  let compaction = "";
  if (arm === "pi") compaction = await pi.compact("c1");
  const history = { ms: Date.now() - t0, spend: await pi.spend(), summ: summarizer ? { ...(summarizer as any).stats } : { calls: 0, input: 0, output: 0 } };

  const rows: Array<{ q: string; where: string; ok: boolean; answer: string }> = [];
  for (const { q, ok, where } of QUESTIONS_ALL) {
    const before = store.eventsSince("c1", 0).length;
    await alice("post", { context: "c1", text: `agent:recall: ${q}` });
    await host.settle();
    const answer = store.eventsSince("c1", before).filter((e) => e.actorId === "agent:recall" && e.type === "message.posted").map((e) => String(e.data.text)).join(" ").replace(/\s+/g, " ").trim();
    rows.push({ q, where, ok: isCorrect(answer, ok), answer });
  }
  const total = await pi.spend();
  const summ = summarizer ? { ...(summarizer as any).stats } : { calls: 0, input: 0, output: 0 };
  const r = { arm, compaction, correct: rows.filter((x) => x.ok).length, total: rows.length, rows, history, totalSpend: total, summ, ms: Date.now() - t0, memoryErrors: pi.memoryErrors, hostErrors: errors.length };
  await host.close();
  store.close();
  return r;
}

const results = [];
for (const arm of arms) {
  console.log(`\n=== arm: ${arm} (${HISTORY} messages, then ${QUESTIONS_ALL.length} questions) ===`);
  const r = await runArm(arm);
  for (const row of r.rows) console.log(`${row.ok ? "OK  " : "MISS"} [${row.where.padEnd(8)}] ${row.q}\n       -> ${row.answer.slice(0, 180) || "(no answer)"}`);
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  console.log(`${r.arm === "pi" ? `(Pi compaction: ${(r as any).compaction}) ` : ""}${r.correct}/${r.total} correct | agent+compaction (Pi's books): ${r.totalSpend.calls} own calls, ${k(r.totalSpend.input)} in / ${k(r.totalSpend.output)} out | case-memory summariser: ${r.summ.calls} calls, ${k(r.summ.input)} in / ${k(r.summ.output)} out | history phase ${(r.history.ms / 1000).toFixed(0)} s, total ${(r.ms / 1000).toFixed(0)} s | errors: memory ${r.memoryErrors}, host ${r.hostErrors}`);
  results.push(r);
}
console.log("\n=== summary ===");
console.log("arm        correct   Pi in/out        summariser in/out   all-in tokens");
for (const r of results) {
  const all = r.totalSpend.input + r.totalSpend.output + r.summ.input + r.summ.output;
  console.log(`${r.arm.padEnd(10)} ${`${r.correct}/${r.total}`.padEnd(9)} ${`${(r.totalSpend.input / 1000).toFixed(1)}k/${(r.totalSpend.output / 1000).toFixed(1)}k`.padEnd(16)} ${`${(r.summ.input / 1000).toFixed(1)}k/${(r.summ.output / 1000).toFixed(1)}k`.padEnd(19)} ${(all / 1000).toFixed(1)}k`);
}
