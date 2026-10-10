import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";

/** Found by mutation testing (=== turned into !==): behaviours nothing pinned down. */

test("a Store opened on a path in a directory that does not exist yet creates the directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "piople-eq-"));
  const path = join(dir, "a", "b", "c", "p.sqlite");
  assert.equal(existsSync(join(dir, "a")), false);
  const s = new Store(path);
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  s.close();
  assert.equal(existsSync(path), true);
  assert.equal(new Store(path).eventsSince("c1", 0).length, 1, "and the data is there on the next open");
});

test("leaving a realm: each inner context's event lists only the work reopened in that context", () => {
  const s = new Store(":memory:");
  s.createContext({ id: "r1", kind: "realm", title: "R", goal: "", createdAt: 1 }, "human:alice");
  for (const c of ["ch1", "ch2"]) s.createContext({ id: c, kind: "channel", title: c, goal: "", createdAt: 1, realmId: "r1" }, "human:alice");
  s.upsertActor({ id: "agent:w", kind: "agent", name: "w" });
  s.join({ contextId: "r1", actorId: "agent:w", capabilities: ["read", "write"], joinedAt: 2 }, "jr", "human:alice");
  for (const c of ["ch1", "ch2"]) s.join({ contextId: c, actorId: "agent:w", capabilities: ["read", "write"], joinedAt: 2 }, `j-${c}`, "human:alice");
  s.requestWork("ch1", "human:alice", { id: "w-one", to: "agent:w", input: {} });
  s.requestWork("ch2", "human:alice", { id: "w-two", to: "agent:w", input: {} });
  s.claimWork("ch1", "agent:w", "w-one");
  s.claimWork("ch2", "agent:w", "w-two");
  const ev = s.removeMember("r1", "agent:w", "rm1", "human:alice");
  assert.deepEqual(ev.data.reopenedWork, [], "the realm itself held no work");
  const reopened = (c: string) => s.eventsSince(c, 0).find((e) => e.type === "member.removed")!.data.reopenedWork;
  assert.deepEqual(reopened("ch1"), ["w-one"]);
  assert.deepEqual(reopened("ch2"), ["w-two"]);
  assert.equal(s.getWork("ch1", "w-one")!.status, "open");
  assert.equal(s.getWork("ch2", "w-two")!.status, "open");
  s.close();
});

test("isMember says yes for members, no for strangers and for someone who left", () => {
  const s = new Store(":memory:");
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  s.join({ contextId: "c1", actorId: "human:bob", capabilities: ["read"], joinedAt: 2 }, "jb", "human:alice");
  assert.equal(s.isMember("c1", "human:alice"), true);
  assert.equal(s.isMember("c1", "human:bob"), true);
  assert.equal(s.isMember("c1", "human:eve"), false);
  assert.equal(s.isMember("nope", "human:alice"), false);
  s.removeMember("c1", "human:bob", "rm", "human:alice");
  assert.equal(s.isMember("c1", "human:bob"), false);
  s.close();
});

test("a token without a lifetime never expires; one with a lifetime stops working at its end", () => {
  const s = new Store(":memory:");
  const forever = s.issueToken("human:alice", undefined, 1_000);
  const short = s.issueToken("human:bob", 500, 1_000); // expires_at = 1500
  assert.equal(s.actorForToken(forever, 1_000_000_000_000), "human:alice", "no lifetime: still good in the far future");
  assert.equal(s.actorForToken(short, 1_499), "human:bob");
  assert.equal(s.actorForToken(short, 1_500), undefined, "at its end the token no longer works");
  assert.equal(s.actorForToken(short, 2_000), undefined);
  s.close();
});
