import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import { extractiveSummarizer, type Summarizer } from "../src/harnesses/memory.ts";
import { fakeModel, lastUser, type ChatMessage } from "./fake-model.ts";

const opts = (baseUrl: string, dir: string, memory?: { summarizer: Summarizer; k?: number; recent?: number; budgetTokens?: number }) =>
  ({ actor: "agent:pi", dir, role: "You are a careful analyst.", provider: { baseUrl }, modelId: "fake-1", ...(memory ? { memory } : {}) });
const posts = (s: Store) => s.eventsSince("c1", 0).filter((e) => e.type === "message.posted" && e.actorId === "agent:pi").map((e) => e.data.text);
async function world(n: number, plantAt = 7) {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  return { store, core, alice, fill: async (host: Host, from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      await alice("post", { context: "c1", text: i === plantAt ? "a long and entirely ordinary opening that pushes the detail past the summary cut: the vault code is JUNIPER-7731" : `routine message ${i} about nothing in particular` });
      await host.settle();
    }
  } };
}
const sys = (m: ChatMessage[]) => JSON.stringify(m[0]);

test("memory: the prompt carries a bounded view, the agent zooms down through the summaries and finds the original line", async () => {
  const { store, fill } = await world(40);
  const FACT_SEQ = 9; // created = 1, joined = 2, so message 7 is event 9
  const covering = (u: string) => [...u.matchAll(/\[(s\d+:(\d+)-(\d+))\]/g)].find((k) => Number(k[2]) <= FACT_SEQ && FACT_SEQ <= Number(k[3]));
  let started = false;
  let zoomPrompt = "";
  const model = await fakeModel((m, n) => {
    const u = lastUser(m);
    if (/^Zoom /.test(u)) {
      if (/JUNIPER-7731/.test(u)) return "POST: found it: JUNIPER-7731";
      const hit = covering(u);
      return hit ? `ZOOM: ${hit[1]}` : "NOOP";
    }
    const top = covering(u);
    if (n > 35 && top && !started) { started = true; zoomPrompt = u; return `ZOOM: ${top[1]}`; }
    return "NOOP";
  });
  const host = new Host(new LocalCore(store));
  const pi = await PiHarness.open({ ...opts(model.baseUrl, ":memory:", { summarizer: extractiveSummarizer(), k: 4, recent: 6, budgetTokens: 600 }), maxRounds: 8 });
  await host.add({ actor: "agent:pi", harness: pi });
  await fill(host, 1, 40);
  assert.ok(started, "the agent zoomed");
  assert.match(zoomPrompt, /Case memory/);
  assert.match(zoomPrompt, /summary of events \d+-\d+ \(ZOOM to read them\)/);
  assert.ok(zoomPrompt.length < 600 * 4 + 1500, `prompt is ${zoomPrompt.length} chars after ~36 messages`);
  assert.doesNotMatch(zoomPrompt, /JUNIPER/, "the planted fact is out of the view");
  assert.match(sys(model.requests[0]!), /ZOOM: <memory id>/, "the protocol offers ZOOM");
  assert.deepEqual(posts(store), ["found it: JUNIPER-7731"]);
  assert.equal(pi.memoryErrors, 0);
  await host.close();
  await model.close();
  store.close();
});

test("memory: it survives a restart and includes the agent's own writes", async () => {
  const { store, alice } = await world(0);
  const dir = mkdtempSync(join(tmpdir(), "piople-mem-"));
  const model = await fakeModel((m) => (/first question/.test(lastUser(m)) ? "POST: my answer is MARIGOLD" : "NOOP"));
  const h1 = new Host(new LocalCore(store));
  await h1.add({ actor: "agent:pi", harness: await PiHarness.open(opts(model.baseUrl, dir, { summarizer: extractiveSummarizer(), k: 4, recent: 6 })) });
  await alice("post", { context: "c1", text: "first question" });
  await h1.settle();
  await h1.close();
  const h2 = new Host(new LocalCore(store));
  await h2.add({ actor: "agent:pi", harness: await PiHarness.open(opts(model.baseUrl, dir, { summarizer: extractiveSummarizer(), k: 4, recent: 6 })) });
  await alice("post", { context: "c1", text: "second question" });
  await h2.settle();
  const u = lastUser(model.requests.at(-1)!);
  assert.match(u, /Case memory/);
  assert.match(u, /agent:pi message.posted: my answer is MARIGOLD/, "its own earlier answer is in the memory although the host never delivered it");
  await h2.close();
  await model.close();
  store.close();
});

test("memory: a summariser that is down never fails a delivery", async () => {
  const { store, fill } = await world(0);
  const down: Summarizer = { name: "down", version: "1", async summarize() { throw new Error("model down"); } };
  const model = await fakeModel(() => "NOOP");
  const host = new Host(new LocalCore(store));
  const errors: unknown[] = [];
  host.onError = (e) => errors.push(e.error);
  const pi = await PiHarness.open(opts(model.baseUrl, ":memory:", { summarizer: down, k: 4, recent: 2 }));
  await host.add({ actor: "agent:pi", harness: pi });
  await fill(host, 1, 20);
  assert.equal(errors.length, 0);
  assert.ok(pi.memoryErrors > 0);
  assert.match(lastUser(model.requests.at(-1)!), /\[e\d+\] \d+ human:alice message.posted: routine message 19/, "everything stays verbatim until it can be summarised");
  await host.close();
  await model.close();
  store.close();
});

test("without memory nothing changes: one conversation per case, no ZOOM in the protocol, ZOOM is refused", async () => {
  const { store, alice } = await world(0);
  const model = await fakeModel((_m, n) => (n === 1 ? "ZOOM: e1" : "NOOP"));
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await PiHarness.open(opts(model.baseUrl, ":memory:")) });
  await alice("post", { context: "c1", text: "hi" });
  await host.settle();
  assert.doesNotMatch(sys(model.requests[0]!), /ZOOM/);
  assert.doesNotMatch(lastUser(model.requests[0]!), /Case memory/);
  assert.match(lastUser(model.requests[1]!), /REFUSED ZOOM: this agent has no case memory/);
  await host.close();
  await model.close();
  store.close();
});

test("memory: zooming an unknown id is feedback, not a crash", async () => {
  const { store, alice } = await world(0);
  const model = await fakeModel((_m, n) => (n === 1 ? "ZOOM: s9:1-2" : "NOOP"));
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await PiHarness.open(opts(model.baseUrl, ":memory:", { summarizer: extractiveSummarizer() })) });
  await alice("post", { context: "c1", text: "hi" });
  await host.settle();
  assert.match(lastUser(model.requests[1]!), /REFUSED ZOOM: no memory entry s9:1-2/);
  await host.close();
  await model.close();
  store.close();
});
