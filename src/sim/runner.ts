import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Models } from "@earendil-works/pi-ai";
import { Store, type PiopleEvent } from "../core/index.ts";
import { agentTurn, fullSystem } from "../agents/loop.ts";
import { openDurable, ensureConv } from "../agents/durable.ts";
import { createGateway } from "../agents/pi-provider.ts";
import { executeIfApproved, type Adapter } from "../agents/executor.ts";
import { matches } from "./matcher.ts";
import { checkInvariants, type Check } from "./invariants.ts";
import type { Range, Scenario } from "./scenario.ts";
import { World } from "./world.ts";

export type RunOptions = {
  mode: "scripted" | "live";
  /** live: model id (overrides scenario.model) and gateway. */
  model?: string;
  baseUrl?: string;
  bearer?: string;
  /** Persist the case + Pi databases here (else in memory). */
  dbPath?: string;
  rounds?: number;
  log?: (line: string) => void;
};

export type Outcome = { name: string; ok: boolean; detail: string };
export type Report = {
  scenario: string;
  title: string;
  mode: RunOptions["mode"];
  model: string;
  rounds: number;
  verdict: "pass" | "fail";
  safety: Check[];
  quality: Check[];
  expectations: Outcome[];
  errors: string[];
  metrics: {
    tokensIn: number; tokensOut: number; toolCalls: number; events: number;
    findings: number; proposals: number; deniedTools: number; deniedDecisions: number; deniedWrites: number; elapsedMs: number;
    perActor: Record<string, { turns: number; toolCalls: number; messages: number; findings: number; proposals: number }>;
  };
  world?: { changes: Array<{ path: string; key: string; before: string; after: string }>; final: Record<string, string> };
  timeline: Array<{ seq: number; type: string; actor: string; summary: string }>;
};

const RIGHTS_ERROR = /^(forbidden|not-a-member|missing-actor)|tool-denied|lacks /;

function worldAdapter(world: World): Adapter {
  return {
    check(a) {
      if (a.verb !== "set") return `world adapter supports verb "set" only, got "${String(a.verb)}"`;
      if (typeof a.path !== "string" || typeof a.key !== "string" || a.value === undefined) return "world set needs path, key and value";
      return world.files.has(a.path) ? null : `no such file: ${a.path}`;
    },
    describe: (a) => `world set ${String(a.path)} ${String(a.key)}=${String(a.value)}`,
    async run(a) {
      try {
        const c = world.setKey(String(a.path), String(a.key), String(a.value));
        return { ok: true, output: `${c.path}: ${c.key} ${c.before} -> ${c.after}` };
      } catch (e) {
        return { ok: false, output: `FAILED: ${(e as Error).message}` };
      }
    },
  };
}

function inRange(n: number, r: Range): boolean {
  return (r.min === undefined || n >= r.min) && (r.max === undefined || n <= r.max);
}
const rangeText = (r: Range) => `${r.min ?? 0}..${r.max ?? "∞"}`;

export async function runScenario(scn: Scenario, opts: RunOptions): Promise<Report> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const rounds = opts.rounds ?? scn.rounds;
  if (opts.mode === "scripted" && !scn.script) throw new Error(`scenario ${scn.id} has no script: run it live`);

  const store = new Store(opts.dbPath ?? ":memory:");
  const world = scn.world ? new World(scn.world) : undefined;
  const ctx = `case-${scn.id}`;
  const deniedTools: string[] = [];
  const deniedDecisions: string[] = [];
  const deniedWrites: string[] = [];
  const errors: string[] = [];

  // models: a scripted fake, or the real gateway
  let models: Models;
  let model: { provider: string; id: string };
  let faux: ReturnType<typeof fauxProvider> | undefined;
  if (opts.mode === "scripted") {
    faux = fauxProvider();
    const fm = createModels();
    fm.setProvider(faux.provider);
    models = fm;
    const m = faux.getModel();
    model = { provider: m.provider, id: m.id };
  } else {
    const id = opts.model ?? scn.model;
    if (!id) throw new Error("live run needs a model (--model or scenario.model)");
    if (!opts.baseUrl || !opts.bearer) throw new Error("live run needs a gateway (baseUrl + bearer)");
    models = createGateway(opts.baseUrl, opts.bearer, [id]).models;
    model = { provider: "piople", id };
  }

  const toolsOf = (id: string) => scn.actors.find((a) => a.id === id)?.tools ?? ["observe"];
  const durable = await openDurable(opts.dbPath ? `${opts.dbPath}.pi.sqlite` : ":memory:", models, store, {
    ...(world ? { world: () => world } : {}),
    allow: (_c, actor, tool) => toolsOf(actor).includes(tool),
    onDenied: (d) => deniedTools.push(`${d.actorId}:${d.tool}`),
  });

  try {
    // people and agents
    for (const a of scn.actors) store.upsertActor({ id: a.id, kind: a.kind, name: a.id });
    const owner = scn.actors.find((a) => a.kind === "human" && a.capabilities.includes("write"))!;
    store.createContext({ id: ctx, kind: "case", title: scn.title, goal: scn.goal, createdAt: Date.now() }, owner.id);
    for (const a of scn.actors) store.join({ contextId: ctx, actorId: a.id, capabilities: a.capabilities, joinedAt: Date.now() }, `join:${a.id}`);
    for (const a of scn.actors) if (a.presence) store.setPresence(a.id, a.presence.state, a.presence.echo === true);
    store.postMessage(ctx, owner.id, "kickoff", scn.kickoff);

    const agents = scn.actors.filter((a) => a.kind === "agent");
    const convs = new Map<string, Awaited<ReturnType<typeof ensureConv>>>();
    for (const a of agents) {
      convs.set(a.id, await ensureConv(durable, store, ctx, a.id, fullSystem(a.system!, { language: scn.language, tools: toolsOf(a.id) }), { provider: model.provider, modelId: model.id }));
    }

    const perActor: Report["metrics"]["perActor"] = {};
    for (const a of scn.actors) perActor[a.id] = { turns: 0, toolCalls: 0, messages: 0, findings: 0, proposals: 0 };
    let tokensIn = 0, tokensOut = 0, toolCalls = 0;

    const adapters: Record<string, Adapter> = world ? { world: worldAdapter(world) } : {};

    /** Humans act on open decisions by the scenario's rules; approved actions then run through the executor. */
    const processDecisions = async () => {
      const open = store.db.prepare(`SELECT id FROM decisions WHERE context_id=? AND status='open' ORDER BY created_at, rowid`).all(ctx) as Array<{ id: string }>;
      for (const { id: decisionId } of open) {
        const prop = store.eventsSince(ctx, 0, 100_000).find((e) => e.type === "action.proposed" && e.data.decisionId === decisionId);
        if (!prop) continue;
        const action = prop.data.action as Record<string, unknown>;
        const text = (store.db.prepare(`SELECT text FROM artifacts WHERE id=?`).get(String(prop.data.proposalId)) as { text: string } | undefined)?.text ?? "";
        // Rules are tried in order until the Store accepts one: a refused decider (no `decide`, or an echo delegate) is logged and the next rule gets its turn.
        let accepted: (typeof scn.decide)[number] | undefined;
        for (const rule of scn.decide.filter((r) => !r.when || matches({ ...action, why: text }, r.when))) {
          try {
            store.resolveDecision(ctx, rule.actor, `decide:${decisionId}`, decisionId, rule.answer);
            log(`  ${rule.actor} decided ${decisionId}: ${rule.answer}`);
            accepted = rule;
            break;
          } catch (e) {
            deniedDecisions.push(`${rule.actor}:${decisionId}:${(e as Error).message}`);
            log(`  ${rule.actor} was refused deciding ${decisionId}: ${(e as Error).message}`);
          }
        }
        if (accepted?.answer === "yes") {
          const r = await executeIfApproved(store, ctx, accepted.actor, String(prop.data.proposalId), decisionId, { adapters, allowWrite: true, defaultAdapter: "world" });
          log(`  executed ${String(prop.data.proposalId)}: ${r.ran ? "ok" : "refused"} ${r.output.slice(0, 120)}`);
        }
      }
    };

    for (let round = 1; round <= rounds; round++) {
      log(`round ${round}/${rounds}`);
      for (const h of scn.humanPosts.filter((p) => p.round === round)) {
        try {
          store.postMessage(ctx, h.actor, `human:${h.actor}:${round}:${store.eventsSince(ctx, 0, 100_000).length}`, h.text);
          perActor[h.actor]!.messages++;
        } catch (e) {
          (RIGHTS_ERROR.test((e as Error).message) ? deniedWrites : errors).push(`${h.actor} post: ${(e as Error).message}`);
        }
      }
      for (const a of agents) {
        if (faux) {
          const turn = scn.script![a.id]?.[round - 1] ?? {};
          faux.setResponses([
            ...(turn.calls ?? []).map((c) => fauxAssistantMessage([fauxToolCall(c.tool, c.args as never)], { stopReason: "toolUse" })),
            fauxAssistantMessage([fauxText(turn.say ?? "ok")]),
          ]);
        }
        try {
          const r = await agentTurn(store, { actorId: a.id, contextId: ctx, durable: { d: durable, conv: convs.get(a.id)! } });
          tokensIn += r.usage.prompt_tokens;
          tokensOut += r.usage.completion_tokens;
          toolCalls += r.toolCalls;
          const st = perActor[a.id]!;
          st.turns++;
          st.toolCalls += r.toolCalls;
          if (r.text) st.messages++;
          log(`  ${a.id}: ${r.toolCalls} tool calls${r.text ? ` — ${r.text.slice(0, 100).replace(/\n/g, " ")}` : ""}`);
        } catch (e) {
          const msg = (e as Error).message;
          (RIGHTS_ERROR.test(msg) ? deniedWrites : errors).push(`${a.id} turn ${round}: ${msg}`);
          log(`  ${a.id}: error ${msg}`);
        }
      }
      await processDecisions();
    }

    // collect
    const events = store.eventsSince(ctx, 0, 100_000);
    const findings = (store.db.prepare(`SELECT author_id, text, evidence, status FROM artifacts WHERE context_id=? AND kind='finding'`).all(ctx) as Array<{ author_id: string; text: string; evidence: string; status: string | null }>)
      .map((f) => ({ author: f.author_id, text: f.text, evidence: (JSON.parse(f.evidence) as string[]).join(" | "), status: f.status }));
    const proposalEvents = events.filter((e) => e.type === "action.proposed");
    const proposals = proposalEvents.map((e) => ({
      ...(e.data.action as Record<string, unknown>),
      why: (store.db.prepare(`SELECT text FROM artifacts WHERE id=?`).get(String(e.data.proposalId)) as { text: string } | undefined)?.text ?? "",
    }));
    for (const f of findings) perActor[f.author]!.findings++;
    for (const e of proposalEvents) perActor[e.actorId]!.proposals++;

    const checks = checkInvariants(store, ctx, world);
    const expectations = evaluate(scn, { events, findings, proposals, world, deniedTools, deniedDecisions, deniedWrites, tokensIn, tokensOut, toolCalls });

    const safety = checks.filter((c) => c.kind === "safety");
    const quality = checks.filter((c) => c.kind === "quality");
    const verdict = safety.every((c) => c.ok) && expectations.every((c) => c.ok) && errors.length === 0 ? "pass" : "fail";

    return {
      scenario: scn.id, title: scn.title, mode: opts.mode, model: opts.mode === "live" ? model.id : "scripted", rounds, verdict,
      safety, quality, expectations, errors,
      metrics: {
        tokensIn, tokensOut, toolCalls, events: events.length, findings: findings.length, proposals: proposals.length,
        deniedTools: deniedTools.length, deniedDecisions: deniedDecisions.length, deniedWrites: deniedWrites.length, elapsedMs: Date.now() - started, perActor,
      },
      ...(world ? { world: { changes: world.changes, final: world.snapshot() } } : {}),
      timeline: events.map((e) => ({ seq: e.seq, type: e.type, actor: e.actorId, summary: summarize(e) })),
    };
  } finally {
    await durable.close();
    store.close();
  }
}

function summarize(e: PiopleEvent): string {
  const d = e.data;
  const t = d.text ?? d.question ?? d.answer ?? d.output ?? (d.action ? JSON.stringify(d.action) : undefined) ?? JSON.stringify(d);
  return String(t).replace(/\s+/g, " ").slice(0, 160);
}

type Facts = {
  events: PiopleEvent[];
  findings: Array<{ author: string; text: string; evidence: string; status: string | null }>;
  proposals: Array<Record<string, unknown>>;
  world: World | undefined;
  deniedTools: string[];
  deniedDecisions: string[];
  deniedWrites: string[];
  tokensIn: number; tokensOut: number; toolCalls: number;
};

function evaluate(scn: Scenario, f: Facts): Outcome[] {
  const out: Outcome[] = [];
  const e = scn.expect;
  const push = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  for (const [type, r] of Object.entries(e.events ?? {})) {
    const n = f.events.filter((x) => x.type === type).length;
    push(`events.${type}`, inRange(n, r), `${n} (want ${rangeText(r)})`);
  }
  for (const [kind, list] of [["findings", f.findings], ["proposals", f.proposals]] as const) {
    const x = e[kind];
    if (!x) continue;
    push(`${kind}.count`, inRange(list.length, x), `${list.length} (want ${rangeText(x)})`);
    (x.some ?? []).forEach((m, i) => {
      const hit = (list as unknown[]).some((item) => matches(item, m));
      push(`${kind}.some[${i}]`, hit, hit ? "matched" : `none of ${list.length} matches ${JSON.stringify(m)}`);
    });
  }
  (e.world ?? []).forEach((c, i) => {
    const content = f.world?.files.get(c.path);
    if (content === undefined) {
      push(`world[${i}] ${c.path}`, false, "file missing");
      return;
    }
    if (c.matches !== undefined) push(`world[${i}] ${c.path} matches`, new RegExp(c.matches, "m").test(content), c.matches);
    if (c.absent !== undefined) push(`world[${i}] ${c.path} absent`, !new RegExp(c.absent, "m").test(content), c.absent);
  });
  if (e.denied?.tools) push("denied.tools", inRange(f.deniedTools.length, e.denied.tools), `${f.deniedTools.length} (want ${rangeText(e.denied.tools)})`);
  if (e.denied?.decisions) push("denied.decisions", inRange(f.deniedDecisions.length, e.denied.decisions), `${f.deniedDecisions.length} (want ${rangeText(e.denied.decisions)})`);
  if (e.denied?.writes) push("denied.writes", inRange(f.deniedWrites.length, e.denied.writes), `${f.deniedWrites.length} (want ${rangeText(e.denied.writes)})`);
  if (e.budget?.maxTokensIn !== undefined) push("budget.tokensIn", f.tokensIn <= e.budget.maxTokensIn, `${f.tokensIn} (max ${e.budget.maxTokensIn})`);
  if (e.budget?.maxTokensOut !== undefined) push("budget.tokensOut", f.tokensOut <= e.budget.maxTokensOut, `${f.tokensOut} (max ${e.budget.maxTokensOut})`);
  if (e.budget?.maxToolCalls !== undefined) push("budget.toolCalls", f.toolCalls <= e.budget.maxToolCalls, `${f.toolCalls} (max ${e.budget.maxToolCalls})`);
  return out;
}
