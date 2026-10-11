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
      // Agreeing means the same destination AND the same skill: a classifier can turn a message into work for a skill, and "work for
      // k8s.inspect" in one order against "a plain message" in the other is not agreement, whichever came first.
      const skillA = a.skill ?? null, skillB = b.skill ?? null;
      const agree = a.choice === b.choice && skillA === skillB;
      // "A person is needed" is a reason to hold back: if either answer says so, the higher figure is the one the router sees
      // (it used to see only the first answer's).
      const human = [a.extras?.needsHuman, b.extras?.needsHuman].filter((x): x is number => typeof x === "number");
      const extras = { ...a.extras, ...(human.length ? { needsHuman: Math.max(...human) } : {}), consensus: { first: a.choice, second: b.choice, agree, ...(skillA !== skillB ? { skills: { first: skillA, second: skillB } } : {}) } };
      if (!agree) return { choice: null, probabilities, confidence: 0, extras };
      return { choice: a.choice, probabilities, confidence: Math.min(a.confidence, b.confidence), ...(a.skill ? { skill: a.skill } : {}), extras };
    },
  };
}
