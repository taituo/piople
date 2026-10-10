import test from "node:test";
import assert from "node:assert/strict";
import { createActivities } from "../src/adapters/temporal/activities.ts";
import { CoreError } from "../src/http/client.ts";

const failing = (err: unknown) => createActivities({ call: async () => { throw err; } }, "agent:orch");
const outcome = async (err: unknown) => {
  try { await failing(err).requestDecision({ context: "c1", question: "q", key: "k" }); return "no error"; } catch (e) { return (e as { nonRetryable?: boolean }).nonRetryable === true ? "non-retryable" : "retryable"; }
};

test("Core refusals that can never succeed fail the Activity for good; transient ones and fixable ones stay retryable", async () => {
  // permanent: Temporal would otherwise retry them for ever and the workflow would sit stuck without any visible failure
  assert.equal(await outcome(new CoreError(400, "bad-request", "too-large: question is 30000 characters")), "non-retryable");
  assert.equal(await outcome(new CoreError(404, "not-found", "unknown-context: c9")), "non-retryable");
  assert.equal(await outcome(new CoreError(409, "conflict", "id-in-use: that decision id already exists")), "non-retryable");
  assert.equal(await outcome(new CoreError(413, "too-large", "too-large: question")), "non-retryable");
  assert.equal(await outcome(new Error("too-large: question is 30000 characters")), "non-retryable", "a local core reports by message");
  assert.equal(await outcome(new Error("bad-actor: to is not human:<id> or agent:<id>")), "non-retryable");
  // retryable: the world may change
  assert.equal(await outcome(new CoreError(503, "error", "unavailable")), "retryable");
  assert.equal(await outcome(new CoreError(429, "limit", "hop-limit")), "retryable");
  assert.equal(await outcome(new CoreError(403, "forbidden", "not-a-member: agent:orch not in c1")), "retryable", "an operator can add the orchestrator while it keeps trying");
  assert.equal(await outcome(new CoreError(401, "unauthorized", "missing or invalid token")), "retryable");
  assert.equal(await outcome(new Error("core-unreachable: http://core (fetch failed)")), "retryable");
});
