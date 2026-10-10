import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type net from "node:net";
import { Store } from "../src/core/index.ts";
import { createCoreServer } from "../src/http/server.ts";
import { HttpCore } from "../src/hosts/http-core.ts";
import { runWork } from "../src/hosts/worker.ts";

async function lab() {
  const store = new Store(":memory:");
  const tok = { alice: store.issueToken("human:alice"), worker: store.issueToken("agent:jobworker") };
  const srv = createCoreServer(store);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  const alice = new HttpCore(url, { "human:alice": tok.alice });
  await alice.call("human:alice", "create", { id: "c1", title: "t" });
  await alice.call("human:alice", "join", { context: "c1", actor: "agent:jobworker", caps: "read,write" });
  const worker = new HttpCore(url, { "agent:jobworker": tok.worker });
  const request = (id: string, input: unknown) => alice.call("human:alice", "work-request", { context: "c1", id, skill: "lab.echo", input: JSON.stringify(input) });
  const args = (id: string) => ({ actor: "agent:jobworker", context: "c1", workId: id, skill: "lab.echo" });
  const events = (type: string) => store.eventsSince("c1", 0).filter((e) => e.type === type);
  return { store, url, tok, worker, request, args, events, close: async () => { await new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }); store.close(); } };
}

test("a worker claims exactly its work, runs the executor and completes it once", async () => {
  const L = await lab();
  await L.request("w1", { text: "hello" });
  await L.request("w2", { text: "not mine" });
  assert.equal(await runWork(L.worker, L.args("w1")), "completed");
  const w = L.store.getWork("c1", "w1")!;
  assert.deepEqual([w.status, w.attempt, (w.result as any).echo, (w.result as any).key], ["done", 1, "hello", "work:w1:1"]);
  assert.equal(L.store.getWork("c1", "w2")!.status, "open", "it took only its own");
  assert.equal(await runWork(L.worker, L.args("w1")), "already-done", "run again: nothing happens, no second attempt");
  assert.equal(L.events("work.completed").length, 1);
  assert.equal(L.store.getWork("c1", "w1")!.attempt, 1);
  await L.close();
});

test("an executor that throws fails the work for good and reports why; a skill with no executor does too", async () => {
  const L = await lab();
  await L.request("bad", { fail: "disk full" });
  assert.equal(await runWork(L.worker, L.args("bad")), "failed");
  assert.deepEqual([L.store.getWork("c1", "bad")!.status], ["failed"]);
  assert.equal((L.events("work.failed")[0]!.data as any).reason, "disk full");
  await L.request("odd", {});
  assert.equal(await runWork(L.worker, { ...L.args("odd"), executors: {} }), "failed");
  assert.match((L.events("work.failed")[1]!.data as any).reason, /no executor for skill lab.echo/);
  await L.close();
});

test("work someone else holds is left alone", async () => {
  const L = await lab();
  await L.request("w1", { sleepMs: 0 });
  await L.store.join({ contextId: "c1", actorId: "agent:other", capabilities: ["read", "write"], joinedAt: 1 }, "jo", "human:alice");
  L.store.setSkills("agent:other", ["lab.echo"]);
  L.store.claimWork("c1", "agent:other", "w1");
  assert.equal(await runWork(L.worker, L.args("w1")), "taken");
  assert.equal(L.store.getWork("c1", "w1")!.claimedBy, "agent:other");
  await L.close();
});

test("a worker that is not a member with write gets Core's refusal as an error: it does not pretend", async () => {
  const L = await lab();
  await L.request("w1", {});
  const outsider = new HttpCore(L.url, { "agent:nobody": L.store.issueToken("agent:nobody") });
  await assert.rejects(runWork(outsider, { ...L.args("w1"), actor: "agent:nobody" }), /not-a-member|forbidden/);
  assert.equal(L.store.getWork("c1", "w1")!.status, "open");
  await L.close();
});

test("a worker process killed mid-work (SIGKILL) and started again finishes the work once, with the same attempt", async () => {
  const L = await lab();
  await L.request("w1", { sleepMs: 30_000, text: "slow" });
  const env = { PATH: process.env.PATH ?? "", PIO_CORE_URL: L.url, PIO_TOKEN: L.tok.worker, PIO_ACTOR: "agent:jobworker", PIO_CONTEXT: "c1", PIO_WORK_ID: "w1", PIO_SKILL: "lab.echo", HOSTNAME: "pod-a" };
  const first = spawn(process.execPath, ["--no-warnings", "src/hosts/worker.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("never claimed")), 15_000);
    const poll = setInterval(() => { if (L.store.getWork("c1", "w1")?.status === "claimed") { clearInterval(poll); clearTimeout(t); resolve(); } }, 50);
  });
  first.kill("SIGKILL");
  await new Promise((r) => first.on("close", r));
  assert.deepEqual([L.store.getWork("c1", "w1")!.status, L.store.getWork("c1", "w1")!.attempt], ["claimed", 1], "the dead worker's claim is still there");
  // the replacement pod: same identity, a quick version of the task (the input is the work's, so shorten it through the executor registry would change it; instead complete via a fresh process with a short sleep)
  const second = spawn(process.execPath, ["--no-warnings", "-e", `
    import("./src/hosts/worker.ts").then(async ({ runWork }) => {
      const { HttpCore } = await import("./src/hosts/http-core.ts");
      const core = new HttpCore(process.env.PIO_CORE_URL, { [process.env.PIO_ACTOR]: process.env.PIO_TOKEN });
      const out = await runWork(core, { actor: process.env.PIO_ACTOR, context: "c1", workId: "w1", skill: "lab.echo", executors: { "lab.echo": async (input, ctx) => ({ echo: input.text, attempt: ctx.attempt, by: "pod-b" }) } });
      console.log("outcome:" + out);
    });`], { env: { ...env, HOSTNAME: "pod-b" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  second.stdout.on("data", (d) => (out += d));
  await new Promise((r) => second.on("close", r));
  assert.match(out, /outcome:completed/);
  const w = L.store.getWork("c1", "w1")!;
  assert.deepEqual([w.status, w.attempt, (w.result as any).by], ["done", 1, "pod-b"], "same attempt: a restart is not a new claim");
  assert.equal(L.events("work.completed").length, 1);
  assert.equal(L.events("work.claimed").length, 1, "one claim in the log, not two");
  await L.close();
});

test("the worker entry: missing configuration exits 2, an unreachable Core exits 1 so the Job retries", async () => {
  const run = (env: Record<string, string>) => new Promise<number | null>((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", "src/hosts/worker.ts"], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: "ignore" });
    p.on("close", resolve);
  });
  assert.equal(await run({}), 2);
  assert.equal(await run({ PIO_CORE_URL: "http://127.0.0.1:1", PIO_TOKEN: "pio_x", PIO_ACTOR: "agent:a", PIO_CONTEXT: "c", PIO_WORK_ID: "w", PIO_SKILL: "lab.echo" }), 1);
});
