import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { LocalCore } from "../src/hosts/host.ts";

/**
 * Ids made before the look-alike rules (Unicode form NFC, no invisible characters) are in databases that exist. After the
 * rules they must keep working: a person whose name has a decomposed letter (typed on a Mac) must not be locked out of their
 * own cases. Only a NEW name is held to the rules.
 */
test("an actor and a case with ids from before the look-alike rules keep working; a new one is still refused", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "piople-legacy-")), "x.db");
  const nfd = "äiti";
  { const s = new Store(path); s.createContext({ id: "c-old", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice"); s.close(); }
  { // what a database from before the rules holds: an actor, a case and a membership with decomposed letters
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("INSERT INTO actors(id,kind,name) VALUES(?,?,?)").run(`human:${nfd}`, "human", `human:${nfd}`);
    db.prepare("INSERT INTO contexts(id,kind,title,goal,created_at) VALUES(?,?,?,?,?)").run(`case-${nfd}`, "case", "old", "", 1);
    db.prepare("INSERT INTO members(context_id,actor_id,capabilities,joined_at) VALUES(?,?,?,?)").run(`case-${nfd}`, `human:${nfd}`, JSON.stringify(["read", "write", "decide"]), 1);
    db.close();
  }
  const s = new Store(path);
  const core = new LocalCore(s);
  const as = (a: string) => (op: string, x: Record<string, unknown> = {}) => core.call(a, op, x) as Promise<any>;
  try {
    const old = as(`human:${nfd}`);
    await old("post", { context: `case-${nfd}`, text: "still here", key: "k1" });
    assert.equal((await old("inbox", { context: `case-${nfd}` })).events.length >= 1, true, "the old actor reads its inbox");
    assert.ok(s.knowsActor(`human:${nfd}`));
    // the old actor can be given a token and added to another case
    assert.ok(s.issueToken(`human:${nfd}`));
    await as("human:alice")("join", { context: "c-old", actor: `human:${nfd}`, caps: "read,write" });
    // a NEW actor with a decomposed letter is refused, and so is an invisible character in a new name
    await assert.rejects(as("human:alice")("join", { context: "c-old", actor: "human:öljy", caps: "read" }), /bad-actor/);
    await assert.rejects(as("human:öljy")("actor"), /bad-actor/);
    assert.throws(() => s.issueToken("human:ali​ce"), /bad-actor/);
    await assert.rejects(as("human:alice")("create", { id: "new​case", title: "t" }), /bad-arg/);
  } finally {
    s.close();
  }
});
