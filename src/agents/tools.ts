import { execFile } from "node:child_process";

/**
 * V2 read-only tools. Allowlist, not blocklist: only kubectl read verbs in
 * explicitly permitted namespaces. No exec, patch, apply, delete — ever.
 */
const ALLOWED_NS = new Set(["demo-apps"]);
const ALLOWED_VERBS = new Set(["get", "describe", "logs"]);
const ALLOWED_RES = new Set(["configmap", "configmaps", "deployment", "deployments", "pod", "pods", "service", "services", "events"]);

export type ToolResult = { ok: boolean; output: string };

export function describeTools(): string {
  return `Tools (reply with exactly one line TOOLCALL <json> to use, max 3 per turn):
{"tool":"k8s","verb":"get|describe|logs","res":"configmap|deployment|pod|service|events","name?":string,"ns":"demo-apps","tail?":number}`;
}

export async function runTool(call: { tool?: string; verb?: string; res?: string; name?: string; ns?: string; tail?: number }): Promise<ToolResult> {
  if (call.tool !== "k8s") return { ok: false, output: "unknown tool" };
  const { verb = "", res = "", name = "", ns = "" } = call;
  if (!ALLOWED_NS.has(ns)) return { ok: false, output: `forbidden namespace: ${ns}` };
  if (!ALLOWED_VERBS.has(verb)) return { ok: false, output: `forbidden verb: ${verb}` };
  if (!ALLOWED_RES.has(res)) return { ok: false, output: `forbidden resource: ${res}` };
  const args = [verb, res];
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, output: "bad name" };
    args.push(name);
  }
  args.push("-n", ns);
  if (verb === "logs") args.push(`--tail=${Math.min(call.tail ?? 20, 50)}`);
  if (verb === "get" && !name) args.push("-o", "name");
  else if (verb === "get") args.push("-o", "yaml");
  return new Promise((resolve) => {
    execFile("kubectl", args, { timeout: 15000, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, output: `kubectl failed: ${String(stderr ?? err.message).slice(0, 1000)}` });
      else resolve({ ok: true, output: String(stdout).slice(0, 4000) });
    });
  });
}
