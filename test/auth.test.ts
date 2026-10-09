import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

function start(env: Record<string, string>, port: number): Promise<ChildProcess> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["src/http/server.ts"], {
      env: { ...process.env, PATH: `/opt/opencode-go-node/bin:${process.env.PATH}`, PIO_PORT: String(port), PIO_DATA: `:memory:`, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes(`listening on :${port}`)) resolve(p);
    });
    setTimeout(() => resolve(p), 3000);
  });
}

async function post(port: number, path: string, body: unknown, actor?: string): Promise<{ code: number; json: unknown }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(actor ? { "x-piople-actor": actor } : {}) },
    body: JSON.stringify(body),
  });
  return { code: res.status, json: await res.json().catch(() => ({})) };
}

test("proxy mode: header identity only, body spoof rejected", async () => {
  const srv = await start({ PIO_AUTH_MODE: "proxy" }, 18991);
  try {
    const ok = await post(18991, "/api/v1/contexts", { title: "t" }, "human:alice");
    assert.equal(ok.code, 200);
    const spoof = await post(18991, "/api/v1/messages", { context: (ok.json as { id: string }).id, actorId: "human:alice", text: "fake" });
    assert.equal(spoof.code, 403);
  } finally {
    srv.kill();
  }
});

test("dev mode: body actorId still works (backwards compatible)", async () => {
  const srv = await start({}, 18992);
  try {
    const r = await post(18992, "/api/v1/contexts", { title: "t", actorId: "human:alice" });
    assert.equal(r.code, 200);
  } finally {
    srv.kill();
  }
});

test("join: strangers cannot add themselves, members cannot grant what they lack", async () => {
  const srv = await start({}, 18993);
  try {
    const ctx = (await post(18993, "/api/v1/contexts", { title: "t" }, "human:alice")).json as { id: string };
    const self = await post(18993, "/api/v1/join", { context: ctx.id, capabilities: ["read", "write", "decide"] }, "agent:evil");
    assert.equal(self.code, 403);
    const add = await post(18993, "/api/v1/join", { context: ctx.id, member: "agent:scout", capabilities: ["read", "write"] }, "human:alice");
    assert.equal(add.code, 200);
    const up = await post(18993, "/api/v1/join", { context: ctx.id, capabilities: ["read", "write", "decide"] }, "agent:scout");
    assert.equal(up.code, 403);
    const junk = await post(18993, "/api/v1/join", { context: ctx.id, member: "agent:x", capabilities: "all" }, "human:alice");
    assert.equal(junk.code, 400);
  } finally {
    srv.kill();
  }
});
