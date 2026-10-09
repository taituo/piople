import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { Store } from "../core/index.ts";

/**
 * Gated executor: a proposed action runs ONLY if
 *  1. its bound decision is resolved with answer "yes", AND
 *  2. env PIO_ALLOW_WRITE=1 (operator opt-in per run).
 * Otherwise it records a refusal. Dry-run is the default.
 */
export type Proposal = { verb: string; res: string; ns: string; name?: string; patch?: unknown };

const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

const WRITE_ALLOW = new Set(["patch"]);
const WRITE_RES = new Set(["configmap"]);

/**
 * The action to run is read from the stored `action.proposed` event, never from the
 * caller: what a human approved is exactly what executes. Execution is once-only per
 * proposal: after a success a repeated call returns the recorded outcome without touching
 * the cluster. Refusals and failures are logged under their own keys so a later retry
 * (decision resolved, opt-in set) is not shadowed by an old refusal.
 */
export async function executeIfApproved(
  s: Store,
  contextId: string,
  executorId: string,
  proposalId: string,
  decisionId: string,
): Promise<{ ran: boolean; output: string }> {
  const okKey = `exec:${proposalId}`;
  const done = s.findEvent(contextId, okKey);
  if (done) return { ran: true, output: String(done.data.output ?? "") };
  const refuse = (out: string) => {
    s.recordExecution(contextId, executorId, `exec-refused:${proposalId}:${randomUUID()}`, proposalId, decisionId, false, out);
    return { ran: false, output: out };
  };
  const stored = s.findEvent(contextId, `proposal:${proposalId}`);
  const data = stored?.data as { action?: Proposal; decisionId?: string } | undefined;
  if (!data?.action) return refuse(`refused: unknown proposal ${proposalId}`);
  if (data.decisionId !== decisionId) return refuse(`refused: decision ${decisionId} is not bound to proposal ${proposalId}`);
  const proposal = data.action;
  const d = s.getDecision(contextId, decisionId);
  if (!d || d.status !== "resolved" || d.answer !== "yes") {
    return refuse(`refused: decision ${decisionId} is ${d?.status ?? "missing"} (${d?.answer ?? "no answer"})`);
  }
  if (process.env.PIO_ALLOW_WRITE !== "1") {
    return refuse(`refused: PIO_ALLOW_WRITE!=1 (dry-run). Would run: kubectl ${proposal.verb} ${proposal.res} ${proposal.name ?? ""} -n ${proposal.ns}`);
  }
  if (!WRITE_ALLOW.has(proposal.verb) || !WRITE_RES.has(proposal.res) || proposal.ns !== "demo-apps") {
    return refuse("refused: action not in write-allowlist");
  }
  if (!proposal.name || !NAME_RE.test(proposal.name)) return refuse("refused: missing or invalid resource name");
  if (typeof proposal.patch !== "object" || proposal.patch === null || Array.isArray(proposal.patch)) return refuse("refused: patch must be a JSON object");
  const args = [proposal.verb, proposal.res, proposal.name, "-n", proposal.ns, "--type", "merge", "-p", JSON.stringify(proposal.patch)];
  const output: string = await new Promise((resolve) => {
    execFile("kubectl", args, { timeout: 15000, maxBuffer: 32 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? `FAILED: ${String(stderr ?? err.message).slice(0, 500)}` : String(stdout).slice(0, 500));
    });
  });
  const ok = !output.startsWith("FAILED");
  s.recordExecution(contextId, executorId, ok ? okKey : `exec-failed:${proposalId}:${randomUUID()}`, proposalId, decisionId, ok, output);
  return { ran: ok, output };
}
