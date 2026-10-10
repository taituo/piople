import type { Harness, PollApi, Step } from "../hosts/types.ts";
import type { Submission, Target } from "../core/index.ts";

/**
 * Routing as a participant. The router is an ordinary harness; Core knows it only as an actor the operator
 * designated, and judges every delivery with the SENDER's authority. A classifier suggests, Core decides:
 * whatever it says, a message can only land where its sender could have written it.
 */
export type ClassifyInput = {
  /** Identifies the submission (never sent anywhere): lets callers attribute timings and errors to a message. */
  submission?: string;
  text: string;
  sender: string;
  hops: number;
  /** Only what the sender may address. Realm descriptors when `stage` is "realm". */
  targets: ReadonlyArray<{ id: string; kind: string; title: string; realm: string | null; parent: string | null }>;
  stage: "targets" | "realm";
  /** The last few messages of the conversation before this one, oldest first, without who wrote them: only whether the sender did (`own`). For replies that mean nothing alone. */
  recent?: ReadonlyArray<{ own: boolean; text: string }>;
};
export type Classification = {
  /** One of the offered ids, or null when nothing fits. */
  choice: string | null;
  /** Probability per offered id. */
  probabilities: Record<string, number>;
  /** 0..1, how sure the classifier is of `choice`. */
  confidence: number;
  /** Optional: ask for work by this skill in the chosen context instead of posting a message. */
  skill?: string | null;
  /** Anything else worth keeping with the decision (urgency, purpose, ...). Recorded, never trusted. */
  extras?: Record<string, unknown>;
};
/**
 * A classifier failure the router can act on. `transient`: retry later (outage, rate limit). `config`: the setup
 * is wrong (bad key, wrong model): keep every message pending and fail loudly, never turn messages into
 * unresolved ones. `message`: this particular message is rejected or answered unusably; after a few attempts it is
 * left unresolved so it cannot hold up the queue.
 */
export class ClassifierError extends Error {
  kind: "transient" | "config" | "message";
  constructor(kind: ClassifierError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface Classifier {
  readonly name: string;
  /**
   * True when the classifier is a service outside the operator's control: it then only ever sees targets in
   * the realms the operator allowed (RouterOptions.external). Default false.
   */
  readonly external?: boolean;
  /** Pin this for tests and comparisons; it is recorded with every decision. */
  readonly version: string;
  classify(input: ClassifyInput): Promise<Classification>;
}

export type RouterOptions = {
  classifier: Classifier;
  /** shadow: record what would be done, deliver nothing. enforce: deliver. Start in shadow. */
  mode: "shadow" | "enforce";
  /** Below this the route is left unresolved. Required: derive it from measured results, do not invent it. */
  minConfidence: number;
  /** Recorded with every decision so results can be compared across rule changes. */
  ruleVersion: string;
  /** A classifier question takes only so many options; more targets are routed realm first, then within it. Default 255. */
  maxOptions?: number;
  /** How many waiting messages to take per poll. Default 20. */
  batch?: number;
  /**
   * Privacy for external classifiers. Destination names are realm-private, so an external classifier is offered
   * only targets inside these realms. The default is none: nothing leaves, every message is left unresolved.
   */
  external?: { allowRealms: string[] };
  /** Leave a message unresolved when the classifier says a human is needed with at least this probability. Unset = never gate. */
  needsHumanAbove?: number;
  /** Attempts before a message the classifier keeps rejecting is left unresolved. Default 3. */
  maxAttempts?: number;
  /**
   * The messages that came before this one in the conversation (oldest first), for replies like "yes, do that".
   * Give only what the sender may read: it is shown to the classifier, and to an external one it leaves the system.
   */
  recent?: (m: { sender: string; key: string }) => ReadonlyArray<{ own: boolean; text: string }>;
  /**
   * Live source for the same thing: take this many messages that came before each one, from the contexts its sender
   * may read (`route-recent`). An external classifier is shown only those inside `external.allowRealms`. Unset = none.
   * Ignored when `recent` is given.
   */
  recentLimit?: number;
};

const clamp01 = (n: number) => n >= 0 && n <= 1;
const REFUSALS = /^(forbidden|not-a-member|not-in-realm|bad-route|work-needs-target)\b/;
const top = (p: Record<string, number>, n = 10) => Object.fromEntries(Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, n));

type Stage = { stage: string; offered: number; choice: string | null; confidence: number };

export class RouterHarness implements Harness {
  private readonly o: Required<Omit<RouterOptions, "external" | "needsHumanAbove" | "recent" | "recentLimit">> & Pick<RouterOptions, "external" | "needsHumanAbove" | "recent" | "recentLimit">;
  private readonly attempts = new Map<string, number>();
  constructor(o: RouterOptions) {
    if (!clamp01(o.minConfidence)) throw new Error("minConfidence must be between 0 and 1");
    if (o.needsHumanAbove !== undefined && !clamp01(o.needsHumanAbove)) throw new Error("needsHumanAbove must be between 0 and 1");
    this.o = { maxOptions: 255, batch: 20, maxAttempts: 3, ...o };
  }

  /** What the classifier may be shown. An external one sees only allowed realms; by default that is nothing. */
  private permitted(targets: Target[]): Target[] {
    if (!this.o.classifier.external) return targets;
    const allow = new Set(this.o.external?.allowRealms ?? []);
    return targets.filter((t) => allow.has(t.kind === "realm" ? t.id : (t.realm ?? "")));
  }

  async step(_s: Step): Promise<void> {
    // A router has no inbox of its own; its work arrives through poll().
  }

  async poll(api: PollApi): Promise<number> {
    const pending = await api.run<Submission[]>("route-pending", { limit: this.o.batch });
    let handled = 0;
    const failures: unknown[] = [];
    for (const sub of pending) {
      try {
        await this.route(api, sub);
        handled++;
      } catch (e) {
        failures.push(e); // a classifier outage must not turn messages into unresolved ones: leave them pending
      }
    }
    if (failures.length) throw new Error(`router: ${failures.length} of ${pending.length} messages could not be routed: ${failures[0] instanceof Error ? failures[0].message : String(failures[0])}`);
    return handled;
  }

  private async route(api: PollApi, sub: Submission): Promise<void> {
    const addressable = await api.run<Target[]>("route-targets", { sender: sub.sender });
    const ref = { ingress: sub.ingress, submitted: sub.key };
    const unresolved = (reason: string, data: Record<string, unknown> = {}) => api.run("route-unresolved", { ...ref, reason, data: JSON.stringify(data) });
    if (!addressable.length) return void (await unresolved("no-targets"));
    const targets = this.permitted(addressable);
    if (!targets.length) return void (await unresolved("no-permitted-targets")); // nothing was sent anywhere

    // A classification recorded before a crash is reused, not paid for twice.
    let c: Classification | null = this.reusable(sub);
    if (!c) {
      try {
        c = await this.classify(api, sub, targets, ref);
        this.attempts.delete(`${sub.ingress}#${sub.key}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/^too-many-options\b/.test(message)) return void (await unresolved("too-many-options", { message })); // permanent for this sender
        if (e instanceof ClassifierError && e.kind === "message") {
          const id = `${sub.ingress}#${sub.key}`;
          const n = (this.attempts.get(id) ?? 0) + 1;
          this.attempts.set(id, n);
          if (n >= this.o.maxAttempts) {
            this.attempts.delete(id);
            return void (await unresolved("classifier-error", { message, attempts: n })); // it would hold up the queue forever
          }
        }
        throw e; // transient or config: leave it pending
      }
    }
    const offered = new Set(targets.map((t) => t.id));
    if (c.choice === null) return void (await unresolved("no-choice", { confidence: c.confidence }));
    if (!offered.has(c.choice)) return void (await unresolved("invalid-choice", { choice: c.choice }));
    if (c.confidence < this.o.minConfidence) return void (await unresolved("low-confidence", { confidence: c.confidence, minConfidence: this.o.minConfidence }));
    const human = Number(c.extras?.needsHuman ?? 0);
    if (this.o.needsHumanAbove !== undefined && human >= this.o.needsHumanAbove) return void (await unresolved("needs-human", { needsHuman: human, threshold: this.o.needsHumanAbove }));
    try {
      await api.run("route-resolve", { ...ref, context: c.choice, deliver: this.o.mode === "enforce", ...(c.skill ? { as: "work", skill: c.skill } : {}) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!REFUSALS.test(message)) throw e; // transport trouble: try again later
      await unresolved("invalid-route", { message });
    }
  }

  private reusable(sub: Submission): Classification | null {
    const r = sub.classification as { classifier?: { name?: string; version?: string }; ruleVersion?: string; choice?: string | null; confidence?: number; skill?: string | null; extras?: Record<string, unknown> | null; error?: string } | null;
    if (!r || r.error || r.classifier?.name !== this.o.classifier.name || r.classifier?.version !== this.o.classifier.version || r.ruleVersion !== this.o.ruleVersion) return null;
    return { choice: r.choice ?? null, probabilities: {}, confidence: r.confidence ?? 0, skill: r.skill ?? null, extras: r.extras ?? undefined };
  }

  /** Earlier messages for a reply: from the callback, or live from what the sender may read (held back for an external classifier outside its allowed realms). */
  private async recentFor(api: PollApi, sub: Submission): Promise<ReadonlyArray<{ own: boolean; text: string }> | undefined> {
    if (this.o.recent) return this.o.recent({ sender: sub.sender, key: sub.key });
    if (!this.o.recentLimit) return undefined;
    const rows = await api.run<Array<{ realm: string | null; own: boolean; text: string }>>("route-recent", { sender: sub.sender, before: sub.seq, limit: this.o.recentLimit });
    const allow = new Set(this.o.external?.allowRealms ?? []);
    return rows.filter((r) => !this.o.classifier.external || (r.realm !== null && allow.has(r.realm))).map((r) => ({ own: r.own, text: r.text }));
  }

  private async classify(api: PollApi, sub: Submission, targets: Target[], ref: { ingress: string; submitted: string }): Promise<Classification> {
    const stages: Stage[] = [];
    const recent = await this.recentFor(api, sub);
    const ask = async (stage: ClassifyInput["stage"], offered: ClassifyInput["targets"]) => {
      const c = await this.o.classifier.classify({ submission: `${sub.ingress}#${sub.key}`, text: sub.text, sender: sub.sender, hops: sub.hops, targets: offered, stage, ...(recent ? { recent } : {}) });
      stages.push({ stage, offered: offered.length, choice: c.choice, confidence: c.confidence });
      return c;
    };
    let result: Classification;
    if (targets.length <= this.o.maxOptions) {
      result = await ask("targets", targets);
    } else {
      // Too many to offer at once: choose the realm first, then within it.
      const groups = new Map<string, Target[]>();
      for (const t of targets) {
        const key = t.kind === "realm" ? t.id : (t.realm ?? `~${t.id}`);
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }
      if (groups.size > this.o.maxOptions) throw new Error(`too-many-options: ${groups.size} realms`);
      const realmTitle = (key: string) => groups.get(key)!.find((t) => t.id === key)?.title ?? key;
      const first = await ask("realm", [...groups.keys()].map((key) => ({ id: key, kind: "realm", title: realmTitle(key), realm: null, parent: null })));
      const inside = first.choice === null ? [] : (groups.get(first.choice) ?? []);
      if (inside.length > this.o.maxOptions) throw new Error(`too-many-options: ${inside.length} targets in ${first.choice}`);
      if (!inside.length) result = { ...first, choice: null };
      else {
        const second = await ask("targets", inside);
        result = { ...second, confidence: Math.min(first.confidence, second.confidence) };
      }
    }
    await api.run("route-classified", {
      ...ref, tag: `${this.o.classifier.version}.${this.o.ruleVersion}`,
      data: JSON.stringify({
        classifier: { name: this.o.classifier.name, version: this.o.classifier.version }, ruleVersion: this.o.ruleVersion, mode: this.o.mode,
        choice: result.choice, confidence: result.confidence, skill: result.skill ?? null, probabilities: top(result.probabilities), stages, extras: result.extras ?? null,
        external: this.o.classifier.external ?? false, offered: targets.length,
      }),
    });
    return result;
  }
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];

/**
 * A deterministic baseline and test double: scores each offered target by how many words of the message
 * appear in its id and title. Not smart, never random, and offline.
 */
export function keywordClassifier(): Classifier {
  return {
    name: "keyword",
    version: "1",
    async classify({ text, targets }) {
      const message = new Set(words(text));
      const score = targets.map((t) => ({ id: t.id, n: words(`${t.id} ${t.title}`).filter((w) => message.has(w)).length }));
      const total = score.reduce((a, x) => a + x.n, 0);
      const probabilities = Object.fromEntries(score.map((x) => [x.id, total ? x.n / total : 0]));
      const best = Math.max(0, ...score.map((x) => x.n));
      const winners = score.filter((x) => x.n === best);
      if (best === 0 || winners.length !== 1) return { choice: null, probabilities, confidence: best === 0 ? 0 : probabilities[winners[0]!.id]! };
      return { choice: winners[0]!.id, probabilities, confidence: probabilities[winners[0]!.id]! };
    },
  };
}
