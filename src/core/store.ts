import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Actor, Artifact, Context, Decision, EventType, Id, Membership, PiopleEvent } from "./types.ts";
import { EVENT_TYPES } from "./types.ts";

const MIGRATIONS: string[] = [
  `
CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE contexts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE members (
  context_id TEXT NOT NULL REFERENCES contexts(id), actor_id TEXT NOT NULL REFERENCES actors(id),
  capabilities TEXT NOT NULL, joined_at INTEGER NOT NULL,
  PRIMARY KEY (context_id, actor_id));
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL,
  context_id TEXT NOT NULL, actor_id TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX events_idem ON events(context_id, key);
CREATE INDEX events_ctx ON events(context_id, seq);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, context_id TEXT NOT NULL REFERENCES contexts(id), kind TEXT NOT NULL,
  author_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT, evidence TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX artifacts_ctx ON artifacts(context_id, created_at);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY, context_id TEXT NOT NULL REFERENCES contexts(id), question TEXT NOT NULL,
  options TEXT NOT NULL, requested_by TEXT NOT NULL, decided_by TEXT, answer TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER);
CREATE INDEX decisions_ctx ON decisions(context_id, status);
`,
  // Migrations 2–3 are kept only so existing DBs keep migrating; runs/pi_convs are unused by the core.
  // Migration 2: run ledger.
  `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, model TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  rounds INTEGER NOT NULL, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0, proposals INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'running');
CREATE INDEX runs_case ON runs(case_id, started_at);
`,
  // Migration 3: durable Pi conversation binding. Protocol owns the row; Pi owns the transcript.
  `
CREATE TABLE pi_convs (
  context_id TEXT NOT NULL, actor_id TEXT NOT NULL, conv_id INTEGER NOT NULL,
  PRIMARY KEY (context_id, actor_id));
`,
  // Migration 4: presence. Global per actor; echo never decides.
  `
CREATE TABLE presence (
  actor_id TEXT PRIMARY KEY, state TEXT NOT NULL, echo INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL);
`,
  // Migration 5: per-actor read cursor. Private state, not an event: a harness that is
  // not running between sessions still needs somewhere durable to resume from.
  `
CREATE TABLE cursors (
  context_id TEXT NOT NULL REFERENCES contexts(id), actor_id TEXT NOT NULL,
  acked_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (context_id, actor_id));
`,
];

export type InboxSummary = { context: Id; title: string; cursor: number; unread: number; pending: number };
export type Pending = {
  /** assistance.requested addressed to me with no assistance.answered for its key */
  assistance: Array<{ key: string; from: Id; question: string; seq: number }>;
  /** open decisions I may resolve (needs decide, and not an echo delegate) */
  decisions: Array<{ id: Id; question: string; options: string[]; requestedBy: Id }>;
};
export type InboxDetail = { context: Id; cursor: number; events: PiopleEvent[]; pending: Pending };

type Row = { seq: number; ts: number; type: string; context_id: string; actor_id: string; key: string; data: string };
type Mutation = {
  type: EventType;
  contextId: Id;
  actorId: Id;
  /** Idempotency key, unique per context. */
  key: string;
  /** Permission/precondition checks. Runs first, inside the transaction, also on replays. */
  check?: () => void;
  /** Side-table writes; returns the event data. Skipped when the key was already used. */
  write?: () => Record<string, unknown>;
};

export class Store {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);
    this.migrate();
  }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    const row = this.db.prepare(`SELECT v FROM meta WHERE k='version'`).get() as { v: string } | undefined;
    const version = row ? Number(row.v) : 0;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.prepare(`INSERT INTO meta(k,v) VALUES('version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(String(i + 1));
      });
    }
  }

  /** One write transaction. BEGIN IMMEDIATE takes the write lock up front, so concurrent processes queue instead of racing. */
  private tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* connection already rolled back */ }
      throw e;
    } finally {
      this.depth--;
    }
  }

  /**
   * The only write path. In one transaction: check, replay lookup, side-table writes, event insert.
   * Replay (same context+key, same type+actor) returns the original event and writes nothing.
   * The same key for a different operation or actor is a conflict, never a silent replay.
   */
  private mutate(m: Mutation): PiopleEvent {
    return this.tx(() => {
      m.check?.();
      const existing = this.db.prepare(`SELECT seq, ts, type, context_id, actor_id, key, data FROM events WHERE context_id=? AND key=?`).get(m.contextId, m.key) as Row | undefined;
      if (existing) {
        if (existing.type !== m.type || existing.actor_id !== m.actorId) {
          throw new Error(`key-conflict: ${m.key} in ${m.contextId} already used by ${existing.actor_id} for ${existing.type}`);
        }
        return this.row(existing);
      }
      const data = m.write?.() ?? {};
      const info = this.db.prepare(`INSERT INTO events(ts,type,context_id,actor_id,key,data) VALUES(?,?,?,?,?,?)`).run(Date.now(), m.type, m.contextId, m.actorId, m.key, JSON.stringify(data));
      const row = this.db.prepare(`SELECT seq, ts, type, context_id, actor_id, key, data FROM events WHERE seq=?`).get(info.lastInsertRowid) as Row;
      return this.row(row);
    });
  }

  private row(r: Row): PiopleEvent {
    return { seq: r.seq, ts: r.ts, type: r.type as EventType, contextId: r.context_id, actorId: r.actor_id, key: r.key, data: JSON.parse(r.data) };
  }

  private caps(contextId: string, actorId: string): string[] | undefined {
    const m = this.db.prepare(`SELECT capabilities FROM members WHERE context_id=? AND actor_id=?`).get(contextId, actorId) as { capabilities: string } | undefined;
    return m ? (JSON.parse(m.capabilities) as string[]) : undefined;
  }

  private mustMember(contextId: string, actorId: string, cap: string): void {
    const caps = this.caps(contextId, actorId);
    if (!caps) throw new Error(`not-a-member: ${actorId} not in ${contextId}`);
    if (!caps.includes(cap)) throw new Error(`forbidden: ${actorId} lacks ${cap} in ${contextId}`);
  }

  upsertActor(a: Actor): void {
    this.db.prepare(`INSERT INTO actors(id,kind,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`).run(a.id, a.kind, a.name);
  }

  createContext(c: Context, by: Id): PiopleEvent {
    return this.mutate({
      type: "context.created", contextId: c.id, actorId: by, key: `create:${c.id}`,
      write: () => {
        this.db.prepare(`INSERT INTO actors(id,kind,name) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`).run(by, by.startsWith("human:") ? "human" : "agent", by);
        this.db.prepare(`INSERT INTO contexts(id,kind,title,goal,created_at) VALUES(?,?,?,?,?)`).run(c.id, c.kind, c.title, c.goal, c.createdAt);
        this.db.prepare(`INSERT INTO members(context_id,actor_id,capabilities,joined_at) VALUES(?,?,?,?)`).run(c.id, by, JSON.stringify(["read", "write", "decide"]), c.createdAt);
        return { title: c.title };
      },
    });
  }

  /**
   * Joining is granted, never taken: `by` must be a member with `decide`,
   * and may not hand out capabilities it does not hold itself.
   */
  join(m: Membership, key: string, by: Id): PiopleEvent {
    return this.mutate({
      type: "member.joined", contextId: m.contextId, actorId: m.actorId, key,
      check: () => {
        this.mustMember(m.contextId, by, "decide");
        const extra = m.capabilities.filter((c) => !this.caps(m.contextId, by)!.includes(c));
        if (extra.length) throw new Error(`forbidden: ${by} cannot grant ${extra.join(",")}`);
      },
      write: () => {
        // The joiner may be known only by id (e.g. from another runtime); register it without renaming.
        this.db.prepare(`INSERT INTO actors(id,kind,name) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`).run(m.actorId, m.actorId.startsWith("human:") ? "human" : "agent", m.actorId);
        this.db.prepare(`INSERT INTO members(context_id,actor_id,capabilities,joined_at) VALUES(?,?,?,?) ON CONFLICT(context_id,actor_id) DO UPDATE SET capabilities=excluded.capabilities`).run(
          m.contextId, m.actorId, JSON.stringify(m.capabilities), m.joinedAt,
        );
        return { capabilities: m.capabilities, by };
      },
    });
  }

  postMessage(contextId: Id, actorId: Id, key: string, text: string): PiopleEvent {
    return this.mutate({
      type: "message.posted", contextId, actorId, key,
      check: () => this.mustMember(contextId, actorId, "write"),
      write: () => ({ text }),
    });
  }

  recordObservation(a: Artifact): PiopleEvent {
    return this.mutate({
      type: "observation.recorded", contextId: a.contextId, actorId: a.authorId, key: `artifact:${a.id}`,
      check: () => this.mustMember(a.contextId, a.authorId, "write"),
      write: () => {
        this.db.prepare(`INSERT INTO artifacts(id,context_id,kind,author_id,text,status,evidence,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
          a.id, a.contextId, a.kind, a.authorId, a.text, a.status, JSON.stringify(a.evidence), a.createdAt,
        );
        return { artifactId: a.id, kind: a.kind, status: a.status, text: a.text.slice(0, 2000), evidence: a.evidence };
      },
    });
  }

  requestAssistance(contextId: Id, actorId: Id, key: string, to: Id, question: string, snapshot: Record<string, unknown>): PiopleEvent {
    return this.mutate({
      type: "assistance.requested", contextId, actorId, key,
      check: () => this.mustMember(contextId, actorId, "write"),
      write: () => ({ to, question, snapshot }),
    });
  }

  answerAssistance(contextId: Id, actorId: Id, key: string, requestKey: string, answer: string, evidence: string[]): PiopleEvent {
    return this.mutate({
      type: "assistance.answered", contextId, actorId, key,
      check: () => {
        if (!this.isMember(contextId, actorId) && !this.isInvitedExpert(contextId, actorId)) {
          throw new Error(`not-a-member: ${actorId} not in ${contextId}`);
        }
      },
      write: () => ({ requestKey, answer, evidence }),
    });
  }

  /** An expert named in an assistance.requested may answer once without membership. */
  private isInvitedExpert(contextId: string, actorId: string): boolean {
    const rows = this.db.prepare(`SELECT data FROM events WHERE context_id=? AND type='assistance.requested'`).all(contextId) as Array<{ data: string }>;
    return rows.some((r) => {
      try {
        return (JSON.parse(r.data) as { to?: string }).to === actorId;
      } catch {
        return false;
      }
    });
  }

  requestDecision(d: Decision): PiopleEvent {
    return this.mutate({
      type: "decision.requested", contextId: d.contextId, actorId: d.requestedBy, key: `decision:${d.id}`,
      check: () => this.mustMember(d.contextId, d.requestedBy, "write"),
      write: () => {
        this.db.prepare(`INSERT INTO decisions(id,context_id,question,options,requested_by,decided_by,answer,status,created_at,resolved_at) VALUES(?,?,?,?,?,NULL,NULL,'open',?,NULL)`).run(
          d.id, d.contextId, d.question, JSON.stringify(d.options), d.requestedBy, d.createdAt,
        );
        return { decisionId: d.id, question: d.question };
      },
    });
  }

  resolveDecision(contextId: Id, actorId: Id, key: string, decisionId: Id, answer: string): PiopleEvent {
    return this.mutate({
      type: "decision.resolved", contextId, actorId, key,
      check: () => {
        this.mustMember(contextId, actorId, "decide");
        const pres = this.db.prepare(`SELECT echo FROM presence WHERE actor_id=?`).get(actorId) as { echo: number } | undefined;
        if (pres?.echo) throw new Error(`forbidden: echo delegate may never decide`);
      },
      write: () => {
        const info = this.db.prepare(`UPDATE decisions SET status='resolved', decided_by=?, answer=?, resolved_at=? WHERE id=? AND context_id=? AND status='open'`).run(actorId, answer, Date.now(), decisionId, contextId);
        if (info.changes !== 1) throw new Error(`decision-not-open: ${decisionId}`);
        return { decisionId, answer };
      },
    });
  }

  /** Agent proposes a side-effecting action. Never executes: binds to a decision. */
  proposeAction(a: Artifact, action: { verb: string; res: string; ns: string; name?: string; patch?: unknown }, decisionId: Id): PiopleEvent {
    return this.mutate({
      type: "action.proposed", contextId: a.contextId, actorId: a.authorId, key: `proposal:${a.id}`,
      check: () => this.mustMember(a.contextId, a.authorId, "write"),
      write: () => {
        this.db.prepare(`INSERT INTO artifacts(id,context_id,kind,author_id,text,status,evidence,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
          a.id, a.contextId, "proposal", a.authorId, a.text, null, JSON.stringify(a.evidence), a.createdAt,
        );
        return { proposalId: a.id, action, decisionId };
      },
    });
  }

  recordExecution(contextId: Id, actorId: string, key: string, proposalId: Id, decisionId: Id, ok: boolean, output: string): PiopleEvent {
    return this.mutate({
      type: "action.executed", contextId, actorId, key,
      check: () => this.mustMember(contextId, actorId, "write"),
      write: () => ({ proposalId, decisionId, ok, output: output.slice(0, 1000) }),
    });
  }

  getDecision(contextId: Id, decisionId: Id): { status: string; answer: string | null } | undefined {
    return this.db.prepare(`SELECT status, answer FROM decisions WHERE id=? AND context_id=?`).get(decisionId, contextId) as { status: string; answer: string | null } | undefined;
  }

  /**
   * Presence is global per actor and logged in each shared context.
   * With a caller key the call is idempotent: a replayed (older) key never reverts newer state.
   */
  setPresence(actorId: Id, state: "active" | "away" | "silent", echo: boolean, key: string = randomUUID()): PiopleEvent | null {
    return this.tx(() => {
      const seen = this.db.prepare(`SELECT seq, ts, type, context_id, actor_id, key, data FROM events WHERE actor_id=? AND type='presence.changed' AND key=? LIMIT 1`).get(actorId, `presence:${key}`) as Row | undefined;
      if (seen) return this.row(seen);
      this.db.prepare(`INSERT INTO presence(actor_id,state,echo,updated_at) VALUES(?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET state=excluded.state, echo=excluded.echo, updated_at=excluded.updated_at`).run(
        actorId, state, echo ? 1 : 0, Date.now(),
      );
      const ctxs = this.db.prepare(`SELECT context_id FROM members WHERE actor_id=?`).all(actorId) as Array<{ context_id: string }>;
      let last: PiopleEvent | null = null;
      for (const c of ctxs) {
        last = this.mutate({ type: "presence.changed", contextId: c.context_id, actorId, key: `presence:${key}`, write: () => ({ state, echo }) });
      }
      return last;
    });
  }

  promoteObservation(artifactId: Id, by: Id, status: "confirmed" | "refuted"): PiopleEvent {
    const a = this.db.prepare(`SELECT context_id FROM artifacts WHERE id=?`).get(artifactId) as { context_id: string } | undefined;
    if (!a) throw new Error(`unknown-artifact: ${artifactId}`);
    return this.mutate({
      type: "observation.promoted", contextId: a.context_id, actorId: by, key: `promote:${artifactId}:${status}`,
      check: () => this.mustMember(a.context_id, by, "write"),
      write: () => {
        this.db.prepare(`UPDATE artifacts SET status=? WHERE id=?`).run(status, artifactId);
        return { artifactId, status };
      },
    });
  }

  /**
   * Move my read cursor forward (never back, never past the end of the log).
   * Acknowledging is not resolving: pending items are derived from open state, not from the cursor.
   */
  ack(contextId: Id, actorId: Id, seq: number): number {
    this.mustMember(contextId, actorId, "read");
    if (!Number.isInteger(seq) || seq < 0) throw new Error(`bad-seq: ${seq}`);
    return this.tx(() => {
      const end = (this.db.prepare(`SELECT COALESCE(MAX(seq),0) m FROM events WHERE context_id=?`).get(contextId) as { m: number }).m;
      this.db.prepare(`INSERT INTO cursors(context_id,actor_id,acked_seq,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(context_id,actor_id) DO UPDATE SET acked_seq=MAX(acked_seq, excluded.acked_seq), updated_at=excluded.updated_at`).run(contextId, actorId, Math.min(seq, end), Date.now());
      return this.cursor(contextId, actorId);
    });
  }

  cursor(contextId: Id, actorId: Id): number {
    const r = this.db.prepare(`SELECT acked_seq a FROM cursors WHERE context_id=? AND actor_id=?`).get(contextId, actorId) as { a: number } | undefined;
    return r?.a ?? 0;
  }

  /** Everything an actor owes attention in one context, derived from open state. */
  pending(contextId: Id, actorId: Id): Pending {
    const asks = this.db.prepare(`
      SELECT r.key, r.actor_id AS from_actor, r.seq, json_extract(r.data,'$.question') AS question FROM events r
      WHERE r.context_id=? AND r.type='assistance.requested' AND json_extract(r.data,'$.to')=?
        AND NOT EXISTS (SELECT 1 FROM events a WHERE a.context_id=r.context_id AND a.type='assistance.answered' AND json_extract(a.data,'$.requestKey')=r.key)
      ORDER BY r.seq`).all(contextId, actorId) as Array<{ key: string; from_actor: string; seq: number; question: string }>;
    const echo = (this.db.prepare(`SELECT echo FROM presence WHERE actor_id=?`).get(actorId) as { echo: number } | undefined)?.echo;
    const canDecide = !!this.caps(contextId, actorId)?.includes("decide") && !echo;
    const decisions = canDecide
      ? (this.db.prepare(`SELECT id, question, options, requested_by FROM decisions WHERE context_id=? AND status='open' ORDER BY created_at`).all(contextId) as Array<{ id: string; question: string; options: string; requested_by: string }>)
          .map((d) => ({ id: d.id, question: d.question, options: JSON.parse(d.options) as string[], requestedBy: d.requested_by }))
      : [];
    return { assistance: asks.map((a) => ({ key: a.key, from: a.from_actor, question: a.question, seq: a.seq })), decisions };
  }

  /** What happened while I was away, across every context I can read. */
  inbox(actorId: Id): InboxSummary[] {
    const ctxs = this.db.prepare(`SELECT c.id, c.title FROM contexts c JOIN members m ON m.context_id=c.id WHERE m.actor_id=? ORDER BY c.created_at, c.id`).all(actorId) as Array<{ id: string; title: string }>;
    return ctxs.filter((c) => this.caps(c.id, actorId)!.includes("read")).map((c) => {
      const cursor = this.cursor(c.id, actorId);
      const unread = (this.db.prepare(`SELECT COUNT(*) n FROM events WHERE context_id=? AND seq>? AND actor_id<>?`).get(c.id, cursor, actorId) as { n: number }).n;
      const p = this.pending(c.id, actorId);
      return { context: c.id, title: c.title, cursor, unread, pending: p.assistance.length + p.decisions.length };
    });
  }

  /** Events after my cursor (all actors, mine included) plus what is pending for me. */
  inboxOf(contextId: Id, actorId: Id, limit = 200): InboxDetail {
    this.mustMember(contextId, actorId, "read");
    const cursor = this.cursor(contextId, actorId);
    return { context: contextId, cursor, events: this.eventsSince(contextId, cursor, limit), pending: this.pending(contextId, actorId) };
  }

  /** Unchecked read, for internal and test use. Actors go through readEvents. */
  eventsSince(contextId: string, afterSeq: number, limit = 200): PiopleEvent[] {
    const rows = this.db.prepare(`SELECT seq, ts, type, context_id, actor_id, key, data FROM events WHERE context_id=? AND seq>? ORDER BY seq ASC LIMIT ?`).all(contextId, afterSeq, limit) as Row[];
    return rows.map((r) => this.row(r));
  }

  readEvents(contextId: Id, actorId: Id, afterSeq: number, limit = 200): PiopleEvent[] {
    this.mustMember(contextId, actorId, "read");
    return this.eventsSince(contextId, afterSeq, limit);
  }

  isMember(contextId: string, actorId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM members WHERE context_id=? AND actor_id=?`).get(contextId, actorId);
  }

  close() { this.db.close(); }
}
