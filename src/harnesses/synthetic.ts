import type { Harness, Step } from "../hosts/types.ts";

/**
 * Participants without a model. They speak the same protocol as everyone else, so a world of
 * hundreds of them costs nothing and tests exactly the rules real agents live under.
 */
export type Behavior = (s: Step) => Promise<void> | void;

export type SyntheticOptions = {
  behaviors: Behavior[];
  /** Pause before each step, to shake out ordering assumptions. */
  delayMs?: number;
  /** Throw on the first n steps (a flaky participant). The host retries them. */
  failFirst?: number;
};

export class SyntheticHarness implements Harness {
  steps = 0;
  private failed = 0;
  private readonly o: SyntheticOptions;
  constructor(o: SyntheticOptions) {
    this.o = o;
  }

  async step(s: Step): Promise<void> {
    this.steps++;
    if (this.o.delayMs) await new Promise((r) => setTimeout(r, this.o.delayMs));
    if (this.failed < (this.o.failFirst ?? 0)) {
      this.failed++;
      throw new Error(`synthetic fault ${this.failed}/${this.o.failFirst}`);
    }
    for (const b of this.o.behaviors) await b(s);
  }
}

const textOf = (e: { data: Record<string, unknown> }) => String(e.data.text ?? "");

export const behave = {
  /** Reply to others' messages that match. */
  replyTo(match: RegExp, reply: string | ((text: string) => string)): Behavior {
    return async (s) => {
      for (const e of s.events) {
        if (e.type !== "message.posted" || e.actorId === s.actor || !match.test(textOf(e))) continue;
        await s.run("post", { text: typeof reply === "function" ? reply(textOf(e)) : reply });
      }
    };
  },

  /** Answer every assistance request addressed to me. */
  answerAsks(answer: (question: string, from: string) => string): Behavior {
    return async (s) => {
      for (const a of s.pending.assistance) await s.run("answer", { request: a.key, answer: answer(a.question, a.from) });
    };
  },

  /** Ask someone something whenever a message matches. */
  askOn(match: RegExp, to: string, question: (text: string) => string): Behavior {
    return async (s) => {
      for (const e of s.events) {
        if (e.type !== "message.posted" || e.actorId === s.actor || !match.test(textOf(e))) continue;
        await s.run("ask", { to, question: question(textOf(e)) });
      }
    };
  },

  /**
   * Take and finish work. Resumes work I still hold (after a restart) before claiming new work.
   * A throwing handler fails the work for good; set retry to reopen it instead.
   */
  worker(handle: (input: unknown, w: { id: string; attempt: number }) => unknown | Promise<unknown>, o: { retry?: boolean } = {}): Behavior {
    return async (s) => {
      const finish = async (id: string, attempt: number, input: unknown) => {
        try {
          const result = await handle(input, { id, attempt });
          await s.run("work-complete", { id, attempt, result: JSON.stringify(result ?? null) });
        } catch (e) {
          await s.run("work-fail", { id, attempt, reason: e instanceof Error ? e.message : String(e), retry: !!o.retry });
        }
      };
      for (const m of s.pending.work.mine) await finish(m.id, m.attempt, m.input);
      while (s.pending.work.open.length) {
        const r = await s.run<{ work: { id: string; attempt: number; input: unknown } | null }>("work-claim", { next: true });
        if (!r.work) break;
        await finish(r.work.id, r.work.attempt, r.work.input);
        s.pending.work.open.shift();
      }
    };
  },

  /** Resolve open decisions that Core offers me (so only with decide). Return null to leave one open. */
  decider(choose: (question: string, options: string[]) => string | null): Behavior {
    return async (s) => {
      for (const d of s.pending.decisions) {
        const answer = choose(d.question, d.options);
        if (answer !== null) await s.run("decide", { decision: d.id, answer });
      }
    };
  },
};
