import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type, createModels, createProvider, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness as PiRuntime, createRegistry, defineExtension, defineTool, hook, ToolTask, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Harness, Step } from "../hosts/types.ts";
import { CaseMemory, type MemEvent, type Summarizer } from "./memory.ts";
import { TOOLS, describeTools, runTool, type EnvironmentProfile } from "./tools.ts";

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
  /**
   * With an environment: offer its tools as Pi tools (function calls) instead of the `TOOL:` command. Each call is then a
   * durable Pi task: its intent is committed before it runs, it shows in the transcript as a tool result, and a call
   * interrupted by a crash reruns on recovery (the bundled tools only read, so they are declared replay-safe). The
   * confinement is the same: the call still runs through `runTool` in its own restricted child process.
   */
  nativeTools?: boolean;
  /**
   * Tools that need a person's approval before they run. The first call opens a Core decision ("allow"/"deny") and is
   * blocked; the model is told to wait. When someone with `decide` resolves it, the agent is shown the resolution and
   * calls again: "allow" lets that exact call (tool and arguments) through, "deny" blocks it. Non-blocking and durable:
   * nothing waits inside a task, the decision is an ordinary Core item, and the agent can never approve itself (it needs
   * `decide` for that, which Core grants separately).
   */
  approval?: { tools: string[] };
  /**
   * Native tools only: the most tool calls one delivery may make (default 16). Pi runs a model's tool calls for as long
   * as the model keeps making them, so a model that retries a blocked call would otherwise loop for ever, at your
   * cost. Over the limit the run is aborted and the agent says so in the case.
   */
  maxToolCalls?: number;
  /** The longest one model round may take, in ms (default 300000). Over it the delivery fails and the host retries it. */
  runTimeoutMs?: number;
  /**
   * Pi's own context handling. `contextWindow` is the model's window as Pi sees it (default 128000, a guess: set the real
   * one); `compaction` are Pi's automatic-compaction thresholds (reserveTokens, keepRecentTokens, backgroundTokens).
   * Pi compacts a conversation's own transcript, so this matters in the default one-conversation-per-case mode and is
   * moot with `memory`, which starts every delivery fresh.
   */
  context?: { contextWindow?: number; compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number; backgroundTokens?: number } };
  /** Called with every model reply (and the prompt that produced it) before it is parsed: for audit and debugging. */
  onReply?: (e: { requestId: string; prompt: string; reply: string }) => void;
};

const MEMORY_LINE = `ZOOM: <memory id>      (read the original lines behind a summary in the case memory)
FIND: <words>          (search the whole case history for lines containing all the words; newest match last, a later line may correct an earlier one)
`;
const protocol = (memory: boolean, tools: string[]) => `You take part in a shared case with humans and other agents. You only act by writing command lines, one per line; anything else you write is ignored. Commands:
POST: <message to everyone; this is also how you answer a question someone wrote in the case>
OBSERVE: <finding, with its evidence>
ASK: <actor id> | <question>
ANSWER: <request key> | <answer>      (only for an ask listed under "Owed to you")
DECIDE: <decision id> | <option>
WORK: <skill> | <json input>      (or WORK: @<actor id> | <json input> to address one actor)
CLAIM: <work id>
DONE: <work id> | <attempt> | <json result>
FAIL: <work id> | <attempt> | <reason>
${memory ? MEMORY_LINE : ""}${tools.length ? `TOOL: <name> | <json arguments>      (your tools, run for you in a confined sandbox:\n${tools.map((t) => `  ${t}`).join("\n")})\n` : ""}Rules: the system tells you what is new and what is owed to you. To reply to a message, use POST. ANSWER is only for an ask listed under "Owed to you", with its key copied exactly; the numbers at the start of log lines are event numbers, not keys. WORK creates a NEW work item for someone else: never write WORK for work that already appears in the log (it is already requested; the item shown under "Owed to you" is yours to CLAIM, not to re-request). Do not invent facts or results; say what you do not know. Permissions are enforced by the system: if a command is refused you will be told, do not try to get around it. If nothing needs doing, reply NOOP. Keep replies short.`;

const CMD = /^\s*(POST|OBSERVE|ASK|ANSWER|DECIDE|WORK|CLAIM|DONE|FAIL|ZOOM|FIND|TOOL):\s?(.*)$/;

/** Strip model control-token leakage (e.g. <ds_s>) before parsing. */
export function sanitize(text: string): string {
  // Only token shapes that models leak: <|im_end|>, <｜end▁of▁sentence｜> (full-width bars), <s>, </s>, <eos>, <bos>,
  // <unk>, <pad>, <ds_s>. Anything else in angle brackets is the author's text (List<String>, <alice>, <email>).
  return text.replace(/<\|[^<>\n]{0,60}\|>|<｜[^<>\n]{0,60}｜>|<\/?s>|<(?:eos|bos|unk|pad|ds_s)>/g, "");
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

/** Text of a value that is not known to be a string, without ever throwing (an object whose toString is not a function makes String() throw, and a step that throws on an event never lets the cursor move past it). */
export function asText(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return "[unreadable]"; }
}

const brief = (d: Record<string, unknown>) => `${typeof d.decisionId === "string" ? `[${d.decisionId}] ` : ""}${asText(d.text ?? d.question ?? d.answer ?? d)}`.slice(0, 400);

/** The longest tool-call arguments a person is asked to approve (characters of the canonical JSON). */
const MAX_APPROVAL_ARGS = 2000;

/** JSON with sorted keys: the same arguments always give the same text, so the same approval. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** One line of what is owed, at most this long in the prompt (a question may be 20,000 characters, an input a megabyte). */
const MAX_OWED_LINE = 4000;
/** All the owed lines together. Over it the rest is only counted: it comes into view as these are dealt with. */
const MAX_OWED_TOTAL = 40_000;
const clip = (t: string) => (t.length > MAX_OWED_LINE ? `${t.slice(0, MAX_OWED_LINE)} … [${t.length - MAX_OWED_LINE} more characters; work-claim returns a work input whole]` : t);

export function renderStep(s: Step, maxEvents = 40): string | null {
  const events = s.events.filter((e) => e.actorId !== s.actor);
  const all: string[] = [];
  for (const a of s.pending.assistance) all.push(clip(`ASK ${a.key} from ${a.from}: ${a.question}`));
  for (const d of s.pending.decisions) all.push(clip(`DECISION ${d.id} [${d.options.join("/")}]: ${d.question}`));
  for (const w of s.pending.work.mine) all.push(clip(`WORK YOU HOLD ${w.id} attempt ${w.attempt}: ${JSON.stringify(w.input)}`));
  for (const w of s.pending.work.open) all.push(clip(`WORK YOU MAY TAKE ${w.id}${w.skill ? ` (skill ${w.skill})` : ""}: ${JSON.stringify(w.input)}`));
  const owed: string[] = [];
  let owedChars = 0;
  for (const line of all) {
    if (owed.length && owedChars + line.length > MAX_OWED_TOTAL) break;
    owed.push(line);
    owedChars += line.length;
  }
  if (owed.length < all.length) owed.push(`(${all.length - owed.length} more owed to you, not shown here: they follow as you deal with these)`);
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
  /** The delivery being handled: the gate asks Core in its case, as this actor. */
  private current: Step | undefined;
  private toolCalls = 0;
  limitHit = false;

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
    const registry = createRegistry();
    const gate: GateRef = {};
    if (o.environment && o.nativeTools) registry.install(environmentExtension(o.environment, gate));
    const rt = await PiRuntime.open(storage, {
      models: createPiModels(o), registry, settings: { retry: { maxRetries: 1 }, ...(o.context?.compaction ? { compaction: o.context.compaction } : {}) },
    } as never, BACKGROUND_CONTEXT);
    rt.resume();
    const memory = o.memory ? CaseMemory.open(o.dir === ":memory:" ? ":memory:" : join(o.dir, `${safe}.memory.sqlite`), o.memory) : undefined;
    const h = new PiHarness(o, rt, storage as never, map, memory);
    gate.check = (name, args) => h.beforeToolCall(name, args);
    gate.exhausted = () => h.limitHit;
    return h;
  }

  /**
   * Pi's own accounting for everything in this store: every model call, including the ones this harness does not make
   * itself (Pi's compaction). `usage` above counts only this harness's own requests and skips replays; this does not.
   */
  async spend(): Promise<{ calls: number; input: number; output: number; models: Record<string, { input: number; output: number }> }> {
    const u = (await this.rt.usage(BACKGROUND_CONTEXT)) as unknown as { models?: Record<string, { input?: number; output?: number }> };
    const models: Record<string, { input: number; output: number }> = {};
    let input = 0, output = 0;
    for (const [k, v] of Object.entries(u.models ?? {})) {
      models[k] = { input: v.input ?? 0, output: v.output ?? 0 };
      input += v.input ?? 0;
      output += v.output ?? 0;
    }
    return { calls: this.usage.calls, input, output, models };
  }

  /**
   * Compact one case's transcript now (Pi's own summary of the older part; the newest `keepRecentTokens` stay verbatim).
   * Pi does this by itself near the end of the window; this is for tests and for an operator who wants it sooner.
   */
  async compact(contextId: string, instructions?: string): Promise<"completed" | "failed"> {
    const conv = await this.conversation(contextId);
    const id = await conv.compact(instructions, BACKGROUND_CONTEXT);
    const done = (await this.rt.waitForTask(id as never, BACKGROUND_CONTEXT)) as unknown as { state?: { outcome?: { status?: string } } };
    return done.state?.outcome?.status === "completed" ? "completed" : "failed";
  }

  /** How many times Pi has compacted this case's transcript (its `pi.compaction` entries). */
  async compactions(contextId: string): Promise<number> {
    const conv = await this.conversation(contextId);
    return (await this.entries(conv, 0)).filter((e) => e.kind === "pi.compaction").length;
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
    this.current = s;
    this.toolCalls = 0;
    this.limitHit = false;
    try {
      await this.deliver(s);
    } finally {
      this.current = undefined;
    }
  }

  private async deliver(s: Step): Promise<void> {
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
      if (v.nodes > 0) prompt = `Case memory (older events are folded into summaries, but the whole history is kept: reply FIND: <words> to search it for exact lines, or ZOOM: <id> to read the lines behind a summary. Do not say you do not know before you have tried FIND):\n${v.text}\n\n${prompt}`;
    }
    const base = `${s.actor}@${s.context}#${s.cursor}`;
    let nudged = false;
    for (let round = 0; round < (this.o.maxRounds ?? 3) && prompt !== null; round++) {
      const reply = await this.ask(conv, `${base}.r${round}`, prompt);
      this.o.onReply?.({ requestId: `${base}.r${round}`, prompt, reply });
      const feedback: string[] = [];
      const commands = parseCommands(reply);
      for (const c of commands) {
        const note = await this.exec(s, c);
        if (note) feedback.push(note);
      }
      // Nothing to execute and no explicit NOOP is not "nothing to do": the model answered in prose, or said nothing
      // (a reasoning model can spend its output on thinking). Say so once, so a person is not left without an answer.
      if (!commands.length && !/\bNOOP\b/.test(reply) && !nudged) {
        nudged = true;
        feedback.push("Your reply contained no command line, so nothing happened. If you have something to say, write it as a command line (for example POST: ...). If there is nothing to do, reply NOOP.");
      }
      prompt = feedback.length ? `${feedback.join("\n")}\nContinue, or reply NOOP.` : null;
    }
    if (this.limitHit) await s.run("observe", { text: `I stopped: I made more than ${this.o.maxToolCalls ?? 16} tool calls in one go without finishing. A person should look at what I was asked to do.` }).catch(() => {});
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

  /**
   * Every native tool call passes here first: the per-delivery cap, then the approval gate. A reason blocks the call.
   * Over the cap nothing is blocked: the call goes through to the tool, which answers with `terminate`, the one thing
   * that ends a Pi run (aborting the conversation does not stop a run that has already queued its next request).
   */
  async beforeToolCall(name: string, args: unknown): Promise<string | null> {
    if (++this.toolCalls > (this.o.maxToolCalls ?? 16)) {
      this.limitHit = true;
      return null;
    }
    return this.gate(name, args);
  }

  /** Why a tool call may not run yet (or at all), or null. See `approval`. */
  async gate(name: string, args: unknown): Promise<string | null> {
    if (!this.o.approval?.tools.includes(name)) return null;
    const s = this.current;
    if (!s) return `${name} needs a person's approval and there is no case to ask in right now`;
    // What the person is asked to approve is the exact call, so it must be reviewable in full: a question is a short text,
    // and cutting the arguments would let part of the call go unseen. Larger calls are refused, not truncated.
    const shown = canonical(args);
    if (shown.length > MAX_APPROVAL_ARGS) return `the arguments of this ${name} call are ${shown.length} characters, more than a person can review (${MAX_APPROVAL_ARGS}): make a smaller call`;
    const id = `tool-${createHash("sha256").update(`${name}\0${shown}`).digest("hex").slice(0, 20)}`;
    const d = await s.run<{ found: boolean; status?: string; answer?: string; decidedBy?: string }>("decision-get", { id });
    if (d.found && d.status === "resolved") return d.answer === "allow" ? null : `${d.decidedBy ?? "a person"} denied this call (decision ${id}): ${name} will not run`;
    if (!d.found) await s.run("decision-request", { id, question: `Allow ${this.actor} to run ${name} ${shown}?`, options: "allow,deny" });
    return `approval needed: decision ${id} is waiting for a person to answer allow or deny. Do not retry yet; you will be told when it is resolved, then call again with the same arguments.`;
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
    const blocked = await this.gate(name, args);
    if (blocked) return `REFUSED TOOL ${name}: ${blocked}`;
    const r = await runTool(env, name, args);
    if (!r.ok) return `REFUSED TOOL ${name}: ${r.error}`;
    return `Tool ${name} returned:\n${r.output.length > 6000 ? `${r.output.slice(0, 6000)}\n…(cut)` : r.output}`;
  }

  private find(s: Step, query: string): string {
    if (!this.memory) return "REFUSED FIND: this agent has no case memory";
    if (!query) return "REFUSED FIND: give the words to look for";
    const { matches, total } = this.memory.find(s.context, query);
    if (!matches.length) return `Find "${query}": no line contains all of those words. Try fewer or different words.`;
    const text = matches.map((m) => `[${m.id}] ${m.text}`).join("\n");
    return `Find "${query}": ${total} match${total === 1 ? "" : "es"}${total > matches.length ? `, the newest ${matches.length} shown (oldest first)` : ""}:\n${text.length > 6000 ? `${text.slice(0, 6000)}\n…(cut)` : text}`;
  }

  private zoom(s: Step, rawId: string): string {
    const id = /^\d+$/.test(rawId) ? `e${rawId}` : rawId; // a bare event number means that event
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
        case "FIND": return this.find(s, rest.trim());
        case "TOOL": return await this.tool(rest);
        case "DONE": await s.run("work-complete", { id: parts[0], attempt: parts[1], result: parts.slice(2).join(" | ") }); return null;
        case "FAIL": await s.run("work-fail", { id: parts[0], attempt: parts[1], reason: parts.slice(2).join(" | ") }); return null;
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // A model that answers a message with ANSWER used to be told only that the key is unknown, and gave up. Say what to do.
      const hint = cmd === "ANSWER" && /unknown-request/.test(why) ? ' ANSWER is only for an ask listed under "Owed to you". To reply to a message, write POST: <your reply>.' : "";
      return `REFUSED ${cmd}: ${why}.${hint}`.replace(/\.\./g, ".");
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
      agent: { model: this.model, instructions: `${this.o.role}\n\nYou are ${this.actor}.\n\n${protocol(!!this.memory, this.o.environment && !this.o.nativeTools ? describeTools(this.o.environment) : [])}${this.o.environment && this.o.nativeTools ? "\n\nYou also have file tools you can call directly (function calls). Use them first if you need file contents, then reply with command lines." : ""}` },
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
    // Not for ever: a model that accepts the request and never answers (a dead connection, a hung provider) would otherwise
    // keep this delivery, and every other case of this actor, waiting until the process is killed.
    const limit = this.o.runTimeoutMs ?? 300_000;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      conv.waitForIdle(BACKGROUND_CONTEXT).then(() => false),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(true), limit); }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      this.map.prepare(`INSERT INTO failed(request_id,n) VALUES(?,1) ON CONFLICT(request_id) DO UPDATE SET n=n+1`).run(requestId);
      throw new Error(`model call failed: no answer within ${limit} ms`);
    }
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

const TOOL_SCHEMAS = {
  read_file: { summary: "Read one text file under your directory.", parameters: Type.Object({ path: Type.String({ description: "path relative to your directory" }), maxBytes: Type.Optional(Type.Number()) }) },
  list_dir: { summary: "List a directory under your directory.", parameters: Type.Object({ path: Type.Optional(Type.String({ description: "relative path, default ." })) }) },
} as const;

/** The profile's tools as a Pi extension. The work stays in runTool (a confined child process); Pi supplies durability. */
type GateRef = { check?: (name: string, args: unknown) => Promise<string | null>; exhausted?: () => boolean };
function environmentExtension(profile: EnvironmentProfile, gate: GateRef) {
  const text = (t: string) => [{ type: "text" as const, text: t }];
  const tools = profile.tools.filter((n): n is keyof typeof TOOL_SCHEMAS => n in TOOL_SCHEMAS && n in TOOLS).map((name) =>
    defineTool({
      name, description: TOOL_SCHEMAS[name].summary, parameters: TOOL_SCHEMAS[name].parameters as never, replay: "safe",
      execute: async (args: unknown) => {
        if (gate.exhausted?.()) return { isError: true, content: text("tool call limit reached for this delivery: stopping"), control: { terminate: true } };
        const r = await runTool(profile, name, args);
        return r.ok ? { content: text(r.output) } : { isError: true, content: text(`REFUSED ${name}: ${r.error}`) };
      },
    } as never));
  const guard = hook(ToolTask, {
    beforeTool: async (call: { name: string; arguments: unknown }) => {
      const why = await gate.check?.(call.name, call.arguments);
      return why ? { block: why } : undefined;
    },
  } as never);
  return defineExtension({ name: "piople-env", tools: tools as never, hooks: [guard] as never });
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
      contextWindow: o.context?.contextWindow ?? 128000, maxTokens: o.maxTokens ?? 2000,
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
    }],
    api: openAICompletionsApi(),
  }) as never);
  return models;
}
