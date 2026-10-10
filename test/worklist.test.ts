import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { runOp } from "../src/ops.ts";
import { statusFor } from "../src/http/server.ts";

test("work-list: a read-only member sees work in its contexts, cannot take it, and sees nothing elsewhere", () => {
  const s = new Store(":memory:");
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  s.createContext({ id: "c2", kind: "case", title: "t2", goal: "", createdAt: 2 }, "human:alice");
  s.join({ contextId: "c1", actorId: "agent:look", capabilities: ["read"], joinedAt: 3 }, "j1", "human:alice");
  s.join({ contextId: "c1", actorId: "agent:w", capabilities: ["read", "write"], joinedAt: 3 }, "j2", "human:alice");
  s.setSkills("agent:w", ["s"]);
  s.requestWork("c1", "human:alice", { id: "w1", skill: "s", input: { n: 1 } });
  s.requestWork("c2", "human:alice", { id: "w2", skill: "s", input: { n: 2 } });
  const open = runOp(s, "agent:look", "work-list", { status: "claimable" }) as any[];
  assert.deepEqual(open.map((w) => [w.contextId, w.id, w.skill, w.status]), [["c1", "w1", "s", "open"]], "only the context it can read");
  assert.ok(open[0].createdAt > 0 && open[0].input.n === 1);
  assert.throws(() => runOp(s, "agent:look", "work-claim", { context: "c1", id: "w1" }), /forbidden|lacks write/, "reading is not taking");
  assert.throws(() => runOp(s, "agent:look", "work-list", { context: "c2" }), /not-a-member/);
  s.claimWork("c1", "agent:w", "w1");
  assert.equal((runOp(s, "agent:look", "work-list", { status: "claimable" }) as any[]).length, 0);
  assert.deepEqual((runOp(s, "agent:look", "work-list", { status: "claimed" }) as any[]).map((w) => w.claimedBy), ["agent:w"]);
  assert.equal((runOp(s, "agent:look", "work-list", { context: "c1" }) as any[]).length, 1, "no filter: all states");
  assert.deepEqual((runOp(s, "agent:look", "work-list", { context: "c1", id: "w1" }) as any[]).map((w) => w.id), ["w1"], "one item by id");
  assert.deepEqual(runOp(s, "agent:look", "work-list", { context: "c1", id: "nope" }), []);
  assert.throws(() => runOp(s, "agent:look", "work-list", { status: "nope" }), /bad-status/);
  assert.equal(statusFor("bad-status: nope").status, 400);
  s.close();
});

test("work-list: an expired lease counts as claimable; limit and order hold", () => {
  const s = new Store(":memory:");
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  s.setSkills("human:alice", ["s"]);
  for (const id of ["a", "b", "c"]) s.requestWork("c1", "human:alice", { id, skill: "s", input: id });
  s.claimWork("c1", "human:alice", "a", 1000, 1_000);
  assert.deepEqual(s.listWork("human:alice", { status: "claimable" }, 1_500).map((w) => w.id), ["b", "c"], "lease still live");
  assert.deepEqual(s.listWork("human:alice", { status: "claimable" }, 99_999_999_999_999).map((w) => w.id), ["a", "b", "c"], "lease expired");
  assert.deepEqual(s.listWork("human:alice", { limit: 2 }).map((w) => w.id), ["a", "b"]);
  s.close();
});
