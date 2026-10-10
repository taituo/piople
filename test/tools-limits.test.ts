import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, type EnvironmentProfile } from "../src/harnesses/tools.ts";

function profile() {
  const root = join(mkdtempSync(join(tmpdir(), "piople-toollimits-")), "agent");
  mkdirSync(root);
  const p: EnvironmentProfile = { name: "t", tools: ["read_file"], files: { root }, timeoutMs: 15_000 };
  return { root, p };
}

test("read_file answers for any maxBytes, even for content that grows when escaped as JSON", async () => {
  const { root, p } = profile();
  writeFileSync(join(root, "quotes.txt"), '"'.repeat(900_000));
  writeFileSync(join(root, "ctrl.bin"), Buffer.alloc(300_000, 1));
  for (const f of ["quotes.txt", "ctrl.bin"]) {
    const r = await runTool(p, "read_file", { path: f, maxBytes: 1_000_000 });
    assert.equal(r.ok, true, `${f}: ${JSON.stringify(r).slice(0, 100)}`);
    if (r.ok) assert.match(r.output, /…\(cut at 100000 of \d+ bytes\)$/);
  }
});

test("read_file does not load a huge file into memory: a sparse 1.5 GB file is answered with its first bytes", async () => {
  const { root, p } = profile();
  const big = join(root, "big.bin");
  writeFileSync(big, "start-of-file");
  truncateSync(big, 1.5 * 1024 ** 3);
  const t0 = Date.now();
  const r = await runTool(p, "read_file", { path: "big.bin", maxBytes: 20 });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 120));
  if (r.ok) assert.match(r.output, /^start-of-file\u0000+\n…\(cut at 20 of 1610612736 bytes\)$/);
  assert.ok(Date.now() - t0 < 5_000, "answered quickly");
});

test("read_file small files are returned whole, with no cut marker", async () => {
  const { root, p } = profile();
  writeFileSync(join(root, "a.txt"), "héllo wörld ä");
  const r = await runTool(p, "read_file", { path: "a.txt" });
  assert.deepEqual(r, { ok: true, output: "héllo wörld ä" });
});
