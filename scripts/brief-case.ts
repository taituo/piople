import { Store } from "../src/core/index.ts";
import { readBearer } from "../src/agents/loop.ts";
import { createGateway, gatewayUrl, textOf } from "../src/agents/pi-provider.ts";

/**
 * F: case brief. Compacts a context's events into one structured artifact
 * (goal, confirmed findings, open questions, decisions) so the next agent
 * or human starts from understanding, not a 500-event scroll.
 * The brief is data with provenance, not a replacement for the log.
 *
 * Usage: node scripts/brief-case.ts --db ./data/x.sqlite --case case-1 [--by human:alice]
 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const DATA = arg("db", "./data/x.sqlite");
const CTX = arg("case", "case-1");
const BY = arg("by", "human:alice");
const MODEL = process.env.PIO_MODEL ?? "deepseek-v4-flash";
const BASE = gatewayUrl();

const s = new Store(DATA);
const goal = (s.db.prepare(`SELECT goal FROM contexts WHERE id=?`).get(CTX) as { goal: string } | undefined)?.goal ?? "";
const events = s.eventsSince(CTX, 0, 500);
const lines = events.map((e) => {
  const d = e.data as Record<string, unknown>;
  return `[${e.type}] ${e.actorId}: ${String(d.text ?? d.question ?? d.answer ?? JSON.stringify(d)).slice(0, 300)}`;
});

const { models } = createGateway(BASE, readBearer(), [MODEL]);
const model = models.getModel("piople", MODEL);
if (!model) throw new Error(`model not registered: ${MODEL}`);
const msg = await models.completeSimple(model, {
  systemPrompt: "Write a case brief in Finnish, max 200 words, sections: TAVOITE / VAHVISTETTU / AVOINNA / PÄÄTÖKSET. Only what the log supports; mark guesses as guesses.",
  messages: [{ role: "user", content: `Goal: ${goal}\n\nLog:\n${lines.join("\n")}` }],
} as never, { maxTokens: 600 } as never);
const brief = textOf(msg as never).trim();
const id = `brief:${Date.now()}`;
s.recordObservation({ id, contextId: CTX, kind: "result", authorId: BY, text: brief, status: "confirmed", evidence: [`model:${MODEL}`, `events:${events.length}`], createdAt: Date.now() });
console.log(`BRIEF ${CTX} events=${events.length} artifact=${id}`);
console.log(brief.slice(0, 800));
s.close();
