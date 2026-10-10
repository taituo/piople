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
