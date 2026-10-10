import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { blocked, waitUntilBlocked } from "../src/hosts/egress-gate.ts";

const listen = () => new Promise<net.Server & { port: number }>((resolve) => {
  const s = net.createServer((c) => c.end());
  s.listen(0, "127.0.0.1", () => resolve(Object.assign(s, { port: (s.address() as net.AddressInfo).port })));
});

test("a reachable canary is not blocked; a closed port is", async () => {
  const s = await listen();
  assert.equal(await blocked("127.0.0.1", s.port), false);
  const closed = s.port;
  await new Promise((r) => s.close(r));
  assert.equal(await blocked("127.0.0.1", closed), true);
});

test("the gate opens only after several refusals in a row, and stays shut while the canary answers", async () => {
  const s = await listen();
  assert.equal(await waitUntilBlocked("127.0.0.1", s.port, { deadlineMs: 700, need: 2, gapMs: 50 }), false, "policy not in force: never opens");
  setTimeout(() => s.close(), 200); // the policy 'arrives' after 200 ms
  const t0 = Date.now();
  assert.equal(await waitUntilBlocked("127.0.0.1", s.port, { deadlineMs: 5000, need: 3, gapMs: 50 }), true);
  assert.ok(Date.now() - t0 >= 200, "it waited for the change");
});

test("the entry exits 0 when blocked, 1 when still open, 2 on bad usage", async () => {
  const s = await listen();
  const run = (...a: string[]) => spawnSync(process.execPath, ["--no-warnings", "src/hosts/egress-gate.ts", ...a], { encoding: "utf8" });
  const open = run("127.0.0.1", String(s.port), "800", "2");
  assert.equal(open.status, 1);
  assert.match(open.stdout, /still open: refusing to start/);
  const closed = s.port;
  await new Promise((r) => s.close(r));
  assert.equal(run("127.0.0.1", String(closed), "3000", "2").status, 0);
  assert.equal(run().status, 2);
});

test("a name that does not resolve, or a bad port, is not evidence that egress is blocked: the gate stays shut", async () => {
  assert.equal(await blocked("no-such-host.invalid", 80, 1000), false);
  assert.equal(await blocked("127.0.0.1", 70_000, 300), false);
  assert.equal(await blocked("127.0.0.1", Number.NaN, 300), false);
  assert.equal(await waitUntilBlocked("no-such-host.invalid", 80, { deadlineMs: 1500, need: 2, gapMs: 50 }), false, "a typo in the canary must never open the gate");
  const r = spawnSync(process.execPath, ["--no-warnings", "src/hosts/egress-gate.ts", "no-such-host.invalid", "80", "1500", "2"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /still open: refusing to start/);
});
