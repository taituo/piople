import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import { SyntheticHarness, behave } from "../src/harnesses/synthetic.ts";
import type { Behavior } from "../src/harnesses/synthetic.ts";
import { fakeModel, lastUser } from "./fake-model.ts";

/**
 * Phase B acceptance: ONE process hosts two Pi agents and two synthetic agents; the human takes
 * part through real CLI processes against the same database file. Midway one Pi agent is
 * restarted. Models are deterministic fakes: this proves the protocol and the plumbing, not
 * intelligence.
 */
const dir = mkdtempSync(join(tmpdir(), "piople-world-"));
const dbPath = join(dir, "core.sqlite");

function cli(as: string, ...args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", dbPath, "--as", as, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err.trim()))));
  });
}
const pi = (actor: string, baseUrl: string) => PiHarness.open({ actor, dir: join(dir, "pi"), role: "You are a careful participant.", provider: { baseUrl }, modelId: "fake-1" });

// An observation by someone else calls for a decision, once.
const askDecisionOnObservation: Behavior = async (s) => {
  if (s.events.some((e) => e.type === "observation.recorded" && e.actorId !== s.actor)) {
    await s.run("decision-request", { question: "Julkaistaanko dokumentaatiolinkki?", options: "yes,no" });
  }
};

test("one process: two Pi agents + two synthetic agents + a human on the CLI; a Pi agent restarts mid-work", async () => {
  const researcherModel = await fakeModel((m) => {
    const u = lastUser(m);
    if (/work\.completed/.test(u)) return "ASK: agent:reviewer | Onko lähde luotettava?\nOBSERVE: Dokumentaatio löytyi osoitteesta https://example.test/x";
    if (/Selvitä/.test(u)) return 'WORK: web.search | {"q":"lib X docs"}\nPOST: Pyysin haun.';
    if (/decision\.resolved/.test(u)) return "POST: Päätös vastaanotettu. Valmis.";
    return "NOOP";
  });
  const reviewerModel = await fakeModel((m) => {
    const key = /ASK (\S+) from/.exec(lastUser(m))?.[1];
    return key ? `ANSWER: ${key} | Kyllä, lähde näyttää luotettavalta.` : "NOOP";
  });

  const store = new Store(dbPath);
  const host = new Host(new LocalCore(store));
  const errors: string[] = [];
  host.onError = (e) => errors.push(`${e.actor}: ${String((e.error as Error).message)}`);
  let researcher = await pi("agent:researcher", researcherModel.baseUrl);
  await host.add({ actor: "agent:researcher", harness: researcher });
  await host.add({ actor: "agent:reviewer", harness: await pi("agent:reviewer", reviewerModel.baseUrl) });
  await host.add({ actor: "agent:fetch", skills: ["web.search"], harness: new SyntheticHarness({ behaviors: [behave.worker((input) => ({ url: "https://example.test/x", for: input }))] }) });
  await host.add({ actor: "agent:sim", harness: new SyntheticHarness({ behaviors: [askDecisionOnObservation] }) });

  // The human sets the case up and speaks, all through separate CLI processes.
  await cli("human:alice", "create", "--id", "c1", "--title", "Kirjasto X", "--goal", "Löydä dokumentaatio");
  for (const a of ["agent:researcher", "agent:reviewer", "agent:fetch", "agent:sim"]) await cli("human:alice", "join", "--context", "c1", "--actor", a, "--caps", "read,write");
  await cli("human:alice", "post", "--context", "c1", "--text", "Selvitä kirjaston X dokumentaatio");

  // Deliver just until the work has been requested, then restart the researcher mid-work.
  await host.pump("agent:researcher");
  assert.equal(store.getWork("c1", store.db.prepare(`SELECT id FROM work`).get()!.id as string)!.status, "open");
  const modelCallsBefore = researcherModel.requests.length;
  await researcher.close(); // the old process is gone before the new one opens its state
  researcher = await pi("agent:researcher", researcherModel.baseUrl); // a new "process" over the same private state
  await host.replace("agent:researcher", researcher); // (closing again is a no-op)

  await host.settle();

  // The human sees the decision waiting, through the CLI, and decides.
  const inbox = await cli("human:alice", "inbox", "--context", "c1");
  assert.equal(inbox.pending.decisions.length, 1);
  assert.equal(inbox.pending.decisions[0].question, "Julkaistaanko dokumentaatiolinkki?");
  await cli("human:alice", "decide", "--context", "c1", "--decision", inbox.pending.decisions[0].id, "--answer", "yes");
  await host.settle();

  const events = store.eventsSince("c1", 0);
  const by = (type: string, actor?: string) => events.filter((e) => e.type === type && (!actor || e.actorId === actor));
  assert.deepEqual(errors, []);
  // collaboration: work routed by skill to a synthetic worker, finished once
  assert.equal(by("work.requested", "agent:researcher").length, 1);
  assert.equal(by("work.claimed", "agent:fetch").length, 1);
  assert.equal(by("work.completed", "agent:fetch").length, 1);
  // a Pi agent asked another Pi agent, who answered
  assert.equal(by("assistance.requested", "agent:researcher").length, 1);
  assert.equal(by("assistance.answered", "agent:reviewer").length, 1);
  assert.match(String(by("assistance.answered")[0]!.data.answer), /luotettava/);
  // a synthetic agent asked for a decision; only the human decided, nothing was lost
  assert.equal(by("decision.requested", "agent:sim").length, 1);
  assert.equal(by("decision.resolved").length, 1);
  assert.equal(by("decision.resolved")[0]!.actorId, "human:alice");
  assert.equal(by("decision.resolved")[0]!.data.answer, "yes");
  // the restarted researcher resumed its durable conversation and finished
  assert.ok(researcherModel.requests.length > modelCallsBefore);
  assert.match(JSON.stringify(researcherModel.requests.at(-1)), /Selvitä kirjaston X/, "the new instance still had the conversation");
  assert.deepEqual(by("message.posted", "agent:researcher").map((e) => e.data.text), ["Pyysin haun.", "Päätös vastaanotettu. Valmis."]);
  // nothing was done twice, and nothing is left to deliver
  assert.equal(await host.tick(), 0);
  for (const e of events) assert.equal(events.filter((x) => x.key === e.key && x.contextId === e.contextId).length, 1);

  await host.close();
  await researcherModel.close();
  await reviewerModel.close();
  store.close();
});
