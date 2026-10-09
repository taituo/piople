import test from "node:test";
import assert from "node:assert/strict";
import { ACTOR, world, serve } from "./support/roles.ts";

/**
 * Wrong and hostile input at the door: types, sizes, prototype keys, odd methods. The answer is always a plain
 * 4xx with a message, never a 500, never a crash, never someone else's data. Shape from Entropi's input suite.
 */
const A = ACTOR.owner;

test("bodies that are not objects get a 400, never a 500", async () => {
  const s = await serve(world());
  try {
    for (const raw of ["null", "123", '"str"', "[]", "[1,2]", "true", "{", "", '{"text":', "\u0000", "{'a':1}"]) {
      const r = await s.call(A, "POST", "/api/v1/messages", undefined, raw);
      assert.equal(r.status, 400, `body ${JSON.stringify(raw)} -> ${r.status}`); // "" parses as {} and lacks its fields
    }
    assert.equal((await s.call(A, "GET", "/healthz")).status, 200, "still alive");
  } finally { await s.close(); }
});

test("wrong types and sizes in every field are 400s", async () => {
  const s = await serve(world());
  try {
    const bad: unknown[] = [{}, [], 123, true, null, ["a"], "", "   ", "\n\t"];
    for (const text of bad) {
      const r = await s.call(A, "POST", "/api/v1/messages", { context: "c1", text });
      assert.equal(r.status, 400, `text ${JSON.stringify(text)} -> ${r.status}`);
    }
    for (const context of [{}, [], 5, "a b", "x".repeat(200), "../etc", "a/b", "<script>", ""]) {
      const r = await s.call(A, "POST", "/api/v1/messages", { context, text: "x" });
      assert.ok([400, 403].includes(r.status), `context ${JSON.stringify(context)} -> ${r.status}`);
    }
    assert.equal((await s.call(A, "POST", "/api/v1/messages", { context: "c1", text: "x".repeat(4001) })).status, 400, "4001 characters");
    assert.equal((await s.call(A, "POST", "/api/v1/messages", { context: "c1", text: "x".repeat(4000) })).status, 200, "exactly 4000 is fine");
    assert.equal((await s.call(A, "POST", "/api/v1/messages", { context: "c1", text: "é".repeat(3000) + "😀".repeat(500) })).status, 200, "characters, not bytes");
    assert.equal((await s.call(A, "POST", "/api/v1/messages", undefined, JSON.stringify({ context: "c1", text: "x".repeat(300_000) }))).status, 413, "a huge body");
    for (const evidence of ["a", 5, [1], [{}], Array(60).fill("x")]) assert.equal((await s.call(A, "POST", "/api/v1/observations", { context: "c1", text: "t", evidence })).status, 400, `evidence ${JSON.stringify(evidence).slice(0, 20)}`);
    assert.equal((await s.call(A, "POST", "/api/v1/observations", { context: "c1", text: "t", status: "certain" })).status, 400);
    assert.equal((await s.call(A, "POST", "/api/v1/decisions", { context: "c1", question: "q", options: ["only-one"] })).status, 400);
    assert.equal((await s.call(A, "POST", "/api/v1/decisions", { context: "c1", question: "q", options: ["a", "a"] })).status, 400);
    assert.equal((await s.call(A, "POST", "/api/v1/presence", { state: "dancing" })).status, 400);
    assert.equal((await s.call(A, "POST", "/api/v1/join", { context: "c1", capabilities: "all" })).status, 400);
    assert.equal((await s.call(A, "POST", "/api/v1/join", { context: "c1", member: "agent:x", capabilities: ["root"] })).status, 400);
  } finally { await s.close(); }
});

test("prototype keys and odd ids change nothing and never crash", async () => {
  const s = await serve(world());
  try {
    const r = await s.call(A, "POST", "/api/v1/messages", undefined, '{"context":"c1","text":"p","__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}');
    assert.equal(r.status, 200);
    assert.equal(({} as any).admin, undefined, "Object.prototype was not polluted");
    assert.equal(({} as any).x, undefined);
    for (const idv of ["__proto__", "constructor", "toString", "hasOwnProperty", "prototype", "valueOf"]) {
      for (const [path, body] of [
        ["/api/v1/messages", { context: idv, text: "x" }],
        ["/api/v1/decisions", { context: "c1", decisionId: idv, answer: "yes" }],
        ["/api/v1/promote", { artifactId: idv }],
        ["/api/v1/assistance", { context: "c1", requestKey: idv, answer: "x" }],
      ] as const) {
        const res = await s.call(ACTOR.owner, "POST", path, body);
        assert.ok(res.status >= 400 && res.status < 500, `${path} ${idv} -> ${res.status}`);
      }
      assert.equal((await s.call(ACTOR.owner, "GET", `/events?context=${idv}`)).status, 403);
    }
  } finally { await s.close(); }
});

test("unknown routes are 404, wrong methods 405, identity is mandatory and malformed identity is refused", async () => {
  const s = await serve(world());
  try {
    assert.equal((await s.call(A, "GET", "/nothing")).status, 404);
    assert.equal((await s.call(A, "POST", "/nothing", {})).status, 404);
    assert.equal((await s.call(A, "GET", "/api/v1/messages")).status, 405);
    assert.equal((await s.call(A, "POST", "/events", {})).status, 405);
    assert.equal((await s.call(undefined, "POST", "/api/v1/messages", { context: "c1", text: "x" })).status, 403, "no identity");
    assert.equal((await s.call("human:alice\nx-evil: 1", "POST", "/api/v1/messages", { context: "c1", text: "x" }).catch(() => ({ status: 403 }))).status, 403);
    assert.equal((await s.call("a b", "POST", "/api/v1/messages", { context: "c1", text: "x" })).status, 403, "malformed identity");
    const err = await s.call(A, "POST", "/api/v1/messages", { context: "c1", text: 5 });
    assert.match(String(err.json.error), /^bad-request/);
    assert.ok(!/at .*\.ts/.test(JSON.stringify(err.json)), "no stack traces leak");
  } finally { await s.close(); }
});

test("a case you are not in and a case that does not exist look the same", async () => {
  const s = await serve(world());
  try {
    const a = await s.call(ACTOR.stranger, "GET", "/events?context=c1");
    const b = await s.call(ACTOR.stranger, "GET", "/events?context=nope");
    assert.deepEqual([a.status, a.json], [b.status, b.json]);
    const c = await s.call(ACTOR.stranger, "POST", "/api/v1/messages", { context: "c1", text: "x" });
    const d = await s.call(ACTOR.stranger, "POST", "/api/v1/messages", { context: "nope", text: "x" });
    assert.equal(c.status, d.status);
  } finally { await s.close(); }
});

test("two deciders at once: exactly one wins, the other gets a conflict", async () => {
  const s = await serve(world());
  try {
    const rs = await Promise.all([ACTOR.owner, ACTOR.decider].map((a) => s.call(a, "POST", "/api/v1/decisions", { context: "c1", decisionId: "d1", answer: "yes" })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    const resolved = s.store.eventsSince("c1", 0).filter((e) => e.type === "decision.resolved");
    assert.equal(resolved.length, 1);
  } finally { await s.close(); }
});

test("the same idempotency key twice is the same event; a repeated decide replays instead of conflicting", async () => {
  const s = await serve(world());
  try {
    const a = await s.call(A, "POST", "/api/v1/messages", { context: "c1", text: "once", key: "k-1" });
    const b = await s.call(A, "POST", "/api/v1/messages", { context: "c1", text: "once", key: "k-1" });
    assert.equal(a.json.event.seq, b.json.event.seq);
    const d1 = await s.call(A, "POST", "/api/v1/decisions", { context: "c1", decisionId: "d1", answer: "yes", key: "dk" });
    const d2 = await s.call(A, "POST", "/api/v1/decisions", { context: "c1", decisionId: "d1", answer: "yes", key: "dk" });
    assert.deepEqual([d1.status, d2.status, d1.json.event.seq === d2.json.event.seq], [200, 200, true]);
  } finally { await s.close(); }
});

test("focus lists what needs you; proxy mode takes identity from the header only", async () => {
  const s = await serve(world(), { authMode: "proxy" });
  try {
    assert.deepEqual((await s.call(A, "GET", "/api/v1/focus")).json.needsYou.map((x: any) => x.decisionId), ["d1"]);
    assert.deepEqual((await s.call(ACTOR.reader, "GET", "/api/v1/focus")).json.needsYou, []);
    assert.equal((await s.call(undefined, "GET", "/api/v1/focus")).status, 403);
    const spoof = await s.call(undefined, "POST", "/api/v1/messages", { context: "c1", text: "x", actorId: A });
    assert.equal(spoof.status, 403, "body identity is ignored in proxy mode");
  } finally { await s.close(); }
});

test("creating a case that exists is a conflict, and the creator can invite others with a bounded grant", async () => {
  const s = await serve(world());
  try {
    assert.equal((await s.call(A, "POST", "/api/v1/contexts", { id: "c1" })).status, 409);
    const fresh = await s.call(A, "POST", "/api/v1/contexts", { id: "c2", title: "two" });
    assert.equal(fresh.status, 200);
    assert.equal((await s.call(A, "POST", "/api/v1/join", { context: "c2", member: ACTOR.writer, capabilities: ["read", "write"] })).status, 200);
    assert.equal((await s.call(ACTOR.writer, "POST", "/api/v1/messages", { context: "c2", text: "hello" })).status, 200);
    assert.equal((await s.call(ACTOR.writer, "POST", "/api/v1/join", { context: "c2", member: ACTOR.reader, capabilities: ["read", "decide"] })).status, 403, "cannot grant what you do not hold");
  } finally { await s.close(); }
});
