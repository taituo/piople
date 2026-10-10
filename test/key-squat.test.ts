import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { SyntheticHarness, behave } from "../src/harnesses/synthetic.ts";

const setup = () => {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const call = (a: string, op: string, x: Record<string, unknown> = {}) => core.call(a, op, x) as Promise<any>;
  return { store, core, call };
};

test("a plain writer cannot squat the keys a Host derives for another actor, so it cannot silence that actor", async () => {
  const { store, core, call } = setup();
  await call("human:alice", "create", { id: "c1", title: "t" });
  await call("human:alice", "join", { context: "c1", actor: "agent:x", caps: "read,write" });
  await call("human:alice", "join", { context: "c1", actor: "human:eve", caps: "read,write" });
  for (let n = 1; n <= 3; n++) {
    await assert.rejects(call("human:eve", "post", { context: "c1", text: "squatted", key: `agent:x@c1#0.${n}` }), /^Error: forbidden: a key that starts with an actor id/);
  }
  const host = new Host(core, { pollMs: 5 });
  const errors: string[] = [];
  host.onError = (e) => errors.push(String((e.error as Error).message));
  await host.add({ actor: "agent:x", harness: new SyntheticHarness({ behaviors: [behave.replyTo(/hello/, "hi back")] }) });
  await call("human:alice", "post", { context: "c1", text: "hello agent" });
  await host.settle();
  assert.deepEqual(errors, []);
  assert.deepEqual(store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:x" && e.type === "message.posted").map((e) => e.data.text), ["hi back"]);
  store.close();
});

test("an actor may use keys under its own id, also when the id itself contains an @, and other keys stay free for everyone", async () => {
  const { store, call } = setup();
  await call("human:alice", "create", { id: "c1", title: "t" });
  await call("human:alice", "join", { context: "c1", actor: "agent:a@b", caps: "read,write" });
  await call("human:alice", "join", { context: "c1", actor: "agent:a", caps: "read,write" });
  await call("agent:a@b", "post", { context: "c1", text: "mine", key: "agent:a@b@c1#0.1" });
  await call("agent:a", "post", { context: "c1", text: "mine too", key: "agent:a@c1#0.1" });
  await assert.rejects(call("agent:a", "post", { context: "c1", text: "not mine", key: "agent:a@b@c1#0.2" }), /forbidden/, "agent:a is not agent:a@b");
  await call("human:alice", "post", { context: "c1", text: "plain", key: "anything:goes@here" });
  await call("human:alice", "post", { context: "c1", text: "no prefix", key: "human-ish" });
  store.close();
});
