import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import type { Context } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import type { CoreClient } from "../src/hosts/types.ts";
import { ClassifierError, RouterHarness, keywordClassifier } from "../src/harnesses/router.ts";
import type { Classification, ClassifyInput, Classifier } from "../src/harnesses/router.ts";

const ctx = (id: string, kind: Context["kind"], title: string, extra: Partial<Context> = {}): Context => ({ id, kind, title, goal: "", createdAt: 1, ...extra });
const R = "agent:router";

/** infra (alice): incidents; hr (carol): people; fin (dave): finance. bob is in infra/incidents and hr/people only. */
function world() {
  const store = new Store(":memory:");
  store.createContext(ctx("realm-infra", "realm", "Infrastructure realm"), "human:alice");
  store.createContext(ctx("ch-incidents", "channel", "Production incidents outage servers", { realmId: "realm-infra" }), "human:alice");
  store.createContext(ctx("realm-hr", "realm", "Human resources realm"), "human:carol");
  store.createContext(ctx("ch-people", "channel", "Holiday leave vacation people", { realmId: "realm-hr" }), "human:carol");
  store.createContext(ctx("realm-fin", "realm", "Finance realm"), "human:dave");
  store.createContext(ctx("ch-finance", "channel", "Invoices budget finance", { realmId: "realm-fin" }), "human:dave");
  for (const [owner, realm, channel] of [["human:alice", "realm-infra", "ch-incidents"], ["human:carol", "realm-hr", "ch-people"]] as const) {
    store.join({ contextId: realm, actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, `jr-${realm}`, owner);
    store.join({ contextId: channel, actorId: "human:bob", capabilities: ["read", "write"], joinedAt: 2 }, `jc-${channel}`, owner);
  }
  store.addRouter(R);
  return store;
}

function spy(inner: Classifier, failFirst = 0) {
  const seen: ClassifyInput[] = [];
  const c: Classifier & { seen: ClassifyInput[]; calls: number } = {
    name: inner.name, version: inner.version, seen, calls: 0,
    async classify(input) {
      c.calls++;
      seen.push(input);
      if (c.calls <= failFirst) throw new Error("classifier down");
      return inner.classify(input);
    },
  };
  return c;
}
async function hostWith(store: Store, router: RouterHarness, core: CoreClient = new LocalCore(store)) {
  const host = new Host(core);
  await host.add({ actor: R, harness: router });
  return host;
}
const posted = (s: Store, c: string) => s.eventsSince(c, 0).filter((e) => e.type === "message.posted");
const ingress = (s: Store, who: string) => s.eventsSince(`ingress:${who}`, 0);

test("messages find their channel; the classifier is offered only what the sender may address; the rest stays visible to the sender", async () => {
  const store = world();
  const classifier = spy(keywordClassifier());
  const host = await hostWith(store, new RouterHarness({ classifier, mode: "enforce", minConfidence: 0.7, ruleVersion: "r1" }));
  store.submitMessage("human:bob", "a", "production servers outage again");
  store.submitMessage("human:bob", "b", "annual holiday leave request");
  store.submitMessage("human:bob", "c", "invoices budget"); // finance exists, but bob cannot address it
  store.submitMessage("human:bob", "d", "production outage holiday"); // leans one way, not enough
  await host.settle();

  assert.deepEqual(posted(store, "ch-incidents").map((e) => [e.actorId, e.data.text, e.data.via]), [["human:bob", "production servers outage again", "route"]]);
  assert.deepEqual(posted(store, "ch-people").map((e) => [e.actorId, e.data.text]), [["human:bob", "annual holiday leave request"]]);
  assert.equal(posted(store, "ch-finance").length, 0);
  for (const input of classifier.seen) assert.deepEqual(input.targets.map((t) => t.id).sort(), ["ch-incidents", "ch-people", "realm-hr", "realm-infra"], "never a target bob cannot write to");

  const ev = ingress(store, "human:bob");
  const unresolved = ev.filter((e) => e.type === "route.unresolved").map((e) => [e.data.submittedKey, e.data.reason]).sort();
  assert.deepEqual(unresolved, [["c", "no-choice"], ["d", "low-confidence"]]);
  const classified = ev.find((e) => e.type === "route.classified" && e.data.submittedKey === "a")!;
  assert.deepEqual([classified.data.classifier, classified.data.ruleVersion, classified.data.mode, classified.data.choice], [{ name: "keyword", version: "1" }, "r1", "enforce", "ch-incidents"]);
  assert.ok(store.inbox("human:bob").find((c) => c.context === "ingress:human:bob")!.unread >= 6, "bob can see what the router did with his messages");
  assert.equal(store.routePending(R).length, 0);
  assert.equal(await host.tick(), 0);
  store.close();
});

test("shadow mode records what it would do and delivers nothing", async () => {
  const store = world();
  const host = await hostWith(store, new RouterHarness({ classifier: keywordClassifier(), mode: "shadow", minConfidence: 0.5, ruleVersion: "r1" }));
  store.submitMessage("human:bob", "a", "production servers outage again");
  await host.settle();
  assert.equal(posted(store, "ch-incidents").length, 0);
  const r = ingress(store, "human:bob").find((e) => e.type === "route.shadowed")!;
  assert.ok(!ingress(store, "human:bob").some((e) => e.type === "route.resolved"), "resolved always means delivered");
  assert.deepEqual([r.data.context, r.data.delivered, r.data.deliveredSeq], ["ch-incidents", false, null]);
  assert.equal(ingress(store, "human:bob").find((e) => e.type === "route.classified")!.data.mode, "shadow");
  store.close();
});

test("a classifier outage leaves messages pending and is retried; a recorded classification is never paid for twice", async () => {
  const store = world();
  const classifier = spy(keywordClassifier(), 2);
  const local = new LocalCore(store);
  let breakResolve = false;
  const flaky: CoreClient = { async call(as, op, args) { if (op === "route-resolve" && breakResolve) { breakResolve = false; throw new Error("core unreachable"); } return local.call(as, op, args); } };
  const host = await hostWith(store, new RouterHarness({ classifier, mode: "enforce", minConfidence: 0.5, ruleVersion: "r1" }), flaky);
  const errors: string[] = [];
  host.onError = (e) => errors.push(String((e.error as Error).message));

  store.submitMessage("human:bob", "a", "production servers outage again");
  await host.settle();
  assert.equal(errors.length, 2, "two failed passes, then success");
  assert.match(errors[0]!, /classifier down/);
  assert.equal(classifier.calls, 3);
  assert.equal(posted(store, "ch-incidents").length, 1, "delivered once");
  assert.equal(ingress(store, "human:bob").filter((e) => e.type === "route.unresolved").length, 0, "an outage never turns into an unresolved message");

  store.submitMessage("human:bob", "b", "annual holiday leave request");
  breakResolve = true; // classified, then the delivery call fails
  await host.settle();
  assert.equal(classifier.calls, 4, "the second attempt reused the recorded classification");
  assert.equal(posted(store, "ch-people").length, 1);
  assert.equal(ingress(store, "human:bob").filter((e) => e.type === "route.classified" && e.data.submittedKey === "b").length, 1);
  store.close();
});

test("too many targets for one question: realm first, then within it", async () => {
  const store = new Store(":memory:");
  store.createContext(ctx("realm-a", "realm", "Alpha research realm"), "human:alice");
  store.createContext(ctx("ch-a1", "channel", "alpha experiments", { realmId: "realm-a" }), "human:alice");
  store.createContext(ctx("ch-a2", "channel", "alpha papers", { realmId: "realm-a" }), "human:alice");
  store.createContext(ctx("realm-b", "realm", "Beta sales realm"), "human:alice");
  store.createContext(ctx("ch-b1", "channel", "beta pipeline", { realmId: "realm-b" }), "human:alice");
  store.createContext(ctx("ch-b2", "channel", "beta customers", { realmId: "realm-b" }), "human:alice");
  store.addRouter(R);
  const classifier = spy(keywordClassifier());
  const host = await hostWith(store, new RouterHarness({ classifier, mode: "enforce", minConfidence: 0.3, ruleVersion: "r1", maxOptions: 3 }));
  store.submitMessage("human:alice", "a", "beta customers call");
  await host.settle();
  assert.deepEqual(classifier.seen.map((i) => [i.stage, i.targets.length]), [["realm", 2], ["targets", 3]]);
  assert.equal(posted(store, "ch-b2").length, 1);
  const stages = ingress(store, "human:alice").find((e) => e.type === "route.classified")!.data.stages as Array<{ stage: string }>;
  assert.deepEqual(stages.map((s) => s.stage), ["realm", "targets"]);
  store.close();
});

test("whatever the classifier says: an unoffered choice is unresolved, a skill asks for work, and a router needs a sane threshold", async () => {
  assert.throws(() => new RouterHarness({ classifier: keywordClassifier(), mode: "shadow", minConfidence: 1.5, ruleVersion: "r" }), /between 0 and 1/);

  const store = world();
  store.join({ contextId: "realm-infra", actorId: "agent:k8s", capabilities: ["read", "write"], joinedAt: 3 }, "k1", "human:alice");
  store.join({ contextId: "ch-incidents", actorId: "agent:k8s", capabilities: ["read", "write"], joinedAt: 3 }, "k2", "human:alice");
  store.setSkills("agent:k8s", ["k8s.inspect"]);
  const answers: Classification[] = [
    { choice: "ch-finance", probabilities: { "ch-finance": 1 }, confidence: 1 }, // not offered to bob
    { choice: "ch-incidents", probabilities: { "ch-incidents": 1 }, confidence: 1, skill: "k8s.inspect" },
  ];
  const scripted: Classifier = { name: "scripted", version: "1", classify: async () => answers.shift()! };
  const host = await hostWith(store, new RouterHarness({ classifier: scripted, mode: "enforce", minConfidence: 0.5, ruleVersion: "r1" }));
  store.submitMessage("human:bob", "a", "something sneaky");
  store.submitMessage("human:bob", "b", "inspect the checkout pods");
  await host.settle();

  assert.equal(posted(store, "ch-finance").length, 0);
  assert.deepEqual(ingress(store, "human:bob").filter((e) => e.type === "route.unresolved").map((e) => [e.data.submittedKey, e.data.reason]), [["a", "invalid-choice"]]);
  const work = store.claimNext("ch-incidents", "agent:k8s")!.work;
  assert.deepEqual([work.requestedBy, work.skill], ["human:bob", "k8s.inspect"]);
  assert.equal(posted(store, "ch-incidents").length, 0, "asked for work instead of posting");
  store.close();
});

test("a message the classifier keeps rejecting is left unresolved after a few attempts and does not hold up the rest; a wrong setup resolves nothing", async () => {
  const store = world();
  const inner = keywordClassifier();
  const classifier: Classifier = { name: "k", version: "1", async classify(i) { if (i.text.includes("poison")) throw new ClassifierError("message", "rejected"); return inner.classify(i); } };
  const host = await hostWith(store, new RouterHarness({ classifier, mode: "enforce", minConfidence: 0.5, ruleVersion: "r1", maxAttempts: 3 }));
  const errors: string[] = [];
  host.onError = (e) => errors.push(String((e.error as Error).message));
  store.submitMessage("human:bob", "p", "poison production outage");
  store.submitMessage("human:bob", "a", "production servers outage again");
  await host.settle();
  assert.deepEqual(unresolvedOf(store), [["p", "classifier-error"]]);
  assert.equal(posted(store, "ch-incidents").length, 1, "the healthy message was delivered");
  assert.equal(errors.length, 2, "two failed passes, the third attempt gave up on it");

  await host.close(); // one host per actor: the first gives the router up before another serves it
  const config: Classifier = { name: "k", version: "2", async classify() { throw new ClassifierError("config", "bad key"); } };
  const host2 = await hostWith(store, new RouterHarness({ classifier: config, mode: "enforce", minConfidence: 0.5, ruleVersion: "r1" }));
  host2.onError = () => {};
  store.submitMessage("human:bob", "b", "production servers outage again");
  for (let i = 0; i < 6; i++) await host2.tick();
  assert.equal(store.routePending(R).length, 1, "a configuration error never turns messages into unresolved ones");
  assert.deepEqual(unresolvedOf(store), [["p", "classifier-error"]]);
  store.close();
});
function unresolvedOf(s: Store) {
  return s.eventsSince("ingress:human:bob", 0).filter((e) => e.type === "route.unresolved").map((e) => [e.data.submittedKey, e.data.reason]);
}

test("recentLimit: a reply is shown the messages the sender could read before it; nothing from places the sender cannot read; an external classifier only gets allowed realms", async () => {
  const store = world();
  // earlier chat: in incidents (bob reads it), in people (bob reads it), in finance (bob cannot)
  store.postMessage("ch-incidents", "human:alice", "k1", "the checkout service is returning 500s");
  store.postMessage("ch-people", "human:carol", "k2", "who covers the holiday desk?");
  store.postMessage("ch-finance", "human:dave", "k3", "SECRET finance numbers");
  store.postMessage("ch-incidents", "human:bob", "k4", "I am looking at the database");

  const run = async (external: boolean, allowRealms: string[]) => {
    const classifier = Object.assign(spy(keywordClassifier()), { external }); // spy() does not carry the flag over
    const host = await hostWith(store, new RouterHarness({ classifier, mode: "shadow", minConfidence: 0, ruleVersion: external ? "e" : "i", recentLimit: 5, external: { allowRealms } }));
    store.submitMessage("human:bob", `reply-${external}-${allowRealms.join("+")}`, "yes, do that");
    await host.settle();
    await host.close();
    return classifier.seen.at(-1)!.recent;
  };
  assert.deepEqual(await run(false, []), [
    { own: false, text: "the checkout service is returning 500s" },
    { own: false, text: "who covers the holiday desk?" },
    { own: true, text: "I am looking at the database" },
  ]);
  assert.deepEqual(await run(true, ["realm-infra"]), [
    { own: false, text: "the checkout service is returning 500s" },
    { own: true, text: "I am looking at the database" },
  ], "external: only the allowed realm; never finance, which bob cannot read, nor hr, which is not allowed");
  store.close();
});

test("route-recent is for routers only", () => {
  const store = world();
  assert.throws(() => store.routeRecent("human:bob", "human:bob", 100), /router/i);
  store.close();
});

test("route-recent: a message posted in a realm itself belongs to that realm, so an external classifier allowed that realm may see it", () => {
  const store = world();
  store.postMessage("realm-infra", "human:alice", "r1", "realm-wide notice");
  assert.deepEqual(store.routeRecent(R, "human:bob", 1e9, 3).map((r) => [r.context, r.realm]), [["realm-infra", "realm-infra"]]);
  store.close();
});

test("a malformed classifier answer never routes: NaN, missing, string or out-of-range confidence, null, wrong types", async () => {
  const bad: Array<[string, unknown]> = [
    ["NaN", { choice: "ch-incidents", probabilities: {}, confidence: Number.NaN }],
    ["missing", { choice: "ch-incidents", probabilities: {} }],
    ["string", { choice: "ch-incidents", probabilities: {}, confidence: "0.99" }],
    ["above 1", { choice: "ch-incidents", probabilities: {}, confidence: 2 }],
    ["negative", { choice: "ch-incidents", probabilities: {}, confidence: -1 }],
    ["null", null],
    ["a string", "ch-incidents"],
    ["choice a number", { choice: 7, probabilities: {}, confidence: 1 }],
    ["skill a number", { choice: "ch-incidents", probabilities: {}, confidence: 1, skill: 5 }],
    ["no probabilities", { choice: "ch-incidents", confidence: 1 }],
  ];
  for (const [name, answer] of bad) {
    const store = world();
    const classifier: Classifier = { name: "fake", version: "1", async classify() { return answer as never; } };
    const host = await hostWith(store, new RouterHarness({ classifier, mode: "enforce", minConfidence: 0.5, ruleVersion: "r1", maxAttempts: 2 }));
    host.onError = () => {};
    store.submitMessage("human:bob", "k1", "production outage");
    for (let i = 0; i < 4; i++) await host.settle(2).catch(() => {});
    assert.equal(posted(store, "ch-incidents").length, 0, `${name}: nothing delivered`);
    const un = ingress(store, "human:bob").filter((e) => e.type === "route.unresolved").map((e) => e.data.reason);
    assert.deepEqual(un, ["classifier-error"], `${name}: left unresolved after the attempts, not pending for ever`);
    await host.close();
    store.close();
  }
});
