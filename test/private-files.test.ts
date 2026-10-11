import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { CaseMemory, extractiveSummarizer } from "../src/harnesses/memory.ts";

const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

test("a new database is private to its owner: file 0600, a new directory 0700, the WAL files too; an existing one is left as the operator made it", () => {
  const old = process.umask(0o022); // the usual umask, which would give 0644
  try {
    const base = mkdtempSync(join(tmpdir(), "piople-private-"));
    const dir = join(base, "data", "deep");
    const path = join(dir, "piople.sqlite");
    const s = new Store(path);
    s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
    s.postMessage("c1", "human:alice", "k1", "private words");
    assert.equal(mode(path), "600");
    assert.equal(mode(dir), "700", "the directory this created");
    assert.equal(mode(join(base, "data")), "700", "and the parent it created on the way");
    for (const ext of ["-wal", "-shm"]) if (existsSync(path + ext)) assert.equal(mode(path + ext), "600", ext);
    s.close();
    // memory files hold case text as well
    const mem = CaseMemory.open(join(dir, "m.memory.sqlite"), { summarizer: extractiveSummarizer(), k: 4, recent: 2 });
    mem.ingest("c", [{ seq: 1, actorId: "human:a", type: "message.posted", data: { text: "x" } }]);
    assert.equal(mode(join(dir, "m.memory.sqlite")), "600");
    mem.close();
    // what already exists is the operator's: not changed, not refused
    const shared = join(base, "shared");
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    const existing = join(shared, "old.sqlite");
    writeFileSync(existing, "");
    chmodSync(existing, 0o664);
    const s2 = new Store(existing);
    s2.close();
    assert.equal(mode(existing), "664");
    assert.equal(mode(shared), "755");
  } finally {
    process.umask(old);
  }
});
