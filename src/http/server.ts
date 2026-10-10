import http from "node:http";
import type { Store } from "../core/index.ts";
import { runOp } from "../ops.ts";

/**
 * Core over HTTP, for participants in other processes and on other machines.
 *   GET  /v1/health          -> {ok:true}                (no auth)
 *   GET  /v1/whoami          -> {actor}
 *   POST /v1/ops/<op>  {args} -> {result} | {error:{code,message}}
 * Identity is the bearer token and nothing else: the caller cannot name another actor, so a host
 * that serves several actors needs one token per actor. The same ops table and the same Store rules
 * as CLI and MCP apply. Plain HTTP: terminate TLS in front of it and keep it off the open internet,
 * a bearer token is a password.
 */
export type ServerOptions = { maxBody?: number };

const STATUS: Array<[RegExp, number, string]> = [
  [/^(forbidden|not-a-member|not-in-realm)\b/, 403, "forbidden"],
  [/^(key-conflict|stale-claim|work-not-claimable|decision-not-open|already-routed)\b/, 409, "conflict"],
  [/^(hop-limit|too-many-pending)\b/, 429, "limit"],
  [/^(unknown-[a-z]+)\b/, 404, "not-found"],
  [/^(missing|bad-[a-z]+|work-needs-target)\b/, 400, "bad-request"],
];

export function statusFor(message: string): { status: number; code: string } {
  for (const [re, status, code] of STATUS) if (re.test(message)) return { status, code };
  return { status: 500, code: "error" };
}

export function createCoreServer(store: Store, o: ServerOptions = {}): http.Server {
  const maxBody = o.maxBody ?? 1_000_000;
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
      res.end(text);
    };
    const fail = (status: number, code: string, message: string) => send(status, { error: { code, message } });

    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/v1/health") return req.method === "GET" ? send(200, { ok: true }) : fail(405, "method", "GET only");

    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    const actor = m ? store.actorForToken(m[1]!) : undefined;
    if (!actor) return fail(401, "unauthorized", "missing or invalid token");

    if (url.pathname === "/v1/whoami") return req.method === "GET" ? send(200, { actor }) : fail(405, "method", "GET only");

    const op = /^\/v1\/ops\/([a-z-]+)$/.exec(url.pathname)?.[1];
    if (!op) return fail(404, "not-found", "no such route");
    if (req.method !== "POST") return fail(405, "method", "POST only");

    let size = 0;
    const chunks: Buffer[] = [];
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (tooBig) return;
      if (size > maxBody) {
        // Answer now and drop the connection: do not keep reading what we have already refused.
        tooBig = true;
        res.setHeader("connection", "close");
        fail(413, "too-large", `body over ${maxBody} bytes`);
        res.once("finish", () => req.destroy());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return;
      let args: unknown = {};
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim()) {
        try {
          args = JSON.parse(raw);
        } catch {
          return fail(400, "bad-request", "body is not valid JSON");
        }
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) return fail(400, "bad-request", "body must be a JSON object");
      try {
        send(200, { result: runOp(store, actor, op, args as Record<string, unknown>) });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const { status, code } = statusFor(message);
        fail(status, code, message.slice(0, 500));
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
