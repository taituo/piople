import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Store } from "../core/index.ts";
import { runTool } from "./tools.ts";

/**
 * The piople surface as a Pi extension. Pi owns the agent loop: it parses tool calls,
 * validates arguments, runs tools as durable tasks and resumes after a crash. These tools
 * are the only way an agent touches the case, and every one goes through the Store, so
 * membership and capability checks happen at the boundary, not in the prompt.
 *
 * Identity is never a tool argument: the conversation id resolves to (context, actor)
 * through the `pi_convs` binding, so an agent cannot act as someone else.
 * All tools are replay-safe: Store writes are keyed by the call id, so a rerun after a
 * crash returns the original event instead of duplicating it.
 */
function binding(s: Store, conversationId: unknown): { contextId: string; actorId: string } {
  const row = s.db.prepare(`SELECT context_id, actor_id FROM pi_convs WHERE conv_id=?`).get(Number(conversationId)) as { context_id: string; actor_id: string } | undefined;
  if (!row) throw new Error(`conversation ${String(conversationId)} is not bound to a case`);
  return { contextId: row.context_id, actorId: row.actor_id };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function pioupleExtension(s: Store) {
  const k8s = defineTool({
    name: "k8s",
    description: "Read-only kubectl in the allowed namespace (get|describe|logs).",
    parameters: Type.Object({
      verb: Type.String({ description: "get | describe | logs" }),
      res: Type.String({ description: "configmap | deployment | pod | service | events" }),
      name: Type.Optional(Type.String()),
      ns: Type.String({ description: "demo-apps" }),
      tail: Type.Optional(Type.Number()),
    }),
    replay: "safe",
    execute: async (args) => {
      const r = await runTool({ tool: "k8s", ...args });
      return text(r.ok ? r.output : `ERROR: ${r.output}`);
    },
  });

  const repo = defineTool({
    name: "repo",
    description: "Read the project's own src/, test/ and scripts/ (ls|read).",
    parameters: Type.Object({
      op: Type.String({ description: "ls | read" }),
      path: Type.String({ description: "e.g. src/agents" }),
      lines: Type.Optional(Type.Number()),
    }),
    replay: "safe",
    execute: async (args) => {
      const r = await runTool({ tool: "repo", ...args });
      return text(r.ok ? r.output : `ERROR: ${r.output}`);
    },
  });

  const observe = defineTool({
    name: "observe",
    description: "Record a finding in the case as a hypothesis, with evidence (what you fetched and from where). Use it instead of plain chat when you have evidence.",
    parameters: Type.Object({
      text: Type.String(),
      evidence: Type.Optional(Type.Array(Type.String())),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const { contextId, actorId } = binding(s, api.conversationId);
      const ev = s.recordObservation({
        id: `obs:${api.callId}`, contextId, kind: "finding", authorId: actorId,
        text: args.text, status: "hypothesis", evidence: [...(args.evidence ?? []), `pi:call:${api.callId}`], createdAt: Date.now(),
      });
      return text(`Recorded finding (event ${ev.seq}).`);
    },
  });

  const propose = defineTool({
    name: "propose",
    description: "Propose a change instead of describing a command. Nothing runs: a human with decide capability must approve first.",
    parameters: Type.Object({
      verb: Type.String({ description: "patch" }),
      res: Type.String({ description: "configmap" }),
      ns: Type.String({ description: "demo-apps" }),
      name: Type.Optional(Type.String()),
      patch: Type.Optional(Type.Record(Type.String(), Type.Any())),
      why: Type.String(),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const { contextId, actorId } = binding(s, api.conversationId);
      const proposalId = `prop:${api.callId}`;
      const decisionId = `dec:${api.callId}`;
      const { why, ...action } = args;
      s.proposeAction(
        { id: proposalId, contextId, kind: "proposal", authorId: actorId, text: why.slice(0, 500), status: null, evidence: [`pi:call:${api.callId}`], createdAt: Date.now() },
        action,
        decisionId,
      );
      s.requestDecision({
        id: decisionId, contextId, question: `Approve action: ${args.verb} ${args.res} ${args.name ?? ""} in ${args.ns}?`,
        options: ["yes", "no"], requestedBy: actorId, decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null,
      });
      return text(`Proposed action, waiting for human decision ${decisionId}.`);
    },
  });

  return defineExtension({ name: "piople", tools: [k8s, repo, observe, propose] });
}
