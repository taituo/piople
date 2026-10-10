import type { InboxDetail, InboxSummary, Store } from "../core/index.ts";
import { OPS, runOp, type Args } from "../ops.ts";
import type { CoreClient, Harness, Step } from "./types.ts";

export class LocalCore implements CoreClient {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async call(as: string, op: string, args: Args = {}): Promise<unknown> {
    return runOp(this.store, as, op, args);
  }
}

export type HostError = { actor: string; context: string; error: unknown };
type Entry = { actor: string; harness: Harness; recovered: boolean; failures: number };

/**
 * One process, many harnesses, each its own actor. The host only delivers: it polls each actor's
 * inbox, calls its harness when there is something new from others (or, once after start, when
 * something is still owed), and moves the cursor forward after a successful step.
 * Membership is never granted here: decide-holders add actors to contexts through Core.
 */
export class Host {
  private readonly entries = new Map<string, Entry>();
  private loops: Promise<void>[] = [];
  private running = false;
  private readonly sleepers = new Set<() => void>();
  onError: (e: HostError) => void = () => {};
  private readonly core: CoreClient;
  private readonly opts: { pollMs?: number };

  constructor(core: CoreClient, opts: { pollMs?: number } = {}) {
    this.core = core;
    this.opts = opts;
  }

  async add(o: { actor: string; harness: Harness; name?: string; skills?: string[] }): Promise<void> {
    if (this.entries.has(o.actor)) throw new Error(`already-hosted: ${o.actor}`);
    await this.core.call(o.actor, "actor", { name: o.name ?? o.actor, ...(o.skills ? { skills: o.skills.join(",") } : {}) });
    const entry: Entry = { actor: o.actor, harness: o.harness, recovered: false, failures: 0 };
    this.entries.set(o.actor, entry);
    if (this.running) this.loops.push(this.loop(entry));
  }

  /** Swap the harness behind an actor (reconnect / new process instance). Identity and cursor stay. */
  async replace(actor: string, harness: Harness): Promise<void> {
    const e = this.entries.get(actor);
    if (!e) throw new Error(`not-hosted: ${actor}`);
    await e.harness.close?.();
    e.harness = harness;
    e.recovered = false;
  }

  actors(): string[] {
    return [...this.entries.keys()];
  }

  /** Check one actor's inbox once. Returns how many steps were attempted. */
  async pump(actor: string): Promise<number> {
    const e = this.entries.get(actor);
    if (!e) throw new Error(`not-hosted: ${actor}`);
    const first = !e.recovered;
    let steps = 0;
    const summary = (await this.core.call(actor, "inbox")) as InboxSummary[];
    for (const s of summary) {
      if (s.unread === 0 && !(first && s.pending > 0)) continue;
      const detail = (await this.core.call(actor, "inbox", { context: s.context })) as InboxDetail;
      steps++;
      try {
        await e.harness.step(this.makeStep(actor, detail));
        e.failures = 0;
      } catch (error) {
        e.failures++;
        this.onError({ actor, context: s.context, error });
        continue; // no ack: the same events are delivered again
      }
      const last = detail.events.at(-1)?.seq;
      if (last === undefined) continue;
      await this.core.call(actor, "ack", { context: s.context, seq: last });
      // What the step itself wrote sits right after `last`; skip past it, but never past anyone else's event.
      const rest = ((await this.core.call(actor, "inbox", { context: s.context })) as InboxDetail).events;
      if (rest.length > 0 && rest.every((ev) => ev.actorId === actor)) {
        await this.core.call(actor, "ack", { context: s.context, seq: rest.at(-1)!.seq });
      }
    }
    e.recovered = true;
    return steps;
  }

  /** One sequential pass over every hosted actor (deterministic, for tests and scripts). */
  async tick(): Promise<number> {
    let n = 0;
    for (const actor of [...this.entries.keys()]) n += await this.pump(actor);
    return n;
  }

  /** Tick until nothing is delivered. Throws if it never settles (a harness that keeps failing or keeps provoking). */
  async settle(maxTicks = 100): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxTicks; i++) {
      const n = await this.tick();
      if (n === 0) return total;
      total += n;
    }
    throw new Error(`not-settled: still delivering after ${maxTicks} ticks`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = [...this.entries.values()].map((e) => this.loop(e));
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const wake of [...this.sleepers]) wake();
    await Promise.all(this.loops);
    this.loops = [];
  }

  async close(): Promise<void> {
    await this.stop();
    for (const e of this.entries.values()) await e.harness.close?.();
  }

  private async loop(e: Entry): Promise<void> {
    const base = this.opts.pollMs ?? 200;
    while (this.running) {
      let didWork = 0;
      try {
        didWork = await this.pump(e.actor);
      } catch (error) {
        this.onError({ actor: e.actor, context: "*", error });
      }
      const wait = e.failures > 0 ? Math.min(base * 2 ** e.failures, 30_000) : didWork ? 0 : base;
      if (wait > 0) await this.sleep(wait);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  private makeStep(actor: string, d: InboxDetail): Step {
    let n = 0;
    return {
      actor,
      context: d.context,
      cursor: d.cursor,
      events: d.events,
      pending: d.pending,
      run: async (op, args = {}) => {
        const def = OPS[op];
        const a: Args = { ...args };
        n++;
        const stable = `${actor}@${d.context}#${d.cursor}.${n}`;
        if (def?.required.includes("context") || def?.optional?.includes("context")) a.context ??= d.context;
        if (def?.optional?.includes("key")) a.key ??= stable;
        else if (def?.mintsId) a.id ??= stable.replace(/[^\w.-]/g, "-");
        return (await this.core.call(actor, op, a)) as never;
      },
    };
  }
}
