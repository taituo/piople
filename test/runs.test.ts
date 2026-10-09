import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";

test("run ledger: start, finish, list; old DBs migrate", () => {
  const s = new Store(":memory:");
  s.startRun("run-1", "case-a", "deepseek-v4-flash", 3);
  let rows = s.listRuns("case-a");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["outcome"], "running");
  s.finishRun("run-1", { tokensIn: 100, tokensOut: 50, toolCalls: 4, proposals: 1, outcome: "done" });
  rows = s.listRuns("case-a");
  assert.equal(rows[0]!["tokens_in"], 100);
  assert.equal(rows[0]!["outcome"], "done");
  assert.throws(() => s.finishRun("missing", { tokensIn: 0, tokensOut: 0, toolCalls: 0, proposals: 0, outcome: "x" }), /run-not-found/);
  s.close();
});
