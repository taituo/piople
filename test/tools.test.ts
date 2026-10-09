import test from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/agents/tools.ts";

test("repo tool reads inside roots, blocks escapes", async () => {
  const ok = await runTool({ tool: "repo", op: "ls", path: "src/agents" });
  assert.equal(ok.ok, true);
  assert.ok(ok.output.includes("loop.ts"));
  const read = await runTool({ tool: "repo", op: "read", path: "src/agents/tools.ts", lines: 10 });
  assert.equal(read.ok, true);
  for (const bad of [
    { tool: "repo", op: "read", path: "../ogw/package.json" },
    { tool: "repo", op: "read", path: "/etc/passwd" },
    { tool: "repo", op: "write", path: "src/x" },
    { tool: "repo", op: "read", path: "data/archive/v1.sqlite" },
  ]) {
    const r = await runTool(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("tool allowlist blocks writes and other namespaces", async () => {
  const r1 = await runTool({ tool: "k8s", verb: "get", res: "configmap", name: "checkout-config", ns: "demo-apps" });
  assert.equal(r1.ok, true);
  assert.ok(r1.output.includes("POOL_SIZE"), "reads real config");
  for (const bad of [
    { tool: "k8s", verb: "patch", res: "configmap", ns: "demo-apps" },
    { tool: "k8s", verb: "delete", res: "pod", ns: "demo-apps" },
    { tool: "k8s", verb: "get", res: "configmap", ns: "kube-system" },
    { tool: "k8s", verb: "get", res: "secret", ns: "demo-apps" },
    { tool: "bash", verb: "get", res: "configmap", ns: "demo-apps" },
  ]) {
    const r = await runTool(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});
