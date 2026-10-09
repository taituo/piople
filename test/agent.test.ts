import test from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Store } from "../src/core/index.ts";
import { openDurable, ensureConv } from "../src/agents/durable.ts";
import { agentTurn, fullSystem } from "../src/agents/loop.ts";

/**
 * Offline proof that Pi, not piople, runs the agent loop: a scripted model calls piople's
 * tools, Pi executes them as durable tasks, and everything lands in the case via the Store.
 */
async function world() {
  const s = new Store(":memory:");
  s.upsertActor({ id: "human:alice", kind: "human", name: "alice" });
  s.upsertActor({ id: "agent:scout", kind: "agent", name: "scout" });
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "find the cause", createdAt: Date.now() }, "human:alice");
  s.join({ contextId: "c1", actorId: "agent:scout", capabilities: ["read", "write"], joinedAt: Date.now() }, "j");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const d = await openDurable(":memory:", models, s);
  const model = faux.getModel();
  const conv = await ensureConv(d, s, "c1", "agent:scout", fullSystem("scout"), { provider: model.provider, modelId: model.id });
  return { s, d, faux, conv };
}

test("agent records a finding and proposes through Pi tools; text parsing is gone", async () => {
  const { s, d, faux, conv } = await world();
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("observe", { text: "POOL_SIZE=0 in checkout-config", evidence: ["k8s:configmap/checkout-config"] })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("propose", { verb: "patch", res: "configmap", ns: "demo-apps", name: "checkout-config", patch: { data: { POOL_SIZE: "10" } }, why: "pool must be > 0" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Löysin syyn ja ehdotin korjauksen.")]),
    ]);
    const r = await agentTurn(s, { actorId: "agent:scout", contextId: "c1", durable: { d, conv } });
    assert.equal(r.toolCalls, 2);
    assert.equal(r.proposals, 1);
    assert.equal(r.kind, "observation");

    const types = s.eventsSince("c1", 0).map((e) => e.type);
    for (const t of ["observation.recorded", "action.proposed", "decision.requested", "message.posted"]) assert.ok(types.includes(t as never), `missing ${t}`);
    const obs = s.eventsSince("c1", 0).find((e) => e.type === "observation.recorded")!;
    assert.equal(obs.actorId, "agent:scout", "identity comes from the conversation binding");
    assert.equal(obs.data.status, "hypothesis");
    const open = s.db.prepare(`SELECT status FROM decisions WHERE context_id='c1'`).all() as Array<{ status: string }>;
    assert.deepEqual(open.map((x) => x.status), ["open"], "a proposal binds to an open decision and nothing runs");
  } finally {
    await d.close();
    s.close();
  }
});

test("a tool call outside the case's rights is refused at the Store, not by the prompt", async () => {
  const { s, d, faux, conv } = await world();
  try {
    s.db.prepare(`UPDATE members SET capabilities=? WHERE context_id='c1' AND actor_id='agent:scout'`).run(JSON.stringify(["read"]));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("observe", { text: "sneaky" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("En saanut kirjoittaa.")]),
    ]);
    // the tool call fails inside Pi, and so does posting the reply: no write capability anywhere
    await assert.rejects(agentTurn(s, { actorId: "agent:scout", contextId: "c1", durable: { d, conv } }), /lacks write/);
    assert.equal(s.eventsSince("c1", 0).filter((e) => e.type === "observation.recorded").length, 0);
  } finally {
    await d.close();
    s.close();
  }
});
