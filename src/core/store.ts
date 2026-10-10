import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Actor, Artifact, Context, ContextKind, Decision, EventType, Id, Membership, PiopleEvent, WorkItem } from "./types.ts";
import { CONTEXT_KINDS, EVENT_TYPES } from "./types.ts";

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
  // Migration 6: self-declared skills (routing hints) and the work table.
  `
ALTER TABLE actors ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
CREATE TABLE work (
  context_id TEXT NOT NULL REFERENCES contexts(id), id TEXT NOT NULL,
  requested_by TEXT NOT NULL, to_actor TEXT, skill TEXT, input TEXT NOT NULL,
  status TEXT NOT NULL, claimed_by TEXT, attempt INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (context_id, id));
CREATE INDEX work_status ON work(context_id, status);
`,
  // Migration 7: actor credentials. Only a hash is stored; a token names exactly one actor.
  `
CREATE TABLE tokens (
  hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE INDEX tokens_actor ON tokens(actor_id);
`,
  // Migration 8: tokens may expire, and record when they were last used.
  `
ALTER TABLE tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE tokens ADD COLUMN last_used_at INTEGER;
`,
  // Migration 9: realms and channels. A realm is a context; contexts point at their realm and, for cases, a channel.
  `
ALTER TABLE contexts ADD COLUMN realm_id TEXT REFERENCES contexts(id);
ALTER TABLE contexts ADD COLUMN parent_id TEXT REFERENCES contexts(id);
CREATE INDEX contexts_realm ON contexts(realm_id);
`,
];

/** Something an actor may address: a context it can write to, with the capabilities it effectively holds there. */
export type Target = { id: Id; kind: ContextKind; title: string; realm: Id | null; parent: Id | null; capabilities: string[] };

export type InboxSummary = { context: Id; title: string; kind: ContextKind; realm: Id | null; cursor: number; unread: number; pending: number };
export type Pending = {
  /** assistance.requested addressed to me with no assistance.answered for its key */
  assistance: Array<{ key: string; from: Id; question: string; seq: number }>;
  /** open decisions I may resolve (needs decide, and not an echo delegate) */
  decisions: Array<{ id: Id; question: string; options: string[]; requestedBy: Id }>;
  work: {
    /** claimable by me right now: addressed to me or to a skill I declared, open or lease expired */
    open: Array<{ id: Id; from: Id; skill: string | null; to: Id | null; input: unknown }>;
    /** claimed by me and not finished (resume these after a restart) */
    mine: Array<{ id: Id; attempt: number; leaseUntil: number | null; input: unknown }>;
  };
};
export type InboxDetail = { context: Id; cursor: number; events: PiopleEvent[]; pending: Pending };

type WorkRow = {
  context_id: string; id: string; requested_by: string; to_actor: string | null; skill: string | null; input: string;
  status: string; claimed_by: string | null; attempt: number; lease_until: number | null; result: string | null;
  created_at: number; updated_at: number;
};
type Row = { seq: number; ts: number; type: string; context_id: string; actor_id: string; key: string; data: string };
type Mutation = {
  type: EventType;
  contextId: Id;
  actorId: Id;
  /** Idempotency key, unique per context. */
  key: string;
  /** Permission/precondition checks. Runs first, inside the transaction, also on replays. */
  check?: () => void;
  /** Look up the key before checking: a caller replaying its own earlier event gets it back even if state has moved on. */
  replayFirst?: boolean;
  /** Side-table writes; returns the event data. Skipped when the key was already used. */
  write?: () => Record<string, unknown>;
};

/** One read never returns more than this many events; page with the cursor. */
export const MAX_READ = 1000;
const checkLease = (leaseMs: number | undefined) => {
  if (leaseMs !== undefined && !(Number.isInteger(leaseMs) && leaseMs > 0)) throw new Error(`bad-lease: ${leaseMs} (positive whole milliseconds)`);
};
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

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
      const lookup = () => {
        const existing = this.db.prepare(`SELECT seq, ts, type, context_id, actor_id, key, data FROM events WHERE context_id=? AND key=?`).get(m.contextId, m.key) as Row | undefined;
        if (existing && (existing.type !== m.type || existing.actor_id !== m.actorId)) {
          throw new Error(`key-conflict: ${m.key} in ${m.contextId} already used by ${existing.actor_id} for ${existing.type}`);
        }
        return existing;
      };
      if (m.replayFirst) {
        const hit = lookup();
        if (hit) return this.row(hit);
      }
      m.check?.();
      const existing = lookup();
      if (existing) return this.row(existing);
      const data = m.write?.() ?? {};
      const info = this.db.prepare(`INSERT INTO events(ts,type,context_id,actor_id,key,data) VALUES(?,?,?,?,?,?)`).run(Date.now(), m.type, m.contextId, m.actorId, m.key, JSON.stringify(data));
      const row = this.db.prepare(`SELECT seq, ts, type, context_id, actor_id, key, data FROM events WHERE seq=?`).get(info.lastInsertRowid) as Row;
      return this.row(row);
    });
  }

  private row(r: Row): PiopleEvent {
    return { seq: r.seq, ts: r.ts, type: r.type as EventType, contextId: r.context_id, actorId: r.actor_id, key: r.key, data: JSON.parse(r.data) };
  }

  private memberCaps(contextId: string, actorId: string): string[] | undefined {
    const m = this.db.prepare(`SELECT capabilities FROM members WHERE context_id=? AND actor_id=?`).get(contextId, actorId) as { capabilities: string } | undefined;
    return m ? (JSON.parse(m.capabilities) as string[]) : undefined;
  }

  private contextRow(id: Id): { kind: ContextKind; realm_id: Id | null; parent_id: Id | null } | undefined {
    return this.db.prepare(`SELECT kind, realm_id, parent_id FROM contexts WHERE id=?`).get(id) as { kind: ContextKind; realm_id: Id | null; parent_id: Id | null } | undefined;
  }

  /**
   * What an actor effectively holds in a context: its own capabilities there, cut down to what it holds in the
   * context's realm. Checked at every access, not only when joining, so lowering or losing a realm role takes
   * effect everywhere inside the realm at once.
   */
  private caps(contextId: string, actorId: string): string[] | undefined {
    const own = this.memberCaps(contextId, actorId);
    if (!own) return undefined;
    const realm = this.contextRow(contextId)?.realm_id;
    if (!realm) return own;
    const bound = this.memberCaps(realm, actorId);
    return bound ? own.filter((c) => bound.includes(c)) : undefined;
  }

  private mustMember(contextId: string, actorId: string, cap: string): void {
    const caps = this.caps(contextId, actorId);
    if (!caps) throw new Error(`not-a-member: ${actorId} not in ${contextId}`);
    if (!caps.includes(cap)) throw new Error(`forbidden: ${actorId} lacks ${cap} in ${contextId}`);
  }

  upsertActor(a: Actor): void {
    this.db.prepare(`INSERT INTO actors(id,kind,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`).run(a.id, a.kind, a.name);
  }

  /** Where a new context sits, validated. A case under a channel lives in that channel's realm. */
  private placement(c: Context, by: Id): { realm: Id | null; parent: Id | null } {
    if (!CONTEXT_KINDS.includes(c.kind)) throw new Error(`bad-kind: ${c.kind} (case, channel or realm)`);
    let realm = c.realmId ?? null;
    const parent = c.parentId ?? null;
    if (c.kind === "realm" && (realm || parent)) throw new Error(`bad-context: a realm has no realm or parent`);
    if (c.kind === "channel" && (!realm || parent)) throw new Error(`bad-context: a channel needs a realm and has no parent`);
    if (parent) {
      const p = this.contextRow(parent);
      if (!p || p.kind !== "channel") throw new Error(`bad-context: parent ${parent} is not a channel`);
      if (realm && p.realm_id !== realm) throw new Error(`bad-context: channel ${parent} is in another realm`);
      realm = p.realm_id;
      this.mustMember(parent, by, "write");
    }
    if (realm) {
      if (this.contextRow(realm)?.kind !== "realm") throw new Error(`bad-context: ${realm} is not a realm`);
      this.mustMember(realm, by, "write");
    }
    return { realm, parent };
  }

  createContext(c: Context, by: Id): PiopleEvent {
    let where = { realm: null as Id | null, parent: null as Id | null };
    return this.mutate({
      type: "context.created", contextId: c.id, actorId: by, key: `create:${c.id}`,
      check: () => { where = this.placement(c, by); },
      write: () => {
        this.db.prepare(`INSERT INTO actors(id,kind,name) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`).run(by, by.startsWith("human:") ? "human" : "agent", by);
        this.db.prepare(`INSERT INTO contexts(id,kind,title,goal,created_at,realm_id,parent_id) VALUES(?,?,?,?,?,?,?)`).run(c.id, c.kind, c.title, c.goal, c.createdAt, where.realm, where.parent);
        // The creator starts with everything it may hold in the realm (all three when standalone).
        const bound = where.realm ? this.memberCaps(where.realm, by)! : ["read", "write", "decide"];
        const caps = ["read", "write", "decide"].filter((x) => bound.includes(x));
        this.db.prepare(`INSERT INTO members(context_id,actor_id,capabilities,joined_at) VALUES(?,?,?,?)`).run(c.id, by, JSON.stringify(caps), c.createdAt);
        return { title: c.title, kind: c.kind, realm: where.realm, parent: where.parent };
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
        const realm = this.contextRow(m.contextId)?.realm_id;
        if (realm) {
          const bound = this.memberCaps(realm, m.actorId);
          if (!bound) throw new Error(`not-in-realm: ${m.actorId} must be a member of ${realm} before joining ${m.contextId}`);
          const beyond = m.capabilities.filter((c) => !bound.includes(c));
          if (beyond.length) throw new Error(`forbidden: ${m.actorId} holds only ${bound.join(",") || "nothing"} in ${realm}, cannot be granted ${beyond.join(",")}`);
        }
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

  /** Skills are self-declared routing hints. They never grant anything. */
  setSkills(actorId: Id, skills: string[]): void {
    const info = this.db.prepare(`UPDATE actors SET skills=? WHERE id=?`).run(JSON.stringify([...new Set(skills)].sort()), actorId);
    if (info.changes !== 1) throw new Error(`unknown-actor: ${actorId}`);
  }

  private skillsOf(actorId: Id): string[] {
    const r = this.db.prepare(`SELECT skills FROM actors WHERE id=?`).get(actorId) as { skills: string } | undefined;
    return r ? (JSON.parse(r.skills) as string[]) : [];
  }

  private workItem(r: WorkRow): WorkItem {
    return {
      id: r.id, contextId: r.context_id, requestedBy: r.requested_by, to: r.to_actor, skill: r.skill, input: JSON.parse(r.input),
      status: r.status as WorkItem["status"], claimedBy: r.claimed_by, attempt: r.attempt, leaseUntil: r.lease_until,
      result: r.result === null ? null : JSON.parse(r.result), createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  getWork(contextId: Id, workId: Id): WorkItem | undefined {
    const r = this.db.prepare(`SELECT * FROM work WHERE context_id=? AND id=?`).get(contextId, workId) as WorkRow | undefined;
    return r ? this.workItem(r) : undefined;
  }

  /** Work nobody currently holds: open, or claimed with an expired lease. Oldest first. */
  private claimableWork(contextId: Id, now: number): WorkItem[] {
    return (this.db.prepare(`SELECT * FROM work WHERE context_id=? AND (status='open' OR (status='claimed' AND lease_until IS NOT NULL AND lease_until<?)) ORDER BY rowid`).all(contextId, now) as WorkRow[]).map((r) => this.workItem(r));
  }

  /** Why this actor may not take this work right now, or null. */
  private cannotClaim(w: WorkItem, actorId: Id, now: number): string | null {
    if (w.to !== null && w.to !== actorId) return `directed to ${w.to}`;
    if (w.skill !== null && !this.skillsOf(actorId).includes(w.skill)) return `needs skill ${w.skill}`;
    if (w.status === "open") return null;
    if (w.status === "claimed" && w.leaseUntil !== null && w.leaseUntil < now) return null;
    return `already ${w.status}${w.claimedBy ? ` by ${w.claimedBy}` : ""}`;
  }

  requestWork(contextId: Id, actorId: Id, w: { id: Id; to?: Id | null; skill?: string | null; input: unknown }): PiopleEvent {
    return this.mutate({
      type: "work.requested", contextId, actorId, key: `work:${w.id}`,
      check: () => {
        this.mustMember(contextId, actorId, "write");
        if (!w.to && !w.skill) throw new Error(`work-needs-target: give --to or --skill`);
      },
      write: () => {
        const now = Date.now();
        this.db.prepare(`INSERT INTO work(context_id,id,requested_by,to_actor,skill,input,status,attempt,created_at,updated_at) VALUES(?,?,?,?,?,?,'open',0,?,?)`).run(
          contextId, w.id, actorId, w.to ?? null, w.skill ?? null, JSON.stringify(w.input ?? null), now, now,
        );
        return { workId: w.id, to: w.to ?? null, skill: w.skill ?? null, input: w.input ?? null };
      },
    });
  }

  /**
   * Atomic claim. One holder at a time; a reclaim after lease expiry bumps `attempt`.
   * The same holder claiming again while its claim is live gets that claim back (restart-safe).
   * Core guarantees one holder and one accepted completion per attempt; it cannot undo side effects
   * outside, so executors should pass `work:<id>:<attempt>` on as their own idempotency key.
   */
  claimWork(contextId: Id, actorId: Id, workId: Id, leaseMs?: number, now = Date.now()): { event: PiopleEvent; work: WorkItem } {
    checkLease(leaseMs);
    return this.tx(() => {
      this.mustMember(contextId, actorId, "write");
      const w = this.getWork(contextId, workId);
      if (!w) throw new Error(`unknown-work: ${workId}`);
      if (w.status === "claimed" && w.claimedBy === actorId && (w.leaseUntil === null || w.leaseUntil >= now)) {
        return { event: this.mutate({ type: "work.claimed", contextId, actorId, key: `claim:${workId}:${w.attempt}` }), work: w };
      }
      const why = this.cannotClaim(w, actorId, now);
      if (why) throw new Error(`work-not-claimable: ${workId} (${why})`);
      return this.doClaim(w, actorId, leaseMs, now);
    });
  }

  /** Claim the oldest work I may take, or null. */
  claimNext(contextId: Id, actorId: Id, leaseMs?: number, now = Date.now()): { event: PiopleEvent; work: WorkItem } | null {
    checkLease(leaseMs);
    return this.tx(() => {
      this.mustMember(contextId, actorId, "write");
      const w = this.claimableWork(contextId, now).find((x) => this.cannotClaim(x, actorId, now) === null);
      return w ? this.doClaim(w, actorId, leaseMs, now) : null;
    });
  }

  private doClaim(w: WorkItem, actorId: Id, leaseMs: number | undefined, now: number): { event: PiopleEvent; work: WorkItem } {
    const attempt = w.attempt + 1;
    const leaseUntil = leaseMs === undefined ? null : now + leaseMs;
    const event = this.mutate({
      type: "work.claimed", contextId: w.contextId, actorId, key: `claim:${w.id}:${attempt}`,
      write: () => {
        const info = this.db.prepare(`UPDATE work SET status='claimed', claimed_by=?, attempt=?, lease_until=?, updated_at=?
          WHERE context_id=? AND id=? AND attempt=? AND (status='open' OR (status='claimed' AND lease_until IS NOT NULL AND lease_until<?))`).run(
          actorId, attempt, leaseUntil, now, w.contextId, w.id, w.attempt, now,
        );
        if (info.changes !== 1) throw new Error(`work-not-claimable: ${w.id} (lost race)`);
        return { workId: w.id, attempt, leaseUntil };
      },
    });
    return { event, work: this.getWork(w.contextId, w.id)! };
  }

  /** Only the current holder of the current attempt may finish. A late finisher from an older attempt is refused. */
  completeWork(contextId: Id, actorId: Id, workId: Id, attempt: number, result: unknown): PiopleEvent {
    return this.mutate({
      type: "work.completed", contextId, actorId, key: `complete:${workId}:${attempt}`, replayFirst: true,
      check: () => this.mustHold(contextId, actorId, workId, attempt),
      write: () => {
        const info = this.db.prepare(`UPDATE work SET status='done', result=?, lease_until=NULL, updated_at=? WHERE context_id=? AND id=? AND status='claimed' AND claimed_by=? AND attempt=?`).run(
          JSON.stringify(result ?? null), Date.now(), contextId, workId, actorId, attempt,
        );
        if (info.changes !== 1) throw new Error(`stale-claim: ${actorId} no longer holds ${workId} attempt ${attempt}`);
        return { workId, attempt, result: result ?? null };
      },
    });
  }

  /** retry=true reopens the work for anyone eligible; otherwise it ends as failed. */
  failWork(contextId: Id, actorId: Id, workId: Id, attempt: number, reason: string, retry = false): PiopleEvent {
    return this.mutate({
      type: "work.failed", contextId, actorId, key: `fail:${workId}:${attempt}`, replayFirst: true,
      check: () => this.mustHold(contextId, actorId, workId, attempt),
      write: () => {
        const info = this.db.prepare(`UPDATE work SET status=?, claimed_by=${retry ? "NULL" : "claimed_by"}, lease_until=NULL, updated_at=? WHERE context_id=? AND id=? AND status='claimed' AND claimed_by=? AND attempt=?`).run(
          retry ? "open" : "failed", Date.now(), contextId, workId, actorId, attempt,
        );
        if (info.changes !== 1) throw new Error(`stale-claim: ${actorId} no longer holds ${workId} attempt ${attempt}`);
        return { workId, attempt, reason, retry };
      },
    });
  }

  private mustHold(contextId: Id, actorId: Id, workId: Id, attempt: number): void {
    this.mustMember(contextId, actorId, "write");
    const w = this.getWork(contextId, workId);
    if (!w) throw new Error(`unknown-work: ${workId}`);
    if (w.claimedBy !== actorId || w.attempt !== attempt || w.status !== "claimed") {
      throw new Error(`stale-claim: ${actorId} does not hold ${workId} attempt ${attempt} (now ${w.status}, attempt ${w.attempt}, held by ${w.claimedBy ?? "nobody"})`);
    }
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
    const now = Date.now();
    const canWork = !!this.caps(contextId, actorId)?.includes("write");
    const open = canWork
      ? this.claimableWork(contextId, now).filter((w) => this.cannotClaim(w, actorId, now) === null)
          .map((w) => ({ id: w.id, from: w.requestedBy, skill: w.skill, to: w.to, input: w.input }))
      : [];
    const mine = (this.db.prepare(`SELECT * FROM work WHERE context_id=? AND status='claimed' AND claimed_by=? ORDER BY rowid`).all(contextId, actorId) as WorkRow[])
      .map((r) => this.workItem(r)).map((w) => ({ id: w.id, attempt: w.attempt, leaseUntil: w.leaseUntil, input: w.input }));
    return { assistance: asks.map((a) => ({ key: a.key, from: a.from_actor, question: a.question, seq: a.seq })), decisions, work: { open, mine } };
  }

  /** What happened while I was away, across every context I can read. */
  inbox(actorId: Id): InboxSummary[] {
    const ctxs = this.db.prepare(`SELECT c.id, c.title, c.kind, c.realm_id FROM contexts c JOIN members m ON m.context_id=c.id WHERE m.actor_id=? ORDER BY c.created_at, c.rowid`).all(actorId) as Array<{ id: string; title: string; kind: ContextKind; realm_id: Id | null }>;
    return ctxs.filter((c) => this.caps(c.id, actorId)?.includes("read")).map((c) => {
      const cursor = this.cursor(c.id, actorId);
      const unread = (this.db.prepare(`SELECT COUNT(*) n FROM events WHERE context_id=? AND seq>? AND actor_id<>?`).get(c.id, cursor, actorId) as { n: number }).n;
      const p = this.pending(c.id, actorId);
      return { context: c.id, title: c.title, kind: c.kind, realm: c.realm_id, cursor, unread, pending: p.assistance.length + p.decisions.length + p.work.open.length + p.work.mine.length };
    });
  }

  /** Everything this actor may address: contexts (realms, channels, cases) it can write to, with what it effectively holds there. */
  targets(actorId: Id): Target[] {
    const rows = this.db.prepare(`SELECT c.id, c.kind, c.title, c.realm_id, c.parent_id FROM contexts c JOIN members m ON m.context_id=c.id WHERE m.actor_id=? ORDER BY c.created_at, c.rowid`).all(actorId) as Array<{ id: string; kind: ContextKind; title: string; realm_id: Id | null; parent_id: Id | null }>;
    const out: Target[] = [];
    for (const r of rows) {
      const caps = this.caps(r.id, actorId);
      if (caps?.includes("write")) out.push({ id: r.id, kind: r.kind, title: r.title, realm: r.realm_id, parent: r.parent_id, capabilities: caps });
    }
    return out;
  }

  /** Events after my cursor (all actors, mine included) plus what is pending for me. */
  inboxOf(contextId: Id, actorId: Id, limit = 200): InboxDetail {
    this.mustMember(contextId, actorId, "read");
    const cursor = this.cursor(contextId, actorId);
    return { context: contextId, cursor, events: this.eventsSince(contextId, cursor, limit), pending: this.pending(contextId, actorId) };
  }

  /**
   * Operator-side: mint a credential for one actor (registering the actor if new). The token is
   * returned once and never stored; verification is by hash. A network host that serves several
   * actors holds one token per actor, so it can speak only as the actors it was given.
   */
  issueToken(actorId: Id, ttlMs?: number, now = Date.now()): string {
    if (!/^(human|agent):\S+$/.test(actorId)) throw new Error(`bad-actor: ${actorId} (expected human:<name> or agent:<name>)`);
    if (ttlMs !== undefined && !(Number.isInteger(ttlMs) && ttlMs > 0)) throw new Error(`bad-ttl: ${ttlMs} (positive whole milliseconds)`);
    const token = `pio_${randomBytes(32).toString("base64url")}`;
    this.tx(() => {
      this.db.prepare(`INSERT INTO actors(id,kind,name) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING`).run(actorId, actorId.startsWith("human:") ? "human" : "agent", actorId);
      this.db.prepare(`INSERT INTO tokens(hash,actor_id,created_at,expires_at) VALUES(?,?,?,?)`).run(hashToken(token), actorId, now, ttlMs === undefined ? null : now + ttlMs);
    });
    return token;
  }

  /** The actor a live (not revoked, not expired) token belongs to, or undefined. Notes use at most once a minute. */
  actorForToken(token: string, now = Date.now()): Id | undefined {
    const hash = hashToken(token);
    const r = this.db.prepare(`SELECT actor_id, last_used_at FROM tokens WHERE hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`).get(hash, now) as { actor_id: string; last_used_at: number | null } | undefined;
    if (!r) return undefined;
    if (r.last_used_at === null || now - r.last_used_at >= 60_000) {
      try {
        this.db.prepare(`UPDATE tokens SET last_used_at=? WHERE hash=?`).run(now, hash);
      } catch {
        // Last-use is bookkeeping: a busy or read-only database must not turn a valid token into a thrown error.
      }
    }
    return r.actor_id;
  }

  /** Operator view of an actor's credentials. Never includes the secret. */
  listTokens(actorId: Id): Array<{ createdAt: number; expiresAt: number | null; lastUsedAt: number | null; revokedAt: number | null }> {
    return (this.db.prepare(`SELECT created_at, expires_at, last_used_at, revoked_at FROM tokens WHERE actor_id=? ORDER BY created_at, rowid`).all(actorId) as Array<{ created_at: number; expires_at: number | null; last_used_at: number | null; revoked_at: number | null }>)
      .map((t) => ({ createdAt: t.created_at, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at }));
  }

  /** Revoke every live (not revoked, not expired) token of an actor. Returns how many. */
  revokeTokens(actorId: Id, now = Date.now()): number {
    return Number(this.db.prepare(`UPDATE tokens SET revoked_at=? WHERE actor_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`).run(now, actorId, now).changes);
  }

  /** Unchecked read, for internal and test use. Actors go through readEvents. */
  eventsSince(contextId: string, afterSeq: number, limit = 200): PiopleEvent[] {
    limit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_READ) : 200;
    const rows = this.db.prepare(`SELECT seq, ts, type, context_id, actor_id, key, data FROM events WHERE context_id=? AND seq>? ORDER BY seq ASC LIMIT ?`).all(contextId, afterSeq, limit) as Row[];
    return rows.map((r) => this.row(r));
  }

  readEvents(contextId: Id, actorId: Id, afterSeq: number, limit = 200): PiopleEvent[] {
    this.mustMember(contextId, actorId, "read");
    return this.eventsSince(contextId, afterSeq, limit);
  }

  isMember(contextId: string, actorId: string): boolean {
    return this.caps(contextId, actorId) !== undefined;
  }

  close() { this.db.close(); }
}
