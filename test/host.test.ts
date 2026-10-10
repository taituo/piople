import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import type { Harness, Step } from "../src/hosts/types.ts";
import { SyntheticHarness, behave } from "../src/harnesses/synthetic.ts";

const types = (s: Store, ctx = "c1") => s.eventsSince(ctx, 0).map((e) => `${e.type}:${e.actorId}`);

function setup() {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const host = new Host(core);
  const as = (actor: string) => (op: string, args: Record<string, unknown> = {}) => core.call(actor, op, args) as Promise<any>;
  return { store, core, host, alice: as("human:alice") };
}
async function members(alice: (op: string, a?: Record<string, unknown>) => Promise<any>, list: Array<[string, string]>, ctx = "c1") {
  for (const [actor, caps] of list) await alice("join", { context: ctx, actor, caps });
}

test("one process, five participants, one protocol: reply, ask, work, decide", async () => {
  const { store, host, alice } = setup();
  await host.add({ actor: "agent:pm", harness: new SyntheticHarness({ behaviors: [
    behave.replyTo(/^ping$/, "pong"),
    behave.askOn(/need docs/, "agent:expert", (t) => `what about: ${t}`),
  ] }) });
  await host.add({ actor: "agent:expert", harness: new SyntheticHarness({ behaviors: [behave.answerAsks((q) => `answer to <${q}>`)] }) });
  await host.add({ actor: "agent:worker", skills: ["web.search"], harness: new SyntheticHarness({ behaviors: [behave.worker((input) => ({ found: input }))] }) });
  await host.add({ actor: "agent:boss", harness: new SyntheticHarness({ behaviors: [behave.decider((q, o) => (o.includes("yes") ? "yes" : null))] }) });

  await alice("create", { id: "c1", title: "t" });
  await members(alice, [["agent:pm", "read,write"], ["agent:expert", "read,write"], ["agent:worker", "read,write"], ["agent:boss", "read,write,decide"]]);
  await alice("post", { context: "c1", text: "ping" });
  await alice("post", { context: "c1", text: "need docs for lib X" });
  await alice("work-request", { context: "c1", id: "w1", skill: "web.search", input: '"lib X"' });
  await alice("decision-request", { context: "c1", id: "d1", question: "ship it?" });
  await host.settle();

  const t = types(store);
  assert.ok(t.includes("message.posted:agent:pm"), "pm replied");
  assert.equal(store.eventsSince("c1", 0).find((e) => e.actorId === "agent:pm" && e.type === "message.posted")!.data.text, "pong");
  assert.ok(t.includes("assistance.requested:agent:pm") && t.includes("assistance.answered:agent:expert"));
  assert.deepEqual(store.getWork("c1", "w1")!.result, { found: "lib X" });
  assert.equal(store.getWork("c1", "w1")!.claimedBy, "agent:worker");
  assert.deepEqual({ ...store.getDecision("c1", "d1")! }, { status: "resolved", answer: "yes" });
  assert.ok(t.includes("decision.resolved:agent:boss"));
  assert.equal(await host.tick(), 0, "settled: nothing left to deliver");
  store.close();
});

test("a step that fails halfway is retried without duplicating what it already did", async () => {
  const { store, host, alice } = setup();
  let crashed = false;
  const flaky: Harness = {
    async step(s: Step) {
      await s.run("post", { text: "once" });
      if (!crashed) { crashed = true; throw new Error("died after posting"); }
      await s.run("post", { text: "twice" });
    },
  };
  const errors: unknown[] = [];
  host.onError = (e) => errors.push(e.error);
  await host.add({ actor: "agent:flaky", harness: flaky });
  await alice("create", { id: "c1", title: "t" });
  await members(alice, [["agent:flaky", "read,write"]]);
  await host.settle();
  const posts = store.eventsSince("c1", 0).filter((e) => e.type === "message.posted").map((e) => e.data.text);
  assert.equal(errors.length, 1);
  assert.deepEqual(posts, ["once", "twice"], "the first post replayed, it did not repeat");
  store.close();
});

test("a flaky participant is retried; a faulty one never blocks the others", async () => {
  const { store, host, alice } = setup();
  const errors: string[] = [];
  host.onError = (e) => errors.push(e.actor);
  await host.add({ actor: "agent:flaky", skills: ["x"], harness: new SyntheticHarness({ failFirst: 2, behaviors: [behave.worker(() => "done")] }) });
  await host.add({ actor: "agent:steady", harness: new SyntheticHarness({ behaviors: [behave.replyTo(/hello/, "hi")] }) });
  await alice("create", { id: "c1", title: "t" });
  await members(alice, [["agent:flaky", "read,write"], ["agent:steady", "read,write"]]);
  await alice("work-request", { context: "c1", id: "w1", skill: "x", input: "1" });
  await alice("post", { context: "c1", text: "hello" });
  await host.settle();
  assert.deepEqual(errors, ["agent:flaky", "agent:flaky"]);
  assert.equal(store.getWork("c1", "w1")!.status, "done");
  assert.ok(types(store).includes("message.posted:agent:steady"));
  store.close();
});

test("a worker dies mid-work; its replacement resumes the same claim and nothing is redelivered", async () => {
  const { store, core, host, alice } = setup();
  const dying: Harness = {
    async step(s) {
      if (s.pending.work.open.length) {
        await s.run("work-claim", { next: true }); // takes it ...
        throw new Error("process killed"); // ... and dies before completing
      }
    },
  };
  host.onError = () => {};
  await host.add({ actor: "agent:w", skills: ["x"], harness: dying });
  await alice("create", { id: "c1", title: "t" });
  await members(alice, [["agent:w", "read,write"]]);
  await alice("work-request", { context: "c1", id: "w1", skill: "x", input: '"payload"' });
  await host.tick();
  assert.equal(store.getWork("c1", "w1")!.status, "claimed");
  await host.close();

  // A new process: new Host, new harness instance, same Core.
  const seen: number[] = [];
  const host2 = new Host(core);
  await host2.add({ actor: "agent:w", skills: ["x"], harness: new SyntheticHarness({ behaviors: [
    (s) => void seen.push(s.events.length),
    behave.worker((input) => `finished ${input}`),
  ] }) });
  await host2.settle();
  const w = store.getWork("c1", "w1")!;
  assert.deepEqual([w.status, w.attempt, w.result], ["done", 1, "finished payload"]);
  assert.equal(store.eventsSince("c1", 0).filter((e) => e.type === "work.claimed").length, 1, "resumed, not re-claimed");
  assert.equal(await host2.settle(), 0);
  await alice("post", { context: "c1", text: "later" });
  await host2.settle();
  assert.deepEqual(seen.slice(-1), [1], "after the restart only the new message is delivered");
  store.close();
});

test("a synthetic 'human' gets no decision power by naming itself human", async () => {
  const { store, host, alice } = setup();
  const errors: string[] = [];
  host.onError = (e) => errors.push(String(e.error));
  const grabby: Harness = { step: async (s) => { await s.run("decide", { decision: "d1", answer: "yes" }); } };
  await host.add({ actor: "human:fake", harness: grabby });
  await alice("create", { id: "c1", title: "t" });
  await members(alice, [["human:fake", "read,write"]]);
  await alice("decision-request", { context: "c1", id: "d1", question: "q" });
  await host.tick();
  assert.match(errors.join(), /forbidden: human:fake lacks decide/);
  assert.equal(store.getDecision("c1", "d1")!.status, "open");
  assert.deepEqual(store.pending("c1", "human:fake").decisions, [], "Core does not even offer it");
  await assert.rejects(host.add({ actor: "human:fake", harness: grabby }), /already-hosted/);
  store.close();
});

test("fifty synthetic workers race for twenty jobs on concurrent loops: each done exactly once", async () => {
  const { store, host, alice } = setup();
  const workers = Array.from({ length: 50 }, (_, i) => `agent:w${i}`);
  const handled = new Map<string, number>();
  for (const w of workers) {
    await host.add({ actor: w, skills: ["job"], harness: new SyntheticHarness({ delayMs: Math.floor(Math.random() * 8), behaviors: [
      behave.worker(async (input) => {
        handled.set(String(input), (handled.get(String(input)) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 2));
        return `by ${w}`;
      }),
    ] }) });
  }
  await alice("create", { id: "c1", title: "t" });
  await members(alice, workers.map((w) => [w, "read,write"] as [string, string]));
  for (let i = 0; i < 20; i++) await alice("work-request", { context: "c1", id: `j${i}`, skill: "job", input: `"j${i}"` });
  const errors: unknown[] = [];
  host.onError = (e) => errors.push(e.error);
  host.start();
  const deadline = Date.now() + 10_000;
  const done = () => (store.db.prepare(`SELECT COUNT(*) n FROM work WHERE status='done'`).get() as { n: number }).n;
  while (done() < 20 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await host.stop();
  assert.deepEqual(errors, []);
  assert.equal(done(), 20);
  assert.equal(store.eventsSince("c1", 0).filter((e) => e.type === "work.claimed").length, 20, "no job claimed twice");
  assert.equal(store.eventsSince("c1", 0).filter((e) => e.type === "work.completed").length, 20);
  assert.ok([...handled.values()].every((n) => n === 1), "no job executed twice");
  store.close();
});

test("a throwing onError handler does not stop delivery: the loop keeps retrying the failing step", async () => {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  await core.call("human:alice", "create", { id: "c1", title: "t" });
  await core.call("human:alice", "join", { context: "c1", actor: "agent:x", caps: "read,write" });
  let steps = 0;
  const host = new Host(core, { pollMs: 5 });
  host.onError = () => { throw new Error("broken handler"); };
  const seen: unknown[] = [];
  const onRejection = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", onRejection);
  await host.add({ actor: "agent:x", harness: { async step() { steps++; throw new Error("step fails"); } } });
  host.start();
  await core.call("human:alice", "post", { context: "c1", text: "hello" });
  await new Promise((r) => setTimeout(r, 600));
  const first = steps;
  await new Promise((r) => setTimeout(r, 600));
  await host.stop();
  process.off("unhandledRejection", onRejection);
  assert.ok(first >= 2 && steps > first, `the step kept being retried (${first} then ${steps})`);
  assert.deepEqual(seen, [], "no unhandled rejection");
  store.close();
});

test("stop() does not wait for ever for a harness stuck in a step; a step that is merely slow is still waited for", async () => {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const call = (a: string, op: string, x: Record<string, unknown> = {}) => core.call(a, op, x) as Promise<any>;
  await call("human:alice", "create", { id: "c1", title: "t" });
  await call("human:alice", "join", { context: "c1", actor: "agent:x", caps: "read,write" });
  let entered = false;
  const errors: string[] = [];
  const host = new Host(core, { pollMs: 5, stopTimeoutMs: 150 });
  host.onError = (e) => errors.push(String((e.error as Error).message));
  await host.add({ actor: "agent:x", harness: { step: () => { entered = true; return new Promise(() => {}); } } as never });
  host.start();
  await call("human:alice", "post", { context: "c1", text: "go" });
  for (let i = 0; i < 100 && !entered; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(entered, "the harness is stuck inside its step");
  const t0 = Date.now();
  await host.stop();
  assert.ok(Date.now() - t0 < 1500, `stop() returned after ${Date.now() - t0} ms`);
  assert.ok(errors.some((m) => /^stop-timeout/.test(m)), "and said which problem it gave up on");
  store.close();
});
