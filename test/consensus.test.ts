import test from "node:test";
import assert from "node:assert/strict";
import { consensusClassifier } from "../src/harnesses/consensus.ts";
import type { Classifier, ClassifyInput } from "../src/harnesses/router.ts";

const targets = [
  { id: "a", kind: "channel", title: "A", realm: null, parent: null },
  { id: "b", kind: "channel", title: "B", realm: null, parent: null },
];
const input: ClassifyInput = { text: "x", sender: "human:x", hops: 0, targets, stage: "targets" };
const fixed = (pick: (first: string) => string | null, conf = 0.9): Classifier => ({
  name: "fake", version: "1",
  async classify(i) {
    const c = pick(i.targets[0]!.id);
    return { choice: c, probabilities: { a: c === "a" ? conf : 1 - conf, b: c === "b" ? conf : 1 - conf }, confidence: conf };
  },
});

test("consensus: the same answer in both orders is kept, with the lower confidence", async () => {
  let n = 0;
  const base: Classifier = { name: "f", version: "1", async classify() { n++; return { choice: "a", probabilities: { a: n === 1 ? 0.9 : 0.7, b: n === 1 ? 0.1 : 0.3 }, confidence: n === 1 ? 0.9 : 0.7 }; } };
  const r = await consensusClassifier(base).classify(input);
  assert.equal(r.choice, "a");
  assert.equal(r.confidence, 0.7);
  assert.ok(Math.abs(r.probabilities.a! - 0.8) < 1e-9);
  assert.deepEqual((r.extras as any).consensus, { first: "a", second: "a", agree: true });
});

test("consensus: an answer that follows the position of the list is dropped", async () => {
  const followsFirst = fixed((first) => first); // always picks whatever is listed first
  const r = await consensusClassifier(followsFirst).classify(input);
  assert.equal(r.choice, null);
  assert.equal(r.confidence, 0);
  assert.deepEqual((r.extras as any).consensus, { first: "a", second: "b", agree: false });
});

test("consensus: keeps name, version and the external flag visible", () => {
  const c = consensusClassifier({ name: "jev", version: "v9", external: true, classify: async () => { throw new Error("no"); } });
  assert.deepEqual([c.name, c.version, c.external], ["consensus(jev)", "v9", true]);
});

test("consensus: the same destination with a different skill is not agreement (work in one order, a plain message in the other)", async () => {
  const withSkill = (skillOf: (first: string) => string | null): Classifier => ({
    name: "fake", version: "1",
    async classify(i) { return { choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9, skill: skillOf(i.targets[0]!.id) }; },
  });
  const differs = await consensusClassifier(withSkill((first) => (first === "a" ? "k8s.inspect" : null))).classify(input);
  assert.equal(differs.choice, null, "one order wants work, the other a message: nothing is routed");
  assert.equal(differs.confidence, 0);
  assert.deepEqual((differs.extras as any).consensus, { first: "a", second: "a", agree: false, skills: { first: "k8s.inspect", second: null } });
  const other = await consensusClassifier(withSkill((first) => (first === "a" ? "k8s.inspect" : "web.search"))).classify(input);
  assert.equal(other.choice, null, "two different skills do not agree either");
  const same = await consensusClassifier(withSkill(() => "k8s.inspect")).classify(input);
  assert.equal(same.choice, "a");
  assert.equal(same.skill, "k8s.inspect", "the same skill in both is kept");
  const none = await consensusClassifier(withSkill(() => null)).classify(input);
  assert.equal(none.choice, "a");
  assert.ok(none.skill == null);
});

test("consensus: if either answer says a person is needed, the router sees the higher figure", async () => {
  let n = 0;
  const base: Classifier = { name: "f", version: "1", async classify() { n++; return { choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9, extras: { needsHuman: n === 1 ? 0.1 : 0.9, provider: "x" } }; } };
  const r = await consensusClassifier(base).classify(input);
  assert.equal(r.choice, "a", "they agree on where");
  assert.equal((r.extras as any).needsHuman, 0.9, "but the second answer wanted a person");
  assert.equal((r.extras as any).provider, "x", "the rest of the extras are kept");
  const none = await consensusClassifier(fixed(() => "a")).classify(input);
  assert.equal((none.extras as any).needsHuman, undefined, "no figure when neither gave one");
});
