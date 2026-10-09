import { Store } from "../src/core/index.ts";
import { agentTurn, readBearer } from "../src/agents/loop.ts";

/**
 * V1 run: one real case, two gateway-backed agents, human decides.
 * Usage: PIO_DATA=./data/v2.sqlite node scripts/run-v1.ts
 */
const DATA = process.env.PIO_DATA ?? "./data/v1.sqlite";
const BASE = process.env.PIO_GATEWAY ?? "http://10.91.1.1:8788/v1";
const MODEL = process.env.PIO_MODEL ?? "deepseek-v4-flash";

const s = new Store(DATA);
const bearer = readBearer();
const now = Date.now();

for (const a of ["human:alice", "agent:scout", "agent:builder"]) {
  s.upsertActor({ id: a, kind: a.startsWith("human:") ? "human" : "agent", name: a });
}
const ctxId = "case-checkout-2";
try {
  s.createContext({ id: ctxId, kind: "case", title: "Checkout API kaatuu restartissa", goal: "Selvitä miksi checkout-api kaatuu uudelleenkäynnistyksessä, ehdota korjausta ja kerro mitä testasit. Älä keksi lokidataa.", createdAt: now }, "human:alice");
} catch { /* exists: continue */ }
for (const [actor, caps] of [["agent:scout", ["read", "write"]], ["agent:builder", ["read", "write"]], ["human:alice", ["read", "write", "decide"]]] as const) {
  s.join({ contextId: ctxId, actorId: actor, capabilities: [...caps], joinedAt: Date.now() }, `join:${actor}:v1`);
}
s.postMessage(ctxId, "human:alice", `kickoff:${now}`, "Auttakaa tässä: checkout-api kaatuu aina restartin jälkeen. Selvittäkää syy ja ehdottakaa korjaus.");

const agents = [
  { actorId: "agent:scout", system: "Olet scout: tutkit havaintoja, epäilet oletuksia, pyydät tarkennuksia." },
  { actorId: "agent:builder", system: "Olet builder: ehdotat konkreettista korjausta ja kerrot miten se testataan." },
];
let totalIn = 0, totalOut = 0;
for (let round = 0; round < 3; round++) {
  for (const a of agents) {
    const r = await agentTurn(s, { ...a, contextId: ctxId, model: MODEL, baseUrl: BASE, bearer, maxTokens: 400 });
    const u = r.usage as { prompt_tokens?: number; completion_tokens?: number };
    totalIn += u.prompt_tokens ?? 0;
    totalOut += u.completion_tokens ?? 0;
    console.log(`--- ${a.actorId} [${r.kind} tools=${r.toolCalls}] tokens=${u.prompt_tokens}+${u.completion_tokens}\n${r.text.slice(0, 500)}\n`);
  }
}
s.requestDecision({ id: `d-v1-${now}`, contextId: ctxId, question: "Hyväksytäänkö agenttien ehdotus jatkoselvitykseen?", options: ["yes", "no"], requestedBy: "agent:builder", decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
console.log(`TOTAL tokens in=${totalIn} out=${totalOut}`);
console.log(`Events: ${s.eventsSince(ctxId, 0, 1000).length}. Human: resolve with resolveDecision().`);
s.close();
