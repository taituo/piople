/**
 * Live run: two real Pi agents and a human in one case, through the real Host and Core.
 *   OPENROUTER_API_KEY=... LIVE_MODEL=<exact model id> node scripts/live-team.ts
 *   LIVE_API_KEY=... LIVE_BASE_URL=https://opencode.ai/zen/go/v1 LIVE_MODEL=deepseek-v4-flash node scripts/live-team.ts
 * Costs real tokens (a few cents). Not part of `npm test`. Prints the case log and usage; exits 1 if
 * the protocol expectations below do not hold.
 */
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env.LIVE_API_KEY ?? process.env.OPENROUTER_API_KEY;
const modelId = process.env.LIVE_MODEL;
if (!apiKey || !modelId) {
  console.error("set LIVE_API_KEY (or OPENROUTER_API_KEY) and LIVE_MODEL");
  process.exit(2);
}
const baseUrl = process.env.LIVE_BASE_URL ?? "https://openrouter.ai/api/v1";

const store = new Store(":memory:");
const core = new LocalCore(store);
const as = (actor: string) => (op: string, a: Record<string, unknown> = {}) => core.call(actor, op, a) as Promise<any>;
const alice = as("human:alice");
const dir = mkdtempSync(join(tmpdir(), "piople-live-"));
const open = (actor: string, role: string) =>
  PiHarness.open({ actor, dir, role, provider: { baseUrl, apiKey }, modelId, maxTokens: 600 });

const scout = await open("agent:scout", "You are an SRE scout. You investigate and report findings with evidence. You never decide for humans.");
const ops = await open("agent:ops", "You are an ops engineer. You take work addressed to your skill, do it carefully and report the result.");
const host = new Host(core);
host.onError = (e) => console.error("host error:", e.actor, e.context, e.error);
await host.add({ actor: "agent:scout", harness: scout });
await host.add({ actor: "agent:ops", skills: ["ops.summarize"], harness: ops });

await alice("create", { id: "c1", title: "Checkout down", goal: "find cause, decide on a fix" });
await alice("join", { context: "c1", actor: "agent:scout", caps: "read,write" });
await alice("join", { context: "c1", actor: "agent:ops", caps: "read,write" });

// 1. a human message; the scout should react with a message/observation
await alice("post", { context: "c1", text: "Checkout is returning 500s since 09:40. The checkout configmap shows POOL_SIZE=0. agent:scout, say what you make of this, with the evidence you rely on." });
await host.settle();

// 2. work addressed by skill; ops should claim it and finish it with the attempt it was given
await alice("work-request", { context: "c1", id: "w1", skill: "ops.summarize", input: JSON.stringify({ task: "Summarize the incident so far in one sentence." }) });
await host.settle();

// 3. a decision only the human may take; an agent that tries to decide is refused by Core
await alice("decision-request", { context: "c1", id: "d1", question: "Patch POOL_SIZE to 10?", options: "yes,no" });
await host.settle();
const stillOpen = store.getDecision("c1", "d1")!.status === "open";
await alice("decide", { context: "c1", decision: "d1", answer: "yes" });

const events = store.eventsSince("c1", 0);
for (const e of events) console.log(`${String(e.seq).padStart(3)} ${e.actorId.padEnd(14)} ${e.type.padEnd(22)} ${JSON.stringify(e.data).slice(0, 160)}`);
console.log("usage scout:", scout.usage, "ops:", ops.usage);

const w = store.getWork("c1", "w1")!;
const agentWrites = events.filter((e) => e.actorId.startsWith("agent:") && ["message.posted", "observation.recorded"].includes(e.type));
const checks: Array<[string, boolean]> = [
  ["agents wrote something to the case", agentWrites.length > 0],
  ["work w1 done by an agent with attempt 1", w.status === "done" && w.attempt === 1],
  ["decision stayed open until the human decided", stillOpen],
  ["no agent decision was recorded", !events.some((e) => e.type === "decision.resolved" && e.actorId.startsWith("agent:"))],
];
for (const [name, ok] of checks) console.log(ok ? "PASS" : "FAIL", name);

await host.close();
store.close();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
