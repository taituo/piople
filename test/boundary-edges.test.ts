import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { MAX_LEASE_MS } from "../src/core/store.ts";

/**
 * Boundary values found by mutation testing (turning < into <=, > into >= left every test green). Time-dependent logic
 * takes its clock as an argument, so the exact edge is testable: a lease that ends AT `now` is still held; one tick
 * later it is free.
 */
function world() {
  const s = new Store(":memory:");
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  for (const a of ["agent:w1", "agent:w2"]) {
    s.upsertActor({ id: a, kind: "agent", name: a });
    s.join({ contextId: "c1", actorId: a, capabilities: ["read", "write"], joinedAt: 2 }, `j-${a}`, "human:alice");
    s.setSkills(a, ["job"]);
  }
  return s;
}

test("a claim lease ends after its last millisecond: at the edge it is still held, one tick later it is free", () => {
  const s = world();
  s.requestWork("c1", "human:alice", { id: "w1", skill: "job", input: {} });
  const t0 = 1_000_000;
  s.claimWork("c1", "agent:w1", "w1", 1000, t0); // leaseUntil = t0 + 1000
  assert.throws(() => s.claimWork("c1", "agent:w2", "w1", 1000, t0 + 1000), /already claimed/, "at the edge the holder still has it");
  assert.equal(s.claimWork("c1", "agent:w1", "w1", 1000, t0 + 1000).work.attempt, 1, "the holder re-claims its own live claim at the edge: same attempt");
  assert.deepEqual(s.listWork("agent:w2", { context: "c1", status: "claimable" }, t0 + 1000).map((w) => w.id), [], "not claimable at the edge");
  assert.deepEqual(s.listWork("agent:w2", { context: "c1", status: "claimable" }, t0 + 1001).map((w) => w.id), ["w1"], "claimable one tick later");
  assert.equal(s.claimWork("c1", "agent:w2", "w1", 1000, t0 + 1001).work.attempt, 2, "taken over as attempt 2");
  s.close();
});

test("an inbox lease is over at its expiry instant: one tick before another host is refused, at the instant it takes over", () => {
  const s = world();
  const t0 = 5_000_000;
  const lease = s.hostLease("agent:w1", "host-a", 1000, t0); // expires at t0 + 1000
  assert.equal(lease.expiresAt, t0 + 1000);
  assert.throws(() => s.hostLease("agent:w1", "host-b", 1000, t0 + 999), /already-hosted/, "one tick before the expiry the lease still holds");
  const takeover = s.hostLease("agent:w1", "host-b", 1000, t0 + 1000); // expires_at > now is false: the lease is over
  assert.equal(takeover.epoch, 2, "at the expiry instant host-b takes over");
  assert.equal(takeover.expiresAt, t0 + 2000);
  // requireHolder uses the same edge: the holder is always fine, a stranger is refused until the lease is over
  assert.doesNotThrow(() => s.requireHolder("agent:w1", "host-b", t0 + 1500));
  assert.throws(() => s.requireHolder("agent:w1", "host-a", t0 + 1500), /already-hosted/);
  assert.throws(() => s.requireHolder("agent:w1", "host-a", t0 + 1999), /already-hosted/, "one tick before host-b's lease ends");
  assert.doesNotThrow(() => s.requireHolder("agent:w1", "host-a", t0 + 2000), "at the instant it ends nobody is excluded");
  s.close();
});

test("limits accept exactly the maximum and refuse one more", () => {
  const s = world();
  s.requestWork("c1", "human:alice", { id: "w1", skill: "job", input: {} });
  s.requestWork("c1", "human:alice", { id: "w2", skill: "job", input: {} });
  assert.throws(() => s.claimWork("c1", "agent:w1", "w1", MAX_LEASE_MS + 1), /bad-lease/);
  assert.equal(s.claimWork("c1", "agent:w1", "w1", MAX_LEASE_MS).work.attempt, 1, "the longest lease is allowed");
  assert.throws(() => s.claimWork("c1", "agent:w2", "w2", 0), /bad-lease/);
  assert.equal(s.claimWork("c1", "agent:w2", "w2", 1).work.attempt, 1, "one millisecond is allowed");
  // ttl of an inbox lease: 1 .. 3,600,000
  assert.throws(() => s.hostLease("agent:w1", "h", 0), /bad-ttl/);
  assert.throws(() => s.hostLease("agent:w1", "h", 3_600_001), /bad-ttl/);
  s.hostLease("agent:w1", "h", 1);
  s.hostLease("agent:w1", "h", 3_600_000);
  // holder id: at most 200 characters
  assert.throws(() => s.hostLease("agent:w2", "h".repeat(201), 1000), /bad-holder/);
  s.hostLease("agent:w2", "h".repeat(200), 1000);
  // context id: at most 200 characters
  assert.throws(() => s.createContext({ id: "x".repeat(201), kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice"), /bad-context/);
  s.createContext({ id: "x".repeat(200), kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  // skills: 100 of 200 characters
  s.setSkills("agent:w1", Array.from({ length: 100 }, (_, i) => `k${i}`));
  assert.throws(() => s.setSkills("agent:w1", Array.from({ length: 101 }, (_, i) => `k${i}`)), /bad-skills/);
  s.setSkills("agent:w1", ["s".repeat(200)]);
  assert.throws(() => s.setSkills("agent:w1", ["s".repeat(201)]), /bad-skills/);
  // a read cursor: 0 is fine, below 0 is not
  s.ack("c1", "human:alice", 0);
  assert.throws(() => s.ack("c1", "human:alice", -1), /bad-seq/);
  s.close();
});

test("a token's last use is written at most once a minute: at exactly one minute it is written again", () => {
  const s = world();
  const token = s.issueToken("human:alice");
  const used = () => (s.db.prepare("SELECT last_used_at FROM tokens WHERE actor_id='human:alice'").get() as { last_used_at: number | null }).last_used_at;
  const t0 = 9_000_000;
  s.actorForToken(token, t0);
  assert.equal(used(), t0);
  s.actorForToken(token, t0 + 59_999);
  assert.equal(used(), t0, "not rewritten within the minute");
  s.actorForToken(token, t0 + 60_000);
  assert.equal(used(), t0 + 60_000, "rewritten at exactly one minute");
  s.close();
});
