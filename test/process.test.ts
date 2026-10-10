import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** CLI and MCP are separate processes over one SQLite file: same rules, shared state. */
const db = join(mkdtempSync(join(tmpdir(), "piople-")), "p.sqlite");

function cli(as: string, ...args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", db, "--as", as, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e) {
    const x = e as { status: number; stdout: string; stderr: string };
    return { code: x.status, out: x.stdout, err: x.stderr };
  }
}

test("cli: create, grant, refuse self-join and over-grant", () => {
  assert.equal(cli("human:alice", "actor").code, 0);
  assert.equal(cli("human:alice", "create", "--id", "c1", "--title", "Checkout down").code, 0);
  assert.equal(cli("human:alice", "join", "--context", "c1", "--actor", "agent:scout", "--caps", "read,write").code, 0);
  assert.match(cli("agent:mallory", "join", "--context", "c1", "--actor", "agent:mallory").err, /not-a-member/);
  assert.match(cli("agent:scout", "join", "--context", "c1", "--actor", "agent:x").err, /lacks decide/);
  assert.equal(cli("human:alice", "join", "--context", "c1", "--actor", "human:bob", "--caps", "read,decide").code, 0);
  assert.match(cli("human:bob", "join", "--context", "c1", "--actor", "agent:y", "--caps", "write").err, /cannot grant write/);
  const ev = JSON.parse(cli("agent:scout", "events", "--context", "c1").out) as Array<{ type: string }>;
  assert.deepEqual(ev.map((e) => e.type), ["context.created", "member.joined", "member.joined"]);
});

test("mcp: same store, identity from env, refusals are tool errors", async () => {
  const p = spawn(process.execPath, ["--no-warnings", "src/mcp/server.ts"], { env: { ...process.env, PIO_DATA: db, PIO_ACTOR: "agent:scout" }, stdio: ["pipe", "pipe", "inherit"] });
  const replies: Array<{ id: number; result?: { tools?: unknown[]; isError?: boolean; content?: Array<{ text: string }> } }> = [];
  let buf = "";
  p.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) replies.push(JSON.parse(l));
  });
  const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  for (const m of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    call(3, "piople_post", { context: "c1", text: "from mcp", key: "m1" }),
    call(4, "piople_decide", { context: "c1", decision: "nope", answer: "yes" }),
  ]) p.stdin.write(JSON.stringify(m) + "\n");
  p.stdin.end();
  await new Promise((r) => p.on("close", r));
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 3, 4]);
  const names = (replies[1]!.result!.tools as Array<{ name: string }>).map((x) => x.name);
  for (const n of ["piople_inbox", "piople_ack", "piople_work_request", "piople_work_claim", "piople_work_complete", "piople_work_fail"]) assert.ok(names.includes(n), `missing tool ${n}`);
  assert.equal(replies[2]!.result!.isError, undefined);
  assert.equal(replies[3]!.result!.isError, true);
  assert.match(replies[3]!.result!.content![0]!.text, /lacks decide/);
  const ev = JSON.parse(cli("human:alice", "events", "--context", "c1").out) as Array<{ type: string; actorId: string }>;
  assert.deepEqual(ev.at(-1), { ...ev.at(-1), type: "message.posted", actorId: "agent:scout" });
});

test("16 concurrent writer processes: no lock errors, no lost or duplicated events", async () => {
  const db2 = join(mkdtempSync(join(tmpdir(), "piople-")), "c.sqlite");
  const run = (as: string, ...args: string[]) =>
    new Promise<{ code: number | null; err: string }>((resolve) => {
      const p = spawn(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", db2, "--as", as, ...args], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d: Buffer) => (err += d));
      p.on("close", (code) => resolve({ code, err }));
    });
  assert.equal((await run("human:alice", "create", "--id", "c1", "--title", "t")).code, 0);
  // Half the writers replay an already-used key: they must collapse to one event.
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => run("human:alice", "post", "--context", "c1", "--text", `m${i}`, "--key", `k${i % 8}`)));
  assert.deepEqual(results.filter((r) => r.code !== 0), []);
  const out = execFileSync(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", db2, "--as", "human:alice", "events", "--context", "c1"], { encoding: "utf8" });
  const posted = (JSON.parse(out) as Array<{ type: string }>).filter((e) => e.type === "message.posted");
  assert.equal(posted.length, 8);
});

test("cli: inbox shows what happened while away; ack persists across processes", () => {
  const db3 = join(mkdtempSync(join(tmpdir(), "piople-")), "i.sqlite");
  const run = (as: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", db3, "--as", as, ...args], { encoding: "utf8" })) as any;
  run("human:alice", "create", "--id", "c1", "--title", "Checkout down");
  run("human:alice", "join", "--context", "c1", "--actor", "agent:scout", "--caps", "read,write");
  run("agent:scout", "decision-request", "--context", "c1", "--id", "d1", "--question", "patch?");
  const summary = run("human:alice", "inbox");
  assert.deepEqual(summary.map((x: any) => [x.context, x.unread, x.pending]), [["c1", 2, 1]]);
  const detail = run("human:alice", "inbox", "--context", "c1");
  assert.equal(detail.pending.decisions[0].id, "d1");
  assert.deepEqual(run("human:alice", "ack", "--context", "c1", "--seq", String(detail.events.at(-1).seq)), { cursor: detail.events.at(-1).seq });
  assert.deepEqual(run("human:alice", "inbox", "--context", "c1").events, []);
  assert.equal(run("human:alice", "inbox")[0].pending, 1);
});

function runAsync(dbPath: string, as: string, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", dbPath, "--as", as, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

test("work: 8 competing processes, 3 work items — each item has exactly one winner", async () => {
  const dbw = join(mkdtempSync(join(tmpdir(), "piople-")), "w.sqlite");
  assert.equal((await runAsync(dbw, "human:alice", "create", "--id", "c1", "--title", "t")).code, 0);
  const workers = Array.from({ length: 8 }, (_, i) => `agent:w${i}`);
  for (const w of workers) {
    assert.equal((await runAsync(dbw, w, "actor", "--skills", "web.search")).code, 0);
    assert.equal((await runAsync(dbw, "human:alice", "join", "--context", "c1", "--actor", w, "--caps", "read,write")).code, 0);
  }
  for (const id of ["w1", "w2", "w3"]) {
    assert.equal((await runAsync(dbw, "human:alice", "work-request", "--context", "c1", "--id", id, "--skill", "web.search", "--input", `{"q":"${id}"}`)).code, 0);
  }

  const results = await Promise.all(workers.map((w) => runAsync(dbw, w, "work-claim", "--context", "c1", "--next", "true")));
  assert.deepEqual(results.filter((r) => r.code !== 0), [], "losing a race is a normal answer, not an error");
  const parsed = results.map((r) => JSON.parse(r.out) as { work: { id: string; attempt: number } | null });
  const won = parsed.filter((r) => r.work).map((r) => r.work!.id).sort();
  assert.deepEqual(won, ["w1", "w2", "w3"]);
  assert.equal(parsed.filter((r) => !r.work).length, 5);

  const events = JSON.parse((await runAsync(dbw, "human:alice", "events", "--context", "c1")).out) as Array<{ type: string; actorId: string; data: { workId?: string } }>;
  assert.equal(events.filter((e) => e.type === "work.claimed").length, 3, "exactly three claim events in the log");
});

test("work: a replaced claimant is refused over the CLI; the replacement finishes", async () => {
  const dbw = join(mkdtempSync(join(tmpdir(), "piople-")), "s.sqlite");
  const run = (as: string, ...a: string[]) => runAsync(dbw, as, ...a);
  await run("human:alice", "create", "--id", "c1", "--title", "t");
  for (const w of ["agent:a", "agent:b"]) {
    await run(w, "actor", "--skills", "x");
    await run("human:alice", "join", "--context", "c1", "--actor", w, "--caps", "read,write");
  }
  await run("human:alice", "work-request", "--context", "c1", "--id", "w1", "--skill", "x", "--input", "go");
  const a = JSON.parse((await run("agent:a", "work-claim", "--context", "c1", "--id", "w1", "--lease-ms", "1")).out) as { work: { attempt: number } };
  await new Promise((r) => setTimeout(r, 30));
  const b = JSON.parse((await run("agent:b", "work-claim", "--context", "c1", "--id", "w1")).out) as { work: { attempt: number } };
  assert.deepEqual([a.work.attempt, b.work.attempt], [1, 2]);
  const late = await run("agent:a", "work-complete", "--context", "c1", "--id", "w1", "--attempt", "1", "--result", "late");
  assert.equal(late.code, 1);
  assert.match(late.err, /stale-claim/);
  assert.equal((await run("agent:b", "work-complete", "--context", "c1", "--id", "w1", "--attempt", "2", "--result", '{"ok":true}')).code, 0);
  const pending = JSON.parse((await run("agent:b", "inbox", "--context", "c1")).out) as { pending: { work: { open: unknown[]; mine: unknown[] } } };
  assert.deepEqual(pending.pending.work, { open: [], mine: [] });
});

test("mcp: valid JSON that is not a request (null, a number, a list, a string) is answered with an error and does not stop the server", async () => {
  const p = spawn(process.execPath, ["--no-warnings", "src/mcp/server.ts"], { env: { ...process.env, PIO_DATA: db, PIO_ACTOR: "agent:scout" }, stdio: ["pipe", "pipe", "inherit"] });
  const replies: Array<{ id: number | null; error?: { code: number } ; result?: unknown }> = [];
  let buf = "";
  p.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) replies.push(JSON.parse(l));
  });
  for (const line of ["null", "42", "[]", '"str"', '{"jsonrpc":"2.0","id":1,"method":7}', '{"jsonrpc":"2.0","id":9,"method":"tools/list"}']) p.stdin.write(line + "\n");
  p.stdin.end();
  const code = await new Promise((r) => p.on("close", r));
  assert.equal(code, 0, "the server survived");
  assert.deepEqual(replies.filter((r) => r.error).map((r) => r.error!.code), [-32600, -32600, -32600, -32600, -32600]);
  assert.ok(replies.some((r) => r.id === 9 && r.result), "and still answered the real request");
});

test("cli: a misspelt option is an error, not silently dropped (a claim must not lose its lease)", () => {
  const dir = mkdtempSync(join(tmpdir(), "piople-cli-"));
  const run = (...a: string[]) => spawnSync(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", join(dir, "c.sqlite"), "--as", "human:alice", ...a], { encoding: "utf8" });
  assert.equal(run("create", "--id", "c1", "--title", "t").status, 0);
  assert.equal(run("work-request", "--context", "c1", "--id", "w1", "--to", "human:alice", "--input", "{}").status, 0);
  const typo = run("work-claim", "--context", "c1", "--id", "w1", "--lease-mz", "100");
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown option --lease-mz for work-claim/);
  assert.equal(JSON.parse(run("work-claim", "--context", "c1", "--id", "w1", "--lease-ms", "100").stdout).work.attempt, 1, "the right spelling works and the typo claimed nothing");
});
