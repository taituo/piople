import { Store } from "../core/index.ts";
import { OPS, runOp, type Args } from "../ops.ts";
import { HttpCore } from "../http/client.ts";

/**
 * Minimal MCP server (stdio, JSON-RPC, no SDK). Exposes the same OPS as the CLI, as tools named
 * piople_<op>. Tool arguments can never change who is calling.
 *
 * Local  (same machine as the database):
 *   PIO_DATA=./data/x.sqlite PIO_ACTOR=agent:ext node src/mcp/server.ts
 * Remote (any machine that can reach a Core over HTTP; identity is the token's actor):
 *   PIO_CORE_URL=http://core:8899 PIO_TOKEN=pio_... node src/mcp/server.ts
 */
const remoteUrl = process.env.PIO_CORE_URL;
let actor = process.env.PIO_ACTOR ?? process.env.PIO_MCP_ACTOR ?? "agent:ext";
let store: Store | null = null;
let call: (op: string, args: Args) => Promise<unknown>;

if (remoteUrl) {
  const token = process.env.PIO_TOKEN;
  if (!token) die("PIO_CORE_URL needs PIO_TOKEN");
  const res = await fetch(`${remoteUrl.replace(/\/+$/, "")}/v1/whoami`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch((e: Error) => die(`cannot reach ${remoteUrl}: ${e.message}`));
  if (!res.ok) die(`${remoteUrl} refused the token (HTTP ${res.status})`);
  const who = ((await res.json()) as { actor: string }).actor;
  if (process.env.PIO_ACTOR && process.env.PIO_ACTOR !== who) die(`PIO_ACTOR=${process.env.PIO_ACTOR} but the token belongs to ${who}`);
  actor = who;
  const core = new HttpCore(remoteUrl, { [actor]: token });
  call = (op, args) => core.call(actor, op, args);
} else {
  store = new Store(process.env.PIO_DATA ?? "./data/piople.sqlite");
  const local = store;
  call = async (op, args) => runOp(local, actor, op, args);
}

function die(message: string): never {
  process.stderr.write(`piople-mcp: ${message}\n`);
  process.exit(1);
}

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

async function handle(req: Req) {
  if (req.id === undefined) return; // notification
  if (req.method === "initialize") {
    return ok(req.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "piople", version: "0.0.1" } });
  }
  if (req.method === "tools/list") return ok(req.id, { tools: TOOLS });
  if (req.method === "tools/call") {
    const op = BY_TOOL.get(req.params?.name ?? "");
    if (!op) return err(req.id, -32602, `unknown tool: ${req.params?.name}`);
    try {
      const out = await call(op, req.params?.arguments ?? {});
      return ok(req.id, { content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (e) {
      // Protocol refusals are tool results, so the calling agent can see and react to them.
      return ok(req.id, { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
    }
  }
  return err(req.id, -32601, `unknown method: ${req.method}`);
}

// Tool calls run one after another (a call over the network can be slow); everything else is
// answered at once, so one slow call never makes the server look dead to its client.
const MAX_LINE = 8_000_000;
let queue: Promise<void> = Promise.resolve();
let buf = "";
process.stdin.on("data", (d: Buffer) => {
  buf += d.toString("utf8");
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let req: Req;
    try {
      req = JSON.parse(line) as Req;
    } catch {
      err(null, -32700, "parse error");
      continue;
    }
    // Valid JSON is not always a request: `null`, a number or a list must not take the server down.
    if (!req || typeof req !== "object" || Array.isArray(req) || typeof req.method !== "string") {
      err(null, -32600, "invalid request");
      continue;
    }
    const answer = (e: unknown) => err(req.id ?? null, -32603, `internal error: ${e instanceof Error ? e.message : String(e)}`);
    if (req.method === "tools/call") queue = queue.then(async () => { await handle(req); }).catch(answer);
    else void handle(req).catch(answer);
  }
  if (buf.length > MAX_LINE) { // one endless line without a newline would otherwise grow without bound
    buf = "";
    err(null, -32600, `request line over ${MAX_LINE} bytes`);
  }
});
process.stdin.on("end", () => void queue.then(() => store?.close()));
