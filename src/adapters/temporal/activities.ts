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

/**
 * What Core refuses for good, as opposed to what may pass. Temporal retries an Activity for ever unless told
 * otherwise, so a request that Core will refuse every time (too large, malformed, an unknown case, an id already in
 * use with other content) would loop silently with the workflow stuck. Those become non-retryable failures that the
 * workflow can see. Left retryable on purpose: no answer, 5xx, 429 (limits ease), and 401/403 (an operator can fix a
 * token or a membership while the Activity keeps trying).
 */
const PERMANENT = /^(missing|bad-[a-z]+|too-large|unknown-[a-z]+|key-conflict|id-in-use|decision-not-open|work-needs-target)\b/;
function classify(e: unknown, op: string): unknown {
  const status = (e as { status?: unknown }).status;
  const message = e instanceof Error ? e.message : String(e);
  const permanent = typeof status === "number" ? [400, 404, 409, 413].includes(status) : PERMANENT.test(message);
  return permanent ? ApplicationFailure.nonRetryable(`Core refused ${op} for good: ${message.slice(0, 300)}`, "CoreRefused") : e;
}

export function createActivities(core: CoreClient, actor: string, o: { pollMs?: number } = {}): PiopleActivities {
  const call = async <T = any>(op: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return (await core.call(actor, op, args)) as T;
    } catch (e) {
      throw classify(e, op);
    }
  };
  const pause = (ms: number) => Context.current().sleep(ms); // rejects when the Activity is cancelled
  // Ids start with "<orchestrator>@": Core keeps ids of that form for that actor, so nobody who can write in the case and
  // guesses a workflow's key can create the work or decision first and make the workflow fail with id-in-use.
  const ownId = (id: string) => `${actor}@${id}`;
  return {
    async requestWork({ context, to, input, key }) {
      const workId = ownId(workIdFor(key));
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
      const decisionId = ownId(decisionIdFor(key));
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
        // A page is cut at 200 events and also at a number of bytes, so a short page does not mean "caught up": rest only on an empty one.
        if (!events.length) await pause(pollMs ?? o.pollMs ?? 1000);
      }
    },
  };
}
