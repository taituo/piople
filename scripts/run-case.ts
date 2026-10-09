import { Store } from "../src/core/index.ts";
import { agentTurn, readBearer, fullSystem } from "../src/agents/loop.ts";
import { createGateway } from "../src/agents/pi-provider.ts";
import { openDurable, ensureConv } from "../src/agents/durable.ts";

/**
 * Unified case runner (replaces run-v1.ts / run-v2.ts).
 * Usage:
 *   node scripts/run-case.ts --db ./data/case.sqlite --case case-checkout-2 \
 *     --rounds 3 --model deepseek-v4-flash [--kickoff "..."] [--title "..."] [--goal "..."]
 * No model calls are made outside the rounds below; all usage is logged.
 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const DATA = arg("db", "./data/case.sqlite");
const CTX = arg("case", "case-checkout-2");
const ROUNDS = Number(arg("rounds", "3"));
const MODEL = arg("model", process.env.PIO_MODEL ?? "deepseek-v4-flash");
const BASE = process.env.PIO_GATEWAY ?? "http://10.91.1.1:8788/v1";
const TITLE = arg("title", "Checkout API kaatuu restartissa");
const GOAL = arg("goal", "Selvitä miksi checkout-api kaatuu uudelleenkäynnistyksessä, ehdota korjausta ja kerro mitä testasit. Älä keksi lokidataa.");
const KICKOFF = arg("kickoff", "Auttakaa tässä: checkout-api kaatuu aina restartin jälkeen. Selvittäkää syy ja ehdottakaa korjaus.");

const s = new Store(DATA);
const bearer = readBearer();
const now = Date.now();
const runId = `run-${now}`;
s.startRun(runId, CTX, MODEL, ROUNDS);

const agents = [
  { actorId: arg("a1", "agent:scout"), system: arg("s1", "Olet scout: tutkit havaintoja, epäilet oletuksia, pyydät tarkennuksia.") },
  { actorId: arg("a2", "agent:builder"), system: arg("s2", "Olet builder: ehdotat konkreettista korjausta ja kerrot miten se testataan.") },
];
for (const a of ["human:alice", agents[0]!.actorId, agents[1]!.actorId]) {
  s.upsertActor({ id: a, kind: a.startsWith("human:") ? "human" : "agent", name: a });
}
try {
  s.createContext({ id: CTX, kind: "case", title: TITLE, goal: GOAL, createdAt: now }, "human:alice");
} catch { /* exists: continue */ }
for (const [actor, caps] of [[agents[0]!.actorId, ["read", "write"]], [agents[1]!.actorId, ["read", "write"]], ["human:alice", ["read", "write", "decide"]]] as const) {
  s.join({ contextId: CTX, actorId: actor, capabilities: [...caps], joinedAt: Date.now() }, `join:${actor}:${now}`);
}
s.postMessage(CTX, "human:alice", `kickoff:${now}`, KICKOFF);

const USE_DURABLE = process.argv.includes("--durable");
const durable = USE_DURABLE ? await openDurable(DATA + ".pi.sqlite", createGateway(BASE, bearer, [MODEL]).models) : undefined;
const convs = new Map<string, Awaited<ReturnType<typeof ensureConv>>>();
if (durable) {
  for (const a of agents) {
    convs.set(a.actorId, await ensureConv(durable, s, CTX, a.actorId, fullSystem(a.system), { provider: "piople", modelId: MODEL }));
  }
}
let totalIn = 0, totalOut = 0, toolCalls = 0, proposals = 0;
for (let round = 0; round < ROUNDS; round++) {
  for (const a of agents) {
    const conv = convs.get(a.actorId);
    const r = await agentTurn(s, { ...a, contextId: CTX, model: MODEL, baseUrl: BASE, bearer, maxTokens: 400, ...(durable && conv ? { durable: { d: durable, conv } } : {}) });
    const u = r.usage as { prompt_tokens?: number; completion_tokens?: number };
    totalIn += u.prompt_tokens ?? 0;
    totalOut += u.completion_tokens ?? 0;
    toolCalls += r.toolCalls;
    if (r.text.startsWith("Proposed action")) proposals++;
    console.log(`--- ${a.actorId} [${r.kind} tools=${r.toolCalls}] tokens=${u.prompt_tokens}+${u.completion_tokens}\n${r.text.slice(0, 500)}\n`);
  }
}
s.requestDecision({ id: `d-${now}`, contextId: CTX, question: "Hyväksytäänkö agenttien ehdotus jatkoselvitykseen?", options: ["yes", "no"], requestedBy: "agent:builder", decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
console.log(`RUN db=${DATA} case=${CTX} model=${MODEL} rounds=${ROUNDS} tokens=${totalIn}+${totalOut} toolCalls=${toolCalls} proposals=${proposals}`);
s.finishRun(runId, { tokensIn: totalIn, tokensOut: totalOut, toolCalls, proposals, outcome: "done" });
console.log(`Events: ${s.eventsSince(CTX, 0, 1000).length}. Human: resolve with resolveDecision().`);
await durable?.close();
s.close();
