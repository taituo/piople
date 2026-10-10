import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import type { Context } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { RouterHarness } from "../src/harnesses/router.ts";
import { NONE, jevClassifier, parseJev } from "../src/harnesses/jev.ts";
import { answerFor, fakeJev } from "./fake-jev.ts";

const MODEL = "typesafe/jev-pinned-test";
const KEY = "sk-secret-key-123";
const targets = [
  { id: "ch-incidents", kind: "channel", title: "Production incidents outage servers", realm: "realm-infra", parent: null },
  { id: "ch-people", kind: "channel", title: "Holiday leave vacation people", realm: "realm-hr", parent: null },
];
const input = (text: string) => ({ text, sender: "human:bob", hops: 2, targets, stage: "targets" as const });

test("the request: pinned model, Bearer key, a none-fits option, and only the text leaves", async () => {
  const jev = await fakeJev((b) => answerFor(b, "ch-incidents"));
  const c = jevClassifier({ apiKey: KEY, model: MODEL, endpoint: jev.url });
  assert.deepEqual([c.name, c.version, c.external], ["jev", MODEL, true]);
  await c.classify(input("production servers keep crashing"));
  const r = jev.requests[0]!;
  assert.equal(r.authorization, `Bearer ${KEY}`);
  assert.equal(r.body.model, MODEL);
  assert.deepEqual(r.body.state, { message: "production servers keep crashing" }, "not the sender, not the hop count");
  assert.deepEqual(Object.keys(r.body.questions), ["target", "needs_human"]);
  assert.equal(r.body.questions.target.type, "choice");
  assert.deepEqual(Object.keys(r.body.questions.target.criteria), ["ch-incidents", "ch-people", NONE]);
  assert.equal(r.body.questions.target.criteria["ch-incidents"], "channel: Production incidents outage servers");
  assert.equal(r.body.questions.needs_human.type, "noul");
  assert.ok(!JSON.stringify(r.body).includes("human:bob") && !JSON.stringify(r.body).includes("realm-"), "no sender id and no realm ids");
  await jev.close();
});

test("the answer: choice, none-fits as null, and where the confidence came from", async () => {
  const replies = [
    (b: any) => answerFor(b, "ch-people", { p: 0.8, confidence: 0.71 }),
    (b: any) => answerFor(b, "ch-people", { p: 0.8, metaConfidence: 0.66 }),
    (b: any) => answerFor(b, "ch-people", { p: 0.8 }),
    (b: any) => answerFor(b, NONE, { p: 0.6, noul: 0.9 }),
  ];
  const jev = await fakeJev((b, n) => replies[n - 1]!(b));
  const c = jevClassifier({ apiKey: KEY, model: MODEL, endpoint: jev.url });
  const [a, m, f, none] = [await c.classify(input("x")), await c.classify(input("x")), await c.classify(input("x")), await c.classify(input("x"))];
  assert.deepEqual([a.choice, a.confidence, a.extras!.confidenceSource], ["ch-people", 0.71, "answer"]);
  assert.deepEqual([m.confidence, m.extras!.confidenceSource], [0.66, "providerMetadata"]);
  assert.deepEqual([f.confidence, f.extras!.confidenceSource], [0.8, "choice-probability"]);
  assert.deepEqual([none.choice, none.extras!.needsHuman], [null, 0.9]);
  assert.equal(Object.keys(none.probabilities).length, 3, "the full distribution, none-fits included");
  await jev.close();
});

test("a malformed answer is an error, never a guess", () => {
  const labels = ["a", "b", NONE];
  const good = () => ({ answers: { target: { type: "choice", choice: "a", probabilities: { a: 0.5, b: 0.3, [NONE]: 0.2 } }, needs_human: { type: "noul", noul: 0.1 } } });
  assert.equal(parseJev(good(), labels).choice, "a");
  const bad: Array<[string, (g: any) => unknown]> = [
    ["not an object", () => "nope"],
    ["no answers", () => ({})],
    ["choice not offered", (g) => ((g.answers.target.choice = "zzz"), g)],
    ["choice missing", (g) => (delete g.answers.target.choice, g)],
    ["wrong type", (g) => ((g.answers.target.type = "score"), g)],
    ["incomplete distribution", (g) => (delete g.answers.target.probabilities.b, g)],
    ["extra label in distribution", (g) => ((g.answers.target.probabilities.q = 0.1), g)],
    ["probability above 1", (g) => ((g.answers.target.probabilities.a = 1.5), g)],
    ["probability not a number", (g) => ((g.answers.target.probabilities.a = "0.5"), g)],
    ["bad confidence", (g) => ((g.answers.target.confidence = 2), g)],
    ["needs_human wrong type", (g) => ((g.answers.needs_human.type = "choice"), g)],
    ["needs_human out of range", (g) => ((g.answers.needs_human.noul = -0.1), g)],
  ];
  for (const [name, mutate] of bad) assert.throws(() => parseJev(mutate(good()), labels), /Invalid Jev response/, name);
});

test("failures are errors without leaking the key or echoing the request or the provider's body", async () => {
  const modes: Array<[string, any, RegExp]> = [
    ["401", { status: 401, raw: `rejected key ${KEY} for message SECRET-TEXT` }, /HTTP 401 \(check the key\)/],
    ["429", { status: 429, raw: "SECRET-TEXT" }, /HTTP 429 \(busy or unavailable, will be retried\)/],
    ["500", { status: 500, raw: "SECRET-TEXT" }, /HTTP 500/],
    ["404", { status: 404 }, /check the model id/],
    ["redirect", { redirect: "http://127.0.0.1:1/elsewhere" }, /unreachable/],
    ["not json", { status: 200, raw: "<html>" }, /Invalid Jev response: not JSON/],
  ];
  for (const [name, reply, expected] of modes) {
    const jev = await fakeJev(() => reply);
    const c = jevClassifier({ apiKey: KEY, model: MODEL, endpoint: jev.url });
    await assert.rejects(c.classify(input("SECRET-TEXT")), (e: Error) => {
      assert.match(e.message, expected, name);
      assert.ok(!e.message.includes(KEY) && !e.message.includes("SECRET-TEXT"), `${name}: nothing sensitive in the error`);
      return true;
    });
    await jev.close();
  }
  const hung = await fakeJev(() => ({ hang: true }));
  await assert.rejects(jevClassifier({ apiKey: KEY, model: MODEL, endpoint: hung.url, timeoutMs: 50 }).classify(input("x")), /Jev unreachable/);
  await hung.close();
  assert.throws(() => jevClassifier({ apiKey: "", model: MODEL }), /needs an apiKey/);
  assert.throws(() => jevClassifier({ apiKey: KEY, model: "" }), /exact model id/);
  await assert.rejects(jevClassifier({ apiKey: KEY, model: MODEL }).classify({ ...input("x"), targets: [{ ...targets[0]!, id: NONE }] }), /may not be called/);
});

// ---- Jev inside the router -----------------------------------------------------------------------------------

const ctx = (id: string, kind: Context["kind"], title: string, extra: Partial<Context> = {}): Context => ({ id, kind, title, goal: "", createdAt: 1, ...extra });
function world() {
  const s = new Store(":memory:");
  s.createContext(ctx("realm-infra", "realm", "Infrastructure realm"), "human:alice");
  s.createContext(ctx("ch-incidents", "channel", "Production incidents outage servers", { realmId: "realm-infra" }), "human:alice");
  s.createContext(ctx("realm-hr", "realm", "Human resources realm"), "human:carol");
  s.createContext(ctx("ch-people", "channel", "Holiday leave vacation people", { realmId: "realm-hr" }), "human:carol");
  for (const [owner, realm, channel] of [["human:alice", "realm-infra", "ch-incidents"], ["human:carol", "realm-hr", "ch-people"]] as const) {
    s.join({ contextId: realm, actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, `jr-${realm}`, owner);
    s.join({ contextId: channel, actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, `jc-${channel}`, owner);
  }
  s.addRouter("agent:router");
  return s;
}
async function routed(store: Store, router: RouterHarness) {
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:router", harness: router });
  return host;
}
const posted = (s: Store, c: string) => s.eventsSince(c, 0).filter((e) => e.type === "message.posted");
const unresolved = (s: Store, who: string) => s.eventsSince(`ingress:${who}`, 0).filter((e) => e.type === "route.unresolved").map((e) => [e.data.submittedKey, e.data.reason]);

test("privacy by default: an external classifier is offered nothing, and nothing leaves", async () => {
  const store = world();
  const jev = await fakeJev((b) => answerFor(b, "ch-incidents"));
  const host = await routed(store, new RouterHarness({ classifier: jevClassifier({ apiKey: KEY, model: MODEL, endpoint: jev.url }), mode: "enforce", minConfidence: 0.5, ruleVersion: "r1" }));
  store.submitMessage("human:bob", "a", "production servers keep crashing");
  await host.settle();
  assert.deepEqual(unresolved(store, "human:bob"), [["a", "no-permitted-targets"]]);
  assert.equal(jev.requests.length, 0, "not a single request was made");
  assert.equal(posted(store, "ch-incidents").length, 0);
  await host.close();
  await jev.close();
  store.close();
});

test("only allowed realms are offered; routing works within them and what is recorded says how it was decided", async () => {
  const store = world();
  const jev = await fakeJev((b) => (b.state.message.includes("holiday") ? answerFor(b, NONE, { p: 0.7 }) : answerFor(b, "ch-incidents", { p: 0.9, confidence: 0.88 })));
  const host = await routed(store, new RouterHarness({
    classifier: jevClassifier({ apiKey: KEY, model: MODEL, endpoint: jev.url }), mode: "enforce", minConfidence: 0.5, ruleVersion: "r1", external: { allowRealms: ["realm-infra"] },
  }));
  store.submitMessage("human:bob", "a", "production servers keep crashing");
  store.submitMessage("human:bob", "b", "I want a holiday"); // hr is not an allowed realm, so it is never offered
  await host.settle();

  for (const r of jev.requests) assert.deepEqual(Object.keys(r.body.questions.target.criteria), ["realm-infra", "ch-incidents", NONE], "hr's names never left");
  assert.deepEqual(posted(store, "ch-incidents").map((e) => e.data.text), ["production servers keep crashing"]);
  assert.equal(posted(store, "ch-people").length, 0);
  assert.deepEqual(unresolved(store, "human:bob"), [["b", "no-choice"]]);
  const rec = store.eventsSince("ingress:human:bob", 0).find((e) => e.type === "route.classified" && e.data.submittedKey === "a")!.data as any;
  assert.deepEqual([rec.classifier, rec.external, rec.offered, rec.choice, rec.confidence], [{ name: "jev", version: MODEL }, true, 2, "ch-incidents", 0.88]);
  assert.deepEqual([rec.extras.confidenceSource, rec.extras.provider, rec.extras.needsHuman], ["answer", "jev", 0.05]);
  assert.equal(rec.probabilities["ch-incidents"], 0.9);
  await host.close();
  await jev.close();
  store.close();
});

test("a human is asked for only past a threshold the operator chose; an outage keeps messages pending", async () => {
  const store = world();
  let down = true;
  const jev = await fakeJev((b) => (down ? { status: 503 } : answerFor(b, "ch-incidents", { p: 0.9, noul: b.state.message.includes("delete") ? 0.95 : 0.1 })));
  const router = (needsHumanAbove?: number) => new RouterHarness({
    classifier: jevClassifier({ apiKey: KEY, model: MODEL, endpoint: jev.url }), mode: "enforce", minConfidence: 0.5, ruleVersion: "r1", external: { allowRealms: ["realm-infra"] }, needsHumanAbove,
  });
  const host = await routed(store, router(0.8));
  const errors: string[] = [];
  host.onError = (e) => errors.push(String((e.error as Error).message));
  store.submitMessage("human:bob", "a", "please delete the production database");
  store.submitMessage("human:bob", "b", "production servers keep crashing");
  await host.tick();
  assert.match(errors[0]!, /HTTP 503/);
  assert.equal(store.routePending("agent:router").length, 2, "an outage is not a decision");
  assert.deepEqual(unresolved(store, "human:bob"), []);

  down = false;
  await host.settle();
  assert.deepEqual(unresolved(store, "human:bob"), [["a", "needs-human"]]);
  assert.deepEqual(posted(store, "ch-incidents").map((e) => e.data.text), ["production servers keep crashing"]);
  assert.throws(() => router(1.5), /needsHumanAbove must be between 0 and 1/);
  await host.close();
  await jev.close();
  store.close();
});
