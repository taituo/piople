import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";

function world() {
  const s = new Store(":memory:");
  s.createContext({ id: "c1", kind: "case", title: "Checkout down", goal: "g", createdAt: 1 }, "human:alice");
  s.createContext({ id: "c2", kind: "case", title: "Other", goal: "g", createdAt: 2 }, "human:alice");
  s.join({ contextId: "c1", actorId: "agent:scout", capabilities: ["read", "write"], joinedAt: 3 }, "j", "human:alice");
  return s;
}

test("away human returns: unread and pending are derived; ack moves the cursor but not the obligations", () => {
  const s = world();
  s.postMessage("c1", "agent:scout", "m1", "found something");
  s.requestAssistance("c1", "agent:scout", "q1", "human:alice", "is staging ok?", {});
  s.requestDecision({ id: "d1", contextId: "c1", question: "patch?", options: ["yes", "no"], requestedBy: "agent:scout", decidedBy: null, answer: null, status: "open", createdAt: 5, resolvedAt: null });

  const summary = s.inbox("human:alice");
  assert.deepEqual(summary.map((x) => [x.context, x.unread, x.pending]), [["c1", 4, 2], ["c2", 0, 0]]);

  const d = s.inboxOf("c1", "human:alice");
  assert.equal(d.cursor, 0);
  assert.ok(d.events.length >= 5); // created, joined, message, ask, decision
  assert.deepEqual(d.pending.assistance.map((a) => a.key), ["q1"]);
  assert.deepEqual(d.pending.decisions.map((x) => x.id), ["d1"]);

  const last = d.events.at(-1)!.seq;
  assert.equal(s.ack("c1", "human:alice", last), last);
  assert.equal(s.ack("c1", "human:alice", 1), last, "cursor never moves back");
  assert.equal(s.ack("c1", "human:alice", last + 1000), last, "cursor never passes the end of the log");

  const after = s.inboxOf("c1", "human:alice");
  assert.deepEqual(after.events, []);
  assert.equal(after.pending.decisions.length, 1, "acked is not resolved");
  assert.equal(after.pending.assistance.length, 1);
  assert.deepEqual(s.inbox("human:alice").map((x) => [x.unread, x.pending]), [[0, 2], [0, 0]]);

  s.answerAssistance("c1", "human:alice", "a1", "q1", "yes, staging", []);
  s.resolveDecision("c1", "human:alice", "k", "d1", "yes");
  const done = s.inboxOf("c1", "human:alice");
  assert.deepEqual(done.pending, { assistance: [], decisions: [], work: { open: [], mine: [] } });
  assert.equal(done.events.length, 2, "only the two events after the cursor, both mine");
  assert.equal(s.inbox("human:alice")[0]!.unread, 0, "own events are never unread");
  s.close();
});

test("pending follows capability, presence and read access", () => {
  const s = world();
  s.requestDecision({ id: "d1", contextId: "c1", question: "q", options: ["yes", "no"], requestedBy: "agent:scout", decidedBy: null, answer: null, status: "open", createdAt: 5, resolvedAt: null });
  assert.equal(s.pending("c1", "agent:scout").decisions.length, 0, "no decide capability, nothing to decide");
  s.setPresence("human:alice", "away", true);
  assert.equal(s.pending("c1", "human:alice").decisions.length, 0, "an echo delegate never gets decisions");
  s.setPresence("human:alice", "active", false);
  assert.equal(s.pending("c1", "human:alice").decisions.length, 1);

  s.join({ contextId: "c1", actorId: "agent:blind", capabilities: ["write"], joinedAt: 6 }, "jb", "human:alice");
  assert.deepEqual(s.inbox("agent:blind"), [], "no read capability, no inbox entry");
  assert.throws(() => s.inboxOf("c1", "agent:blind"), /lacks read/);
  assert.throws(() => s.ack("c1", "agent:blind", 1), /lacks read/);
  assert.throws(() => s.inboxOf("c1", "agent:stranger"), /not-a-member/);
  assert.throws(() => s.ack("c1", "human:alice", -1), /bad-seq/);
  s.close();
});

test("the cursor is durable state: a new connection resumes where the old one stopped", () => {
  const s = world();
  s.postMessage("c1", "agent:scout", "m1", "one");
  s.ack("c1", "agent:scout", s.eventsSince("c1", 0).at(-1)!.seq);
  s.postMessage("c1", "human:alice", "m2", "two");
  const resumed = s.inboxOf("c1", "agent:scout");
  assert.deepEqual(resumed.events.map((e) => e.key), ["m2"]);
  s.close();
});

test("pending asks are found in linear time: 6,000 open asks and some answered ones still take a fraction of a second", () => {
  const s = new Store(":memory:");
  s.createContext({ id: "c", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:a");
  s.join({ contextId: "c", actorId: "human:b", capabilities: ["read", "write"], joinedAt: 2 }, "jb", "human:a");
  for (let i = 0; i < 6000; i++) s.requestAssistance("c", "human:a", `a${i}`, "human:b", `q${i}?`, {});
  for (let i = 0; i < 6000; i += 3) s.answerAssistance("c", "human:b", `r${i}`, `a${i}`, "done", []);
  const t0 = Date.now();
  const pending = s.pending("c", "human:b").assistance;
  const took = Date.now() - t0;
  assert.equal(pending.length, 4000, "the answered third is gone, the rest is still owed");
  assert.deepEqual(pending.slice(0, 3).map((a) => a.key), ["a1", "a2", "a4"], "in the order they were asked");
  assert.ok(took < 500, `took ${took} ms (the correlated NOT EXISTS needed about 3 s for 6,000)`);
  s.close();
});
