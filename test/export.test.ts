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
