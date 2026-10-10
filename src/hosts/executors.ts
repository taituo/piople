/**
 * What a one-shot worker can do, by skill. An executor gets the work's input and an idempotency key
 * (`work:<id>:<attempt>`) it should pass on to anything with side effects outside Piople: Core guarantees one holder
 * and one accepted completion per attempt, it cannot undo what happened elsewhere.
 */
export type ExecutorContext = { context: string; workId: string; attempt: number; idempotencyKey: string };
export type Executor = (input: unknown, ctx: ExecutorContext) => Promise<unknown>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const EXECUTORS: Record<string, Executor> = {
  /** The lab task: sleep (so a test can kill the pod mid-work), then answer with who did it. */
  "lab.echo": async (input, ctx) => {
    const i = (input && typeof input === "object" ? input : {}) as { sleepMs?: unknown; text?: unknown; fail?: unknown };
    if (i.fail) throw new Error(String(i.fail));
    await sleep(Math.min(Math.max(Number(i.sleepMs) || 0, 0), 120_000));
    return { echo: i.text ?? input, attempt: ctx.attempt, key: ctx.idempotencyKey, by: process.env.HOSTNAME ?? "local" };
  },
};
