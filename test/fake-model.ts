import http from "node:http";

export type ChatMessage = { role: string; content: unknown };
export type FakeModel = { baseUrl: string; requests: ChatMessage[][]; /** Whole request bodies (model, tools, ...) in the same order. */ bodies: Array<Record<string, any>>; close(): Promise<void> };

const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));
export const lastUser = (m: ChatMessage[]) => text([...m].reverse().find((x) => x.role === "user")?.content);

/** A deterministic OpenAI-compatible /chat/completions endpoint (SSE) that answers from a function. */
export type FakeToolCall = { toolCall: { name: string; args: unknown } };
export async function fakeModel(reply: (messages: ChatMessage[], n: number) => string | { status: number } | FakeToolCall, opts: { tokensFromSize?: boolean } = {}): Promise<FakeModel> {
  const requests: ChatMessage[][] = [];
  const bodies: Array<Record<string, any>> = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b) as { model: string; messages: ChatMessage[] };
      requests.push(body.messages);
      bodies.push(body);
      const out = reply(body.messages, requests.length);
      const promptTokens = opts.tokensFromSize ? Math.ceil(JSON.stringify(body.messages).length / 4) : 10; // Pi decides on compaction from the usage the provider reports
      if (typeof out === "object" && "toolCall" in out) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        chunk({ id: "f", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: out.toolCall.name, arguments: JSON.stringify(out.toolCall.args) } }] } }] });
        chunk({ id: "f", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 } });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (typeof out !== "string") {
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `fake failure ${out.status}`, type: "fake" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      chunk({ id: "f", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: out } }] });
      chunk({ id: "f", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, bodies, close: () => new Promise((r) => srv.close(() => r())) };
}
