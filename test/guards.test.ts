import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";

/** Found by mutation testing (deleting these guards left every test green): the refusals of unknown objects and bad values. */
function world() {
  const s = new Store(":memory:");
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  s.join({ contextId: "c1", actorId: "human:carol", capabilities: ["read", "decide"], joinedAt: 2 }, "jc", "human:alice");
  s.join({ contextId: "c1", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, "jb", "human:alice");
  s.addRouter("agent:router");
  return s;
}

test("join: a holder of decide cannot hand out a capability it does not hold", () => {
  const s = world();
  assert.throws(() => s.join({ contextId: "c1", actorId: "human:eve", capabilities: ["read", "write"], joinedAt: 3 }, "j1", "human:carol"), /forbidden: human:carol cannot grant write/);
  s.join({ contextId: "c1", actorId: "human:eve", capabilities: ["read"], joinedAt: 3 }, "j2", "human:carol"); // read she does hold
  s.close();
});

test("unknown findings and work items are named as unknown, not as an internal error", () => {
  const s = world();
  assert.throws(() => s.promoteObservation("nope", "human:alice", "confirmed"), /^Error: unknown-artifact: nope/);
  assert.throws(() => s.claimWork("c1", "human:bob", "nope"), /^Error: unknown-work: nope/);
  assert.throws(() => s.completeWork("c1", "human:bob", "nope", 1, "r"), /^Error: unknown-work: nope/);
  assert.throws(() => s.failWork("c1", "human:bob", "nope", 1, "why"), /^Error: unknown-work: nope/);
  s.close();
});

test("routing: an unknown submission is named, and a route may only post a message or request work", () => {
  const s = world();
  assert.throws(() => s.routeClassified("agent:router", "ingress:human:bob", "nope", {}), /^Error: unknown-submission/);
  assert.throws(() => s.routeUnresolved("agent:router", "ingress:human:bob", "nope", "no-choice"), /^Error: unknown-submission/);
  s.submitMessage("human:bob", "m1", "hello");
  assert.throws(() => s.routeResolve("agent:router", "ingress:human:bob", "m1", { context: "c1", as: "banana" } as never), /bad-route: as must be message or work/);
  assert.equal(s.routePending("agent:router").length, 1, "the refused route left the message pending");
  s.close();
});

test("operator tools: a router and a token need a real actor id, and a token a sensible lifetime", () => {
  const s = world();
  assert.throws(() => s.addRouter("justabob"), /bad-actor/);
  assert.throws(() => s.addRouter(""), /bad-actor/);
  assert.throws(() => s.issueToken("justabob"), /bad-actor/);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => s.issueToken("human:alice", bad), /bad-ttl/, String(bad));
  assert.match(s.issueToken("human:alice", 60_000), /^pio_/);
  s.close();
});
