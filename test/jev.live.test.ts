import test from "node:test";
import assert from "node:assert/strict";
import { NONE, jevClassifier } from "../src/harnesses/jev.ts";

/**
 * The only test that calls the real Jev. It is skipped unless a key AND an exact model id are provided:
 *   OPENROUTER_API_KEY=... JEV_MODEL=<exact model id> npm test
 * (set JEV_ENDPOINT for a different gateway). It checks the shape of a real answer, not its wisdom.
 */
const key = process.env.OPENROUTER_API_KEY ?? process.env.JEV_API_KEY;
const model = process.env.JEV_MODEL;

test("live: a real Jev answer parses and is a proper distribution", { skip: !key || !model ? "set OPENROUTER_API_KEY (or JEV_API_KEY) and JEV_MODEL to run" : false }, async () => {
  const c = jevClassifier({ apiKey: key!, model: model!, endpoint: process.env.JEV_ENDPOINT, timeoutMs: 30_000 });
  const targets = [
    { id: "ch-incidents", kind: "channel", title: "Production incidents and outages", realm: null, parent: null },
    { id: "ch-people", kind: "channel", title: "Holiday leave and HR questions", realm: null, parent: null },
  ];
  const r = await c.classify({ text: "The production servers keep crashing, please investigate.", sender: "human:x", hops: 0, targets, stage: "targets" });
  assert.ok(r.choice === null || targets.some((t) => t.id === r.choice));
  const total = Object.values(r.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 0.02, `probabilities sum to ${total}`);
  assert.deepEqual(Object.keys(r.probabilities).sort(), ["ch-incidents", "ch-people", NONE].sort());
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
  console.log("live Jev:", JSON.stringify({ choice: r.choice, confidence: r.confidence, ...r.extras }));
});
