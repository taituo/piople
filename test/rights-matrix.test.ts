import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { ACTOR, ROLES, world, serve, outcomeOfError, outcomeOfStatus, type Outcome, type Role } from "./support/roles.ts";

/**
 * Who may do what, as a table: every kind of participant x every operation. The same table runs against the
 * Store (the API is not the only way in) and against the HTTP app, so both doors must agree. Shape from Entropi's
 * rights matrix.
 */
type Row = {
  name: string;
  /** Per-role expectation; a missing role defaults to `others`. */
  want: Partial<Record<Role, Outcome>> & { others: Outcome };
  store: (s: Store, actor: string, n: number) => unknown;
  http: (call: (actor: string, method: string, path: string, body?: unknown) => Promise<{ status: number }>, actor: string, n: number) => Promise<{ status: number }>;
  /** Prepare state before the attempt (e.g. someone already decided). */
  prep?: (s: Store) => void;
};
const ok = (...roles: Role[]): Partial<Record<Role, Outcome>> => Object.fromEntries(roles.map((r) => [r, "ok" as const]));
const WRITERS: Role[] = ["owner", "decider", "writer", "away", "echo", "bot"];

const rows: Row[] = [
  {
    name: "post a message", want: { ...ok(...WRITERS), others: "forbidden" },
    store: (s, a, n) => s.postMessage("c1", a, `m${n}`, "hi"),
    http: (c, a) => c(a, "POST", "/api/v1/messages", { context: "c1", text: "hi" }),
  },
  {
    name: "record a finding", want: { ...ok(...WRITERS), others: "forbidden" },
    store: (s, a, n) => s.recordObservation({ id: `o${n}`, contextId: "c1", kind: "finding", authorId: a, text: "t", status: "hypothesis", evidence: ["e"], createdAt: 1 }),
    http: (c, a) => c(a, "POST", "/api/v1/observations", { context: "c1", text: "t", evidence: ["e"] }),
  },
  {
    name: "promote a finding", want: { ...ok(...WRITERS), others: "forbidden" },
    store: (s, a) => s.promoteObservation("o1", a, "confirmed"),
    http: (c, a) => c(a, "POST", "/api/v1/promote", { artifactId: "o1" }),
  },
  {
    name: "ask for a decision", want: { ...ok(...WRITERS), others: "forbidden" },
    store: (s, a, n) => s.requestDecision({ id: `dq${n}`, contextId: "c1", question: "q?", options: ["yes", "no"], requestedBy: a, decidedBy: null, answer: null, status: "open", createdAt: 1, resolvedAt: null }),
    http: (c, a) => c(a, "POST", "/api/v1/decisions", { context: "c1", question: "q?" }),
  },
  {
    // only a present human with decide, who did not ask: the owner and decider
    name: "decide d1", want: { ...ok("owner", "decider"), others: "forbidden" },
    store: (s, a, n) => s.resolveDecision("c1", a, `r${n}`, "d1", "yes"),
    http: (c, a) => c(a, "POST", "/api/v1/decisions", { context: "c1", decisionId: "d1", answer: "yes" }),
  },
  {
    name: "decide d1 with an answer that is not an option", want: { ...ok(), owner: "bad", decider: "bad", others: "forbidden" },
    store: (s, a, n) => s.resolveDecision("c1", a, `r${n}`, "d1", "maybe"),
    http: (c, a) => c(a, "POST", "/api/v1/decisions", { context: "c1", decisionId: "d1", answer: "maybe" }),
  },
  {
    // those holding the decide capability learn it is over before anything about themselves (finished beats rights)
    name: "decide d1 after someone else already did (first decision wins)", want: { owner: "conflict", decider: "conflict", away: "conflict", echo: "conflict", bot: "conflict", others: "forbidden" },
    prep: (s) => { s.resolveDecision("c1", ACTOR.owner, "first", "d1", "no"); },
    store: (s, a, n) => s.resolveDecision("c1", a, `r${n}`, "d1", "yes"),
    http: (c, a) => c(a, "POST", "/api/v1/decisions", { context: "c1", decisionId: "d1", answer: "yes" }),
  },
  {
    name: "decide a decision that does not exist", want: { owner: "not-found", decider: "not-found", away: "not-found", echo: "not-found", bot: "not-found", others: "forbidden" },
    store: (s, a, n) => s.resolveDecision("c1", a, `r${n}`, "nope", "yes"),
    http: (c, a) => c(a, "POST", "/api/v1/decisions", { context: "c1", decisionId: "nope", answer: "yes" }),
  },
  {
    name: "ask for assistance", want: { ...ok(...WRITERS), others: "forbidden" },
    store: (s, a, n) => s.requestAssistance("c1", a, `q${n}`, "agent:expert", `what about ${n}?`, {}),
    http: (c, a) => c(a, "POST", "/api/v1/assistance", { context: "c1", to: "agent:expert", question: "what else?" }),
  },
  {
    name: "answer an assistance request", want: { ...ok(...WRITERS), others: "forbidden" },
    store: (s, a, n) => s.answerAssistance("c1", a, `a${n}`, "q1", "yes", ["e"]),
    http: (c, a) => c(a, "POST", "/api/v1/assistance", { context: "c1", requestKey: "q1", answer: "yes", evidence: ["e"] }),
  },
  {
    name: "let someone read along (grant read)", want: { ...ok("owner", "decider", "writer", "away", "echo"), others: "forbidden" },
    store: (s, a, n) => s.join({ contextId: "c1", actorId: "agent:expert", capabilities: ["read"], joinedAt: 1 }, `g${n}`, a),
    http: (c, a) => c(a, "POST", "/api/v1/join", { context: "c1", member: "agent:expert", capabilities: ["read"] }),
  },
  {
    // nobody can hand out what they do not hold; and an agent never hands out anything
    name: "grant the decide capability", want: { ...ok("owner", "decider", "away", "echo"), others: "forbidden" },
    store: (s, a, n) => s.join({ contextId: "c1", actorId: "agent:expert", capabilities: ["read", "decide"], joinedAt: 1 }, `g${n}`, a),
    http: (c, a) => c(a, "POST", "/api/v1/join", { context: "c1", member: "agent:expert", capabilities: ["read", "decide"] }),
  },
];

const store = (cell: Row, role: Role, n: number): Outcome => {
  const s = world();
  try {
    cell.prep?.(s);
    cell.store(s, ACTOR[role], n);
    return "ok";
  } catch (e) {
    return outcomeOfError(e);
  } finally {
    s.close();
  }
};

for (const row of rows) {
  test(`matrix (store): ${row.name}`, () => {
    const got: Record<string, Outcome> = {}, want: Record<string, Outcome> = {};
    ROLES.forEach((r, i) => { got[r] = store(row, r, i); want[r] = row.want[r] ?? row.want.others; });
    assert.deepEqual(got, want);
  });
  test(`matrix (http): ${row.name}`, async () => {
    const got: Record<string, Outcome> = {}, want: Record<string, Outcome> = {};
    let i = 0;
    for (const r of ROLES) {
      const srv = await serve(world());
      try {
        row.prep?.(srv.store);
        got[r] = outcomeOfStatus((await row.http((a, m, p, b) => srv.call(a, m, p, b), ACTOR[r], i++)).status);
        want[r] = row.want[r] ?? row.want.others;
      } finally { await srv.close(); }
    }
    assert.deepEqual(got, want);
  });
}

test("matrix: the rows really cover every operation the HTTP app offers", () => {
  const routes = ["/api/v1/messages", "/api/v1/observations", "/api/v1/promote", "/api/v1/decisions", "/api/v1/assistance", "/api/v1/join"];
  const covered = new Set(rows.map((r) => /\"(\/api\/v1\/[a-z]+)\"/.exec(r.http.toString())?.[1]));
  for (const r of routes) assert.ok(covered.has(r), `no matrix row for ${r}`);
});

test("decisions: a requester cannot decide their own request, and silence never expires into consent", async () => {
  let now = 1000;
  const s = world({ now: () => now });
  try {
    // dave asks, dave may not answer himself, alice can
    s.requestDecision({ id: "mine", contextId: "c1", question: "ok?", options: ["yes", "no"], requestedBy: ACTOR.decider, decidedBy: null, answer: null, status: "open", createdAt: 1, resolvedAt: null, expiresAt: 5000 });
    assert.throws(() => s.resolveDecision("c1", ACTOR.decider, "k1", "mine", "yes"), /requester cannot decide/);
    // after the deadline nobody can say yes; the decision is closed as expired, once
    now = 6000;
    assert.throws(() => s.resolveDecision("c1", ACTOR.owner, "k2", "mine", "yes"), /decision-expired/);
    assert.throws(() => s.resolveDecision("c1", ACTOR.owner, "k3", "mine", "yes"), /decision-not-open/);
    assert.equal(s.eventsSince("c1", 0).filter((e) => e.type === "decision.expired").length, 1);
    // a sweep expires what nobody touched
    s.requestDecision({ id: "late", contextId: "c1", question: "ok?", options: ["yes", "no"], requestedBy: "agent:req", decidedBy: null, answer: null, status: "open", createdAt: 1, resolvedAt: null, expiresAt: 7000 });
    now = 8000;
    assert.equal(s.expireDue(), 1);
    assert.equal(s.getDecision("c1", "late")?.status, "expired");
  } finally { s.close(); }
});

test("focus: a person is shown only the decisions they could take right now", async () => {
  const s = world();
  try {
    const seen = Object.fromEntries(ROLES.map((r) => [r, s.needsYou(ACTOR[r]).map((x) => x.decisionId)]));
    assert.deepEqual(seen.owner, ["d1"]);
    assert.deepEqual(seen.decider, ["d1"]);
    for (const r of ["writer", "reader", "away", "echo", "bot", "stranger"] as const) assert.deepEqual(seen[r], [], `${r} is not asked`);
  } finally { s.close(); }
});

test("granting only adds: a writer cannot strip the owner's rights by joining them again", () => {
  const s = world();
  try {
    s.join({ contextId: "c1", actorId: ACTOR.owner, capabilities: ["read"], joinedAt: 2 }, "strip", ACTOR.writer);
    const caps = JSON.parse((s.db.prepare(`SELECT capabilities c FROM members WHERE context_id='c1' AND actor_id=?`).get(ACTOR.owner) as { c: string }).c) as string[];
    assert.deepEqual(caps.sort(), ["decide", "read", "write"]);
  } finally { s.close(); }
});
