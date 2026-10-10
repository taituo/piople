import { DatabaseSync } from "node:sqlite";

/**
 * OptChat-style case memory for a long-lived agent: recent events verbatim, older ones summarised in chunks of K,
 * summaries of summaries above that. A *derived* store beside a harness (its own sqlite file), never in Core: the
 * source of truth stays the event log, so the tree can be rebuilt from the events and the same summarizer gives
 * the same tree. Nothing here imports a model library; summarising goes through the `Summarizer` interface.
 *
 * What a summary may never be the only home of: open asks, decisions and work come from Core's `pending` on every
 * step, and decisions already taken are pinned verbatim in the view (`decisions`) even after their event was folded
 * into a summary.
 */

export type MemEvent = { seq: number; actorId: string; type: string; data: Record<string, unknown> };
export type MemNode = { id: string; level: number; type: string | null; firstSeq: number; lastSeq: number; text: string; children: string[]; parent: string | null };

export interface Summarizer {
  readonly name: string;
  /** Pin the exact model/version: recorded so a tree built by another summarizer is recognisable. */
  readonly version: string;
  summarize(input: { level: number; texts: string[]; firstSeq: number; lastSeq: number }): Promise<string>;
}

export type MemoryOptions = {
  summarizer: Summarizer;
  /** Nodes summarised together. Default 8. */
  k?: number;
  /** Newest events that are never summarised (kept verbatim). Default 20. */
  recent?: number;
};

const SKIP = new Set(["presence.changed"]);
const PINNED = ["decision.requested", "decision.resolved"];

/** The line a memory node holds for an event: complete, never truncated, so zooming returns the original. */
export function eventLine(e: MemEvent): string {
  const d = e.data;
  const id = typeof d.decisionId === "string" ? ` [${d.decisionId}]` : "";
  const body = typeof d.text === "string" ? d.text : typeof d.question === "string" ? d.question : typeof d.answer === "string" ? d.answer : JSON.stringify(d);
  return `${e.seq} ${e.actorId} ${e.type}${id}: ${body}`;
}

const cut = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, Math.max(1, n - 1))}…`);

export class CaseMemory {
  private readonly db: DatabaseSync;
  private readonly summarizer: Summarizer;
  private readonly k: number;
  private readonly recent: number;

  private constructor(db: DatabaseSync, o: MemoryOptions) {
    this.db = db;
    this.summarizer = o.summarizer;
    this.k = Math.max(2, o.k ?? 8);
    this.recent = Math.max(0, o.recent ?? 20);
  }

  static open(path: string, o: MemoryOptions): CaseMemory {
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS nodes (
        context TEXT NOT NULL, id TEXT NOT NULL, level INTEGER NOT NULL, type TEXT,
        first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, text TEXT NOT NULL, children TEXT NOT NULL, parent TEXT,
        PRIMARY KEY (context, id));
      CREATE INDEX IF NOT EXISTS nodes_level ON nodes(context, level, first_seq);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    const prev = db.prepare(`SELECT v FROM meta WHERE k='summarizer'`).get() as { v: string } | undefined;
    const now = `${o.summarizer.name}@${o.summarizer.version}`;
    if (prev && prev.v !== now) throw new Error(`memory-summarizer-mismatch: this memory was built by ${prev.v}, not ${now}; rebuild it from the events`);
    db.prepare(`INSERT INTO meta(k,v) VALUES('summarizer',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(now);
    return new CaseMemory(db, o);
  }

  close(): void {
    this.db.close();
  }

  private node(r: Record<string, unknown>): MemNode {
    return { id: r.id as string, level: r.level as number, type: (r.type as string | null) ?? null, firstSeq: r.first_seq as number, lastSeq: r.last_seq as number, text: r.text as string, children: JSON.parse(r.children as string) as string[], parent: (r.parent as string | null) ?? null };
  }

  /** The highest event seq held in this case's memory (0 if none): where to continue reading the log. */
  lastSeq(context: string): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(last_seq),0) m FROM nodes WHERE context=? AND level=0`).get(context) as { m: number }).m;
  }

  /** Add events as level-0 nodes. Idempotent by seq: a redelivered step adds nothing. */
  ingest(context: string, events: MemEvent[]): number {
    let added = 0;
    const ins = this.db.prepare(`INSERT OR IGNORE INTO nodes(context,id,level,type,first_seq,last_seq,text,children,parent) VALUES(?,?,0,?,?,?,?,'[]',NULL)`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const e of events) {
        if (SKIP.has(e.type)) continue;
        added += Number(ins.run(context, `e${e.seq}`, e.type, e.seq, e.seq, eventLine(e)).changes);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return added;
  }

  private uncovered(context: string, level: number): MemNode[] {
    return (this.db.prepare(`SELECT * FROM nodes WHERE context=? AND level=? AND parent IS NULL ORDER BY first_seq`).all(context, level) as Array<Record<string, unknown>>).map((r) => this.node(r));
  }

  /**
   * Fold every full chunk of K unsummarised nodes into a summary node, level by level. The newest `recent`
   * level-0 nodes stay verbatim. Returns how many summaries were made. The summariser is called before anything is
   * written, so a failing summariser leaves the tree as it was and the next compaction tries again.
   */
  async compact(context: string): Promise<number> {
    let made = 0;
    for (let level = 0; level < 12; level++) {
      const open = this.uncovered(context, level);
      const eligible = level === 0 ? open.slice(0, Math.max(0, open.length - this.recent)) : open;
      let any = false;
      for (let i = 0; i + this.k <= eligible.length; i += this.k) {
        const chunk = eligible.slice(i, i + this.k);
        const first = chunk[0]!.firstSeq, last = chunk.at(-1)!.lastSeq;
        const text = (await this.summarizer.summarize({ level: level + 1, texts: chunk.map((n) => n.text), firstSeq: first, lastSeq: last })).trim();
        if (!text) throw new Error(`memory-empty-summary: ${this.summarizer.name} returned nothing for events ${first}-${last}`);
        const id = `s${level + 1}:${first}-${last}`;
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.prepare(`INSERT OR IGNORE INTO nodes(context,id,level,type,first_seq,last_seq,text,children,parent) VALUES(?,?,?,NULL,?,?,?,?,NULL)`).run(context, id, level + 1, first, last, text, JSON.stringify(chunk.map((n) => n.id)));
          const up = this.db.prepare(`UPDATE nodes SET parent=? WHERE context=? AND id=?`);
          for (const n of chunk) up.run(id, context, n.id);
          this.db.exec("COMMIT");
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
        made++;
        any = true;
      }
      if (!any && level > 0) break;
    }
    return made;
  }

  /** A node and the nodes it stands for. Level 0 has no children: its text is the original line. */
  zoom(context: string, id: string): { node: MemNode; children: MemNode[] } | null {
    const r = this.db.prepare(`SELECT * FROM nodes WHERE context=? AND id=?`).get(context, id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const node = this.node(r);
    const get = this.db.prepare(`SELECT * FROM nodes WHERE context=? AND id=?`);
    return { node, children: node.children.map((c) => this.node(get.get(context, c) as Record<string, unknown>)) };
  }

  /**
   * Exact search over the original lines (level 0 is never discarded, only left out of the view): every word must occur in
   * what was said (not in the seq, actor or type that prefix a line), case-insensitively. Newest matches are returned last, because a later line may correct an earlier one. Summaries are
   * not searched: they paraphrase, and the point of a search is to get the words as they were said.
   */
  find(context: string, query: string, limit = 8): { matches: MemNode[]; total: number } {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0).slice(0, 6);
    if (!words.length) return { matches: [], total: 0 };
    // Matched in JavaScript, not with SQL LIKE/LOWER: SQLite lowers ASCII only, so "älä" would never find "Älä" and
    // "öljy" never "ÖLJY" (Finnish and Swedish capitals).
    const rows = this.db.prepare(`SELECT * FROM nodes WHERE context=? AND level=0 ORDER BY first_seq`).all(context) as Array<Record<string, unknown>>;
    // Only the words that were said: a line is "<seq> <actor> <type>[ <id>]: <body>", and a search for "message" or "alice" must not match them all.
    const body = (line: string) => { const i = line.indexOf(": "); return (i < 0 ? line : line.slice(i + 2)).toLowerCase(); };
    const matches = rows.filter((r) => { const t = body(String(r.text)); return words.every((w) => t.includes(w)); }).map((r) => this.node(r));
    const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 8;
    return { matches: matches.slice(matches.length - Math.min(n, matches.length)), total: matches.length };
  }

  /** Decisions already taken or asked whose events have been folded into summaries: pinned verbatim. */
  pinned(context: string, max = 20): MemNode[] {
    const q = this.db.prepare(`SELECT * FROM nodes WHERE context=? AND level=0 AND parent IS NOT NULL AND type IN (${PINNED.map(() => "?").join(",")}) ORDER BY first_seq DESC LIMIT ?`);
    return (q.all(context, ...PINNED, max) as Array<Record<string, unknown>>).map((r) => this.node(r)).reverse();
  }

  /**
   * What the agent is shown: every node no summary covers yet, oldest first (summaries of old history, then the
   * recent events verbatim), within a token budget (~4 characters a token). Over budget, texts are shortened
   * evenly down to a floor; then the oldest nodes are left out, and the count is reported. Every line carries its id.
   */
  view(context: string, budgetTokens = 1500): { text: string; omitted: number; nodes: number } {
    const frontier = (this.db.prepare(`SELECT * FROM nodes WHERE context=? AND parent IS NULL ORDER BY first_seq, level DESC`).all(context) as Array<Record<string, unknown>>).map((r) => this.node(r));
    const pins = this.pinned(context);
    const budget = Math.max(200, budgetTokens * 4);
    const line = (n: MemNode, cap: number) => (n.level === 0 ? `[${n.id}] ${cut(n.text, cap)}` : `[${n.id}] summary of events ${n.firstSeq}-${n.lastSeq} (ZOOM to read them): ${cut(n.text, cap)}`);
    const render = (nodes: MemNode[], cap: number) => nodes.map((n) => line(n, n.level === 0 ? cap : cap + 300));
    const pinLines = (cap: number) => pins.map((n) => `[${n.id}] ${cut(n.text, cap)}`);
    const size = (ls: string[]) => ls.reduce((a, l) => a + l.length + 1, 0);
    let cap = 400, nodes = frontier;
    while (size(render(nodes, cap)) + size(pinLines(cap)) > budget && cap > 60) cap = Math.max(60, Math.floor(cap * 0.7));
    // Still too big: leave out the most detailed old entries first (lowest level, oldest), never the newest three
    // events. The broad summaries are the cheapest way to keep the gist of the whole case, so they go last.
    let omitted = 0;
    const protectedIds = new Set(nodes.filter((n) => n.level === 0).slice(-3).map((n) => n.id));
    const order = nodes.filter((n) => !protectedIds.has(n.id)).sort((a, b) => a.level - b.level || a.firstSeq - b.firstSeq);
    for (const drop of order) {
      if (size(render(nodes, cap)) + size(pinLines(cap)) <= budget) break;
      nodes = nodes.filter((n) => n.id !== drop.id);
      omitted++;
    }
    const out = [
      ...(omitted ? [`(${omitted} detailed entries left out to fit; the summaries above still cover them: ZOOM one to read them)`] : []),
      ...render(nodes, cap),
      ...(pins.length ? ["Decisions already taken or asked, verbatim:", ...pinLines(cap)] : []),
    ];
    return { text: out.join("\n"), omitted, nodes: nodes.length };
  }
}

/** Offline, deterministic summariser: the opening of each line. For tests and as a no-model baseline; it loses detail by design. */
export function extractiveSummarizer(o: { perLine?: number; max?: number } = {}): Summarizer {
  const per = o.perLine ?? 70, max = o.max ?? 600;
  return {
    name: "extractive", version: `${per}/${max}`,
    async summarize({ texts, firstSeq, lastSeq }) {
      return cut(`${texts.length} items, events ${firstSeq}-${lastSeq}: ${texts.map((t) => cut(t.replace(/\s+/g, " "), per)).join(" | ")}`, max);
    },
  };
}

/**
 * Summarise with a model behind an OpenAI-compatible /chat/completions (plain fetch, no SDK). Pin the exact model
 * id: it is recorded with the memory, and a memory refuses to open under another summariser. `headers` are for
 * gateways that want extra ones (the opencode Go gateway needs `x-opencode-session`). Summarising is a cheap job:
 * prefer a small non-reasoning model.
 */
export function modelSummarizer(o: { baseUrl: string; apiKey?: string; modelId: string; maxWords?: number; maxTokens?: number; timeoutMs?: number; headers?: Record<string, string>; fetch?: typeof fetch }): Summarizer & { stats: { calls: number; input: number; output: number } } {
  const request = o.fetch ?? fetch;
  const words = o.maxWords ?? 120;
  const stats = { calls: 0, input: 0, output: 0 };
  return {
    stats,
    name: "model", version: o.modelId,
    async summarize({ level, texts, firstSeq, lastSeq }) {
      const system = `You compress the history of a shared case between humans and agents. Write at most ${words} words. Keep who said or did what, ids, names, numbers, exact decisions and what is still owed. Never invent anything; say "unknown" rather than guess. Output only the summary.`;
      const user = `${level === 1 ? "Events" : "Summaries"} ${firstSeq}-${lastSeq}:\n${texts.join("\n")}`;
      let res: Response;
      try {
        res = await request(`${o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
          headers: { ...o.headers, "content-type": "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
          body: JSON.stringify({ model: o.modelId, temperature: 0, max_tokens: o.maxTokens ?? Math.max(2000, words * 12), messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        });
      } catch (e) {
        throw new Error(`summarizer unreachable (${e instanceof Error ? e.name : "error"})`); // never echo the request
      }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`summarizer returned HTTP ${res.status}`); }
      const body = (await res.json().catch(() => null)) as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
      stats.calls++;
      stats.input += body?.usage?.prompt_tokens ?? 0;
      stats.output += body?.usage?.completion_tokens ?? 0;
      // A cut-off summary would be filed as if it were whole: refuse it. (Reasoning models spend max_tokens on thinking first.)
      if (body?.choices?.[0]?.finish_reason === "length") throw new Error("summarizer ran out of tokens before finishing: raise maxTokens (reasoning models need room to think) or use a non-reasoning model");
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("summarizer returned no text");
      return content.trim();
    },
  };
}
