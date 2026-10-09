import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";

/** V0 synthetic world: 2 humans + 2 synthetic agents, no LLM. Proves the protocol, not intelligence. */

function memStore() {
  return new Store(":memory:");
}

test("four actors, one case, full loop with idempotent replay", () => {
  const s = memStore();
  for (const a of ["human:alice", "human:bob", "agent:scout", "agent:builder"]) {
    s.upsertActor({ id: a, kind: a.startsWith("human:") ? "human" : "agent", name: a });
  }
  s.createContext({ id: "case-1", kind: "case", title: "Checkout API down", goal: "Find cause, fix, verify", createdAt: Date.now() }, "human:alice");
  for (const a of ["human:bob", "agent:scout", "agent:builder"]) {
    s.join({ contextId: "case-1", actorId: a, capabilities: a === "human:bob" ? ["read", "write", "decide"] : ["read", "write"], joinedAt: Date.now() }, `join:${a}`);
  }
  // idempotent replay: same key returns same event, no duplicate
  const m1 = s.postMessage("case-1", "human:alice", "k1", "auttakaa tässä");
  const m1b = s.postMessage("case-1", "human:alice", "k1", "auttakaa tässä");
  assert.equal(m1.seq, m1b.seq);

  s.recordObservation({ id: "obs-1", contextId: "case-1", kind: "finding", authorId: "agent:scout", text: "POOL_SIZE=0 in ConfigMap", status: "hypothesis", evidence: ["k8s:configmap/checkout"], createdAt: Date.now() });
  const req = s.requestAssistance("case-1", "agent:scout", "ask-1", "agent:builder", "Is this enough to crash on restart?", { observation: "obs-1" });
  s.answerAssistance("case-1", "agent:builder", "ans-1", "ask-1", "No — also check pool init retry", ["git:src/pool.ts"]);
  s.requestDecision({ id: "d-1", contextId: "case-1", question: "Apply fix to staging?", options: ["yes", "no"], requestedBy: "agent:builder", decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
  // agent cannot decide: needs decide capability
  assert.throws(() => s.resolveDecision("case-1", "agent:builder", "dec-1", "d-1", "yes"), /forbidden/);
  s.resolveDecision("case-1", "human:bob", "dec-1", "d-1", "yes");

  const events = s.eventsSince("case-1", 0);
  const types = events.map((e) => e.type);
  for (const t of ["context.created", "member.joined", "message.posted", "observation.recorded", "assistance.requested", "assistance.answered", "decision.requested", "decision.resolved"]) {
    assert.ok(types.includes(t as never), `missing ${t}`);
  }
  s.close();
});

test("invited expert answers without membership; stranger cannot", () => {
  const s = memStore();
  s.upsertActor({ id: "human:alice", kind: "human", name: "alice" });
  s.upsertActor({ id: "agent:scout", kind: "agent", name: "scout" });
  s.upsertActor({ id: "agent:outsider", kind: "agent", name: "outsider" });
  s.createContext({ id: "case-i", kind: "case", title: "i", goal: "i", createdAt: Date.now() }, "human:alice");
  s.join({ contextId: "case-i", actorId: "agent:scout", capabilities: ["read", "write"], joinedAt: Date.now() }, "j");
  s.requestAssistance("case-i", "agent:scout", "q1", "agent:expert", "help?", {});
  s.upsertActor({ id: "agent:expert", kind: "agent", name: "expert" });
  s.answerAssistance("case-i", "agent:expert", "a1", "q1", "yes", ["e"]);
  assert.throws(() => s.answerAssistance("case-i", "agent:outsider", "a2", "q1", "hi", []), /not-a-member/);
  s.close();
});

test("non-member cannot write; events are append-only", () => {
  const s = memStore();
  s.upsertActor({ id: "human:alice", kind: "human", name: "alice" });
  s.upsertActor({ id: "agent:stranger", kind: "agent", name: "stranger" });
  s.createContext({ id: "case-x", kind: "case", title: "x", goal: "x", createdAt: Date.now() }, "human:alice");
  s.join({ contextId: "case-x", actorId: "human:alice", capabilities: ["read", "write", "decide"], joinedAt: Date.now() }, "j1");
  assert.throws(() => s.postMessage("case-x", "agent:stranger", "k", "hi"), /not-a-member/);
  assert.throws(() => (s.db.exec(`UPDATE events SET type='hacked'`), null), /append-only/);
  s.close();
});
