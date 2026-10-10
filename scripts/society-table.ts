/**
 * The betting Table, step 1 of docs/agent-societies.md, without a model: no human triggers anything.
 *   node scripts/society-table.ts
 * A feed (stand-in for a scout) posts odds and results into the Table. Three personas with different
 * stances wake on those events, say what they think in the Table, are nudged by each other but keep
 * their own strategy, and keep their paper bets and balance in a private case nobody else can read.
 * Swap the synthetic personas for PiHarness ones when a model key is available. Exits 1 if the
 * expectations at the bottom do not hold.
 */
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { SyntheticHarness } from "../src/harnesses/synthetic.ts";
import type { Step } from "../src/hosts/types.ts";

const store = new Store(":memory:");
const core = new LocalCore(store);
const as = (actor: string) => (op: string, a: Record<string, unknown> = {}) => core.call(actor, op, a) as Promise<any>;

type Odds = { match: string; home: number; draw: number; away: number };
type Pick = "home" | "draw" | "away";
const parse = (text: string): Record<string, string> =>
  Object.fromEntries(text.split(/\s+/).slice(1).map((kv) => kv.split("=") as [string, string]));

/** A stance: which side it likes given odds, and how far others may move it (never past its own core). */
type Stance = { name: string; core: string; choose: (o: Odds) => Pick | null; openness: number };
const stances: Stance[] = [
  { name: "agent:value", core: "backs the side whose odds look too long", openness: 0.2,
    choose: (o) => (o.away >= 3 ? "away" : o.draw >= 3.5 ? "draw" : null) },
  { name: "agent:favourite", core: "backs short favourites, small edges, often", openness: 0.4,
    choose: (o) => (Math.min(o.home, o.away) < 2 ? (o.home < o.away ? "home" : "away") : null) },
  { name: "agent:contrarian", core: "bets against what the Table agrees on", openness: 0.1, choose: () => null },
];

function persona(st: Stance) {
  const ledger = `ledger-${st.name.split(":")[1]}`;
  const open = new Map<string, { pick: Pick; price: number; stake: number }>();
  let balance = 100;
  let confidence = 1; // the persona's view, moved by others within `openness`
  let ledgerMade = false;
  const heard = new Map<string, Pick[]>(); // match -> picks the Table voiced

  return async (s: Step) => {
    if (s.context !== "table") return;
    if (!ledgerMade) {
      await s.run("create", { context: ledger, id: ledger, title: `${st.name} private ledger`, goal: "paper bets, never shared" });
      ledgerMade = true;
    }
    for (const e of s.events) {
      if (e.type !== "message.posted") continue;
      const text = String(e.data.text ?? "");
      const kv = parse(text);
      if (text.startsWith("STANCE ") && e.actorId !== s.actor) {
        const list = heard.get(kv.match) ?? [];
        list.push(kv.pick as Pick);
        heard.set(kv.match, list);
        // influence: agreement raises confidence a little, disagreement lowers it; bounded by openness
        confidence = Math.max(1 - st.openness, Math.min(1 + st.openness, confidence + (open.get(kv.match)?.pick === kv.pick ? 0.05 : -0.05)));
      }
      if (text.startsWith("ODDS ") && e.actorId === "agent:feed") {
        const o: Odds = { match: kv.match, home: +kv.home, draw: +kv.draw, away: +kv.away };
        const pick = st.choose(o);
        if (!pick) continue;
        const stake = Math.round(5 * confidence * 10) / 10;
        open.set(o.match, { pick, price: o[pick], stake });
        await s.run("post", { text: `STANCE match=${o.match} pick=${pick} why="${st.core}"` });
        await s.run("post", { context: ledger, text: `BET match=${o.match} pick=${pick} price=${o[pick]} stake=${stake}` });
      }
      if (text.startsWith("CLOSE ") && e.actorId === "agent:feed" && st.name === "agent:contrarian") {
        const voiced = heard.get(kv.match) ?? [];
        if (!voiced.length) continue;
        const crowd = voiced.sort((a, b) => voiced.filter((x) => x === b).length - voiced.filter((x) => x === a).length)[0];
        const pick: Pick = crowd === "home" ? "away" : "home";
        const price = +kv[pick];
        open.set(kv.match, { pick, price, stake: 5 });
        await s.run("post", { text: `STANCE match=${kv.match} pick=${pick} why="the Table leans ${crowd}; I fade it"` });
        await s.run("post", { context: ledger, text: `BET match=${kv.match} pick=${pick} price=${price} stake=5` });
      }
      if (text.startsWith("RESULT ") && e.actorId === "agent:feed") {
        const bet = open.get(kv.match);
        if (!bet) continue;
        open.delete(kv.match);
        const pnl = bet.pick === kv.winner ? bet.stake * (bet.price - 1) : -bet.stake;
        balance = Math.round((balance + pnl) * 100) / 100;
        await s.run("post", { context: ledger, text: `SETTLE match=${kv.match} pnl=${pnl.toFixed(2)} balance=${balance}` });
        // in public only a mood, never the number
        await s.run("post", { text: `MOOD ${st.name} ${pnl >= 0 ? "satisfied" : "unmoved"} about ${kv.match}` });
      }
    }
  };
}

// The world. The feed owns the Table and seats the personas; after that nobody but the feed acts from outside.
const feed = as("agent:feed");
await feed("actor", { name: "odds feed (scout stand-in)" });
await feed("create", { id: "table", title: "The Table", goal: "argue stances on every match; bets stay private" });

const host = new Host(core, { pollMs: 5 });
host.onError = (e) => console.error("host error:", e.actor, e.context, e.error);
for (const st of stances) {
  await host.add({ actor: st.name, harness: new SyntheticHarness({ behaviors: [persona(st)] }) });
  await feed("join", { context: "table", actor: st.name, caps: "read,write" });
}

const matches: (Odds & { winner: Pick })[] = [
  { match: "HJK-KuPS", home: 1.8, draw: 3.6, away: 4.2, winner: "home" },
  { match: "Inter-Ilves", home: 2.4, draw: 3.3, away: 3.0, winner: "away" },
  { match: "SJK-VPS", home: 2.9, draw: 3.2, away: 2.5, winner: "draw" },
  { match: "FCL-Haka", home: 1.6, draw: 3.9, away: 5.5, winner: "home" },
];
for (const m of matches) {
  await feed("post", { context: "table", text: `ODDS match=${m.match} home=${m.home} draw=${m.draw} away=${m.away}` });
  await host.settle();
  await feed("post", { context: "table", text: `CLOSE match=${m.match} home=${m.home} draw=${m.draw} away=${m.away}` });
  await host.settle();
  await feed("post", { context: "table", text: `RESULT match=${m.match} winner=${m.winner}` });
  await host.settle();
}

const log = (ctx: string) => store.eventsSince(ctx, 0).filter((e) => e.type === "message.posted");
console.log("== The Table (public)");
for (const e of log("table")) console.log(`${e.actorId.padEnd(17)} ${String(e.data.text)}`);
for (const st of stances) {
  const l = `ledger-${st.name.split(":")[1]}`;
  console.log(`== ${l} (private)`);
  for (const e of log(l)) console.log(`  ${String(e.data.text)}`);
}

// expectations
const fail: string[] = [];
const table = log("table");
if (table.some((e) => e.actorId.startsWith("human:"))) fail.push("a human acted");
for (const st of stances) {
  if (!table.some((e) => e.actorId === st.name && String(e.data.text).startsWith("STANCE"))) fail.push(`${st.name} never woke`);
  if (table.some((e) => /balance|pnl/.test(String(e.data.text)))) fail.push("a number leaked to the Table");
  const other = stances.find((x) => x !== st)!;
  try {
    await core.call(other.name, "inbox", { context: `ledger-${st.name.split(":")[1]}` });
    fail.push(`${other.name} could read ${st.name}'s ledger`);
  } catch {
    /* refused: the ledger is private */
  }
}
await host.stop?.();
if (fail.length) {
  console.error("FAIL:", fail.join("; "));
  process.exit(1);
}
console.log("OK: personas woke on world events only, argued in public, kept results private");
process.exit(0);
