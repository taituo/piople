import { lookup } from "node:dns/promises";
import { connect, isIP, type Socket } from "node:net";

/**
 * A gate for a pod's init container: exit 0 only once a connection to a canary address is refused (or times out)
 * several times in a row, i.e. the network policy for this pod is demonstrably in force. Exit 1 if it never is within
 * the deadline, so the pod (and the container that holds a credential) never starts on a cluster that does not enforce
 * egress policy, or before it has caught up with a new pod (kube-router needs a moment).
 *   node src/hosts/egress-gate.ts <host> <port> [deadlineMs=30000] [needBlocked=3]
 */
/** Connect-level outcomes that are evidence of a closed path. Anything else (a name that does not resolve, a bad port) says nothing about the policy. */
const BLOCKING = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EACCES", "EPERM", "ETIMEDOUT"]);

/**
 * True only when the connection itself is refused, unreachable or times out. A name that does not resolve is NOT
 * evidence that egress is blocked (a typo in the canary would open the gate on a cluster with no policy at all), so
 * the host is resolved first and a failure there, or an invalid port, counts as "not shown to be blocked". Give the
 * canary as an IP address if DNS itself is behind the policy.
 */
export async function blocked(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  let address = host;
  if (!isIP(host)) {
    try { address = (await lookup(host)).address; } catch { return false; }
  }
  return new Promise((resolve) => {
    let s: Socket;
    try { s = connect({ host: address, port }); } catch { return resolve(false); } // bad port: no evidence either way
    const done = (b: boolean) => { s.destroy(); resolve(b); };
    s.setTimeout(timeoutMs, () => done(true));
    s.once("connect", () => done(false));
    s.once("error", (e: NodeJS.ErrnoException) => done(BLOCKING.has(e.code ?? "")));
  });
}

export async function waitUntilBlocked(host: string, port: number, o: { deadlineMs?: number; need?: number; gapMs?: number } = {}): Promise<boolean> {
  const t0 = Date.now(), need = o.need ?? 3;
  let streak = 0;
  while (Date.now() - t0 < (o.deadlineMs ?? 30_000)) {
    streak = (await blocked(host, port)) ? streak + 1 : 0;
    if (streak >= need) return true;
    await new Promise((r) => setTimeout(r, o.gapMs ?? 250));
  }
  return false;
}

if (import.meta.main) {
  const [host, port, deadline, need] = process.argv.slice(2);
  if (!host || !port) { console.error("usage: egress-gate <host> <port> [deadlineMs] [needBlocked]"); process.exit(2); }
  const ok = await waitUntilBlocked(host, Number(port), { deadlineMs: deadline ? Number(deadline) : undefined, need: need ? Number(need) : undefined });
  console.log(ok ? `egress to ${host}:${port} is blocked: policy in force` : `egress to ${host}:${port} is still open: refusing to start`);
  process.exit(ok ? 0 : 1);
}
