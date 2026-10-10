import { randomUUID } from "node:crypto";
import { OPS, RANDOM_KEY_OPS, type Args, type CoreClient } from "../ops.ts";

export class CoreError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type HttpCoreOptions = {
  /** Extra attempts after a network failure, timeout or 5xx. */
  retries?: number;
  timeoutMs?: number;
  /** First backoff; doubles up to maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

/**
 * A CoreClient over HTTP. One token per actor: `call(as, ...)` speaks as exactly the actors it was
 * given tokens for. Retries are safe because the client fixes an idempotency key (or id) before the
 * first attempt, so a lost response replays on the server instead of duplicating. The one op that
 * cannot be retried blindly, `work-claim --next`, is not: a lost answer leaves the claim visible in
 * the inbox under `work.mine`, where the host resumes it.
 */
export class HttpCore implements CoreClient {
  private readonly base: string;
  private readonly tokens: Map<string, string>;
  private readonly o: Required<Omit<HttpCoreOptions, "fetch">> & { fetch: typeof fetch };

  constructor(baseUrl: string, tokens: Record<string, string>, o: HttpCoreOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.tokens = new Map(Object.entries(tokens));
    this.o = { retries: o.retries ?? 3, timeoutMs: o.timeoutMs ?? 10_000, backoffMs: o.backoffMs ?? 100, maxBackoffMs: o.maxBackoffMs ?? 2_000, fetch: o.fetch ?? fetch };
  }

  async call(as: string, op: string, args: Args = {}): Promise<unknown> {
    const token = this.tokens.get(as);
    if (!token) throw new Error(`no-token: this client holds no credential for ${as}`);
    const a: Args = { ...args };
    const def = OPS[op];
    if (RANDOM_KEY_OPS.has(op) && def?.optional?.includes("key")) a.key ??= randomUUID();
    else if (def?.mintsId) a.id ??= `i-${randomUUID().slice(0, 12)}`;
    const retryable = !(op === "work-claim" && (a.next === true || a.next === "true"));

    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.o.fetch(`${this.base}/v1/ops/${op}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(a),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { code?: string; message?: string } };
        if (res.ok) return body.result;
        const err = new CoreError(res.status, body.error?.code ?? "error", body.error?.message ?? `HTTP ${res.status}`);
        if (res.status < 500) throw err; // the core answered: retrying will not change a refusal
        lastError = err;
      } catch (e) {
        if (e instanceof CoreError && e.status < 500) throw e;
        lastError = e;
      }
      if (!retryable || attempt >= this.o.retries) break;
      await new Promise((r) => setTimeout(r, Math.min(this.o.backoffMs * 2 ** attempt, this.o.maxBackoffMs)));
    }
    if (lastError instanceof CoreError) throw lastError;
    throw new Error(`core-unreachable: ${this.base} (${lastError instanceof Error ? lastError.message : String(lastError)})`);
  }
}
