import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";

/** Found by running the README's `watch` example with scripted input: lines that arrived together were dropped after the first. */
test("watch acts on every line of input that arrives at once, not only the first", { timeout: 30_000 }, async () => {
  const db = join(mkdtempSync(join(tmpdir(), "piople-watch-")), "w.sqlite");
  const s = new Store(db);
  s.createContext({ id: "c1", kind: "case", title: "t", goal: "", createdAt: 1 }, "human:alice");
  s.join({ contextId: "c1", actorId: "human:bob", capabilities: ["read", "write", "decide"], joinedAt: 2 }, "jb", "human:alice");
  s.requestDecision({ id: "d1", contextId: "c1", question: "one?", options: ["yes", "no"], requestedBy: "human:alice", decidedBy: null, answer: null, status: "open", createdAt: 1, resolvedAt: null } as never);
  s.requestDecision({ id: "d2", contextId: "c1", question: "two?", options: ["yes", "no"], requestedBy: "human:alice", decidedBy: null, answer: null, status: "open", createdAt: 1, resolvedAt: null } as never);
  s.close();
  const p = spawn(process.execPath, ["--no-warnings", "src/hosts/watch.ts", "--as", "human:bob", "--db", db], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d: Buffer) => (out += d));
  p.stdin.end("help\ndecide d1 yes\nsay hello from a script\ndecide d2 no\n"); // all four lines in one burst, then EOF
  await new Promise((r) => p.on("close", r));
  const after = new Store(db);
  const answers = Object.fromEntries(after.eventsSince("c1", 0).filter((e) => e.type === "decision.resolved").map((e) => [e.data.decisionId, e.data.answer]));
  const said = after.eventsSince("c1", 0).filter((e) => e.type === "message.posted" && e.actorId === "human:bob").map((e) => e.data.text);
  after.close();
  assert.deepEqual(answers, { d1: "yes", d2: "no" }, `both decisions were answered; output was: ${out.slice(0, 300)}`);
  assert.deepEqual(said, ["hello from a script"], "and the line in between was said");
});
