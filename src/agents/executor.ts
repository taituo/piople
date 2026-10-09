import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store, failpoint } from "../core/index.ts";
import { allowedNamespaces } from "./tools.ts";

/**
 * Gated executor: a proposed action runs ONLY if
 *  1. its bound decision is resolved with answer "yes", AND
 *  2. the operator opted in (PIO_ALLOW_WRITE=1, or `allowWrite` for sandboxed worlds), AND
 *  3. the adapter named by the stored action accepts it.
 * Otherwise it records a refusal. Dry-run is the default.
 *
 * Adapters are the only code that can touch the outside world. An adapter validates the
 * action against its own allowlist and runs it; piople core never learns what "patch" means.
 */
export type Action = Record<string, unknown>;
export type Adapter = {
  /** Return an error string to refuse the action, or null to accept it. */
  check(action: Action): string | null;
  /**
   * Do it. `idempotencyKey` is stable across retries of the same proposal: an adapter must never apply one
   * key twice, because the process can die after the effect and before piople records it.
   */
  run(action: Action, ctx: { idempotencyKey: string }): Promise<{ ok: boolean; output: string }>;
  /** Human-readable dry-run description. */
  describe(action: Action): string;
};
export type ExecuteOptions = { adapters?: Record<string, Adapter>; allowWrite?: boolean; defaultAdapter?: string };

const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const KUBECTL_VERBS = new Set(["patch"]);
const KUBECTL_RES = new Set(["configmap"]);

/** Real cluster writes: patch of a configmap in the allowed namespaces. Default adapter. */
export const kubectlAdapter: Adapter = {
  check(a) {
    if (!KUBECTL_VERBS.has(String(a.verb)) || !KUBECTL_RES.has(String(a.res)) || !allowedNamespaces().has(String(a.ns))) return "action not in write-allowlist";
    if (typeof a.name !== "string" || !NAME_RE.test(a.name)) return "missing or invalid resource name";
    if (typeof a.patch !== "object" || a.patch === null || Array.isArray(a.patch)) return "patch must be a JSON object";
    return null;
  },
  describe: (a) => `kubectl ${String(a.verb)} ${String(a.res)} ${String(a.name ?? "")} -n ${String(a.ns)}`,
  run: (a) =>
    new Promise((resolve) => {
      const args = [String(a.verb), String(a.res), String(a.name), "-n", String(a.ns), "--type", "merge", "-p", JSON.stringify(a.patch)];
      execFile("kubectl", args, { timeout: 15000, maxBuffer: 32 * 1024 }, (err, stdout, stderr) => {
        resolve(err ? { ok: false, output: `FAILED: ${String(stderr ?? err.message).slice(0, 500)}` } : { ok: true, output: String(stdout).slice(0, 500) });
      });
    }),
};

export const DEFAULT_ADAPTERS: Record<string, Adapter> = { kubectl: kubectlAdapter };

/**
 * Exactly-once, in two halves: the adapter dedups the effect by idempotency key, piople dedups the record by event key.
 * The action to run is read from the stored `action.proposed` event, never from the
 * caller: what a human approved is exactly what executes. After a success a repeated call
 * returns the recorded outcome without touching the world. Refusals and failures are logged
 * under their own keys so a later retry (decision resolved, opt-in set) is not shadowed by
 * an old refusal.
 */
export async function executeIfApproved(
  s: Store,
  contextId: string,
  executorId: string,
  proposalId: string,
  decisionId: string,
  opts: ExecuteOptions = {},
): Promise<{ ran: boolean; output: string }> {
  const okKey = `exec:${proposalId}`;
  const done = s.findEvent(contextId, okKey);
  if (done) return { ran: true, output: String(done.data.output ?? "") };
  const refuse = (out: string) => {
    s.recordExecution(contextId, executorId, `exec-refused:${proposalId}:${randomUUID()}`, proposalId, decisionId, false, out);
    return { ran: false, output: out };
  };
  const stored = s.findEvent(contextId, `proposal:${proposalId}`);
  const data = stored?.data as { action?: Action; decisionId?: string } | undefined;
  if (!data?.action) return refuse(`refused: unknown proposal ${proposalId}`);
  if (data.decisionId !== decisionId) return refuse(`refused: decision ${decisionId} is not bound to proposal ${proposalId}`);
  const action = data.action;
  const adapterName = typeof action.adapter === "string" ? action.adapter : (opts.defaultAdapter ?? "kubectl");
  const adapter = (opts.adapters ?? DEFAULT_ADAPTERS)[adapterName];
  const d = s.getDecision(contextId, decisionId);
  if (!d || d.status !== "resolved" || d.answer !== "yes") {
    return refuse(`refused: decision ${decisionId} is ${d?.status ?? "missing"} (${d?.answer ?? "no answer"})`);
  }
  if (!adapter) return refuse(`refused: no adapter "${adapterName}"`);
  if (!(opts.allowWrite ?? process.env.PIO_ALLOW_WRITE === "1")) {
    return refuse(`refused: PIO_ALLOW_WRITE!=1 (dry-run). Would run: ${adapter.describe(action)}`);
  }
  const bad = adapter.check(action);
  if (bad) return refuse(`refused: ${bad}`);
  const result = await adapter.run(action, { idempotencyKey: okKey });
  failpoint("exec:after-run"); // crash window: the world changed, piople has not recorded it yet
  s.recordExecution(contextId, executorId, result.ok ? okKey : `exec-failed:${proposalId}:${randomUUID()}`, proposalId, decisionId, result.ok, result.output);
  return { ran: result.ok, output: result.output };
}
