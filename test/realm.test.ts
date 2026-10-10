import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import type { Context } from "../src/core/index.ts";
import { statusFor } from "../src/http/server.ts";

const ctx = (id: string, kind: Context["kind"], extra: Partial<Context> = {}): Context => ({ id, kind, title: id, goal: "", createdAt: 1, ...extra });

function world() {
  const s = new Store(":memory:");
  s.createContext(ctx("realm-infra", "realm"), "human:alice");
  s.join({ contextId: "realm-infra", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, "j-bob", "human:alice");
  s.join({ contextId: "realm-infra", actorId: "agent:carol", capabilities: ["read"], joinedAt: 2 }, "j-carol", "human:alice");
  return s;
}

test("roles in a realm: writing is needed to create inside it, and what a creator holds is capped by its realm role", () => {
  const s = world();
  assert.throws(() => s.createContext(ctx("ch-x", "channel", { realmId: "realm-infra" }), "agent:carol"), /lacks write in realm-infra/);
  assert.throws(() => s.createContext(ctx("ch-x", "channel", { realmId: "realm-infra" }), "human:dave"), /not-a-member/);

  const ev = s.createContext(ctx("ch-incidents", "channel", { realmId: "realm-infra" }), "human:bob");
  assert.deepEqual(ev.data, { title: "ch-incidents", kind: "channel", realm: "realm-infra", parent: null });
  assert.deepEqual(s.targets("human:bob").find((t) => t.id === "ch-incidents")!.capabilities, ["read", "write"], "bob has no decide in the realm, so none in its channel");

  s.createContext(ctx("case-1", "case", { parentId: "ch-incidents" }), "human:bob");
  const t = s.targets("human:bob").find((x) => x.id === "case-1")!;
  assert.deepEqual([t.kind, t.realm, t.parent], ["case", "realm-infra", "ch-incidents"], "a case under a channel lives in the channel's realm");
  s.close();
});

test("the realm is the upper bound: you cannot join a context inside it without the realm, nor hold more than you hold there", () => {
  const s = world();
  s.createContext(ctx("ch-incidents", "channel", { realmId: "realm-infra" }), "human:alice");
  const join = (actor: string, caps: string[], key: string) => s.join({ contextId: "ch-incidents", actorId: actor, capabilities: caps, joinedAt: 3 }, key, "human:alice");

  assert.throws(() => join("human:dave", ["read"], "j1"), /not-in-realm: human:dave must be a member of realm-infra/);
  assert.throws(() => join("agent:carol", ["read", "write"], "j2"), /holds only read in realm-infra, cannot be granted write/);
  join("agent:carol", ["read"], "j3");
  join("human:bob", ["read", "write"], "j4");
  assert.throws(() => join("human:bob", ["read", "write", "decide"], "j5"), /cannot be granted decide/);

  s.join({ contextId: "realm-infra", actorId: "human:dave", capabilities: ["read", "write"], joinedAt: 4 }, "j-dave", "human:alice");
  join("human:dave", ["read", "write"], "j6");
  s.close();
});

test("effective capabilities follow the realm at every access: lowering a realm role lowers it everywhere inside", () => {
  const s = world();
  s.createContext(ctx("ch-incidents", "channel", { realmId: "realm-infra" }), "human:alice");
  s.join({ contextId: "ch-incidents", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 3 }, "jb", "human:alice");
  s.postMessage("ch-incidents", "human:bob", "m1", "hello");
  assert.ok(s.targets("human:bob").some((t) => t.id === "ch-incidents"));

  s.join({ contextId: "realm-infra", actorId: "human:bob", capabilities: ["read"], joinedAt: 4 }, "j-bob-down", "human:alice");
  assert.throws(() => s.postMessage("ch-incidents", "human:bob", "m2", "again"), /lacks write in ch-incidents/);
  assert.ok(s.readEvents("ch-incidents", "human:bob", 0).length > 0, "reading still works");
  assert.ok(!s.targets("human:bob").some((t) => t.id === "ch-incidents"), "no longer addressable for writing");
  assert.ok(s.inbox("human:bob").some((c) => c.context === "ch-incidents"));
  s.close();
});

test("placement is validated: kinds, realms and channels", () => {
  const s = world();
  s.createContext(ctx("ch-a", "channel", { realmId: "realm-infra" }), "human:alice");
  s.createContext(ctx("realm-other", "realm"), "human:alice");
  s.createContext(ctx("ch-b", "channel", { realmId: "realm-other" }), "human:alice");

  assert.throws(() => s.createContext(ctx("x1", "channel"), "human:alice"), /a channel needs a realm/);
  assert.throws(() => s.createContext(ctx("x2", "channel", { realmId: "realm-infra", parentId: "ch-a" }), "human:alice"), /has no parent/);
  assert.throws(() => s.createContext(ctx("x3", "realm", { realmId: "realm-infra" }), "human:alice"), /a realm has no realm or parent/);
  assert.throws(() => s.createContext(ctx("x4", "nope" as never), "human:alice"), /bad-kind/);
  assert.throws(() => s.createContext(ctx("x5", "case", { parentId: "realm-infra" }), "human:alice"), /parent realm-infra is not a channel/);
  assert.throws(() => s.createContext(ctx("x6", "case", { parentId: "ch-b", realmId: "realm-infra" }), "human:alice"), /channel ch-b is in another realm/);
  assert.throws(() => s.createContext(ctx("x7", "case", { realmId: "ch-a" }), "human:alice"), /ch-a is not a realm/);
  assert.throws(() => s.createContext(ctx("x8", "case", { parentId: "nowhere" }), "human:alice"), /parent nowhere is not a channel/);
  // writing in the realm is not enough to create under a channel you are not in
  assert.throws(() => s.createContext(ctx("x9", "case", { parentId: "ch-a" }), "human:bob"), /not-a-member: human:bob not in ch-a/);
  assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM contexts WHERE id LIKE 'x%'`).get()!.n, 0, "refused creations leave nothing behind");
  s.close();
});

test("realms isolate: nothing leaks across, and what you may address is only what you may write", () => {
  const s = world();
  s.createContext(ctx("ch-a", "channel", { realmId: "realm-infra" }), "human:alice");
  s.createContext(ctx("realm-other", "realm"), "human:alice");
  s.join({ contextId: "realm-other", actorId: "human:erin", capabilities: ["read", "write"], joinedAt: 3 }, "j-erin", "human:alice");
  s.createContext(ctx("ch-b", "channel", { realmId: "realm-other" }), "human:erin");
  s.postMessage("ch-a", "human:alice", "m1", "secret");

  assert.throws(() => s.readEvents("ch-a", "human:erin", 0), /not-a-member/);
  assert.throws(() => s.postMessage("ch-a", "human:erin", "m2", "hi"), /not-a-member/);
  assert.throws(() => s.join({ contextId: "ch-a", actorId: "human:erin", capabilities: ["read"], joinedAt: 4 }, "j", "human:alice"), /not-in-realm/);
  assert.deepEqual(s.inbox("human:erin").map((c) => c.context), ["realm-other", "ch-b"]);
  assert.deepEqual(s.targets("human:erin").map((t) => t.id), ["realm-other", "ch-b"]);
  assert.deepEqual(s.targets("human:alice").map((t) => [t.id, t.kind]), [["realm-infra", "realm"], ["ch-a", "channel"], ["realm-other", "realm"]]);
  assert.deepEqual(s.targets("agent:carol").map((t) => t.id), [], "read-only in the realm: nothing to write to");
  assert.deepEqual(s.inbox("agent:carol").map((c) => [c.context, c.kind, c.realm]), [["realm-infra", "realm", null]]);
  s.close();
});

test("standalone cases are unchanged; creating twice replays", () => {
  const s = new Store(":memory:");
  const a = s.createContext(ctx("case-1", "case"), "human:alice");
  assert.equal(s.createContext(ctx("case-1", "case"), "human:alice").seq, a.seq);
  assert.deepEqual(s.targets("human:alice"), [{ id: "case-1", kind: "case", title: "case-1", realm: null, parent: null, capabilities: ["read", "write", "decide"] }]);
  s.close();
});

test("CLI: realm, channel and targets; an outsider is refused; HTTP maps not-in-realm to 403", () => {
  const db = join(mkdtempSync(join(tmpdir(), "piople-realm-")), "r.sqlite");
  const cli = (as: string, ...a: string[]) => JSON.parse(execFileSync(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", db, "--as", as, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  cli("human:alice", "create", "--kind", "realm", "--id", "realm-x", "--title", "X");
  cli("human:alice", "join", "--context", "realm-x", "--actor", "human:bob", "--caps", "read,write");
  cli("human:alice", "create", "--kind", "channel", "--realm", "realm-x", "--id", "ch-1", "--title", "Incidents");
  cli("human:alice", "join", "--context", "ch-1", "--actor", "human:bob", "--caps", "read,write");
  assert.deepEqual(cli("human:bob", "targets").map((t: any) => [t.id, t.kind, t.realm]), [["realm-x", "realm", null], ["ch-1", "channel", "realm-x"]]);
  assert.throws(() => cli("human:alice", "join", "--context", "ch-1", "--actor", "agent:outsider", "--caps", "read"), /not-in-realm/);
  assert.equal(statusFor("not-in-realm: x must be a member").status, 403);
  assert.equal(statusFor("bad-context: a channel needs a realm").status, 400);
});
