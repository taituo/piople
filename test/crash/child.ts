// One "process lifetime" against files in a directory. test/crash.test.ts SIGKILLs it at named failpoints
// (PIO_FAILPOINT) and then runs it again to prove the system converges with every effect exactly once.
import fs from "node:fs";
import path from "node:path";
import { Store } from "../../src/core/index.ts";
import { executeIfApproved, type Adapter } from "../../src/agents/executor.ts";

const [dir, action] = process.argv.slice(2) as [string, string];
const s = new Store(path.join(dir, "case.sqlite"));
const effects = path.join(dir, "effects.log");

// A persistent, idempotent adapter: the external world is a file; a repeated key is a no-op.
const adapter: Adapter = {
  check: () => null,
  describe: () => "append to effects.log",
  async run(a, { idempotencyKey }) {
    const lines = fs.existsSync(effects) ? fs.readFileSync(effects, "utf8").split("\n").filter(Boolean) : [];
    if (!lines.some((l) => l.startsWith(`${idempotencyKey}\t`))) fs.appendFileSync(effects, `${idempotencyKey}\t${JSON.stringify(a)}\n`);
    return { ok: true, output: "applied" };
  },
};

function setup() {
  for (const [id, kind] of [["human:alice", "human"], ["agent:a", "agent"]] as const) s.upsertActor({ id, kind, name: id });
  try { s.createContext({ id: "c", kind: "case", title: "t", goal: "g", createdAt: 1 }, "human:alice"); } catch { /* exists */ }
  s.join({ contextId: "c", actorId: "agent:a", capabilities: ["read", "write"], joinedAt: 1 }, "j");
}
setup();

if (action === "observe") {
  s.recordObservation({ id: "o1", contextId: "c", kind: "finding", authorId: "agent:a", text: "x", status: "hypothesis", evidence: ["e"], createdAt: 1 });
}
if (action === "exec") {
  s.proposeAction({ id: "p1", contextId: "c", kind: "proposal", authorId: "agent:a", text: "do it", status: null, evidence: [], createdAt: 1 }, { adapter: "fs", verb: "set" }, "d1");
  s.requestDecision({ id: "d1", contextId: "c", question: "go?", options: ["yes", "no"], requestedBy: "agent:a", decidedBy: null, answer: null, status: "open", createdAt: 1, resolvedAt: null });
  if (s.getDecision("c", "d1")?.status === "open") s.resolveDecision("c", "human:alice", "decide:d1", "d1", "yes");
  await executeIfApproved(s, "c", "human:alice", "p1", "d1", { adapters: { fs: adapter }, allowWrite: true });
}

const count = (sql: string) => (s.db.prepare(sql).get() as { n: number }).n;
console.log("SUMMARY " + JSON.stringify({
  artifacts: count("SELECT COUNT(*) n FROM artifacts"),
  observed: count("SELECT COUNT(*) n FROM events WHERE type='observation.recorded'"),
  executed: count("SELECT COUNT(*) n FROM events WHERE type='action.executed' AND json_extract(data,'$.ok')=1"),
  resolved: count("SELECT COUNT(*) n FROM events WHERE type='decision.resolved'"),
  effects: fs.existsSync(effects) ? fs.readFileSync(effects, "utf8").split("\n").filter(Boolean).length : 0,
}));
s.close();
