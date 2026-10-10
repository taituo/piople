import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";

function world() {
  const s = new Store(":memory:");
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  s.join({ contextId: "c1", actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, "j1", "human:alice");
  s.join({ contextId: "c1", actorId: "human:viewer", capabilities: ["read"], joinedAt: 2 }, "j2", "human:alice");
  s.requestAssistance("c1", "human:alice", "ask-bob", "human:bob", "bob: approve?", {});
  s.requestAssistance("c1", "human:alice", "ask-viewer", "human:viewer", "viewer: opinion?", {});
  s.requestAssistance("c1", "human:alice", "ask-carol", "human:carol", "carol (outside): opinion?", {});
  return s;
}
const pending = (s: Store, a: string) => (s.inboxOf("c1", a) as any).pending.assistance.map((x: any) => x.key);

test("answer: a read-only member may answer an ask addressed to them, but not anyone else's", () => {
  const s = world();
  s.answerAssistance("c1", "human:viewer", "a1", "ask-viewer", "looks fine", []);
  assert.throws(() => s.answerAssistance("c1", "human:viewer", "a2", "ask-bob", "I answer for bob", []), /forbidden: human:viewer lacks write/);
  s.close();
});

test("answer: an invited expert answers only the ask addressed to them, and only once; it cannot clear someone else's pending ask", () => {
  const s = world();
  assert.deepEqual(pending(s, "human:bob"), ["ask-bob"]);
  assert.throws(() => s.answerAssistance("c1", "human:carol", "a1", "ask-bob", "I answer for bob: yes", []), /not-a-member/);
  assert.deepEqual(pending(s, "human:bob"), ["ask-bob"], "bob's ask is still his");
  s.answerAssistance("c1", "human:carol", "a2", "ask-carol", "my opinion", []);
  assert.throws(() => s.answerAssistance("c1", "human:carol", "a3", "ask-carol", "another", []), /already-answered/);
  assert.throws(() => s.answerAssistance("c1", "human:carol", "a4", "ask-bob", "spam", []), /not-a-member/);
  assert.equal(s.eventsSince("c1", 0).filter((e) => e.type === "assistance.answered").length, 1);
  s.close();
});

test("answer: replaying the same call returns the original event, also for an expert who has answered", () => {
  const s = world();
  const first = s.answerAssistance("c1", "human:carol", "a2", "ask-carol", "my opinion", []);
  const again = s.answerAssistance("c1", "human:carol", "a2", "ask-carol", "my opinion", []);
  assert.equal(again.seq, first.seq);
  s.close();
});

test("answer: a removed member can no longer answer, even an ask addressed to them; a member who can write still may answer others' asks", () => {
  const s = world();
  s.removeMember("c1", "human:bob", "rm", "human:alice");
  assert.throws(() => s.answerAssistance("c1", "human:bob", "a1", "ask-bob", "still here", []), /not-a-member/);
  s.answerAssistance("c1", "human:alice", "a2", "ask-bob", "alice answers for bob", []); // alice can write
  assert.deepEqual(pending(s, "human:alice").includes("ask-bob"), false);
  s.close();
});
