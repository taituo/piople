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

// ---- hygiene: expiring tokens, bounded inputs, remote MCP ----------------------------------------

test("tokens expire, record last use at most once a minute, and can be listed without secrets", () => {
  const store = new Store(":memory:");
  const t0 = 1_000_000;
  const short = store.issueToken("agent:a", 5_000, t0);
  const forever = store.issueToken("agent:a", undefined, t0);
  const used = () => store.listTokens("agent:a").map((t) => t.lastUsedAt); // [short, forever]
  assert.deepEqual(used(), [null, null]);
  assert.equal(store.actorForToken(short, t0 + 4_999), "agent:a");
  assert.equal(store.actorForToken(short, t0 + 5_000), undefined, "expired exactly at expires_at");
  assert.equal(used()[0], t0 + 4_999, "an expired attempt is not recorded as use");
  assert.throws(() => store.issueToken("agent:a", 0), /bad-ttl/);
  assert.throws(() => store.issueToken("agent:a", 1.5), /bad-ttl/);

  store.actorForToken(forever, t0 + 100);
  assert.equal(used()[1], t0 + 100, "first use is recorded");
  store.actorForToken(forever, t0 + 30_000);
  assert.equal(used()[1], t0 + 100, "no write within a minute");
  store.actorForToken(forever, t0 + 61_000);
  assert.equal(used()[1], t0 + 61_000);
  assert.equal(store.actorForToken(forever, t0 + 10 ** 9), "agent:a", "no ttl, no expiry");
  const listed = JSON.stringify(store.listTokens("agent:a"));
  assert.ok(!listed.includes(short) && !listed.includes(forever), "the secret never leaves");
  store.revokeTokens("agent:a");
  assert.ok(store.listTokens("agent:a").every((t) => t.revokedAt !== null));
  store.close();
});

test("admin CLI: --ttl-ms and list-tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "piople-admin-"));
  const db = join(dir, "t.sqlite");
  const admin = (...a: string[]) => execFileSync(process.execPath, ["--no-warnings", "src/cli/admin.ts", "--db", db, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const { token } = JSON.parse(admin("issue-token", "--actor", "agent:x", "--ttl-ms", "60000"));
  const listed = JSON.parse(admin("list-tokens", "--actor", "agent:x")) as { tokens: Array<{ createdAt: number; expiresAt: number }> };
  assert.equal(listed.tokens.length, 1);
  assert.equal(listed.tokens[0]!.expiresAt - listed.tokens[0]!.createdAt, 60_000);
  assert.ok(!JSON.stringify(listed).includes(token));
  assert.throws(() => admin("issue-token", "--actor", "agent:x", "--ttl-ms", "soon"), /bad-ttl/);
});

test("reads are bounded and leases must be sensible", () => {
  const store = new Store(":memory:");
  store.createContext({ id: "c1", kind: "case", title: "t", goal: "g", createdAt: 1 }, "human:alice");
  for (let i = 0; i < 1100; i++) store.postMessage("c1", "human:alice", `k${i}`, "x");
  assert.equal(store.readEvents("c1", "human:alice", 0, 10 ** 9).length, 1000, "one read never returns more than MAX_READ");
  assert.equal(store.readEvents("c1", "human:alice", 0, Number.NaN).length, 200, "a nonsense limit falls back to the default");
  assert.equal(store.readEvents("c1", "human:alice", 0, -5).length, 1);
  store.join({ contextId: "c1", actorId: "agent:w", capabilities: ["read", "write"], joinedAt: 2 }, "j", "human:alice");
  store.setSkills("agent:w", ["job"]);
  store.requestWork("c1", "human:alice", { id: "w1", skill: "job", input: 1 });
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => store.claimWork("c1", "agent:w", "w1", bad), /bad-lease/);
  assert.equal(store.getWork("c1", "w1")!.status, "open", "a refused lease claims nothing");
  assert.equal(store.claimWork("c1", "agent:w", "w1", 1000).work.attempt, 1);
  store.close();
});

test("remote MCP: an agent on another machine uses the same tools over HTTP, identity from its token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piople-mcp-"));
  const db = join(dir, "m.sqlite");
  const issue = (a: string) => JSON.parse(execFileSync(process.execPath, ["--no-warnings", "src/cli/admin.ts", "--db", db, "issue-token", "--actor", a], { encoding: "utf8" })).token as string;
  const tAlice = issue("human:alice");
  const tScout = issue("agent:scout");
  const port = await freePort();
  const server = await startServer(db, port);
  const url = `http://127.0.0.1:${port}`;
  const alice = new HttpCore(url, { "human:alice": tAlice });
  await alice.call("human:alice", "create", { id: "c1", title: "t" });
  await alice.call("human:alice", "join", { context: "c1", actor: "agent:scout", caps: "read,write" });

  const mcp = (env: Record<string, string>) => spawn(process.execPath, ["--no-warnings", "src/mcp/server.ts"], { env: { PATH: process.env.PATH!, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const p = mcp({ PIO_CORE_URL: url, PIO_TOKEN: tScout });
  const replies: any[] = [];
  let buf = "";
  p.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) replies.push(JSON.parse(l));
  });
  const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  for (const m of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "piople_post", { context: "c1", text: "hello from afar", key: "m1" }),
    call(3, "piople_decide", { context: "c1", decision: "d", answer: "yes" }),
    call(4, "piople_inbox", { context: "c1" }),
  ]) p.stdin!.write(JSON.stringify(m) + "\n");
  p.stdin!.end();
  await new Promise((r) => p.on("close", r));
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 3, 4], "answered in order over the network");
  assert.equal(replies[1].result.isError, undefined);
  assert.equal(replies[2].result.isError, true);
  assert.match(replies[2].result.content[0].text, /lacks decide/);
  const events = (await alice.call("human:alice", "events", { context: "c1" })) as Array<{ type: string; actorId: string; data: { text?: string } }>;
  const posted = events.find((e) => e.type === "message.posted")!;
  assert.deepEqual([posted.actorId, posted.data.text], ["agent:scout", "hello from afar"]);

  const run = (env: Record<string, string>) => new Promise<{ code: number | null; err: string }>((resolve) => {
    const c = mcp(env);
    let err = "";
    c.stderr!.on("data", (d: Buffer) => (err += d));
    c.on("close", (code) => resolve({ code, err }));
  });
  const wrong = await run({ PIO_CORE_URL: url, PIO_TOKEN: "pio_wrong" });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /refused the token \(HTTP 401\)/);
  const mismatch = await run({ PIO_CORE_URL: url, PIO_TOKEN: tScout, PIO_ACTOR: "human:alice" });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.err, /token belongs to agent:scout/);
  assert.match((await run({ PIO_CORE_URL: url })).err, /needs PIO_TOKEN/);

  server.kill("SIGTERM");
  await exited(server);
});
