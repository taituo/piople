import type { Classification, ClassifyInput, Classifier } from "./router.ts";

/**
 * Jev (TypeSafe's decision classifier) behind the Classifier interface. Request and response shapes follow the
 * open-source jev-classifier client (src/jev.ts): POST { model, state, questions } with a Bearer key, answers
 * keyed by question name. Plain fetch, no SDK. Calls with the OpenRouter "decisions" endpoint by default;
 * pass `endpoint` for another gateway that speaks the same shape.
 *
 * Three questions are asked in one call: which destination (`choice`, with an explicit "none fits" option so
 * the model is never forced to pick), and whether a human is needed (`noul`). Urgency (`score`) is not asked
 * yet: its request shape is not verified here.
 */
export const NONE = "__none__";
export const OPENROUTER_DECISIONS = "https://openrouter.ai/api/alpha/decisions";

export type JevOptions = {
  apiKey: string;
  /**
   * An exact model id, e.g. a pinned version. There is deliberately no default: a moving alias such as
   * "latest" makes routing results irreproducible and recorded decisions uninterpretable.
   */
  model: string;
  endpoint?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

const INSTRUCTIONS =
  "You route one message inside a collaboration system. Given the message, which of the listed destinations should receive it? " +
  "Choose exactly one. Only the listed destinations exist: never infer others. " +
  `If none of them clearly fits, choose ${NONE}.`;
const HUMAN =
  "A person must make a decision or clarify the request before anything can be done about this message. " +
  "False when the message is a plain statement, question or task that others can handle on their own.";

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`Invalid Jev response: ${what}`);
  return v as Record<string, unknown>;
}
function prob(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`Invalid Jev response: ${what} is not a probability`);
  return v;
}

/** Strict: a malformed answer is an error, never a guess. Exported for tests. */
export function parseJev(body: unknown, labels: string[]): { choice: string; probabilities: Record<string, number>; confidence: number; confidenceSource: string; needsHuman: number } {
  const root = obj(body, "body");
  const answers = obj(root.answers, "answers");
  const target = obj(answers.target, "answers.target");
  const human = obj(answers.needs_human, "answers.needs_human");
  if (target.type !== "choice" || typeof target.choice !== "string" || !labels.includes(target.choice)) throw new Error("Invalid Jev response: choice is missing or not one of the offered options");
  if (human.type !== "noul") throw new Error("Invalid Jev response: needs_human is not a noul answer");
  const dist = obj(target.probabilities, "answers.target.probabilities");
  if (Object.keys(dist).length !== labels.length || labels.some((l) => !Object.hasOwn(dist, l))) throw new Error("Invalid Jev response: incomplete probability distribution");
  const probabilities = Object.fromEntries(labels.map((l) => [l, prob(dist[l], `probability of ${l}`)]));
  // Some gateways omit the native confidence; then the chosen option's own probability stands in, and we say so.
  const meta = root.providerMetadata as { typesafe?: { confidence?: { target?: number } } } | undefined;
  let confidence: number, confidenceSource: string;
  if (target.confidence !== undefined) [confidence, confidenceSource] = [prob(target.confidence, "confidence"), "answer"];
  else if (meta?.typesafe?.confidence?.target !== undefined) [confidence, confidenceSource] = [prob(meta.typesafe.confidence.target, "confidence"), "providerMetadata"];
  else [confidence, confidenceSource] = [probabilities[target.choice]!, "choice-probability"];
  return { choice: target.choice, probabilities, confidence, confidenceSource, needsHuman: prob(human.noul, "needs_human") };
}

export function jevClassifier(o: JevOptions): Classifier {
  if (!o.apiKey) throw new Error("jevClassifier needs an apiKey");
  if (!o.model) throw new Error("jevClassifier needs an exact model id (no default: pin it)");
  const request = o.fetch ?? fetch;
  const endpoint = o.endpoint ?? OPENROUTER_DECISIONS;
  return {
    name: "jev",
    version: o.model,
    external: true,
    async classify(input: ClassifyInput): Promise<Classification> {
      if (input.targets.some((t) => t.id === NONE)) throw new Error(`a destination may not be called ${NONE}`);
      const labels = [...input.targets.map((t) => t.id), NONE];
      const criteria = { ...Object.fromEntries(input.targets.map((t) => [t.id, `${t.kind}: ${t.title}`])), [NONE]: "No listed destination clearly fits the message." };
      let response: Response;
      try {
        response = await request(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
          headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
          // Only the text leaves: not the sender, not the hop count.
          body: JSON.stringify({ model: o.model, state: { message: input.text }, questions: { target: { type: "choice", instructions: INSTRUCTIONS, criteria }, needs_human: { type: "noul", instructions: HUMAN } } }),
        });
      } catch (e) {
        throw new Error(`Jev unreachable (${e instanceof Error ? e.name : "error"})`); // never echo the request
      }
      if (!response.ok) {
        await response.body?.cancel(); // provider error bodies can echo the request
        const hint = response.status === 401 || response.status === 403 ? "check the key" : response.status === 402 ? "check the balance" : response.status === 404 ? "check the model id" : response.status === 429 || response.status >= 500 ? "busy or unavailable, will be retried" : "request rejected";
        throw new Error(`Jev returned HTTP ${response.status} (${hint})`);
      }
      const p = parseJev(await response.json().catch(() => { throw new Error("Invalid Jev response: not JSON"); }), labels);
      return {
        choice: p.choice === NONE ? null : p.choice,
        probabilities: p.probabilities,
        confidence: p.confidence,
        extras: { needsHuman: p.needsHuman, confidenceSource: p.confidenceSource, provider: "jev", model: o.model },
      };
    },
  };
}
