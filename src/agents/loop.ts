import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Conversation } from "@earendil-works/pi-durable";
import { Store } from "../core/index.ts";
import { describeTools } from "./tools.ts";
import { askConv, type Durable } from "./durable.ts";
import { sanitize } from "./sanitize.ts";

export { sanitize };

/**
 * Pi owns the agent: model transport, the tool loop, durable history, crash recovery.
 * This file owns only the protocol edge of a turn: read the case → hand it to the agent's
 * Pi conversation → post what the agent said back to the case. Findings and proposals are
 * written by the agent through Pi tools (see pi-tools.ts), never parsed out of text here.
 */
export type AgentConfig = {
  actorId: string;
  contextId: string;
  /** The agent's durable Pi conversation (one per context+actor, see durable.ts). */
  durable: { d: Durable; conv: Conversation };
};

/** Gateway bearer: PIO_GATEWAY_BEARER, else the file named by PIO_BEARER_FILE (default: host gateway config). */
export function readBearer(path = process.env.PIO_BEARER_FILE ?? `${process.env.HOME ?? ""}/.config/opencode-go-gateway/gateway-bearer`): string {
  const fromEnv = process.env.PIO_GATEWAY_BEARER?.trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`gateway bearer not found: set PIO_GATEWAY_BEARER or PIO_BEARER_FILE (tried ${path})`);
  }
}

export function contextPrompt(s: Store, contextId: string, goal: string, lastN = 30): string {
  const events = s.eventsSince(contextId, 0, 500).slice(-lastN);
  const lines = events.map((e) => {
    const d = e.data as Record<string, unknown>;
    const text = String(d.text ?? d.question ?? d.answer ?? d.observation ?? JSON.stringify(d)).slice(0, 400);
    return `[${e.type}] ${e.actorId}: ${text}`;
  });
  // Case digest: confirmed findings first, so tools gather and hypotheses converge.
  const confirmed = s.db.prepare(`SELECT author_id, text FROM artifacts WHERE context_id=? AND status='confirmed' ORDER BY created_at`).all(contextId) as Array<{ author_id: string; text: string }>;
  const digest = confirmed.length
    ? `Confirmed so far:\n${confirmed.map((c) => `- ${c.author_id}: ${c.text.slice(0, 300)}`).join("\n")}\n\n`
    : "";
  return `Goal: ${goal}\n\n${digest}Shared history (newest last):\n${lines.join("\n")}`;
}

/** Durable conversations need the FULL system text at creation: bare role prompts drift into meta-chat. */
export function fullSystem(base: string): string {
  return `${base}\n\nReply in Finnish. Keep it under 120 words.\n${describeTools()}\nNever invent log/config content: fetch it with a tool first.\nRecord evidence-backed findings with the observe tool. To change anything use the propose tool: do NOT describe a kubectl command. A human must approve before anything runs.`;
}

export async function agentTurn(
  s: Store,
  cfg: AgentConfig,
): Promise<{ kind: "message" | "observation"; text: string; usage: { prompt_tokens: number; completion_tokens: number }; toolCalls: number; proposals: number }> {
  const goalRow = s.db.prepare(`SELECT goal FROM contexts WHERE id=?`).get(cfg.contextId) as { goal: string } | undefined;
  const prompt = contextPrompt(s, cfg.contextId, goalRow?.goal ?? "");
  const r = await askConv(cfg.durable.d, cfg.durable.conv, `${prompt}\n\nYou are ${cfg.actorId}. What is your next contribution?`, `turn:${cfg.actorId}:${randomUUID()}`);
  const text = sanitize(r.text).trim();
  const proposals = r.tools.filter((t) => t === "propose").length;
  const wroteFinding = r.tools.some((t) => t === "observe" || t === "propose");
  if (text) {
    const note = r.tools.length ? `\n\n[tools used: ${r.tools.length}]` : "";
    s.postMessage(cfg.contextId, cfg.actorId, `turn:${cfg.actorId}:${Date.now()}:${randomUUID().slice(0, 8)}`, text + note);
  }
  return { kind: wroteFinding ? "observation" : "message", text, usage: r.usage, toolCalls: r.tools.length, proposals };
}
