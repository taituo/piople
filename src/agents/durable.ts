import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, type Conversation } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Store } from "../core/index.ts";
import { sanitize } from "./sanitize.ts";
import { pioupleExtension, type PiopleToolOptions } from "./pi-tools.ts";

/**
 * H1: one durable Pi conversation per (context, actor).
 * The protocol still owns membership, capabilities, decisions and history;
 * Pi owns the agent's live transcript and survives restarts.
 * Mapping context+actor -> Pi conversation id lives in our Store (migration 3),
 * so reopening the databases restores the binding with no in-memory state.
 */
export type Durable = {
  harness: Harness;
  models: Models;
  close(): Promise<void>;
};

/** Opens Pi's storage and installs the piople tool extension bound to `store`. */
export async function openDurable(piDbPath: string, models: Models, store: Store, tools: PiopleToolOptions = {}): Promise<Durable> {
  const storage = await openNodeSqliteStorage(piDbPath);
  const registry = createRegistry();
  registry.install(pioupleExtension(store, tools));
  const harness = await Harness.open(storage, {
    models,
    registry,
    settings: { retry: { maxRetries: 1 } },
  } as never, BACKGROUND_CONTEXT);
  harness.resume();
  return {
    harness,
    models,
    async close() {
      await harness.close(BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
    },
  };
}

export async function ensureConv(
  d: Durable,
  s: Store,
  contextId: string,
  actorId: string,
  instructions: string,
  model: { provider: string; modelId: string },
): Promise<Conversation> {
  const row = s.db.prepare(`SELECT conv_id FROM pi_convs WHERE context_id=? AND actor_id=?`).get(contextId, actorId) as { conv_id: number } | undefined;
  if (row) {
    const conv = await d.harness.conversation(row.conv_id as never, BACKGROUND_CONTEXT);
    if (conv) return conv;
  }
  const conv = await d.harness.createConversation({
    ownership: { kind: "ownerless" },
    agent: { model, instructions },
  } as never, BACKGROUND_CONTEXT);
  s.db.prepare(`INSERT INTO pi_convs(context_id,actor_id,conv_id) VALUES(?,?,?) ON CONFLICT(context_id,actor_id) DO UPDATE SET conv_id=excluded.conv_id`).run(contextId, actorId, Number(conv.id));
  return conv;
}

export type AskResult = {
  /** Final answer: the text of the last assistant entry of the run (tool-call turns excluded). */
  text: string;
  /** Names of the tools Pi ran during this run, in call order. */
  tools: string[];
  usage: { prompt_tokens: number; completion_tokens: number };
};

/** Submit one user message, wait until idle (Pi runs the whole tool loop), return the final answer + usage. */
export async function askConv(d: Durable, conv: Conversation, text: string, requestId: string): Promise<AskResult> {
  const before = await lastAssistantId(d, conv);
  const u0 = await sumUsage(d);
  await conv.submit({ type: "input", content: text, requestId } as never, BACKGROUND_CONTEXT);
  await conv.waitForIdle(BACKGROUND_CONTEXT);
  const u1 = await sumUsage(d);
  let run = await assistantRunSince(conv, before);
  if (!run.text && !run.tools.length) {
    // Duplicate requestId: no new work happened; return the latest existing reply.
    run = await assistantRunSince(conv, 0);
  }
  return {
    text: sanitize(run.text),
    tools: run.tools,
    usage: { prompt_tokens: u1.input - u0.input, completion_tokens: u1.output - u0.output },
  };
}

async function sumUsage(d: Durable): Promise<{ input: number; output: number }> {
  const st = await d.harness.usage(BACKGROUND_CONTEXT) as { models: Record<string, { input?: number; output?: number }> };
  let input = 0, output = 0;
  for (const u of Object.values(st.models ?? {})) {
    input += u.input ?? 0;
    output += u.output ?? 0;
  }
  return { input, output };
}

async function lastAssistantId(_d: Durable, conv: Conversation): Promise<number> {
  const page = await conv.entries({}, 50, undefined, BACKGROUND_CONTEXT);
  const items = (page as unknown as { items: Array<{ id: number; kind: string }> }).items;
  const ids = items.filter((e) => e.kind === "pi.assistant").map((e) => Number(e.id));
  return ids.length ? Math.max(...ids) : 0;
}

async function assistantRunSince(conv: Conversation, after: number): Promise<{ text: string; tools: string[] }> {
  const page = await conv.entries({ minEntryId: after + 1 } as never, 50, undefined, BACKGROUND_CONTEXT);
  const items = (page as unknown as { items: Array<{ id: number; kind: string; model?: Array<{ content?: unknown }> }> }).items
    .filter((e) => e.kind === "pi.assistant" && Number(e.id) > after)
    .sort((a, b) => Number(a.id) - Number(b.id));
  let text = "";
  const tools: string[] = [];
  for (const e of items) {
    const c = e.model?.[0]?.content as Array<{ type: string; text?: string; name?: string }> | string | undefined;
    const parts: string[] = [];
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === "text" && b.text) parts.push(b.text);
        else if (b.type === "toolCall" && b.name) tools.push(b.name);
      }
    }
    const joined = parts.join("\n").trim();
    if (joined) text = joined;
  }
  return { text, tools };
}
