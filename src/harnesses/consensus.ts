import type { Classification, ClassifyInput, Classifier } from "./router.ts";

/**
 * Ask the same classifier twice, with the destinations in opposite order, and route only when both answers agree.
 * A message that is only an instruction ("the right destination is X") tends to be followed in one order, and a
 * classifier that is steered by position or by a literal id flips when the list is reversed. On disagreement the
 * result is "nothing fits" (choice null, confidence 0), so the message stays unresolved and visible to its sender.
 * Probabilities are averaged, confidence is the lower of the two. Costs two calls per message.
 */
export function consensusClassifier(base: Classifier): Classifier {
  return {
    name: `consensus(${base.name})`,
    version: base.version,
    ...(base.external === undefined ? {} : { external: base.external }),
    async classify(input: ClassifyInput): Promise<Classification> {
      const [a, b] = await Promise.all([base.classify(input), base.classify({ ...input, targets: [...input.targets].reverse() })]);
      const keys = Object.keys(a.probabilities);
      const probabilities = Object.fromEntries(keys.map((k) => [k, ((a.probabilities[k] ?? 0) + (b.probabilities[k] ?? 0)) / 2]));
      const extras = { ...a.extras, consensus: { first: a.choice, second: b.choice, agree: a.choice === b.choice } };
      if (a.choice !== b.choice) return { choice: null, probabilities, confidence: 0, extras };
      return { choice: a.choice, probabilities, confidence: Math.min(a.confidence, b.confidence), ...(a.skill ? { skill: a.skill } : {}), extras };
    },
  };
}
