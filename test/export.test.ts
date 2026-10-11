import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import type { Context } from "../src/core/index.ts";
import { exportLabelled, redactText } from "../src/eval/export.ts";
import { runRoutingEval } from "../src/eval/routing.ts";
import { keywordClassifier } from "../src/harnesses/router.ts";

const ctx = (id: string, kind: Context["kind"], title: string, extra: Partial<Context> = {}): Context => ({ id, kind, title, goal: "", createdAt: 1, ...extra });

test("export: human posts into channels become labelled cases; router deliveries, agents, short texts and ingress are left out; the result runs in the evaluation", async () => {
  const s = new Store(":memory:");
  s.createContext(ctx("realm-a", "realm", "Infra realm"), "human:alice");
  s.createContext(ctx("ch-inc", "channel", "Production incidents outage", { realmId: "realm-a" }), "human:alice");
  s.createContext(ctx("ch-dep", "channel", "Deployments release rollout", { realmId: "realm-a" }), "human:alice");
  s.join({ contextId: "realm-a", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, "j1", "human:alice");
  s.join({ contextId: "ch-inc", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, "j2", "human:alice");
  s.join({ contextId: "realm-a", actorId: "agent:bot", capabilities: ["read", "write"], joinedAt: 2 }, "j3", "human:alice");
  s.join({ contextId: "ch-inc", actorId: "agent:bot", capabilities: ["read", "write"], joinedAt: 2 }, "j4", "human:alice");
  s.postMessage("ch-inc", "human:alice", "p1", "production is down, mail me at a.b@example.com");
  s.postMessage("ch-dep", "human:alice", "p2", "the release rollout failed");
  s.postMessage("ch-inc", "human:bob", "p3", "k"); // too short
  s.postMessage("ch-inc", "agent:bot", "p4", "I am looking at the outage"); // an agent's post is not a human label
  s.addRouter("agent:router");
  s.submitMessage("human:bob", "m1", "outage again please look");
  s.routeResolve("agent:router", "ingress:human:bob", "m1", { context: "ch-inc" } as never); // delivered by a router: not a human choice

  const d = exportLabelled(s, { redact: true });
  assert.deepEqual(d.cases.map((c) => [c.sender, c.expect, c.text]), [
    ["human:alice", "ch-inc", "production is down, mail me at <email>"],
    ["human:alice", "ch-dep", "the release rollout failed"],
  ]);
  assert.ok(d.cases.every((c) => c.tags?.includes("real")));
  assert.ok(!d.members.some((m) => m.actor === "agent:bot" && m.contexts.length === 0));
  const run = await runRoutingEval(d, keywordClassifier());
  assert.equal(run.rows.length, 2);
  assert.deepEqual(run.rows.map((r) => r.predicted), ["ch-inc", "ch-dep"]);
  s.close();
});

test("redactText masks e-mail addresses, URLs and long numbers, nothing else", () => {
  assert.equal(redactText("mail x@y.fi, see https://a.b/c?d=1 and invoice 123456789 or room 42"), "mail <email>, see <url> and invoice <number> or room 42");
});

test("export: an author whose realm role was lowered no longer has a usable label, and the dataset still replays", async () => {
  const s = new Store(":memory:");
  s.createContext(ctx("realm-a", "realm", "Infra"), "human:alice");
  s.createContext(ctx("ch-1", "channel", "Incidents outage", { realmId: "realm-a" }), "human:alice");
  s.join({ contextId: "realm-a", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, "j1", "human:alice");
  s.join({ contextId: "ch-1", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, "j2", "human:alice");
  s.postMessage("ch-1", "human:bob", "p1", "the outage is back");
  s.postMessage("ch-1", "human:alice", "p2", "looking at the outage");
  s.db.prepare(`UPDATE members SET capabilities=? WHERE context_id='realm-a' AND actor_id='human:bob'`).run(JSON.stringify(["read"]));
  const d = exportLabelled(s);
  assert.deepEqual(d.cases.map((c) => c.sender), ["human:alice"], "bob can no longer address the channel through the realm: his post is not a usable label");
  await runRoutingEval(d, keywordClassifier()); // must not throw dataset-invalid / not-in-realm
  s.close();
});

test("redactText stays fast on long inputs without an address, and still masks real ones", () => {
  const t0 = Date.now();
  redactText("a".repeat(300_000));
  redactText("a.".repeat(150_000));
  redactText("1".repeat(300_000));
  redactText(`https://${"x".repeat(300_000)}`);
  assert.ok(Date.now() - t0 < 2_000, `linear: took ${Date.now() - t0} ms (it took 7 s for 80,000 characters when quadratic)`);
  assert.equal(redactText("mail a.b+c@example.co.uk and x@y.fi"), "mail <email> and <email>");
  assert.equal(redactText("no address here, and a lone @ sign: @"), "no address here, and a lone @ sign: @");
});

test("export-main: a mistyped database or an unwritable output is a plain error, and the reader creates nothing", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, existsSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../src/core/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "piople-export-"));
  const run = (...a: string[]) => spawnSync(process.execPath, ["--no-warnings", "src/eval/export-main.ts", ...a], { encoding: "utf8" });
  const missing = join(dir, "typo.sqlite");
  const a = run("--db", missing, "--out", join(dir, "o.json"));
  assert.equal(a.status, 1);
  assert.match(a.stderr, /^error: no database at .*typo\.sqlite \(nothing was created/);
  assert.equal(existsSync(missing), false, "no empty database was created");
  assert.equal(existsSync(join(dir, "o.json")), false);
  const real = join(dir, "real.sqlite");
  new Store(real).close();
  const b = run("--db", real, "--out", join(dir, "no-such-dir", "o.json"));
  assert.equal(b.status, 1);
  assert.match(b.stderr, /^error: cannot write .*o\.json: /);
  assert.ok(!/at .*node:internal|\.ts:\d+/.test(b.stderr), "no stack trace");
  mkdirSync(join(dir, "ok"));
  const c = run("--db", real, "--out", join(dir, "ok", "o.json"));
  assert.equal(c.status, 0);
  assert.ok(existsSync(join(dir, "ok", "o.json")));
});

test("admin: revoking or listing on a mistyped database is an error that creates nothing; issuing a token still starts a database", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "piople-admin-"));
  const admin = (db: string, ...a: string[]) => spawnSync(process.execPath, ["--no-warnings", "src/cli/admin.ts", "--db", db, ...a], { encoding: "utf8" });
  const typo = join(dir, "typo.sqlite");
  for (const cmd of [["revoke-tokens", "--actor", "agent:fetch"], ["list-tokens", "--actor", "agent:fetch"], ["remove-router", "--actor", "agent:router"], ["list-routers"]]) {
    const r = admin(typo, ...cmd);
    assert.equal(r.status, 1, cmd[0]);
    assert.match(r.stderr, /^error: no database at .*typo\.sqlite \(nothing was created/, cmd[0]);
    assert.equal(r.stdout, "", `${cmd[0]} printed an answer`);
  }
  assert.equal(existsSync(typo), false, "nothing was created");
  const real = join(dir, "real.sqlite");
  assert.equal(admin(real, "issue-token", "--actor", "agent:fetch").status, 0, "issuing starts a database");
  assert.equal(admin(real, "revoke-tokens", "--actor", "agent:fetch").status, 0, "and then revoking works on it");
  assert.equal(admin(join(dir, "r2.sqlite"), "add-router", "--actor", "agent:router").status, 0, "designating a router may start one too");
});

test("eval: a wrong dataset or a meaningless number is a sentence and exit 2, never a stack trace or NaN in a report", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "piople-evalcli-"));
  writeFileSync(join(dir, "bad.json"), "{ not json");
  writeFileSync(join(dir, "shape.json"), '{"cases": "nope"}');
  writeFileSync(join(dir, "empty.json"), '{"contexts":[],"members":[],"cases":[]}');
  writeFileSync(join(dir, "case.json"), '{"contexts":[],"members":[],"cases":[{"id":"x"}]}');
  const run = (...a: string[]) => spawnSync(process.execPath, ["--no-warnings", "src/eval/main.ts", ...a], { encoding: "utf8" });
  const cases: Array<[string[], RegExp]> = [
    [["--dataset", join(dir, "missing.json")], /^error: cannot read the dataset .*missing\.json: /],
    [["--dataset", join(dir, "bad.json")], /^error: .*bad\.json is not valid JSON/],
    [["--dataset", join(dir, "shape.json")], /^error: .*shape\.json is not a routing dataset/],
    [["--dataset", join(dir, "empty.json")], /^error: .*empty\.json has no cases/],
    [["--dataset", join(dir, "case.json")], /^error: .*case\.json: case number 1 needs a string "id", "sender" and "text"/],
    [["--target-precision", "abc"], /^error: --target-precision must be a number above 0 and at most 1/],
    [["--target-precision", "2"], /^error: --target-precision must be/],
    [["--target-precision", ""], /^error: --target-precision must be/],
    [["--context", "x"], /^error: --context must be a whole number/],
    [["--context", "-1"], /^error: Option '--context' argument is ambiguous/], // the parser: a value that starts with "-" looks like an option
    [["--context=-1"], /^error: --context must be a whole number/],
    [["--needs-human-above", "7"], /^error: --needs-human-above must be a number from 0 to 1/],
  ];
  for (const [args, want] of cases) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, want, args.join(" "));
    assert.ok(!/node:internal|\.ts:\d+/.test(r.stderr), `${args.join(" ")}: no stack trace`);
    assert.equal(r.stdout, "");
  }
  const ok = run("--target-precision", "0.9", "--context", "1");
  assert.equal(ok.status, 0);
  assert.ok(!/NaN|undefined/.test(ok.stdout), "a good run has no NaN or undefined in its report");
});

test("a mistyped flag, or a flag without its value, is a sentence and exit 2 in every tool, never a stack trace of Node's files", async () => {
  const { spawnSync } = await import("node:child_process");
  const tools: Array<[string, string[]]> = [
    ["src/cli/admin.ts", ["--nonsense", "x", "list-tokens"]], ["src/cli/admin.ts", ["--db"]],
    ["src/hosts/watch.ts", ["--nonsense"]], ["src/hosts/watch.ts", ["--as"]],
    ["src/eval/export-main.ts", ["--bogus"]], ["src/eval/export-main.ts", ["--out"]],
    ["src/eval/main.ts", ["--bogus"]], ["src/eval/main.ts", ["--context", "-1"]],
  ];
  for (const [file, args] of tools) {
    const r = spawnSync(process.execPath, ["--no-warnings", file, ...args], { encoding: "utf8", input: "", timeout: 20_000 });
    assert.equal(r.status, 2, `${file} ${args.join(" ")}`);
    assert.match(r.stderr, /^error: (Unknown option|Option)/, `${file} ${args.join(" ")}: ${r.stderr.slice(0, 80)}`);
    assert.ok(!/node:internal|\.ts:\d+/.test(r.stderr), `${file} ${args.join(" ")}: no stack trace`);
    assert.equal(r.stdout, "");
  }
});
