import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { LocalCore } from "../src/hosts/host.ts";
import { opDef } from "../src/ops.ts";

/** Found by probing the Core with hostile and sloppy input. */
function world() {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const as = (a: string) => (op: string, args: Record<string, unknown> = {}) => core.call(a, op, args) as Promise<any>;
  return { store, alice: as("human:alice"), bob: as("human:bob"), as };
}

test("a decision can only be answered with one of its options", async () => {
  const { alice, bob, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("decision-request", { context: "c1", id: "d1", question: "ok?", options: "yes,no" });
  await assert.rejects(alice("decide", { context: "c1", decision: "d1", answer: "maybe" }), /bad-answer/);
  assert.equal(store.getDecision("c1", "d1")!.status, "open", "a refused answer leaves the decision open");
  await alice("decide", { context: "c1", decision: "d1", answer: "no" });
  assert.equal(store.getDecision("c1", "d1")!.status, "resolved");
  await alice("decision-request", { context: "c1", id: "d2", question: "no options given?" }); // the default options are yes,no
  await assert.rejects(alice("decide", { context: "c1", decision: "d2", answer: "whatever" }), /bad-answer: "whatever" is not one of yes, no/);
  await alice("decide", { context: "c1", decision: "d2", answer: "yes" });
  void bob;
  store.close();
});

test("ids and actors are validated at the door", async () => {
  const { alice, as, store } = world();
  await assert.rejects(alice("create", { id: " ", title: "t" }), /missing|bad-context/);
  await assert.rejects(alice("create", { id: "x".repeat(201), title: "t" }), /too-large: id|bad-context/);
  await assert.rejects(as("justabob")("actor"), /bad-actor/);
  await assert.rejects(as("")("actor"), /bad-actor/);
  await alice("create", { id: "c1", title: "t" });
  await assert.rejects(alice("join", { context: "c1", actor: "mallory", caps: "read" }), /bad-actor/);
  await assert.rejects(alice("work-request", { context: "c1", to: "nobody-prefix", input: "{}" }), /bad-actor/);
  store.close();
});

test("text must be text: blank and structured values are refused, not stored as [object Object]", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await assert.rejects(alice("post", { context: "c1", text: "   " }), /missing: text/);
  await assert.rejects(alice("post", { context: "c1", text: { a: 1 } }), /bad-arg/);
  await assert.rejects(alice("post", { context: "c1", text: ["a"] }), /bad-arg/);
  await alice("post", { context: "c1", text: "😀 ok" });
  assert.ok(!store.eventsSince("c1", 0).some((e) => JSON.stringify(e.data).includes("[object Object]")));
  store.close();
});

test("a membership needs at least one capability", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await assert.rejects(alice("join", { context: "c1", actor: "human:bob", caps: "" }), /bad-caps/);
  store.close();
});

test("op names that exist on every object are not ops", async () => {
  const { alice, store } = world();
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(opDef(name), undefined, name);
    await assert.rejects(alice(name), /unknown-op/, name);
  }
  store.close();
});

test("reusing an id in another context is a clean conflict, not a database error", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("create", { id: "c2", title: "t" });
  await alice("decision-request", { context: "c1", id: "d1", question: "first?" });
  await assert.rejects(alice("decision-request", { context: "c2", id: "d1", question: "second?" }), /^Error: id-in-use: that decision id already exists/);
  await alice("observe", { context: "c1", id: "o1", text: "one" });
  await assert.rejects(alice("observe", { context: "c2", id: "o1", text: "two" }), /id-in-use/);
  const { statusFor } = await import("../src/http/server.ts");
  assert.deepEqual(statusFor("id-in-use: that decision id already exists"), { status: 409, code: "conflict" });
  assert.equal(store.getDecision("c1", "d1")!.status, "open", "the original is untouched");
  assert.equal(store.getDecision("c2", "d1"), undefined, "nothing was half-written in the other context");
  store.close();
});

test("size limits hold for every caller, not only HTTP: a huge title, id or message is refused with too-large", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await assert.rejects(alice("create", { id: "c2", title: "x".repeat(2_001) }), /^Error: too-large: title is 2001 characters, the limit is 2000/);
  await assert.rejects(alice("post", { context: "c1", text: "y".repeat(1_000_001) }), /too-large: text/);
  await assert.rejects(alice("work-request", { context: "c1", to: "human:alice", input: { a: "z".repeat(1_100_000) } as never }), /too-large: input/);
  await alice("post", { context: "c1", text: "y".repeat(1_000_000) }); // generous: the limit itself is allowed
  await alice("create", { id: "c3", title: "x".repeat(2_000) });
  const { statusFor } = await import("../src/http/server.ts");
  assert.deepEqual(statusFor("too-large: text is 5 characters, the limit is 1"), { status: 413, code: "too-large" });
  store.close();
});

test("promote takes only confirmed or refuted; anything else is refused and the finding keeps its status", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("observe", { context: "c1", id: "o1", text: "the pool is empty" });
  for (const bad of ["banana", "CONFIRMED", "hypothesis", "confirmed "]) await assert.rejects(alice("promote", { artifact: "o1", status: bad }), /bad-status/, bad);
  const status = () => (store.db.prepare("SELECT status FROM artifacts WHERE id='o1'").get() as { status: string }).status;
  assert.equal(status(), "hypothesis", "nothing changed");
  await alice("promote", { artifact: "o1", status: "confirmed" });
  assert.equal(status(), "confirmed");
  await alice("promote", { artifact: "o1", status: "refuted" });
  assert.equal(status(), "refuted", "a finding may still be refuted later");
  store.close();
});

test("presence: the state and echo flag are checked; a typo must not silently turn echo off", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  for (const bad of ["banana", "AWAY", "Active"]) await assert.rejects(alice("presence", { state: bad }), /bad-state/, bad);
  for (const bad of ["yes", "1", "maybe", 2]) await assert.rejects(alice("presence", { state: "away", echo: bad }), /bad-echo/, String(bad));
  const row = () => store.db.prepare("SELECT state, echo FROM presence WHERE actor_id='human:alice'").get() as { state: string; echo: number } | undefined;
  assert.equal(row(), undefined, "refused calls changed nothing");
  await alice("presence", { state: "away", echo: "true" });
  assert.deepEqual({ ...row() }, { state: "away", echo: 1 });
  await alice("presence", { state: "active", echo: false });
  assert.deepEqual({ ...row() }, { state: "active", echo: 0 });
  await alice("presence", { state: "silent" }); // echo omitted: off
  assert.deepEqual({ ...row() }, { state: "silent", echo: 0 });
  store.close();
});

test("yes/no arguments are true or false; a typo is an error, so `retry yes` cannot silently end a work item for good", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("work-request", { context: "c1", id: "w1", to: "human:alice", input: "{}" });
  const claim = await alice("work-claim", { context: "c1", id: "w1" });
  for (const bad of ["yes", "1", "True", "TRUE", 1]) await assert.rejects(alice("work-fail", { context: "c1", id: "w1", attempt: claim.work.attempt, reason: "x", retry: bad }), /bad-flag/, String(bad));
  assert.equal(store.getWork("c1", "w1")!.status, "claimed", "the refused calls changed nothing");
  await alice("work-fail", { context: "c1", id: "w1", attempt: claim.work.attempt, reason: "flaky", retry: "true" });
  assert.equal(store.getWork("c1", "w1")!.status, "open", "retry true reopens the work");
  await assert.rejects(alice("work-claim", { context: "c1", next: "yes" }), /bad-flag/);
  store.close();
});

test("comma-separated lists are trimmed: options 'yes, no' means yes and no, caps 'read, write' means read and write", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("decision-request", { context: "c1", id: "d1", question: "q?", options: "yes, no," });
  assert.deepEqual(store.pending("c1", "human:alice").decisions[0]!.options, ["yes", "no"]);
  await alice("decide", { context: "c1", decision: "d1", answer: "no" });
  for (const blank of [",", " ", " , "]) await assert.rejects(alice("decision-request", { context: "c1", id: "d2", question: "q?", options: blank }), /bad-options/, JSON.stringify(blank));
  await alice("join", { context: "c1", actor: "human:bob", caps: " read , write " });
  assert.deepEqual(JSON.parse((store.db.prepare("SELECT capabilities FROM members WHERE actor_id='human:bob'").get() as { capabilities: string }).capabilities), ["read", "write"]);
  store.close();
});
