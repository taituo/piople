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
