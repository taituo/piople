import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/core/index.ts";
import { parseScenario, loadScenario, type Scenario } from "../src/sim/scenario.ts";
import { runScenario } from "../src/sim/runner.ts";
import { checkInvariants } from "../src/sim/invariants.ts";
import { matches, validateMatch } from "../src/sim/matcher.ts";
import { World } from "../src/sim/world.ts";

const DIR = "scenarios";
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const raw = (f: string) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as Record<string, any>;

// Every scenario file is a test case: adding a JSON file adds a test, no code needed.
for (const f of files) {
  test(`scenario ${f} passes scripted, every invariant and expectation`, async () => {
    const scn = loadScenario(path.join(DIR, f));
    const report = await runScenario(scn, { mode: "scripted" });
    const bad = [...report.safety, ...report.quality].filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)
      .concat(report.expectations.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`), report.errors);
    assert.deepEqual(bad, [], report.scenario);
    assert.equal(report.verdict, "pass");
  });
}

test("scripted runs are deterministic", async () => {
  const scn = loadScenario(path.join(DIR, "checkout-incident.json"));
  const a = await runScenario(scn, { mode: "scripted" });
  const b = await runScenario(scn, { mode: "scripted" });
  assert.deepEqual(a.timeline, b.timeline);
  assert.deepEqual(a.world, b.world);
});

test("the harness fails when behavior or expectations are wrong", async () => {
  const base = raw("checkout-incident.json");
  const run = (mut: (s: Record<string, any>) => void) => {
    const s = structuredClone(base);
    mut(s);
    return runScenario(parseScenario(s), { mode: "scripted" });
  };
  // a human who refuses leaves the world broken, so the "healthy" expectation must fail
  const refused = await run((s) => { s.decide = [{ actor: "human:alice", answer: "no" }]; });
  assert.equal(refused.verdict, "fail");
  assert.ok(refused.expectations.some((c) => !c.ok && c.name.startsWith("world")));
  // an impossible budget fails
  const budget = await run((s) => { s.expect.budget = { maxToolCalls: 1 }; });
  assert.equal(budget.verdict, "fail");
  // an unscripted agent does nothing, so required findings are missing
  const silent = await run((s) => { s.script = { "agent:scout": [], "agent:builder": [] }; });
  assert.equal(silent.verdict, "fail");
  // giving the scout a decision-less deny rule changes nothing about safety but the wrong approver is refused by the Store
  const carol = await run((s) => {
    s.actors.push({ id: "human:carol", kind: "human", capabilities: ["read"] });
    s.decide = [{ actor: "human:carol", answer: "yes" }, ...s.decide];
    s.expect.denied = { decisions: { min: 1, max: 1 } };
  });
  assert.equal(carol.verdict, "pass", JSON.stringify(carol.expectations.filter((c) => !c.ok)));
  assert.equal(carol.metrics.deniedDecisions, 1);
});

test("a granted-tool list is enforced on every call, not suggested", async () => {
  const s = structuredClone(raw("checkout-incident.json"));
  s.actors.find((a: any) => a.id === "agent:builder").tools = ["world", "observe"]; // propose revoked
  s.expect = { denied: { tools: { min: 1 } }, events: { "action.executed": { max: 0 } }, proposals: { max: 0 } };
  const r = await runScenario(parseScenario(s), { mode: "scripted" });
  assert.equal(r.metrics.deniedTools, 1);
  assert.equal(r.verdict, "pass", JSON.stringify(r.expectations.filter((c) => !c.ok)));
});

test("runaway protection stops a run at its token limit and fails it, instead of spending on", async () => {
  const s = structuredClone(raw("checkout-incident.json"));
  s.limits = { maxTokens: 1 };
  const r = await runScenario(parseScenario(s), { mode: "scripted" });
  assert.equal(r.verdict, "fail");
  assert.ok(r.errors.some((e) => /limit-exceeded: \d+ tokens/.test(e)), JSON.stringify(r.errors));
  assert.equal(r.metrics.perActor["agent:builder"]!.turns, 0, "the builder never got a turn after the limit was hit");
  s.limits = { maxTokens: 10_000_000, maxSeconds: 600, turnSeconds: 60 };
  assert.equal((await runScenario(parseScenario(s), { mode: "scripted" })).verdict, "pass", "generous limits change nothing");
});

test("live mode refuses to start without a model and a gateway", async () => {
  const scn = loadScenario(path.join(DIR, "checkout-incident.json"));
  await assert.rejects(runScenario({ ...scn, model: undefined as never }, { mode: "live" }), /needs a model/);
  await assert.rejects(runScenario(scn, { mode: "live" }), /needs a gateway/);
  const noScript: Scenario = { ...scn };
  delete (noScript as { script?: unknown }).script;
  await assert.rejects(runScenario(noScript, { mode: "scripted" }), /has no script/);
});

// ---------------------------------------------------------------- validation

const invalid: Array<[string, (s: Record<string, any>) => void, RegExp]> = [
  ["typo in a field", (s) => { s.kickof = "x"; }, /unknown field "kickof"/],
  ["bad id", (s) => { s.id = "Bad Id"; }, /lowercase/],
  ["unknown capability", (s) => { s.actors[0].capabilities.push("root"); }, /unknown capability "root"/],
  ["unknown tool", (s) => { s.actors[1].tools.push("rm"); }, /unknown tool "rm"/],
  ["world tool without world", (s) => { delete s.world; delete s.expect.world; }, /world.*required/],
  ["duplicate actor", (s) => { s.actors.push(structuredClone(s.actors[1])); }, /duplicate actor/],
  ["human post by an agent", (s) => { s.humanPosts[0].actor = "agent:scout"; }, /not a human/],
  ["post in a round that does not exist", (s) => { s.humanPosts[0].round = 99; }, /round/],
  ["decide rule with bad answer", (s) => { s.decide[0].answer = "maybe"; }, /yes \| no/],
  ["bad match operator", (s) => { s.decide[0].when.value = { gtt: 1 }; }, /unknown operator "gtt"/],
  ["script for a human", (s) => { s.script["human:alice"] = []; }, /not an agent/],
  ["script with unknown tool", (s) => { s.script["agent:scout"][0].calls[0].tool = "nope"; }, /unknown tool "nope"/],
  ["expect with unknown event", (s) => { s.expect.events["thing.happened"] = { min: 1 }; }, /unknown event type/],
  ["limits with a non-positive number", (s) => { s.limits = { maxTokens: 0 }; }, /limits.maxTokens/],
  ["min above max", (s) => { s.expect.findings.min = 9; s.expect.findings.max = 1; }, /min > max/],
  ["bad regex in world effect", (s) => { s.world.effects[0].when.matches = "("; }, /invalid regular expression/],
  ["no agents", (s) => { s.actors = s.actors.filter((a: any) => a.kind === "human"); s.script = {}; s.humanPosts = []; }, /at least one agent/],
];
for (const [name, mutate, want] of invalid) {
  test(`validation rejects: ${name}`, () => {
    const s = structuredClone(raw("checkout-incident.json"));
    mutate(s);
    assert.throws(() => parseScenario(s), want);
  });
}

test("validation reports every problem at once", () => {
  const s = structuredClone(raw("checkout-incident.json"));
  s.kickof = 1; s.rounds = 0; s.actors[0].capabilities = ["root"];
  try { parseScenario(s); assert.fail("should throw"); } catch (e) {
    const m = (e as Error).message;
    assert.match(m, /kickof/); assert.match(m, /rounds/); assert.match(m, /root/);
  }
});

// ---------------------------------------------------------------- matcher

test("matcher conditions", () => {
  const o = { a: { b: "10", c: "hello world" }, n: 3, flag: true };
  const cases: Array<[any, boolean]> = [
    [{ "a.b": { gt: 5 } }, true], [{ "a.b": { gt: 10 } }, false], [{ "a.b": { gte: 10, lte: 10 } }, true],
    [{ "a.c": { includes: "WORLD" } }, true], [{ "a.c": { matches: "^hello" } }, true], [{ "a.c": { matches: "^world" } }, false],
    [{ n: 3 }, true], [{ n: { ne: 3 } }, false], [{ flag: true }, true], [{ "a.zzz": { exists: false } }, true],
    [{ "a.b": { in: [1, 10] } }, true], [{ "a.b": { lt: "abc" as never } }, false], [{}, true],
  ];
  for (const [m, want] of cases) assert.equal(matches(o, m), want, JSON.stringify(m));
  assert.match(validateMatch({ x: { matches: "(" } }, "m") ?? "", /regular expression/);
  assert.equal(validateMatch({ x: { gt: 1 } }, "m"), null);
});

// ---------------------------------------------------------------- world

test("world: set keys in JSON and env files, effects react, unknown keys fail", () => {
  const w = new World({
    files: { "cfg.json": '{"data":{"POOL":"0","N":3}}\n', "app.env": "POOL=0\nREGION: eu\n", "status": "down" },
    effects: [
      { when: { path: "cfg.json", matches: '"POOL": "0"' }, set: { status: "down" } },
      { when: { path: "cfg.json", matches: '"POOL": "[1-9]' }, set: { status: "up" } },
    ],
  });
  assert.equal(w.read("status"), "down");
  assert.deepEqual(w.setKey("cfg.json", "POOL", "10"), { path: "cfg.json", key: "POOL", before: "0", after: "10" });
  assert.equal(w.read("status"), "up");
  w.setKey("cfg.json", "N", "5");
  assert.equal((JSON.parse(w.files.get("cfg.json")!) as any).data.N, 5, "numbers stay numbers");
  w.setKey("app.env", "POOL", "7");
  w.setKey("app.env", "REGION", "fi");
  assert.equal(w.read("app.env"), "POOL=7\nREGION: fi\n");
  assert.throws(() => w.setKey("cfg.json", "MISSING", "1"), /not found/);
  assert.throws(() => w.setKey("nope", "A", "1"), /no such file/);
  assert.deepEqual(w.ls("").sort(), ["app.env", "cfg.json", "status"]);
  assert.deepEqual(w.grep("region"), ["app.env:2:REGION: fi"]);
  assert.equal(w.changes.length, 4);
});

// ---------------------------------------------------------------- invariants catch violations

function violationStore() {
  const s = new Store(":memory:");
  for (const id of ["human:alice", "agent:a"]) s.upsertActor({ id, kind: id.startsWith("human") ? "human" : "agent", name: id });
  s.createContext({ id: "c", kind: "case", title: "t", goal: "g", createdAt: Date.now() }, "human:alice");
  s.join({ contextId: "c", actorId: "agent:a", capabilities: ["read", "write"], joinedAt: Date.now() }, "j");
  return s;
}
const failed = (s: Store, w?: World) => checkInvariants(s, "c", w).filter((c) => !c.ok).map((c) => c.name);

test("invariants: a clean case has no violations", () => {
  assert.deepEqual(failed(violationStore()), []);
});

test("invariants: execution without a human yes is caught", () => {
  const s = violationStore();
  s.proposeAction({ id: "p", contextId: "c", kind: "proposal", authorId: "agent:a", text: "x", status: null, evidence: [], createdAt: 1 }, { verb: "set" }, "d");
  s.requestDecision({ id: "d", contextId: "c", question: "q", options: ["yes", "no"], requestedBy: "agent:a", decidedBy: null, answer: null, status: "open", createdAt: 1, resolvedAt: null });
  s.recordExecution("c", "human:alice", "exec:p", "p", "d", true, "ran anyway");
  assert.deepEqual(failed(s), ["execution-requires-approval"]);
});

test("invariants: a proposal without its decision is caught", () => {
  const s = violationStore();
  s.proposeAction({ id: "p", contextId: "c", kind: "proposal", authorId: "agent:a", text: "x", status: null, evidence: [], createdAt: 1 }, { verb: "set" }, "never-requested");
  assert.deepEqual(failed(s), ["proposal-bound-to-decision"]);
});

test("invariants: an outsider's event and a resolver without decide are caught", () => {
  const s = violationStore();
  s.append({ type: "message.posted", contextId: "c", actorId: "agent:ghost", key: "k", data: { text: "boo" } });
  s.requestDecision({ id: "d", contextId: "c", question: "q", options: ["yes", "no"], requestedBy: "agent:a", decidedBy: null, answer: null, status: "open", createdAt: 1, resolvedAt: null });
  s.append({ type: "decision.resolved", contextId: "c", actorId: "agent:a", key: "k2", data: { decisionId: "d", answer: "yes" } });
  assert.deepEqual(failed(s).sort(), ["only-deciders-resolve", "only-members-act"]);
});

test("invariants: an unexplained world change is caught; findings without evidence are quality failures", () => {
  const s = violationStore();
  const w = new World({ files: { f: "K=1\n" } });
  w.setKey("f", "K", "2");
  assert.deepEqual(failed(s, w), ["world-changes-only-via-approved-actions"]);
  s.recordObservation({ id: "o", contextId: "c", kind: "finding", authorId: "agent:a", text: "guess", status: "hypothesis", evidence: ["pi:call:1"], createdAt: 1 });
  const q = checkInvariants(s, "c", undefined).find((c) => c.name === "agent-findings-cite-evidence")!;
  assert.equal(q.ok, false);
  assert.equal(q.kind, "quality");
});
