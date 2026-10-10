import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { PiopleActivities } from "./activities.ts";

/**
 * An example chain: ask one agent for something, put the result to a human, and only if they say yes ask a second
 * agent to act on it. Deterministic: the only inputs are the workflow's own arguments and Activity results; ids come
 * from the workflow id and the step name, so a replay asks for exactly the same things.
 */
export type ChainInput = {
  context: string; first: { to: string; input: unknown }; second: { to: string }; question: string;
  /** How soon a dead worker is noticed while an Activity is waiting (it heartbeats). Default 20. */
  heartbeatSeconds?: number;
};
export type ChainResult =
  | { status: "done"; first: unknown; second: unknown }
  | { status: "declined"; first: unknown; answer: string }
  | { status: "failed"; step: "first" | "second"; reason: string };

export async function piopleChain(i: ChainInput): Promise<ChainResult> {
  const act = proxyActivities<PiopleActivities>({
    startToCloseTimeout: "1 hour", heartbeatTimeout: `${i.heartbeatSeconds ?? 20} seconds`,
    retry: { initialInterval: "1 second", maximumInterval: "10 seconds", backoffCoefficient: 2 },
  });
  const id = workflowInfo().workflowId;
  const a = await act.requestWork({ context: i.context, to: i.first.to, input: i.first.input, key: `${id}:first` });
  const r1 = await act.awaitWork({ context: i.context, workId: a.workId });
  if (r1.status !== "done") return { status: "failed", step: "first", reason: r1.reason };
  const d = await act.requestDecision({ context: i.context, question: i.question, key: `${id}:decision` });
  const { answer } = await act.awaitDecision({ context: i.context, decisionId: d.decisionId });
  if (answer !== "yes") return { status: "declined", first: r1.result, answer };
  const b = await act.requestWork({ context: i.context, to: i.second.to, input: { from: r1.result }, key: `${id}:second` });
  const r2 = await act.awaitWork({ context: i.context, workId: b.workId });
  if (r2.status !== "done") return { status: "failed", step: "second", reason: r2.reason };
  return { status: "done", first: r1.result, second: r2.result };
}
