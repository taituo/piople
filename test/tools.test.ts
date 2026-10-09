import test from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/agents/tools.ts";

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
