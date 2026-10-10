import { randomUUID } from "node:crypto";
import type { ContextKind, Store } from "./core/index.ts";

/**
 * One operation table, two process-level faces: CLI (src/cli/main.ts) and MCP (src/mcp/server.ts).
 * The caller's identity is fixed by the process (`as`), never taken from arguments.
 * Every op goes through Store, so membership/capability rules are identical everywhere.
 */
export type Args = Record<string, unknown>;

/** How anything that is not Core itself talks to it: in-process (LocalCore) or over HTTP (HttpCore). */
export interface CoreClient {
  call(as: string, op: string, args?: Args): Promise<unknown>;
}
type Op = {
  description: string;
  required: string[];
  optional?: string[];
  /** The optional `id` names a new object (not an existing one): a host may derive a stable one for retries. */
  mintsId?: boolean;
  run(s: Store, as: string, a: Args): unknown;
};

const str = (a: Args, k: string) => String(a[k]);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : String(v).split(","));
const json = (v: unknown): unknown => {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const flag = (v: unknown) => v === true || v === "true";
const key = (a: Args) => (a.key == null ? randomUUID() : String(a.key));

export const OPS: Record<string, Op> = {
  actor: {
    description: "Register or rename the calling actor (kind inferred from id prefix human:/agent:); --skills a,b declares routing hints, not permissions",
    required: [], optional: ["name", "skills"],
    run: (s, as, a) => {
      s.upsertActor({ id: as, kind: as.startsWith("human:") ? "human" : "agent", name: a.name == null ? as : str(a, "name") });
      if (a.skills != null) s.setSkills(as, list(a.skills));
      return { id: as };
    },
  },
  create: {
    mintsId: true,
    description: "Create a context: a case (default), a channel (needs --realm) or a realm. The caller joins holding what it may in the realm. --parent puts a case under a channel",
    required: ["title"], optional: ["id", "goal", "kind", "realm", "parent"],
    run: (s, as, a) => {
      const kind = (a.kind == null ? "case" : str(a, "kind")) as ContextKind;
      return s.createContext({
        id: a.id == null ? `${kind}-${randomUUID().slice(0, 8)}` : str(a, "id"), kind, title: str(a, "title"), goal: a.goal == null ? "" : str(a, "goal"), createdAt: Date.now(),
        realmId: a.realm == null ? null : str(a, "realm"), parentId: a.parent == null ? null : str(a, "parent"),
      }, as);
    },
  },
  targets: {
    description: "What I may address: realms, channels and cases I can write to, with my effective capabilities in each",
    required: [],
    run: (s, as) => s.targets(as),
  },
  join: {
    description: "Grant membership to another actor (caller needs decide, cannot grant more than it holds)",
    required: ["context", "actor"], optional: ["caps", "key"],
    run: (s, as, a) => s.join({ contextId: str(a, "context"), actorId: str(a, "actor"), capabilities: a.caps == null ? ["read", "write"] : list(a.caps), joinedAt: Date.now() }, a.key == null ? `join:${str(a, "actor")}:${[...(a.caps == null ? ["read", "write"] : list(a.caps))].sort().join("+")}:${s.removals(str(a, "context"), str(a, "actor"))}` : str(a, "key"), as),
  },
  leave: {
    description: "Leave a context or realm (leaving a realm leaves everything inside it). Refused for the last holder of decide",
    required: ["context"], optional: ["key"],
    run: (s, as, a) => s.removeMember(str(a, "context"), as, key(a), as),
  },
  "remove-member": {
    description: "Remove another actor from a context or realm at once (caller needs decide). Their held work is reopened; refused for the last holder of decide",
    required: ["context", "actor"], optional: ["key"],
    run: (s, as, a) => s.removeMember(str(a, "context"), str(a, "actor"), key(a), as),
  },
  events: {
    description: "Read context events after seq (members only)",
    required: ["context"], optional: ["after", "limit"],
    run: (s, as, a) => {
      return s.readEvents(str(a, "context"), as, Number(a.after ?? 0), Number(a.limit ?? 200));
    },
  },
  inbox: {
    description: "What I owe attention: without --context a summary of all my cases; with it the events after my cursor plus pending asks and decisions",
    required: [], optional: ["context", "limit", "holder"],
    run: (s, as, a) => {
      s.requireHolder(as, a.holder == null ? undefined : String(a.holder));
      return a.context == null ? s.inbox(as) : s.inboxOf(str(a, "context"), as, Number(a.limit ?? 200));
    },
  },
  ack: {
    description: "Move my read cursor forward to --seq (never back). Does not resolve pending items",
    required: ["context", "seq"], optional: ["holder"],
    run: (s, as, a) => {
      s.requireHolder(as, a.holder == null ? undefined : String(a.holder));
      return { cursor: s.ack(str(a, "context"), as, Number(a.seq)) };
    },
  },
  "host-lease": {
    description: "Acquire or renew the lease on my inbox for this host process. Refused (already-hosted) while another holder's lease is live; then only the holder may inbox/ack",
    required: ["holder"], optional: ["ttl-ms"],
    run: (s, as, a) => s.hostLease(as, str(a, "holder"), a["ttl-ms"] == null ? 30_000 : Number(a["ttl-ms"])),
  },
  "host-release": {
    description: "Give up my inbox lease at once (the holder only)",
    required: ["holder"],
    run: (s, as, a) => (s.hostRelease(as, str(a, "holder")), { released: true }),
  },
  "work-request": {
    mintsId: true,
    description: "Ask for work, addressed to an actor (--to) and/or anyone declaring a skill (--skill)",
    required: ["context", "input"], optional: ["to", "skill", "id"],
    run: (s, as, a) => {
      const id = a.id == null ? `w-${randomUUID().slice(0, 8)}` : str(a, "id");
      return s.requestWork(str(a, "context"), as, { id, to: a.to == null ? null : str(a, "to"), skill: a.skill == null ? null : str(a, "skill"), input: json(a.input) });
    },
  },
  "work-claim": {
    description: "Atomically claim work: --id <work> or --next for the oldest I may take. Returns the attempt number; pass work:<id>:<attempt> on as your idempotency key",
    required: ["context"], optional: ["id", "next", "lease-ms"],
    run: (s, as, a) => {
      const lease = a["lease-ms"] == null ? undefined : Number(a["lease-ms"]);
      if (a.id != null) return s.claimWork(str(a, "context"), as, str(a, "id"), lease);
      if (flag(a.next)) return s.claimNext(str(a, "context"), as, lease) ?? { work: null };
      throw new Error("missing: id or next");
    },
  },
  "work-complete": {
    description: "Finish claimed work with the attempt you were given; refused if the claim moved on",
    required: ["context", "id", "attempt"], optional: ["result"],
    run: (s, as, a) => s.completeWork(str(a, "context"), as, str(a, "id"), Number(a.attempt), json(a.result)),
  },
  "work-fail": {
    description: "Give up claimed work; --retry true reopens it for anyone eligible",
    required: ["context", "id", "attempt", "reason"], optional: ["retry"],
    run: (s, as, a) => s.failWork(str(a, "context"), as, str(a, "id"), Number(a.attempt), str(a, "reason"), flag(a.retry)),
  },
  submit: {
    description: "Submit a message without saying where it belongs; it waits in my ingress until a router routes it. --after-context/--after-seq name the routed message this reacts to (hop limit)",
    required: ["text"], optional: ["key", "after-context", "after-seq"],
    run: (s, as, a) => s.submitMessage(as, key(a), str(a, "text"), a["after-context"] == null ? undefined : { context: str(a, "after-context"), seq: Number(a["after-seq"]) }),
  },
  "route-pending": {
    description: "Router only: submitted messages still waiting for a route, with any recorded classification",
    required: [], optional: ["limit"],
    run: (s, as, a) => s.routePending(as, Number(a.limit ?? 50)),
  },
  "route-targets": {
    description: "Router only: what the sender may address. Show a classifier nothing else",
    required: ["sender"],
    run: (s, as, a) => s.routeTargets(as, str(a, "sender")),
  },
  "route-classified": {
    description: "Router only: record the classifier's assessment of a submitted message (JSON). Not a decision",
    required: ["ingress", "submitted", "data"], optional: ["tag"],
    run: (s, as, a) => s.routeClassified(as, str(a, "ingress"), str(a, "submitted"), json(a.data) as Record<string, unknown>, a.tag == null ? undefined : str(a, "tag")),
  },
  "route-resolve": {
    description: "Router only: deliver a submitted message to --context as its sender (message, or --as work with --skill/--to). --deliver false records the route without delivering",
    required: ["ingress", "submitted", "context"], optional: ["as", "skill", "to", "deliver"],
    run: (s, as, a) => s.routeResolve(as, str(a, "ingress"), str(a, "submitted"), {
      context: str(a, "context"), as: a.as == null ? undefined : (str(a, "as") as "message" | "work"),
      skill: a.skill == null ? null : str(a, "skill"), to: a.to == null ? null : str(a, "to"), deliver: !(a.deliver === false || a.deliver === "false"),
    }),
  },
  "route-unresolved": {
    description: "Router only: leave a submitted message unrouted (uncertain or invalid); it stays visible to its sender",
    required: ["ingress", "submitted", "reason"], optional: ["data"],
    run: (s, as, a) => s.routeUnresolved(as, str(a, "ingress"), str(a, "submitted"), str(a, "reason"), a.data == null ? {} : (json(a.data) as Record<string, unknown>)),
  },
  post: {
    description: "Post a message",
    required: ["context", "text"], optional: ["key"],
    run: (s, as, a) => s.postMessage(str(a, "context"), as, key(a), str(a, "text")),
  },
  observe: {
    mintsId: true,
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
    mintsId: true,
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
    required: ["state"], optional: ["echo", "key"],
    run: (s, as, a) => s.setPresence(as, str(a, "state") as "active" | "away" | "silent", a.echo === true || a.echo === "true", a.key == null ? undefined : str(a, "key")),
  },
};

/**
 * Ops whose server-side default idempotency key is random. A caller that may retry (a network
 * client) must fix a key before the first attempt, or a lost response would turn into a duplicate.
 * Other keyed ops (decide, join, ...) have deterministic defaults and are replay-safe as they are.
 */
export const RANDOM_KEY_OPS: ReadonlySet<string> = new Set(["post", "ask", "answer", "presence", "submit", "leave", "remove-member"]);

export function runOp(s: Store, as: string, name: string, a: Args): unknown {
  const op = OPS[name];
  if (!op) throw new Error(`unknown-op: ${name}`);
  const missing = op.required.filter((k) => a[k] == null || a[k] === "");
  if (missing.length) throw new Error(`missing: ${missing.join(",")}`);
  return op.run(s, as, a);
}
