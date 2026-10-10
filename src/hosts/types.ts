import type { InboxDetail, Pending } from "../core/index.ts";
import type { Args } from "../ops.ts";

export type { CoreClient } from "../ops.ts";

/** One delivery to a harness: what is new in one context, and what is owed. */
export type Step = {
  actor: string;
  context: string;
  /** The cursor this delivery started from. Stable across retries of the same delivery. */
  cursor: number;
  /** Events after the actor's cursor, all actors, own included. */
  events: InboxDetail["events"];
  pending: Pending;
  /**
   * Run an op as this actor. `context` defaults to this step's context. Missing idempotency
   * keys/ids are derived from (actor, context, cursor, call number), so if the step is retried
   * after a partial failure the same calls replay instead of duplicating.
   */
  run<T = any>(op: string, args?: Args): Promise<T>;
};

/**
 * The participation contract. A harness turns what is new into protocol actions.
 * Delivery is at-least-once: the cursor moves only after step() returns.
 * A harness owns its private state (conversation, memory); Core owns identity, membership,
 * authorization and history.
 */
export interface Harness {
  step(s: Step): Promise<void>;
  /**
   * For participants whose work is not announced in their inbox (a router reads a queue it is not a member of).
   * Called on every host pass; returns how many items it handled. A throw counts as an attempt and is retried.
   */
  poll?(api: PollApi): Promise<number>;
  close?(): Promise<void> | void;
}

/** What poll() may do: run ops as its own actor. Callers make their own calls idempotent. */
export type PollApi = { actor: string; run<T = any>(op: string, args?: Args): Promise<T> };
