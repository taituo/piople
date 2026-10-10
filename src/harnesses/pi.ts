import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness as PiRuntime, createRegistry, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Harness, Step } from "../hosts/types.ts";
import { CaseMemory, type MemEvent, type Summarizer } from "./memory.ts";
import { describeTools, runTool, type EnvironmentProfile } from "./tools.ts";

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
  /**
   * Long-lived agents: instead of one ever-growing transcript per case, each delivery starts a fresh conversation
   * whose first prompt carries a bounded view of the case's history (recent events verbatim, older ones summarised;
   * see memory.ts). The agent can read what a summary stands for with `ZOOM: <id>`. Pi keeps one small durable
   * conversation per delivery; the memory is derived and lives beside it in `<actor>.memory.sqlite`.
   */
  memory?: { summarizer: Summarizer; k?: number; recent?: number; budgetTokens?: number };
  /**
   * What this agent may do beyond talking: the operator's profile (tools.ts). Tools run in confined child processes
   * with an empty environment; the agent calls them with `TOOL: <name> | <json>` and a refusal comes back as feedback.
   * Without a profile the agent has no tools, whatever it writes.
   */
  environment?: EnvironmentProfile;
};

const MEMORY_LINE = `ZOOM: <memory id>      (read the original lines behind a summary in the case memory)
`;
const protocol = (memory: boolean, tools: string[]) => `You take part in a shared case with humans and other agents. You only act by writing command lines, one per line; anything else you write is ignored. Commands:
POST: <message to everyone>
OBSERVE: <finding, with its evidence>
ASK: <actor id> | <question>
ANSWER: <request key> | <answer>
DECIDE: <decision id> | <option>
WORK: <skill> | <json input>      (or WORK: @<actor id> | <json input> to address one actor)
CLAIM: <work id>
DONE: <work id> | <attempt> | <json result>
FAIL: <work id> | <attempt> | <reason>
${memory ? MEMORY_LINE : ""}${tools.length ? `TOOL: <name> | <json arguments>      (your tools, run for you in a confined sandbox:\n${tools.map((t) => `  ${t}`).join("\n")})\n` : ""}Rules: the system tells you what is new and what is owed to you. WORK creates a NEW work item for someone else: never write WORK for work that already appears in the log (it is already requested; the item shown under "Owed to you" is yours to CLAIM, not to re-request). Do not invent facts or results; say what you do not know. Permissions are enforced by the system: if a command is refused you will be told, do not try to get around it. If nothing needs doing, reply NOOP. Keep replies short.`;

const CMD = /^\s*(POST|OBSERVE|ASK|ANSWER|DECIDE|WORK|CLAIM|DONE|FAIL|ZOOM|TOOL):\s?(.*)$/;

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
  private readonly memory: CaseMemory | undefined;
  /** Compactions that failed (the summariser was down); the memory is left as it was and retried next delivery. */
  memoryErrors = 0;

  private constructor(o: PiHarnessOptions, rt: PiRuntime, storage: PiHarness["storage"], map: DatabaseSync, memory: CaseMemory | undefined) {
    this.o = o;
    this.actor = o.actor;
    this.rt = rt;
    this.storage = storage;
    this.map = map;
    this.model = { provider: "piople", modelId: o.modelId };
    this.memory = memory;
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
    const memory = o.memory ? CaseMemory.open(o.dir === ":memory:" ? ":memory:" : join(o.dir, `${safe}.memory.sqlite`), o.memory) : undefined;
    return new PiHarness(o, rt, storage as never, map, memory);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.rt.close(BACKGROUND_CONTEXT);
    await this.storage.close(BACKGROUND_CONTEXT as never);
    this.map.close();
    this.memory?.close();
  }

  async step(s: Step): Promise<void> {
    let prompt = renderStep(s);
    if (prompt === null) {
      await this.remember(s);
      return;
    }
    const mem = this.memory;
    // With memory every delivery is its own conversation (keyed by the cursor, so a retry reuses it); without, one per case.
    const conv = await this.conversation(mem ? `${s.context}@${s.cursor}` : s.context);
    if (mem) {
      const v = mem.view(s.context, this.o.memory?.budgetTokens);
      if (v.nodes > 0) prompt = `Case memory (older events are folded into summaries; reply ZOOM: <id> to read the original lines behind one):\n${v.text}\n\n${prompt}`;
    }
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
    await this.remember(s);
  }

  /**
   * Bring the memory up to the end of the case's log (own writes included: the host acks past them, so they are
   * never delivered) and fold what has become old. Never fails the delivery: a summariser that is down only means
   * the view is a little longer until the next try.
   */
  private async remember(s: Step): Promise<void> {
    const mem = this.memory;
    if (!mem) return;
    try {
      for (;;) {
        const after = mem.lastSeq(s.context);
        const evs = await s.run<MemEvent[]>("events", { after, limit: 1000 });
        mem.ingest(s.context, evs);
        if (evs.length < 1000) break;
      }
      await mem.compact(s.context);
    } catch {
      this.memoryErrors++;
    }
  }

  private async tool(rest: string): Promise<string> {
    const env = this.o.environment;
    if (!env) return "REFUSED TOOL: this agent has no tools";
    const bar = rest.indexOf("|");
    const name = (bar < 0 ? rest : rest.slice(0, bar)).trim();
    let args: unknown = {};
    if (bar >= 0 && rest.slice(bar + 1).trim()) {
      try { args = JSON.parse(rest.slice(bar + 1)); } catch { return `REFUSED TOOL ${name}: the arguments are not valid JSON`; }
    }
    const r = await runTool(env, name, args);
    if (!r.ok) return `REFUSED TOOL ${name}: ${r.error}`;
    return `Tool ${name} returned:\n${r.output.length > 6000 ? `${r.output.slice(0, 6000)}\n…(cut)` : r.output}`;
  }

  private zoom(s: Step, id: string): string {
    if (!this.memory) return "REFUSED ZOOM: this agent has no case memory";
    const z = this.memory.zoom(s.context, id);
    if (!z) return `REFUSED ZOOM: no memory entry ${id} in this case`;
    const lines = z.children.length ? z.children.map((c) => `[${c.id}] ${c.text}`) : [`[${z.node.id}] ${z.node.text}`];
    const text = lines.join("\n");
    return `Zoom ${id} (${z.children.length ? `what the summary stands for, ${lines.length} entries` : "the original line"}):\n${text.length > 6000 ? `${text.slice(0, 6000)}\n…(cut)` : text}`;
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
        case "ZOOM": return this.zoom(s, parts[0] ?? "");
        case "TOOL": return await this.tool(rest);
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
      agent: { model: this.model, instructions: `${this.o.role}\n\nYou are ${this.actor}.\n\n${protocol(!!this.memory, this.o.environment ? describeTools(this.o.environment) : [])}` },
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
