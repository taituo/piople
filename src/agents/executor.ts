import { execFile } from "node:child_process";
import { Store } from "../core/index.ts";

/**
 * Gated executor: a proposed action runs ONLY if
 *  1. its bound decision is resolved with answer "yes", AND
 *  2. env PIO_ALLOW_WRITE=1 (operator opt-in per run).
 * Otherwise it records a refusal. Dry-run is the default.
 */
export type Proposal = { verb: string; res: string; ns: string; name?: string; patch?: unknown };

const WRITE_ALLOW = new Set(["patch"]);
const WRITE_RES = new Set(["configmap"]);

export async function executeIfApproved(
  s: Store,
  contextId: string,
  executorId: string,
  proposalId: string,
  decisionId: string,
  proposal: Proposal,
): Promise<{ ran: boolean; output: string }> {
  const d = s.getDecision(contextId, decisionId);
  const key = `exec:${proposalId}`;
  if (!d || d.status !== "resolved" || d.answer !== "yes") {
    const out = `refused: decision ${decisionId} is ${d?.status ?? "missing"} (${d?.answer ?? "no answer"})`;
    s.recordExecution(contextId, executorId, key, proposalId, decisionId, false, out);
    return { ran: false, output: out };
  }
  if (process.env.PIO_ALLOW_WRITE !== "1") {
    const out = `refused: PIO_ALLOW_WRITE!=1 (dry-run). Would run: kubectl ${proposal.verb} ${proposal.res} ${proposal.name ?? ""} -n ${proposal.ns}`;
    s.recordExecution(contextId, executorId, key, proposalId, decisionId, false, out);
    return { ran: false, output: out };
  }
  if (!WRITE_ALLOW.has(proposal.verb) || !WRITE_RES.has(proposal.res) || proposal.ns !== "demo-apps") {
    const out = `refused: action not in write-allowlist`;
    s.recordExecution(contextId, executorId, key, proposalId, decisionId, false, out);
    return { ran: false, output: out };
  }
  const args = [proposal.verb, proposal.res, proposal.name!, "-n", proposal.ns, "--type", "merge", "-p", JSON.stringify(proposal.patch)];
  const output: string = await new Promise((resolve) => {
    execFile("kubectl", args, { timeout: 15000, maxBuffer: 32 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? `FAILED: ${String(stderr ?? err.message).slice(0, 500)}` : String(stdout).slice(0, 500));
    });
  });
  const ok = !output.startsWith("FAILED");
  s.recordExecution(contextId, executorId, key, proposalId, decisionId, ok, output);
  return { ran: ok, output };
}
