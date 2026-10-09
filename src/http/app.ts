import http from "node:http";
import { randomUUID } from "node:crypto";
import { Store } from "../core/index.ts";

/**
 * HTTP + SSE over the Store, as a factory so tests can run it in-process. Every route takes the actor from
 * the auth mode and goes through Store operations, so "the API can't but the agent can" is not a thing.
 * Errors map to statuses by the Store's own message prefixes; anything unexpected is a plain 500 that
 * never leaks internals.
 */
export type AppOptions = {
  /** "proxy": identity ONLY from x-piople-actor (set by a trusted proxy); "dev": body.actorId / testUser also work. */
  authMode?: "dev" | "proxy";
  testUser?: string;
  maxBodyBytes?: number;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9:_.@#-]{0,127}$/;
const MAX_TEXT = 4000;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const bad = (m: string) => new HttpError(400, `bad-request: ${m}`);

type Body = Record<string, unknown>;

function id(b: Body, k: string, required = true): string | undefined {
  const v = b[k];
  if (v === undefined || v === null) { if (required) throw bad(`${k} is required`); return undefined; }
  if (typeof v !== "string" || !ID.test(v)) throw bad(`${k} must be an id (letters, digits, : _ . @ # -; max 128)`);
  return v;
}
function text(b: Body, k: string, required = true): string | undefined {
  const v = b[k];
  if (v === undefined || v === null) { if (required) throw bad(`${k} is required`); return undefined; }
  if (typeof v !== "string") throw bad(`${k} must be a string`);
  if (required && !v.trim()) throw bad(`${k} must not be empty`);
  if ([...v].length > MAX_TEXT) throw bad(`${k} is longer than ${MAX_TEXT} characters`);
  return v;
}
function strings(b: Body, k: string, max = 50): string[] | undefined {
  const v = b[k];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || x.length > 500)) throw bad(`${k} must be an array of at most ${max} short strings`);
  return v as string[];
}
function oneOf<T extends string>(b: Body, k: string, allowed: readonly T[], fallback: T): T {
  const v = b[k];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw bad(`${k} must be one of: ${allowed.join(", ")}`);
  return v as T;
}

/** Status for an error message, by the prefixes the Store uses. */
export function statusOf(e: unknown): { status: number; message: string } {
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  if (/^(forbidden|not-a-member|missing-actor)/.test(msg)) return { status: 403, message: msg };
  if (/^(unknown-|not-found)/.test(msg)) return { status: 404, message: msg };
  if (/^(decision-not-open|decision-expired|conflict)/.test(msg)) return { status: 409, message: msg };
  if (/^bad-request/.test(msg)) return { status: 400, message: msg };
  if (/UNIQUE constraint failed/.test(msg)) return { status: 409, message: "conflict: already exists" };
  if (/FOREIGN KEY constraint failed/.test(msg)) return { status: 404, message: "not-found: unknown reference" };
  return { status: 500, message: "internal error" };
}

export function createApp(store: Store, o: AppOptions = {}): http.Server {
  const authMode = o.authMode ?? "dev";
  const maxBody = o.maxBodyBytes ?? 256 * 1024;
  const subs = new Map<string, Set<http.ServerResponse>>();

  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    const t = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(t) });
    res.end(t);
  };

  function actorOf(req: http.IncomingMessage, body: Body): string {
    const h = req.headers["x-piople-actor"];
    if (typeof h === "string" && h) {
      if (!ID.test(h)) throw new HttpError(403, "missing-actor: malformed x-piople-actor");
      return h;
    }
    if (authMode === "proxy") throw new HttpError(403, "missing-actor: proxy mode requires x-piople-actor");
    if (typeof body.actorId === "string" && body.actorId) {
      if (!ID.test(body.actorId)) throw new HttpError(403, "missing-actor: malformed actorId");
      return body.actorId;
    }
    if (o.testUser) return o.testUser;
    throw new HttpError(403, "missing-actor");
  }

  async function readBody(req: http.IncomingMessage): Promise<Body> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > maxBody) throw new HttpError(413, "bad-request: body too large");
      chunks.push(c as Buffer);
    }
    if (!chunks.length) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw bad("invalid JSON"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw bad("body must be a JSON object");
    return parsed as Body;
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
  const actorRow = (actor: string) => store.upsertActor({ id: actor, kind: actor.startsWith("human:") ? "human" : "agent", name: actor });

  type Handler = (body: Body, actor: string) => { code?: number; payload: unknown; broadcastTo?: string; ev?: unknown };
  const posts: Record<string, Handler> = {
    "/api/v1/contexts": (b, actor) => {
      const cid = id(b, "id", false) ?? `case-${randomUUID().slice(0, 8)}`;
      actorRow(actor);
      const ev = store.createContext({ id: cid, kind: "case", title: text(b, "title", false) ?? cid, goal: text(b, "goal", false) ?? "", createdAt: Date.now() }, actor);
      return { payload: { id: cid, event: ev }, broadcastTo: cid, ev };
    },
    "/api/v1/join": (b, actor) => {
      const contextId = id(b, "context")!;
      const member = id(b, "member", false) ?? actor;
      if (!store.isMember(contextId, actor)) throw new HttpError(403, `not-a-member: ${actor} not in ${contextId}`);
      for (const a of new Set([actor, member])) actorRow(a);
      const ev = store.join(
        { contextId, actorId: member, capabilities: strings(b, "capabilities", 10) ?? ["read", "write"], joinedAt: Date.now() },
        id(b, "key", false) ?? `join:${actor}:${randomUUID()}`,
        actor, // the granter must be a member and may only grant what it holds
      );
      return { payload: { event: ev }, broadcastTo: contextId, ev };
    },
    "/api/v1/messages": (b, actor) => {
      const c = id(b, "context")!;
      const ev = store.postMessage(c, actor, id(b, "key", false) ?? randomUUID(), text(b, "text")!);
      return { payload: { event: ev }, broadcastTo: c, ev };
    },
    "/api/v1/observations": (b, actor) => {
      const c = id(b, "context")!;
      const ev = store.recordObservation({
        id: id(b, "id", false) ?? randomUUID(), contextId: c, kind: "finding", authorId: actor, text: text(b, "text")!,
        status: oneOf(b, "status", ["hypothesis", "confirmed", "refuted"] as const, "hypothesis"), evidence: strings(b, "evidence") ?? [], createdAt: Date.now(),
      });
      return { payload: { event: ev }, broadcastTo: c, ev };
    },
    "/api/v1/assistance": (b, actor) => {
      const c = id(b, "context")!;
      const key = id(b, "key", false) ?? randomUUID();
      const ev = b.answer !== undefined
        ? store.answerAssistance(c, actor, key, id(b, "requestKey")!, text(b, "answer")!, strings(b, "evidence") ?? [])
        : store.requestAssistance(c, actor, key, id(b, "to")!, text(b, "question")!, typeof b.snapshot === "object" && b.snapshot !== null && !Array.isArray(b.snapshot) ? (b.snapshot as Record<string, unknown>) : {});
      return { payload: { event: ev }, broadcastTo: c, ev };
    },
    "/api/v1/decisions": (b, actor) => {
      const c = id(b, "context")!;
      const ev = b.answer !== undefined
        ? store.resolveDecision(c, actor, id(b, "key", false) ?? randomUUID(), id(b, "decisionId")!, text(b, "answer")!)
        : store.requestDecision({
            id: id(b, "id", false) ?? randomUUID(), contextId: c, question: text(b, "question")!, options: strings(b, "options", 10) ?? ["yes", "no"],
            requestedBy: actor, decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null,
            expiresAt: typeof b.expiresAt === "number" && Number.isFinite(b.expiresAt) ? b.expiresAt : null,
          });
      return { payload: { event: ev }, broadcastTo: c, ev };
    },
    "/api/v1/presence": (b, actor) => {
      actorRow(actor);
      const ev = store.setPresence(actor, oneOf(b, "state", ["active", "away", "silent"] as const, "active"), b.echo === true);
      return { payload: { event: ev } };
    },
    "/api/v1/promote": (b, actor) => {
      const ev = store.promoteObservation(id(b, "artifactId")!, actor, oneOf(b, "status", ["confirmed", "refuted"] as const, "confirmed"));
      return { payload: { event: ev }, broadcastTo: ev.contextId, ev };
    },
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/healthz") {
        if (req.method !== "GET") throw new HttpError(405, "method-not-allowed");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok\n");
        return;
      }
      if (url.pathname === "/events") {
        if (req.method !== "GET") throw new HttpError(405, "method-not-allowed");
        const contextId = url.searchParams.get("context") ?? "";
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isInteger(after) || after < 0) throw bad("after must be a non-negative integer");
        const actor = actorOf(req, {});
        // an unknown case and a case you are not in answer the same: no hint that it exists
        if (!ID.test(contextId) || !store.isMember(contextId, actor)) throw new HttpError(403, "not-a-member");
        if (req.headers.accept === "text/event-stream") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          let set = subs.get(contextId);
          if (!set) { set = new Set(); subs.set(contextId, set); }
          const mine = set;
          mine.add(res);
          for (const e of store.eventsSince(contextId, after)) res.write(`data: ${JSON.stringify(e)}\n\n`);
          req.on("close", () => {
            mine.delete(res);
            if (!mine.size) subs.delete(contextId);
          });
          return;
        }
        send(res, 200, { events: store.eventsSince(contextId, after) });
        return;
      }
      if (url.pathname === "/api/v1/focus") {
        if (req.method !== "GET") throw new HttpError(405, "method-not-allowed");
        send(res, 200, { needsYou: store.needsYou(actorOf(req, {})) });
        return;
      }
      const handler = posts[url.pathname];
      if (!handler) throw new HttpError(404, "not-found");
      if (req.method !== "POST") throw new HttpError(405, "method-not-allowed");
      const body = await readBody(req);
      const actor = actorOf(req, body);
      const r = handler(body, actor);
      if (r.broadcastTo) broadcast(r.broadcastTo, r.ev);
      send(res, r.code ?? 200, r.payload);
    } catch (e) {
      const { status, message } = statusOf(e);
      if (status >= 500) console.error("piople http:", e);
      if (!res.headersSent) send(res, status, { error: message });
    }
  });
}
