import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_HOPS, MAX_PENDING_SUBMISSIONS, Store } from "../src/core/index.ts";
import { statusFor } from "../src/http/server.ts";
import type { Context } from "../src/core/index.ts";

const ctx = (id: string, kind: Context["kind"], extra: Partial<Context> = {}): Context => ({ id, kind, title: id, goal: "", createdAt: 1, ...extra });

/** alice (everything) and bob (read, write) in realm-infra with channel ch-incidents; carol only in realm-hr. agent:router is a router. */
function world() {
  const s = new Store(":memory:");
  s.createContext(ctx("realm-infra", "realm"), "human:alice");
  s.createContext(ctx("ch-incidents", "channel", { realmId: "realm-infra" }), "human:alice");
  s.join({ contextId: "realm-infra", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, "jb1", "human:alice");
  s.join({ contextId: "ch-incidents", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, "jb2", "human:alice");
  s.createContext(ctx("realm-hr", "realm"), "human:carol");
  s.createContext(ctx("ch-people", "channel", { realmId: "realm-hr" }), "human:carol");
  s.addRouter("agent:router");
  return s;
}
const R = "agent:router";
const types = (s: Store, c: string) => s.eventsSince(c, 0).map((e) => `${e.type}:${e.actorId}`);

test("a submitted message waits in the sender's own ingress; only a router may see the queue", () => {
  const s = world();
  const e = s.submitMessage("human:bob", "k1", "production is down");
  assert.equal(e.contextId, "ingress:human:bob");
  assert.equal(s.submitMessage("human:bob", "k1", "production is down").seq, e.seq, "replays");
  assert.throws(() => s.submitMessage("human:bob", "k2", "  "), /bad-message/);

  assert.deepEqual(s.routePending(R).map((p) => [p.sender, p.text, p.hops, p.classification]), [["human:bob", "production is down", 0, null]]);
  assert.throws(() => s.routePending("human:bob"), /is not a router/);
  assert.throws(() => s.routeTargets("human:bob", "human:bob"), /is not a router/);
  assert.throws(() => s.readEvents("ingress:human:bob", R, 0), /not-a-member/, "a router sees the queue through route ops, not by joining");
  assert.throws(() => s.readEvents("ingress:human:bob", "human:alice", 0), /not-a-member/);
  assert.ok(s.readEvents("ingress:human:bob", "human:bob", 0).length === 1, "the sender sees its own");
  assert.ok(!s.targets("human:bob").some((t) => t.kind === "ingress"), "an ingress is not a destination");
  assert.throws(() => s.createContext(ctx("ingress:human:x", "ingress"), "human:x"), /bad-kind/);
  s.close();
});

test("delivery happens as the sender and only where the sender may write: the router never grants anything", () => {
  const s = world();
  s.submitMessage("human:bob", "k1", "production is down");
  assert.deepEqual(s.routeTargets(R, "human:bob").map((t) => t.id), ["realm-infra", "ch-incidents"], "the classifier sees only what bob may address");

  // a route into carol's realm is refused: bob cannot write there. Nothing is recorded, the message stays pending.
  assert.throws(() => s.routeResolve(R, "ingress:human:bob", "k1", { context: "ch-people" }), /not-a-member: human:bob not in ch-people/);
  assert.equal(s.routePending(R).length, 1);
  assert.equal(s.eventsSince("ch-people", 0).filter((e) => e.type === "message.posted").length, 0);
  assert.ok(!types(s, "ingress:human:bob").some((t) => t.startsWith("route.resolved")));
  assert.throws(() => s.routeResolve(R, "ingress:human:bob", "k1", { context: "ingress:human:bob" }), /not a destination/);

  const r = s.routeResolve(R, "ingress:human:bob", "k1", { context: "ch-incidents" });
  assert.equal(r.data.delivered, true);
  const posted = s.eventsSince("ch-incidents", 0).find((e) => e.type === "message.posted")!;
  assert.equal(posted.actorId, "human:bob", "it reads as bob's message");
  assert.deepEqual([posted.data.text, posted.data.via, posted.data.hops], ["production is down", "route", 0]);
  assert.equal(r.data.deliveredSeq, posted.seq);
  assert.equal(s.routePending(R).length, 0);
  assert.equal(s.routeResolve(R, "ingress:human:bob", "k1", { context: "ch-incidents" }).seq, r.seq, "a replay returns the original");
  assert.equal(s.eventsSince("ch-incidents", 0).filter((e) => e.type === "message.posted").length, 1, "and delivers nothing twice");
  assert.throws(() => s.routeResolve("human:bob", "ingress:human:bob", "k1", { context: "ch-incidents" }), /is not a router/);
  s.close();
});

test("a route can be recorded without delivering (shadow), and a message ends exactly once", () => {
  const s = world();
  s.submitMessage("human:bob", "k1", "production is down");
  s.submitMessage("human:bob", "k2", "lunch?");
  s.routeClassified(R, "ingress:human:bob", "k1", { classifier: { name: "t", version: "1" }, choice: "ch-incidents", confidence: 0.9 });
  assert.equal(s.routePending(R)[0]!.classification!.choice, "ch-incidents", "pending carries the recorded classification");

  const r = s.routeResolve(R, "ingress:human:bob", "k1", { context: "ch-incidents", deliver: false });
  assert.equal(r.type, "route.shadowed", "a shadowed route is not 'resolved': resolved always means delivered");
  assert.deepEqual([r.data.delivered, r.data.deliveredSeq], [false, null]);
  assert.equal(s.routeResolve(R, "ingress:human:bob", "k1", { context: "ch-incidents", deliver: false }).seq, r.seq, "a replay returns the original");
  assert.throws(() => s.routeResolve(R, "ingress:human:bob", "k1", { context: "ch-incidents" }), /already-routed: k1 ended as route.shadowed/);
  assert.throws(() => s.routeUnresolved(R, "ingress:human:bob", "k1", "late"), /already-routed: k1 ended as route.shadowed/);
  assert.equal(s.eventsSince("ch-incidents", 0).filter((e) => e.type === "message.posted").length, 0, "shadow delivers nothing");
  assert.deepEqual(s.routePending(R).map((p) => p.key), ["k2"], "yet the message is no longer pending");

  s.routeUnresolved(R, "ingress:human:bob", "k2", "low-confidence", { confidence: 0.2 });
  assert.throws(() => s.routeResolve(R, "ingress:human:bob", "k2", { context: "ch-incidents" }), /already-routed: k2 ended as route.unresolved/);
  assert.throws(() => s.routeUnresolved(R, "ingress:human:bob", "k1", "late"), /already-routed: k1 ended as route.shadowed/);
  assert.throws(() => s.routeClassified(R, "ingress:human:bob", "k2", {}), /already-routed/);
  assert.throws(() => s.routeResolve(R, "ingress:human:bob", "nope", { context: "ch-incidents" }), /unknown-submission/);
  // the unresolved message stays visible to its sender, who can then clarify
  const mine = s.inbox("human:bob").find((c) => c.context === "ingress:human:bob")!;
  assert.ok(mine.unread >= 3, "the router's records are unread events in bob's ingress");
  assert.ok(types(s, "ingress:human:bob").includes("route.unresolved:agent:router"));
  s.close();
});

test("routing can request work by skill instead of posting a message", () => {
  const s = world();
  s.join({ contextId: "realm-infra", actorId: "agent:k8s", capabilities: ["read", "write"], joinedAt: 3 }, "jk1", "human:alice");
  s.join({ contextId: "ch-incidents", actorId: "agent:k8s", capabilities: ["read", "write"], joinedAt: 3 }, "jk2", "human:alice");
  s.setSkills("agent:k8s", ["k8s.inspect"]);
  s.submitMessage("human:bob", "k1", "inspect the checkout pods");

  assert.throws(() => s.routeResolve(R, "ingress:human:bob", "k1", { context: "ch-incidents", as: "work" }), /work-needs-target/);
  assert.equal(s.routePending(R).length, 1, "a refused route leaves the message pending and records nothing");

  s.routeResolve(R, "ingress:human:bob", "k1", { context: "ch-incidents", as: "work", skill: "k8s.inspect" });
  const w = s.claimNext("ch-incidents", "agent:k8s")!.work;
  assert.deepEqual([w.requestedBy, w.skill, (w.input as { text: string; via: string }).text, (w.input as { via: string }).via], ["human:bob", "k8s.inspect", "inspect the checkout pods", "route"]);
  assert.equal(s.eventsSince("ch-incidents", 0).filter((e) => e.type === "message.posted").length, 0);
  s.close();
});

test("hops are counted along a chain and refused past the limit", () => {
  const s = world();
  s.join({ contextId: "realm-infra", actorId: "agent:k8s", capabilities: ["read", "write"], joinedAt: 3 }, "jk1", "human:alice");
  s.join({ contextId: "ch-incidents", actorId: "agent:k8s", capabilities: ["read", "write"], joinedAt: 3 }, "jk2", "human:alice");
  s.submitMessage("human:bob", "m0", "start");
  let seq = s.routeResolve(R, "ingress:human:bob", "m0", { context: "ch-incidents" }).data.deliveredSeq as number;
  for (let hop = 1; hop <= MAX_HOPS; hop++) {
    const e = s.submitMessage("agent:k8s", `h${hop}`, `follow-up ${hop}`, { context: "ch-incidents", seq });
    assert.equal(e.data.hops, hop);
    seq = s.routeResolve(R, "ingress:agent:k8s", `h${hop}`, { context: "ch-incidents" }).data.deliveredSeq as number;
  }
  assert.throws(() => s.submitMessage("agent:k8s", "h-over", "once more", { context: "ch-incidents", seq }), /hop-limit/);
  assert.equal(s.routePending(R).length, 0, "the refused submission left nothing behind");

  assert.throws(() => s.submitMessage("agent:k8s", "x1", "t", { context: "ch-incidents", seq: 99999 }), /bad-after/);
  assert.throws(() => s.submitMessage("agent:k8s", "x2", "t", { context: "ch-people", seq: 1 }), /not-a-member/, "cannot cite a conversation it cannot read");
  s.close();
});

test("a sender can have only so many messages waiting; a replay still answers; resolving frees a slot", () => {
  const s = world();
  for (let i = 0; i < MAX_PENDING_SUBMISSIONS; i++) s.submitMessage("human:bob", `p${i}`, `message ${i}`);
  assert.throws(() => s.submitMessage("human:bob", "one-too-many", "x"), /too-many-pending/);
  assert.equal(s.submitMessage("human:bob", "p0", "message 0").key, "p0", "a replay of a waiting message is not refused");
  assert.equal(s.submitMessage("human:carol", "c0", "someone else is unaffected").key, "c0");
  s.routeUnresolved(R, "ingress:human:bob", "p0", "no-choice");
  s.submitMessage("human:bob", "one-too-many", "x");
  assert.equal(s.routePending(R, 1000).length, MAX_PENDING_SUBMISSIONS + 1, "99 of bob's old ones, his new one, and carol's");
  s.close();
});

test("CLI and admin: a router is made by the operator, and only a router may use the route ops", () => {
  const db = join(mkdtempSync(join(tmpdir(), "piople-routing-")), "r.sqlite");
  const admin = (...a: string[]) => JSON.parse(execFileSync(process.execPath, ["--no-warnings", "src/cli/admin.ts", "--db", db, ...a], { encoding: "utf8" }));
  const cli = (as: string, ...a: string[]) => JSON.parse(execFileSync(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", db, "--as", as, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  cli("human:bob", "create", "--id", "case-1", "--title", "t");
  const sub = cli("human:bob", "submit", "--text", "where does this go?");
  assert.equal(sub.type, "message.submitted");
  assert.throws(() => cli("agent:router", "route-pending"), /is not a router/);
  assert.deepEqual(admin("add-router", "--actor", "agent:router"), { actor: "agent:router", router: true });
  assert.deepEqual(admin("list-routers"), { routers: ["agent:router"] });
  const pending = cli("agent:router", "route-pending");
  assert.deepEqual(pending.map((p: any) => [p.sender, p.text]), [["human:bob", "where does this go?"]]);
  const targets = cli("agent:router", "route-targets", "--sender", "human:bob");
  assert.deepEqual(targets.map((t: any) => t.id), ["case-1"]);
  cli("agent:router", "route-resolve", "--ingress", pending[0].ingress, "--submitted", pending[0].key, "--context", "case-1");
  assert.deepEqual(cli("agent:router", "route-pending"), []);
  assert.deepEqual(admin("remove-router", "--actor", "agent:router"), { actor: "agent:router", removed: 1 });
  assert.throws(() => cli("agent:router", "route-pending"), /is not a router/);
});

test("an ingress cannot be squatted, router-owned keys and ids cannot collide, and the new limits have honest status codes", () => {
  const s = world();
  assert.throws(() => s.createContext(ctx("ingress:human:alice", "case"), "human:mallory"), /ids starting with ingress: are reserved/);
  // even if such a context somehow existed, submitting must not adopt it
  s.db.prepare(`INSERT INTO actors(id,kind,name) VALUES('human:victim','human','v')`).run();
  s.db.prepare(`INSERT INTO contexts(id,kind,title,goal,created_at) VALUES('ingress:human:victim','case','squat','',1)`).run();
  assert.throws(() => s.submitMessage("human:victim", "k", "hello"), /exists but is not an ingress/);

  for (const key of ["resolved:x", "shadowed:x", "unresolved:x", "classified:x"]) assert.throws(() => s.submitMessage("human:bob", key, "t"), /bad-key/, key);
  // two keys that look alike produce two distinct work items
  s.join({ contextId: "realm-infra", actorId: "agent:k8s", capabilities: ["read", "write"], joinedAt: 3 }, "jk1", "human:alice");
  s.join({ contextId: "ch-incidents", actorId: "agent:k8s", capabilities: ["read", "write"], joinedAt: 3 }, "jk2", "human:alice");
  s.setSkills("agent:k8s", ["k8s.inspect"]);
  s.submitMessage("human:bob", "a b", "first");
  s.submitMessage("human:bob", "a-b", "second");
  for (const key of ["a b", "a-b"]) s.routeResolve(R, "ingress:human:bob", key, { context: "ch-incidents", as: "work", skill: "k8s.inspect" });
  const texts = [s.claimNext("ch-incidents", "agent:k8s")!.work, s.claimNext("ch-incidents", "agent:k8s")!.work].map((w) => (w.input as { text: string }).text).sort();
  assert.deepEqual(texts, ["first", "second"]);

  assert.equal(statusFor("already-routed: k ended as route.resolved").status, 409);
  assert.equal(statusFor("hop-limit: this chain has been routed 5 times already").status, 429);
  assert.equal(statusFor("too-many-pending: human:bob has 100 messages waiting").status, 429);
  s.close();
});

test("the queue holds exactly what still waits: terminal events remove it, replays never bring it back", () => {
  const s = world();
  s.submitMessage("human:bob", "k1", "one");
  s.submitMessage("human:bob", "k2", "two");
  s.submitMessage("human:bob", "k3", "three");
  assert.deepEqual(s.routePending(R).map((p) => p.key), ["k1", "k2", "k3"]);
  s.routeResolve(R, "ingress:human:bob", "k1", { context: "ch-incidents" });
  s.routeResolve(R, "ingress:human:bob", "k2", { context: "ch-incidents", deliver: false });
  assert.deepEqual(s.routePending(R).map((p) => p.key), ["k3"]);
  s.submitMessage("human:bob", "k1", "one"); // the sender retries a submission that was already routed
  s.submitMessage("human:bob", "k2", "two");
  assert.deepEqual(s.routePending(R).map((p) => p.key), ["k3"], "a replay does not re-queue a finished message");
  s.routeUnresolved(R, "ingress:human:bob", "k3", "no-choice");
  assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM route_queue`).get()!.n, 0);
  assert.equal(s.eventsSince("ch-incidents", 0).filter((e) => e.type === "message.posted").length, 1, "only k1 was delivered");
  s.close();
});

test("work made by a route cannot be blocked by someone who takes its id first", async () => {
  const { createHash } = await import("node:crypto");
  const s = world();
  s.join({ contextId: "realm-infra", actorId: "agent:k8s", capabilities: ["read", "write"], joinedAt: 3 }, "jk1", "human:alice");
  s.join({ contextId: "ch-incidents", actorId: "agent:k8s", capabilities: ["read", "write"], joinedAt: 3 }, "jk2", "human:alice");
  s.join({ contextId: "realm-infra", actorId: "human:eve", capabilities: ["read", "write"], joinedAt: 3 }, "je0", "human:alice");
  s.join({ contextId: "ch-incidents", actorId: "human:eve", capabilities: ["read", "write"], joinedAt: 3 }, "je1", "human:alice");
  s.setSkills("agent:k8s", ["k8s.inspect"]);
  s.submitMessage("human:bob", "k1", "inspect the checkout pods");
  // The id the route used to give its work: from the ingress and the submitted key, which the members of the ingress can see.
  const old = `route-${createHash("sha256").update(`ingress:human:bob\0k1`).digest("hex").slice(0, 32)}`;
  s.requestWork("ch-incidents", "human:eve", { id: old, to: null, skill: "k8s.inspect", input: "blocked" }); // the old id could be taken by anyone who writes there
  // Whatever Eve managed, the route goes through and the work is the sender's
  s.routeResolve(R, "ingress:human:bob", "k1", { context: "ch-incidents", as: "work", skill: "k8s.inspect" });
  const routed = `human:bob@route-${old.slice("route-".length)}`;
  const w = s.getWork("ch-incidents", routed)!;
  assert.ok(w, "the routed work exists under the sender's id");
  assert.equal(w.requestedBy, "human:bob");
  assert.equal((w.input as { text: string }).text, "inspect the checkout pods", "the routed message, not what was put under the old id");
  assert.equal((s.getWork("ch-incidents", old)!.input as string), "blocked", "and Eve's work under the old id is just her own work");
  s.close();
});

test("a sender who has never been seen before can submit (no raw database error), and one with the longest actor id can read their own ingress", async () => {
  const { LocalCore } = await import("../src/hosts/host.ts");
  const s = world();
  const core = new LocalCore(s);
  const call = (a: string, op: string, x: Record<string, unknown> = {}) => core.call(a, op, x) as Promise<any>;
  const newcomer = await call("human:newcomer", "submit", { text: "hello, I am new" });
  assert.equal(newcomer.type, "message.submitted");
  const long = `human:${"b".repeat(194)}`; // an actor id of 200 characters
  await call(long, "submit", { text: "hello from a long name" });
  const ingress = `ingress:${long}`;
  assert.equal(ingress.length, 208);
  assert.ok((await call(long, "events", { context: ingress })).length >= 1, "reads its own ingress");
  assert.ok((await call(long, "inbox", { context: ingress })).events.length >= 1);
  s.close();
});
