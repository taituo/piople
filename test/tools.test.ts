import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeTools, runTool, TOOLS, type EnvironmentProfile, type ToolDef } from "../src/harnesses/tools.ts";

function area() {
  const base = mkdtempSync(join(tmpdir(), "piople-env-"));
  const root = join(base, "root");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(join(base, "outside"));
  writeFileSync(join(root, "a.txt"), "inside\n");
  writeFileSync(join(root, "sub", "b.txt"), "deeper\n");
  writeFileSync(join(base, "outside", "s.txt"), "TOPSECRET\n");
  symlinkSync(join(base, "outside", "s.txt"), join(root, "link.txt"));
  symlinkSync(join(base, "outside"), join(root, "linkdir"));
  const profile: EnvironmentProfile = { name: "reader", tools: ["read_file", "list_dir"], files: { root } };
  return { base, root, profile };
}
const probeRegistry: Record<string, ToolDef> = { probe: { description: "test", script: resolve("test/probe-tool.ts"), needsFiles: true } };
const probe = async (p: EnvironmentProfile, args: object = {}) => {
  const r = await runTool({ ...p, tools: ["probe"] }, "probe", args, probeRegistry);
  assert.ok(r.ok, JSON.stringify(r));
  return JSON.parse(r.output) as Record<string, any>;
};

test("bundled tools: read and list inside, refuse everything outside, say why without leaking paths", async () => {
  const { profile, base } = area();
  assert.deepEqual(await runTool(profile, "read_file", { path: "a.txt" }), { ok: true, output: "inside\n" });
  assert.deepEqual(await runTool(profile, "read_file", { path: "sub/b.txt" }), { ok: true, output: "deeper\n" });
  assert.deepEqual(await runTool(profile, "list_dir", {}), { ok: true, output: "a.txt\nlink.txt\nlinkdir/\nsub/" });
  for (const path of ["../outside/s.txt", join(base, "outside", "s.txt"), "/etc/passwd", "link.txt", "linkdir/s.txt", "sub/../../outside/s.txt"]) {
    const r = await runTool(profile, "read_file", { path });
    assert.deepEqual(r, { ok: false, error: "denied: outside the allowed directory" }, path);
  }
  assert.deepEqual(await runTool(profile, "list_dir", { path: ".." }), { ok: false, error: "denied: outside the allowed directory" });
  assert.deepEqual(await runTool(profile, "list_dir", { path: "linkdir" }), { ok: false, error: "denied: outside the allowed directory" });
  assert.deepEqual(await runTool(profile, "read_file", { path: "nope.txt" }), { ok: false, error: "not found" });
  assert.deepEqual(await runTool(profile, "read_file", { path: "sub" }), { ok: false, error: "not a regular file" });
  assert.deepEqual(await runTool(profile, "read_file", {}), { ok: false, error: "path must be a non-empty string" });
  assert.deepEqual(await runTool(profile, "read_file", "oops"), { ok: false, error: "path must be a non-empty string" });
});

test("a tool the profile does not list, or that does not exist, or that needs a directory the profile lacks, is refused", async () => {
  const { profile } = area();
  assert.match((await runTool({ ...profile, tools: ["list_dir"] }, "read_file", { path: "a.txt" }) as any).error, /not available/);
  assert.match((await runTool(profile, "rm_rf", {}) as any).error, /not available/);
  assert.match((await runTool({ name: "x", tools: ["read_file"] }, "read_file", { path: "a.txt" }) as any).error, /needs a directory/);
  assert.match((await runTool({ ...profile, files: { root: "/nonexistent/dir" } }, "read_file", { path: "a.txt" }) as any).error, /not available/);
  assert.deepEqual(describeTools({ ...profile, tools: ["list_dir", "nope", "read_file"] }).map((l) => l.split(" ")[0]), ["list_dir", "read_file"]);
});

test("the RUNTIME stops a naive tool: outside reads, directory listings, writes and child processes are all denied", async () => {
  const { profile, root } = area();
  const r = await probe(profile);
  assert.equal(r.inside.ok, true, "the allowed directory works");
  for (const k of ["dotdot", "absolute", "parentDir", "write", "spawn"]) assert.deepEqual(r[k], { ok: false, code: "ERR_ACCESS_DENIED" }, `${k} is denied by the runtime, not by tool code`);
  assert.equal(existsSync(join(root, "w.txt")), false, "nothing was written");
});

test("KNOWN LIMIT, pinned: the runtime follows a symlink inside the directory; the bundled tools close it with a realpath check", async () => {
  const { profile } = area();
  const r = await probe(profile);
  assert.deepEqual(r.symlink, { ok: true, value: "TOPSECRET\n" }, "if this starts failing Node changed: the realpath check may become redundant");
});

test("the child gets an empty environment: the harness's token and keys never reach a tool; only the profile's own env does", async () => {
  const { profile } = area();
  process.env.PIO_TOKEN = "pio_should_never_leak";
  process.env.OPENROUTER_API_KEY = "sk-or-should-never-leak";
  try {
    assert.deepEqual((await probe(profile)).env, []);
    assert.deepEqual((await probe({ ...profile, env: { TOOL_ONLY: "1" } })).env, ["TOOL_ONLY"]);
  } finally {
    delete process.env.PIO_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test("limits: a tool that hangs is killed on time, one that floods is cut off, and both come back as results", async () => {
  const { profile } = area();
  const t0 = Date.now();
  const slow = await runTool({ ...profile, tools: ["probe"], timeoutMs: 400 }, "probe", { mode: "sleep" }, probeRegistry);
  assert.match((slow as any).error, /longer than 400 ms/);
  assert.ok(Date.now() - t0 < 5000);
  const flood = await runTool({ ...profile, tools: ["probe"], maxOutputBytes: 50_000 }, "probe", { mode: "flood" }, probeRegistry);
  assert.match((flood as any).error, /too much output/);
});

test("bundled registry is what the agent is told about", () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), ["list_dir", "read_file"]);
});
