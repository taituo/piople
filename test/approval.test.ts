import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { executeIfApproved } from "../src/agents/executor.ts";

function setup() {
  const s = new Store(":memory:");
  s.upsertActor({ id: "human:alice", kind: "human", name: "alice" });
  s.upsertActor({ id: "agent:builder", kind: "agent", name: "builder" });
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "g", createdAt: Date.now() }, "human:alice");
  s.join({ contextId: "c1", actorId: "agent:builder", capabilities: ["read", "write"], joinedAt: Date.now() }, "j");
  return s;
}

const action = { verb: "patch", res: "configmap", ns: "demo-apps", name: "checkout-config", patch: { data: { POOL_SIZE: "5" } } };

test("proposal without approval is refused, never runs", async () => {
  const s = setup();
  s.proposeAction({ id: "p1", contextId: "c1", kind: "proposal", authorId: "agent:builder", text: "patch POOL_SIZE", status: null, evidence: [], createdAt: Date.now() }, action, "d1");
  s.requestDecision({ id: "d1", contextId: "c1", question: "Apply?", options: ["yes", "no"], requestedBy: "agent:builder", decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
  const r = await executeIfApproved(s, "c1", "human:alice", "p1", "d1");
  assert.equal(r.ran, false);
  assert.match(r.output, /decision d1 is open/);
  s.close();
});

test("approval + no operator opt-in still refuses (dry-run default)", async () => {
  const s = setup();
  s.proposeAction({ id: "p1", contextId: "c1", kind: "proposal", authorId: "agent:builder", text: "patch", status: null, evidence: [], createdAt: Date.now() }, action, "d1");
  s.requestDecision({ id: "d1", contextId: "c1", question: "Apply?", options: ["yes", "no"], requestedBy: "agent:builder", decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
  s.resolveDecision("c1", "human:alice", "k", "d1", "yes");
  const r = await executeIfApproved(s, "c1", "human:alice", "p1", "d1");
  assert.equal(r.ran, false);
  assert.match(r.output, /PIO_ALLOW_WRITE/);
  const evs = s.eventsSince("c1", 0).map((e) => e.type);
  assert.ok(evs.includes("action.proposed") && evs.includes("action.executed"));
  s.close();
});

test("negative decision blocks even with opt-in", async () => {
  process.env.PIO_ALLOW_WRITE = "1";
  try {
    const s = setup();
    s.proposeAction({ id: "p1", contextId: "c1", kind: "proposal", authorId: "agent:builder", text: "patch", status: null, evidence: [], createdAt: Date.now() }, action, "d1");
    s.requestDecision({ id: "d1", contextId: "c1", question: "Apply?", options: ["yes", "no"], requestedBy: "agent:builder", decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
    s.resolveDecision("c1", "human:alice", "k", "d1", "no");
    const r = await executeIfApproved(s, "c1", "human:alice", "p1", "d1");
    assert.equal(r.ran, false);
    s.close();
  } finally {
    delete process.env.PIO_ALLOW_WRITE;
  }
});

test("executor runs the stored proposal, only for its bound decision, and is refused on mismatch", async () => {
  const s = setup();
  s.proposeAction({ id: "p1", contextId: "c1", kind: "proposal", authorId: "agent:builder", text: "patch", status: null, evidence: [], createdAt: Date.now() }, action, "d1");
  s.requestDecision({ id: "d1", contextId: "c1", question: "Apply?", options: ["yes", "no"], requestedBy: "agent:builder", decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
  s.requestDecision({ id: "d2", contextId: "c1", question: "Other?", options: ["yes", "no"], requestedBy: "agent:builder", decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
  s.resolveDecision("c1", "human:alice", "k", "d2", "yes");
  const wrong = await executeIfApproved(s, "c1", "human:alice", "p1", "d2");
  assert.equal(wrong.ran, false);
  assert.match(wrong.output, /not bound to proposal/);
  const unknown = await executeIfApproved(s, "c1", "human:alice", "nope", "d1");
  assert.match(unknown.output, /unknown proposal/);
  s.close();
});

test("an old refusal does not shadow a later retry", async () => {
  const s = setup();
  s.proposeAction({ id: "p1", contextId: "c1", kind: "proposal", authorId: "agent:builder", text: "patch", status: null, evidence: [], createdAt: Date.now() }, action, "d1");
  s.requestDecision({ id: "d1", contextId: "c1", question: "Apply?", options: ["yes", "no"], requestedBy: "agent:builder", decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
  await executeIfApproved(s, "c1", "human:alice", "p1", "d1");
  s.resolveDecision("c1", "human:alice", "k", "d1", "yes");
  const again = await executeIfApproved(s, "c1", "human:alice", "p1", "d1");
  assert.match(again.output, /PIO_ALLOW_WRITE/, "re-evaluated, not replayed");
  const refusals = s.eventsSince("c1", 0).filter((e) => e.type === "action.executed");
  assert.equal(refusals.length, 2);
  s.close();
});
