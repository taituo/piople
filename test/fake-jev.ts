import http from "node:http";

export type JevRequest = { authorization: string | undefined; body: any };
export type Reply = unknown | { status: number; raw?: string } | { redirect: string } | { hang: true };
export type FakeJev = { url: string; requests: JevRequest[]; close(): Promise<void> };

/** A valid Jev-shaped answer for the request: `choice` gets probability p, the rest share the remainder. */
export function answerFor(body: any, choice: string, o: { p?: number; noul?: number; confidence?: number; metaConfidence?: number } = {}) {
  const labels = Object.keys(body.questions.target.criteria);
  const p = o.p ?? 0.9;
  const rest = labels.length > 1 ? (1 - p) / (labels.length - 1) : 0;
  const probabilities = Object.fromEntries(labels.map((l) => [l, l === choice ? p : rest]));
  return {
    answers: {
      target: { type: "choice", choice, probabilities, ...(o.confidence !== undefined ? { confidence: o.confidence } : {}) },
      needs_human: { type: "noul", noul: o.noul ?? 0.05 },
    },
    ...(o.metaConfidence !== undefined ? { providerMetadata: { typesafe: { confidence: { target: o.metaConfidence } } } } : {}),
  };
}

/** A local stand-in for the Jev decisions endpoint (OpenRouter-style shape). */
export async function fakeJev(reply: (body: any, n: number) => Reply): Promise<FakeJev> {
  const requests: JevRequest[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b);
      requests.push({ authorization: req.headers.authorization, body });
      const r = reply(body, requests.length) as any;
      if (r && r.hang) return; // never answer
      if (r && r.redirect) { res.writeHead(302, { location: r.redirect }); return void res.end(); }
      if (r && typeof r.status === "number") { res.writeHead(r.status, { "content-type": "text/plain" }); return void res.end(r.raw ?? ""); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/decisions`;
  return { url, requests, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
