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
