import { randomUUID } from "node:crypto";
import type { InboxDetail, InboxSummary, Store } from "../core/index.ts";
import { OPS, opDef, runOp, type Args } from "../ops.ts";
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
type Entry = { actor: string; harness: Harness; recovered: boolean; failures: number; leaseUntil: number; looping?: boolean };

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
  /** An error handler that throws must not take the delivery loop down with it (it would die silently and the actor would go deaf). */
  private report(e: HostError): void {
    try {
      this.onError(e);
    } catch {
      /* the handler is the caller's; there is nobody left to tell */
    }
  }
  private readonly core: CoreClient;
  private readonly opts: { pollMs?: number; holder?: string; leaseMs?: number; stopTimeoutMs?: number };
  /** Names this host process to Core. Give a stable one to a service that restarts, so the restart renews its own lease instead of waiting for it to expire. */
  readonly holder: string;
  private readonly leaseMs: number;

  constructor(core: CoreClient, opts: { pollMs?: number; holder?: string; leaseMs?: number; stopTimeoutMs?: number } = {}) {
    this.core = core;
    this.opts = opts;
    this.holder = opts.holder ?? `host-${randomUUID().slice(0, 8)}`;
    this.leaseMs = opts.leaseMs ?? 30_000;
  }

  /** A call a harness makes as its actor. The two calls that consume the inbox carry this host's holder, so a harness that reads its own inbox is not fenced out by its own lease. */
  private call(actor: string, op: string, args: Args): Promise<unknown> {
    return this.core.call(actor, op, op === "inbox" || op === "ack" ? { holder: this.holder, ...args } : args);
  }

  /** Take or renew the lease on an actor's inbox. Another live host for the same actor makes this throw `already-hosted`. */
  private async lease(e: Entry): Promise<void> {
    const l = (await this.core.call(e.actor, "host-lease", { holder: this.holder, "ttl-ms": this.leaseMs })) as { expiresAt: number };
    e.leaseUntil = l.expiresAt;
  }

  async add(o: { actor: string; harness: Harness; name?: string; skills?: string[] }): Promise<void> {
    if (this.entries.has(o.actor)) throw new Error(`already-hosted: ${o.actor}`);
    await this.core.call(o.actor, "actor", { name: o.name ?? o.actor, ...(o.skills ? { skills: o.skills.join(",") } : {}) });
    const entry: Entry = { actor: o.actor, harness: o.harness, recovered: false, failures: 0, leaseUntil: 0 };
    await this.lease(entry); // refused if another host is live for this actor; nothing is registered then
    this.entries.set(o.actor, entry);
    if (this.running && !entry.looping) this.loops.push(this.loop(entry));
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
    let stepFailed = false;
    if (Date.now() > e.leaseUntil - this.leaseMs / 2) await this.lease(e);
    const holder = this.holder;
    const summary = (await this.core.call(actor, "inbox", { holder })) as InboxSummary[];
    for (const s of summary) {
      if (s.unread === 0 && !(first && s.pending > 0)) continue;
      const detail = (await this.core.call(actor, "inbox", { context: s.context, holder })) as InboxDetail;
      steps++;
      try {
        await e.harness.step(this.makeStep(actor, detail));
        e.failures = 0;
      } catch (error) {
        e.failures++;
        stepFailed = true;
        this.report({ actor, context: s.context, error });
        continue; // no ack: the same events are delivered again
      }
      const last = detail.events.at(-1)?.seq;
      if (last === undefined) continue;
      await this.core.call(actor, "ack", { context: s.context, seq: last, holder });
      // What the step itself wrote sits right after `last`; skip past it, but never past anyone else's event.
      const rest = ((await this.core.call(actor, "inbox", { context: s.context, holder })) as InboxDetail).events;
      if (rest.length > 0 && rest.every((ev) => ev.actorId === actor)) {
        await this.core.call(actor, "ack", { context: s.context, seq: rest.at(-1)!.seq, holder });
      }
    }
    if (e.harness.poll) {
      steps++; // an attempt, so a failing poll is retried by settle() instead of looking idle
      try {
        steps += await e.harness.poll({ actor, run: (op, args = {}) => this.call(actor, op, args) as never });
        steps--; // handled items replace the attempt; an idle poll is not a delivery
      } catch (error) {
        e.failures++;
        stepFailed = true;
        this.report({ actor, context: "*", error });
      }
    }
    e.recovered = true;
    if (!stepFailed) e.failures = 0;
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
    // An actor whose old loop is still inside a stuck step (stop() gave up on it) keeps that loop: a second one would run two
    // steps of the same actor at once.
    this.loops = [...this.entries.values()].filter((e) => !e.looping).map((e) => this.loop(e));
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const wake of [...this.sleepers]) wake();
    // A step in flight is waited for, but not for ever: a harness stuck in a model call that never answers would otherwise
    // keep stop() (and so close(), which releases the lease) from returning, and a SIGTERM handler would hang until it is killed.
    const limit = this.opts.stopTimeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    const stuck = await Promise.race([
      Promise.all(this.loops).then(() => false),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(true), limit); }),
    ]);
    clearTimeout(timer);
    this.loops = [];
    if (stuck) this.report({ actor: "*", context: "*", error: new Error(`stop-timeout: a harness step did not finish within ${limit} ms; stopping without it`) });
  }

  async close(): Promise<void> {
    await this.stop();
    for (const e of this.entries.values()) {
      await e.harness.close?.();
      await this.core.call(e.actor, "host-release", { holder: this.holder }).catch(() => {}); // best effort: the lease expires anyway
    }
  }

  private async loop(e: Entry): Promise<void> {
    e.looping = true;
    try {
      await this.loopBody(e);
    } finally {
      e.looping = false;
    }
  }

  private async loopBody(e: Entry): Promise<void> {
    const base = this.opts.pollMs ?? 200;
    while (this.running) {
      let didWork = 0;
      try {
        didWork = await this.pump(e.actor);
      } catch (error) {
        e.failures++; // the core is unreachable or refused us: back off, then pick up from the cursor
        this.report({ actor: e.actor, context: "*", error });
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
        const def = opDef(op);
        const a: Args = { ...args };
        n++;
        const stable = `${actor}@${d.context}#${d.cursor}.${n}`;
        if (def?.required.includes("context") || def?.optional?.includes("context")) a.context ??= d.context;
        if (def?.optional?.includes("key")) { if (a.key == null) { a.key = stable; a["derived-key"] = true; } } // derived: a retried step may send other content under it
        else if (def?.mintsId) a.id ??= stable; // starts with "<actor>@": Core reserves such ids for that actor, so nobody can take them first
        return (await this.call(actor, op, a)) as never;
      },
    };
  }
}
