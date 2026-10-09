import { Store } from "../src/core/index.ts";
import { readBearer } from "../src/agents/loop.ts";
import { createGateway } from "../src/agents/pi-provider.ts";
import { openDurable, ensureConv, askConv } from "../src/agents/durable.ts";

/**
 * H2 restart proof: open -> ask -> CLOSE everything -> reopen ->
 * same conv binding, same requestId is idempotent, history continues.
 * Usage: node scripts/restart-proof.ts (needs gateway)
 */
const DB = "./data/restart.sqlite";
const BASE = process.env.PIO_GATEWAY ?? "http://10.91.1.1:8788/v1";
const MODEL = "deepseek-v4-flash";
const bearer = readBearer();
const gw = () => createGateway(BASE, bearer, [MODEL]).models;

async function phase1() {
  const s = new Store(DB);
  s.upsertActor({ id: "agent:scout", kind: "agent", name: "scout" });
  try {
    s.createContext({ id: "case-r", kind: "case", title: "restart", goal: "prove durability", createdAt: Date.now() }, "agent:scout");
  } catch { /* exists */ }
  s.join({ contextId: "case-r", actorId: "agent:scout", capabilities: ["read", "write"], joinedAt: Date.now() }, "j1");
  const d = await openDurable(DB + ".pi.sqlite", gw());
  const conv = await ensureConv(d, s, "case-r", "agent:scout", "You are scout. Answer in one short sentence.", { provider: "piople", modelId: MODEL });
  const convId = Number(conv.id);
  const r1 = await askConv(d, conv, "Remember the word JUNIPER. Reply OK.", "req-1");
  console.log(`phase1 conv=${convId} reply=${r1.text.slice(0, 80)}`);
  await d.close();
  s.close();
  return convId;
}

async function phase2(convId: number) {
  const s = new Store(DB);
  const d = await openDurable(DB + ".pi.sqlite", gw());
  const conv = await ensureConv(d, s, "case-r", "agent:scout", "You are scout.", { provider: "piople", modelId: MODEL });
  console.log(`phase2 conv=${Number(conv.id)} same=${Number(conv.id) === convId}`);
  // Same requestId again: must not duplicate work.
  const r1b = await askConv(d, conv, "Remember the word JUNIPER. Reply OK.", "req-1");
  console.log(`resubmit req-1 reply=${r1b.text.slice(0, 80)}`);
  const r2 = await askConv(d, conv, "What was the word? Reply with it.", "req-2");
  console.log(`continuity reply=${r2.text.slice(0, 120)}`);
  console.log(`remembered=${r2.text.includes("JUNIPER")}`);
  console.log(`events=${s.eventsSince("case-r", 0, 100).length}`);
  await d.close();
  s.close();
}

const c = await phase1();
await phase2(c);
console.log("RESTART_PROOF_DONE");
