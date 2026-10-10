import test from "node:test";
import assert from "node:assert/strict";
import type net from "node:net";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { HttpCore } from "../src/hosts/http-core.ts";
import { createCoreServer } from "../src/http/server.ts";
import { SyntheticHarness, behave } from "../src/harnesses/synthetic.ts";
import { runOp } from "../src/ops.ts";

const worker = () => new SyntheticHarness({ behaviors: [behave.worker((input) => ({ echo: input }))] });
function world() {
  const s = new Store(":memory:");
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  s.upsertActor({ id: "agent:w", kind: "agent", name: "w" });
  s.join({ contextId: "c1", actorId: "agent:w", capabilities: ["read", "write"], joinedAt: 2 }, "j", "human:alice");
  return s;
}

test("lease: a second holder is refused while the first is live, takes over after expiry or release, epoch moves on", () => {
  const s = world();
  const a = s.hostLease("agent:w", "h1", 1000, 10_000);
  assert.deepEqual([a.holder, a.epoch, a.expiresAt], ["h1", 1, 11_000]);
  assert.equal(s.hostLease("agent:w", "h1", 1000, 10_500).epoch, 1, "renewing keeps the epoch");
  assert.throws(() => s.hostLease("agent:w", "h2", 1000, 10_900), /already-hosted/);
  assert.equal(s.hostLease("agent:w", "h2", 1000, 12_000).epoch, 2, "after expiry the next holder takes over");
  s.hostRelease("agent:w", "h1"); // not the holder: nothing happens
  assert.throws(() => s.hostLease("agent:w", "h1", 1000, 12_100), /already-hosted/);
  s.hostRelease("agent:w", "h2");
  assert.equal(s.hostLease("agent:w", "h3", 1000, 12_200).epoch, 3, "after release at once");
  assert.throws(() => s.hostLease("agent:w", "", 1000), /bad-holder/);
  assert.throws(() => s.hostLease("agent:w", "h", 0), /bad-ttl/);
  assert.throws(() => s.hostLease("agent:nobody", "h", 1000), /unknown-actor/);
  s.close();
});

test("fencing: while a lease is live only its holder may inbox or ack; a stale holder is refused; no lease behaves as before", () => {
  const s = world();
  runOp(s, "human:alice", "post", { context: "c1", text: "hi" });
  assert.doesNotThrow(() => runOp(s, "agent:w", "inbox", {}), "no lease: as before");
  s.hostLease("agent:w", "h1", 1000, Date.now() - 5000); // expired
  s.hostLease("agent:w", "h2", 60_000); // h2 took over
  assert.throws(() => runOp(s, "agent:w", "ack", { context: "c1", seq: 1, holder: "h1" }), /already-hosted/, "the paused host cannot move the cursor");
  assert.throws(() => runOp(s, "agent:w", "inbox", { holder: "h1" }), /already-hosted/);
  assert.throws(() => runOp(s, "agent:w", "inbox", {}), /already-hosted.*pass the holder/, "a CLI call without the holder is refused too");
  assert.equal((runOp(s, "agent:w", "ack", { context: "c1", seq: 2, holder: "h2" }) as any).cursor, 2);
  assert.doesNotThrow(() => runOp(s, "agent:w", "inbox", { context: "c1", holder: "h2" }));
  // writes stay allowed for anyone holding the identity: they are idempotent by key
  assert.doesNotThrow(() => runOp(s, "agent:w", "post", { context: "c1", text: "x", key: "k" }));
  s.close();
});

test("Host: a second host for the same actor is refused, close releases, a restart with the same holder renews at once", async () => {
  const s = world();
  const h1 = new Host(new LocalCore(s), { holder: "svc-a" });
  await h1.add({ actor: "agent:w", skills: ["x"], harness: worker() });
  const h2 = new Host(new LocalCore(s));
  await assert.rejects(h2.add({ actor: "agent:w", harness: worker() }), /already-hosted/);
  assert.deepEqual(h2.actors(), [], "nothing was registered");
  const restarted = new Host(new LocalCore(s), { holder: "svc-a" }); // same logical service after a crash, no close
  await restarted.add({ actor: "agent:w", harness: worker() });
  await restarted.close();
  await h2.add({ actor: "agent:w", harness: worker() }); // released by close
  await h2.close();
  s.close();
});

test("Host: work is processed once even with two hosts trying; the loser never consumes the inbox", async () => {
  const s = world();
  const winner = new Host(new LocalCore(s));
  await winner.add({ actor: "agent:w", skills: ["echo"], harness: worker() });
  const loser = new Host(new LocalCore(s));
  await assert.rejects(loser.add({ actor: "agent:w", skills: ["echo"], harness: worker() }), /already-hosted/);
  runOp(s, "human:alice", "work-request", { context: "c1", id: "w1", skill: "echo", input: '{"n":1}' });
  await winner.settle();
  const w = s.getWork("c1", "w1")!;
  assert.deepEqual([w.status, w.attempt], ["done", 1]);
  await winner.close();
  s.close();
});

test("Host: a takeover fences the old host; its next pass fails loudly and it does not ack", async () => {
  const s = world();
  const old = new Host(new LocalCore(s), { holder: "old", leaseMs: 1000 });
  await old.add({ actor: "agent:w", harness: worker() });
  s.hostRelease("agent:w", "old");
  s.hostLease("agent:w", "new", 60_000); // another process took over while the old one was paused
  runOp(s, "human:alice", "post", { context: "c1", text: "hello" });
  await assert.rejects(old.pump("agent:w"), /already-hosted/);
  assert.equal(s.cursor("c1", "agent:w"), 0, "the cursor did not move");
  s.close();
});

test("HTTP: host-lease and fencing travel as ordinary ops; already-hosted is a 409", async () => {
  const s = world();
  const t = { w: s.issueToken("agent:w") };
  const srv = createCoreServer(s);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  const post = (op: string, body: object) => fetch(`${url}/v1/ops/${op}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t.w}` }, body: JSON.stringify(body) });
  assert.equal((await post("host-lease", { holder: "h1" })).status, 200);
  assert.equal((await post("host-lease", { holder: "h2" })).status, 409);
  assert.equal((await post("inbox", { holder: "h2" })).status, 409);
  assert.equal((await post("inbox", { holder: "h1" })).status, 200);
  const host = new Host(new HttpCore(url, { "agent:w": t.w }));
  await assert.rejects(host.add({ actor: "agent:w", harness: worker() }), /already-hosted/);
  await new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); });
  s.close();
});
