import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { CaseMemory, extractiveSummarizer, modelSummarizer, eventLine, type MemEvent, type Summarizer } from "../src/harnesses/memory.ts";

const msg = (seq: number, text: string, actorId = "human:alice"): MemEvent => ({ seq, actorId, type: "message.posted", data: { text } });
const history = (n: number, plant?: { at: number; text: string }) => Array.from({ length: n }, (_, i) => msg(i + 1, plant && plant.at === i + 1 ? plant.text : `routine message number ${i + 1} about nothing in particular`));
const open = (o: Partial<{ summarizer: Summarizer; k: number; recent: number }> = {}) => CaseMemory.open(":memory:", { summarizer: extractiveSummarizer(), k: 4, recent: 6, ...o });
const build = async (m: CaseMemory, events: MemEvent[]) => { m.ingest("c1", events); await m.compact("c1"); };
const dump = (m: CaseMemory) => JSON.stringify((m as any).db.prepare(`SELECT id, level, first_seq, last_seq, text, children, parent FROM nodes ORDER BY level, first_seq`).all());

test("short history: everything verbatim, nothing summarised", async () => {
  const m = open();
  await build(m, history(5));
  assert.equal(await m.compact("c1"), 0);
  assert.equal(m.view("c1").nodes, 5);
  assert.match(m.view("c1").text, /\[e3\] 3 human:alice message.posted: routine message number 3/);
  m.close();
});

test("a long history stays within the budget, newest verbatim, older folded into summaries of summaries", async () => {
  const m = open();
  await build(m, history(300));
  const v = m.view("c1", 800);
  assert.ok(v.text.length <= 800 * 4, `view is ${v.text.length} chars`);
  assert.match(v.text, /\[e300\]/, "the newest event is verbatim");
  assert.doesNotMatch(v.text, /\[e1\]/);
  assert.match(v.text, /\[s\d:1-\d+\] summary of events 1-/, "the oldest history is a summary");
  const levels = (m as any).db.prepare(`SELECT MAX(level) l FROM nodes`).get().l;
  assert.ok(levels >= 3, `tree is ${levels} levels deep`);
  m.close();
});

test("zoom returns the exact original text of a summarised segment", async () => {
  const m = open();
  const events = history(40);
  await build(m, events);
  const top = (m as any).db.prepare(`SELECT id FROM nodes WHERE first_seq=1 AND parent IS NULL`).get().id as string;
  const z = m.zoom("c1", top)!;
  assert.ok(z.children.length > 0);
  let leaf = z;
  while (leaf.children.length && leaf.children[0]!.level > 0) leaf = m.zoom("c1", leaf.children[0]!.id)!;
  assert.deepEqual(leaf.children.map((c) => c.text), events.slice(0, leaf.children.length).map(eventLine), "the original lines, untouched");
  assert.equal(m.zoom("c1", "e1")!.node.text, eventLine(events[0]!));
  assert.equal(m.zoom("c1", "nope"), null);
  m.close();
});

test("rebuilding from the events gives the same tree for the same summariser", async () => {
  const events = history(120);
  const a = open(), b = open();
  await build(a, events);
  // b is built incrementally, in uneven batches, with a repeated (redelivered) batch in between
  for (const [from, to] of [[0, 17], [10, 50], [50, 51], [51, 120]] as const) { b.ingest("c1", events.slice(from, to)); await b.compact("c1"); }
  assert.equal(dump(a), dump(b));
  a.close(); b.close();
});

test("a fact planted deep in the history is not in the view but is found by zooming down", async () => {
  const m = open();
  await build(m, history(200, { at: 37, text: "the vault code is JUNIPER-7731, tell nobody" }));
  assert.doesNotMatch(m.view("c1", 2000).text, /JUNIPER/);
  let id = (m as any).db.prepare(`SELECT id FROM nodes WHERE parent IS NULL AND first_seq<=37 AND last_seq>=37`).get().id as string;
  for (let hops = 0; hops < 10; hops++) {
    const z = m.zoom("c1", id)!;
    if (z.node.level === 0) { assert.match(z.node.text, /JUNIPER-7731/); m.close(); return; }
    id = z.children.find((c) => c.firstSeq <= 37 && c.lastSeq >= 37)!.id;
  }
  assert.fail("did not reach the event");
});

test("decisions are never only in a summary: pinned verbatim once their events are folded away", async () => {
  const m = open();
  const events = history(60);
  events[9] = { seq: 10, actorId: "human:alice", type: "decision.requested", data: { decisionId: "d1", question: "Patch POOL_SIZE to 10?" } };
  events[11] = { seq: 12, actorId: "human:alice", type: "decision.resolved", data: { decisionId: "d1", answer: "yes" } };
  await build(m, events);
  const v = m.view("c1", 1500).text;
  assert.doesNotMatch(v.split("Decisions already")[0]!, /\[e12\]/, "the event itself is folded into a summary");
  assert.match(v, /Decisions already taken or asked, verbatim:/);
  assert.match(v, /\[e12\] 12 human:alice decision.resolved \[d1\]: yes/);
  assert.match(v, /\[e10\] 10 human:alice decision.requested \[d1\]: Patch POOL_SIZE to 10\?/);
  m.close();
});

test("over a tiny budget the texts shrink, then the oldest entries are left out, and it says so", async () => {
  const m = open({ recent: 30 });
  await build(m, history(30));
  const v = m.view("c1", 100);
  assert.ok(v.text.length <= 100 * 4 + 200, `${v.text.length}`);
  assert.ok(v.omitted > 0);
  assert.match(v.text, /entries left out/);
  assert.match(v.text, /\[e30\]/);
  m.close();
});

test("a failing summariser leaves the tree as it was; the next compaction tries again", async () => {
  let fail = true;
  const flaky: Summarizer = { name: "flaky", version: "1", async summarize(i) { if (fail) throw new Error("model down"); return `ok ${i.firstSeq}-${i.lastSeq}`; } };
  const m = open({ summarizer: flaky });
  m.ingest("c1", history(30));
  await assert.rejects(m.compact("c1"), /model down/);
  assert.equal((m as any).db.prepare(`SELECT COUNT(*) n FROM nodes WHERE level>0`).get().n, 0);
  fail = false;
  assert.ok(await m.compact("c1") > 0);
  m.close();
});

test("a memory refuses to open under another summariser, and an empty summary is an error", async () => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/piople-mem-${process.pid}.sqlite`;
  CaseMemory.open(path, { summarizer: extractiveSummarizer() }).close();
  assert.throws(() => CaseMemory.open(path, { summarizer: { name: "model", version: "x", async summarize() { return "s"; } } }), /memory-summarizer-mismatch/);
  const m = open({ summarizer: { name: "e", version: "1", async summarize() { return "  "; } } });
  m.ingest("c1", history(30));
  await assert.rejects(m.compact("c1"), /memory-empty-summary/);
  m.close();
});

test("modelSummarizer: plain chat/completions call, pinned model, strict answer, errors never echo the request", async () => {
  const seen: any[] = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      seen.push({ auth: req.headers.authorization, extra: req.headers["x-extra"], body: JSON.parse(b) });
      if (seen.length === 4) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "half a summ" } }] })); return; }
      if (seen.length === 3) { res.writeHead(500); res.end("secret-echo " + b); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: seen.length === 2 ? "" : "  Short summary.  " } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const s = modelSummarizer({ baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v1/`, apiKey: "k-1", modelId: "pinned-1", headers: { "x-extra": "yes" } });
  assert.deepEqual([s.name, s.version], ["model", "pinned-1"]);
  assert.equal(await s.summarize({ level: 1, texts: ["a", "b"], firstSeq: 1, lastSeq: 2 }), "Short summary.");
  assert.equal(seen[0].auth, "Bearer k-1");
  assert.equal(seen[0].extra, "yes");
  assert.equal(seen[0].body.model, "pinned-1");
  assert.match(seen[0].body.messages[0].content, /not X done/, "the prompt forbids showing a plan as done");
  assert.match(seen[0].body.messages[1].content, /Events 1-2:\na\nb/);
  await assert.rejects(s.summarize({ level: 1, texts: ["a"], firstSeq: 1, lastSeq: 1 }), /no text/);
  await assert.rejects(s.summarize({ level: 1, texts: ["TOPSECRET"], firstSeq: 1, lastSeq: 1 }), (e: Error) => /HTTP 500/.test(e.message) && !/TOPSECRET|secret-echo|k-1/.test(e.message));
  await assert.rejects(s.summarize({ level: 1, texts: ["a"], firstSeq: 1, lastSeq: 1 }), /ran out of tokens/, "a cut-off summary is an error, not a filed half-sentence");
  await new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); });
});

test("find: exact word search over the original lines, newest last, all words required, summaries not searched", async () => {
  const m = open();
  const events = history(60);
  events[4] = msg(5, "Alert A-228 fires above 3.6 percent error rate.");
  events[40] = msg(41, "Update: alert a-228 threshold changed to 2.9 percent.");
  events[20] = msg(21, "Alert A-229 fires above 7.0 percent error rate.");
  await build(m, events);
  const r = m.find("c1", "a-228 percent");
  assert.deepEqual(r.matches.map((x) => x.id), ["e5", "e41"], "case-insensitive, both lines, oldest first so the correction is last");
  assert.equal(r.total, 2);
  assert.equal(m.find("c1", "a-228 7.0").matches.length, 0, "every word must occur in the same line");
  assert.deepEqual(m.find("c1", "A-229").matches.map((x) => x.id), ["e21"], "a near-duplicate does not match");
  assert.equal(m.find("c1", "").total, 0);
  assert.equal(m.find("c1", "100%_").matches.length, 0, "LIKE wildcards in the query are literal");
  assert.equal(m.find("c1", "routine", 3).matches.length, 3, "limited to the newest few");
  assert.equal(m.find("c1", "routine", 3).total > 3, true);
  assert.ok(!m.find("c1", "items events").matches.length, "summary text is not searched: only the original lines");
  m.close();
});

test("find: case-insensitive for non-ASCII capitals, wildcards are literal, and a limit of 0 or less returns nothing", () => {
  const m = CaseMemory.open(":memory:", { summarizer: extractiveSummarizer(), k: 4, recent: 2 });
  const ev = (seq: number, text: string): MemEvent => ({ seq, actorId: "human:a", type: "message.posted", data: { text } });
  m.ingest("c", [ev(1, "Päätös: Älä tee rollbackia"), ev(2, "ÖLJY vuotaa, tilaus ÅLAND-1"), ev(3, "100% sure_thing and back\\slash"), ev(4, "plain Upper CASE")]);
  const ids = (q: string, limit?: number) => m.find("c", q, limit).matches.map((n) => n.id);
  assert.deepEqual(ids("älä"), ["e1"]);
  assert.deepEqual(ids("ÄLÄ"), ["e1"]);
  assert.deepEqual(ids("öljy"), ["e2"]);
  assert.deepEqual(ids("åland-1"), ["e2"]);
  assert.deepEqual(ids("upper case"), ["e4"]);
  assert.deepEqual(ids("100%"), ["e3"]);
  assert.deepEqual(ids("surexthing"), [], "_ is not a wildcard");
  assert.deepEqual(ids("back\\slash"), ["e3"]);
  assert.deepEqual(ids("a", 0), []);
  assert.deepEqual(ids("a", -1), []);
  assert.deepEqual(ids("a", 1), ["e4"], "newest match last, the limit keeps the newest");
  assert.equal(m.find("c", "a", 1).total, 4, "'a' is in what every one of the four lines says");
  m.close();
});

test("find: only the words that were said match, not the seq, actor or type that prefix a line", async () => {
  const m = open();
  await build(m, [msg(1, "port is 5433"), { seq: 2, actorId: "agent:alice-bot", type: "observation.recorded", data: { text: "nothing about ports" } }, msg(3, "message from the team")]);
  assert.equal(m.find("c1", "message").matches.length, 1, "only the line that says 'message', not every message.posted");
  assert.equal(m.find("c1", "alice").matches.length, 0, "the actor id is not text");
  assert.equal(m.find("c1", "observation").matches.length, 0, "nor is the event type");
  assert.deepEqual(m.find("c1", "5433").matches.map((x) => x.id), ["e1"]);
  m.close();
});

test("view stays fast when the summariser has been down and thousands of events are still uncovered", () => {
  const m = CaseMemory.open(":memory:", { summarizer: extractiveSummarizer(), k: 8, recent: 20 });
  const ev = (seq: number): MemEvent => ({ seq, actorId: "human:a", type: "message.posted", data: { text: `message number ${seq} with some ordinary words in it` } });
  m.ingest("c", Array.from({ length: 12_000 }, (_, i) => ev(i + 1))); // never compacted
  const t0 = Date.now();
  const v = m.view("c", 1500);
  const took = Date.now() - t0;
  assert.ok(took < 400, `took ${took} ms (re-rendering the list for every dropped entry needed about 5 s for 12,000)`);
  assert.ok(v.text.length <= 1500 * 4 + 400, "and it still fits the budget");
  assert.match(v.text, /\[e12000\]/, "the newest event is shown");
  assert.match(v.text, /\[e11998\]/, "so are the newest three");
  m.close();
});
