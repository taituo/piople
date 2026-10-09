import { randomUUID } from "node:crypto";
import { Store } from "../core/index.ts";

/**
 * G: minimal MCP server (stdio, JSON-RPC) over the piople protocol.
 * No SDK: three read tools + two gated writes, same Store rules as HTTP.
 * Identity comes from env PIO_MCP_ACTOR (set by the host); every call
 * re-checks membership/capabilities. Writes need no extra auth here
 * because propose/answer never execute side effects by themselves.
 *
 * Usage: PIO_DATA=./data/x.sqlite PIO_MCP_ACTOR=agent:ext node src/mcp/server.ts
 */
const ACTOR = process.env.PIO_MCP_ACTOR ?? "agent:ext";
const DATA = process.env.PIO_DATA ?? "./data/piople.sqlite";
const store = new Store(DATA);

type Req = { jsonrpc: string; id?: number | string | null; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

const TOOLS = [
  { name: "piople_events", description: "Read context events after seq", inputSchema: { type: "object", properties: { context: { type: "string" }, after: { type: "number" } }, required: ["context"] } },
  { name: "piople_post", description: "Post a message (member+write required)", inputSchema: { type: "object", properties: { context: { type: "string" }, key: { type: "string" }, text: { type: "string" } }, required: ["context", "text"] } },
  { name: "piople_observe", description: "Record a finding (member+write required)", inputSchema: { type: "object", properties: { context: { type: "string" }, text: { type: "string" }, evidence: { type: "array" } }, required: ["context", "text"] } },
  { name: "piople_answer", description: "Answer an assistance request (member or invited)", inputSchema: { type: "object", properties: { context: { type: "string" }, key: { type: "string" }, requestKey: { type: "string" }, answer: { type: "string" } }, required: ["context", "requestKey", "answer"] } },
];

function ok(id: Req["id"] | undefined, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function err(id: Req["id"] | undefined, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: String(message).slice(0, 300) } }) + "\n");
}

let buf = "";
process.stdin.on("data", (d: Buffer) => {
  buf += d.toString("utf8");
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let req: Req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    // JSON-RPC notifications carry no id and must never be answered.
    if (req.id === undefined || req.id === null) continue;
    try {
      if (req.method === "initialize") {
        ok(req.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "piople", version: "0.0.1" } });
      } else if (req.method === "tools/list") {
        ok(req.id, { tools: TOOLS });
      } else if (req.method === "tools/call") {
        const name = req.params?.name ?? "";
        const a = req.params?.arguments ?? {};
        if (name === "piople_events") {
          if (!store.isMember(String(a.context), ACTOR)) throw new Error("not-a-member");
          ok(req.id, { content: [{ type: "text", text: JSON.stringify(store.eventsSince(String(a.context), Number(a.after ?? 0))) }] });
        } else if (name === "piople_post") {
          const ev = store.postMessage(String(a.context), ACTOR, String(a.key ?? `mcp:${randomUUID()}`), String(a.text));
          ok(req.id, { content: [{ type: "text", text: JSON.stringify(ev) }] });
        } else if (name === "piople_observe") {
          const ev = store.recordObservation({ id: `mcp:${randomUUID()}`, contextId: String(a.context), kind: "finding", authorId: ACTOR, text: String(a.text), status: "hypothesis", evidence: (a.evidence as string[]) ?? [], createdAt: Date.now() });
          ok(req.id, { content: [{ type: "text", text: JSON.stringify(ev) }] });
        } else if (name === "piople_answer") {
          const ev = store.answerAssistance(String(a.context), ACTOR, String(a.key ?? `mcp:${randomUUID()}`), String(a.requestKey), String(a.answer), []);
          ok(req.id, { content: [{ type: "text", text: JSON.stringify(ev) }] });
        } else {
          err(req.id, -32602, `unknown tool: ${name}`);
        }
      } else if (req.method === "ping") {
        ok(req.id, {});
      } else {
        err(req.id, -32601, `unknown method: ${req.method}`);
      }
    } catch (e) {
      err(req.id, -32000, e instanceof Error ? e.message : "error");
    }
  }
});
