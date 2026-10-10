# Plan: what remains

State: the protocol core, CLI/MCP/HTTP, Host and harnesses (synthetic, Pi, router), realms and channels, routing
with the Jev classifier, and the routing evaluation are merged. This file plans the rest. It is a plan, not code:
every item names what it needs, how it should work, and the test that says it is done. Nothing here is built.

Principles that every item must keep (they are why Core stays small):

- Core owns identity, membership, authorization, event history. Harnesses and runtimes own execution and private state.
- A classifier, a model, a tool or an orchestrator suggests or executes; Core judges with the *sender's* authority.
- Optional things (Pi, Kubernetes, Temporal, SDKs) live in their own files and are optional dependencies.
- A claim is only as good as its test. "Not covered" stays written down until it is covered.

## Order

| # | Item | Needs | Why this place in the order |
| - | --- | --- | --- |
| 1 | Call the real Jev | operator: network, key, model id | Turns the biggest assumption (the request shape) into a fact |
| 2 | A real routing dataset | operator: real messages | Without it `minConfidence` cannot be chosen |
| 3 | Decide the environment plan | operator: 8 decisions | Blocks 6 and 9 |
| 4 | Member removal | nothing | Core hygiene; also needed by 6 and 8 |
| 5 | One host per actor | nothing | Prevents double processing before anything runs at scale |
| 6 | Urgency and direct TypeSafe | the official API page | Only after the shape is verified |
| 7 | Environments, process level (E1) | decision 3 | First time an agent has real tools |
| 8 | OptChat memory | nothing | The original centre of the project; independent of the rest |
| 9 | Kubernetes and Temporal (E2, E3) | decision 3, a cluster | Last: builds on 5 and 7 |
| 10 | Push, signed identity, rate limits | nothing | When load or exposure calls for it |
| 11 | Human harness | nothing | Ergonomics; the CLI already covers participation |

Items 4, 5 and 8 can start today and do not depend on each other.

## 1. Call the real Jev

Needs: `openrouter.ai` (and/or `api.typesafe.ai`) in the environment's allowed domains; `OPENROUTER_API_KEY` or
`JEV_API_KEY`; an exact `JEV_MODEL`. Never paste the key into chat: it goes in the environment settings.

Steps: run `npm test` (the live test `test/jev.live.test.ts` stops being skipped); fix whatever the real service
disagrees with in `src/harnesses/jev.ts` (request shape, where `confidence` lives, limits); keep the fake
(`test/fake-jev.ts`) in step with what is learned. Record latency and cost per call.

Done when: the live test passes against the real service, and any difference found is reflected in the fake and in
a test of its own.

## 2. A real routing dataset

Needs: real messages from the operator, each with the destination a person would pick (or `null`: "stays unrouted"),
for realms, channels and senders as they really are. Privacy: the dataset is shown to the classifier, so building it
from private realms is the operator's decision (`--send-to-external`).

Steps: write the dataset in the format of `eval/routing-synthetic.json`; run `node src/eval/main.ts --dataset ...`
with the keyword baseline and with Jev; choose the target precision for the cost of a wrong delivery (a message in
the wrong channel is worse than an unrouted one); read the suggested `minConfidence` only when the report says
*confident*. Collect more data until it does.

Done when: a threshold exists whose 95% lower bound reaches the target, and shadow mode has run on live traffic long
enough to compare against what people actually chose. Only then switch `mode` to `enforce`.

## 3. Decide the environment plan

Needs: answers to the eight decisions in the design document "Piople: ympäristöt ja orkestrointi"
(https://claude.ai/code/artifact/33bff5db-7ef8-4815-a363-b86ebb3c36e8, section "Riskit ja avoimet päätökset"). The
recommendations there stand unless overruled: launcher by configuration and delay (no host registry in Core);
environment stays in operator configuration (Core never trusts a declaration); expiring tokens before Kubernetes;
Temporal as orchestrator only; durable Pi state only for long-lived agents; first tool read-only and confined; a
cluster (kind or k3d) for tests; real-model run once the key exists.

## 4. Member removal

Goal: a member can be removed from a context or realm, immediately and visibly. Today membership can only be added or lowered.

Design:
- Op `leave` (my own membership) and `remove-member` (needs `decide`). Event `member.removed`, idempotent by key.
- Never remove the last member holding `decide` (an orphaned context nobody can govern): refused with `forbidden`.
- Removing someone from a **realm** removes their memberships in that realm's contexts in the same transaction, with
  a `member.removed` event in each (reason `realm-removed`). Otherwise re-adding them to the realm would silently
  restore old context roles.
- Work they hold in that context is reopened (`attempt` kept) so it is not stranded behind a refused `complete`.
- Their cursor in that context is dropped. Identity, tokens and presence are untouched: membership is not identity.
- Ingress contexts and routers are not members; routing is unaffected.

Done when tests show: access ends at once (read, write, inbox, targets); the last-decider rule; realm cascade with
per-context events; held work reopens and can be claimed by someone else; replay is idempotent; a non-decider gets
403 over HTTP; a removed member's old routed messages and history stay readable by others.

## 5. One host per actor

Goal: two hosts cannot both consume the same actor's inbox, so nothing is processed twice. Today the rule is "one
replica per actor", enforced by nothing.

Design: a lease in Core. Table `host_leases(actor_id, holder, epoch, expires_at)`. Op `host-lease --holder <id>
--ttl-ms N` acquires or renews; a different holder gets `already-hosted` until the lease expires or is released.
While a lease is live, only its holder may call `inbox` and `ack` for that actor (`--holder` is then required);
those are the two calls a host consumes with. Writes made through `step.run` stay allowed: they are idempotent by
key. Host acquires at `add`, renews every pass, releases at `close`. An actor without a lease (a CLI human) behaves
as today. A takeover bumps `epoch`; the old holder's `ack` is refused (fencing), so a paused host that wakes up
cannot move the cursor.

Done when: a second host for the same actor is refused while the first is live; it takes over after the TTL or after
release; a stale holder's `ack` is refused; `settle()` and the restart tests still pass; HTTP maps `already-hosted` to 409.

## 6. Urgency and direct TypeSafe access

Blocked on verifying the request shape of the `score` question and of direct access from TypeSafe's own docs
(`docs.typesafe.ai`, blocked by the network policy here). Do not guess either.

Design once verified: ask `urgency` as `score` over at most 10 ordered levels in the same call; record it in
`route.classified.extras`; measure it in the evaluation before anything acts on it (no behaviour change in the first
version). Direct access either as another `endpoint` preset or, if the SDK is needed, in its own file with the SDK as
an optional dependency (like Pi), so the harness stays dependency-free.

Done when: the fake server follows the documented shape, a test pins it, and the live test covers it.

## 7. Environments, process level (E1)

Goal: an agent's real abilities are fixed by its environment, not by the skill it declares. First time a harness has a
real tool, so first time enforcement matters.

Verified here (Node 22.22): the permission model (`--experimental-permission`, `--allow-fs-read=<dir>`) denies reads
outside the directory (`ERR_ACCESS_DENIED`) and denies child processes, but does **not** restrict the network.
So at process level a file profile can be enforced, a network profile cannot; that waits for E2 (containers, network
policy).

Design:
- `EnvironmentProfile` is operator configuration, outside Core: files (root, read-only or read-write), allowed tools,
  secrets, model provider. Core never stores or trusts it.
- A tool runs in a child process started with the permission flags for its profile and a **whitelisted environment**
  (no token, no keys). Results come back over stdio. The model never sees credentials.
- First tool: read-only file reading confined to one directory. `PiHarness` gets a `TOOL: <name> | <json>` command; a
  refusal goes back to the model as feedback, like `REFUSED` today.
- Rule from the plan: a harness that uses tools needs at least its own process; synthetic agents and humans may share one.

Done when (gate 1 of the plan): a tool that tries to read outside its directory is stopped by the runtime, not by
our code; the token and keys are absent from the child's environment and from the model's context; the same agent
works with and without the tool; tests cover the denial.

## 8. OptChat memory

Goal: long-lived agents remember a long history without carrying all of it, and can go back to the detail.

Design:
- A derived, rebuildable memory beside a harness, in its own store (`memory.sqlite`), never in Core. Source of
  truth stays the events and the harness transcript.
- A tree: recent messages verbatim; older ones summarised in chunks of K; summaries of summaries above that.
- `memory_zoom(node)` returns a node's children or the original text it summarised. In `PiHarness`: a `ZOOM: <id>`
  command and a prompt that shows the tree down to a token budget.
- A `Summarizer` interface (fake deterministic one for tests, a cheap model later), like `Classifier`.
- **Decisions and obligations never live only in a summary.** Open decisions, asks and work come from Core's `pending`
  on every step, and decided facts are quoted as events, not paraphrased.

Done when: after a long history the prompt stays within the budget; zooming returns the exact original text of a
summarised segment; rebuilding from the events gives the same tree for the same summarizer; a planted fact at a
chosen depth can be found by zooming; a decision made long ago is still visible verbatim. Quality with a real model
is measured separately, as routing is, not assumed.

## 9. Kubernetes and Temporal (E2, E3)

Needs: decision 3 and, for tests, a cluster (kind or k3d) and a Temporal test server. Both adapters are optional
dependencies in their own files; Core, Host and the harnesses do not change.

- **Kubernetes:** a *launcher* is an ordinary participant (`agent:launcher`, `read` only) that finds work no live host
  will take (configuration skill -> profile, plus a delay) and creates a Job whose name is derived from the work id
  (Kubernetes refuses a duplicate name). It is the only component with cluster permissions. One pod per environment
  profile; long-lived agents as one-replica Deployments with `Recreate`; default-deny egress except Core and the model
  endpoint; a Secret per pod; expiring tokens issued by a provisioning step, never by the launcher.
- **Temporal:** an orchestrator only. Workflows decide progression and stay deterministic; Activities call Piople
  (`requestWork`, `awaitWork`, `requestDecision`) with ids derived from workflow and activity ids, so a retry replays
  in Core instead of duplicating. Executors stay Piople agents. Temporal-directed work is addressed to a named actor
  the launcher ignores, so two orchestrators never start the same work.

Done when (gates 2 and 3): the same test task runs locally, in a pod and under a Temporal workflow with no change to
Core; a pod is killed mid-work and the work finishes once; network policy blocks traffic it should; a workflow worker
is killed mid-run without duplicating work.

## 10. Push, signed identity, rate limits

When load or exposure calls for them, not before.
- **Push:** `GET /v1/inbox/wait` (long-poll) or SSE, so hosts stop polling every 200 ms. `HttpCore` uses it when present.
- **Signed identity:** per-actor Ed25519 key pairs; Core stores only the public key; requests are signed over method,
  path, body hash, timestamp and a nonce, with a replay window. Removes the shared secret from Core.
- **Rate limits:** a per-token bucket in the server, with `429` and `Retry-After`.
- **Multi-node Core:** not planned. SQLite is a single writer by design; a different store would be a different project.

## 11. Human harness

A continuously running participant for people: `piople watch --as human:x` shows new events and pending asks and
decisions and lets the person answer, through a `Console` interface (stdin/stdout adapter; scripted in tests). No
model, same rules: deciding still needs `decide` in the context.

Done when: a scripted console resolves a decision as a human actor, a synthetic actor cannot do the same by naming
itself human, and the CLI one-shot commands behave as before.

## Known limits to keep in mind

- A participant that omits `--after` on `submit` starts a new hop chain; the 100-waiting-messages cap is the backstop.
- A router sees every unrouted message (inherent to the role); the operator chooses who is one.
- Messages submitted during shadow mode stay undelivered when the router is switched to enforce.
- Nothing has run on two physical machines or in a cluster; remote processes were tested over localhost.
- No real model and no real Jev call has been made from this environment.
