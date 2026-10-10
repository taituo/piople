import type { Store } from "../core/index.ts";
import type { EvalDataset } from "./routing.ts";

/**
 * Real labelled data for the routing evaluation, from real use. When a person posts straight into a channel they
 * have chosen the destination themselves: that message and its channel are a label nobody had to write. This turns
 * those posts into an `EvalDataset` (contexts, members, cases in the order they happened, so `--context K` sees
 * what came before). Not exported: messages a router delivered (the router's choice is not a human label),
 * anything posted by an agent, ingress contexts, and messages shorter than `minLength`.
 *
 * The output holds real message text. Keep it on the machine, review it, and note that running an external
 * classifier over it (`--send-to-external`) shows that text to an outside service. `redact` masks e-mail
 * addresses, URLs and long digit runs; it is a convenience and does not make text safe to share.
 */
export type ExportOptions = { minLength?: number; redact?: boolean; since?: number; name?: string };

export function redactText(t: string): string {
  return t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>").replace(/https?:\/\/\S+/g, "<url>").replace(/\d{6,}/g, "<number>");
}

export function exportLabelled(store: Store, o: ExportOptions = {}): EvalDataset {
  const minLength = o.minLength ?? 2;
  const contexts = store.db.prepare(`SELECT id, kind, title, realm_id, parent_id FROM contexts WHERE kind IN ('realm','channel','case') ORDER BY created_at, rowid`).all() as Array<{ id: string; kind: "realm" | "channel" | "case"; title: string; realm_id: string | null; parent_id: string | null }>;
  const ids = new Set(contexts.map((c) => c.id));
  // What an actor may address NOW, with realm rights applied (store.targets): a post is only a usable label if its author
  // can still address that channel, and the evaluation replays exactly these rights. A channel needs its realm joined first.
  const realmOf = new Map(contexts.map((c) => [c.id, c.realm_id]));
  const actors = (store.db.prepare(`SELECT DISTINCT actor_id FROM members`).all() as Array<{ actor_id: string }>).map((r) => r.actor_id);
  const byActor = new Map<string, string[]>();
  for (const a of actors) {
    const can = store.targets(a).map((t) => t.id).filter((id) => ids.has(id));
    const withRealms = new Set(can);
    for (const id of can) { const r = realmOf.get(id); if (r && ids.has(r)) withRealms.add(r); }
    if (withRealms.size) byActor.set(a, [...withRealms]);
  }
  const addressable = new Map([...actors].map((a) => [a, new Set(store.targets(a).map((t) => t.id))]));
  const rows = store.db.prepare(`SELECT seq, context_id, actor_id, data FROM events WHERE type='message.posted' AND actor_id LIKE 'human:%' AND seq>? ORDER BY seq`).all(o.since ?? 0) as Array<{ seq: number; context_id: string; actor_id: string; data: string }>;
  const cases = [];
  for (const r of rows) {
    if (!ids.has(r.context_id)) continue; // ingress or unknown
    const d = JSON.parse(r.data) as { text?: unknown; via?: unknown };
    if (d.via === "route" || typeof d.text !== "string" || d.text.trim().length < minLength) continue;
    if (!addressable.get(r.actor_id)?.has(r.context_id)) continue; // posted, then lost the right: no longer a valid label
    cases.push({ id: `r${r.seq}`, sender: r.actor_id, text: o.redact ? redactText(d.text) : d.text, expect: r.context_id, tags: ["real"] });
  }
  const used = new Set(cases.map((c) => c.sender));
  return {
    name: o.name ?? "routing-real",
    note: "Exported from real use: each case is a message a person posted straight into a channel, labelled with that channel. Contains real text.",
    contexts: contexts.map((c) => ({ id: c.id, kind: c.kind, title: c.title, ...(c.realm_id ? { realm: c.realm_id } : {}), ...(c.parent_id ? { parent: c.parent_id } : {}) })),
    members: [...byActor].filter(([a]) => used.has(a) || a.startsWith("human:")).map(([actor, ctx]) => ({ actor, contexts: ctx })),
    cases,
  };
}
