import fs from "node:fs";
import type { Models } from "@earendil-works/pi-ai";
import { Store } from "../core/index.ts";
import { describeTools, runTool } from "./tools.ts";
import { createGateway, textOf } from "./pi-provider.ts";

/**
 * B1: Pi owns model transport (pi-ai provider on the gateway).
 * The loop still owns the protocol: read context → ask model → write back.
 */

export type AgentConfig = {
  actorId: string;
  contextId: string;
  system: string;
  model: string;
  baseUrl: string;
  bearer: string;
  maxTokens: number;
  /** Injected Pi models (tests). Built from baseUrl/bearer/model when absent. */
  pi?: Models;
};

export function readBearer(path = "/home/tiny/.config/opencode-go-gateway/gateway-bearer"): string {
  return fs.readFileSync(path, "utf8").trim();
}

/** Strip model control-token leakage (e.g. DeepSeek <ds_s>) before parsing. */
export function sanitize(text: string): string {
  return text.replace(/<[a-zA-Z_|][a-zA-Z0-9_|]*>/g, "");
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

async function chat(cfg: AgentConfig, messages: Array<{ role: string; content: string }>): Promise<{ text: string; usage: { prompt_tokens?: number; completion_tokens?: number } }> {
  const pi = cfg.pi ?? createGateway(cfg.baseUrl, cfg.bearer, [cfg.model]).models;
  const model = pi.getModel("piople", cfg.model);
  if (!model) throw new Error(`model not registered: ${cfg.model}`);
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  // pi-ai 1.0.4 openai-completions crashes on string-form assistant messages
  // ("Cannot read properties of undefined (reading 'length')"): send blocks.
  // It also chokes on the `timestamp` field: omit it entirely.
  const rest = messages.filter((m) => m.role !== "system").map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.role === "assistant" ? [{ type: "text" as const, text: m.content }] : m.content,
  }));
  const msg = await pi.completeSimple(model, { systemPrompt: system, messages: rest } as never, {
    maxTokens: cfg.maxTokens,
    transformHeaders: (h: Record<string, string | null>) => ({ ...h, "x-session-id": `piople-${cfg.contextId}-${cfg.actorId}` }),
  } as never);
  const usage = (msg as { usage?: { input?: number; output?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;
  return {
    text: textOf(msg as never).trim(),
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? usage?.input ?? 0,
      completion_tokens: usage?.completion_tokens ?? usage?.output ?? 0,
    },
  };
}

export async function agentTurn(s: Store, cfg: AgentConfig): Promise<{ kind: "message" | "observation"; text: string; usage: unknown; toolCalls: number }> {
  const goalRow = s.db.prepare(`SELECT goal FROM contexts WHERE id=?`).get(cfg.contextId) as { goal: string } | undefined;
  const prompt = contextPrompt(s, cfg.contextId, goalRow?.goal ?? "");
  const system = cfg.system + "\n\nReply in Finnish. Start with OBS: if you state a finding with evidence, otherwise plain chat. Keep it under 120 words.\nYou have read-only cluster tools. " + describeTools() + "\nNever invent log/config content: fetch it with a tool first.\nTo change anything, do NOT describe a kubectl patch command — instead reply with one line PROPOSE: {\"verb\":\"patch\",\"res\":\"configmap\",\"ns\":\"demo-apps\",\"name\":\"...\",\"patch\":{...},\"why\":\"...\"}. A human must approve before anything runs.";
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: system },
    { role: "user", content: prompt + `\n\nYou are ${cfg.actorId}. What is your next contribution?` },
  ];  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let toolCalls = 0;
  const toolLog: string[] = [];
  // Up to 3 tool rounds, then a final answer.
  for (let i = 0; i < 3; i++) {
    const r = await chat(cfg, messages);
    usage.prompt_tokens! += r.usage.prompt_tokens ?? 0;
    usage.completion_tokens! += r.usage.completion_tokens ?? 0;
    const m = /^TOOLCALL\s+(\{.*\})\s*$/m.exec(sanitize(r.text));
    if (!m) {
      return finish(s, cfg, r.text, usage, toolCalls, toolLog);
    }
    let call: Record<string, unknown>;
    try { call = JSON.parse(m[1]!); } catch { break; }
    const result = await runTool(call as never);
    toolCalls++;
    toolLog.push(`${JSON.stringify(call)} -> ${result.output.slice(0, 300)}`);
    messages.push({ role: "assistant", content: sanitize(r.text) });
    messages.push({ role: "user", content: `Tool result (ok=${result.ok}):\n${result.output.slice(0, 2000)}\n\nContinue. Answer with findings, not more tool calls unless strictly needed.` });
  }
  const r = await chat(cfg, messages);
  usage.prompt_tokens! += r.usage.prompt_tokens ?? 0;
  usage.completion_tokens! += r.usage.completion_tokens ?? 0;
  return finish(s, cfg, r.text, usage, toolCalls, toolLog);
}

function finish(s: Store, cfg: AgentConfig, text: string, usage: unknown, toolCalls: number, toolLog: string[]) {
  text = sanitize(text);
  const clean = text.replace(/^TOOLCALL\s+\{.*\}\s*/m, "").trim() || text;
  const key = `turn:${cfg.actorId}:${Date.now()}`;
  const evidence = [`model:${cfg.model}`, ...toolLog.map((t) => `tool:${t.slice(0, 120)}`)];
  // PROPOSE: {"verb":"patch","res":"configmap","ns":"demo-apps","name":"checkout-config","patch":{...},"why":"..."}
  const pm = /^PROPOSE:\s*(\{.*\})\s*$/m.exec(clean);
  if (pm) {
    try {
      const p = JSON.parse(pm[1]!) as { verb: string; res: string; ns: string; name?: string; patch?: unknown; why?: string };
      const pid = `${key}-prop`;
      const did = `${key}-dec`;
      s.proposeAction(
        { id: pid, contextId: cfg.contextId, kind: "proposal", authorId: cfg.actorId, text: `${String(p.why ?? clean).slice(0, 500)}`, status: null, evidence, createdAt: Date.now() },
        { verb: p.verb, res: p.res, ns: p.ns, name: p.name, patch: p.patch },
        did,
      );
      s.requestDecision({ id: did, contextId: cfg.contextId, question: `Approve action: ${p.verb} ${p.res} ${p.name ?? ""} in ${p.ns}?`, options: ["yes", "no"], requestedBy: cfg.actorId, decidedBy: null, answer: null, status: "open", createdAt: Date.now(), resolvedAt: null });
      return { kind: "observation" as const, text: `Proposed action, waiting for human decision ${did}`, usage, toolCalls };
    } catch { /* fall through to normal handling */ }
  }
  if (clean.startsWith("OBS:")) {
    s.recordObservation({
      id: key, contextId: cfg.contextId, kind: "finding", authorId: cfg.actorId,
      text: clean.slice(4).trim(), status: "hypothesis", evidence, createdAt: Date.now(),
    });
    return { kind: "observation" as const, text: clean, usage, toolCalls };
  }
  s.postMessage(cfg.contextId, cfg.actorId, key, toolLog.length ? `${clean}\n\n[tools used: ${toolCalls}]` : clean);
  return { kind: "message" as const, text: clean, usage, toolCalls };
}
