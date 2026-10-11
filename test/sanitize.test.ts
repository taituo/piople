import test from "node:test";
import assert from "node:assert/strict";

test("sanitize strips leaked control tokens and nothing the author wrote in angle brackets", async () => {
  const { sanitize } = await import("../src/harnesses/pi.ts");
  assert.equal(sanitize("<ds_s>hello"), "hello");
  assert.equal(sanitize("a<|im_end|>b"), "ab");
  assert.equal(sanitize("a<｜end▁of▁sentence｜>b"), "ab");
  assert.equal(sanitize("x</s>y<s>z<eos>"), "xyz");
  for (const keep of ["use List<String> and <T> here", "mail to <alice> about <b>bold</b>", "redacted: <email> <url> <number>", "x < y > z", "map<int,int>"]) assert.equal(sanitize(keep), keep, keep);
});

test("no event data can make the formatters throw (a step that throws on an event never lets the cursor pass it)", async () => {
  const { renderStep } = await import("../src/harnesses/pi.ts");
  const { HumanHarness, scriptedConsole } = await import("../src/harnesses/human.ts");
  const { eventLine } = await import("../src/harnesses/memory.ts");
  const hostile: Array<Record<string, unknown>> = [
    { text: { toString: 1 } }, { question: { toString: 1, valueOf: 1 } }, { answer: Object.create(null) },
    { text: { nested: { text: { toString: 1 } } } }, { text: null }, { text: 5 }, { text: [1, [2, [3]]] }, {}, { decisionId: { toString: 1 } },
  ];
  for (const [i, data] of hostile.entries()) {
    const ev = { seq: i + 1, ts: 1, type: "message.posted", contextId: "c1", actorId: "human:eve", key: `k${i}`, data };
    const step = { actor: "agent:me", context: "c1", cursor: 0, events: [ev], pending: { assistance: [], decisions: [], work: { open: [], mine: [] } }, run: async () => ({}) } as never;
    assert.doesNotThrow(() => renderStep(step), `renderStep ${JSON.stringify(data)}`);
    assert.doesNotThrow(() => eventLine(ev as never), `eventLine ${JSON.stringify(data)}`);
    await assert.doesNotReject(new HumanHarness({ console: scriptedConsole([]) }).step(step), `human ${JSON.stringify(data)}`);
  }
});
