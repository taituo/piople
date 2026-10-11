import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { HumanHarness, printable, scriptedConsole } from "../src/harnesses/human.ts";

test("printable: control characters, C1 and bidi controls are shown as visible escapes; newline, tab and ordinary text stay", () => {
  assert.equal(printable("a\u001b[2Jb"), "a\\x1b[2Jb");
  assert.equal(printable("t\u001b]52;c;aGFja2Vk\u0007"), "t\\x1b]52;c;aGFja2Vk\\x07");
  assert.equal(printable("\u009b31m"), "\\x9b31m");
  assert.equal(printable("x\u202Ey"), "x\\u202ey");
  assert.equal(printable("line1\nline2\tä ö 😀 \"quoted\""), "line1\nline2\tä ö 😀 \"quoted\"");
});

test("a message cannot drive the terminal of the person who reads it, and a typed result keeps its spaces", async () => {
  const s = new Store(":memory:");
  const core = new LocalCore(s);
  await core.call("human:eve", "create", { id: "c1", title: "t" });
  await core.call("human:eve", "join", { context: "c1", actor: "human:alice", caps: "read,write" });
  await core.call("human:eve", "post", { context: "c1", text: "hi \u001b[2J\u001b]0;pwned\u0007 \u009b31m \u202Eevil" });
  await core.call("human:eve", "work-request", { context: "c1", id: "w1", to: "human:alice", input: "{}" });
  const con = scriptedConsole(["claim w1", 'done w1 1 {"r":"two  spaces   here"}']);
  const host = new Host(core);
  await host.add({ actor: "human:alice", harness: new HumanHarness({ console: con }) });
  await host.settle(3);
  const out = con.out.join("\n");
  assert.ok(!/[\u001b\u0007\u009b\u202e]/.test(out), "no raw control character reached the terminal");
  assert.match(out, /hi \\x1b\[2J\\x1b\]0;pwned\\x07 \\x9b31m \\u202eevil/);
  assert.equal(JSON.stringify(s.getWork("c1", "w1")!.result), '{"r":"two  spaces   here"}', "the result is stored as typed");
  await host.close();
  s.close();
});

test("a person's terminal is not flooded: a megabyte message and fifty long asks are printed clipped, with the amount left out", async () => {
  const s = new Store(":memory:");
  const core = new LocalCore(s);
  await core.call("human:eve", "create", { id: "c1", title: "t" });
  await core.call("human:eve", "join", { context: "c1", actor: "human:alice", caps: "read,write" });
  await core.call("human:eve", "post", { context: "c1", text: "BEGIN " + "x".repeat(999_000), key: "big" });
  for (let i = 0; i < 50; i++) await core.call("human:eve", "ask", { context: "c1", to: "human:alice", question: `q${i} ` + "y".repeat(19_000), key: `a${i}` });
  await core.call("human:eve", "post", { context: "c1", text: "short and complete", key: "small" });
  const con = scriptedConsole([]);
  const host = new Host(core);
  await host.add({ actor: "human:alice", harness: new HumanHarness({ console: con }) });
  await host.settle(2);
  const out = con.out.join("\n");
  assert.ok(out.length < 400_000, `the terminal got ${out.length} characters`);
  assert.match(out, /BEGIN x+ … \[\d+ more characters; read them whole with: piople events/);
  assert.match(out, /short and complete/, "short messages are whole");
  assert.match(out, /ask a0 from human:eve: q0 y+ … \[\d+ more characters/);
  assert.match(out, /-> answer a0 \| <text>/, "the hint on how to answer is not clipped away");
  await host.close();
  s.close();
});
