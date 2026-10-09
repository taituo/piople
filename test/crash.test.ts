import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Real SIGKILLs at named failpoints (src/core/failpoint.ts), then the next life must converge on the
 * same state as an undisturbed run, with every effect exactly once. Idea and shape from Entropi's crash matrix.
 */
type Life = { signal: string | null; summary?: Record<string, number>; err: string };
function life(dir: string, action: string, failpoint?: string): Promise<Life> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["test/crash/child.ts", dir, action], {
      env: { ...process.env, ...(failpoint ? { PIO_FAILPOINT: failpoint } : { PIO_FAILPOINT: "" }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (_c, signal) => {
      const line = out.split("\n").find((l) => l.startsWith("SUMMARY "));
      resolve({ signal, ...(line ? { summary: JSON.parse(line.slice(8)) as Record<string, number> } : {}), err });
    });
  });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "piople-crash-"));
const killed = (l: Life, why: string) => assert.equal(l.signal, "SIGKILL", `failpoint ${why} must fire (stderr: ${l.err.slice(0, 200)})`);

for (const point of ["store:observe:after-artifact", "store:before-commit"]) {
  test(`crash inside a mutation at ${point}: nothing half-written, and the retry records it once`, async () => {
    const dir = tmp();
    try {
      killed(await life(dir, "observe", point), point);
      const after = await life(dir, "none");
      assert.equal(after.signal, null, after.err);
      assert.deepEqual([after.summary!.artifacts, after.summary!.observed], [0, 0], "the interrupted transaction left no trace");
      const retry = await life(dir, "observe");
      assert.deepEqual([retry.summary!.artifacts, retry.summary!.observed], [1, 1]);
      const again = await life(dir, "observe");
      assert.deepEqual([again.summary!.artifacts, again.summary!.observed], [1, 1], "replaying the same call changes nothing");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("crash between the external effect and piople's record: the retry applies the effect no second time", async () => {
  const dir = tmp();
  try {
    killed(await life(dir, "exec", "exec:after-run"), "exec:after-run");
    const mid = await life(dir, "none");
    assert.equal(mid.summary!.effects, 1, "the effect happened");
    assert.equal(mid.summary!.executed, 0, "but piople never recorded it");
    const retry = await life(dir, "exec");
    assert.equal(retry.signal, null, retry.err);
    assert.equal(retry.summary!.effects, 1, "the adapter deduplicated by idempotency key");
    assert.equal(retry.summary!.executed, 1, "and now it is recorded, once");
    assert.equal(retry.summary!.resolved, 1);
    const again = await life(dir, "exec");
    assert.deepEqual([again.summary!.effects, again.summary!.executed], [1, 1], "another restart changes nothing");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("two crashes in a row still converge on one effect", async () => {
  const dir = tmp();
  try {
    killed(await life(dir, "exec", "exec:after-run"), "first");
    killed(await life(dir, "exec", "exec:after-run"), "second");
    const done = await life(dir, "exec");
    assert.deepEqual([done.summary!.effects, done.summary!.executed], [1, 1]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
