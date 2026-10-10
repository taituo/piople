import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness as PiRuntime, createRegistry, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Harness, Step } from "../hosts/types.ts";

/**
 * A Pi-backed participant. The only file that imports Pi.
 *
 * Division of labour: Pi owns the agent's live transcript (one durable conversation per case)
 * and model transport; this harness owns a tiny private map of case -> conversation and a memo of
 * request -> reply. Core owns identity, membership, authorization and history, and judges every
 * command the model emits exactly as it would any other participant's: a refused command comes
 * back to the model as an error, it never gains the agent more power.
 */
export type PiHarnessOptions = {
  actor: string;
  /** Private state directory (Pi transcripts + the map). ":memory:" for throwaway runs. */
  dir: string;
  /** Role text. The command protocol is appended; Pi needs the full system text at creation. */
  role: string;
  provider: { baseUrl: string; apiKey?: string };
  modelId: string;
  /** Model rounds per delivery: after commands that produce feedback the model gets to react. */
  maxRounds?: number;
  maxTokens?: number;
};

const PROTOCOL = `You take part in a shared case with humans and other agents. You only act by writing command lines, one per line; anything else you write is ignored. Commands:
POST: <message to everyone>
OBSERVE: <finding, with its evidence>
ASK: <actor id> | <question>
ANSWER: <request key> | <answer>
DECIDE: <decision id> | <option>
WORK: <skill> | <json input>      (or WORK: @<actor id> | <json input> to address one actor)
CLAIM: <work id>
DONE: <work id> | <attempt> | <json result>
FAIL: <work id> | <attempt> | <reason>
Rules: the system tells you what is new and what is owed to you. WORK creates a NEW work item for someone else: never write WORK for work that already appears in the log (it is already requested; the item shown under "Owed to you" is yours to CLAIM, not to re-request). Do not invent facts or results; say what you do not know. Permissions are enforced by the system: if a command is refused you will be told, do not try to get around it. If nothing needs doing, reply NOOP. Keep replies short.`;

const CMD = /^\s*(POST|OBSERVE|ASK|ANSWER|DECIDE|WORK|CLAIM|DONE|FAIL):\s?(.*)$/;

/** Strip model control-token leakage (e.g. <ds_s>) before parsing. */
export function sanitize(text: string): string {
  return text.replace(/<[a-zA-Z_|][a-zA-Z0-9_|]*>/g, "");
}

export type Command = { cmd: string; rest: string };
/** Command lines; a line that is not a command continues the previous one. */
export function parseCommands(reply: string): Command[] {
  const out: Command[] = [];
  let open = false;
  for (const line of sanitize(reply).split("\n")) {
    const m = CMD.exec(line);
    if (m) {
      out.push({ cmd: m[1]!, rest: m[2]! });
      open = true;
    } else if (line.trim() === "NOOP") {
      open = false; // an explicit "nothing more" ends the previous command
    } else if (open && line.trim()) {
      out.at(-1)!.rest += `\n${line}`;
    }
  }
  return out;
}

const brief = (d: Record<string, unknown>) => String(d.text ?? d.question ?? d.answer ?? JSON.stringify(d)).slice(0, 400);

export function renderStep(s: Step, maxEvents = 40): string | null {
  const events = s.events.filter((e) => e.actorId !== s.actor);
  const owed: string[] = [];
  for (const a of s.pending.assistance) owed.push(`ASK ${a.key} from ${a.from}: ${a.question}`);
  for (const d of s.pending.decisions) owed.push(`DECISION ${d.id} [${d.options.join("/")}]: ${d.question}`);
  for (const w of s.pending.work.mine) owed.push(`WORK YOU HOLD ${w.id} attempt ${w.attempt}: ${JSON.stringify(w.input)}`);
  for (const w of s.pending.work.open) owed.push(`WORK YOU MAY TAKE ${w.id}${w.skill ? ` (skill ${w.skill})` : ""}: ${JSON.stringify(w.input)}`);
  if (!events.length && !owed.length) return null;
  const shown = events.slice(-maxEvents);
  return [
    `Case ${s.context}.`,
    events.length ? `New since you last looked${events.length > shown.length ? ` (last ${shown.length} of ${events.length})` : ""}:` : "Nothing new.",
    ...shown.map((e) => `${e.seq} ${e.actorId} ${e.type}: ${brief(e.data)}`),
    owed.length ? `Owed to you:\n${owed.join("\n")}` : "",
    "Reply with command lines, or NOOP.",
  ].filter(Boolean).join("\n");
}

export class PiHarness implements Harness {
  readonly actor: string;
  /** Tokens spent by this harness since it opened. */
  usage = { calls: 0, input: 0, output: 0 };
  private closed = false;
  private readonly o: PiHarnessOptions;
  private readonly rt: PiRuntime;
  private readonly storage: { close(c: never): Promise<void> | void };
  private readonly map: DatabaseSync;
  private readonly model: { provider: string; modelId: string };

  private constructor(o: PiHarnessOptions, rt: PiRuntime, storage: PiHarness["storage"], map: DatabaseSync) {
    this.o = o;
    this.actor = o.actor;
    this.rt = rt;
    this.storage = storage;
    this.map = map;
    this.model = { provider: "piople", modelId: o.modelId };
  }

  static async open(o: PiHarnessOptions): Promise<PiHarness> {
    const safe = o.actor.replace(/[^\w.-]/g, "_");
    let piPath = ":memory:", mapPath = ":memory:";
    if (o.dir !== ":memory:") {
      mkdirSync(o.dir, { recursive: true });
      piPath = join(o.dir, `${safe}.pi.sqlite`);
      mapPath = join(o.dir, `${safe}.map.sqlite`);
    }
    const map = new DatabaseSync(mapPath);
    map.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS convs (context_id TEXT PRIMARY KEY, conv_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (request_id TEXT PRIMARY KEY, reply TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS failed (request_id TEXT PRIMARY KEY, n INTEGER NOT NULL);`);
    const storage = await openNodeSqliteStorage(piPath);
    const rt = await PiRuntime.open(storage, {
      models: createPiModels(o), registry: createRegistry(), settings: { retry: { maxRetries: 1 } },
    } as never, BACKGROUND_CONTEXT);
    rt.resume();
    return new PiHarness(o, rt, storage as never, map);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.rt.close(BACKGROUND_CONTEXT);
    await this.storage.close(BACKGROUND_CONTEXT as never);
    this.map.close();
  }

  async step(s: Step): Promise<void> {
    let prompt = renderStep(s);
    if (prompt === null) return;
    const conv = await this.conversation(s.context);
    const base = `${s.actor}@${s.context}#${s.cursor}`;
    for (let round = 0; round < (this.o.maxRounds ?? 3) && prompt !== null; round++) {
      const reply = await this.ask(conv, `${base}.r${round}`, prompt);
      const feedback: string[] = [];
      for (const c of parseCommands(reply)) {
        const note = await this.exec(s, c);
        if (note) feedback.push(note);
      }
      prompt = feedback.length ? `${feedback.join("\n")}\nContinue, or reply NOOP.` : null;
    }
  }

  /** Execute one command. Returns feedback for the model (a claim's input, or why it was refused). */
  private async exec(s: Step, { cmd, rest }: Command): Promise<string | null> {
    const parts = rest.split("|").map((x) => x.trim());
    try {
      switch (cmd) {
        case "POST": await s.run("post", { text: rest.trim() }); return null;
        case "OBSERVE": await s.run("observe", { text: rest.trim() }); return null;
        case "ASK": await s.run("ask", { to: parts[0], question: parts.slice(1).join(" | ") }); return null;
        case "ANSWER": await s.run("answer", { request: parts[0], answer: parts.slice(1).join(" | ") }); return null;
        case "DECIDE": await s.run("decide", { decision: parts[0], answer: parts[1] }); return null;
        case "WORK": {
          const target = parts[0]!.startsWith("@") ? { to: parts[0]!.slice(1) } : { skill: parts[0] };
          await s.run("work-request", { ...target, input: parts.slice(1).join(" | ") });
          return null;
        }
        case "CLAIM": {
          const r = await s.run<{ work: { id: string; attempt: number; input: unknown } }>("work-claim", { id: parts[0] });
          return `Claimed ${r.work.id}, attempt ${r.work.attempt}. Input: ${JSON.stringify(r.work.input)}. Finish with DONE or FAIL using this attempt.`;
        }
        case "DONE": await s.run("work-complete", { id: parts[0], attempt: parts[1], result: parts.slice(2).join(" | ") }); return null;
        case "FAIL": await s.run("work-fail", { id: parts[0], attempt: parts[1], reason: parts.slice(2).join(" | ") }); return null;
      }
    } catch (e) {
      return `REFUSED ${cmd}: ${e instanceof Error ? e.message : String(e)}`;
    }
    return null;
  }

  private async conversation(contextId: string): Promise<Conversation> {
    const row = this.map.prepare(`SELECT conv_id FROM convs WHERE context_id=?`).get(contextId) as { conv_id: number } | undefined;
    if (row) {
      const conv = await this.rt.conversation(row.conv_id as never, BACKGROUND_CONTEXT);
      if (conv) return conv;
    }
    const conv = await this.rt.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: this.model, instructions: `${this.o.role}\n\nYou are ${this.actor}.\n\n${PROTOCOL}` },
    } as never, BACKGROUND_CONTEXT);
    this.map.prepare(`INSERT INTO convs(context_id,conv_id) VALUES(?,?) ON CONFLICT(context_id) DO UPDATE SET conv_id=excluded.conv_id`).run(contextId, Number(conv.id));
    return conv;
  }

  /**
   * One model round, at most once per requestId: a retried delivery reuses the memoized reply, so
   * retries cost no tokens and re-issue the very same commands (which Core then replays).
   * A failed model call is never memoized and never looks like an empty answer: it throws, the
   * host retries the delivery, and Pi gets a fresh request id (it deduplicates the old one).
   */
  private async ask(conv: Conversation, requestId: string, text: string): Promise<string> {
    const memo = this.map.prepare(`SELECT reply FROM turns WHERE request_id=?`).get(requestId) as { reply: string } | undefined;
    if (memo) return memo.reply;
    const fails = (this.map.prepare(`SELECT n FROM failed WHERE request_id=?`).get(requestId) as { n: number } | undefined)?.n ?? 0;
    const before = await this.lastAssistantId(conv);
    await conv.submit({ type: "input", content: text, requestId: fails ? `${requestId}~${fails}` : requestId } as never, BACKGROUND_CONTEXT);
    await conv.waitForIdle(BACKGROUND_CONTEXT);
    let got = await this.assistantSince(conv, before);
    if (!got.found && before > 0) got = await this.assistantSince(conv, 0, true); // Pi saw this requestId already
    if (got.error || !got.found) {
      this.map.prepare(`INSERT INTO failed(request_id,n) VALUES(?,1) ON CONFLICT(request_id) DO UPDATE SET n=n+1`).run(requestId);
      throw new Error(`model call failed: ${got.error ?? "no reply"}`);
    }
    this.usage.calls++;
    this.usage.input += got.usage.input;
    this.usage.output += got.usage.output;
    const reply = sanitize(got.reply).trim();
    this.map.prepare(`INSERT OR REPLACE INTO turns(request_id,reply) VALUES(?,?)`).run(requestId, reply);
    return reply;
  }

  private async entries(conv: Conversation, after: number) {
    type Msg = { content?: unknown; usage?: { input?: number; output?: number }; stopReason?: string; errorMessage?: string };
    const page = await conv.entries({ minEntryId: after + 1 } as never, 100, undefined, BACKGROUND_CONTEXT);
    return (page as unknown as { items: Array<{ id: number; kind: string; model?: Msg[] }> }).items;
  }

  private async lastAssistantId(conv: Conversation): Promise<number> {
    const ids = (await this.entries(conv, 0)).filter((e) => e.kind === "pi.assistant").map((e) => Number(e.id));
    return ids.length ? Math.max(...ids) : 0;
  }

  private async assistantSince(conv: Conversation, after: number, newestOnly = false) {
    let items = (await this.entries(conv, after)).filter((e) => e.kind === "pi.assistant" && Number(e.id) > after).sort((a, b) => Number(a.id) - Number(b.id));
    if (newestOnly) items = items.slice(-1);
    let reply = "", input = 0, output = 0, error: string | null = null;
    for (const e of items) {
      const m = e.model?.[0];
      input += m?.usage?.input ?? 0;
      output += m?.usage?.output ?? 0;
      if (m?.stopReason === "error" || m?.stopReason === "aborted") error = m.errorMessage ?? m.stopReason;
      const c = m?.content;
      if (typeof c === "string") reply += c;
      else if (Array.isArray(c)) for (const b of c as Array<{ type: string; text?: string }>) if (b.type === "text" && b.text) reply += b.text;
    }
    return { found: items.length > 0, reply, error, usage: { input, output } };
  }
}

function createPiModels(o: PiHarnessOptions): Models {
  const models = createModels();
  models.setProvider(createProvider({
    id: "piople",
    name: "piople model provider",
    baseUrl: o.provider.baseUrl,
    auth: { apiKey: { name: "key", resolve: async () => ({ auth: { apiKey: o.provider.apiKey ?? "none" } }) } },
    models: [{
      id: o.modelId, name: o.modelId, api: "openai-completions", provider: "piople", baseUrl: o.provider.baseUrl,
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: o.maxTokens ?? 2000,
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
    }],
    api: openAICompletionsApi(),
  }) as never);
  return models;
}
