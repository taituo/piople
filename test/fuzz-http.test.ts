import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { createCoreServer } from "../src/http/server.ts";

/**
 * Stateful random HTTP calls: five actors with tokens use ids they harvest from earlier answers (works and attempts,
 * decisions, findings, asks, submissions) mixed with removals, leaves and joins. After the barrage: no 5xx, every answer
 * is JSON, and database invariants hold (one holder per claim and only a member holds, one completion per work, one
 * resolution per decision and inside its options, valid finding and presence states, no member without a context, no
 * empty membership, each submission routed once and left the queue, and answers only from members or the addressee,
 * an invited expert only once). Deterministic (seeded). Found the realm-leave key collision (500).
 */
test("random stateful HTTP calls: no 500, JSON everywhere, database invariants hold", { timeout: 120_000 }, async () => {
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const ACTORS = ["human:a", "human:b", "agent:c", "agent:d", "agent:router"];
const bad: Record<string, string> = {}; let calls = 0; const ok: Record<string, number> = {}; const hist: Record<string, number> = {};
for (let seed = 1; seed <= 4; seed++) {
  const r = rng(seed); const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!; const chance = (p: number) => r() < p;
  const store = new Store(":memory:"); store.addRouter("agent:router");
  const tokens = Object.fromEntries(ACTORS.map((a) => [a, store.issueToken(a)]));
  const srv = createCoreServer(store, { maxBody: 100_000 }); await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const ctxs = ["c1", "c2"]; const works: Array<{ ctx: string; id: string; attempt: number }> = []; const decs: Array<{ ctx: string; id: string }> = []; const arts: string[] = []; const asks: Array<{ ctx: string; key: string }> = []; const subs: Array<{ ingress: string; key: string }> = [];
  const call = async (actor: string, op: string, args: Record<string, unknown>) => {
    calls++; let status = 0, body = "";
    try { const res = await fetch(`${base}/v1/ops/${op}`, { method: "POST", headers: { authorization: `Bearer ${tokens[actor]}`, "content-type": "application/json" }, body: JSON.stringify(args) }); status = res.status; body = await res.text(); } catch (e) { bad[`fetch-throw ${op}`] ??= String(e); return null; }
    hist[status] = (hist[status] ?? 0) + 1; let j: any = null; try { j = JSON.parse(body); } catch { bad[`non-json ${op}`] ??= body.slice(0, 80); }
    if (status >= 500) bad[`${status} ${op}`] ??= `${body.slice(0, 150)} args=${JSON.stringify(args).slice(0, 120)}`;
    if (status === 200) ok[op] = (ok[op] ?? 0) + 1;
    return status === 200 ? j?.result : null;
  };
  // world
  await call("human:a", "create", { id: "r1", title: "Realm", kind: "realm" }); await call("human:a", "create", { id: "ch1", title: "Chan topic", kind: "channel", realm: "r1" });
  for (const c of ["c1", "c2"]) await call("human:a", "create", { id: c, title: `${c} topic` });
  for (const a of ACTORS.slice(1)) { for (const c of ["r1", "ch1", "c1", "c2"]) await call("human:a", "join", { context: c, actor: a, caps: chance(0.8) ? "read,write,decide" : "read,write" }); await call(a, "actor", { skills: "job" }); }
  ctxs.push("ch1", "r1");
  for (let i = 0; i < 450; i++) {
    const actor = pick(ACTORS); const ctx = pick(ctxs); const w = works.length ? pick(works) : null; const d = decs.length ? pick(decs) : null;
    const m = r(); let res: any;
    if (m < 0.10) res = await call(actor, "post", { context: ctx, text: `msg ${i}`, ...(chance(0.3) ? { key: `pk${i % 7}` } : {}) });
    else if (m < 0.17) { const id = `w${i}`; res = await call(actor, "work-request", { context: ctx, id, ...(chance(0.5) ? { to: pick(ACTORS) } : { skill: "job" }), input: "{}" }); if (res) works.push({ ctx, id, attempt: 0 }); }
    else if (m < 0.27 && w) { res = await call(actor, "work-claim", { context: w.ctx, id: w.id, ...(chance(0.5) ? { "lease-ms": 1000 + Math.floor(r() * 5000) } : {}) }); if (res?.work) w.attempt = res.work.attempt; }
    else if (m < 0.33) { res = await call(actor, "work-claim", { context: ctx, next: "true" }); if (res?.work) { const f = works.find((x) => x.id === res.work.id && x.ctx === ctx); if (f) f.attempt = res.work.attempt; } }
    else if (m < 0.41 && w) res = await call(actor, "work-complete", { context: w.ctx, id: w.id, attempt: chance(0.8) ? w.attempt : w.attempt + 1, result: JSON.stringify({ r: i }) });
    else if (m < 0.46 && w) res = await call(actor, "work-fail", { context: w.ctx, id: w.id, attempt: w.attempt, reason: "x", retry: chance(0.5) ? "true" : "false" });
    else if (m < 0.52) { const id = `d${i}`; res = await call(actor, "decision-request", { context: ctx, id, question: "ok?", ...(chance(0.4) ? { options: "allow, deny" } : {}) }); if (res) decs.push({ ctx, id }); }
    else if (m < 0.58 && d) res = await call(actor, "decide", { context: d.ctx, decision: d.id, answer: pick(["yes", "no", "allow", "deny", "maybe"]) });
    else if (m < 0.63) { const id = `o${i}`; res = await call(actor, "observe", { context: ctx, id, text: "finding" }); if (res) arts.push(id); }
    else if (m < 0.67 && arts.length) res = await call(actor, "promote", { artifact: pick(arts), status: pick(["confirmed", "refuted", "banana"]) });
    else if (m < 0.73) { const key = `ask${i}`; res = await call(actor, "ask", { context: ctx, to: pick(ACTORS), question: "help?", key }); if (res) asks.push({ ctx, key }); }
    else if (m < 0.78 && asks.length) { const a = pick(asks); res = await call(actor, "answer", { context: a.ctx, request: a.key, answer: "ans" }); }
    else if (m < 0.81) res = await call(actor, "presence", { state: pick(["active", "away", "silent"]), echo: pick(["true", "false", false]) });
    else if (m < 0.84) { res = await call(actor, "submit", { text: `route me ${i}`, key: `sub${i}` }); if (res) subs.push({ ingress: `ingress:${actor}`, key: `sub${i}` }); }
    else if (m < 0.88) { const t = await call("agent:router", "route-pending", {}); const sub = Array.isArray(t) && t.length ? pick(t) as any : null; if (sub) { const choice = pick(["resolve", "unresolved", "classified"]); const tg = (await call("agent:router", "route-targets", { sender: sub.sender })) ?? []; const dest = Array.isArray(tg) && tg.length ? (pick(tg) as any).id : "c1";
        if (choice === "resolve") res = await call("agent:router", "route-resolve", { ingress: sub.ingress, submitted: sub.key, context: dest, ...(chance(0.3) ? { as: "work", skill: "job" } : {}), ...(chance(0.3) ? { deliver: "false" } : {}) });
        else if (choice === "unresolved") res = await call("agent:router", "route-unresolved", { ingress: sub.ingress, submitted: sub.key, reason: "no-choice", data: "{}" });
        else res = await call("agent:router", "route-classified", { ingress: sub.ingress, submitted: sub.key, data: JSON.stringify({ choice: dest }) }); } }
    else if (m < 0.91) res = await call(actor, "remove-member", { context: pick(ctxs), actor: pick(ACTORS), key: `rm${i}` });
    else if (m < 0.94) res = await call(actor, "leave", { context: pick(ctxs), key: `lv${i}` });
    else if (m < 0.97) res = await call("human:a", "join", { context: pick(ctxs), actor: pick(ACTORS), caps: pick(["read", "read,write", "read,write,decide"]) });
    else { res = await call(actor, pick(["inbox", "events", "targets", "ack"]), pick([{ context: ctx }, {}, { context: ctx, seq: 5 }])); }
    void res;
  }
  // invariants
  const q = (sql: string) => store.db.prepare(sql).all() as any[];
  const must = (name: string, sql: string) => { const rows = q(sql); if (rows.length) bad[name] = JSON.stringify(rows[0]).slice(0, 160); };
  must("work: open with holder / claimed without", `SELECT * FROM work WHERE (status='open' AND claimed_by IS NOT NULL) OR (status='claimed' AND claimed_by IS NULL)`);
  must("work: holder not a member", `SELECT w.id, w.claimed_by FROM work w LEFT JOIN members m ON m.context_id=w.context_id AND m.actor_id=w.claimed_by WHERE w.status='claimed' AND m.actor_id IS NULL`);
  must("work: done twice", `SELECT json_extract(data,'$.workId') w, context_id, COUNT(*) n FROM events WHERE type='work.completed' GROUP BY 1,2 HAVING n>1`);
  must("decision: resolved without answer", `SELECT * FROM decisions WHERE (status='resolved' AND answer IS NULL) OR (status='open' AND answer IS NOT NULL)`);
  must("decision: resolved twice", `SELECT json_extract(data,'$.decisionId') d, context_id, COUNT(*) n FROM events WHERE type='decision.resolved' GROUP BY 1,2 HAVING n>1`);
  for (const dd of q(`SELECT id, options, answer FROM decisions WHERE status='resolved'`)) { const o = JSON.parse(dd.options) as string[]; if (o.length && !o.includes(dd.answer)) bad["decision answered outside its options"] = `${dd.id}: ${dd.answer} in ${dd.options}`; }
  must("artifact: odd status", `SELECT id, status FROM artifacts WHERE kind<>'proposal' AND status NOT IN ('hypothesis','confirmed','refuted')`);
  must("presence: odd", `SELECT * FROM presence WHERE state NOT IN ('active','away','silent')`);
  must("member without context", `SELECT m.* FROM members m LEFT JOIN contexts c ON c.id=m.context_id WHERE c.id IS NULL`);
  must("member with empty capabilities", `SELECT * FROM members WHERE capabilities='[]'`);
  must("route: delivered twice", `SELECT json_extract(data,'$.submittedKey') k, context_id, COUNT(*) n FROM events WHERE type IN ('route.resolved','route.unresolved','route.shadowed') GROUP BY 1,2 HAVING n>1`);
  must("route queue holds a routed message", `SELECT q.* FROM route_queue q WHERE EXISTS (SELECT 1 FROM events e WHERE e.context_id=q.ingress AND e.type IN ('route.resolved','route.unresolved','route.shadowed') AND json_extract(e.data,'$.submittedKey')=q.key)`);
  { // replay membership in event order: an answer is legitimate if the author was a member (with write, or the addressee) when it was written
    const evs = q(`SELECT seq, context_id, actor_id, type, key, data FROM events ORDER BY seq`);
    const mem = new Map<string, Set<string>>(); const asksTo = new Map<string, string>(); const answered = new Map<string, number>();
    for (const e of evs) {
      const d = JSON.parse(e.data); const k = e.context_id; mem.get(k) ?? mem.set(k, new Set());
      if (e.type === "context.created") mem.get(k)!.add(e.actor_id);
      else if (e.type === "member.joined") mem.get(k)!.add(e.actor_id);
      else if (e.type === "member.removed") mem.get(k)!.delete(e.actor_id);
      else if (e.type === "assistance.requested") asksTo.set(`${k}\0${e.key}`, d.to);
      else if (e.type === "assistance.answered") {
        const isMember = mem.get(k)!.has(e.actor_id), to = asksTo.get(`${k}\0${d.requestKey}`);
        if (!isMember && to !== e.actor_id) { bad["answer by a stranger (at that time)"] = `seed ${seed} seq ${e.seq} ${e.actor_id} in ${k}; ask to=${to}`; bad["  history"] = JSON.stringify(evs.filter((x) => x.context_id === k && x.seq <= e.seq && (x.actor_id === e.actor_id || x.type.startsWith("member") || x.type === "context.created")).map((x) => `${x.seq}:${x.type}:${x.actor_id}:${(x.type.startsWith("member") ? x.data : "").slice(0, 60)}`).slice(-14)); }
        if (!isMember) { const n = (answered.get(`${k}\0${e.actor_id}\0${d.requestKey}`) ?? 0) + 1; answered.set(`${k}\0${e.actor_id}\0${d.requestKey}`, n); if (n > 1) bad["expert answered the same ask twice"] = `seq ${e.seq} ${e.actor_id}`; }
      }
    }
  }
  srv.close(); store.close();
}
assert.deepEqual(bad, {}, `after ${calls} random HTTP calls`);
assert.ok(Object.keys(ok).length >= 20, `the random calls reached ${Object.keys(ok).length} operations`);
});
