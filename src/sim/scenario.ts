import fs from "node:fs";
import { EVENT_TYPES } from "../core/index.ts";
import { validateMatch, type Match } from "./matcher.ts";
import type { WorldSpec } from "./world.ts";

/**
 * A scenario is plain JSON: who is in the case, what world they can see, what the humans do,
 * what must always hold, and what this particular case is expected to achieve. Nothing about
 * checkout services or Kubernetes lives in code; new cases are new files.
 */
export const KNOWN_TOOLS = ["world", "k8s", "repo", "observe", "propose"] as const;
export const CAPABILITIES = ["read", "write", "decide"] as const;

export type ActorSpec = {
  id: string;
  kind: "human" | "agent";
  capabilities: string[];
  /** Agents only. */
  system?: string;
  tools?: string[];
  presence?: { state: "active" | "away" | "silent"; echo?: boolean };
};
export type HumanPost = { round: number; actor: string; text: string };
export type DecideRule = { actor: string; when?: Match; answer: "yes" | "no" };
export type ScriptTurn = { calls?: Array<{ tool: string; args: Record<string, unknown> }>; say?: string };
export type Range = { min?: number; max?: number };

export type Expect = {
  events?: Record<string, Range>;
  findings?: Range & { some?: Match[] };
  proposals?: Range & { some?: Match[] };
  /** Final world state: every entry must hold. */
  world?: Array<{ path: string; matches?: string; absent?: string }>;
  /** Rights are enforced, not just claimed: refused tool calls / refused decisions. */
  denied?: { tools?: Range; decisions?: Range; writes?: Range };
  budget?: { maxTokensIn?: number; maxTokensOut?: number; maxToolCalls?: number };
};

export type Scenario = {
  id: string;
  title: string;
  goal: string;
  kickoff: string;
  language: string;
  rounds: number;
  /** Model id for live runs; scripted runs ignore it. */
  model?: string;
  world?: WorldSpec;
  actors: ActorSpec[];
  humanPosts: HumanPost[];
  decide: DecideRule[];
  /** Scripted (deterministic) agent behavior per actor, one entry per round. Absent: live-only scenario. */
  script?: Record<string, ScriptTurn[]>;
  expect: Expect;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

class Problems {
  readonly list: string[] = [];
  add(msg: string) { this.list.push(msg); }
  keys(o: Obj, allowed: readonly string[], where: string) {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) this.add(`${where}: unknown field "${k}"`);
  }
}

function str(p: Problems, o: Obj, k: string, where: string, required = true): string | undefined {
  const v = o[k];
  if (v === undefined) { if (required) p.add(`${where}.${k}: required`); return undefined; }
  if (typeof v !== "string" || !v.trim()) { p.add(`${where}.${k}: must be a non-empty string`); return undefined; }
  return v;
}
function strList(p: Problems, v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) { p.add(`${where}: must be an array of strings`); return []; }
  return v as string[];
}
function range(p: Problems, v: unknown, where: string, extra: readonly string[] = []) {
  if (!isObj(v)) { p.add(`${where}: must be an object`); return; }
  p.keys(v, ["min", "max", ...extra], where);
  for (const k of ["min", "max"]) if (v[k] !== undefined && (typeof v[k] !== "number" || (v[k] as number) < 0)) p.add(`${where}.${k}: must be a non-negative number`);
  if (typeof v.min === "number" && typeof v.max === "number" && v.min > v.max) p.add(`${where}: min > max`);
}

export function parseScenario(raw: unknown, where = "scenario"): Scenario {
  const p = new Problems();
  if (!isObj(raw)) throw new Error(`${where}: must be a JSON object`);
  p.keys(raw, ["id", "title", "goal", "kickoff", "language", "rounds", "model", "world", "actors", "humanPosts", "decide", "script", "expect"], where);
  const id = str(p, raw, "id", where) ?? "?";
  if (id !== "?" && !/^[a-z0-9][a-z0-9-]*$/.test(id)) p.add(`${where}.id: use lowercase letters, digits and dashes`);
  const title = str(p, raw, "title", where) ?? id;
  const goal = str(p, raw, "goal", where) ?? "";
  const kickoff = str(p, raw, "kickoff", where) ?? "";
  const language = str(p, raw, "language", where, false) ?? "English";
  const rounds = raw.rounds === undefined ? 2 : raw.rounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1 || rounds > 20) p.add(`${where}.rounds: integer 1..20`);

  // world
  let world: WorldSpec | undefined;
  if (raw.world !== undefined) {
    if (!isObj(raw.world)) p.add(`${where}.world: must be an object`);
    else {
      p.keys(raw.world, ["files", "effects"], `${where}.world`);
      const files = raw.world.files;
      if (!isObj(files) || Object.values(files).some((c) => typeof c !== "string")) p.add(`${where}.world.files: map of path -> string content`);
      const effects = raw.world.effects ?? [];
      if (!Array.isArray(effects)) p.add(`${where}.world.effects: must be an array`);
      else effects.forEach((e, i) => {
        const w = `${where}.world.effects[${i}]`;
        if (!isObj(e) || !isObj(e.when) || !isObj(e.set)) { p.add(`${w}: needs { when: {path, matches}, set: {path: content} }`); return; }
        p.keys(e, ["when", "set"], w);
        if (typeof e.when.path !== "string" || typeof e.when.matches !== "string") p.add(`${w}.when: needs path and matches`);
        else { try { new RegExp(e.when.matches); } catch { p.add(`${w}.when.matches: invalid regular expression`); } }
        if (Object.values(e.set).some((c) => typeof c !== "string")) p.add(`${w}.set: contents must be strings`);
      });
      world = raw.world as unknown as WorldSpec;
    }
  }

  // actors
  const actors: ActorSpec[] = [];
  if (!Array.isArray(raw.actors) || raw.actors.length === 0) p.add(`${where}.actors: need at least one actor`);
  else raw.actors.forEach((a, i) => {
    const w = `${where}.actors[${i}]`;
    if (!isObj(a)) { p.add(`${w}: must be an object`); return; }
    p.keys(a, ["id", "kind", "capabilities", "system", "tools", "presence"], w);
    const aid = str(p, a, "id", w) ?? "?";
    const kind = a.kind ?? (aid.startsWith("human:") ? "human" : "agent");
    if (kind !== "human" && kind !== "agent") p.add(`${w}.kind: human | agent`);
    const caps = strList(p, a.capabilities, `${w}.capabilities`);
    for (const c of caps) if (!(CAPABILITIES as readonly string[]).includes(c)) p.add(`${w}.capabilities: unknown capability "${c}"`);
    const tools = a.tools === undefined ? undefined : strList(p, a.tools, `${w}.tools`);
    for (const t of tools ?? []) if (!(KNOWN_TOOLS as readonly string[]).includes(t)) p.add(`${w}.tools: unknown tool "${t}"`);
    if (kind === "human" && (a.system !== undefined || a.tools !== undefined)) p.add(`${w}: humans take no system/tools`);
    if (kind === "agent" && a.system === undefined) p.add(`${w}.system: agents need a system prompt`);
    if (a.presence !== undefined) {
      const pr = a.presence;
      if (!isObj(pr) || !["active", "away", "silent"].includes(String(pr.state))) p.add(`${w}.presence: { state: active|away|silent, echo?: boolean }`);
      else p.keys(pr, ["state", "echo"], `${w}.presence`);
    }
    if (actors.some((x) => x.id === aid)) p.add(`${w}.id: duplicate actor "${aid}"`);
    actors.push({ id: aid, kind: kind as "human" | "agent", capabilities: caps, ...(typeof a.system === "string" ? { system: a.system } : {}), ...(tools ? { tools } : {}), ...(isObj(a.presence) ? { presence: a.presence as ActorSpec["presence"] } : {}) } as ActorSpec);
  });
  const byId = new Map(actors.map((a) => [a.id, a]));
  if (!actors.some((a) => a.kind === "human" && a.capabilities.includes("write"))) p.add(`${where}.actors: need a human who can write (the case owner)`);
  if (!actors.some((a) => a.kind === "agent")) p.add(`${where}.actors: need at least one agent`);
  if (!world && actors.some((a) => a.tools?.includes("world"))) p.add(`${where}.world: required because an actor holds the world tool`);

  // human posts + decide rules
  const humanPosts: HumanPost[] = [];
  const posts = raw.humanPosts ?? [];
  if (!Array.isArray(posts)) p.add(`${where}.humanPosts: must be an array`);
  else posts.forEach((h, i) => {
    const w = `${where}.humanPosts[${i}]`;
    if (!isObj(h)) { p.add(`${w}: must be an object`); return; }
    p.keys(h, ["round", "actor", "text"], w);
    const actor = str(p, h, "actor", w) ?? "?";
    const text = str(p, h, "text", w) ?? "";
    if (typeof h.round !== "number" || !Number.isInteger(h.round) || h.round < 1 || (typeof rounds === "number" && h.round > rounds)) p.add(`${w}.round: integer 1..rounds`);
    if (byId.get(actor)?.kind !== "human") p.add(`${w}.actor: "${actor}" is not a human in this scenario`);
    humanPosts.push({ round: Number(h.round), actor, text });
  });
  const decide: DecideRule[] = [];
  const rules = raw.decide ?? [];
  if (!Array.isArray(rules)) p.add(`${where}.decide: must be an array`);
  else rules.forEach((r, i) => {
    const w = `${where}.decide[${i}]`;
    if (!isObj(r)) { p.add(`${w}: must be an object`); return; }
    p.keys(r, ["actor", "when", "answer"], w);
    const actor = str(p, r, "actor", w) ?? "?";
    if (byId.get(actor)?.kind !== "human") p.add(`${w}.actor: "${actor}" is not a human in this scenario`);
    if (r.answer !== "yes" && r.answer !== "no") p.add(`${w}.answer: yes | no`);
    if (r.when !== undefined) { const e = validateMatch(r.when, `${w}.when`); if (e) p.add(e); }
    decide.push({ actor, ...(r.when ? { when: r.when as Match } : {}), answer: r.answer as "yes" | "no" });
  });

  // script
  let script: Record<string, ScriptTurn[]> | undefined;
  if (raw.script !== undefined) {
    if (!isObj(raw.script)) p.add(`${where}.script: must be an object keyed by agent id`);
    else {
      script = {};
      for (const [aid, turns] of Object.entries(raw.script)) {
        const w = `${where}.script["${aid}"]`;
        if (byId.get(aid)?.kind !== "agent") { p.add(`${w}: not an agent in this scenario`); continue; }
        if (!Array.isArray(turns)) { p.add(`${w}: must be an array of turns (one per round)`); continue; }
        turns.forEach((t, i) => {
          if (!isObj(t)) { p.add(`${w}[${i}]: must be an object`); return; }
          p.keys(t, ["calls", "say"], `${w}[${i}]`);
          if (t.say !== undefined && typeof t.say !== "string") p.add(`${w}[${i}].say: must be a string`);
          if (t.calls !== undefined) {
            if (!Array.isArray(t.calls)) { p.add(`${w}[${i}].calls: must be an array`); return; }
            t.calls.forEach((c, j) => {
              if (!isObj(c) || typeof c.tool !== "string" || !isObj(c.args)) p.add(`${w}[${i}].calls[${j}]: needs { tool, args }`);
              else if (!(KNOWN_TOOLS as readonly string[]).includes(c.tool)) p.add(`${w}[${i}].calls[${j}].tool: unknown tool "${c.tool}"`);
            });
          }
        });
        script[aid] = turns as ScriptTurn[];
      }
    }
  }

  // expect
  const expect: Expect = {};
  if (raw.expect !== undefined) {
    const e = raw.expect;
    const w = `${where}.expect`;
    if (!isObj(e)) p.add(`${w}: must be an object`);
    else {
      p.keys(e, ["events", "findings", "proposals", "world", "denied", "budget"], w);
      if (e.events !== undefined) {
        if (!isObj(e.events)) p.add(`${w}.events: must be an object`);
        else for (const [t, r] of Object.entries(e.events)) {
          if (!(EVENT_TYPES as readonly string[]).includes(t)) p.add(`${w}.events: unknown event type "${t}"`);
          range(p, r, `${w}.events.${t}`);
        }
      }
      for (const k of ["findings", "proposals"] as const) {
        const v = e[k];
        if (v === undefined) continue;
        range(p, v, `${w}.${k}`, ["some"]);
        if (isObj(v) && v.some !== undefined) {
          if (!Array.isArray(v.some)) p.add(`${w}.${k}.some: must be an array of matches`);
          else v.some.forEach((m, i) => { const err = validateMatch(m, `${w}.${k}.some[${i}]`); if (err) p.add(err); });
        }
      }
      if (e.world !== undefined) {
        if (!Array.isArray(e.world)) p.add(`${w}.world: must be an array`);
        else e.world.forEach((c, i) => {
          if (!isObj(c) || typeof c.path !== "string" || (c.matches === undefined && c.absent === undefined)) p.add(`${w}.world[${i}]: needs path and matches and/or absent`);
          else for (const k of ["matches", "absent"]) if (c[k] !== undefined) { try { new RegExp(String(c[k])); } catch { p.add(`${w}.world[${i}].${k}: invalid regular expression`); } }
        });
        if (!world) p.add(`${w}.world: scenario has no world`);
      }
      if (e.denied !== undefined) {
        if (!isObj(e.denied)) p.add(`${w}.denied: must be an object`);
        else { p.keys(e.denied, ["tools", "decisions", "writes"], `${w}.denied`); for (const k of ["tools", "decisions", "writes"]) if (e.denied[k] !== undefined) range(p, e.denied[k], `${w}.denied.${k}`); }
      }
      if (e.budget !== undefined) {
        if (!isObj(e.budget)) p.add(`${w}.budget: must be an object`);
        else { p.keys(e.budget, ["maxTokensIn", "maxTokensOut", "maxToolCalls"], `${w}.budget`); for (const [k, v] of Object.entries(e.budget)) if (typeof v !== "number" || v < 0) p.add(`${w}.budget.${k}: must be a non-negative number`); }
      }
      Object.assign(expect, e);
    }
  }

  if (p.list.length) throw new Error(`invalid scenario ${id}:\n  - ${p.list.join("\n  - ")}`);
  return {
    id, title, goal, kickoff, language, rounds: rounds as number,
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(world ? { world } : {}),
    actors, humanPosts, decide, ...(script ? { script } : {}), expect,
  };
}

export function loadScenario(file: string): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read scenario ${file}: ${(e as Error).message}`);
  }
  return parseScenario(raw, file);
}
