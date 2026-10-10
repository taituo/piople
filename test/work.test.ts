import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";

function world() {
  const s = new Store(":memory:");
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "g", createdAt: 1 }, "human:alice");
  for (const [a, caps, skills] of [
    ["agent:web", ["read", "write"], ["web.search"]],
    ["agent:web2", ["read", "write"], ["web.search"]],
    ["agent:fs", ["read", "write"], ["fs.read"]],
    ["agent:ro", ["read"], ["web.search"]],
  ] as const) {
    s.join({ contextId: "c1", actorId: a, capabilities: [...caps], joinedAt: 2 }, `j-${a}`, "human:alice");
    s.setSkills(a, [...skills]);
  }
  return s;
}

test("work needs a target; skill and to only route, they never grant", () => {
  const s = world();
  assert.throws(() => s.requestWork("c1", "human:alice", { id: "w0", input: "x" }), /work-needs-target/);
  assert.throws(() => s.requestWork("c1", "agent:stranger", { id: "w0", skill: "web.search", input: "x" }), /not-a-member/);
  s.requestWork("c1", "human:alice", { id: "w1", skill: "web.search", input: { q: "docs" } });
  s.requestWork("c1", "human:alice", { id: "w2", to: "agent:fs", input: "only fs" });

  assert.throws(() => s.claimWork("c1", "agent:fs", "w1"), /needs skill web.search/);
  assert.throws(() => s.claimWork("c1", "agent:web", "w2"), /directed to agent:fs/);
  assert.throws(() => s.claimWork("c1", "agent:ro", "w1"), /lacks write/, "the skill is not a permission");
  s.upsertActor({ id: "agent:stranger", kind: "agent", name: "stranger" });
  s.setSkills("agent:stranger", ["web.search"]);
  assert.throws(() => s.claimWork("c1", "agent:stranger", "w1"), /not-a-member/, "a matching skill without membership is nothing");
  assert.throws(() => s.setSkills("agent:nobody", ["x"]), /unknown-actor/);
  assert.equal(s.claimNext("c1", "agent:web")!.work.id, "w1");
  assert.equal(s.claimNext("c1", "agent:web"), null, "w2 is not for agent:web");
  assert.equal(s.claimNext("c1", "agent:fs")!.work.id, "w2");
  s.close();
});

test("only one holder; the same holder reclaiming gets its claim back", () => {
  const s = world();
  s.requestWork("c1", "human:alice", { id: "w1", skill: "web.search", input: 1 });
  const a = s.claimWork("c1", "agent:web", "w1");
  assert.equal(a.work.attempt, 1);
  assert.throws(() => s.claimWork("c1", "agent:web2", "w1"), /already claimed by agent:web/);
  assert.equal(s.claimNext("c1", "agent:web2"), null);
  const again = s.claimWork("c1", "agent:web", "w1"); // e.g. the host restarted
  assert.equal(again.event.seq, a.event.seq);
  assert.equal(again.work.attempt, 1);
  assert.equal(s.eventsSince("c1", 0).filter((e) => e.type === "work.claimed").length, 1);
  s.close();
});

test("expired lease: the replacement wins, the late original is refused", () => {
  const s = world();
  s.requestWork("c1", "human:alice", { id: "w1", skill: "web.search", input: 1 });
  const first = s.claimWork("c1", "agent:web", "w1", 100, 1000);
  assert.equal(first.work.leaseUntil, 1100);
  assert.throws(() => s.claimWork("c1", "agent:web2", "w1", 100, 1050), /already claimed/);
  const second = s.claimWork("c1", "agent:web2", "w1", 100, 1200);
  assert.equal(second.work.attempt, 2);
  assert.throws(() => s.completeWork("c1", "agent:web", "w1", 1, "late"), /stale-claim/);
  assert.throws(() => s.failWork("c1", "agent:web", "w1", 1, "late"), /stale-claim/);
  const done = s.completeWork("c1", "agent:web2", "w1", 2, { found: true });
  assert.equal(s.completeWork("c1", "agent:web2", "w1", 2, { found: true }).seq, done.seq, "replay returns the original");
  assert.equal(s.getWork("c1", "w1")!.status, "done");
  assert.deepEqual(s.getWork("c1", "w1")!.result, { found: true });
  assert.equal(s.eventsSince("c1", 0).filter((e) => e.type === "work.completed").length, 1);
  s.close();
});

test("an expired lease alone does not lose finished work", () => {
  const s = world();
  s.requestWork("c1", "human:alice", { id: "w1", skill: "web.search", input: 1 });
  s.claimWork("c1", "agent:web", "w1", 1, 1000);
  s.completeWork("c1", "agent:web", "w1", 1, "ok"); // nobody took it over meanwhile
  assert.equal(s.getWork("c1", "w1")!.status, "done");
  assert.throws(() => s.claimWork("c1", "agent:web2", "w1", undefined, 9999), /already done/);
  s.close();
});

test("fail: terminal by default, retry reopens with a new attempt", () => {
  const s = world();
  s.requestWork("c1", "human:alice", { id: "w1", skill: "web.search", input: 1 });
  s.requestWork("c1", "human:alice", { id: "w2", skill: "web.search", input: 2 });
  const c1 = s.claimWork("c1", "agent:web", "w1");
  const f = s.failWork("c1", "agent:web", "w1", c1.work.attempt, "network down", true);
  assert.equal(s.failWork("c1", "agent:web", "w1", 1, "network down", true).seq, f.seq, "replay after the work was reopened");
  assert.equal(s.getWork("c1", "w1")!.status, "open");
  const c2 = s.claimWork("c1", "agent:web2", "w1");
  assert.equal(c2.work.attempt, 2);
  s.completeWork("c1", "agent:web2", "w1", 2, "ok");

  const d = s.claimWork("c1", "agent:web", "w2");
  s.failWork("c1", "agent:web", "w2", d.work.attempt, "bad input");
  assert.equal(s.getWork("c1", "w2")!.status, "failed");
  assert.throws(() => s.claimWork("c1", "agent:web2", "w2"), /already failed/);
  assert.throws(() => s.completeWork("c1", "agent:web", "w2", 1, "x"), /stale-claim/);
  s.close();
});

test("pending work: what I can take, and what I hold after a restart", () => {
  const s = world();
  s.requestWork("c1", "human:alice", { id: "w1", skill: "web.search", input: "a" });
  s.requestWork("c1", "human:alice", { id: "w2", to: "agent:fs", input: "b" });
  assert.deepEqual(s.pending("c1", "agent:web").work.open.map((w) => w.id), ["w1"]);
  assert.deepEqual(s.pending("c1", "agent:fs").work.open.map((w) => w.id), ["w2"]);
  assert.deepEqual(s.pending("c1", "agent:ro").work.open, [], "no write, nothing to take");
  assert.equal(s.inbox("agent:web")[0]!.pending, 1);

  const c = s.claimWork("c1", "agent:web", "w1", 60_000);
  assert.deepEqual(s.pending("c1", "agent:web2").work.open, [], "held by someone else");
  const mine = s.pending("c1", "agent:web").work.mine;
  assert.deepEqual(mine.map((m) => [m.id, m.attempt]), [["w1", 1]]);
  s.completeWork("c1", "agent:web", "w1", c.work.attempt, "ok");
  assert.deepEqual(s.pending("c1", "agent:web").work, { open: [], mine: [] });
  s.close();
});

test("work ids are per context; claims are events in the log", () => {
  const s = world();
  s.createContext({ id: "c2", kind: "case", title: "t2", goal: "g", createdAt: 3 }, "human:alice");
  s.join({ contextId: "c2", actorId: "agent:web", capabilities: ["read", "write"], joinedAt: 4 }, "j", "human:alice");
  s.requestWork("c1", "human:alice", { id: "w1", skill: "web.search", input: 1 });
  s.requestWork("c2", "human:alice", { id: "w1", skill: "web.search", input: 2 });
  s.claimWork("c2", "agent:web", "w1");
  assert.equal(s.getWork("c1", "w1")!.status, "open");
  assert.deepEqual(s.eventsSince("c2", 0).map((e) => e.type).filter((t) => t.startsWith("work.")), ["work.requested", "work.claimed"]);
  s.close();
});
