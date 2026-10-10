import { createHash } from "node:crypto";
import { ApplicationFailure, Context } from "@temporalio/activity";
import type { CoreClient } from "../../hosts/types.ts";

/**
 * Temporal as an orchestrator only (plan item 9). Workflows decide progression and stay deterministic; these
 * Activities are the only place that talks to Piople, as one ordinary actor (the orchestrator), and every request is
 * addressed to a *named* actor: work addressed to a skill would be fair game for a launcher, and two orchestrators
 * must never start the same work. Ids are derived from a key the workflow builds from its own workflow id and step
 * name, so an Activity retry, a replayed workflow or a restarted worker replays in Core instead of duplicating.
 * Executors stay Piople agents; nothing here runs the work.
 */
export type WorkOutcome = { status: "done"; result: unknown } | { status: "failed"; reason: string };

export type PiopleActivities = {
  /** Ask `to` (a named actor) to do something. Idempotent in `key`. */
  requestWork(a: { context: string; to: string; input: unknown; key: string }): Promise<{ workId: string }>;
  /** Wait (heartbeating) until the work is done or finally failed. */
  awaitWork(a: { context: string; workId: string; pollMs?: number }): Promise<WorkOutcome>;
  /** Put a question to the people in the case who may decide. Idempotent in `key`. */
  requestDecision(a: { context: string; question: string; options?: string[]; key: string }): Promise<{ decisionId: string }>;
  /** Wait (heartbeating) for a human to resolve it. */
  awaitDecision(a: { context: string; decisionId: string; pollMs?: number }): Promise<{ answer: string }>;
};

const derive = (prefix: string, key: string) => `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
export const workIdFor = (key: string) => derive("tw", key);
export const decisionIdFor = (key: string) => derive("td", key);

export function createActivities(core: CoreClient, actor: string, o: { pollMs?: number } = {}): PiopleActivities {
  const call = <T = any>(op: string, args: Record<string, unknown>) => core.call(actor, op, args) as Promise<T>;
  const pause = (ms: number) => Context.current().sleep(ms); // rejects when the Activity is cancelled
  return {
    async requestWork({ context, to, input, key }) {
      const workId = workIdFor(key);
      await call("work-request", { context, id: workId, to, input: JSON.stringify(input ?? null) });
      return { workId };
    },
    async awaitWork({ context, workId, pollMs }) {
      for (;;) {
        const [w] = await call<Array<{ status: string; result: unknown; attempt: number }>>("work-list", { context, id: workId });
        if (!w) throw ApplicationFailure.nonRetryable(`work ${workId} not found in ${context}`, "WorkNotFound");
        if (w.status === "done") return { status: "done", result: w.result };
        if (w.status === "failed") return { status: "failed", reason: `the work failed (attempt ${w.attempt})` };
        Context.current().heartbeat({ workId, status: w.status, attempt: w.attempt });
        await pause(pollMs ?? o.pollMs ?? 1000);
      }
    },
    async requestDecision({ context, question, options, key }) {
      const decisionId = decisionIdFor(key);
      await call("decision-request", { context, id: decisionId, question, ...(options ? { options: options.join(",") } : {}) });
      return { decisionId };
    },
    async awaitDecision({ context, decisionId, pollMs }) {
      let after = 0;
      for (;;) {
        const events = await call<Array<{ seq: number; type: string; data: { decisionId?: string; answer?: string } }>>("events", { context, after, limit: 200 });
        for (const e of events) {
          after = Math.max(after, e.seq);
          if (e.type === "decision.resolved" && e.data.decisionId === decisionId) return { answer: String(e.data.answer ?? "") };
        }
        Context.current().heartbeat({ decisionId, after });
        if (events.length < 200) await pause(pollMs ?? o.pollMs ?? 1000);
      }
    },
  };
}
