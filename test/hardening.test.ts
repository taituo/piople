import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { LocalCore } from "../src/hosts/host.ts";
import { opDef } from "../src/ops.ts";

/** Found by probing the Core with hostile and sloppy input. */
function world() {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const as = (a: string) => (op: string, args: Record<string, unknown> = {}) => core.call(a, op, args) as Promise<any>;
  return { store, alice: as("human:alice"), bob: as("human:bob"), as };
}

test("a decision can only be answered with one of its options", async () => {
  const { alice, bob, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("decision-request", { context: "c1", id: "d1", question: "ok?", options: "yes,no" });
  await assert.rejects(alice("decide", { context: "c1", decision: "d1", answer: "maybe" }), /bad-answer/);
  assert.equal(store.getDecision("c1", "d1")!.status, "open", "a refused answer leaves the decision open");
  await alice("decide", { context: "c1", decision: "d1", answer: "no" });
  assert.equal(store.getDecision("c1", "d1")!.status, "resolved");
  await alice("decision-request", { context: "c1", id: "d2", question: "no options given?" }); // the default options are yes,no
  await assert.rejects(alice("decide", { context: "c1", decision: "d2", answer: "whatever" }), /bad-answer: "whatever" is not one of yes, no/);
  await alice("decide", { context: "c1", decision: "d2", answer: "yes" });
  void bob;
  store.close();
});

test("ids and actors are validated at the door", async () => {
  const { alice, as, store } = world();
  await assert.rejects(alice("create", { id: " ", title: "t" }), /missing|bad-context/);
  await assert.rejects(alice("create", { id: "x".repeat(201), title: "t" }), /too-large: id|bad-context/);
  await assert.rejects(as("justabob")("actor"), /bad-actor/);
  await assert.rejects(as("")("actor"), /bad-actor/);
  await alice("create", { id: "c1", title: "t" });
  await assert.rejects(alice("join", { context: "c1", actor: "mallory", caps: "read" }), /bad-actor/);
  await assert.rejects(alice("work-request", { context: "c1", to: "nobody-prefix", input: "{}" }), /bad-actor/);
  store.close();
});

test("text must be text: blank and structured values are refused, not stored as [object Object]", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await assert.rejects(alice("post", { context: "c1", text: "   " }), /missing: text/);
  await assert.rejects(alice("post", { context: "c1", text: { a: 1 } }), /bad-arg/);
  await assert.rejects(alice("post", { context: "c1", text: ["a"] }), /bad-arg/);
  await alice("post", { context: "c1", text: "😀 ok" });
  assert.ok(!store.eventsSince("c1", 0).some((e) => JSON.stringify(e.data).includes("[object Object]")));
  store.close();
});

test("a membership needs at least one capability", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await assert.rejects(alice("join", { context: "c1", actor: "human:bob", caps: "" }), /bad-caps/);
  store.close();
});

test("op names that exist on every object are not ops", async () => {
  const { alice, store } = world();
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(opDef(name), undefined, name);
    await assert.rejects(alice(name), /unknown-op/, name);
  }
  store.close();
});

test("reusing an id in another context is a clean conflict, not a database error", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("create", { id: "c2", title: "t" });
  await alice("decision-request", { context: "c1", id: "d1", question: "first?" });
  await assert.rejects(alice("decision-request", { context: "c2", id: "d1", question: "second?" }), /^Error: id-in-use: that decision id already exists/);
  await alice("observe", { context: "c1", id: "o1", text: "one" });
  await assert.rejects(alice("observe", { context: "c2", id: "o1", text: "two" }), /id-in-use/);
  const { statusFor } = await import("../src/http/server.ts");
  assert.deepEqual(statusFor("id-in-use: that decision id already exists"), { status: 409, code: "conflict" });
  assert.equal(store.getDecision("c1", "d1")!.status, "open", "the original is untouched");
  assert.equal(store.getDecision("c2", "d1"), undefined, "nothing was half-written in the other context");
  store.close();
});

test("size limits hold for every caller, not only HTTP: a huge title, id or message is refused with too-large", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await assert.rejects(alice("create", { id: "c2", title: "x".repeat(2_001) }), /^Error: too-large: title is 2001 characters, the limit is 2000/);
  await assert.rejects(alice("post", { context: "c1", text: "y".repeat(1_000_001) }), /too-large: text/);
  await assert.rejects(alice("work-request", { context: "c1", to: "human:alice", input: { a: "z".repeat(1_100_000) } as never }), /too-large: input/);
  await alice("post", { context: "c1", text: "y".repeat(1_000_000) }); // generous: the limit itself is allowed
  await alice("create", { id: "c3", title: "x".repeat(2_000) });
  const { statusFor } = await import("../src/http/server.ts");
  assert.deepEqual(statusFor("too-large: text is 5 characters, the limit is 1"), { status: 413, code: "too-large" });
  store.close();
});

test("promote takes only confirmed or refuted; anything else is refused and the finding keeps its status", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("observe", { context: "c1", id: "o1", text: "the pool is empty" });
  for (const bad of ["banana", "CONFIRMED", "hypothesis", "confirmed "]) await assert.rejects(alice("promote", { artifact: "o1", status: bad }), /bad-status/, bad);
  const status = () => (store.db.prepare("SELECT status FROM artifacts WHERE id='o1'").get() as { status: string }).status;
  assert.equal(status(), "hypothesis", "nothing changed");
  await alice("promote", { artifact: "o1", status: "confirmed" });
  assert.equal(status(), "confirmed");
  await alice("promote", { artifact: "o1", status: "refuted" });
  assert.equal(status(), "refuted", "a finding may still be refuted later");
  store.close();
});

test("presence: the state and echo flag are checked; a typo must not silently turn echo off", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  for (const bad of ["banana", "AWAY", "Active"]) await assert.rejects(alice("presence", { state: bad }), /bad-state/, bad);
  for (const bad of ["yes", "1", "maybe", 2]) await assert.rejects(alice("presence", { state: "away", echo: bad }), /bad-echo/, String(bad));
  const row = () => store.db.prepare("SELECT state, echo FROM presence WHERE actor_id='human:alice'").get() as { state: string; echo: number } | undefined;
  assert.equal(row(), undefined, "refused calls changed nothing");
  await alice("presence", { state: "away", echo: "true" });
  assert.deepEqual({ ...row() }, { state: "away", echo: 1 });
  await alice("presence", { state: "active", echo: false });
  assert.deepEqual({ ...row() }, { state: "active", echo: 0 });
  await alice("presence", { state: "silent" }); // echo omitted: off
  assert.deepEqual({ ...row() }, { state: "silent", echo: 0 });
  store.close();
});

test("yes/no arguments are true or false; a typo is an error, so `retry yes` cannot silently end a work item for good", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("work-request", { context: "c1", id: "w1", to: "human:alice", input: "{}" });
  const claim = await alice("work-claim", { context: "c1", id: "w1" });
  for (const bad of ["yes", "1", "True", "TRUE", 1]) await assert.rejects(alice("work-fail", { context: "c1", id: "w1", attempt: claim.work.attempt, reason: "x", retry: bad }), /bad-flag/, String(bad));
  assert.equal(store.getWork("c1", "w1")!.status, "claimed", "the refused calls changed nothing");
  await alice("work-fail", { context: "c1", id: "w1", attempt: claim.work.attempt, reason: "flaky", retry: "true" });
  assert.equal(store.getWork("c1", "w1")!.status, "open", "retry true reopens the work");
  await assert.rejects(alice("work-claim", { context: "c1", next: "yes" }), /bad-flag/);
  store.close();
});

test("comma-separated lists are trimmed: options 'yes, no' means yes and no, caps 'read, write' means read and write", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("decision-request", { context: "c1", id: "d1", question: "q?", options: "yes, no," });
  assert.deepEqual(store.pending("c1", "human:alice").decisions[0]!.options, ["yes", "no"]);
  await alice("decide", { context: "c1", decision: "d1", answer: "no" });
  for (const blank of [",", " ", " , "]) await assert.rejects(alice("decision-request", { context: "c1", id: "d2", question: "q?", options: blank }), /bad-options/, JSON.stringify(blank));
  await alice("join", { context: "c1", actor: "human:bob", caps: " read , write " });
  assert.deepEqual(JSON.parse((store.db.prepare("SELECT capabilities FROM members WHERE actor_id='human:bob'").get() as { capabilities: string }).capabilities), ["read", "write"]);
  store.close();
});

test("a bad cursor is an error, not an empty answer; a lease has an upper bound", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("post", { context: "c1", text: "m" });
  for (const bad of ["abc", "Infinity", "NaN"]) await assert.rejects(alice("events", { context: "c1", after: bad }), /bad-seq/, bad);
  assert.equal((await alice("events", { context: "c1", after: "0" })).length, 2);
  assert.equal((await alice("events", { context: "c1", after: "-5" })).length, 2, "a negative cursor reads from the start");
  assert.equal((await alice("events", { context: "c1" })).length, 2, "no cursor reads from the start");
  const { MAX_LEASE_MS } = await import("../src/core/store.ts");
  await alice("work-request", { context: "c1", id: "w1", to: "human:alice", input: "{}" });
  for (const bad of [MAX_LEASE_MS + 1, 99_999_999_999_999]) await assert.rejects(alice("work-claim", { context: "c1", id: "w1", "lease-ms": bad }), /bad-lease/, String(bad));
  const ok = await alice("work-claim", { context: "c1", id: "w1", "lease-ms": MAX_LEASE_MS });
  assert.ok(ok.work.leaseUntil - Date.now() <= MAX_LEASE_MS, "the longest lease is allowed");
  store.close();
});

test("declared skills are bounded: 100 at most, 200 characters each", async () => {
  const { as, store } = world();
  const bob = as("agent:bob");
  await bob("actor", { skills: Array.from({ length: 100 }, (_, i) => `s${i}`).join(",") });
  await assert.rejects(bob("actor", { skills: Array.from({ length: 101 }, (_, i) => `s${i}`).join(",") }), /bad-skills/);
  await assert.rejects(bob("actor", { skills: "x".repeat(201) }), /bad-skills/);
  assert.equal(JSON.parse((store.db.prepare("SELECT skills FROM actors WHERE id='agent:bob'").get() as { skills: string }).skills).length, 100, "the refused calls changed nothing");
  store.close();
});

test("leaving a realm with a key that is taken in an inner context works; a real collision is a clean key-conflict and changes nothing", async () => {
  const { alice, as, store } = world();
  const bob = as("human:bob");
  await alice("create", { id: "r1", title: "Realm", kind: "realm" });
  await alice("join", { context: "r1", actor: "human:bob", caps: "read,write" });
  await alice("create", { id: "ch1", title: "Channel", kind: "channel", realm: "r1" });
  await alice("join", { context: "ch1", actor: "human:bob", caps: "read,write" });
  await alice("post", { context: "ch1", text: "someone used k1 here", key: "k1" });
  await bob("leave", { context: "r1", key: "k1" }); // used to fail with a raw UNIQUE constraint error
  const members = (c: string) => (store.db.prepare("SELECT actor_id FROM members WHERE context_id=?").all(c) as Array<{ actor_id: string }>).map((m) => m.actor_id);
  assert.deepEqual([members("r1"), members("ch1")], [["human:alice"], ["human:alice"]], "bob left the realm and the channel inside it");
  assert.ok(store.eventsSince("ch1", 0).some((e) => e.type === "member.removed" && e.key === "k1@ch1"));

  await alice("join", { context: "r1", actor: "human:bob", caps: "read,write" });
  await alice("join", { context: "ch1", actor: "human:bob", caps: "read,write" });
  await alice("post", { context: "ch1", text: "occupies the derived key", key: "k2@ch1" });
  await assert.rejects(bob("leave", { context: "r1", key: "k2" }), /^Error: key-conflict/);
  assert.deepEqual([members("r1").sort(), members("ch1").sort()], [["human:alice", "human:bob"], ["human:alice", "human:bob"]], "the refused leave changed nothing");
  store.close();
});

test("ids cannot contain control characters: an ESC sequence in an id would drive the terminal of whoever reads an error message", async () => {
  const { alice, as, store } = world();
  const ESC = "\u001b";
  await alice("create", { id: "c1", title: "t" });
  await assert.rejects(alice("create", { id: `evil${ESC}[2Jid`, title: "t" }), /bad-arg: id contains a control character/);
  await assert.rejects(alice("post", { context: `c1${ESC}`, text: "x" }), /bad-arg: context contains a control character/);
  await assert.rejects(alice("work-request", { context: "c1", id: "w\u0007", to: "human:alice", input: "{}" }), /bad-arg: id/);
  await assert.rejects(as(`human:eve${ESC}[31m`)("actor"), /bad-actor/);
  await assert.rejects(alice("join", { context: "c1", actor: `human:eve${ESC}[31m`, caps: "read" }), /bad-actor/);
  await assert.rejects(alice("post", { context: "c1", text: "x", key: "k\u0000" }), /bad-arg: key/);
  assert.throws(() => store.createContext({ id: `x${ESC}y`, kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice"), /bad-context/, "also straight at the Store");
  await alice("post", { context: "c1", text: `text may still contain ${ESC}: it is printed through printable() where it is shown to a person` });
  await alice("create", { id: "ääkköset-😀-ok", title: "t" }); // non-ASCII ids stay fine
});

test("deeply nested JSON is refused with a plain 400, not a stack overflow (HTTP 500)", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  const nested = (depth: number): unknown => { let v: unknown = []; for (let i = 1; i < depth; i++) v = [v]; return v; };
  const asText = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
  const { statusFor } = await import("../src/http/server.ts");
  for (const depth of [65, 5_000, 200_000]) {
    for (const call of [
      () => alice("work-request", { context: "c1", id: `w${depth}`, to: "human:alice", input: nested(depth) as never }),
      () => alice("work-request", { context: "c1", id: `v${depth}`, to: "human:alice", input: asText(depth) }),
      () => alice("post", { context: "c1", text: "x", key: `k${depth}`, extra: nested(depth) as never }),
    ]) {
      await assert.rejects(call(), (e: Error) => /^bad-arg: .*nested deeper than 64 levels/.test(e.message) && statusFor(e.message).status === 400, `depth ${depth}`);
    }
  }
  await alice("work-request", { context: "c1", id: "w-ok", to: "human:alice", input: nested(64) as never }); // the limit itself is allowed
  await alice("work-request", { context: "c1", id: "w-ok2", to: "human:alice", input: asText(64) });
  assert.equal(store.getWork("c1", "w65"), undefined, "nothing was stored by the refused calls");
  store.close();
});

test("an id that is not in Unicode normal form is refused: it would look exactly like the normal one", async () => {
  const { alice, store, as } = world();
  const nfc = "äiti", nfd = "äiti";
  assert.notEqual(nfc, nfd);
  await alice("create", { id: nfc, title: "t" });
  await assert.rejects(alice("create", { id: nfd, title: "t" }), /NFC|bad-context/, "a case id");
  await assert.rejects(alice("join", { context: nfc, actor: `human:${nfd}`, caps: "read,write" }), /bad-actor/, "a member");
  await assert.rejects(as(`human:${nfd}`)("actor"), /bad-actor/, "an acting identity");
  assert.throws(() => store.createContext({ id: nfd, kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice"), /bad-context/);
  await alice("create", { id: "ääkköset-ok", title: "t" }); // normal Finnish text is untouched
  store.close();
});

test("ids cannot hide characters: zero-width, direction overrides, soft hyphens and unusual spaces are refused", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  for (const ch of ["​", "‍", "‮", "⁠", "­", "﻿", " ", " "]) {
    await assert.rejects(alice("join", { context: "c1", actor: `human:ali${ch}ce2`, caps: "read" }), /bad-actor/, `actor with U+${ch.codePointAt(0)!.toString(16)}`);
    await assert.rejects(alice("create", { id: `c${ch}2`, title: "t" }), /bad-arg|bad-context/, `context with U+${ch.codePointAt(0)!.toString(16)}`);
  }
  assert.throws(() => store.createContext({ id: "c​3", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice"), /bad-context/);
  await alice("create", { id: "ääkköset 😀 ok", title: "t" }); // visible text, Finnish letters, emoji and an ordinary space stay fine
  store.close();
});

test("one read of a case is bounded in bytes: a writer cannot make every poll a hundred megabytes, and a reader still gets everything page by page", async () => {
  const { alice, as, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:x", caps: "read,write" });
  const big = "y".repeat(999_000);
  for (let i = 0; i < 12; i++) await alice("post", { context: "c1", text: `${i}:${big}`, key: `k${i}` });
  const agent = as("agent:x");
  const seen: string[] = [];
  for (let page = 0; page < 20; page++) {
    const inbox = await agent("inbox", { context: "c1" });
    if (!inbox.events.length) break;
    const bytes = JSON.stringify(inbox.events).length;
    assert.ok(bytes < 5_500_000, `a page was ${bytes} bytes`);
    for (const e of inbox.events) if (e.type === "message.posted") seen.push(String(e.data.text).split(":")[0]!);
    await agent("ack", { context: "c1", seq: inbox.events.at(-1).seq });
  }
  assert.deepEqual(seen, Array.from({ length: 12 }, (_, i) => String(i)), "every message arrived, in order, none twice");
  const first = await agent("events", { context: "c1", after: 0, limit: 1000 });
  assert.ok(first.length >= 1 && first.length < 8, `events returned ${first.length} at once`);
  store.close();
});

test("the open work an inbox lists is bounded too: whoever may request work cannot make an agent's inbox (and prompt) enormous", async () => {
  const { alice, as, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:x", caps: "read,write" });
  const big = JSON.stringify({ blob: "z".repeat(90_000) });
  for (let i = 0; i < 30; i++) await alice("work-request", { context: "c1", id: `w${i}`, to: "agent:x", input: big });
  const agent = as("agent:x");
  const first = await agent("inbox", { context: "c1" });
  const chars = JSON.stringify(first.pending.work.open).length;
  assert.ok(first.pending.work.open.length >= 1 && first.pending.work.open.length < 30, `listed ${first.pending.work.open.length}`);
  assert.ok(chars < 400_000, `the open list was ${chars} characters`);
  assert.equal(first.pending.work.moreOpen, 30 - first.pending.work.open.length, "and says how many were left out");
  // taking the listed ones brings the rest into view; nothing is lost
  const taken = new Set<string>();
  for (let round = 0; round < 40; round++) {
    const inbox = await agent("inbox", { context: "c1" });
    if (!inbox.pending.work.open.length) break;
    for (const w of inbox.pending.work.open) {
      const c = await agent("work-claim", { context: "c1", id: w.id });
      await agent("work-complete", { context: "c1", id: w.id, attempt: c.work.attempt, result: "1" });
      taken.add(w.id);
    }
  }
  assert.equal(taken.size, 30, "every item was offered in the end");
  store.close();
});

test("open asks and decisions in an inbox are bounded as well, and the rest follows as they are answered", async () => {
  const { alice, as, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:x", caps: "read,write,decide" });
  for (let i = 0; i < 60; i++) await alice("ask", { context: "c1", to: "agent:x", question: `${i}:` + "q".repeat(19_000), key: `a${i}` });
  for (let i = 0; i < 5; i++) await alice("decision-request", { context: "c1", id: `d${i}`, question: "ship?", options: Array.from({ length: 2_000 }, (_, j) => `option-number-${j}`).join(",") });
  const agent = as("agent:x");
  const first = await agent("inbox", { context: "c1" });
  const asks = JSON.stringify(first.pending.assistance).length, decisions = JSON.stringify(first.pending.decisions).length;
  assert.ok(first.pending.assistance.length >= 1 && asks < 400_000, `asks listed ${first.pending.assistance.length}, ${asks} characters`);
  assert.equal(first.pending.moreAssistance, 60 - first.pending.assistance.length);
  assert.ok(first.pending.decisions.length >= 1 && decisions < 400_000, `decisions listed ${first.pending.decisions.length}, ${decisions} characters`);
  assert.equal(first.pending.moreDecisions, 5 - first.pending.decisions.length);
  const answered = new Set<string>();
  for (let round = 0; round < 80; round++) {
    const inbox = await agent("inbox", { context: "c1" });
    if (!inbox.pending.assistance.length) break;
    for (const a of inbox.pending.assistance) { await agent("answer", { context: "c1", request: a.key, answer: "ok" }); answered.add(a.key); }
  }
  assert.equal(answered.size, 60, "every ask was shown in the end");
  store.close();
});

test("work-list is bounded in bytes too, and the first item always comes", async () => {
  const { alice, as, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:x", caps: "read,write" });
  const big = JSON.stringify({ blob: "z".repeat(900_000) });
  for (let i = 0; i < 12; i++) await alice("work-request", { context: "c1", id: `w${i}`, to: "agent:x", input: big });
  const listed = await as("agent:x")("work-list", { context: "c1", status: "claimable" });
  const bytes = JSON.stringify(listed).length;
  assert.ok(listed.length >= 1 && listed.length < 12 && bytes < 5_500_000, `listed ${listed.length} items, ${bytes} bytes`);
  assert.equal(listed[0].id, "w0", "oldest first");
  assert.equal((await as("agent:x")("work-list", { context: "c1", id: "w11" })).length, 1, "one item by id is always reachable");
  store.close();
});

test("the exact edges of the inbox list bounds: 50 items fit, the 51st does not; 200,000 characters fit, one more does not", async () => {
  const { alice, as, store } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:x", caps: "read,write" });
  for (let i = 0; i < 51; i++) await alice("work-request", { context: "c1", id: `s${i}`, to: "agent:x", input: "{}" });
  const byCount = (await as("agent:x")("inbox", { context: "c1" })).pending;
  assert.equal(byCount.work.open.length, 50, "50 fit");
  assert.equal(byCount.work.moreOpen, 1, "the 51st is counted as left out");
  // a second context: items of exactly 50,000 characters each (the JSON of a 49,998 character string), so four make 200,000
  await alice("create", { id: "c2", title: "t" });
  await alice("join", { context: "c2", actor: "agent:x", caps: "read,write" });
  const item = JSON.stringify("x".repeat(49_998));
  assert.equal(item.length, 50_000);
  for (let i = 0; i < 5; i++) await alice("work-request", { context: "c2", id: `b${i}`, to: "agent:x", input: item });
  const bySize = (await as("agent:x")("inbox", { context: "c2" })).pending;
  assert.equal(bySize.work.open.length, 4, "four items of 50,000 are exactly 200,000: they fit");
  assert.equal(bySize.work.moreOpen, 1, "the fifth is one item over");
  store.close();
});

test("a name that is new must be in Unicode normal form (id and key arguments), while what refers to something that exists is not held to it", async () => {
  const { alice, store } = world();
  await alice("create", { id: "c1", title: "t" });
  const nfc = "p\u00e4\u00e4t\u00f6s", nfd = "pa\u0308a\u0308to\u0308s";
  assert.notEqual(nfc, nfd);
  await assert.rejects(alice("decision-request", { context: "c1", id: nfd, question: "q", options: "a,b" }), /bad-arg: id is not in Unicode normal form/);
  await assert.rejects(alice("work-request", { context: "c1", id: nfd, to: "human:alice", input: "{}" }), /bad-arg: id is not in Unicode normal form/);
  await assert.rejects(alice("observe", { context: "c1", id: nfd, text: "x" }), /bad-arg: id is not in Unicode normal form/);
  await assert.rejects(alice("post", { context: "c1", text: "x", key: nfd }), /bad-arg: key is not in Unicode normal form/);
  await alice("decision-request", { context: "c1", id: nfc, question: "q", options: "a,b" }); // the normal form works
  await alice("work-request", { context: "c1", id: nfc, to: "human:alice", input: "{}" });
  // a reference is looked up, not created: it is not refused for its form (it simply does not exist)
  await assert.rejects(alice("decide", { context: "c1", decision: nfd, answer: "a" }), (e: Error) => !/normal form/.test(e.message));
  await assert.rejects(alice("answer", { context: "c1", request: nfd, answer: "a" }), (e: Error) => !/normal form/.test(e.message));
  store.close();
});
