import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";

function world() {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  return { store, core, alice };
}

test("a key the caller chose names one request: the same key with other content is a key-conflict, with the same content a replay", async () => {
  const { store, alice } = world();
  await alice("create", { id: "c1", title: "t" });
  const first = await alice("post", { context: "c1", text: "hello", key: "k1" });
  const again = await alice("post", { context: "c1", text: "hello", key: "k1" });
  assert.equal(again.seq, first.seq, "same request, same key: the original event");
  await assert.rejects(alice("post", { context: "c1", text: "other", key: "k1" }), /key-conflict: k1 in c1 was already used for a different request/);
  await assert.rejects(alice("post", { context: "c1", text: "hello", key: "k1", extra: 1 }), /key-conflict/, "any change of the request counts");
  assert.equal(store.eventsSince("c1", 0).filter((e) => e.type === "message.posted").length, 1, "nothing was written by the refused calls");
  const { statusFor } = await import("../src/http/server.ts");
  assert.equal(statusFor("key-conflict: k1 in c1 was already used for a different request").status, 409);
  store.close();
});

test("without a key, or with a host-derived key, nothing changes: deterministic defaults still replay, derived keys tolerate other content", async () => {
  const { store, alice } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("decision-request", { context: "c1", id: "d1", question: "ok?" });
  const a = await alice("decide", { context: "c1", decision: "d1", answer: "yes" });
  const b = await alice("decide", { context: "c1", decision: "d1", answer: "no" }); // deterministic default key: replay, as before
  assert.equal(b.seq, a.seq);
  const p1 = await alice("post", { context: "c1", text: "A", key: "host-key", "derived-key": true });
  const p2 = await alice("post", { context: "c1", text: "B", key: "host-key", "derived-key": true });
  assert.equal(p2.seq, p1.seq, "a derived key replays whatever content comes back");
  store.close();
});

test("events written before the check existed carry no hash and replay as before", async () => {
  const { store, alice } = world();
  await alice("create", { id: "c1", title: "t" });
  store.postMessage("c1", "human:alice", "old", "written by an older version"); // no call hash: like an event from before migration 12
  const r = await alice("post", { context: "c1", text: "different now", key: "old" });
  assert.equal(r.data.text, "written by an older version", "the old event is replayed, no error");
  store.close();
});

test("a host step that is retried may send other content under the same derived key: the original event stands and the step completes", async () => {
  const { store, core, alice } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:x", caps: "read,write" });
  const texts = ["first attempt", "second attempt, other words"];
  let attempt = 0;
  const host = new Host(core);
  host.onError = () => {};
  await host.add({ actor: "agent:x", harness: { async step(s: any) {
    const text = texts[attempt++]!;
    await s.run("post", { text });
    if (attempt === 1) throw new Error("crash after the post");
  } } as never });
  await alice("post", { context: "c1", text: "go" });
  await host.settle(5);
  assert.equal(attempt, 2, "the step was retried");
  const said = store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:x" && e.type === "message.posted").map((e) => e.data.text);
  assert.deepEqual(said, ["first attempt"], "one event, the original");
  await host.close();
  store.close();
});
