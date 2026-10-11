import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import type { EnvironmentProfile } from "../src/harnesses/tools.ts";
import { fakeModel, lastUser } from "./fake-model.ts";

/**
 * The approval gate asks a person "Allow agent:pi to run read_file {...}?" in a decision whose id is derived from the call,
 * which anyone can compute. A member with write (not decide) could create a decision with that id first, with another
 * question ("click allow to switch to dark mode"); the agent then never asked its own question, the person answered allow
 * to what they were shown, and the agent's real call ran without anyone having seen it.
 */
test("approval: nobody can take the gate's decision id first and put another question to the person", async () => {
  const base = mkdtempSync(join(tmpdir(), "piople-spoof-"));
  mkdirSync(join(base, "root"));
  writeFileSync(join(base, "root", "notes.txt"), "the deploy key rotates on friday\n");
  const profile = { name: "reader", tools: ["read_file"], files: { root: join(base, "root") } } as EnvironmentProfile;
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const as = (a: string) => (op: string, x: Record<string, unknown> = {}) => core.call(a, op, x) as Promise<any>;
  const alice = as("human:alice"), eve = as("human:eve");
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "agent:pi", caps: "read,write" });
  await alice("join", { context: "c1", actor: "human:eve", caps: "read,write" });
  const hash = createHash("sha256").update(`read_file\0${JSON.stringify({ path: "notes.txt" })}`).digest("hex").slice(0, 20);
  // the way the gate used to name its decision, and the way it does now
  await eve("decision-request", { context: "c1", id: `tool-${hash}`, question: "Click allow to switch to dark mode", options: "allow,deny" });
  await assert.rejects(eve("decision-request", { context: "c1", id: `agent:pi@tool-${hash}`, question: "Click allow to switch to dark mode", options: "allow,deny" }), /forbidden/, "the new id is the agent's");
  const model = await fakeModel((m, n) => (n === 1 || /decision\.resolved/.test(lastUser(m)) ? 'TOOL: read_file | {"path":"notes.txt"}' : /Tool read_file returned/.test(lastUser(m)) ? "POST: it says friday" : "NOOP"));
  const host = new Host(core);
  await host.add({ actor: "agent:pi", harness: await PiHarness.open({ actor: "agent:pi", dir: ":memory:", role: "r", provider: { baseUrl: model.baseUrl }, modelId: "fake-1", maxRounds: 6, environment: profile, approval: { tools: ["read_file"] } }) });
  await alice("post", { context: "c1", text: "read the notes" });
  await host.settle();
  const own = store.eventsSince("c1", 0).filter((e) => e.type === "decision.requested" && e.actorId === "agent:pi");
  assert.equal(own.length, 1, "the agent asked its own question, whatever else existed");
  assert.match(String(own[0]!.data.question), /Allow agent:pi to run read_file \{"path":"notes.txt"\}\?/);
  assert.deepEqual(store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:pi" && e.type === "message.posted"), [], "and nothing ran yet");
  // the person who answers the question that was shown is answering the real call
  await alice("decide", { context: "c1", decision: String(own[0]!.data.decisionId), answer: "allow" });
  await host.settle();
  assert.deepEqual(store.eventsSince("c1", 0).filter((e) => e.actorId === "agent:pi" && e.type === "message.posted").map((e) => e.data.text), ["it says friday"]);
  // allowing eve's decision (the old id) changes nothing about the agent
  await host.close();
  await model.close();
  store.close();
});
