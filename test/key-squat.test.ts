import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { SyntheticHarness, behave } from "../src/harnesses/synthetic.ts";

const setup = () => {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const call = (a: string, op: string, x: Record<string, unknown> = {}) => core.call(a, op, x) as Promise<any>;
  return { store, core, call };
};

test("a plain writer cannot squat the keys a Host derives for another actor, so it cannot silence that actor", async () => {
  const { store, core, call } = setup();
  await call("human:alice", "create", { id: "c1", title: "t" });
  await call("human:alice", "join", { context: "c1", actor: "agent:x", caps: "read,write" });
  await call("human:alice", "join", { context: "c1", actor: "human:eve", caps: "read,write" });
  for (let n = 1; n <= 3; n++) {
    await assert.rejects(call("human:eve", "post", { context: "c1", text: "squatted", key: `agent:x@c1#0.${n}` }), /^Error: forbidden: a key that starts with an actor id/);
  }
  const host = new Host(core, { pollMs: 5 });
  const errors: string[] = [];
  host.onError = (e) => errors.push(String((e.error as Error).message));
  await host.add({ actor: "agent:x", harness: new SyntheticHarness({ behaviors: [behave.replyTo(/hello/, "hi back")] }) });
  await call("human:alice", "post", { context: "c1", text: "hello agent" });
  await host.settle();
  assert.deepEqual(errors, []);
  assert.deepEqual(store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:x" && e.type === "message.posted").map((e) => e.data.text), ["hi back"]);
  store.close();
});

test("an actor may use keys under its own id, also when the id itself contains an @, and other keys stay free for everyone", async () => {
  const { store, call } = setup();
  await call("human:alice", "create", { id: "c1", title: "t" });
  await call("human:alice", "join", { context: "c1", actor: "agent:a@b", caps: "read,write" });
  await call("human:alice", "join", { context: "c1", actor: "agent:a", caps: "read,write" });
  await call("agent:a@b", "post", { context: "c1", text: "mine", key: "agent:a@b@c1#0.1" });
  await call("agent:a", "post", { context: "c1", text: "mine too", key: "agent:a@c1#0.1" });
  await assert.rejects(call("agent:a", "post", { context: "c1", text: "not mine", key: "agent:a@b@c1#0.2" }), /forbidden/, "agent:a is not agent:a@b");
  await call("human:alice", "post", { context: "c1", text: "plain", key: "anything:goes@here" });
  await call("human:alice", "post", { context: "c1", text: "no prefix", key: "human-ish" });
  store.close();
});

test("the ids a Host mints (decisions, work, observations, contexts) cannot be taken by someone else first either", async () => {
  const { store, core, call } = setup();
  await call("human:alice", "create", { id: "c1", title: "t" });
  await call("human:alice", "join", { context: "c1", actor: "agent:x", caps: "read,write" });
  await call("human:alice", "join", { context: "c1", actor: "human:eve", caps: "read,write,decide" });
  const id = "agent:x@c1#0.1";
  await assert.rejects(call("human:eve", "decision-request", { context: "c1", id, question: "q", options: "a,b" }), /forbidden/);
  await assert.rejects(call("human:eve", "work-request", { context: "c1", id, to: "agent:x", input: "{}" }), /forbidden/);
  await assert.rejects(call("human:eve", "create", { id, title: "taken first" }), /forbidden/);
  const errors: string[] = [];
  const host = new Host(core, { pollMs: 5 });
  host.onError = (e) => errors.push(String((e.error as Error).message));
  await host.add({ actor: "agent:x", harness: new SyntheticHarness({ behaviors: [async (s) => { if (s.events.some((e) => /ask me/.test(String(e.data.text ?? "")))) await s.run("decision-request", { question: "ship?", options: "yes,no" }); }] }) });
  await call("human:alice", "post", { context: "c1", text: "ask me" });
  await host.settle();
  assert.deepEqual(errors, []);
  assert.equal(store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:x" && e.type === "decision.requested").length, 1);
  // normal ids are unaffected
  await call("human:eve", "decision-request", { context: "c1", id: "d-plain", question: "q", options: "a,b" });
  store.close();
});

test("a writer cannot take Core's own predictable keys (claim:, complete:, fail:, decision:, …) to block work", async () => {
  const { store, call } = setup();
  await call("human:alice", "create", { id: "c1", title: "t" });
  await call("human:alice", "join", { context: "c1", actor: "agent:w", caps: "read,write" });
  await call("human:alice", "join", { context: "c1", actor: "human:eve", caps: "read,write" });
  await call("human:alice", "work-request", { context: "c1", id: "w1", to: "agent:w", input: "{}" });
  for (const key of ["claim:w1:1", "complete:w1:1", "fail:w1:1", "decision:d9", "work:w2", "create:x", "classified:k", "unresolved:k", "resolved:k", "shadowed:k", "route:i", "presence:p", "promote:a:b", "artifact:a", "proposal:a"]) {
    await assert.rejects(call("human:eve", "post", { context: "c1", text: "squat", key }), /bad-arg: key .* starts with a prefix Core uses/, key);
  }
  const claimed = await call("agent:w", "work-claim", { context: "c1", id: "w1" });
  assert.equal(claimed.work.id, "w1", "the worker claims it");
  await call("agent:w", "work-complete", { context: "c1", id: "w1", attempt: claimed.work.attempt, result: "1" });
  // keys that merely look similar stay free
  await call("human:eve", "post", { context: "c1", text: "ok", key: "claims:w1" });
  await call("human:eve", "post", { context: "c1", text: "ok", key: "my-claim:w1:1" });
  store.close();
});

test("the ids the Temporal activities derive from a workflow key cannot be taken first by a writer who guesses the key", async () => {
  const { createActivities, workIdFor, decisionIdFor } = await import("../src/adapters/temporal/activities.ts");
  const { store, core, call } = setup();
  await call("human:alice", "create", { id: "c1", title: "t" });
  await call("agent:orchestrator", "actor").catch(() => {});
  await call("human:alice", "join", { context: "c1", actor: "agent:orchestrator", caps: "read,write,decide" });
  await call("human:alice", "join", { context: "c1", actor: "agent:echo", caps: "read,write" });
  await call("human:alice", "join", { context: "c1", actor: "human:eve", caps: "read,write,decide" });
  // Eve knows the workflow's key ("order-17:approve") and takes both ids the old way, with the bare hash
  await call("human:eve", "work-request", { context: "c1", id: workIdFor("order-17:approve"), to: "agent:echo", input: "{}" });
  await call("human:eve", "decision-request", { context: "c1", id: decisionIdFor("order-17:approve"), question: "taken", options: "a,b" });
  const acts = createActivities(core, "agent:orchestrator");
  const w = await acts.requestWork({ context: "c1", to: "agent:echo", input: { n: 1 }, key: "order-17:approve" });
  const d = await acts.requestDecision({ context: "c1", question: "ok?", key: "order-17:approve" });
  assert.equal(w.workId, `agent:orchestrator@${workIdFor("order-17:approve")}`);
  assert.equal(d.decisionId, `agent:orchestrator@${decisionIdFor("order-17:approve")}`);
  assert.equal((await acts.requestWork({ context: "c1", to: "agent:echo", input: { n: 1 }, key: "order-17:approve" })).workId, w.workId, "still idempotent");
  // and Eve cannot take the new form
  await assert.rejects(call("human:eve", "work-request", { context: "c1", id: w.workId, to: "agent:echo", input: "{}" }), /forbidden/);
  await assert.rejects(call("human:eve", "decision-request", { context: "c1", id: d.decisionId, question: "x", options: "a,b" }), /forbidden/);
  store.close();
});
