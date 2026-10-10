# Handover

Written for whoever picks this up next (a person or an agent), without access to the conversation that produced
it. Read this first, then `README.md` (how it works and how to use it) and `PLAN.md` (what to do next).
Everything below was checked against the code and the tests on the day it was written (2026-10-10).

## 1. In one minute

**Piople is a protocol for shared participation, not an agent runtime.** Humans, AI agents and synthetic
participants take part in the same collaboration through the same small core: identities, membership,
capabilities, an append-only event history, work routing, and automatic message routing. Runtimes (Pi agents,
the CLI, MCP clients, Kubernetes pods later) own their execution and private state; the core owns who may do what
and what happened. There is no UI by design.

State: protocol core, CLI, MCP (local and remote), HTTP, Host with harnesses (synthetic, Pi, router), realms and
channels, routing with a Jev classifier, and a routing evaluation tool are **merged into `master`**. 94 tests pass, 1 is
skipped (the live Jev test), `npm run typecheck` is clean. No real model and no real Jev call has ever been made
from the environment this was built in; that, and a real routing dataset, are the main things still missing.

## 2. Where everything is

| What | Where |
| --- | --- |
| Code | github.com/taituo/piople, default branch `master` (there is no `main`) |
| Merged work | PR #1 (protocol core, CLI/MCP/HTTP, Host, Pi, synthetic) and PR #2 (realms, channels, routing, Jev, eval) |
| Branch with the plan and this file | `claude/followups` (not merged, no PR). The older `claude/friendly-bell-vyeprp` is fully merged and can be deleted |
| What to do next | `PLAN.md` (11 items in dependency order, each with what it needs and the test that says it is done) |
| Environment/orchestration design (Kubernetes, Temporal, profiles) | Claude Docs page "Piople: ympäristöt ja orkestrointi", https://claude.ai/code/artifact/33bff5db-7ef8-4815-a363-b86ebb3c36e8 . Contains 8 open decisions that block PLAN items 7 and 9 |
| Where the idea came from | `start.md` (234 KB ChatGPT conversation) and the author's earlier project `taituo/entropi`. History of the first version is in git up to `c5a5b16` (agents, kubectl tools, executor, old HTTP server, run scripts; removed on purpose) |
| Reference implementation of a Jev client | github.com/felpsdev/jev-classifier (MIT). It was cloned read-only into `/home/user/felpsdev/` in the build environment; that clone is not part of this repo and will not exist elsewhere |

## 3. Running it (five minutes)

Needs Node >= 22.19 (built on 22.22; `node:sqlite` and native TypeScript type stripping). `npm install` pulls TypeScript
and the optional Pi packages (pinned 1.0.4; only `src/harnesses/pi.ts` imports them).

```sh
npm install && npm test && npm run typecheck          # 94 pass, 1 skipped

alias piople='node --no-warnings src/cli/main.ts --db ./data/p.sqlite'
piople --as human:alice create --kind realm --id realm-infra --title Infra
piople --as human:alice create --kind channel --realm realm-infra --id ch-incidents --title "Production incidents"
piople --as human:alice submit --text "production servers keep crashing"      # waits in alice's ingress
node src/cli/admin.ts --db ./data/p.sqlite add-router --actor agent:router    # the operator designates routers
node src/cli/admin.ts --db ./data/p.sqlite issue-token --actor agent:fetch --ttl-ms 3600000
PIO_DATA=./data/p.sqlite PIO_PORT=8899 node src/http/main.ts                  # Core over HTTP, binds 127.0.0.1
node src/eval/main.ts                                                         # routing evaluation, keyword baseline
```

Every operation is in one table (`src/ops.ts`) and reachable through CLI (`piople <op> --arg value`), MCP (tools
`piople_<op>`) and HTTP (`POST /v1/ops/<op>`). `piople help` lists them. Tests spawn real processes and listen on
ephemeral ports; they are written to be deterministic (all pass on repeated runs), but they do need to be able to
open sockets and spawn `node`.

## 4. Map of the code

```
src/core/      Store (SQLite, migrations, every rule) + types. Imports only itself and node:*.   ~1,060 lines
src/ops.ts     the one operation table; the caller's identity is fixed by the process, never an argument
src/cli/       main.ts (one process = one op, JSON out), admin.ts (operator: tokens, routers)
src/mcp/       stdio JSON-RPC, no SDK; local (database file) or remote (PIO_CORE_URL + PIO_TOKEN)
src/http/      server.ts (identity = bearer token), client.ts (HttpCore: safe retries), main.ts (entry)
src/hosts/     Harness contract + Host (one process, many participants) + CoreClient seam (LocalCore / HttpCore)
src/harnesses/ synthetic.ts (no model), pi.ts (Pi agent), router.ts (routing + Classifier), jev.ts (Jev classifier)
src/eval/      routing evaluation: labelled messages -> measured thresholds
eval/          routing-synthetic.json (35 authored messages; says nothing about real traffic)
test/          one file per area + fake-model.ts / fake-jev.ts (local stand-ins for the model and Jev endpoints)
```

`test/boundaries.test.ts` enforces the layering: Core imports only itself and `node:*`; CLI/MCP/HTTP/ops/hosts do
not import harnesses; `@earendil-works/*` (Pi) is imported only by `src/harnesses/pi.ts`.

## 5. The model

**Actor** (`human:x` / `agent:x`) has an identity, optional self-declared `skills` (routing hints, never permissions)
and optional bearer tokens. **Context** is the unit of membership and history; its `kind` is `case`, `channel`, `realm`
or `ingress`. **Membership** gives capabilities `read | write | decide`. **Event** is append-only (SQLite triggers)
and idempotent by `(context, key)`. Work, decisions, observations, assistance requests and routing records are all
events plus small side tables.

Tables, by migration (`src/core/store.ts`, `MIGRATIONS`): 1 actors/contexts/members/events/artifacts/decisions;
2 `runs` and 3 `pi_convs` (legacy, unused, kept so old databases migrate); 4 presence; 5 read cursors;
6 skills + work; 7 tokens (hash only); 8 token expiry/last use; 9 realms/channels (`realm_id`, `parent_id`);
10 routers, `route_queue`, indexes. **Edit an old migration only if it was never released**; migration 10 was edited in
place before it was merged, nothing after that should be.

Event types: `context.created member.joined message.posted observation.recorded observation.promoted
assistance.requested assistance.answered decision.requested decision.resolved action.proposed action.executed
presence.changed work.requested work.claimed work.completed work.failed message.submitted route.classified
route.resolved route.shadowed route.unresolved`.

Ops: `actor create targets join events inbox ack work-request work-claim work-complete work-fail submit
route-pending route-targets route-classified route-resolve route-unresolved post observe promote ask answer
decision-request decide presence`. Not ops, by design: minting tokens and designating routers (`src/cli/admin.ts`,
operator with database access).

## 6. Rules that must not be broken

These are the reasons the core can be trusted. Each has a test; do not weaken a test to make a change pass.

1. **One write path.** Every mutation goes through `Store.mutate`: one `BEGIN IMMEDIATE` transaction doing check,
   idempotency lookup, side-table writes and event insert. Replays return the original event; the same key for another
   operation or actor is `key-conflict`; a failed write leaves nothing behind.
2. **Authorization before replay.** `replayFirst` lets an actor get its own earlier event back, but any op that has an
   authorization gate (`mustRouter`) runs it *before* the replay lookup. Otherwise a non-router gets a misleading `key-conflict`.
3. **The realm is the upper bound.** Effective capabilities = own capabilities cut down to the realm role, computed in
   `caps()` at every access, not only at join. Realm membership does not confer channel membership.
4. **Joining is granted, never taken**: the granter needs `decide` and cannot grant more than it holds, nor more than
   the target holds in the realm.
5. **Routing delivers as the sender.** `route-resolve` posts as the sender and only where the sender may write, so a
   router and the classifier behind it can never reach a place the sender cannot. A refused route records nothing and
   the message stays pending. The router cannot alter the text.
6. **Identity is the credential, nothing else.** The HTTP server derives the actor from the bearer token only; no
   argument can name another caller. Tokens are stored as hashes, can expire and be revoked.
7. **Privacy by default for external classifiers.** An external classifier is offered only targets in
   `external.allowRealms` (default none: nothing leaves, no request is made). Only the message text is sent.
8. **`route.resolved` always means delivered.** Shadow mode records `route.shadowed`; a message ends exactly once.
9. **Nothing invented**: `minConfidence` is a required option and the evaluation says "not yet confident" or "no
   threshold reaches the target" instead of suggesting one. The Jev model id has no default and is recorded with
   every decision.
10. **A configuration error never turns messages into unresolved ones.** Wrong key or outage keeps them pending;
    only a message the classifier keeps rejecting is given up on, after `maxAttempts`.
11. **Reserved names**: ids starting `ingress:` and submit keys starting `resolved:`, `shadowed:`, `unresolved:`,
    `classified:` belong to Core and the router.

## 7. How the main flows work

**A message gets routed.** `submit` puts `message.submitted` in the sender's ingress (`ingress:<actor>`, created by Core)
and a row in `route_queue`. `RouterHarness.poll` reads `route-pending`, asks `route-targets` for what the sender may
address (the only thing a classifier ever sees), filters for external classifiers, classifies (reusing a classification
recorded before a crash), records `route.classified`, then `route-resolve` (enforce: delivered as the sender;
shadow: `route.shadowed`) or `route-unresolved` with a reason (`no-targets`, `no-permitted-targets`, `no-choice`,
`invalid-choice`, `low-confidence`, `needs-human`, `too-many-options`, `classifier-error`, `invalid-route`). All
records are events in the sender's ingress, so the sender can see what happened.

**A host delivers.** `Host` polls each actor's `inbox`, calls `harness.step` when others have written (or once after
start when something is still owed), and acks after success: at-least-once. Calls made through `step.run` get keys derived
from `(actor, context, cursor, call number)`, so a retried step replays instead of duplicating. A harness may also
implement `poll` (the router does, since its queue is not an inbox).

**Work is claimed atomically.** `work-claim` bumps `attempt`; completion must present the attempt it was given, so a
replaced claimant gets `stale-claim`. The same holder claiming again gets its live claim back. Leases are optional.

**Remote processes.** `HttpCore` fixes an idempotency key/id before the first attempt, so a retry after a lost response
replays on the server. `work-claim --next` is the one op never retried blindly (a lost claim shows up under `work.mine`).

## 8. Decisions and why

| Decision | Why |
| --- | --- |
| Core is one SQLite file with one write path | Correctness is checkable in one place; concurrency is `BEGIN IMMEDIATE` + `busy_timeout` |
| Realm and channel are context kinds, not new tables | They share events, membership, inbox and cursors; Core grew two columns |
| Routing is a participant (router harness), Core only judges | Models stay out of the core; the classifier can be replaced (keyword, Jev, a local model) |
| Delivery as the sender | Makes "the classifier never grants rights" structural, not a promise |
| Shadow mode has its own event | Keeps `resolved` = delivered; shadow-period messages are not replayed on enforce |
| Pi, SDKs, Kubernetes, Temporal are optional, in their own files | Core, CLI, MCP, HTTP, Host stay dependency-free |
| No UI | CLI, MCP and future UIs are ergonomics, not participation models |
| Plans go in documents, not code | The author's preference for design work (see section 11) |

## 9. What is verified and what is not

Verified by tests: everything in section 6; 16 concurrent writer processes; 8 processes racing for 3 jobs (one winner each);
a Core process killed with SIGKILL mid-work and restarted (the worker finishes the same claim once); a mixed world of 2 Pi
agents + 2 synthetic agents + a human on real CLI processes with a mid-run restart; remote MCP; routing end to end;
Jev request/response handling against a local stand-in.

**Not verified (do not assume):**
- **No real model call** and **no real Jev call** has been made. The Pi tests run the real Pi runtime against a
  deterministic OpenAI-compatible fake (`test/fake-model.ts`); the Jev tests run against `test/fake-jev.ts`, which follows the
  request/response shape of felpsdev/jev-classifier. `test/jev.live.test.ts` is the first check against the real service
  (it needs a key and an exact model id; it is skipped otherwise).
- Remote processes were only tested over localhost, never on two machines or in a cluster.
- The synthetic routing dataset was written together with the keyword baseline; its numbers say nothing about real traffic.
- Urgency (`score`) and direct TypeSafe access are not implemented because their request shapes could not be verified
  (`docs.typesafe.ai` was unreachable). Do not guess them.

## 10. Tooling and environment quirks

- **Node runs `.ts` by stripping types.** Anything that needs a transform fails at runtime although `tsc` passes:
  constructor parameter properties, enums, namespaces. `tsconfig.json` sets `erasableSyntaxOnly` so `tsc` catches them.
  Imports need the `.ts` extension.
- **Set `busy_timeout` before `journal_mode=WAL`** (concurrent processes otherwise fail with "database is locked" on open).
- `node:sqlite` prints an experimental warning; scripts use `--no-warnings`.
- **Pi packages are pinned to 1.0.4.** Known quirks are handled in `pi.ts`: control-token leakage is stripped, a failed model
  call surfaces as `stopReason: "error"` (and Pi deduplicates a repeated request id, so a retry needs a fresh one).
- **The Node permission model** (`--experimental-permission`, `--allow-fs-read`) confines file reads and child processes
  but **not the network** (checked on Node 22.22). Relevant for PLAN item 7.
- The build environment was a cloud container with an egress allowlist: `openrouter.ai`, `api.typesafe.ai`, `docs.typesafe.ai`
  and most blog/docs hosts were blocked; GitHub was reachable only through the git proxy and the GitHub MCP tools
  (scoped to this repository). A connected `opencode.ai` host answers `GET /v1/models` but returned "Missing API key" for
  POST; no credential was available. If you are in the same kind of environment, add the hosts you need under Allowed domains.
- **Secrets**: none are in the repo or in git history. Keys belong in the environment's settings, never in chat or files.
- Commits in this project end with `Co-Authored-By` and `Claude-Session` trailers; PR bodies end with the Claude Code line.

## 11. Working with the author

- Language: Finnish in conversation; code, comments, commit messages and docs in English.
- Wants **the core kept tight** ("ydin tiukkana"): no model calls, tool execution or orchestration in Core.
- Plans and designs go in a **document, not code**, when asked ("paperille, ei koodiksi").
- Merges are the author's call and are done only when asked explicitly ("laita vaan merge"); never open a PR unprompted.
  After a PR is merged, follow-up work goes on a fresh branch from `master`.
- Prefers honesty about what is unproven over a green summary; large or ambiguous choices are put to the author first.
- Reviews are worth running before a PR: the two code reviews done here found real bugs both times (see section 12).

## 12. Bugs found the hard way (do not reintroduce)

`busy_timeout` after WAL; replay of a failed decision write left orphan rows (now one transaction); replayed presence keys
reverted newer state; `HttpCore` retried `work-claim --next` blindly; a failed model call looked like an empty answer and
was memoized; the router's authorization ran after the replay lookup (misleading `key-conflict`); ingress ids could be
squatted (`create --id ingress:<victim>`); routed work ids collided for keys differing only by punctuation; shadow results
were shown as routed; polling cost grew with history (now `route_queue`); one permanently rejected message could starve the
queue; eval latency was matched by text instead of submission id; `revokeTokens` counted expired tokens; MCP blocked
`initialize` behind a slow remote call.

## 13. What to do first

1. `npm install && npm test && npm run typecheck` and read `README.md`; confirm the numbers in section 1.
2. Read `PLAN.md`. Items 4 (member removal), 5 (one host per actor) and 8 (OptChat memory) need nothing from anyone and
   do not depend on each other; item 5 is the smallest meaningful Core change.
3. Ask the author for what only they can provide: network access and a key for Jev (`OPENROUTER_API_KEY`, `JEV_MODEL`, an
   allowed `openrouter.ai`), a real routing dataset, and answers to the 8 decisions in the design document (they unblock
   Kubernetes/Temporal and environments).
4. When Jev can be called: run the live test, fix the stand-in to match, then measure with `src/eval` before enforcing.

## 14. Known limits

A participant that omits `--after` on `submit` starts a new hop chain (the 100-waiting-messages cap is the backstop). A router sees every
unrouted message (inherent to the role; the operator chooses who is one). Nothing prevents two hosts serving one actor
(PLAN item 5). Members cannot be removed, only lowered (PLAN item 4). The original centre of the project, the OptChat memory,
is not built (PLAN item 8).
