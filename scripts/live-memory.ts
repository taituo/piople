/**
 * Live run: does the case memory (summaries + ZOOM) let a real agent recall facts buried in a long history?
 * Five facts are planted at different depths of a 70-message case, one of them a human decision. The agent is then
 * asked about each, one question at a time. Three arms: no memory (the agent only ever saw the newest events), memory
 * with an offline summariser that loses detail (so ZOOM is the only way back), memory with a real model summariser.
 *   LIVE_API_KEY=... LIVE_BASE_URL=https://opencode.ai/zen/go/v1 LIVE_MODEL=deepseek-v4-flash \
 *   SUM_API_KEY=... SUM_BASE_URL=https://openrouter.ai/api/v1 SUM_MODEL=openai/gpt-4.1-mini \
 *   node scripts/live-memory.ts [none|extractive|model ...]
 * Costs real tokens (cents). Not part of `npm test`. The summariser defaults to the agent's own endpoint and model.
 */
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import { extractiveSummarizer, modelSummarizer, type Summarizer } from "../src/harnesses/memory.ts";

const apiKey = process.env.LIVE_API_KEY ?? process.env.OPENROUTER_API_KEY;
const modelId = process.env.LIVE_MODEL;
if (!apiKey || !modelId) { console.error("set LIVE_API_KEY (or OPENROUTER_API_KEY) and LIVE_MODEL"); process.exit(2); }
const baseUrl = process.env.LIVE_BASE_URL ?? "https://openrouter.ai/api/v1";
const sum = {
  apiKey: process.env.SUM_API_KEY ?? apiKey, baseUrl: process.env.SUM_BASE_URL ?? baseUrl, modelId: process.env.SUM_MODEL ?? modelId,
  headers: (process.env.SUM_BASE_URL ?? baseUrl).includes("opencode.ai") ? { "x-opencode-session": "piople-live-memory" } : undefined,
};
const arms = (process.argv.slice(2).length ? process.argv.slice(2) : ["none", "extractive", "model"]) as Array<"none" | "extractive" | "model">;

import { PLANT, QUESTIONS_ALL, filler, isCorrect } from "./scenario.ts";


const QUESTIONS = process.env.LIVE_Q ? QUESTIONS_ALL.slice(0, Number(process.env.LIVE_Q)) : QUESTIONS_ALL;
const summarizerFor = (arm: string): Summarizer | undefined =>
  arm === "extractive" ? extractiveSummarizer({ perLine: 60 }) : arm === "model" ? modelSummarizer({ baseUrl: sum.baseUrl, apiKey: sum.apiKey, modelId: sum.modelId, headers: sum.headers, maxWords: 90 }) : undefined;

async function runArm(arm: "none" | "extractive" | "model") {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  const summarizer = summarizerFor(arm);
  const pi = await PiHarness.open({
    actor: "agent:recall", dir: ":memory:", onReply: process.env.LIVE_TRACE ? (e) => console.log(`   [reply ${e.requestId.split("#").at(-1)}] ${e.reply.replace(/\n/g, " ⏎ ").slice(0, 260)}`) : undefined, provider: { baseUrl, apiKey }, modelId, maxTokens: 900, maxRounds: 8,
    role: "You answer questions about this case using its history. Answer in one short sentence. If your view only shows summaries, use ZOOM to read the original lines before you say you do not know. Never guess.",
    ...(summarizer ? { memory: { summarizer, k: 6, recent: 10, budgetTokens: 1200 } } : {}),
  });
  const host = new Host(core);
  const errors: string[] = [];
  host.onError = (e) => errors.push(e.error instanceof Error ? e.error.message : String(e.error));
  await host.add({ actor: "agent:recall", harness: pi });
  await alice("create", { id: "c1", title: "Platform ops" });
  await alice("join", { context: "c1", actor: "agent:recall", caps: "read,write" });
  // history: 70 messages, four facts planted, one decision asked and resolved
  for (let i = 1; i <= 70; i++) {
    await alice("post", { context: "c1", text: PLANT[i] ?? filler(i) });
    if (i === 28) await alice("decision-request", { context: "c1", id: "d-redis", question: "Move the session cache to Redis?" });
    if (i === 30) await alice("decide", { context: "c1", decision: "d-redis", answer: "no" });
  }
  const t0 = Date.now();
  await alice("post", { context: "c1", text: "Please stand by: I will ask a few questions about the history of this case." });
  await host.settle(); // the agent reads (and, with memory, files away) the whole history here
  const prime = { ms: Date.now() - t0, calls: pi.usage.calls };
  const rows: Array<{ q: string; where: string; ok: boolean; answer: string }> = [];
  for (const { q, ok, where } of QUESTIONS) {
    const before = store.eventsSince("c1", 0).length;
    await alice("post", { context: "c1", text: `agent:recall: ${q}` });
    await host.settle();
    const answer = store.eventsSince("c1", before).filter((e) => e.actorId === "agent:recall" && e.type === "message.posted").map((e) => String(e.data.text)).join(" ").replace(/\s+/g, " ").trim();
    rows.push({ q, where, ok: isCorrect(answer, ok), answer });
  }
  const result = { arm, correct: rows.filter((r) => r.ok).length, total: rows.length, rows, usage: { ...pi.usage }, primeMs: prime.ms, totalMs: Date.now() - t0, memoryErrors: pi.memoryErrors, hostErrors: errors.length };
  await host.close();
  store.close();
  return result;
}

const results = [];
for (const arm of arms) {
  console.log(`\n=== arm: ${arm} ===`);
  const r = await runArm(arm);
  for (const row of r.rows) console.log(`${row.ok ? "OK  " : "MISS"} [${row.where.padEnd(8)}] ${row.q}\n       -> ${row.answer.slice(0, 200) || "(no answer)"}`);
  console.log(`${r.correct}/${r.total} correct; ${r.usage.calls} model calls, ${r.usage.input} in / ${r.usage.output} out tokens; ${(r.totalMs / 1000).toFixed(0)} s; memory errors ${r.memoryErrors}, host errors ${r.hostErrors}`);
  results.push(r);
}
console.log("\n=== summary ===");
for (const r of results) console.log(`${r.arm.padEnd(11)} ${r.correct}/${r.total}   agent tokens in/out ${r.usage.input}/${r.usage.output}   ${(r.totalMs / 1000).toFixed(0)} s`);
