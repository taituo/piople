import http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../../src/core/index.ts";
import { createApp, statusOf } from "../../src/http/app.ts";

/** Everyone who can show up at the door of a case. One row per kind of participant, as in an access matrix. */
export const ROLES = ["owner", "decider", "writer", "reader", "away", "echo", "bot", "stranger"] as const;
export type Role = (typeof ROLES)[number];
export const ACTOR: Record<Role, string> = {
  owner: "human:alice", decider: "human:dave", writer: "human:wendy", reader: "human:rita",
  away: "human:amy", echo: "human:eve", bot: "agent:bot", stranger: "human:sam",
};
const CAPS: Record<Exclude<Role, "stranger">, string[]> = {
  owner: ["read", "write", "decide"], decider: ["read", "write", "decide"], writer: ["read", "write"], reader: ["read"],
  away: ["read", "write", "decide"], echo: ["read", "write", "decide"], bot: ["read", "write", "decide"],
};

/** What an attempt came to, whatever the layer: the HTTP status classes and the Store's message prefixes agree. */
export type Outcome = "ok" | "bad" | "forbidden" | "not-found" | "conflict";
export const outcomeOfStatus = (s: number): Outcome =>
  s < 300 ? "ok" : s === 400 ? "bad" : s === 403 ? "forbidden" : s === 404 ? "not-found" : s === 409 ? "conflict" : (`status-${s}` as Outcome);
export const outcomeOfError = (e: unknown): Outcome => outcomeOfStatus(statusOf(e).status);

/**
 * A case "c1" with every kind of participant, one open decision d1 (requested by agent:req), an observation o1
 * and an assistance request q1 to an outside expert.
 */
export function world(opts: { now?: () => number } = {}): Store {
  const s = new Store(":memory:", opts);
  for (const r of ROLES) s.upsertActor({ id: ACTOR[r], kind: ACTOR[r].startsWith("human:") ? "human" : "agent", name: ACTOR[r] });
  s.upsertActor({ id: "agent:req", kind: "agent", name: "req" });
  s.upsertActor({ id: "agent:expert", kind: "agent", name: "expert" });
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "g", createdAt: 1 }, ACTOR.owner);
  for (const r of ROLES) if (r !== "stranger" && r !== "owner") s.join({ contextId: "c1", actorId: ACTOR[r], capabilities: CAPS[r], joinedAt: 1 }, `j:${r}`);
  s.join({ contextId: "c1", actorId: "agent:req", capabilities: ["read", "write"], joinedAt: 1 }, "j:req");
  s.setPresence(ACTOR.away, "away", false);
  s.setPresence(ACTOR.echo, "away", true);
  s.recordObservation({ id: "o1", contextId: "c1", kind: "finding", authorId: ACTOR.writer, text: "t", status: "hypothesis", evidence: ["e"], createdAt: 1 });
  s.requestDecision({ id: "d1", contextId: "c1", question: "go?", options: ["yes", "no"], requestedBy: "agent:req", decidedBy: null, answer: null, status: "open", createdAt: 1, resolvedAt: null });
  s.requestAssistance("c1", "agent:req", "q1", "agent:expert", "help?", {});
  return s;
}

export type Served = {
  store: Store;
  call(actor: string | undefined, method: string, path: string, body?: unknown, raw?: string): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
};

/** Run the real HTTP app in-process on a free port. */
export async function serve(store: Store, opts: Parameters<typeof createApp>[1] = {}): Promise<Served> {
  const server: http.Server = createApp(store, opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    async call(actor, method, path, body, raw) {
      const res = await fetch(base + path, {
        method,
        headers: { ...(actor ? { "x-piople-actor": actor } : {}), ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}) },
        ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const t = await res.text();
      let json: any;
      try { json = JSON.parse(t); } catch { json = t; }
      return { status: res.status, json };
    },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => { store.close(); r(); }); }),
  };
}
