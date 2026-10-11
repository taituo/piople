import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import type { CoreClient } from "../src/hosts/types.ts";
import { PiHarness, parseCommands, renderStep } from "../src/harnesses/pi.ts";
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

test("a reply with no command and no NOOP is not silence: the model is told once and can still answer", async () => {
  const { store, alice } = world();
  const model = await fakeModel((_m, n) => (n === 1 ? "The capital of Finland is Helsinki." : n === 2 ? "POST: Helsinki" : "NOOP"));
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await PiHarness.open(piOpts(model.baseUrl)) });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("post", { context: "c1", text: "capital of Finland?" });
  await host.settle();
  assert.match(lastUser(model.requests[1]!), /contained no command line/);
  assert.deepEqual(posts(store), ["Helsinki"]);
  await host.close();
  await model.close();
  store.close();
});

test("the reminder is given once per delivery: a model that keeps writing prose does not loop", async () => {
  const { store, alice } = world();
  const model = await fakeModel(() => "just prose, no commands");
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await PiHarness.open(piOpts(model.baseUrl)) });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("post", { context: "c1", text: "hello" });
  await host.settle();
  assert.equal(model.requests.length, 2, "one reply and one reminder, then it stops");
  assert.deepEqual(posts(store), []);
  await host.close();
  await model.close();
  store.close();
});

test("a model that answers a message with ANSWER is told to use POST, and recovers", async () => {
  const { store, alice } = world();
  const model = await fakeModel((m, n) => (n === 1 ? "ANSWER: capital of Finland? | Helsinki" : /write POST:/.test(lastUser(m)) ? "POST: Helsinki" : "NOOP"));
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await PiHarness.open(piOpts(model.baseUrl)) });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("post", { context: "c1", text: "capital of Finland?" });
  await host.settle();
  assert.match(lastUser(model.requests[1]!), /REFUSED ANSWER: unknown-request: .* ANSWER is only for an ask listed under "Owed to you"\. To reply to a message, write POST/);
  assert.deepEqual(posts(store), ["Helsinki"]);
  await host.close();
  await model.close();
  store.close();
});

test("a model that accepts the request and never answers fails the delivery after runTimeoutMs instead of hanging for ever", async () => {
  const http = await import("node:http");
  const sockets: Array<{ destroy(): void }> = [];
  const srv = http.createServer(() => { /* never answers */ });
  srv.on("connection", (c) => sockets.push(c));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`;
  const { store, alice } = world();
  const errors: string[] = [];
  const host = new Host(new LocalCore(store));
  host.onError = (e) => errors.push(String((e.error as Error).message));
  await host.add({ actor: "agent:pi", harness: await PiHarness.open({ ...piOpts(baseUrl), runTimeoutMs: 400 }) });
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("post", { context: "c1", text: "hello?" });
  const t0 = Date.now();
  await host.tick();
  assert.ok(Date.now() - t0 < 5_000, `the delivery gave up after ${Date.now() - t0} ms`);
  assert.ok(errors.some((m) => /model call failed: no answer within 400 ms/.test(m)), `reported: ${JSON.stringify(errors)}`);
  for (const c of sockets) c.destroy();
  srv.close();
  store.close();
  process.exitCode ||= 0;
});

test("what is owed to a Pi agent is clipped in the prompt: a flood of long asks, decisions and work cannot make every model call enormous", () => {
  const long = "q".repeat(19_000);
  const step = {
    actor: "agent:pi", context: "c1", cursor: 0, events: [],
    pending: {
      assistance: Array.from({ length: 50 }, (_, i) => ({ key: `a${i}`, from: "human:alice", question: long, seq: i + 1 })),
      decisions: [{ id: "d1", question: "ship?", options: Array.from({ length: 2_000 }, (_, j) => `option-number-${j}`), requestedBy: "human:alice" }],
      work: { open: [{ id: "w1", from: "human:alice", skill: null, to: "agent:pi", input: { blob: "z".repeat(150_000) } }], mine: [] },
    },
    run: async () => ({}),
  } as never;
  const text = renderStep(step)!;
  assert.ok(text.length < 60_000, `the prompt was ${text.length} characters`);
  assert.match(text, /ASK a0 from human:alice: q+ … \[\d+ more characters/, "a long line says it was clipped");
  assert.match(text, /\(\d+ more owed to you, not shown here/, "and the rest is counted");
  assert.match(text, /ASK a0 /, "the first is always there");
  const small = renderStep({ ...(step as object), pending: { assistance: [{ key: "a1", from: "human:bob", question: "what time?", seq: 1 }], decisions: [], work: { open: [], mine: [] } } } as never)!;
  assert.match(small, /ASK a1 from human:bob: what time\?/, "short ones are untouched");
  assert.doesNotMatch(small, /more characters|not shown/);
});

test("after a model round times out the agent recovers: the stuck request is given up on and the next try is sent and answered", async () => {
  const http = await import("node:http");
  const real = await fakeModel(() => "POST: hello back");
  let seen = 0;
  const held: Array<{ destroy(): void }> = [];
  const proxy = http.createServer(async (req, res) => {
    seen++;
    let b = "";
    req.on("data", (d) => (b += d));
    await new Promise((r) => req.on("end", r));
    if (seen === 1) { held.push(req.socket); return; } // the first request is accepted and never answered
    const r = await fetch(real.baseUrl + req.url!.replace(/^\/v1/, ""), { method: "POST", headers: { "content-type": "application/json" }, body: b });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "text/event-stream" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1`;
  const { store, alice } = world();
  const errors: string[] = [];
  const host = new Host(new LocalCore(store));
  host.onError = (e) => errors.push(String((e.error as Error).message));
  try {
    await host.add({ actor: "agent:pi", harness: await PiHarness.open({ ...piOpts(baseUrl), runTimeoutMs: 400 }) });
    await alice("create", { id: "c1", title: "t" });
    await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
    await alice("post", { context: "c1", text: "hello?" });
    await host.tick(); // times out
    assert.ok(errors.some((m) => /no answer within 400 ms/.test(m)));
    await host.tick(); // must go out as a new request and be answered
    assert.equal(seen, 2, "the retry was sent (before the fix it queued behind the stuck run and never left)");
    assert.deepEqual(posts(store), ["hello back"]);
  } finally {
    for (const s of held) s.destroy();
    await host.close();
    await real.close();
    proxy.close();
    store.close();
  }
});

test("Core not answering while the agent acts is not 'REFUSED' feedback: the step is retried, the reply is not paid for twice, and nothing is lost", async () => {
  const { isTransient } = await import("../src/harnesses/pi.ts");
  assert.equal(isTransient(new Error("core-unreachable: http://x (fetch failed)")), true);
  assert.equal(isTransient(Object.assign(new Error("HTTP 503"), { status: 503 })), true);
  assert.equal(isTransient(new Error("database is locked")), true);
  assert.equal(isTransient(Object.assign(new Error("forbidden: x"), { status: 403 })), false, "a refusal is feedback");
  assert.equal(isTransient(Object.assign(new Error("hop-limit: x"), { status: 429 })), false, "a limit is a rule");
  assert.equal(isTransient(new Error("not-a-member: agent:pi not in c1")), false);
  assert.equal(isTransient(new Error("unknown-request: r")), false);
  const store = new Store(":memory:");
  const inner = new LocalCore(store);
  let failures = 2;
  const core = { call: async (a: string, op: string, x: Record<string, unknown> = {}) => { if (a === "agent:pi" && op === "post" && failures-- > 0) throw new Error("core-unreachable: http://core (fetch failed)"); return inner.call(a, op, x); } } as never;
  const alice = (op: string, a: Record<string, unknown> = {}) => inner.call("human:alice", op, a) as Promise<any>;
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  const model = await fakeModel((_m, n) => `POST: answer number ${n}`);
  const errors: string[] = [];
  const host = new Host(core);
  host.onError = (e) => errors.push(String((e.error as Error).message));
  try {
    await host.add({ actor: "agent:pi", harness: await PiHarness.open({ ...piOpts(model.baseUrl), maxRounds: 1 }) });
    await alice("post", { context: "c1", text: "please answer" });
    for (let i = 0; i < 6; i++) await host.tick();
    assert.equal(errors.length, 2, `the two outages were reported to the host, not to the model: ${JSON.stringify(errors)}`);
    assert.deepEqual(posts(store), ["answer number 1"], "the reply of the first model call arrived, once");
    assert.equal(model.requests.length, 1, "and the model was asked once: the retries reused its remembered reply");
  } finally {
    await host.close();
    await model.close();
    store.close();
  }
});
