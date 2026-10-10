import test from "node:test";
import assert from "node:assert/strict";
import { K8sLauncher } from "../src/adapters/k8s.ts";
import { runWork } from "../src/hosts/worker.ts";

const PROTO = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

test("a skill named like an Object.prototype member is not a launch profile: nothing is launched and no error is counted", async () => {
  const created: unknown[] = [];
  const runner = { async create(m: Record<string, unknown>) { created.push(m); return "created" as const; } };
  const profiles = { "lab.echo": { image: "img:1", actor: "agent:w", coreUrl: "http://core", tokenSecret: { name: "s", key: "k" } } };
  for (const skill of PROTO) {
    const l = new K8sLauncher({ namespace: "ns", profiles, delayMs: 0, runner, everyMs: 0 });
    await l.poll({ run: async () => [{ id: "w1", contextId: "c1", skill, to: null, createdAt: 0 }] } as never);
    assert.deepEqual(l.stats, { launched: 0, existing: 0, errors: 0 }, skill);
  }
  assert.equal(created.length, 0);
  const real = new K8sLauncher({ namespace: "ns", profiles, delayMs: 0, runner, everyMs: 0 });
  await real.poll({ run: async () => [{ id: "w2", contextId: "c1", skill: "lab.echo", to: null, createdAt: 0 }] } as never);
  assert.equal(real.stats.launched, 1, "a real skill still launches");
});

test("a worker told to run a skill named like an Object.prototype member has no executor and fails the work cleanly", async () => {
  for (const skill of PROTO) {
    const calls: string[] = [];
    const core = { async call(_as: string, op: string) { calls.push(op); return op === "work-claim" ? { work: { attempt: 1, input: {} } } : {}; } };
    const outcome = await runWork(core as never, { actor: "agent:w", context: "c1", workId: "w1", skill });
    assert.equal(outcome, "failed", skill);
    assert.deepEqual(calls, ["actor", "work-claim", "work-fail"], `${skill}: no executor was called`);
  }
});
