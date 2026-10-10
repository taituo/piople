import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import type { EnvironmentProfile } from "../src/harnesses/tools.ts";
import { fakeModel, lastUser } from "./fake-model.ts";

async function setup(environment?: EnvironmentProfile) {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  return { store, core, alice, open: (baseUrl: string) => PiHarness.open({ actor: "agent:pi", dir: ":memory:", role: "You read files.", provider: { baseUrl }, modelId: "fake-1", maxRounds: 6, ...(environment ? { environment } : {}) }) };
}
const area = () => {
  const base = mkdtempSync(join(tmpdir(), "piople-pitool-"));
  mkdirSync(join(base, "root"));
  writeFileSync(join(base, "root", "notes.txt"), "the deploy key rotates on friday\n");
  writeFileSync(join(base, "secret.txt"), "OUTSIDE-SECRET\n");
  return { base, profile: { name: "reader", tools: ["read_file", "list_dir"], files: { root: join(base, "root") } } as EnvironmentProfile };
};
const sys = (m: unknown[]) => JSON.stringify(m[0]);

test("an agent with a profile lists, reads, is refused outside its directory, and the refusal is feedback", async () => {
  const { profile } = area();
  const { store, alice, open } = await setup(profile);
  const replies = ["TOOL: list_dir | {}", "TOOL: read_file | {\"path\": \"notes.txt\"}", "TOOL: read_file | {\"path\": \"../secret.txt\"}", "TOOL: write_file | {}", "TOOL: read_file | {not json", "POST: done"];
  const model = await fakeModel((_m, n) => replies[n - 1] ?? "NOOP");
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await open(model.baseUrl) });
  await alice("post", { context: "c1", text: "what do the notes say?" });
  await host.settle();
  assert.match(lastUser(model.requests[1]!), /Tool list_dir returned:\nnotes.txt/);
  assert.match(lastUser(model.requests[2]!), /Tool read_file returned:\nthe deploy key rotates on friday/);
  assert.match(lastUser(model.requests[3]!), /REFUSED TOOL read_file: denied: outside the allowed directory/);
  assert.match(lastUser(model.requests[4]!), /REFUSED TOOL write_file: tool write_file is not available to this agent/);
  assert.match(lastUser(model.requests[5]!), /REFUSED TOOL read_file: the arguments are not valid JSON/);
  assert.ok(!JSON.stringify(model.requests).includes("OUTSIDE-SECRET"), "the file outside never reached the model");
  assert.match(sys(model.requests[0]!), /TOOL: <name> \| <json arguments>[\s\S]*read_file[\s\S]*list_dir/, "the protocol names the agent's tools");
  assert.equal(store.eventsSince("c1", 0).filter((e) => e.type === "message.posted" && e.actorId === "agent:pi").length, 1);
  await host.close();
  await model.close();
  store.close();
});

test("the same agent without a profile has no tools: the protocol does not offer them and TOOL is refused", async () => {
  const { store, alice, open } = await setup();
  const model = await fakeModel((_m, n) => (n === 1 ? "TOOL: read_file | {\"path\": \"notes.txt\"}" : "NOOP"));
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await open(model.baseUrl) });
  await alice("post", { context: "c1", text: "hi" });
  await host.settle();
  assert.doesNotMatch(sys(model.requests[0]!), /TOOL:/);
  assert.match(lastUser(model.requests[1]!), /REFUSED TOOL: this agent has no tools/);
  await host.close();
  await model.close();
  store.close();
});

test("credentials never reach the model: not in the system text, the prompts or any tool result", async () => {
  process.env.PIO_TOKEN = "pio_never_in_prompts";
  const { profile } = area();
  const { store, alice, open } = await setup({ ...profile, tools: ["read_file"] });
  try {
    const model = await fakeModel((_m, n) => (n === 1 ? "TOOL: read_file | {\"path\": \"notes.txt\"}" : "NOOP"));
    const host = new Host(new LocalCore(store));
    await host.add({ actor: "agent:pi", harness: await open(model.baseUrl) });
    await alice("post", { context: "c1", text: "go" });
    await host.settle();
    assert.ok(!JSON.stringify(model.requests).includes("pio_never_in_prompts"));
    await host.close();
    await model.close();
  } finally {
    delete process.env.PIO_TOKEN;
  }
  store.close();
});

test("native tools: the model calls a Pi tool, the confined runner does the work, the result is a tool message in the transcript", async () => {
  const { profile, base } = area();
  const { store, alice, open } = await setupNative(profile);
  const lastTool = (m: any[]) => [...m].reverse().find((x) => x.role === "tool");
  const model = await fakeModel((m, n) => {
    if (n === 1) return { toolCall: { name: "read_file", args: { path: "notes.txt" } } };
    if (n === 2) return /deploy key rotates on friday/.test(JSON.stringify(lastTool(m)?.content)) ? { toolCall: { name: "read_file", args: { path: "../secret.txt" } } } : "POST: no content";
    if (n === 3) return /REFUSED read_file: denied: outside the allowed directory/.test(JSON.stringify(lastTool(m)?.content)) ? "POST: friday, and the other file is off limits" : "POST: wrong";
    return "NOOP";
  });
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await open(model.baseUrl) });
  await alice("post", { context: "c1", text: "what do the notes say?" });
  await host.settle();
  assert.deepEqual(store.eventsSince("c1", 0).filter((e) => e.type === "message.posted" && e.actorId === "agent:pi").map((e) => e.data.text), ["friday, and the other file is off limits"]);
  const offered = (model.bodies[0]!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort();
  assert.deepEqual(offered, ["list_dir", "read_file"], "the profile's tools are offered as function tools, and nothing else");
  assert.ok(!JSON.stringify(model.requests).includes("OUTSIDE-SECRET"));
  assert.doesNotMatch(JSON.stringify(model.requests[0]![0]), /TOOL: <name>/, "the text command is not offered in native mode");
  void base;
  await host.close();
  await model.close();
  store.close();
});

async function setupNative(environment: EnvironmentProfile) {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  return { store, core, alice, open: (baseUrl: string) => PiHarness.open({ actor: "agent:pi", dir: ":memory:", role: "You read files.", provider: { baseUrl }, modelId: "fake-1", maxRounds: 6, environment, nativeTools: true }) };
}

// ---- approval gate: a tool call that needs a person --------------------------------------------------------------
async function gated(profile: EnvironmentProfile, native: boolean, tools = ["read_file"]) {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  const open = (baseUrl: string) => PiHarness.open({ actor: "agent:pi", dir: ":memory:", role: "You read files.", provider: { baseUrl }, modelId: "fake-1", maxRounds: 6, environment: profile, nativeTools: native, approval: { tools } });
  const decisions = () => store.eventsSince("c1", 0).filter((e) => e.type === "decision.requested");
  return { store, alice, open, decisions };
}
/** The tool message that answers the newest user message (an older one in the history is not news). */
const freshTool = (m: any[]) => { const i = m.map((x) => x.role).lastIndexOf("user"); return m.slice(i + 1).find((x) => x.role === "tool"); };
const callRead = (path: string) => (native: boolean) => (native ? { toolCall: { name: "read_file", args: { path } } } : `TOOL: read_file | ${JSON.stringify({ path })}`);

for (const native of [true, false]) {
  const mode = native ? "native tools" : "TOOL: command";

  test(`approval (${mode}): blocked until a person allows it; then the same call runs`, async () => {
    const { profile } = area();
    const { store, alice, open, decisions } = await gated(profile, native);
    const model = await fakeModel((m, n) => {
      const u = native ? JSON.stringify(freshTool(m)?.content ?? "") : lastUser(m);
      if (/friday/.test(u) && (native ? true : /Tool read_file returned/.test(u))) return "POST: it says friday";
      if (/approval needed/.test(u)) return "NOOP";
      if (n === 1 || /decision\.resolved/.test(lastUser(m))) return callRead("notes.txt")(native) as never;
      return "NOOP";
    });
    const host = new Host(new LocalCore(store));
    await host.add({ actor: "agent:pi", harness: await open(model.baseUrl) });
    await alice("post", { context: "c1", text: "what do the notes say?" });
    await host.settle();
    assert.equal(decisions().length, 1, "one decision asked for");
    const d = decisions()[0]!;
    assert.match(String(d.data.question), /Allow agent:pi to run read_file \{"path":"notes.txt"\}\?/);
    assert.deepEqual(store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:pi" && e.type === "message.posted"), [], "nothing ran, nothing was said");
    // the agent cannot approve itself: it holds no decide
    await assert.rejects(new LocalCore(store).call("agent:pi", "decide", { context: "c1", decision: d.data.decisionId, answer: "allow" }), /lacks decide/);
    await alice("decide", { context: "c1", decision: d.data.decisionId, answer: "allow" });
    await host.settle();
    assert.deepEqual(store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:pi" && e.type === "message.posted").map((e) => e.data.text), ["it says friday"]);
    assert.equal(decisions().length, 1, "asking again did not open a second decision");
    await host.close();
    await model.close();
    store.close();
  });

  test(`approval (${mode}): a "deny" blocks that call for good, and says who denied it`, async () => {
    const { profile } = area();
    const { store, alice, open, decisions } = await gated(profile, native);
    const seen: string[] = [];
    const model = await fakeModel((m, n) => {
      seen.push(native ? JSON.stringify(freshTool(m)?.content ?? "") : lastUser(m));
      if (native && freshTool(m)) return "NOOP"; // like a real model: it has its answer for this prompt (a refusal)
      return n === 1 || /decision\.resolved/.test(lastUser(m)) ? (callRead("notes.txt")(native) as never) : "NOOP";
    });
    const host = new Host(new LocalCore(store));
    await host.add({ actor: "agent:pi", harness: await open(model.baseUrl) });
    await alice("post", { context: "c1", text: "read the notes" });
    await host.settle();
    await alice("decide", { context: "c1", decision: decisions()[0]!.data.decisionId, answer: "deny" });
    await host.settle();
    assert.ok(seen.some((t) => /human:alice denied this call/.test(t)), "the model was told who said no");
    assert.ok(!seen.some((t) => /friday/.test(t)), "the file was never read");
    await host.close();
    await model.close();
    store.close();
  });
}

test("approval: other arguments need their own decision; a tool not listed needs none", async () => {
  const { profile } = area();
  const { store, alice, open, decisions } = await gated(profile, true, ["read_file"]);
  const model = await fakeModel((m, n) => (n === 1 ? { toolCall: { name: "read_file", args: { path: "notes.txt" } } } : n === 2 ? { toolCall: { name: "read_file", args: { path: "other.txt" } } } : n === 3 ? { toolCall: { name: "list_dir", args: {} } } : "NOOP"));
  const host = new Host(new LocalCore(store));
  await host.add({ actor: "agent:pi", harness: await open(model.baseUrl) });
  await alice("post", { context: "c1", text: "go" });
  await host.settle();
  assert.deepEqual(decisions().map((e) => String(e.data.question).replace(/^.*run /, "")), ['read_file {"path":"notes.txt"}?', 'read_file {"path":"other.txt"}?'], "one per distinct call; list_dir asked nothing");
  const toolMsgs = model.requests.at(-1)!.filter((x: any) => x.role === "tool").map((x: any) => JSON.stringify(x.content));
  assert.ok(toolMsgs.some((t) => /notes\.txt|inside|approval needed/.test(t)));
  assert.ok(toolMsgs.some((t) => /list_dir|notes.txt\\n|a\.txt|notes\.txt/.test(t)), "list_dir ran without asking");
  await host.close();
  await model.close();
  store.close();
});

test("a model that keeps calling a blocked tool is stopped at the limit, says so in the case, and the delivery does not retry for ever", async () => {
  const { profile } = area();
  const { store, alice, open } = await gated(profile, true);
  const model = await fakeModel(() => ({ toolCall: { name: "read_file", args: { path: "notes.txt" } } }));
  const host = new Host(new LocalCore(store));
  const errors: unknown[] = [];
  host.onError = (e) => errors.push(e.error);
  await host.add({ actor: "agent:pi", harness: await PiHarness.open({ actor: "agent:pi", dir: ":memory:", role: "r", provider: { baseUrl: model.baseUrl }, modelId: "fake-1", maxRounds: 6, environment: profile, nativeTools: true, approval: { tools: ["read_file"] }, maxToolCalls: 3 }) });
  void open;
  await alice("post", { context: "c1", text: "read the notes" });
  await host.settle();
  assert.ok(model.requests.length <= 6, `the model was asked ${model.requests.length} times, not for ever`);
  assert.equal(errors.length, 0);
  const said = store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:pi" && e.type === "observation.recorded").map((e) => String(e.data.text));
  assert.equal(said.length, 1);
  assert.match(said[0]!, /I stopped: I made more than 3 tool calls/);
  await host.close();
  await model.close();
  store.close();
});
