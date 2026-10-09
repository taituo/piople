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
  s.requestAssistance("case-1", "agent:scout", "ask-1", "agent:builder", "Is this enough to crash on restart?", { observation: "obs-1" });
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

test("echo delegate may answer but never decide; hypotheses promote", () => {
  const s = memStore();
  s.upsertActor({ id: "human:alice", kind: "human", name: "alice" });
  s.upsertActor({ id: "agent:scout", kind: "agent", name: "scout" });
  s.createContext({ id: "case-e", kind: "case", title: "e", goal: "e", createdAt: Date.now() }, "human:alice");
  s.join({ contextId: "case-e", actorId: "agent:scout", capabilities: ["read", "write"], joinedAt: Date.now() }, "j");
  s.recordObservation({ id: "o1", contextId: "case-e", kind: "finding", authorId: "agent:scout", text: "h?", status: "hypothesis", evidence: [], createdAt: Date.now() });
  s.promoteObservation("o1", "human:alice", "confirmed");
  const row = s.db.prepare(`SELECT status FROM artifacts WHERE id='o1'`).get() as { status: string };
  assert.equal(row.status, "confirmed");
  assert.throws(() => s.promoteObservation("o1", "agent:stranger", "refuted"), /not-a-member/);
  s.requestDecision({ id: "d1", contextId: "case-e", question: "q?", options: ["yes", "no"], requestedBy: "agent:scout", decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
  s.setPresence("human:alice", "away", true);
  assert.throws(() => s.resolveDecision("case-e", "human:alice", "k", "d1", "yes"), /echo delegate may never decide/);
  s.setPresence("human:alice", "active", false);
  s.resolveDecision("case-e", "human:alice", "k", "d1", "yes");
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
  // the invitation is consumed: a second, different answer is refused; a replay is not
  assert.throws(() => s.answerAssistance("case-i", "agent:expert", "a3", "q1", "again", []), /already used/);
  assert.equal(s.answerAssistance("case-i", "agent:expert", "a1", "q1", "yes", ["e"]).key, "a1");
  // an invitation is bound to its request: it does not open the whole case
  assert.throws(() => s.answerAssistance("case-i", "agent:expert", "a4", "no-such-request", "x", []), /unknown-request/);
  s.requestAssistance("case-i", "agent:scout", "q2", "agent:other", "second?", {});
  assert.throws(() => s.answerAssistance("case-i", "agent:expert", "a5", "q2", "x", []), /not-a-member/);
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

test("replays return the original event for every mutation, not an error", () => {
  const s = memStore();
  s.upsertActor({ id: "human:alice", kind: "human", name: "alice" });
  s.createContext({ id: "case-r", kind: "case", title: "r", goal: "r", createdAt: Date.now() }, "human:alice");
  const obs = { id: "o1", contextId: "case-r", kind: "finding" as const, authorId: "human:alice", text: "t", status: "hypothesis" as const, evidence: [], createdAt: Date.now() };
  assert.equal(s.recordObservation(obs).seq, s.recordObservation(obs).seq);
  s.upsertActor({ id: "agent:a", kind: "agent", name: "a" });
  s.join({ contextId: "case-r", actorId: "agent:a", capabilities: ["read", "write"], joinedAt: Date.now() }, "ja");
  const dec = { id: "d1", contextId: "case-r", question: "q?", options: ["yes", "no"], requestedBy: "agent:a", decidedBy: null, answer: null, status: "open" as const, createdAt: Date.now(), resolvedAt: null };
  assert.equal(s.requestDecision(dec).seq, s.requestDecision(dec).seq);
  const r1 = s.resolveDecision("case-r", "human:alice", "k", "d1", "yes");
  const r2 = s.resolveDecision("case-r", "human:alice", "k", "d1", "yes");
  assert.equal(r1.seq, r2.seq);
  // a different key on the already-resolved decision is still refused
  assert.throws(() => s.resolveDecision("case-r", "human:alice", "k2", "d1", "no"), /decision-not-open/);
  s.close();
});

test("join cannot escalate: granter must be a member and can only grant what it holds", () => {
  const s = memStore();
  s.upsertActor({ id: "human:alice", kind: "human", name: "alice" });
  s.createContext({ id: "case-j", kind: "case", title: "j", goal: "j", createdAt: Date.now() }, "human:alice");
  for (const a of ["agent:evil", "agent:scout", "agent:x"]) s.upsertActor({ id: a, kind: "agent", name: a });
  const at = (actorId: string, capabilities: string[]) => ({ contextId: "case-j", actorId, capabilities, joinedAt: Date.now() });
  assert.throws(() => s.join(at("agent:evil", ["read", "write", "decide"]), "j1", "agent:evil"), /not-a-member/);
  s.join(at("agent:scout", ["read", "write"]), "j2", "human:alice");
  assert.throws(() => s.join(at("agent:scout", ["read", "write", "decide"]), "j3", "agent:scout"), /only a human can grant/);
  assert.throws(() => s.join(at("agent:x", ["root"]), "j4", "human:alice"), /unknown capability/);
  s.close();
});

test("invalid statuses and presence states are rejected", () => {
  const s = memStore();
  s.upsertActor({ id: "human:alice", kind: "human", name: "alice" });
  s.createContext({ id: "case-v", kind: "case", title: "v", goal: "v", createdAt: Date.now() }, "human:alice");
  assert.throws(() => s.recordObservation({ id: "o", contextId: "case-v", kind: "finding", authorId: "human:alice", text: "t", status: "bogus" as never, evidence: [], createdAt: Date.now() }), /unknown status/);
  assert.throws(() => s.setPresence("human:alice", "bogus" as never, false), /unknown presence/);
  s.close();
});

test("a failed mutation leaves no half-written state", () => {
  const s = memStore();
  s.upsertActor({ id: "human:alice", kind: "human", name: "alice" });
  s.createContext({ id: "case-t", kind: "case", title: "t", goal: "t", createdAt: Date.now() }, "human:alice");
  // make the event append fail after the artifact row is inserted
  s.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON events WHEN NEW.type='observation.recorded' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
  const obs = { id: "o1", contextId: "case-t", kind: "finding" as const, authorId: "human:alice", text: "t", status: "hypothesis" as const, evidence: [], createdAt: Date.now() };
  assert.throws(() => s.recordObservation(obs), /boom/);
  assert.equal(s.db.prepare(`SELECT count(*) AS n FROM artifacts`).get()!["n"], 0);
  s.db.exec(`DROP TRIGGER boom`);
  s.recordObservation(obs);
  assert.equal(s.db.prepare(`SELECT count(*) AS n FROM artifacts`).get()!["n"], 1);
  s.close();
});
