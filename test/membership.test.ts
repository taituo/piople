import test from "node:test";
import assert from "node:assert/strict";
import type net from "node:net";
import { Store } from "../src/core/index.ts";
import type { Context } from "../src/core/index.ts";
import { createCoreServer } from "../src/http/server.ts";
import { HttpCore } from "../src/hosts/http-core.ts";
import { runOp } from "../src/ops.ts";

const ctx = (id: string, kind: Context["kind"], extra: Partial<Context> = {}): Context => ({ id, kind, title: id, goal: "", createdAt: 1, ...extra });
const join = (s: Store, c: string, actor: string, caps: string[], by = "human:alice") => s.join({ contextId: c, actorId: actor, capabilities: caps, joinedAt: 2 }, `j:${c}:${actor}`, by);

function world() {
  const s = new Store(":memory:");
  s.createContext(ctx("realm-x", "realm"), "human:alice");
  join(s, "realm-x", "human:bob", ["read", "write", "decide"]);
  join(s, "realm-x", "agent:carol", ["read", "write"]);
  s.createContext(ctx("ch-1", "channel", { realmId: "realm-x" }), "human:alice");
  join(s, "ch-1", "human:bob", ["read", "write", "decide"]);
  join(s, "ch-1", "agent:carol", ["read", "write"]);
  return s;
}

test("access ends at once, visibly, and history stays readable by others", () => {
  const s = world();
  s.postMessage("ch-1", "agent:carol", "m1", "before");
  const ev = s.removeMember("ch-1", "agent:carol", "rm1", "human:alice");
  assert.deepEqual([ev.type, ev.actorId, ev.data.by, ev.data.reason], ["member.removed", "agent:carol", "human:alice", "removed"]);
  assert.throws(() => s.postMessage("ch-1", "agent:carol", "m2", "after"), /not-a-member/);
  assert.throws(() => s.readEvents("ch-1", "agent:carol", 0, 10), /not-a-member/);
  assert.ok(!s.targets("agent:carol").some((t) => t.id === "ch-1"));
  assert.ok(!s.inbox("agent:carol").some((c) => c.context === "ch-1"));
  assert.ok(s.readEvents("ch-1", "human:bob", 0, 100).some((e) => e.type === "message.posted" && e.actorId === "agent:carol"), "old messages stay");
  assert.ok(s.readEvents("ch-1", "human:bob", 0, 100).some((e) => e.type === "member.removed"), "the removal is an event");
  assert.equal(s.cursor("ch-1", "agent:carol"), 0, "cursor dropped");
  s.close();
});

test("only a decider removes others; anyone may leave; the last decider cannot go", () => {
  const s = world();
  assert.throws(() => s.removeMember("ch-1", "human:bob", "x", "agent:carol"), /lacks decide/);
  assert.throws(() => s.removeMember("ch-1", "human:dave", "x", "human:alice"), /not-a-member/);
  s.removeMember("ch-1", "agent:carol", "leave1", "agent:carol"); // leaving needs no decide
  s.removeMember("ch-1", "human:bob", "rm-bob", "human:alice");
  assert.throws(() => s.removeMember("ch-1", "human:alice", "rm-alice", "human:alice"), /forbidden: human:alice is the last holder of decide/);
  assert.throws(() => s.removeMember("ch-1", "human:alice", "rm-alice2", "human:alice"), /last holder/);
  // a non-decider may go even when it is the only member left besides the decider
  s.close();
});

test("removal from a realm cascades into its contexts, one event each; re-adding does not restore old roles", () => {
  const s = world();
  s.createContext(ctx("case-1", "case", { parentId: "ch-1" }), "human:alice");
  join(s, "case-1", "agent:carol", ["read", "write"]);
  const ev = s.removeMember("realm-x", "agent:carol", "rm-realm", "human:alice");
  assert.equal(ev.contextId, "realm-x");
  for (const c of ["ch-1", "case-1"]) {
    const removed = s.readEvents(c, "human:alice", 0, 100).filter((e) => e.type === "member.removed");
    assert.equal(removed.length, 1, c);
    assert.deepEqual([removed[0]!.actorId, removed[0]!.data.reason, removed[0]!.data.realm], ["agent:carol", "realm-removed", "realm-x"]);
    assert.throws(() => s.postMessage(c, "agent:carol", `p-${c}`, "x"), /not-a-member/);
  }
  join(s, "realm-x", "agent:carol", ["read", "write"]);
  assert.throws(() => s.postMessage("ch-1", "agent:carol", "p2", "x"), /not-a-member/, "back in the realm, but not in the channel");
  s.close();
});

test("a realm's last decider cannot be removed through the cascade either", () => {
  const s = new Store(":memory:");
  s.createContext(ctx("realm-x", "realm"), "human:alice");
  s.createContext(ctx("ch-1", "channel", { realmId: "realm-x" }), "human:alice");
  assert.throws(() => s.removeMember("realm-x", "human:alice", "k", "human:alice"), /last holder of decide/);
  join(s, "realm-x", "human:bob", ["read", "write", "decide"]);
  assert.throws(() => s.removeMember("realm-x", "human:alice", "k2", "human:alice"), /last holder of decide in ch-1/, "bob is not in ch-1, so ch-1 would be orphaned");
  s.close();
});

test("work held by the removed member reopens with its attempt kept and can be claimed by someone else", () => {
  const s = world();
  s.setSkills("agent:carol", ["s"]);
  s.setSkills("human:bob", ["s"]);
  s.requestWork("ch-1", "human:alice", { id: "w1", skill: "s", input: { q: 1 } });
  assert.equal(s.claimWork("ch-1", "agent:carol", "w1").work.attempt, 1);
  const ev = s.removeMember("ch-1", "agent:carol", "rm", "human:alice");
  assert.deepEqual(ev.data.reopenedWork, ["w1"]);
  assert.deepEqual([s.getWork("ch-1", "w1")!.status, s.getWork("ch-1", "w1")!.claimedBy], ["open", null]);
  assert.throws(() => s.completeWork("ch-1", "agent:carol", "w1", 1, "late"), /not-a-member/);
  assert.equal(s.claimWork("ch-1", "human:bob", "w1").work.attempt, 2);
  s.close();
});

test("replay is idempotent; a removed-and-rejoined actor can be removed again with a new key", () => {
  const s = world();
  const a = s.removeMember("ch-1", "agent:carol", "k1", "human:alice");
  assert.equal(s.removeMember("ch-1", "agent:carol", "k1", "human:alice").seq, a.seq);
  assert.equal(s.readEvents("ch-1", "human:alice", 0, 100).filter((e) => e.type === "member.removed").length, 1);
  assert.equal(s.removeMember("ch-1", "agent:carol", "k1", "human:bob").seq, a.seq, "same key, same actor and type: a replay, whoever asks");
  s.join({ contextId: "ch-1", actorId: "agent:carol", capabilities: ["read"], joinedAt: 3 }, "rejoin-1", "human:alice");
  s.removeMember("ch-1", "agent:carol", "k2", "human:alice");
  assert.throws(() => s.postMessage("ch-1", "agent:carol", "p", "x"), /not-a-member/);
  s.close();
});

test("ops over HTTP: leave and remove-member; a non-decider gets 403; a lost response replays", async () => {
  const store = world();
  const t = { alice: store.issueToken("human:alice"), carol: store.issueToken("agent:carol") };
  const srv = createCoreServer(store);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  const post = (path: string, token: string, body: object) => fetch(`${url}/v1/ops/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await post("remove-member", t.carol, { context: "ch-1", actor: "human:bob" })).status, 403);
  const first = await (await post("remove-member", t.alice, { context: "ch-1", actor: "agent:carol", key: "kk" })).json() as any;
  const again = await (await post("remove-member", t.alice, { context: "ch-1", actor: "agent:carol", key: "kk" })).json() as any;
  assert.equal(first.seq, again.seq);
  assert.equal((await post("post", t.carol, { context: "ch-1", text: "x" })).status, 403);
  const core = new HttpCore(url, { "human:alice": t.alice });
  assert.equal(((await core.call("human:alice", "leave", { context: "realm-x" })) as any).type, "member.removed", "alice may leave the realm only if another decider remains: bob does");
  await new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); });
  store.close();
});

test("ops: leave is the caller's own removal", () => {
  const s = world();
  const e = runOp(s, "agent:carol", "leave", { context: "ch-1" }) as any;
  assert.deepEqual([e.actorId, e.data.reason], ["agent:carol", "left"]);
  s.close();
});

test("ops: joining again after a removal really joins (the default key moves on), and a retried join still replays", () => {
  const s = world();
  const j = () => runOp(s, "human:alice", "join", { context: "ch-1", actor: "agent:carol", caps: "read,write" }) as any;
  const before = j();
  assert.equal(j().seq, before.seq, "a retried join replays");
  runOp(s, "human:alice", "remove-member", { context: "ch-1", actor: "agent:carol" });
  assert.throws(() => s.postMessage("ch-1", "agent:carol", "p1", "x"), /not-a-member/);
  const after = j();
  assert.ok(after.seq > before.seq);
  s.postMessage("ch-1", "agent:carol", "p2", "back");
  assert.equal(j().seq, after.seq, "and the new join replays too");
  s.close();
});
