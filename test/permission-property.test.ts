import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";

/**
 * The permission model against an independent reference: random realms, channels, memberships, removals and roles
 * lowered behind the API. For every actor and context, reading, posting, `targets`, `inbox` and the router's
 * `route-recent` must agree with "the actor's own capabilities, cut down to what it holds in the context's realm".
 * Deterministic (seeded).
 */
test("reads, writes, targets, inbox and route-recent agree with the effective-capability model", () => {
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; } // mulberry32: the first draws differ between small seeds (a plain LCG gives nearly the same first value)
const seen = new Set<string>(); let checks = 0; const violations: string[] = [];
const bug = (seed: number, msg: string) => { const k = msg.replace(/[\d]+/g, "N").replace(/human:\w+|ctx-\w+|realm-\w+/g, "X"); if (seen.has(k)) return; seen.add(k); violations.push(`seed ${seed}: ${msg}`); };
for (let seed = 1; seed <= 80; seed++) {
  const r = rng(seed); const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const s = new Store(":memory:"); s.addRouter("agent:router");
  const H = ["human:a", "human:b", "human:c", "human:d"]; const CAPS = [["read"], ["read", "write"], ["read", "write", "decide"], ["write"], ["read", "decide"]];
  const realms = ["realm-1", "realm-2"], chans = ["ctx-1", "ctx-2", "ctx-3", "ctx-4"]; const chanRealm: Record<string, string | null> = {};
  let t = 1;
  for (const rl of realms) s.createContext({ id: rl, kind: "realm", title: rl, goal: "", createdAt: t++ }, "human:a");
  for (const c of chans) { const rl = r() < 0.7 ? pick(realms) : null; chanRealm[c] = rl; s.createContext(rl ? { id: c, kind: "channel", title: c, goal: "", createdAt: t++, realmId: rl } : { id: c, kind: "case", title: c, goal: "", createdAt: t++ }, "human:a"); }
  const tryit = (f: () => unknown) => { try { f(); } catch { /* refusals are fine */ } };
  for (let i = 0; i < 25; i++) {
    const who = pick(H), ctx = pick([...realms, ...chans]);
    const mode = r();
    if (mode < 0.6) tryit(() => s.join({ contextId: ctx, actorId: who, capabilities: pick(CAPS), joinedAt: t }, `j${seed}-${i}`, "human:a"));
    else if (mode < 0.75) tryit(() => s.removeMember(ctx, who, `r${seed}-${i}`, "human:a"));
    else if (mode < 0.9) s.db.prepare(`UPDATE members SET capabilities=? WHERE context_id=? AND actor_id=?`).run(JSON.stringify(pick(CAPS)), ctx, who); // roles lowered/changed behind the API
    else tryit(() => s.postMessage(ctx, "human:a", `p${seed}-${i}`, `msg ${i} in ${ctx}`));
  }
  for (const c of [...realms, ...chans]) tryit(() => s.postMessage(c, "human:a", `final-${c}`, `final in ${c}`));
  // reference model
  const own = (ctx: string, a: string): string[] | undefined => { const m = s.db.prepare(`SELECT capabilities FROM members WHERE context_id=? AND actor_id=?`).get(ctx, a) as any; return m ? JSON.parse(m.capabilities) : undefined; };
  const eff = (ctx: string, a: string): string[] => { const o = own(ctx, a); if (!o) return []; const rl = (s.db.prepare(`SELECT realm_id FROM contexts WHERE id=?`).get(ctx) as any).realm_id; if (!rl) return o; const b = own(rl, a); return b ? o.filter((c) => b.includes(c)) : []; };
  for (const a of H) for (const ctx of [...realms, ...chans]) {
    const e = eff(ctx, a); checks += 4;
    let canRead = true; try { s.readEvents(ctx, a, 0, 100); } catch { canRead = false; }
    if (canRead !== e.includes("read")) bug(seed, `${a} readEvents(${ctx}) ${canRead ? "allowed" : "refused"} but effective caps are [${e}]`);
    const tg = s.targets(a).some((x) => x.id === ctx); if (tg !== e.includes("write")) bug(seed, `${a} targets include ${ctx}=${tg} but effective caps are [${e}]`);
    let canPost = true; try { s.postMessage(ctx, a, `probe-${seed}-${a}-${ctx}`, "probe"); } catch { canPost = false; }
    if (canPost !== e.includes("write")) bug(seed, `${a} post in ${ctx} ${canPost ? "allowed" : "refused"} but effective caps are [${e}]`);
    const listed = s.inbox(a).some((x: any) => x.context === ctx);
    if (listed && !e.includes("read") && own(ctx, a) === undefined) bug(seed, `${a} inbox lists ${ctx} though not a member`);
    if (listed && !e.includes("read")) bug(seed, `${a} inbox lists ${ctx} but has no effective read (caps [${e}])`);
  }
  // route-recent must never expose a context the sender cannot read
  for (const a of H) {
    const rec = s.routeRecent("agent:router", a, 1e9, 10); checks++;
    for (const x of rec) if (!eff(x.context, a).includes("read")) bug(seed, `routeRecent for ${a} returned a message from ${x.context} without effective read`);
  }
  s.close();
}
assert.deepEqual(violations, [], `after ${checks} checks`);
});
