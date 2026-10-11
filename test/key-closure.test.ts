import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { SyntheticHarness, behave } from "../src/harnesses/synthetic.ts";
import { OPS } from "../src/ops.ts";

/**
 * Closure of the key/id squatting family (#51-#53, #62): run an agent through a whole life (reply, ask, decision, work,
 * observation) in a clean case, collect every key and id it used, then run it again after a writer has tried to take each
 * of them with every op that takes a `key` or an `id`. Every step of the clean run must still happen and the host must
 * report no error. (On the code before those fixes the agent managed 1 event of 6 and failed with key-conflict.)
 */
async function world(attack: string[] | null) {
  const store = new Store(":memory:"); const core = new LocalCore(store);
  const call = (a: string, op: string, x: Record<string, unknown> = {}) => core.call(a, op, x) as Promise<any>;
  await call("human:alice", "create", { id: "c1", title: "t" });
  await call("human:alice", "join", { context: "c1", actor: "agent:x", caps: "read,write,decide", skills: "job" }).catch(() => {});
  await call("human:alice", "join", { context: "c1", actor: "human:eve", caps: "read,write,decide" });
  const attempts = { tried: 0, accepted: [] as string[] };
  if (attack) for (const k of attack) {
    // every way eve can name k: as a key on every op that takes one, and as an id on every op that mints/takes one
    for (const [op, def] of Object.entries(OPS) as Array<[string, any]>) {
      const args: Record<string, unknown> = { context: "c1" };
      const names = [...def.required, ...(def.optional ?? [])];
      if (!names.includes("key") && !names.includes("id")) continue;
      for (const field of ["key", "id"]) if (names.includes(field)) {
        const a: Record<string, unknown> = { ...args, text: "z", question: "q?", to: "agent:x", options: "a,b", input: "{}", title: "z", kind: "case", [field]: k, as: "human:eve" };
        attempts.tried++;
        try { await call("human:eve", op, a); attempts.accepted.push(`${op}.${field}=${k.slice(0, 40)}`); } catch { /* refused or invalid: fine */ }
      }
    }
  }
  const host = new Host(core, { pollMs: 5 }); const errors: string[] = [];
  host.onError = (e) => errors.push(String((e.error as Error).message).slice(0, 70));
  await host.add({ actor: "agent:x", skills: ["job"], harness: new SyntheticHarness({ behaviors: [
    behave.replyTo(/^hello/, "hi"),
    behave.askOn(/^ask-someone/, "human:alice", () => "may I?"),
    async (s: any) => { if (s.events.some((e: any) => /^decide-please/.test(String(e.data.text ?? "")))) await s.run("decision-request", { question: "ship?", options: "yes,no" }); },
    async (s: any) => { if (s.events.some((e: any) => /^make-work/.test(String(e.data.text ?? "")))) await s.run("work-request", { to: "agent:x", input: "{}" }); },
    async (s: any) => { if (s.events.some((e: any) => /^observe-this/.test(String(e.data.text ?? "")))) await s.run("observe", { text: "noted" }); },
    behave.worker((i) => ({ done: true, i })),
  ] }) });
  for (const t of ["hello there", "ask-someone", "decide-please", "make-work", "observe-this"]) await call("human:alice", "post", { context: "c1", text: t, key: `m-${t}` });
  await host.settle(20).catch(() => {});
  const mine = store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:x");
  const keys = mine.map((e) => e.key);
  const ids = mine.flatMap((e) => ["decisionId", "id", "workId", "artifactId"].map((f) => e.data[f]).filter((x): x is string => typeof x === "string"));
  store.close();
  return { count: mine.length, types: mine.map((e) => e.type).join(","), keys, ids, errors, attempts };
}

test("a writer who tries to take every key and id an agent uses, with every op, cannot block or change what the agent does", async () => {
  const clean = await world(null);
  const targets = [...new Set([...clean.keys, ...clean.ids])];
  assert.ok(targets.length >= 8, `the clean run used ${targets.length} keys and ids`);
  const attacked = await world(targets);
  assert.ok(attacked.attempts.tried > 100, `eve tried ${attacked.attempts.tried} combinations`);
  const need = new Map<string, number>();
  for (const t of clean.types.split(",")) need.set(t, (need.get(t) ?? 0) + 1);
  const got = new Map<string, number>();
  for (const t of attacked.types.split(",")) got.set(t, (got.get(t) ?? 0) + 1);
  const missing = [...need].filter(([t, n]) => (got.get(t) ?? 0) < n).map(([t]) => t);
  assert.deepEqual(missing, [], `steps that no longer happened: ${missing.join(",")}`);
  assert.deepEqual(attacked.errors, [], "and the host reported no error");
});
