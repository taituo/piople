import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
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
  // Migration 2: run ledger. One row per runner invocation; outcome is free text.
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
];

type EventRow = { seq: number; ts: number; type: string; context_id: string; actor_id: string; key: string; data: string };

export const CAPABILITIES = ["read", "write", "decide"] as const;
const OBSERVATION_STATUSES = ["hypothesis", "confirmed", "refuted"];
const PRESENCE_STATES = ["active", "away", "silent"];

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);
    this.migrate();
  }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
    const row = this.db.prepare(`SELECT v FROM meta WHERE k='version'`).get() as { v: string } | undefined;
    const version = row ? Number(row.v) : 0;
    for (let i = version; i < MIGRATIONS.length; i++) {
      // Schema change and version bump commit together, so a crash never half-migrates.
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[i]!);
        this.db.prepare(`INSERT INTO meta(k,v) VALUES('version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(String(i + 1));
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  private txDepth = 0;

  /** Run `fn` atomically: state change and its event commit together or not at all. Nests via savepoints. */
  private tx<T>(fn: () => T): T {
    const sp = `sp${this.txDepth}`;
    this.db.exec(this.txDepth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const r = fn();
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? "COMMIT" : `RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  /** Idempotency: the original event for (context, key), if this mutation already happened. */
  findEvent(contextId: string, key: string): PiopleEvent | undefined {
    const r = this.db.prepare(`SELECT seq, ts, type, context_id, actor_id, key, data FROM events WHERE context_id=? AND key=?`).get(contextId, key) as EventRow | undefined;
    return r && this.row(r);
  }

  private capabilitiesOf(contextId: string, actorId: string): string[] {
    const m = this.db.prepare(`SELECT capabilities FROM members WHERE context_id=? AND actor_id=?`).get(contextId, actorId) as { capabilities: string } | undefined;
    return m ? (JSON.parse(m.capabilities) as string[]) : [];
  }

  private mustMember(contextId: string, actorId: string, cap: string): void {
    if (!this.isMember(contextId, actorId)) throw new Error(`not-a-member: ${actorId} not in ${contextId}`);
    if (!this.capabilitiesOf(contextId, actorId).includes(cap)) throw new Error(`forbidden: ${actorId} lacks ${cap} in ${contextId}`);
  }

  upsertActor(a: Actor): void {
    this.db.prepare(`INSERT INTO actors(id,kind,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`).run(a.id, a.kind, a.name);
  }

  createContext(c: Context, by: Id): PiopleEvent {
    return this.tx(() => {
      this.db.prepare(`INSERT INTO contexts(id,kind,title,goal,created_at) VALUES(?,?,?,?,?)`).run(c.id, c.kind, c.title, c.goal, c.createdAt);
      this.db.prepare(`INSERT INTO members(context_id,actor_id,capabilities,joined_at) VALUES(?,?,?,?) ON CONFLICT(context_id,actor_id) DO NOTHING`).run(
        c.id, by, JSON.stringify(["read", "write", "decide"]), c.createdAt,
      );
      return this.append({ type: "context.created", contextId: c.id, actorId: by, key: `create:${c.id}`, data: { title: c.title } });
    });
  }

  /**
   * Add or update a member. Trusted callers (setup scripts) omit `grantedBy`.
   * Boundary callers pass it: the granter must be a member and may only hand out
   * capabilities it holds itself, so joining can never escalate privileges.
   */
  join(m: Membership, key: string, grantedBy?: Id): PiopleEvent {
    return this.tx(() => {
      const bad = m.capabilities.filter((c) => !(CAPABILITIES as readonly string[]).includes(c));
      if (bad.length) throw new Error(`bad-request: unknown capability ${bad.join(",")}`);
      if (grantedBy !== undefined) {
        this.mustMember(m.contextId, grantedBy, "write");
        const held = this.capabilitiesOf(m.contextId, grantedBy);
        const over = m.capabilities.filter((c) => !held.includes(c));
        if (over.length) throw new Error(`forbidden: ${grantedBy} cannot grant ${over.join(",")} in ${m.contextId}`);
      }
      this.db.prepare(`INSERT INTO members(context_id,actor_id,capabilities,joined_at) VALUES(?,?,?,?) ON CONFLICT(context_id,actor_id) DO UPDATE SET capabilities=excluded.capabilities`).run(
        m.contextId, m.actorId, JSON.stringify(m.capabilities), m.joinedAt,
      );
      return this.append({ type: "member.joined", contextId: m.contextId, actorId: m.actorId, key, data: { capabilities: m.capabilities } });
    });
  }

  postMessage(contextId: Id, actorId: Id, key: string, text: string): PiopleEvent {
    this.mustMember(contextId, actorId, "write");
    return this.append({ type: "message.posted", contextId, actorId, key, data: { text } });
  }

  recordObservation(a: Artifact): PiopleEvent {
    return this.tx(() => {
      this.mustMember(a.contextId, a.authorId, "write");
      if (a.status !== null && !OBSERVATION_STATUSES.includes(a.status)) throw new Error(`bad-request: unknown status ${a.status}`);
      const prior = this.findEvent(a.contextId, `artifact:${a.id}`);
      if (prior) return prior;
      this.db.prepare(`INSERT INTO artifacts(id,context_id,kind,author_id,text,status,evidence,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
        a.id, a.contextId, a.kind, a.authorId, a.text, a.status, JSON.stringify(a.evidence), a.createdAt,
      );
      return this.append({ type: "observation.recorded", contextId: a.contextId, actorId: a.authorId, key: `artifact:${a.id}`, data: { artifactId: a.id, kind: a.kind, status: a.status, text: a.text.slice(0, 2000), evidence: a.evidence } });
    });
  }

  requestAssistance(contextId: Id, actorId: Id, key: string, to: Id, question: string, snapshot: Record<string, unknown>): PiopleEvent {
    this.mustMember(contextId, actorId, "write");
    return this.append({ type: "assistance.requested", contextId, actorId, key, data: { to, question, snapshot } });
  }

  /**
   * Answers must reference a real open `assistance.requested` in this context.
   * Members may answer any request; an invited expert (the request's `to`) only that one,
   * and only once: the invitation is consumed by the answer.
   */
  answerAssistance(contextId: Id, actorId: Id, key: string, requestKey: string, answer: string, evidence: string[]): PiopleEvent {
    return this.tx(() => {
      const request = this.findEvent(contextId, requestKey);
      if (request?.type !== "assistance.requested") throw new Error(`unknown-request: ${requestKey} in ${contextId}`);
      if (!this.isMember(contextId, actorId)) {
        if ((request.data as { to?: string }).to !== actorId) throw new Error(`not-a-member: ${actorId} not in ${contextId}`);
        const prior = this.findEvent(contextId, key);
        if (!prior && this.hasAnswered(contextId, actorId, requestKey)) throw new Error(`forbidden: invitation ${requestKey} already used by ${actorId}`);
      }
      return this.append({ type: "assistance.answered", contextId, actorId, key, data: { requestKey, answer, evidence } });
    });
  }

  private hasAnswered(contextId: string, actorId: string, requestKey: string): boolean {
    const rows = this.db.prepare(`SELECT data FROM events WHERE context_id=? AND type='assistance.answered' AND actor_id=?`).all(contextId, actorId) as Array<{ data: string }>;
    return rows.some((r) => (JSON.parse(r.data) as { requestKey?: string }).requestKey === requestKey);
  }

  requestDecision(d: Decision): PiopleEvent {
    return this.tx(() => {
      this.mustMember(d.contextId, d.requestedBy, "write");
      const prior = this.findEvent(d.contextId, `decision:${d.id}`);
      if (prior) return prior;
      this.db.prepare(`INSERT INTO decisions(id,context_id,question,options,requested_by,decided_by,answer,status,created_at,resolved_at) VALUES(?,?,?,?,?,NULL,NULL,'open',?,NULL)`).run(
        d.id, d.contextId, d.question, JSON.stringify(d.options), d.requestedBy, d.createdAt,
      );
      return this.append({ type: "decision.requested", contextId: d.contextId, actorId: d.requestedBy, key: `decision:${d.id}`, data: { decisionId: d.id, question: d.question } });
    });
  }

  /** Agent proposes a side-effecting action. Never executes: binds to a decision. */
  proposeAction(a: Artifact, action: { verb: string; res: string; ns: string; name?: string; patch?: unknown }, decisionId: Id): PiopleEvent {
    return this.tx(() => {
      this.mustMember(a.contextId, a.authorId, "write");
      const prior = this.findEvent(a.contextId, `proposal:${a.id}`);
      if (prior) return prior;
      this.db.prepare(`INSERT INTO artifacts(id,context_id,kind,author_id,text,status,evidence,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
        a.id, a.contextId, "proposal", a.authorId, a.text, null, JSON.stringify(a.evidence), a.createdAt,
      );
      return this.append({ type: "action.proposed", contextId: a.contextId, actorId: a.authorId, key: `proposal:${a.id}`, data: { proposalId: a.id, action, decisionId } });
    });
  }

  recordExecution(contextId: Id, actorId: string, key: string, proposalId: Id, decisionId: Id, ok: boolean, output: string): PiopleEvent {
    return this.append({ type: "action.executed", contextId, actorId, key, data: { proposalId, decisionId, ok, output: output.slice(0, 1000) } });
  }

  getDecision(contextId: Id, decisionId: Id): { status: string; answer: string | null } | undefined {
    return this.db.prepare(`SELECT status, answer FROM decisions WHERE id=? AND context_id=?`).get(decisionId, contextId) as { status: string; answer: string | null } | undefined;
  }

  startRun(id: string, caseId: string, model: string, rounds: number): void {
    this.db.prepare(`INSERT INTO runs(id,case_id,model,started_at,rounds) VALUES(?,?,?,?,?)`).run(id, caseId, model, Date.now(), rounds);
  }

  finishRun(id: string, r: { tokensIn: number; tokensOut: number; toolCalls: number; proposals: number; outcome: string }): void {
    const info = this.db.prepare(`UPDATE runs SET finished_at=?,tokens_in=?,tokens_out=?,tool_calls=?,proposals=?,outcome=? WHERE id=?`).run(
      Date.now(), r.tokensIn, r.tokensOut, r.toolCalls, r.proposals, r.outcome, id,
    );
    if (info.changes !== 1) throw new Error(`run-not-found: ${id}`);
  }

  listRuns(caseId?: string): Array<Record<string, unknown>> {
    const rows = caseId
      ? this.db.prepare(`SELECT * FROM runs WHERE case_id=? ORDER BY started_at`).all(caseId)
      : this.db.prepare(`SELECT * FROM runs ORDER BY started_at`).all();
    return rows as Array<Record<string, unknown>>;
  }

  resolveDecision(contextId: Id, actorId: Id, key: string, decisionId: Id, answer: string): PiopleEvent {
    return this.tx(() => {
      this.mustMember(contextId, actorId, "decide");
      const prior = this.findEvent(contextId, key);
      if (prior) return prior;
      const pres = this.db.prepare(`SELECT echo FROM presence WHERE actor_id=?`).get(actorId) as { echo: number } | undefined;
      if (pres?.echo) throw new Error(`forbidden: echo delegate may never decide`);
      const info = this.db.prepare(`UPDATE decisions SET status='resolved', decided_by=?, answer=?, resolved_at=? WHERE id=? AND context_id=? AND status='open'`).run(actorId, answer, Date.now(), decisionId, contextId);
      if (info.changes !== 1) throw new Error(`decision-not-open: ${decisionId}`);
      return this.append({ type: "decision.resolved", contextId, actorId, key, data: { decisionId, answer } });
    });
  }

  setPresence(actorId: Id, state: "active" | "away" | "silent", echo: boolean): PiopleEvent | null {
    return this.tx(() => {
      if (!PRESENCE_STATES.includes(state)) throw new Error(`bad-request: unknown presence state ${state}`);
      this.db.prepare(`INSERT INTO presence(actor_id,state,echo,updated_at) VALUES(?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET state=excluded.state, echo=excluded.echo, updated_at=excluded.updated_at`).run(
        actorId, state, echo ? 1 : 0, Date.now(),
      );
      // Presence is global; log it in every shared context of the actor so members see it.
      const ctxs = this.db.prepare(`SELECT context_id FROM members WHERE actor_id=?`).all(actorId) as Array<{ context_id: string }>;
      let last: PiopleEvent | null = null;
      for (const c of ctxs) {
        last = this.append({ type: "presence.changed", contextId: c.context_id, actorId, key: `presence:${actorId}:${randomUUID()}`, data: { state, echo } });
      }
      return last;
    });
  }

  promoteObservation(artifactId: Id, by: Id, status: "confirmed" | "refuted"): PiopleEvent {
    return this.tx(() => {
      const a = this.db.prepare(`SELECT context_id, author_id FROM artifacts WHERE id=?`).get(artifactId) as { context_id: string; author_id: string } | undefined;
      if (!a) throw new Error(`unknown-artifact: ${artifactId}`);
      this.mustMember(a.context_id, by, "write");
      if (status !== "confirmed" && status !== "refuted") throw new Error(`bad-request: cannot promote to ${status}`);
      this.db.prepare(`UPDATE artifacts SET status=? WHERE id=?`).run(status, artifactId);
      return this.append({ type: "observation.promoted", contextId: a.context_id, actorId: by, key: `promote:${artifactId}:${status}`, data: { artifactId, status } });
    });
  }

  append(e: { type: EventType; contextId: string; actorId: string; key: string; data: Record<string, unknown> }): PiopleEvent {
    if (!EVENT_TYPES.includes(e.type)) throw new Error(`unknown-event: ${e.type}`);
    const existing = this.findEvent(e.contextId, e.key);
    if (existing) return existing;
    const info = this.db.prepare(`INSERT INTO events(ts,type,context_id,actor_id,key,data) VALUES(?,?,?,?,?,?)`).run(Date.now(), e.type, e.contextId, e.actorId, e.key, JSON.stringify(e.data));
    const row = this.db.prepare(`SELECT seq, ts, type, context_id, actor_id, key, data FROM events WHERE seq=?`).get(info.lastInsertRowid) as EventRow;
    return this.row(row);
  }

  private row(r: EventRow): PiopleEvent {
    return { seq: r.seq, ts: r.ts, type: r.type as EventType, contextId: r.context_id, actorId: r.actor_id, key: r.key, data: JSON.parse(r.data) };
  }

  eventsSince(contextId: string, afterSeq: number, limit = 200): PiopleEvent[] {
    const rows = this.db.prepare(`SELECT seq, ts, type, context_id, actor_id, key, data FROM events WHERE context_id=? AND seq>? ORDER BY seq ASC LIMIT ?`).all(contextId, afterSeq, limit) as EventRow[];
    return rows.map((r) => this.row(r));
  }

  isMember(contextId: string, actorId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM members WHERE context_id=? AND actor_id=?`).get(contextId, actorId);
  }

  close() { this.db.close(); }
}
