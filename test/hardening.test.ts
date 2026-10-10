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
  await assert.rejects(alice("create", { id: "x".repeat(201), title: "t" }), /bad-context/);
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
