import { HttpCore } from "./http-core.ts";
import { EXECUTORS, type Executor } from "./executors.ts";
import type { CoreClient } from "./types.ts";

/**
 * A one-shot worker for one piece of work (what a Kubernetes Job runs):
 *   PIO_CORE_URL PIO_TOKEN PIO_ACTOR PIO_CONTEXT PIO_WORK_ID PIO_SKILL  node src/hosts/worker.ts
 * It claims exactly that work, runs the executor for its skill and reports the result. Restart-safe by Core's own
 * rules: claiming again while its claim is live returns the same claim (same attempt), a completion is accepted once,
 * and a worker that finds the work already done, or taken by another, just exits.
 */
export type Outcome = "completed" | "failed" | "already-done" | "taken";

export async function runWork(core: CoreClient, o: { actor: string; context: string; workId: string; skill: string; executors?: Record<string, Executor>; log?: (m: string) => void }): Promise<Outcome> {
  const log = o.log ?? (() => {});
  const run = (op: string, args: Record<string, unknown>) => core.call(o.actor, op, args) as Promise<any>;
  // Skills are self-declared routing hints and grant nothing; claiming still needs membership with write.
  await run("actor", { skills: o.skill });
  let claim: { work: { attempt: number; input: unknown } };
  try {
    claim = await run("work-claim", { context: o.context, id: o.workId });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/already done/.test(m)) { log("already done"); return "already-done"; }
    if (/already (claimed|failed)/.test(m)) { log(`not mine: ${m}`); return "taken"; }
    throw e;
  }
  const { attempt, input } = claim.work;
  log(`claimed attempt ${attempt}`);
  const table = o.executors ?? EXECUTORS;
  const exec = Object.hasOwn(table, o.skill) ? table[o.skill] : undefined; // "constructor" is not an executor
  try {
    if (!exec) throw new Error(`no executor for skill ${o.skill}`);
    const result = await exec(input, { context: o.context, workId: o.workId, attempt, idempotencyKey: `work:${o.workId}:${attempt}` });
    try {
      await run("work-complete", { context: o.context, id: o.workId, attempt, result: JSON.stringify(result ?? null) });
    } catch (e) {
      if (/stale-claim|already done/.test(e instanceof Error ? e.message : "")) { log("completion refused: no longer mine"); return "taken"; }
      throw e;
    }
    log("completed");
    return "completed";
  } catch (e) {
    if (e instanceof Error && /^(core-unreachable|no-token)/.test(e.message)) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    await run("work-fail", { context: o.context, id: o.workId, attempt, reason });
    log(`failed: ${reason}`);
    return "failed";
  }
}

if (import.meta.main) {
  const need = (k: string) => process.env[k] ?? (console.error(`missing ${k}`), process.exit(2));
  const actor = need("PIO_ACTOR");
  const core = new HttpCore(need("PIO_CORE_URL"), { [actor]: need("PIO_TOKEN") });
  try {
    const outcome = await runWork(core, { actor, context: need("PIO_CONTEXT"), workId: need("PIO_WORK_ID"), skill: need("PIO_SKILL"), log: (m) => console.log(`[worker ${process.env.HOSTNAME ?? ""}] ${m}`) });
    console.log(`outcome: ${outcome}`);
    process.exit(0); // anything Core has settled (done, failed, taken) is finished for the Job
  } catch (e) {
    console.error(`worker error: ${e instanceof Error ? e.message : String(e)}`); // Core unreachable etc.: let the Job retry
    process.exit(1);
  }
}
