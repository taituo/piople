import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import { extractiveSummarizer } from "../src/harnesses/memory.ts";
import { fakeModel, lastUser } from "./fake-model.ts";

/** Found by mutation testing: nothing checked what an agent is told when FIND cannot run or has nothing to look for. */
async function run(withMemory: boolean, command: string, expectFeedback: RegExp) {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  await core.call("human:alice", "create", { id: "c1", title: "t" });
  await core.call("human:alice", "join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  const model = await fakeModel((m, n) => (n === 1 ? command : expectFeedback.test(lastUser(m)) ? "POST: got the expected feedback" : "POST: wrong feedback"));
  const host = new Host(core);
  await host.add({ actor: "agent:pi", harness: await PiHarness.open({ actor: "agent:pi", dir: ":memory:", role: "r", provider: { baseUrl: model.baseUrl }, modelId: "fake-1", maxRounds: 4, ...(withMemory ? { memory: { summarizer: extractiveSummarizer() } } : {}) }) });
  await core.call("human:alice", "post", { context: "c1", text: "go" });
  await host.settle();
  const said = store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:pi" && e.type === "message.posted").map((e) => e.data.text);
  await host.close();
  await model.close();
  store.close();
  return said;
}

test("FIND without a case memory is refused with a reason the agent sees", { timeout: 30_000 }, async () => {
  assert.deepEqual(await run(false, "FIND: anything", /REFUSED FIND: this agent has no case memory/), ["got the expected feedback"]);
});

test("FIND with nothing to look for is refused with a reason the agent sees", { timeout: 30_000 }, async () => {
  assert.deepEqual(await run(true, "FIND:", /REFUSED FIND: give the words to look for/), ["got the expected feedback"]);
});
