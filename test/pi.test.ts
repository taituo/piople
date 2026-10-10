import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import type { CoreClient } from "../src/hosts/types.ts";
import { PiHarness, parseCommands } from "../src/harnesses/pi.ts";
import { fakeModel, lastUser } from "./fake-model.ts";

const piOpts = (baseUrl: string, dir = ":memory:") => ({ actor: "agent:pi", dir, role: "You are a careful analyst.", provider: { baseUrl }, modelId: "fake-1" });
const world = () => {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  return { store, core, alice };
};
const posts = (s: Store) => s.eventsSince("c1", 0).filter((e) => e.type === "message.posted" && e.actorId === "agent:pi").map((e) => e.data.text);

test("parseCommands: command lines, continuations, noise and control tokens", () => {
  assert.deepEqual(parseCommands("thinking...\nPOST: hello\nsecond line\nASK: agent:x | why?<ds_s>\nNOOP"), [
    { cmd: "POST", rest: "hello\nsecond line" },
    { cmd: "ASK", rest: "agent:x | why?" },
  ]);
  assert.deepEqual(parseCommands("NOOP"), []);
});

test("a Pi agent reads the case through the host and answers with protocol commands", async () => {
  const { store, alice } = world();
  const model = await fakeModel(() => "Let me answer.\nPOST: hello from pi");
  const host = new Host(new LocalCore(store));
  const pi = await PiHarness.open(piOpts(model.baseUrl));
  await host.add({ actor: "agent:pi", harness: pi });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("post", { context: "c1", text: "hi pi, what is the capital of Finland?" });
  await host.settle();
  assert.deepEqual(posts(store), ["hello from pi"]);
  const sys = JSON.stringify(model.requests[0]![0]);
  assert.match(sys, /careful analyst/);
  assert.match(sys, /agent:pi/);
  assert.match(sys, /DECIDE:/, "the full protocol is in the system text");
  assert.match(lastUser(model.requests[0]!), /capital of Finland/);
  assert.equal(pi.usage.calls, 1);
  assert.deepEqual([pi.usage.input, pi.usage.output], [10, 5]);
  await host.close();
  await model.close();
  store.close();
});

test("Core refuses what the agent lacks the right for, and tells the model", async () => {
  const { store, alice } = world();
  const model = await fakeModel((_m, n) => (n === 1 ? "DECIDE: d1 | yes" : "NOOP"));
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await PiHarness.open(piOpts(model.baseUrl)) });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("decision-request", { context: "c1", id: "d1", question: "ship?" });
  await host.settle();
  assert.equal(store.getDecision("c1", "d1")!.status, "open");
  assert.equal(model.requests.length, 2, "the refusal went back to the model for a second round");
  assert.match(lastUser(model.requests[1]!), /REFUSED DECIDE: .*lacks decide/);
  await host.close();
  await model.close();
  store.close();
});

test("work: claim, see the input, finish with the attempt it was given", async () => {
  const { store, alice } = world();
  const model = await fakeModel((m, n) => (n === 1 ? "CLAIM: w1" : /Claimed w1, attempt 1/.test(lastUser(m)) ? 'DONE: w1 | 1 | {"answer":42}' : "NOOP"));
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", skills: ["maths"], harness: await PiHarness.open(piOpts(model.baseUrl)) });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("work-request", { context: "c1", id: "w1", skill: "maths", input: '{"q":"6*7"}' });
  await host.settle();
  const w = store.getWork("c1", "w1")!;
  assert.deepEqual([w.status, w.attempt, w.result], ["done", 1, { answer: 42 }]);
  assert.match(lastUser(model.requests[0]!), /WORK YOU MAY TAKE w1 \(skill maths\)/);
  await host.close();
  await model.close();
  store.close();
});

test("a command Core cannot run right now goes back to the model; the delivery still completes", async () => {
  const { store, alice } = world();
  const model = await fakeModel((_m, n) => (n === 1 ? "POST: one\nPOST: two" : "NOOP"));
  const local = new LocalCore(store);
  let breakOnce = true;
  const flaky: CoreClient = {
    async call(as, op, args) {
      if (op === "post" && args?.text === "two" && breakOnce) { breakOnce = false; throw new Error("core unreachable"); }
      return local.call(as, op, args);
    },
  };
  const host = new Host(flaky);
  const errors: string[] = [];
  host.onError = (e) => errors.push(String((e.error as Error).message));
  const pi = await PiHarness.open(piOpts(model.baseUrl));
  await host.add({ actor: "agent:pi", harness: pi });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("post", { context: "c1", text: "go" });
  await host.settle();
  // a failing command is feedback for the model, not a failed delivery
  assert.equal(errors.length, 0);
  assert.deepEqual(posts(store), ["one"]);
  assert.match(lastUser(model.requests.at(-1)!), /REFUSED POST: core unreachable/);
  await host.close();
  await model.close();
  store.close();
});

test("the same delivery replayed reuses the stored reply: no tokens, no duplicate events", async () => {
  const { store, core, alice } = world();
  const model = await fakeModel(() => "POST: one\nASK: human:alice | still there?");
  const pi = await PiHarness.open(piOpts(model.baseUrl));
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("post", { context: "c1", text: "go" });
  await core.call("agent:pi", "actor", {});
  const detail = (await core.call("agent:pi", "inbox", { context: "c1" })) as any;
  const mk = () => {
    let n = 0;
    return { actor: "agent:pi", context: "c1", cursor: detail.cursor, events: detail.events, pending: detail.pending,
      run: async (op: string, a: Record<string, unknown> = {}) => core.call("agent:pi", op, { context: "c1", ...(["post", "ask"].includes(op) ? { key: `k${++n}` } : {}), ...a }) as any };
  };
  await pi.step(mk());
  const events = store.eventsSince("c1", 0).length;
  await pi.step(mk()); // a retry of the identical delivery
  assert.equal(model.requests.length, 1, "the model was asked once");
  assert.equal(pi.usage.calls, 1);
  assert.equal(store.eventsSince("c1", 0).length, events, "same keys, so Core replayed instead of appending");
  await pi.close();
  await model.close();
  store.close();
});

test("restart: a new process reopens the same conversation and the model sees the history", async () => {
  const { store, core, alice } = world();
  const dir = mkdtempSync(join(tmpdir(), "piople-pi-"));
  const model = await fakeModel((_m, n) => `POST: reply ${n}`);
  const host1 = new Host(core);
  await host1.add({ actor: "agent:pi", harness: await PiHarness.open(piOpts(model.baseUrl, dir)) });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("post", { context: "c1", text: "my favourite colour is JUNIPER" });
  await host1.settle();
  await host1.close(); // the process ends

  const host2 = new Host(core);
  await host2.add({ actor: "agent:pi", harness: await PiHarness.open(piOpts(model.baseUrl, dir)) });
  await alice("post", { context: "c1", text: "what did I just tell you?" });
  await host2.settle();
  const history = JSON.stringify(model.requests.at(-1));
  assert.match(history, /JUNIPER/, "the durable conversation survived");
  assert.match(history, /what did I just tell you/);
  assert.equal(model.requests.length, 2, "and the old delivery was not replayed");
  assert.deepEqual(posts(store), ["reply 1", "reply 2"]);
  await host2.close();
  await model.close();
  store.close();
});

test("NOOP and nothing-owed deliveries leave no trace and cost nothing", async () => {
  const { store, alice } = world();
  const model = await fakeModel(() => "NOOP");
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await PiHarness.open(piOpts(model.baseUrl)) });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("post", { context: "c1", text: "fyi" });
  const before = store.eventsSince("c1", 0).length;
  await host.settle();
  assert.equal(store.eventsSince("c1", 0).length, before);
  assert.equal(model.requests.length, 1);
  await host.close();
  await model.close();
  store.close();
});

test("a failed model call is an error, not an empty answer: the delivery is retried with a fresh request", async () => {
  const { store, alice } = world();
  const model = await fakeModel((_m, n) => (n === 1 ? { status: 401 } : "POST: ok now"));
  const host = new Host(new LocalCore(store));
  const errors: string[] = [];
  host.onError = (e) => errors.push(String((e.error as Error).message));
  const pi = await PiHarness.open(piOpts(model.baseUrl));
  await host.add({ actor: "agent:pi", harness: pi });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("post", { context: "c1", text: "hello?" });
  await host.tick();
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /model call failed: .*401/);
  assert.deepEqual(posts(store), [], "nothing was posted and nothing was memoized");
  assert.equal(pi.usage.calls, 0, "a failed call is not counted as a call");
  await host.settle();
  assert.deepEqual(posts(store), ["ok now"]);
  assert.equal(model.requests.length, 2);
  await host.close();
  await model.close();
  store.close();
});
