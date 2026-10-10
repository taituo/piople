import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";

/**
 * Work lifecycle as a property: random claims (with and without leases), completions with held and stale attempts,
 * failures with and without retry, member removal and re-joining, and the clock moving, with these invariants after
 * every step: at most one completion per work and a done work has exactly its attempt's completion; open work has
 * no holder and claimed work has one; attempts never go down; a holder is always a current member (removal
 * reopens its work); failed and done are exclusive. Deterministic (seeded).
 */
test("work lifecycle invariants hold over random operation sequences", () => {
const violations: string[] = []; let steps = 0; const seen = new Set<string>();
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const fail = (seed: number, step: number, msg: string, log: string[]) => { const k = msg.replace(/\d+/g, "N"); if (seen.has(k)) return; seen.add(k); violations.push(`seed ${seed} step ${step}: ${msg}; last ops: ${log.slice(-6).join(" | ")}`); };
for (let seed = 1; seed <= 60; seed++) {
  const r = rng(seed); const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const s = new Store(":memory:"); const A = ["agent:a1", "agent:a2", "agent:a3", "agent:a4"]; const log: string[] = [];
  s.createContext({ id: "c", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:boss");
  for (const a of A) { s.upsertActor({ id: a, kind: "agent", name: a }); s.join({ contextId: "c", actorId: a, capabilities: ["read", "write"], joinedAt: 2 }, `j-${a}`, "human:boss"); s.setSkills(a, ["sk"]); }
  let now = 1_000_000; const works: string[] = []; const held = new Map<string, number>(); let rejoin = 0; let wn = 0;
  const attemptsSeen = new Map<string, number>();
  const tryit = (label: string, f: () => unknown) => { try { const x = f(); log.push(`${label}:ok`); return x; } catch (e) { log.push(`${label}:${(e instanceof Error ? e.message : String(e)).split(":")[0]}`); return undefined; } };
  for (let step = 0; step < 150; step++, steps++) {
    const op = r();
    if (op < 0.16 || !works.length) { const id = `w${++wn}`; works.push(id); tryit(`req ${id}`, () => s.requestWork("c", "human:boss", { id, to: r() < 0.3 ? pick(A) : null, skill: "sk", input: {} })); }
    else if (op < 0.45) { const a = pick(A), id = pick(works), lease = r() < 0.6 ? 500 + Math.floor(r() * 3000) : undefined; const res = tryit(`claim ${a} ${id}`, () => s.claimWork("c", a, id, lease, now)) as any; if (res) held.set(`${a}|${id}`, res.work.attempt); }
    else if (op < 0.62) { const a = pick(A), id = pick(works); const h = held.get(`${a}|${id}`); const att = h !== undefined && r() < 0.8 ? h : (h ?? 1) + (r() < 0.5 ? 1 : -1); tryit(`complete ${a} ${id}#${att}`, () => s.completeWork("c", a, id, att, "r")); }
    else if (op < 0.72) { const a = pick(A), id = pick(works); const h = held.get(`${a}|${id}`) ?? 1; tryit(`fail ${a} ${id}#${h}`, () => s.failWork("c", a, id, h, "x", r() < 0.5)); }
    else if (op < 0.80) { const a = pick(A); tryit(`remove ${a}`, () => s.removeMember("c", a, `rm${step}`, "human:boss")); }
    else if (op < 0.86) { const a = pick(A); tryit(`rejoin ${a}`, () => s.join({ contextId: "c", actorId: a, capabilities: ["read", "write"], joinedAt: now }, `rj${++rejoin}`, "human:boss")); }
    else if (op < 0.93) { const a = pick(A); tryit(`claimNext ${a}`, () => { const x = s.claimNext("c", a, 1000, now); if (x) held.set(`${a}|${x.work.id}`, x.work.attempt); return x; }); }
    else { now += Math.floor(r() * 4000); }
    // invariants
    const rows = s.db.prepare(`SELECT id, status, claimed_by, attempt, lease_until FROM work WHERE context_id='c'`).all() as any[];
    const ev = s.eventsSince("c", 0, 5000);
    for (const w of rows) {
      const comp = ev.filter((e) => e.type === "work.completed" && (e.data as any).workId === w.id);
      if (comp.length > 1) fail(seed, step, `work ${w.id} completed ${comp.length} times`, log);
      if (w.status === "done" && (comp.length !== 1 || (comp[0]!.data as any).attempt !== w.attempt)) fail(seed, step, `done work ${w.id} has ${comp.length} completion events / attempt mismatch`, log);
      if (w.status !== "done" && comp.length) fail(seed, step, `work ${w.id} status ${w.status} but has a completion event`, log);
      if (w.status === "open" && w.claimed_by) fail(seed, step, `open work ${w.id} still has a holder ${w.claimed_by}`, log);
      if (w.status === "claimed" && !w.claimed_by) fail(seed, step, `claimed work ${w.id} has no holder`, log);
      const prev = attemptsSeen.get(w.id) ?? 0; if (w.attempt < prev) fail(seed, step, `attempt of ${w.id} went down ${prev} -> ${w.attempt}`, log); attemptsSeen.set(w.id, w.attempt);
      if (w.status === "claimed") { const m = s.db.prepare(`SELECT 1 FROM members WHERE context_id='c' AND actor_id=?`).get(w.claimed_by); if (!m) fail(seed, step, `work ${w.id} is held by ${w.claimed_by}, who is no longer a member`, log); }
      if (w.status === "failed" && ev.filter((e) => e.type === "work.completed" && (e.data as any).workId === w.id).length) fail(seed, step, `failed work ${w.id} also completed`, log);
    }
  }
  s.close();
}
assert.deepEqual(violations, [], `after ${steps} random steps`);
});
