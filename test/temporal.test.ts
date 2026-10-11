import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import type net from "node:net";
import { tmpdir } from "node:os";
import { Store } from "../src/core/index.ts";
import { createCoreServer } from "../src/http/server.ts";
import { HttpCore } from "../src/hosts/http-core.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { SyntheticHarness, behave } from "../src/harnesses/synthetic.ts";

/**
 * Temporal as orchestrator, against a local Temporal dev server (the SDK downloads and runs it). Skipped when the
 * optional @temporalio packages are not installed or the dev server cannot be started (no network for the download).
 */
type TemporalTesting = typeof import("@temporalio/testing");
let T: TemporalTesting | undefined;
let env: Awaited<ReturnType<TemporalTesting["TestWorkflowEnvironment"]["createLocal"]>> | undefined;
let skip: string | false = false;
try {
  T = await import("@temporalio/testing");
  env = await T.TestWorkflowEnvironment.createLocal();
} catch (e) {
  skip = `Temporal dev server unavailable: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<V>(what: string, f: () => V | undefined | false | Promise<V | undefined | false>, ms = 60_000): Promise<V> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v as V;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function piople() {
  const store = new Store(":memory:");
  const tok = { alice: store.issueToken("human:alice"), orch: store.issueToken("agent:orchestrator") };
  const srv = createCoreServer(store);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  const alice = (op: string, a: Record<string, unknown> = {}) => new HttpCore(url, { "human:alice": tok.alice }).call("human:alice", op, a) as Promise<any>;
  await alice("create", { id: "c1", title: "Chain" });
  for (const who of ["agent:orchestrator", "agent:echo1", "agent:echo2"]) await alice("join", { context: "c1", actor: who, caps: "read,write" });
  const gate = { open: false };
  const host = new Host(new LocalCore(store), { pollMs: 50 });
  const echo = (name: string, wait: boolean) => host.add({ actor: name, harness: new SyntheticHarness({ behaviors: [behave.worker(async (input) => { if (wait) await until("the gate", () => gate.open); return { by: name, saw: input }; })] }) });
  return {
    store, url, tok, alice, gate, host, echo,
    work: () => store.listWork("agent:orchestrator", { context: "c1" }),
    events: (type: string) => store.eventsSince("c1", 0).filter((e) => e.type === type),
    openDecision: () => store.eventsSince("c1", 0).filter((e) => e.type === "decision.requested").map((e) => String(e.data.decisionId)).find((id) => store.getDecision("c1", id)?.status === "open"),
    close: async () => { await host.close(); await new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }); store.close(); },
  };
}
const input = (extra: object = {}) => ({ context: "c1", first: { to: "agent:echo1", input: { q: "triage" } }, second: { to: "agent:echo2" }, question: "Go ahead?", heartbeatSeconds: 3, ...extra });

test("a chain: agent, human decision, agent; every step is one Piople item addressed to a named actor", { skip }, async () => {
  const P = await piople();
  await P.echo("agent:echo1", false); await P.echo("agent:echo2", false); P.host.start();
  const { Worker } = await import("@temporalio/worker");
  const { createActivities } = await import("../src/adapters/temporal/activities.ts");
  const worker = await Worker.create({ connection: env!.nativeConnection, taskQueue: "t1", workflowsPath: new URL("../src/adapters/temporal/workflows.ts", import.meta.url).pathname, activities: createActivities(new HttpCore(P.url, { "agent:orchestrator": P.tok.orch }), "agent:orchestrator", { pollMs: 50 }) });
  await worker.runUntil(async () => {
    const run = await env!.client.workflow.start("piopleChain", { args: [input()], taskQueue: "t1", workflowId: "chain-1" });
    const d = await until("the human decision", () => P.openDecision());
    assert.equal(P.work().length, 1, "the second step waits for the human");
    await P.alice("decide", { context: "c1", decision: d, answer: "yes" });
    const r = (await run.result()) as any;
    assert.equal(r.status, "done");
    assert.deepEqual([r.first.by, r.first.saw, r.second.by], ["agent:echo1", { q: "triage" }, "agent:echo2"]);
    assert.deepEqual(r.second.saw, { from: r.first });
  });
  assert.deepEqual(P.work().map((w) => [w.to, w.skill, w.status, w.requestedBy]), [["agent:echo1", null, "done", "agent:orchestrator"], ["agent:echo2", null, "done", "agent:orchestrator"]], "named actors, never a skill a launcher could pick up");
  assert.equal(P.events("decision.requested").length, 1);
  await P.close();
});

test("a human who says no stops the chain: the second step is never asked for", { skip }, async () => {
  const P = await piople();
  await P.echo("agent:echo1", false); P.host.start();
  const { Worker } = await import("@temporalio/worker");
  const { createActivities } = await import("../src/adapters/temporal/activities.ts");
  const worker = await Worker.create({ connection: env!.nativeConnection, taskQueue: "t2", workflowsPath: new URL("../src/adapters/temporal/workflows.ts", import.meta.url).pathname, activities: createActivities(new HttpCore(P.url, { "agent:orchestrator": P.tok.orch }), "agent:orchestrator", { pollMs: 50 }) });
  await worker.runUntil(async () => {
    const run = await env!.client.workflow.start("piopleChain", { args: [input()], taskQueue: "t2", workflowId: "chain-no" });
    await P.alice("decide", { context: "c1", decision: await until("the decision", () => P.openDecision()), answer: "no" });
    const r = (await run.result()) as any;
    assert.deepEqual([r.status, r.answer], ["declined", "no"]);
  });
  assert.equal(P.work().length, 1);
  await P.close();
});

test("Activities are idempotent in their key: a retry, a replay or a second call asks for the same thing once", { skip }, async () => {
  const P = await piople();
  const { createActivities, workIdFor, decisionIdFor } = await import("../src/adapters/temporal/activities.ts");
  const acts = createActivities(new HttpCore(P.url, { "agent:orchestrator": P.tok.orch }), "agent:orchestrator");
  const a = await acts.requestWork({ context: "c1", to: "agent:echo1", input: { n: 1 }, key: "wf:step" });
  const b = await acts.requestWork({ context: "c1", to: "agent:echo1", input: { n: 1 }, key: "wf:step" });
  assert.deepEqual([a.workId, b.workId], [`agent:orchestrator@${workIdFor("wf:step")}`, `agent:orchestrator@${workIdFor("wf:step")}`], "ids start with the orchestrator, which Core keeps for it");
  assert.equal(P.work().length, 1);
  assert.notEqual(workIdFor("wf:step"), workIdFor("wf:other"));
  const d1 = await acts.requestDecision({ context: "c1", question: "ok?", key: "wf:d" });
  const d2 = await acts.requestDecision({ context: "c1", question: "ok?", key: "wf:d" });
  assert.deepEqual([d1.decisionId, d2.decisionId], [`agent:orchestrator@${decisionIdFor("wf:d")}`, `agent:orchestrator@${decisionIdFor("wf:d")}`]);
  assert.equal(P.events("decision.requested").length, 1);
  await P.close();
});

test("the Temporal worker is SIGKILLed while waiting on an agent; a new one finishes the chain with no duplicate work", { skip }, async () => {
  const P = await piople();
  await P.echo("agent:echo1", true); await P.echo("agent:echo2", false); P.host.start();
  const start = () => spawn(process.execPath, ["--no-warnings", "src/adapters/temporal/worker.ts"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir(), TEMPORAL_ADDRESS: env!.address, TEMPORAL_TASK_QUEUE: "t4", PIO_CORE_URL: P.url, PIO_TOKEN: P.tok.orch, PIO_ACTOR: "agent:orchestrator" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = (p: ChildProcess) => new Promise<void>((resolve, reject) => {
    let out = ""; const t = setTimeout(() => reject(new Error(`worker never started: ${out}`)), 60_000);
    p.stdout!.on("data", (d) => { out += d; if (/temporal worker running/.test(out)) { clearTimeout(t); resolve(); } });
    p.stderr!.on("data", (d) => { out += d; });
    p.on("close", () => { clearTimeout(t); reject(new Error(`worker exited early: ${out.slice(-400)}`)); });
  });
  const w1 = start();
  await ready(w1);
  const run = await env!.client.workflow.start("piopleChain", { args: [input()], taskQueue: "t4", workflowId: "chain-kill" });
  await until("the first step to be claimed", () => P.work().some((w) => w.status === "claimed"));
  w1.kill("SIGKILL");
  await new Promise((r) => w1.on("close", r));
  P.gate.open = true; // the agent finishes while no orchestrator is alive: Piople has the result, Temporal does not know yet
  await until("the work to be done", () => P.work()[0]?.status === "done");
  const w2 = start();
  await ready(w2);
  try {
    await P.alice("decide", { context: "c1", decision: await until("the decision", () => P.openDecision()), answer: "yes" });
    const r = (await run.result()) as any;
    assert.equal(r.status, "done");
  } finally {
    w2.kill("SIGKILL");
  }
  assert.equal(P.work().length, 2, "one item per step, however many times the Activities ran");
  assert.equal(P.events("work.requested").length, 2);
  assert.equal(P.events("work.claimed").length, 2, "and each was claimed once");
  assert.equal(P.events("work.completed").length, 2);
  assert.equal(P.events("decision.requested").length, 1);
  const hist = await run.fetchHistory();
  assert.ok(hist.events!.some((e) => e.activityTaskTimedOutEventAttributes || e.activityTaskStartedEventAttributes), "Temporal did run Activities");
  await P.close();
});

test.after(async () => { await env?.teardown(); });
