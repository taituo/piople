import { Store } from "../core/index.ts";
import { OPS, runOp } from "../ops.ts";

/**
 * Minimal MCP server (stdio, JSON-RPC, no SDK). Exposes the same OPS as the CLI,
 * as tools named piople_<op>. Identity comes from PIO_ACTOR, set by the host
 * process — tool arguments can never change who is calling.
 *
 * Usage: PIO_DATA=./data/x.sqlite PIO_ACTOR=agent:ext node src/mcp/server.ts
 */
const ACTOR = process.env.PIO_ACTOR ?? process.env.PIO_MCP_ACTOR ?? "agent:ext";
const store = new Store(process.env.PIO_DATA ?? "./data/piople.sqlite");

type Req = { jsonrpc: string; id?: number | string | null; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

const TOOLS = Object.entries(OPS).map(([name, o]) => ({
  name: `piople_${name.replace(/-/g, "_")}`,
  description: o.description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries([...o.required, ...(o.optional ?? [])].map((k) => [k, { type: "string" }])),
    required: o.required,
  },
}));
const BY_TOOL = new Map(Object.keys(OPS).map((n) => [`piople_${n.replace(/-/g, "_")}`, n]));

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: Req["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
const err = (id: Req["id"], code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message: message.slice(0, 300) } });

function handle(req: Req) {
  if (req.id === undefined) return; // notification
  if (req.method === "initialize") {
    return ok(req.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "piople", version: "0.0.1" } });
  }
  if (req.method === "tools/list") return ok(req.id, { tools: TOOLS });
  if (req.method === "tools/call") {
    const op = BY_TOOL.get(req.params?.name ?? "");
    if (!op) return err(req.id, -32602, `unknown tool: ${req.params?.name}`);
    try {
      const out = runOp(store, ACTOR, op, req.params?.arguments ?? {});
      return ok(req.id, { content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (e) {
      // Protocol refusals are tool results, so the calling agent can see and react to them.
      return ok(req.id, { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
    }
  }
  return err(req.id, -32601, `unknown method: ${req.method}`);
}

let buf = "";
process.stdin.on("data", (d: Buffer) => {
  buf += d.toString("utf8");
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line) as Req);
    } catch {
      err(null, -32700, "parse error");
    }
  }
});
process.stdin.on("end", () => store.close());
