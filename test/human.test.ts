import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { HumanHarness, scriptedConsole } from "../src/harnesses/human.ts";

const resolver = (s: Store) => s.eventsSince("c1", 0).find((e) => e.type === "decision.resolved")?.actorId;
function world() {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const call = (as: string) => (op: string, a: Record<string, unknown> = {}) => core.call(as, op, a) as Promise<any>;
  return { store, core, alice: call("human:alice"), call };
}

test("a scripted human resolves a decision, answers an ask, posts and takes work through the host", async () => {
  const { store, core, alice } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "human:bob", caps: "read,write,decide" });
  await alice("join", { context: "c1", actor: "agent:x", caps: "read,write" });
  await alice("decision-request", { context: "c1", id: "d1", question: "Patch POOL_SIZE to 10?" });
  await core.call("agent:x", "ask", { context: "c1", to: "human:bob", question: "which cluster?", key: "q1" });
  await alice("work-request", { context: "c1", id: "w1", to: "human:bob", input: '{"do":"it"}' });
  const io = scriptedConsole(["help", "decide d1 yes", "answer q1 | prod-eu", "say on it", "claim w1", "done w1 1 \"ok\"", "bogus", ""]);
  const host = new Host(core);
  await host.add({ actor: "human:bob", harness: new HumanHarness({ console: io }) });
  await host.settle();
  const text = io.out.join("\n");
  assert.match(text, /decision d1 \[yes\/no\] \(human:alice\): Patch POOL_SIZE to 10\?/);
  assert.match(text, /ask q1 from agent:x: which cluster\?/);
  assert.match(text, /work you may take w1/);
  assert.match(text, /unknown command bogus/);
  assert.equal(store.getDecision("c1", "d1")!.status, "resolved");
  assert.equal(resolver(store), "human:bob");
  assert.ok(store.eventsSince("c1", 0).some((e) => e.type === "assistance.answered" && e.data.answer === "prod-eu"));
  assert.ok(store.eventsSince("c1", 0).some((e) => e.type === "message.posted" && e.actorId === "human:bob" && e.data.text === "on it"));
  const w = store.getWork("c1", "w1")!;
  assert.deepEqual([w.status, w.attempt, w.result], ["done", 1, "ok"]);
  await host.close();
  store.close();
});

test("same rules as everyone: naming yourself human grants nothing; an agent with the same harness is refused too", async () => {
  const { store, core, alice } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("join", { context: "c1", actor: "human:eve", caps: "read,write" }); // a human without decide
  await alice("join", { context: "c1", actor: "agent:bot", caps: "read,write,decide" }); // an agent that may decide
  await alice("decision-request", { context: "c1", id: "d1", question: "ship?" });
  const eve = scriptedConsole(["decide d1 yes", ""]);
  const bot = scriptedConsole(["decide d1 yes", ""]);
  const host = new Host(core);
  await host.add({ actor: "human:eve", harness: new HumanHarness({ console: eve }) });
  await host.settle();
  assert.match(eve.out.join("\n"), /refused: forbidden: human:eve lacks decide/, "no decide, no decision");
  assert.equal(store.getDecision("c1", "d1")!.status, "open");
  // with decide an agent could (that is a capability the operator granted, not something the name gives); an unjoined one cannot
  await host.add({ actor: "human:mallory", harness: new HumanHarness({ console: scriptedConsole(["decide d1 yes", ""]) }) });
  await host.settle();
  assert.equal(store.getDecision("c1", "d1")!.status, "open", "not a member: nothing to see, nothing to decide");
  await host.add({ actor: "agent:bot", harness: new HumanHarness({ console: bot }) });
  await host.settle();
  assert.equal(resolver(store), "agent:bot", "capabilities decide, not the actor kind");
  await host.close();
  store.close();
});

test("an empty line or the end of input leaves everything pending: nothing is resolved by looking", async () => {
  const { store, core, alice } = world();
  await alice("create", { id: "c1", title: "t" });
  await alice("decision-request", { context: "c1", id: "d1", question: "ship?" });
  await alice("join", { context: "c1", actor: "human:bob", caps: "read,write,decide" });
  const io = scriptedConsole([]);
  const host = new Host(core);
  await host.add({ actor: "human:bob", harness: new HumanHarness({ console: io }) });
  await host.settle();
  assert.equal(store.getDecision("c1", "d1")!.status, "open");
  assert.equal(store.pending("c1", "human:bob").decisions.length, 1);
  await host.close();
  store.close();
});

test("the CLI one-shot commands behave as before and `watch` runs as a real process on the same database", async () => {
  const db = join(mkdtempSync(join(tmpdir(), "piople-watch-")), "w.sqlite");
  const cli = (as: string, ...a: string[]) => JSON.parse(execFileSync(process.execPath, ["--no-warnings", "src/cli/main.ts", "--db", db, "--as", as, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  cli("human:alice", "create", "--id", "c1", "--title", "t");
  cli("human:alice", "join", "--context", "c1", "--actor", "human:bob", "--caps", "read,write,decide");
  cli("human:alice", "decision-request", "--context", "c1", "--id", "d1", "--question", "ship?");
  const p = spawn(process.execPath, ["--no-warnings", "src/hosts/watch.ts", "--as", "human:bob", "--db", db], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no prompt: ${out}`)), 15_000);
    p.stdout.on("data", () => { if (/decision d1/.test(out) && /> /.test(out)) { clearTimeout(t); resolve(); } });
  });
  p.stdin.write("decide d1 yes\n\n");
  p.stdin.end(); // Ctrl-D
  await new Promise<void>((r) => p.on("close", () => r()));
  assert.match(out, /decided/);
  const events = cli("human:alice", "events", "--context", "c1");
  assert.ok((events.events ?? events).some((e: any) => e.type === "decision.resolved" && e.actorId === "human:bob"));
});
