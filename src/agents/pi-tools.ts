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
 * through the `pi_convs` binding, so an agent cannot act as someone else. Which tools an
 * actor may call is data (`allow`), checked on every call, so rights are not a prompt hint.
 * All tools are replay-safe: Store writes are keyed by the call id, so a rerun after a
 * crash returns the original event instead of duplicating it.
 */
/** What the `world` tool needs from a simulated world; src/sim/world.ts implements it. */
export interface WorldView {
  ls(prefix?: string): string[];
  read(path: string, maxLines?: number): string | undefined;
  grep(pattern: string, prefix?: string): string[];
}
export type ToolDenied = { contextId: string; actorId: string; tool: string };
export type PiopleToolOptions = {
  /** Source of the sandboxed world for a case (simulations); absent: the world tool reports no world. */
  world?: (contextId: string) => WorldView | undefined;
  /** Whether `actorId` may call `tool` in `contextId`. Default: everyone may call every tool. */
  allow?: (contextId: string, actorId: string, tool: string) => boolean;
  onDenied?: (d: ToolDenied) => void;
};

function binding(s: Store, conversationId: unknown): { contextId: string; actorId: string } {
  const row = s.db.prepare(`SELECT context_id, actor_id FROM pi_convs WHERE conv_id=?`).get(Number(conversationId)) as { context_id: string; actor_id: string } | undefined;
  if (!row) throw new Error(`conversation ${String(conversationId)} is not bound to a case`);
  return { contextId: row.context_id, actorId: row.actor_id };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function pioupleExtension(s: Store, o: PiopleToolOptions = {}) {
  /** Resolve who is calling and refuse tools this actor was not granted. */
  const caller = (api: { conversationId: unknown }, tool: string) => {
    const who = binding(s, api.conversationId);
    if (o.allow && !o.allow(who.contextId, who.actorId, tool)) {
      o.onDenied?.({ ...who, tool });
      throw new Error(`tool-denied: ${who.actorId} has not been granted ${tool} in ${who.contextId}`);
    }
    return who;
  };

  const k8s = defineTool({
    name: "k8s",
    description: "Read-only kubectl in the allowed namespaces (get|describe|logs).",
    parameters: Type.Object({
      verb: Type.String({ description: "get | describe | logs" }),
      res: Type.String({ description: "configmap | deployment | pod | service | events" }),
      name: Type.Optional(Type.String()),
      ns: Type.String(),
      tail: Type.Optional(Type.Number()),
    }),
    replay: "safe",
    execute: async (args, api) => {
      caller(api, "k8s");
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
    execute: async (args, api) => {
      caller(api, "repo");
      const r = await runTool({ tool: "repo", ...args });
      return text(r.ok ? r.output : `ERROR: ${r.output}`);
    },
  });

  const world = defineTool({
    name: "world",
    description: "Look at the world of this case, read-only: ls a directory, read a file, or grep a pattern.",
    parameters: Type.Object({
      op: Type.String({ description: "ls | read | grep" }),
      path: Type.Optional(Type.String({ description: "file or directory prefix" })),
      pattern: Type.Optional(Type.String({ description: "regular expression for grep" })),
      lines: Type.Optional(Type.Number()),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const { contextId } = caller(api, "world");
      const w = o.world?.(contextId);
      if (!w) return text("ERROR: this case has no world");
      if (args.op === "ls") return text(w.ls(args.path).join("\n") || "(empty)");
      if (args.op === "read") {
        const c = w.read(args.path ?? "", Math.min(args.lines ?? 200, 400));
        return text(c ?? `ERROR: no such file: ${args.path ?? ""}`);
      }
      if (args.op === "grep") {
        if (!args.pattern) return text("ERROR: grep needs a pattern");
        try { return text(w.grep(args.pattern, args.path).join("\n") || "(no matches)"); } catch { return text("ERROR: invalid pattern"); }
      }
      return text(`ERROR: unknown op ${args.op}`);
    },
  });

  const observe = defineTool({
    name: "observe",
    description: "Record a finding in the case as a hypothesis, with evidence (what you fetched and from where).",
    parameters: Type.Object({
      text: Type.String(),
      evidence: Type.Optional(Type.Array(Type.String())),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const { contextId, actorId } = caller(api, "observe");
      const ev = s.recordObservation({
        id: `obs:${api.callId}`, contextId, kind: "finding", authorId: actorId,
        text: args.text, status: "hypothesis", evidence: [...(args.evidence ?? []), `pi:call:${api.callId}`], createdAt: Date.now(),
      });
      return text(`Recorded finding (event ${ev.seq}).`);
    },
  });

  const propose = defineTool({
    name: "propose",
    description: "Propose a change instead of describing a command. Nothing runs: a human with decision rights must approve first. Give the adapter and its fields (e.g. adapter=world verb=set path key value).",
    parameters: Type.Object({
      adapter: Type.Optional(Type.String({ description: "which executor adapter, e.g. kubectl or world" })),
      verb: Type.String({ description: "e.g. set | patch" }),
      res: Type.Optional(Type.String()),
      ns: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      patch: Type.Optional(Type.Record(Type.String(), Type.Any())),
      why: Type.String(),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const { contextId, actorId } = caller(api, "propose");
      const proposalId = `prop:${api.callId}`;
      const decisionId = `dec:${api.callId}`;
      const { why, ...action } = args;
      const target = args.path ?? args.name ?? args.res ?? "";
      s.proposeAction(
        { id: proposalId, contextId, kind: "proposal", authorId: actorId, text: why.slice(0, 500), status: null, evidence: [`pi:call:${api.callId}`], createdAt: Date.now() },
        action,
        decisionId,
      );
      s.requestDecision({
        id: decisionId, contextId, question: `Approve action: ${args.verb} ${target}${args.key ? ` ${args.key}=${args.value ?? ""}` : ""}?`,
        options: ["yes", "no"], requestedBy: actorId, decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null,
      });
      return text(`Proposed action, waiting for human decision ${decisionId}.`);
    },
  });

  return defineExtension({ name: "piople", tools: [k8s, repo, world, observe, propose] });
}
