/** Piople V0 protocol types. Four concepts only: Actor, Context, Event, Artifact. */

export type Id = string;

export type ActorKind = "human" | "agent";
export type Actor = {
  id: Id;
  kind: ActorKind;
  name: string;
};

export type ContextKind = "case";
export type Context = {
  id: Id;
  kind: ContextKind;
  title: string;
  goal: string;
  createdAt: number;
};

export type Membership = {
  contextId: Id;
  actorId: Id;
  /** Capability list, enforced at the boundary. V0: read | write | decide */
  capabilities: string[];
  joinedAt: number;
};

export const EVENT_TYPES = [
  "context.created",
  "member.joined",
  "message.posted",
  "observation.recorded",
  "assistance.requested",
  "assistance.answered",
  "decision.requested",
  "decision.resolved",
  "decision.expired",
  "action.proposed",
  "action.executed",
  "presence.changed",
  "observation.promoted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type PiopleEvent = {
  seq: number;
  ts: number;
  type: EventType;
  contextId: Id;
  actorId: Id;
  /** Idempotency key supplied by the caller. Replays return the original event. */
  key: string;
  data: Record<string, unknown>;
};

export type ObservationStatus = "hypothesis" | "confirmed" | "refuted";
export type ArtifactKind = "finding" | "decision" | "result" | "card" | "proposal";
export type Artifact = {
  id: Id;
  contextId: Id;
  kind: ArtifactKind;
  authorId: Id;
  text: string;
  status: ObservationStatus | null;
  evidence: string[];
  createdAt: number;
};

export type DecisionStatus = "open" | "resolved" | "expired";
export type Decision = {
  id: Id;
  contextId: Id;
  question: string;
  options: string[];
  requestedBy: Id;
  decidedBy: Id | null;
  answer: string | null;
  status: DecisionStatus;
  createdAt: number;
  resolvedAt: number | null;
  /** After this time the decision can no longer be taken: silence is never consent. */
  expiresAt?: number | null;
};

export type PresenceState = "active" | "away" | "silent";
export type Presence = {
  actorId: Id;
  state: PresenceState;
  /** echo: away human whose delegate may answer questions, but never decide. */
  echo: boolean;
  updatedAt: number;
};
