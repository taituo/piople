import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";

/** A database as the version before migration 12 left it: the current schema without events.args_hash, version 11. */
function oldDb(path: string) {
  const s = new Store(path);
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  s.postMessage("c1", "human:alice", "k1", "written by the old version");
  s.db.exec("ALTER TABLE events DROP COLUMN args_hash");
  s.db.prepare("UPDATE meta SET v=? WHERE k='version'").run("11");
  s.close();
}
const version = (s: Store) => (s.db.prepare("SELECT v FROM meta WHERE k='version'").get() as { v: string }).v;

test("a database from before migration 12 upgrades with its data, keeps working, and treats old events as unhashed", () => {
  const path = join(mkdtempSync(join(tmpdir(), "piople-mig-")), "old.sqlite");
  oldDb(path);
  const s = new Store(path);
  assert.equal(version(s), "12");
  assert.ok((s.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).some((c) => c.name === "args_hash"));
  assert.deepEqual(s.eventsSince("c1", 0).map((e) => e.type), ["context.created", "message.posted"], "the old events are all there");
  s.postMessage("c1", "human:alice", "k2", "written by the new version");
  assert.equal(s.eventsSince("c1", 0).length, 3);
  // an old event has no hash: the same key replays whatever content comes (no error), as before the migration
  const replay = s.withCallHash("some-hash", () => s.postMessage("c1", "human:alice", "k1", "other words"));
  assert.equal(replay.data.text, "written by the old version");
  // a new event has one: another request under its key is refused
  s.withCallHash("hash-a", () => s.postMessage("c1", "human:alice", "k3", "first"));
  assert.throws(() => s.withCallHash("hash-b", () => s.postMessage("c1", "human:alice", "k3", "second")), /key-conflict/);
  s.close();
  assert.equal(version(new Store(path)), "12", "opening again changes nothing");
});

test("many processes opening the same old database at once all upgrade it safely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piople-mig-race-"));
  const base = join(dir, "base.sqlite");
  oldDb(base);
  const path = join(dir, "race.sqlite");
  copyFileSync(base, path);
  const results = await Promise.all(Array.from({ length: 12 }, () => new Promise<{ code: number | null; err: string }>((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", path, "--as", "human:alice", "events", "--context", "c1"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("close", (code) => resolve({ code, err }));
  })));
  assert.deepEqual(results.filter((r) => r.code !== 0), []);
  const s = new Store(path);
  assert.equal(version(s), "12");
  assert.equal(s.eventsSince("c1", 0).length, 2);
  s.close();
});

test("a database from a newer version is refused with a clear error, untouched, and a database at the current version still opens", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Store } = await import("../src/core/index.ts");
  const path = join(mkdtempSync(join(tmpdir(), "piople-newer-")), "x.db");
  const first = new Store(path);
  first.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  first.close();
  const db = new DatabaseSync(path);
  const current = Number((db.prepare("SELECT v FROM meta WHERE k='version'").get() as { v: string }).v);
  db.prepare("UPDATE meta SET v=? WHERE k='version'").run(String(current + 5));
  const before = JSON.stringify(db.prepare("SELECT seq, type FROM events").all());
  db.close();
  assert.throws(() => new Store(path), (e: Error) => new RegExp(`^cannot-open-database: .*database-too-new: this database is at schema version ${current + 5}, this program knows up to ${current}`).test(e.message));
  const after = new DatabaseSync(path);
  assert.equal(JSON.stringify(after.prepare("SELECT seq, type FROM events").all()), before, "nothing was written");
  assert.equal((after.prepare("SELECT v FROM meta WHERE k='version'").get() as { v: string }).v, String(current + 5), "and the version is as it was");
  after.prepare("UPDATE meta SET v=? WHERE k='version'").run(String(current));
  after.close();
  new Store(path).close(); // back at the current version, it opens again
});
