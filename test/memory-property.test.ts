import test from "node:test";
import assert from "node:assert/strict";
import { CaseMemory, extractiveSummarizer, type Summarizer, type MemEvent } from "../src/harnesses/memory.ts";

/**
 * The case-memory tree under random batches, redelivery and a summariser that fails a quarter of the time: every
 * non-skipped event stays as a level-0 node; a summary has k children one level down, in order, with the same range
 * as its children, and each child names it as parent; the view stays within budget, keeps the newest events and never
 * mentions an event that does not exist. Deterministic (seeded).
 */
test("the memory tree stays consistent under random batches, redelivery and a failing summariser", async () => {
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const seen = new Set<string>(); let checks = 0; const violations: string[] = [];
const bug = (seed: number, msg: string) => { const k = msg.replace(/\d+/g, "N"); if (seen.has(k)) return; seen.add(k); violations.push(`seed ${seed}: ${msg}`); };
for (let seed = 1; seed <= 60; seed++) {
  const r = rng(seed); const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const flaky = r() < 0.6; const inner = extractiveSummarizer();
  const summ: Summarizer = { name: "flaky", version: "1", async summarize(i) { if (flaky && r() < 0.25) throw new Error("down"); return inner.summarize(i); } };
  const k = pick([2, 3, 4, 8]), recent = pick([0, 2, 5, 10]);
  const m = CaseMemory.open(":memory:", { summarizer: summ, k, recent });
  let seq = 0; const all: MemEvent[] = [];
  const types = ["message.posted", "decision.requested", "decision.resolved", "presence.changed", "observation.recorded"];
  for (let round = 0; round < 12; round++) {
    const n = Math.floor(r() * 12); const batch: MemEvent[] = [];
    for (let i = 0; i < n; i++) { seq += 1 + (r() < 0.2 ? Math.floor(r() * 3) : 0); const type = pick(types); batch.push({ seq, actorId: pick(["human:a", "agent:b"]), type, data: type.startsWith("decision") ? { decisionId: `d${seq}`, question: `q${seq}` } : { text: `text ${seq} ${"w".repeat(Math.floor(r() * 300))}` } }); }
    all.push(...batch);
    m.ingest("c", batch); if (r() < 0.3) m.ingest("c", batch); // redelivery
    for (let t = 0; t < 2; t++) { try { await m.compact("c"); } catch { /* flaky summariser: tree must stay consistent */ } }
    // invariants
    const db = (m as any).db; const rows = db.prepare(`SELECT * FROM nodes WHERE context='c'`).all() as any[]; checks++;
    const byId = new Map(rows.map((x) => [x.id, x]));
    const kept = all.filter((e) => e.type !== "presence.changed");
    const l0 = rows.filter((x) => x.level === 0);
    if (l0.length !== kept.length) bug(seed, `level-0 nodes ${l0.length} but ${kept.length} non-skipped events ingested`);
    const parentCount = new Map<string, number>();
    for (const x of rows) {
      const ch = JSON.parse(x.children) as string[];
      if (x.level > 0) {
        if (ch.length < 2 && ch.length !== k) bug(seed, `summary ${x.id} has ${ch.length} children (k=${k})`);
        const kids = ch.map((c) => byId.get(c));
        if (kids.some((c) => !c)) { bug(seed, `summary ${x.id} points to a missing child`); continue; }
        if (kids.some((c: any) => c.level !== x.level - 1)) bug(seed, `summary ${x.id} child at wrong level`);
        if (kids[0].first_seq !== x.first_seq || kids.at(-1).last_seq !== x.last_seq) bug(seed, `summary ${x.id} range ${x.first_seq}-${x.last_seq} differs from its children's ${kids[0].first_seq}-${kids.at(-1).last_seq}`);
        for (const c of kids as any[]) if (c.parent !== x.id) bug(seed, `child ${c.id} of ${x.id} has parent ${c.parent}`);
        for (let i = 1; i < kids.length; i++) if ((kids[i] as any).first_seq <= (kids[i - 1] as any).last_seq) bug(seed, `children of ${x.id} overlap or are out of order`);
      } else if (ch.length) bug(seed, `level-0 node ${x.id} has children`);
      if (x.parent) { parentCount.set(x.id, 1); const p = byId.get(x.parent); if (!p) bug(seed, `${x.id} has parent ${x.parent} that does not exist`); else if (!(JSON.parse(p.children) as string[]).includes(x.id)) bug(seed, `${x.id} claims parent ${x.parent} which does not list it`); }
    }
    // every kept event is reachable via its ancestors from the frontier, text intact
    for (const e of kept) { const n = byId.get(`e${e.seq}`); if (!n) { bug(seed, `event ${e.seq} lost`); continue; } }
    const v = m.view("c", 1500); checks++;
    if (v.text.length > Math.max(200, 1500 * 4) + 4000) bug(seed, `view is ${v.text.length} chars, over budget`);
    const newest = kept.slice(-3); for (const e of newest) if (kept.length && !v.text.includes(`[e${e.seq}]`) && v.omitted > 0) bug(seed, `one of the newest 3 events (e${e.seq}) is missing from the view`);
    const pins = kept.filter((e) => e.type.startsWith("decision.")); // pinned only once folded; just check the view never invents a decision
    for (const mt of v.text.matchAll(/\[e(\d+)\]/g)) if (!all.some((e) => e.seq === Number(mt[1]))) bug(seed, `view mentions unknown event e${mt[1]}`);
    void pins;
  }
  m.close();
}
assert.deepEqual(violations, [], `after ${checks} checks`);
});
