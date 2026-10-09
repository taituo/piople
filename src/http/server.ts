import http from "node:http";
import { randomUUID } from "node:crypto";
import { Store } from "../core/index.ts";

const PORT = Number(process.env.PIO_PORT ?? 8899);
const DATA = process.env.PIO_DATA ?? "./data/piople.sqlite";
const TEST_USER = process.env.PIO_TEST_USER ?? ""; // dev/synthetic only
// AUTH_MODE=proxy: identity ONLY from x-piople-actor (set by a trusted proxy),
// body.actorId and TEST_USER are ignored. Default dev keeps current behavior.
const AUTH_MODE = process.env.PIO_AUTH_MODE ?? "dev";

const store = new Store(DATA);

// SSE subscribers per context
const subs = new Map<string, Set<http.ServerResponse>>();

function send(res: http.ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

function actorOf(req: http.IncomingMessage, body: Record<string, unknown>): string {
  const h = req.headers["x-piople-actor"];
  if (typeof h === "string" && h) return h;
  if (AUTH_MODE === "proxy") throw new Error("missing-actor: proxy mode requires x-piople-actor");
  if (typeof body.actorId === "string" && body.actorId) return body.actorId;
  if (TEST_USER) return TEST_USER;
  throw new Error("missing-actor");
}

const MAX_BODY = 1024 * 1024;

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("bad-request: body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("bad-request: invalid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("bad-request: body must be a JSON object");
  return body as Record<string, unknown>;
}

function stringList(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`bad-request: ${field} must be a string array`);
  return v as string[];
}

function broadcast(contextId: string, ev: unknown) {
  const set = subs.get(contextId);
  if (!set) return;
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const r of set) {
    if (r.destroyed) set.delete(r);
    else r.write(line);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      const contextId = url.searchParams.get("context") ?? "";
      const after = Number(url.searchParams.get("after") ?? 0);
      if (!Number.isInteger(after) || after < 0) throw new Error("bad-request: after must be a non-negative integer");
      const actor = actorOf(req, {});
      if (!contextId || !store.isMember(contextId, actor)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.headers.accept === "text/event-stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        let set = subs.get(contextId);
        if (!set) { set = new Set(); subs.set(contextId, set); }
        set.add(res);
        for (const e of store.eventsSince(contextId, after)) res.write(`data: ${JSON.stringify(e)}\n\n`);
        req.on("close", () => {
          set!.delete(res);
          if (!set!.size) subs.delete(contextId);
        });
        return;
      }
      send(res, 200, { events: store.eventsSince(contextId, after) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/contexts") {
      const body = await readBody(req);
      const actor = actorOf(req, body);
      const id = String(body.id ?? `case-${randomUUID().slice(0, 8)}`);
      store.upsertActor({ id: actor, kind: actor.startsWith("human:") ? "human" : "agent", name: actor });
      const ev = store.createContext({ id, kind: "case", title: String(body.title ?? id), goal: String(body.goal ?? ""), createdAt: Date.now() }, actor);
      store.join({ contextId: id, actorId: actor, capabilities: ["read", "write", "decide"], joinedAt: Date.now() }, `join:${actor}:init`);
      broadcast(id, ev);
      send(res, 200, { id, event: ev });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/join") {
      const body = await readBody(req);
      const actor = actorOf(req, body);
      const contextId = String(body.context ?? "");
      const member = String(body.member ?? actor);
      if (!store.isMember(contextId, actor)) throw new Error(`not-a-member: ${actor} not in ${contextId}`);
      for (const id of new Set([actor, member])) store.upsertActor({ id, kind: id.startsWith("human:") ? "human" : "agent", name: id });
      const ev = store.join(
        { contextId, actorId: member, capabilities: stringList(body.capabilities, "capabilities") ?? ["read", "write"], joinedAt: Date.now() },
        String(body.key ?? `join:${actor}:${randomUUID()}`),
        actor, // must already be a member and may only grant what it holds
      );
      broadcast(contextId, ev);
      send(res, 200, { event: ev });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/messages") {
      const body = await readBody(req);
      const actor = actorOf(req, body);
      const ev = store.postMessage(String(body.context), actor, String(body.key ?? randomUUID()), String(body.text ?? ""));
      broadcast(String(body.context), ev);
      send(res, 200, { event: ev });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/observations") {
      const body = await readBody(req);
      const actor = actorOf(req, body);
      const ev = store.recordObservation({
        id: String(body.id ?? randomUUID()),
        contextId: String(body.context),
        kind: "finding",
        authorId: actor,
        text: String(body.text ?? ""),
        status: (body.status as "hypothesis" | "confirmed" | "refuted" | null) ?? "hypothesis",
        evidence: stringList(body.evidence, "evidence") ?? [],
        createdAt: Date.now(),
      });
      broadcast(String(body.context), ev);
      send(res, 200, { event: ev });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/assistance") {
      const body = await readBody(req);
      const actor = actorOf(req, body);
      const ev = body.answer
        ? store.answerAssistance(String(body.context), actor, String(body.key ?? randomUUID()), String(body.requestKey), String(body.answer), (stringList(body.evidence, "evidence") ?? []))
        : store.requestAssistance(String(body.context), actor, String(body.key ?? randomUUID()), String(body.to), String(body.question), (body.snapshot as Record<string, unknown>) ?? {});
      broadcast(String(body.context), ev);
      send(res, 200, { event: ev });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/decisions") {
      const body = await readBody(req);
      const actor = actorOf(req, body);
      const ev = body.answer
        ? store.resolveDecision(String(body.context), actor, String(body.key ?? randomUUID()), String(body.decisionId), String(body.answer))
        : store.requestDecision({
            id: String(body.id ?? randomUUID()),
            contextId: String(body.context),
            question: String(body.question),
            options: stringList(body.options, "options") ?? ["yes", "no"],
            requestedBy: actor,
            decidedBy: null,
            answer: null,
            status: "open",
            createdAt: Date.now(),
            resolvedAt: null,
          });
      broadcast(String(body.context), ev);
      send(res, 200, { event: ev });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/presence") {
      const body = await readBody(req);
      const actor = actorOf(req, body);
      const ev = store.setPresence(actor, (body.state as "active" | "away" | "silent") ?? "active", body.echo === true);
      send(res, 200, { event: ev });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/promote") {
      const body = await readBody(req);
      const actor = actorOf(req, body);
      const ev = store.promoteObservation(String(body.artifactId), actor, body.status === "refuted" ? "refuted" : "confirmed");
      broadcast(ev.contextId, ev);
      send(res, 200, { event: ev });
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    const code = /^(forbidden|not-a-member|missing-actor)/.test(msg) ? 403 : 400;
    send(res, code, { error: msg });
  }
});

server.listen(PORT, () => console.log(`piople V0 listening on :${PORT} data=${DATA}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    for (const set of subs.values()) for (const r of set) r.end();
  });
}
