import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";

function world() {
  const s = new Store(":memory:");
  s.upsertActor({ id: "human:alice", kind: "human", name: "alice" });
  s.upsertActor({ id: "agent:scout", kind: "agent", name: "scout" });
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "g", createdAt: 1 }, "human:alice");
  s.join({ contextId: "c1", actorId: "agent:scout", capabilities: ["read", "write"], joinedAt: 2 }, "j-scout", "human:alice");
  return s;
}
const art = { id: "o1", contextId: "c1", kind: "finding" as const, authorId: "agent:scout", text: "x", status: "hypothesis" as const, evidence: [], createdAt: 3 };
const dec = { id: "d1", contextId: "c1", question: "q?", options: ["yes", "no"], requestedBy: "agent:scout", decidedBy: null, answer: null, status: "open" as const, createdAt: 4, resolvedAt: null };

test("every mutation replays to the original event, with no error and no duplicate", () => {
  const s = world();
  const calls: Array<[string, () => { seq: number }]> = [
    ["create", () => s.createContext({ id: "c1", kind: "case", title: "t", goal: "g", createdAt: 1 }, "human:alice")],
    ["join", () => s.join({ contextId: "c1", actorId: "agent:scout", capabilities: ["read", "write"], joinedAt: 2 }, "j-scout", "human:alice")],
    ["post", () => s.postMessage("c1", "human:alice", "m1", "hi")],
    ["observe", () => s.recordObservation(art)],
    ["promote", () => s.promoteObservation("o1", "human:alice", "confirmed")],
    ["ask", () => s.requestAssistance("c1", "agent:scout", "a1", "agent:expert", "help?", {})],
    ["answer", () => s.answerAssistance("c1", "agent:scout", "r1", "a1", "yes", [])],
    ["decision", () => s.requestDecision(dec)],
    ["decide", () => s.resolveDecision("c1", "human:alice", "k1", "d1", "yes")],
    ["propose", () => s.proposeAction({ ...art, id: "p1", kind: "proposal" }, { verb: "patch", res: "cm", ns: "n" }, "d1")],
    ["execute", () => s.recordExecution("c1", "agent:scout", "x1", "p1", "d1", true, "ok")],
    ["presence", () => s.setPresence("human:alice", "away", false, "pk1")!],
  ];
  for (const [name, call] of calls) {
    const first = call();
    const again = call();
    assert.equal(again.seq, first.seq, `${name} replay returned a different event`);
  }
  const seqs = s.eventsSince("c1", 0).map((e) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal((s.db.prepare(`SELECT COUNT(*) n FROM decisions`).get() as { n: number }).n, 1);
  assert.equal((s.db.prepare(`SELECT COUNT(*) n FROM artifacts`).get() as { n: number }).n, 2);
  s.close();
});

test("same key for another operation or actor is a conflict, not a silent replay", () => {
  const s = world();
  s.postMessage("c1", "human:alice", "k", "hi");
  assert.throws(() => s.requestAssistance("c1", "human:alice", "k", "agent:scout", "q", {}), /key-conflict/);
  assert.throws(() => s.postMessage("c1", "agent:scout", "k", "hi"), /key-conflict/);
  s.close();
});

test("a failing write leaves no half-done state", () => {
  const s = world();
  s.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON events WHEN NEW.type='decision.requested' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
  assert.throws(() => s.requestDecision(dec), /boom/);
  assert.equal((s.db.prepare(`SELECT COUNT(*) n FROM decisions`).get() as { n: number }).n, 0);
  s.db.exec(`DROP TRIGGER boom`);
  s.requestDecision(dec); // the same call succeeds once the fault is gone
  assert.equal((s.db.prepare(`SELECT COUNT(*) n FROM decisions`).get() as { n: number }).n, 1);
  s.close();
});

test("a second resolve with a new key is refused; a replayed presence key never reverts state", () => {
  const s = world();
  s.requestDecision(dec);
  s.resolveDecision("c1", "human:alice", "k1", "d1", "yes");
  assert.throws(() => s.resolveDecision("c1", "human:alice", "k2", "d1", "no"), /decision-not-open/);
  s.setPresence("human:alice", "away", true, "p1");
  s.setPresence("human:alice", "active", false, "p2");
  s.setPresence("human:alice", "away", true, "p1"); // late replay of the old call
  const row = s.db.prepare(`SELECT state, echo FROM presence WHERE actor_id='human:alice'`).get() as { state: string; echo: number };
  assert.deepEqual({ ...row }, { state: "active", echo: 0 });
  s.close();
});

test("readEvents needs the read capability, not just membership", () => {
  const s = world();
  s.join({ contextId: "c1", actorId: "agent:blind", capabilities: ["write"], joinedAt: 5 }, "j-blind", "human:alice");
  assert.ok(s.readEvents("c1", "agent:scout", 0).length > 0);
  assert.throws(() => s.readEvents("c1", "agent:blind", 0), /lacks read/);
  assert.throws(() => s.readEvents("c1", "agent:stranger", 0), /not-a-member/);
  s.close();
});
