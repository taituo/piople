import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { createCoreServer } from "../src/http/server.ts";
import { HttpCore } from "../src/hosts/http-core.ts";
import { Host } from "../src/hosts/host.ts";
import { SyntheticHarness, behave } from "../src/harnesses/synthetic.ts";

async function boot(store: Store, maxBody?: number) {
  const srv = createCoreServer(store, { maxBody });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  return { url, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
const raw = (url: string, path: string, o: { method?: string; token?: string; body?: string } = {}) =>
  fetch(`${url}${path}`, { method: o.method ?? "POST", headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body });
const client = (url: string, tokens: Record<string, string>) => new HttpCore(url, tokens, { backoffMs: 5, retries: 2 });

test("auth, routing and status codes", async () => {
  const store = new Store(":memory:");
  const t = { alice: store.issueToken("human:alice"), a: store.issueToken("agent:a") };
  const srv = await boot(store, 200);
  const alice = client(srv.url, { "human:alice": t.alice, "agent:a": t.a });
  await alice.call("human:alice", "create", { id: "c1", title: "t" });

  assert.equal((await raw(srv.url, "/v1/health", { method: "GET" })).status, 200);
  assert.equal((await raw(srv.url, "/v1/ops/post")).status, 401, "no token");
  assert.equal((await raw(srv.url, "/v1/ops/post", { token: "pio_nope" })).status, 401, "bad token");
  assert.equal((await raw(srv.url, "/v1/nothing")).status, 401, "unauthenticated callers cannot probe routes");
  assert.deepEqual(await (await raw(srv.url, "/v1/whoami", { method: "GET", token: t.a })).json(), { actor: "agent:a" });

  const status = async (path: string, o: Parameters<typeof raw>[2]) => (await raw(srv.url, path, o)).status;
  assert.equal(await status("/v1/ops/post", { token: t.a, body: '{"context":"c1","text":"x"}' }), 403, "not a member");
  assert.equal(await status("/v1/ops/post", { token: t.alice, body: '{"context":"c1"}' }), 400, "missing text");
  assert.equal(await status("/v1/ops/nope", { token: t.alice, body: "{}" }), 404, "unknown op");
  assert.equal(await status("/v1/ops/post", { token: t.alice, body: "{oops" }), 400, "bad json");
  assert.equal(await status("/v1/ops/post", { token: t.alice, body: "[1]" }), 400, "not an object");
  assert.equal(await status("/v1/ops/post", { method: "GET", token: t.alice }), 405);
  assert.equal(await status("/v1/ops/post", { token: t.alice, body: JSON.stringify({ context: "c1", text: "x".repeat(500) }) }), 413);
  await raw(srv.url, "/v1/ops/post", { token: t.alice, body: '{"context":"c1","text":"hi","key":"k"}' });
  assert.equal(await status("/v1/ops/ask", { token: t.alice, body: '{"context":"c1","to":"agent:a","question":"q","key":"k"}' }), 409, "key reused by another op");
  await srv.close();
  store.close();
});

test("identity is the token and nothing else; tokens are stored hashed and can be revoked", async () => {
  const store = new Store(":memory:");
  const tAlice = store.issueToken("human:alice");
  const tA = store.issueToken("agent:a");
  const srv = await boot(store);
  const c = client(srv.url, { "human:alice": tAlice, "agent:a": tA });
  await c.call("human:alice", "create", { id: "c1", title: "t" });
  await c.call("human:alice", "join", { context: "c1", actor: "agent:a", caps: "read,write" });

  // agent:a tries to speak as alice by every name it can think of
  const r = await raw(srv.url, "/v1/ops/post", { token: tA, body: JSON.stringify({ context: "c1", text: "I am alice", actor: "human:alice", as: "human:alice", actorId: "human:alice", authorId: "human:alice" }) });
  assert.equal(r.status, 200);
  assert.equal(store.eventsSince("c1", 0).at(-1)?.actorId, "agent:a");
  await assert.rejects(c.call("agent:a", "decide", { context: "c1", decision: "d", answer: "yes" }), /lacks decide/);
  assert.equal(store.eventsSince("c1", 0).filter((e) => e.type === "message.posted").length, 1);
  await assert.rejects(c.call("agent:b", "inbox"), /no-token/, "a client speaks only as the actors it holds tokens for");

  assert.equal((store.db.prepare(`SELECT COUNT(*) n FROM tokens WHERE hash=?`).get(tA) as { n: number }).n, 0, "the token itself is not stored");
  assert.throws(() => store.issueToken("alice"), /bad-actor/);
  const tA2 = store.issueToken("agent:a");
  assert.notEqual(tA, tA2);
  assert.equal(store.actorForToken(tA2), "agent:a");
  assert.equal(store.revokeTokens("agent:a"), 2);
  assert.equal(store.actorForToken(tA), undefined);
  assert.equal((await raw(srv.url, "/v1/whoami", { method: "GET", token: tA2 })).status, 401);
  assert.equal(store.actorForToken(tAlice), "human:alice", "other actors keep theirs");
  await srv.close();
  store.close();
});

test("the same Host and harnesses work unchanged over HTTP", async () => {
  const store = new Store(":memory:");
  const tok = Object.fromEntries(["human:alice", "agent:pm", "agent:w", "agent:boss"].map((a) => [a, store.issueToken(a)]));
  const srv = await boot(store);
  const core = client(srv.url, tok);
  const host = new Host(core);
  await host.add({ actor: "agent:pm", harness: new SyntheticHarness({ behaviors: [behave.replyTo(/^ping$/, "pong")] }) });
  await host.add({ actor: "agent:w", skills: ["job"], harness: new SyntheticHarness({ behaviors: [behave.worker((i) => `did ${i}`)] }) });
  await host.add({ actor: "agent:boss", harness: new SyntheticHarness({ behaviors: [behave.decider(() => "yes")] }) });
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pm", caps: "read,write" });
  await alice("join", { context: "c1", actor: "agent:w", caps: "read,write" });
  await alice("join", { context: "c1", actor: "agent:boss", caps: "read,write,decide" });
  await alice("post", { context: "c1", text: "ping" });
  await alice("work-request", { context: "c1", id: "w1", skill: "job", input: '"x"' });
  await alice("decision-request", { context: "c1", id: "d1", question: "ok?" });
  await host.settle();
  const ev = store.eventsSince("c1", 0);
  assert.ok(ev.some((e) => e.type === "message.posted" && e.actorId === "agent:pm" && e.data.text === "pong"));
  assert.deepEqual(store.getWork("c1", "w1")!.result, "did x");
  assert.equal(store.getDecision("c1", "d1")!.answer, "yes");
  assert.equal(ev.find((e) => e.type === "decision.resolved")!.actorId, "agent:boss");
  await srv.close();
  store.close();
});

test("eight clients race over HTTP for three jobs: exactly one winner each", async () => {
  const store = new Store(":memory:");
  const workers = Array.from({ length: 8 }, (_, i) => `agent:w${i}`);
  const tok = Object.fromEntries(["human:alice", ...workers].map((a) => [a, store.issueToken(a)]));
  const srv = await boot(store);
  const core = client(srv.url, tok);
  await core.call("human:alice", "create", { id: "c1", title: "t" });
  for (const w of workers) {
    await core.call(w, "actor", { skills: "job" });
    await core.call("human:alice", "join", { context: "c1", actor: w, caps: "read,write" });
  }
  for (const id of ["j1", "j2", "j3"]) await core.call("human:alice", "work-request", { context: "c1", id, skill: "job", input: `"${id}"` });
  const res = await Promise.all(workers.map((w) => core.call(w, "work-claim", { context: "c1", next: true }) as Promise<{ work: { id: string } | null }>));
  assert.deepEqual(res.filter((r) => r.work).map((r) => r.work!.id).sort(), ["j1", "j2", "j3"]);
  assert.equal(res.filter((r) => !r.work).length, 5);
  assert.equal(store.eventsSince("c1", 0).filter((e) => e.type === "work.claimed").length, 3);
  await srv.close();
  store.close();
});

test("a lost response is retried safely: one event, not two; a blind claim is not retried", async () => {
  const store = new Store(":memory:");
  const tAlice = store.issueToken("human:alice");
  const srv = await boot(store);
  let calls = 0;
  let dropNext = true;
  const lossy: typeof fetch = async (input, init) => {
    calls++;
    const res = await fetch(input, init); // the server did process it ...
    if (dropNext) { dropNext = false; throw new TypeError("fetch failed (response lost)"); } // ... but we never heard back
    return res;
  };
  const c = new HttpCore(srv.url, { "human:alice": tAlice }, { backoffMs: 5, retries: 3, fetch: lossy });
  await c.call("human:alice", "create", { id: "c1", title: "t" });
  assert.equal(calls, 2, "create was retried and replayed by its key");
  dropNext = true;
  await c.call("human:alice", "post", { context: "c1", text: "once" }); // no key given by the caller
  assert.equal(store.eventsSince("c1", 0).filter((e) => e.type === "message.posted").length, 1);

  await c.call("human:alice", "actor", { skills: "job" });
  await c.call("human:alice", "work-request", { context: "c1", id: "w1", skill: "job", input: "1" });
  await c.call("human:alice", "work-request", { context: "c1", id: "w2", skill: "job", input: "2" });
  calls = 0;
  dropNext = true;
  await assert.rejects(c.call("human:alice", "work-claim", { context: "c1", next: true }), /core-unreachable/);
  assert.equal(calls, 1, "claim --next is never retried blindly");
  const mine = ((await c.call("human:alice", "inbox", { context: "c1" })) as any).pending.work.mine;
  assert.deepEqual(mine.map((m: any) => m.id), ["w1"], "the lost claim is visible and can be resumed");
  await srv.close();
  store.close();
});

test("admin CLI issues and revokes credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piople-admin-"));
  const db = join(dir, "a.sqlite");
  const admin = (...a: string[]) => execFileSync(process.execPath, ["--no-warnings", "src/cli/admin.ts", "--db", db, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const { token } = JSON.parse(admin("issue-token", "--actor", "agent:x"));
  const store = new Store(db);
  assert.equal(store.actorForToken(token), "agent:x");
  assert.throws(() => admin("issue-token", "--actor", "nobody"), /bad-actor/);
  assert.deepEqual(JSON.parse(admin("revoke-tokens", "--actor", "agent:x")), { actor: "agent:x", revoked: 1 });
  assert.equal(store.actorForToken(token), undefined);
  store.close();
});

// ---- the real thing: a Core process that dies and comes back ------------------------------------

const freePort = () => new Promise<number>((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
function startServer(db: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--no-warnings", "src/http/main.ts"], { env: { ...process.env, PIO_DATA: db, PIO_PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
    p.once("error", reject);
    p.stdout!.on("data", (d: Buffer) => { if (String(d).includes("listening")) resolve(p); });
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null || p.signalCode ? r() : p.once("exit", () => r())));

test("the Core process is killed mid-work and restarted: the worker finishes the same claim, nothing is lost or repeated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piople-d-"));
  const db = join(dir, "core.sqlite");
  const issue = (a: string) => JSON.parse(execFileSync(process.execPath, ["--no-warnings", "src/cli/admin.ts", "--db", db, "issue-token", "--actor", a], { encoding: "utf8" })).token as string;
  const tokens = { "human:alice": issue("human:alice"), "agent:w": issue("agent:w") };
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let server = await startServer(db, port);
  const opts = { retries: 12, backoffMs: 40, maxBackoffMs: 400 };
  const alice = new HttpCore(url, { "human:alice": tokens["human:alice"] }, opts);

  let handled = 0;
  let inHandler!: () => void;
  const reachedHandler = new Promise<void>((r) => (inHandler = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const host = new Host(new HttpCore(url, { "agent:w": tokens["agent:w"] }, opts), { pollMs: 20 });
  const errors: string[] = [];
  host.onError = (e) => errors.push(String((e.error as Error).message));
  await host.add({ actor: "agent:w", skills: ["job"], harness: new SyntheticHarness({ behaviors: [behave.worker(async () => { handled++; inHandler(); await gate; return "finished"; })] }) });

  await alice.call("human:alice", "create", { id: "c1", title: "t" });
  await alice.call("human:alice", "join", { context: "c1", actor: "agent:w", caps: "read,write" });
  await alice.call("human:alice", "work-request", { context: "c1", id: "w1", skill: "job", input: '"payload"' });
  host.start();
  await reachedHandler; // the worker holds the claim and is mid-work

  server.kill("SIGKILL");
  await exited(server);
  release(); // the worker finishes while the Core is down: its completion has nowhere to go yet
  await new Promise((r) => setTimeout(r, 250));
  server = await startServer(db, port);

  const store = new Store(db);
  const deadline = Date.now() + 15_000;
  while (store.getWork("c1", "w1")!.status !== "done" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  const w = store.getWork("c1", "w1")!;
  assert.deepEqual([w.status, w.attempt, w.result, w.claimedBy], ["done", 1, "finished", "agent:w"]);
  assert.equal(handled, 1, "the work was executed once");
  const ev = store.eventsSince("c1", 0);
  assert.equal(ev.filter((e) => e.type === "work.claimed").length, 1);
  assert.equal(ev.filter((e) => e.type === "work.completed").length, 1);

  // Another process takes over the same actor with the same credential and carries on.
  await host.close();
  const host2 = new Host(new HttpCore(url, { "agent:w": tokens["agent:w"] }, opts));
  await host2.add({ actor: "agent:w", skills: ["job"], harness: new SyntheticHarness({ behaviors: [behave.worker(() => "second")] }) });
  await alice.call("human:alice", "work-request", { context: "c1", id: "w2", skill: "job", input: '"again"' });
  await host2.settle();
  assert.deepEqual([store.getWork("c1", "w2")!.status, store.getWork("c1", "w2")!.claimedBy], ["done", "agent:w"]);
  assert.deepEqual(ev.map((e) => e.seq), [...ev.map((e) => e.seq)].sort((a, b) => a - b), "history intact and ordered");

  await host2.close();
  store.close();
  server.kill("SIGTERM");
  await exited(server);
});
