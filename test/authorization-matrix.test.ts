import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";

/**
 * Found by mutation testing: deleting any of these ten authorization checks left every test green. For each guarded
 * Store method: a stranger (not a member) and a read-only member are refused, a member who may do it is not.
 */
function world() {
  const s = new Store(":memory:");
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  s.join({ contextId: "c1", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, "jb", "human:alice");
  s.join({ contextId: "c1", actorId: "human:viewer", capabilities: ["read"], joinedAt: 2 }, "jv", "human:alice");
  s.addRouter("agent:router");
  return s;
}
const art = (by: string, id = "o1") => ({ id, contextId: "c1", kind: "finding", authorId: by, text: "x", status: "hypothesis", evidence: [], createdAt: 1 }) as never;
const dec = (by: string, id = "d1") => ({ id, contextId: "c1", question: "q?", options: ["yes", "no"], requestedBy: by, decidedBy: null, answer: null, status: "open", createdAt: 1, resolvedAt: null }) as never;

test("join: only a holder of decide may add someone, and not with rights it does not hold", () => {
  const s = world();
  assert.throws(() => s.join({ contextId: "c1", actorId: "human:eve", capabilities: ["read"], joinedAt: 3 }, "j1", "human:bob"), /forbidden: human:bob lacks decide/, "a member with write but no decide");
  assert.throws(() => s.join({ contextId: "c1", actorId: "human:eve", capabilities: ["read"], joinedAt: 3 }, "j2", "human:viewer"), /lacks decide/);
  assert.throws(() => s.join({ contextId: "c1", actorId: "human:eve", capabilities: ["read"], joinedAt: 3 }, "j3", "human:stranger"), /not-a-member/);
  s.join({ contextId: "c1", actorId: "human:eve", capabilities: ["read"], joinedAt: 3 }, "j4", "human:alice");
  s.close();
});

test("observe, ask, decision-request, propose and execute need write; a stranger and a read-only member are refused", () => {
  const s = world();
  for (const who of ["human:stranger", "human:viewer"]) {
    const re = who === "human:stranger" ? /not-a-member/ : /forbidden: human:viewer lacks write/;
    assert.throws(() => s.recordObservation(art(who)), re, `observe by ${who}`);
    assert.throws(() => s.requestAssistance("c1", who, "a1", "human:bob", "help?", {}), re, `ask by ${who}`);
    assert.throws(() => s.requestDecision(dec(who)), re, `decision-request by ${who}`);
    assert.throws(() => s.proposeAction(art(who, "p1"), { verb: "patch", res: "cm", ns: "n" }, "d0"), re, `propose by ${who}`);
    assert.throws(() => s.recordExecution("c1", who, "x1", "p1", "d0", true, "ok"), re, `execute by ${who}`);
  }
  assert.equal(s.eventsSince("c1", 0).filter((e) => ["observation.recorded", "assistance.requested", "decision.requested", "action.proposed", "action.executed"].includes(e.type)).length, 0, "nothing was written");
  s.recordObservation(art("human:bob"));
  s.requestAssistance("c1", "human:bob", "a1", "human:alice", "help?", {});
  s.requestDecision(dec("human:bob"));
  s.close();
});

test("decision-get is for members, and claim --next is for members who can write", () => {
  const s = world();
  s.requestDecision(dec("human:bob"));
  assert.throws(() => s.decisionInfo("c1", "human:stranger", "d1"), /not-a-member/);
  assert.equal((s.decisionInfo("c1", "human:viewer", "d1") as { found: boolean }).found, true, "read is enough to look");
  s.requestWork("c1", "human:alice", { id: "w1", skill: "job", input: {} });
  s.upsertActor({ id: "human:stranger", kind: "human", name: "s" });
  s.setSkills("human:stranger", ["job"]);
  s.setSkills("human:viewer", ["job"]);
  assert.throws(() => s.claimNext("c1", "human:stranger"), /not-a-member/);
  assert.throws(() => s.claimNext("c1", "human:viewer"), /forbidden: human:viewer lacks write/);
  assert.equal(s.getWork("c1", "w1")!.status, "open", "nobody took it");
  s.close();
});

test("route-classified and route-unresolved are for routers only", () => {
  const s = world();
  s.submitMessage("human:bob", "m1", "hello there");
  for (const who of ["human:bob", "human:alice", "agent:stranger"]) {
    assert.throws(() => s.routeClassified(who, "ingress:human:bob", "m1", {}), /router/i, `classified by ${who}`);
    assert.throws(() => s.routeUnresolved(who, "ingress:human:bob", "m1", "no-choice"), /router/i, `unresolved by ${who}`);
  }
  assert.equal(s.eventsSince("ingress:human:bob", 0).filter((e) => e.type.startsWith("route.")).length, 0);
  s.routeClassified("agent:router", "ingress:human:bob", "m1", { choice: null });
  s.routeUnresolved("agent:router", "ingress:human:bob", "m1", "no-choice");
  s.close();
});
