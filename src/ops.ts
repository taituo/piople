import { randomUUID } from "node:crypto";
import type { Store } from "./core/index.ts";

/**
 * One operation table, two process-level faces: CLI (src/cli/main.ts) and MCP (src/mcp/server.ts).
 * The caller's identity is fixed by the process (`as`), never taken from arguments.
 * Every op goes through Store, so membership/capability rules are identical everywhere.
 */
export type Args = Record<string, unknown>;
type Op = {
  description: string;
  required: string[];
  optional?: string[];
  run(s: Store, as: string, a: Args): unknown;
};

const str = (a: Args, k: string) => String(a[k]);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : String(v).split(","));
const key = (a: Args) => (a.key == null ? randomUUID() : String(a.key));

export const OPS: Record<string, Op> = {
  actor: {
    description: "Register or rename the calling actor (kind inferred from id prefix human:/agent:)",
    required: [], optional: ["name"],
    run: (s, as, a) => {
      s.upsertActor({ id: as, kind: as.startsWith("human:") ? "human" : "agent", name: a.name == null ? as : str(a, "name") });
      return { id: as };
    },
  },
  create: {
    description: "Create a case context; the caller joins with read,write,decide",
    required: ["title"], optional: ["id", "goal"],
    run: (s, as, a) => s.createContext({ id: a.id == null ? `case-${randomUUID().slice(0, 8)}` : str(a, "id"), kind: "case", title: str(a, "title"), goal: a.goal == null ? "" : str(a, "goal"), createdAt: Date.now() }, as),
  },
  join: {
    description: "Grant membership to another actor (caller needs decide, cannot grant more than it holds)",
    required: ["context", "actor"], optional: ["caps", "key"],
    run: (s, as, a) => s.join({ contextId: str(a, "context"), actorId: str(a, "actor"), capabilities: a.caps == null ? ["read", "write"] : list(a.caps), joinedAt: Date.now() }, a.key == null ? `join:${str(a, "actor")}` : str(a, "key"), as),
  },
  events: {
    description: "Read context events after seq (members only)",
    required: ["context"], optional: ["after", "limit"],
    run: (s, as, a) => {
      if (!s.isMember(str(a, "context"), as)) throw new Error(`not-a-member: ${as} not in ${str(a, "context")}`);
      return s.eventsSince(str(a, "context"), Number(a.after ?? 0), Number(a.limit ?? 200));
    },
  },
  post: {
    description: "Post a message",
    required: ["context", "text"], optional: ["key"],
    run: (s, as, a) => s.postMessage(str(a, "context"), as, key(a), str(a, "text")),
  },
  observe: {
    description: "Record a finding (status hypothesis)",
    required: ["context", "text"], optional: ["evidence", "id"],
    run: (s, as, a) => s.recordObservation({ id: a.id == null ? `obs-${randomUUID().slice(0, 8)}` : str(a, "id"), contextId: str(a, "context"), kind: "finding", authorId: as, text: str(a, "text"), status: "hypothesis", evidence: list(a.evidence), createdAt: Date.now() }),
  },
  promote: {
    description: "Confirm or refute a finding",
    required: ["artifact", "status"],
    run: (s, as, a) => s.promoteObservation(str(a, "artifact"), as, str(a, "status") as "confirmed" | "refuted"),
  },
  ask: {
    description: "Request assistance from an actor (may be a non-member expert)",
    required: ["context", "to", "question"], optional: ["key"],
    run: (s, as, a) => s.requestAssistance(str(a, "context"), as, key(a), str(a, "to"), str(a, "question"), {}),
  },
  answer: {
    description: "Answer an assistance request (member or invited expert)",
    required: ["context", "request", "answer"], optional: ["evidence", "key"],
    run: (s, as, a) => s.answerAssistance(str(a, "context"), as, key(a), str(a, "request"), str(a, "answer"), list(a.evidence)),
  },
  "decision-request": {
    description: "Open a decision",
    required: ["context", "question"], optional: ["options", "id"],
    run: (s, as, a) => s.requestDecision({ id: a.id == null ? `d-${randomUUID().slice(0, 8)}` : str(a, "id"), contextId: str(a, "context"), question: str(a, "question"), options: a.options == null ? ["yes", "no"] : list(a.options), requestedBy: as, decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null }),
  },
  decide: {
    description: "Resolve an open decision (needs decide; echo delegates never decide)",
    required: ["context", "decision", "answer"], optional: ["key"],
    run: (s, as, a) => s.resolveDecision(str(a, "context"), as, a.key == null ? `decide:${str(a, "decision")}` : str(a, "key"), str(a, "decision"), str(a, "answer")),
  },
  presence: {
    description: "Set own presence: active|away|silent, optional echo",
    required: ["state"], optional: ["echo"],
    run: (s, as, a) => s.setPresence(as, str(a, "state") as "active" | "away" | "silent", a.echo === true || a.echo === "true"),
  },
};

export function runOp(s: Store, as: string, name: string, a: Args): unknown {
  const op = OPS[name];
  if (!op) throw new Error(`unknown-op: ${name}`);
  const missing = op.required.filter((k) => a[k] == null || a[k] === "");
  if (missing.length) throw new Error(`missing: ${missing.join(",")}`);
  return op.run(s, as, a);
}
