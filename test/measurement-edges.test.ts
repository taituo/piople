import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import type { Context } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { ClassifierError, RouterHarness, keywordClassifier } from "../src/harnesses/router.ts";
import type { Classification, ClassifyInput, Classifier } from "../src/harnesses/router.ts";
import { NONE, jevClassifier, parseJev } from "../src/harnesses/jev.ts";
import { analyze, formatReport, runRoutingEval, wilsonLower } from "../src/eval/routing.ts";
import type { EvalDataset, EvalRow } from "../src/eval/routing.ts";
import { exportLabelled } from "../src/eval/export.ts";

/** Edges of the measurement code that decides whether routing may be trusted, pinned after mutation testing left them free. */
const row = (o: Partial<EvalRow>): EvalRow => ({ id: "x", sender: "human:a", expect: "a", tags: [], predicted: "a", confidence: 1, needsHuman: null, outcome: "classified", latencyMs: 10, ...o });

test("analyze: the threshold grid includes both ends; a suggestion needs the target reached exactly, the support reached exactly", () => {
  assert.equal(analyze([]).thresholds.length, 21);
  assert.equal(analyze([]).thresholds.at(-1)!.threshold, 1, "the top threshold 1.0 is in the grid");
  assert.deepEqual(analyze([], { step: 0.5 }).thresholds.map((t) => t.threshold), [0, 0.5, 1]);
  const ten = (wrong: number) => Array.from({ length: 20 }, (_, i) => row({ id: `r${i}`, predicted: i < wrong ? "b" : "a" }));
  assert.equal(analyze(ten(1), { targetPrecision: 0.95, minSupport: 10 }).suggestion?.precision, 0.95, "19 of 20 is exactly 95%: it reaches 95%");
  assert.equal(analyze(ten(2), { targetPrecision: 0.95, minSupport: 10 }).suggestion, null, "18 of 20 is 90%");
  const nine = Array.from({ length: 9 }, (_, i) => row({ id: `n${i}` }));
  const exactlyTen = Array.from({ length: 10 }, (_, i) => row({ id: `t${i}` }));
  assert.equal(analyze(nine, { minSupport: 10 }).suggestion, null, "9 routed messages are too few");
  assert.equal(analyze(exactlyTen, { minSupport: 10 }).suggestion?.routed, 10, "exactly the support is enough");
});

test("analyze: confident when the Wilson lower bound reaches the target exactly, not when it is below", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row({ id: `r${i}` }));
  const bound = wilsonLower(10, 10);
  assert.equal(analyze(rows, { targetPrecision: bound, minSupport: 10 }).suggestion?.confident, true);
  assert.equal(analyze(rows, { targetPrecision: bound + 1e-9, minSupport: 10 }).suggestion?.confident, false);
});

test("wilsonLower: zero and full counts are valid, impossible ones are refused", () => {
  assert.equal(wilsonLower(0, 0), 0);
  assert.equal(wilsonLower(0, 5), 0);
  assert.ok(wilsonLower(2, 2) > 0.3);
  for (const [k, n] of [[-1, 5], [0, -1], [3, 2], [-1, -1]] as const) assert.throws(() => wilsonLower(k, n), RangeError, `${k} of ${n}`);
});

test("analyze: latency percentiles, error and no-target counts, and the report's rows and 'n/a'", () => {
  const rows = [row({ latencyMs: 40 }), row({ latencyMs: 10 }), row({ latencyMs: null }), row({ latencyMs: 30 }), row({ latencyMs: 20 }),
    row({ outcome: "error", predicted: null, expect: null, latencyMs: null }), row({ outcome: "no-targets", predicted: null, expect: null, latencyMs: null }), row({ outcome: "no-permitted-targets", predicted: null, expect: null, latencyMs: null })];
  const a = analyze(rows);
  assert.deepEqual(a.latencyMs, { median: 30, p95: 40 }, "null latencies are left out, the rest sorted");
  assert.equal(a.errors, 1);
  assert.equal(a.withoutTargets, 2);
  const none = analyze([row({ predicted: null, confidence: 0 })]);
  const text = formatReport({ dataset: "d", classifier: { name: "c", version: "1" }, rows: [row({ predicted: null, confidence: 0 })], delivered: 0 }, none, undefined);
  assert.match(text, /n\/a/, "precision of nothing routed is n/a");
  assert.match(text, /\| 0\.00 \|/);
  assert.match(text, /\| 0\.10 \|/);
  assert.match(text, /\| 1\.00 \|/, "the last threshold is always shown");
  assert.doesNotMatch(text, /\| 0\.05 \|/, "every other threshold is left out");
});

const dataset = (): EvalDataset => ({
  name: "d", contexts: [{ id: "r1", kind: "realm", title: "Infra realm" }, { id: "ch1", kind: "channel", realm: "r1", title: "Incidents outage servers" }],
  members: [{ actor: "human:a", contexts: ["r1", "ch1"] }, { actor: "human:b", contexts: ["r1", "ch1"] }],
  cases: [{ id: "m1", sender: "human:a", text: "servers outage", expect: "ch1" }, { id: "m2", sender: "human:b", text: "outage again", expect: "ch1" }],
});

test("runRoutingEval: needsHumanAbove holds messages back and context shows the earlier messages with who wrote them", async () => {
  const kw = keywordClassifier();
  const free = await runRoutingEval(dataset(), kw);
  assert.deepEqual(free.rows.map((r) => r.predicted), ["ch1", "ch1"]);
  const held = await runRoutingEval(dataset(), kw, { needsHumanAbove: 0 });
  assert.deepEqual(held.rows.map((r) => r.predicted), [null, null], "every message needs a person at threshold 0, so none counts as routed");
  const seen: ClassifyInput[] = [];
  const spy: Classifier = { name: "spy", version: "1", async classify(i) { seen.push(i); return kw.classify(i); } };
  await runRoutingEval(dataset(), spy, { context: 1 });
  assert.deepEqual(seen.map((i) => i.recent), [[], [{ own: false, text: "servers outage" }]], "the second message sees the first, written by someone else");
  seen.length = 0;
  const same = dataset();
  same.cases[1]!.sender = "human:a";
  await runRoutingEval(same, spy, { context: 1 });
  assert.deepEqual(seen.map((i) => i.recent), [[], [{ own: true, text: "servers outage" }]], "own is true for the same sender");
});

const ctx = (id: string, kind: Context["kind"], title: string, extra: Partial<Context> = {}): Context => ({ id, kind, title, goal: "", createdAt: 1, ...extra });
function twoRealms() {
  const s = new Store(":memory:");
  for (const [r, c, t] of [["r1", "c1", "Infra realm"], ["r2", "c2", "Money realm"]] as const) {
    s.createContext(ctx(r, "realm", t), "human:a");
    s.createContext(ctx(c, "channel", `${c} topic`, { realmId: r }), "human:a");
  }
  s.addRouter("agent:router");
  return s;
}
async function route(s: Store, classifier: Classifier, o: Record<string, unknown> = {}) {
  const host = new Host(new LocalCore(s));
  host.onError = () => {};
  await host.add({ actor: "agent:router", harness: new RouterHarness({ classifier, mode: "enforce", minConfidence: 0.5, ruleVersion: "r", ...o } as never) });
  s.submitMessage("human:a", `k${Math.random()}`, "hello");
  await host.settle(4).catch(() => {});
  await host.close();
  return s.eventsSince("ingress:human:a", 0).filter((e) => e.type === "route.resolved" || e.type === "route.unresolved");
}
const fixed = (extra: Partial<Classification> & { confidence: number }): Classifier => ({ name: "fixed", version: "1", async classify(i) { const id = i.targets.find((t) => t.kind === "channel")?.id ?? i.targets[0]!.id; return { choice: id, probabilities: Object.fromEntries(i.targets.map((t) => [t.id, t.id === id ? 1 : 0])), ...extra }; } });

test("router options: confidence and needs-human thresholds are inclusive at the edge, and their bounds are 0 and 1", async () => {
  const mk = (o: Record<string, unknown>) => new RouterHarness({ classifier: keywordClassifier(), mode: "shadow", minConfidence: 0.5, ruleVersion: "r", ...o } as never);
  mk({ minConfidence: 0 });
  mk({ minConfidence: 1 });
  mk({ needsHumanAbove: 0 });
  mk({ needsHumanAbove: 1 });
  for (const bad of [-0.01, 1.01]) { assert.throws(() => mk({ minConfidence: bad }), /minConfidence/); assert.throws(() => mk({ needsHumanAbove: bad }), /needsHumanAbove/); }
  const atEdge = await route(twoRealms(), fixed({ confidence: 0.5 }));
  assert.deepEqual(atEdge.map((e) => e.type), ["route.resolved"], "confidence equal to minConfidence routes");
  const below = await route(twoRealms(), fixed({ confidence: 0.4999 }));
  assert.deepEqual(below.map((e) => [e.type, e.data.reason]), [["route.unresolved", "low-confidence"]]);
  const human = await route(twoRealms(), fixed({ confidence: 1, extras: { needsHuman: 0.5 } }), { needsHumanAbove: 0.5 });
  assert.deepEqual(human.map((e) => [e.type, e.data.reason]), [["route.unresolved", "needs-human"]], "needsHuman equal to the limit holds the message back");
  const calm = await route(twoRealms(), fixed({ confidence: 1, extras: { needsHuman: 0.4999 } }), { needsHumanAbove: 0.5 });
  assert.deepEqual(calm.map((e) => e.type), ["route.resolved"]);
});

test("router: all targets in one question up to maxOptions, realm first beyond it; realm titles are the realms' own", async () => {
  // bob can address 4 contexts: two realms and a channel in each
  const stages = async (maxOptions: number) => {
    const seen: Array<[string, string[]]> = [];
    const spy: Classifier = { name: "spy", version: "1", async classify(i) { seen.push([i.stage, i.targets.map((t) => `${t.id}:${t.title}`)]); return fixed({ confidence: 1 }).classify(i); } };
    const s = twoRealms();
    const events = await route(s, spy, { maxOptions });
    return { seen, events };
  };
  assert.deepEqual((await stages(4)).seen.map((x) => x[0]), ["targets"], "4 targets, room for 4: one question");
  const two = await stages(3);
  assert.deepEqual(two.seen.map((x) => x[0]), ["realm", "targets"], "4 targets, room for 3: realm first");
  assert.deepEqual(two.seen[0]![1], ["r1:Infra realm", "r2:Money realm"], "the realm stage shows each realm's own title");
  assert.equal((await stages(2)).seen.length, 2, "two realms and room for 2: still fine");
  const tooMany = await stages(1);
  assert.deepEqual(tooMany.events.map((e) => [e.type, e.data.reason]), [["route.unresolved", "too-many-options"]], "two realms but room for 1");
});

test("keyword classifier: a tie between destinations is no choice, a single best match is a choice, no match scores zero", async () => {
  const kw = keywordClassifier();
  const t = (id: string, title: string) => ({ id, kind: "channel", title, realm: null, parent: null });
  const input = (text: string, targets: ReturnType<typeof t>[]): ClassifyInput => ({ text, sender: "human:a", hops: 0, targets, stage: "targets" });
  const tie = await kw.classify(input("deploy rollout", [t("a", "deploy"), t("b", "rollout")]));
  assert.equal(tie.choice, null, "one word each: a tie");
  const clear = await kw.classify(input("deploy rollout today", [t("a", "deploy rollout"), t("b", "holiday")]));
  assert.equal(clear.choice, "a");
  const none = await kw.classify(input("nothing matches", [t("a", "deploy"), t("b", "holiday")]));
  assert.deepEqual([none.choice, none.confidence], [null, 0]);
});

const jevBody = (probabilities: Record<string, number>) => ({ answers: { target: { type: "choice", choice: "a", probabilities, confidence: 0.9 }, needs_human: { type: "noul", noul: 0.1 } } });

test("jev: probabilities of exactly 0 and 1 are valid, a hair outside is not; HTTP statuses are classified at their edges", async () => {
  assert.equal(parseJev(jevBody({ a: 1, [NONE]: 0 }), ["a", NONE]).probabilities.a, 1);
  for (const p of [1.0000001, -0.0000001]) assert.throws(() => parseJev(jevBody({ a: p, [NONE]: 0 }), ["a", NONE]), /probability/, String(p));
  const kind = async (status: number) => {
    const c = jevClassifier({ apiKey: "k", model: "m", fetch: (async () => new Response("{}", { status })) as typeof fetch });
    try { await c.classify({ text: "x", sender: "human:a", hops: 0, targets: [{ id: "a", kind: "channel", title: "A", realm: null, parent: null }], stage: "targets" }); return "ok"; } catch (e) { return (e as ClassifierError).kind; }
  };
  const kinds = Object.fromEntries(await Promise.all([400, 401, 404, 407, 408, 429, 499, 500, 503].map(async (s) => [s, await kind(s)])));
  assert.deepEqual(kinds, { 400: "message", 401: "config", 404: "config", 407: "message", 408: "transient", 429: "transient", 499: "message", 500: "transient", 503: "transient" });
});

test("export: a text exactly as long as the minimum is kept, one character shorter is not", () => {
  const s = new Store(":memory:");
  s.createContext(ctx("c1", "case", "t"), "human:alice");
  s.postMessage("c1", "human:alice", "p1", "ab");
  s.postMessage("c1", "human:alice", "p2", "a");
  assert.deepEqual(exportLabelled(s).cases.map((c) => c.text), ["ab"], "default minimum is 2");
  assert.deepEqual(exportLabelled(s, { minLength: 1 }).cases.map((c) => c.text), ["ab", "a"]);
  s.close();
});

test("eval: an accepted alternative counts as correct, an unaccepted one does not, and an unrouted message keeps its expectation", async () => {
  const d: EvalDataset = {
    name: "d", contexts: [{ id: "r1", kind: "realm", title: "R" }, { id: "ch1", kind: "channel", realm: "r1", title: "One" }, { id: "ch2", kind: "channel", realm: "r1", title: "Two" }],
    members: [{ actor: "human:a", contexts: ["r1", "ch1", "ch2"] }],
    cases: [
      { id: "m1", sender: "human:a", text: "to two, accepted", expect: "ch1", accept: ["ch2"] },
      { id: "m2", sender: "human:a", text: "to two, not accepted", expect: "ch1", accept: ["ch1"] },
      { id: "m3", sender: "human:a", text: "nowhere", expect: "ch1", accept: ["ch2"] },
      { id: "m4", sender: "human:a", text: "ack to one", expect: null, accept: ["ch1"] },
    ],
  };
  const byText: Classifier = { name: "t", version: "1", async classify(i) {
    const choice = /nowhere/.test(i.text) ? null : /ack/.test(i.text) ? "ch1" : "ch2";
    return { choice, probabilities: Object.fromEntries(i.targets.map((t) => [t.id, t.id === choice ? 1 : 0])), confidence: 1 };
  } };
  const run = await runRoutingEval(d, byText);
  const by = Object.fromEntries(run.rows.map((r) => [r.id, r]));
  assert.deepEqual([by.m1!.predicted, by.m1!.expect], ["ch2", "ch2"], "accepted: the expectation becomes what was chosen, so it counts as correct");
  assert.deepEqual([by.m2!.predicted, by.m2!.expect], ["ch2", "ch1"], "ch2 is not among the accepted ones: wrong");
  assert.deepEqual([by.m3!.predicted, by.m3!.expect], [null, "ch1"], "nothing chosen: the expectation stays");
  assert.deepEqual([by.m4!.predicted, by.m4!.expect], ["ch1", "ch1"], "an acknowledgement may follow its thread");
});

test("the report shows n/a only where nothing was routed", () => {
  const rows = [row({ confidence: 0.5 })];
  const text = formatReport({ dataset: "d", classifier: { name: "c", version: "1" }, rows, delivered: 0 }, analyze(rows), undefined);
  const line = (t: string) => text.split("\n").find((l) => l.startsWith(`| ${t} |`))!;
  assert.doesNotMatch(line("0.00"), /n\/a/, "at threshold 0 the message is routed and correct");
  assert.match(line("0.00"), /100%/);
  assert.match(line("1.00"), /n\/a/, "above its confidence nothing is routed: precision n/a");
});
