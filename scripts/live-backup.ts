/**
 * Live run of crewpi design bet 4 ("agents are colleagues with a backup") on piople's own primitives:
 * the main agent claims work with a lease and then disappears; the backup (same skill) takes it over once the lease
 * has run out, as attempt 2, and the main agent's late result is refused as stale. No Core change.
 *   LIVE_API_KEY=... LIVE_BASE_URL=https://opencode.ai/zen/go/v1 LIVE_MODEL=deepseek-v4-flash node scripts/live-backup.ts
 */
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env.LIVE_API_KEY ?? process.env.OPENROUTER_API_KEY;
const modelId = process.env.LIVE_MODEL;
if (!apiKey || !modelId) { console.error("set LIVE_API_KEY (or OPENROUTER_API_KEY) and LIVE_MODEL"); process.exit(2); }
const baseUrl = process.env.LIVE_BASE_URL ?? "https://openrouter.ai/api/v1";
const LEASE = 2000;

const store = new Store(":memory:");
const core = new LocalCore(store);
const as = (actor: string) => (op: string, a: Record<string, unknown> = {}) => core.call(actor, op, a) as Promise<any>;
const alice = as("human:alice"), main = as("agent:ops-main");
const refused = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "piople-backup-"));

await alice("create", { id: "c1", title: "Checkout down", goal: "keep the work moving" });
await alice("join", { context: "c1", actor: "agent:ops-main", caps: "read,write" });
await alice("join", { context: "c1", actor: "agent:ops-backup", caps: "read,write" });
await main("actor", { skills: "ops.summarize" });
await as("agent:ops-backup")("actor", { skills: "ops.summarize" });

// the main agent takes the work with a lease, then goes away without finishing
await alice("work-request", { context: "c1", id: "w1", skill: "ops.summarize", input: JSON.stringify({ task: "Summarize in one sentence: checkout returned 500s because POOL_SIZE was 0." }) });
const first = await main("work-claim", { context: "c1", id: "w1", "lease-ms": LEASE });
const tooEarly = await refused(as("agent:ops-backup")("work-claim", { context: "c1", id: "w1" }));

await sleep(LEASE + 500); // the main agent's lease runs out

// the backup is a real model, started now (a restart): it sees the work it may take and claims it
const backup = await PiHarness.open({ actor: "agent:ops-backup", dir, role: "You are the backup ops engineer. You take over work with skill ops.summarize that nobody holds, do it carefully and report the result.", provider: { baseUrl, apiKey }, modelId, maxTokens: 600 });
const host = new Host(core, { holder: "backup-host" });
host.onError = (e) => console.error("host error:", e.actor, e.context, e.error);
await host.add({ actor: "agent:ops-backup", skills: ["ops.summarize"], harness: backup });
await host.settle();

// the main agent comes back with its old result
const late = await refused(main("work-complete", { context: "c1", id: "w1", attempt: first.work.attempt, result: '"late result from the main agent"' }));

const events = store.eventsSince("c1", 0, 1000);
for (const e of events) console.log(`${String(e.seq).padStart(3)} ${e.actorId.padEnd(16)} ${e.type.padEnd(22)} ${JSON.stringify(e.data).slice(0, 150)}`);
const w = store.getWork("c1", "w1")!;
console.log("tooEarly:", tooEarly, "| late:", late, "| usage backup:", backup.usage);
const checks: Array<[string, boolean]> = [
  ["main agent held attempt 1", first.work.attempt === 1],
  ["backup could not take the work while the lease was live", tooEarly !== null],
  ["backup (real model) took it over as attempt 2 and finished it", w.status === "done" && w.attempt === 2],
  ["the result came from the backup", events.some((e) => e.type === "work.completed" && e.actorId === "agent:ops-backup")],
  ["main agent's late result was refused (stale claim)", late !== null && /stale/.test(late)],
  ["exactly one accepted completion", events.filter((e) => e.type === "work.completed").length === 1],
];
for (const [name, ok] of checks) console.log(ok ? "PASS" : "FAIL", name);
await host.close();
store.close();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
