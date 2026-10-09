# piople — protocol first

Multi-agent + multi-user collaboration core. Pi runs agents; piople owns the shared protocol.
OptChat comes last. Order so far: synthetic world → real models → read-only tools → gated writes.

Four concepts: `Actor`, `Context` (kind=case), `Event` (append-only), `Artifact`.
Events today: `context.created, member.joined, message.posted, observation.recorded,
assistance.requested/answered, decision.requested/resolved, action.proposed/executed`.

## Current state

```
src/core/    Store (SQLite, migrations), types — imports only itself + node:*
src/agents/  loop.ts (turn edge: read case → Pi conversation → post reply),
             pi-tools.ts (Pi extension: k8s, repo, observe, propose),
             durable.ts (one durable Pi conversation per context+actor),
             tools.ts (read-only allowlists), executor.ts (gated writes)
src/http/    server.ts (node:http JSON + SSE, same rules as the core)
test/        synthetic, tools (allowlist), approval (gate), runs (ledger),
             agent (Pi tool loop with a scripted faux model, offline)
scripts/     run-case.ts — unified runner, see --help-ish args in file
data/        live DBs; data/archive/ — frozen V1–V3 runs, keep readable, don't write
```

Needs Node >= 22.19 (`/opt/opencode-go-node/bin` on this host). CI runs `typecheck` + `test`;
the live-cluster test skips itself when no `demo-apps` cluster is reachable.
Gateway bearer: `PIO_GATEWAY_BEARER`, or the file in `PIO_BEARER_FILE`.

```sh
npm install
npm test && npm run typecheck
node scripts/run-case.ts --db ./data/case.sqlite --case case-checkout-2 --rounds 3   # needs the gateway
PIO_PORT=8899 PIO_DATA=./data/piople.sqlite node src/http/server.ts
```

Models via host gateway `http://10.91.1.1:8788/v1` (bearer `gateway-bearer`,
27 models, `x-session-id` per conversation). Default cheap `deepseek-v4-flash`,
harder calls `gpt-5.6-luna`. Every run lands in the `runs` table
(model, tokens in/out, tool calls, proposals, outcome) — that table, not the
console log, is the history.

Rules: membership + capability checked at the boundary (`read|write|decide`);
every mutation takes an idempotency `key`, replays return the original event;
`events` append-only (triggers); creator auto-joins; proposals never execute —
`executor.ts` runs only on decision `yes` AND `PIO_ALLOW_WRITE=1`, and records
every refusal. Identity header `x-piople-actor` is trusted dev-only
(`PIO_TEST_USER`); verified identity is phase E work.

## History (frozen, DBs in data/archive/)

- **V0**: synthetic 2+2 world, no model. HTTP smoke incl. same-key replay + restart persistence.
- **V1**: two gateway agents, checkout-api restart crash. Without evidence both
  refused to invent a cause. Found live: `observation.recorded` hid content
  (TR-context-loss) → event now carries `text`+`evidence`. With human-posted
  evidence: exact fix proposed (~1.4k+1.2k tokens).
- **V2**: read-only kubectl allowlist; agents fetched `POOL_SIZE=0` themselves,
  converged on the fix with zero human evidence (~5.3k+2.3k tokens).
- **V3**: `PROPOSE:` → proposal + bound decision; 4 proposals
  (`patch checkout-config POOL_SIZE→10`); gate verified refused while open.
  **Not applied — awaiting human approval.**
- **A**: git history from here; unified `run-case.ts`; `runs` ledger;
  `turn:` key prefix. No model calls spent in A.

## Next (B) — DONE: Pi owns transport

- `src/agents/pi-provider.ts`: pi-ai `local`-provider on the same gateway
  (pinned `@earendil-works/pi-ai@1.0.4`, like Entropi). `loop.ts` `chat()`
  goes through `models.completeSimple`; raw `fetch` path deleted.
- Three pi-ai 1.0.4 quirks found by bisecting and worked around in our layer:
  `sanitize()` strips model control-token leakage (`<ds_s>`) before parsing;
  assistant messages sent as `[{type:"text",text}]` blocks (string form
  crashes the converter); `timestamp` omitted (breaks request building).
- Proof: `case-pi-1`, 2 rounds, `deepseek-v4-flash` — 9 tool calls,
  3 well-formed `patch checkout-config POOL_SIZE→10` proposals with bound
  decisions, ledger row `4071+2067` tokens. Tests 7/7, `tsc` clean.
- **H (Durable conversations)**: `src/agents/durable.ts` — one persistent Pi
  conversation per (context, actor) on `openNodeSqliteStorage`, binding in
  `pi_convs` (migration 3). `run-case.ts --durable` sends only the newest
  user message per round; Pi holds the history. Restart proof
  (`scripts/restart-proof.ts`): full close+reopen → same conv id, same
  requestId resubmits without duplicating work (now returns the original
  reply), `JUNIPER` remembered across restart, protocol events intact.
  Full durable run `case-full-1`: 6 tool calls, 2 proposals.
  Lesson: durable convs need the FULL system text at creation
  (`fullSystem()`); bare role prompts drift into meta-chat with zero tool use.
- **Second intent, same core**: `case-review-1` — reviewer+scout reviewed
  `durable.ts`/`loop.ts` via new `repo` read-only tool (roots pinned, escapes
  tested). Reviewer read real code, flagged a real uncertainty, noted its own
  truncation limit. No core changes needed for a new domain.
- **ask_expert** (`scripts/ask-expert.ts`): scout in checkout case consulted
  reviewer in review case. Bounded snapshot over, answer with provenance back.
  Expert explicitly could not see the other history — isolation holds.
  Protocol: invited experts may answer without membership
  (`isInvitedExpert`), strangers still blocked (tested).
- **E (identity + presence)**: `PIO_AUTH_MODE=proxy` — identity only from
  `x-piople-actor`, body spoof rejected (`test/auth.test.ts` spawns the
  server in both modes). `presence` (migration 4, global per actor):
  echo delegates may answer but never decide (enforced in
  `resolveDecision`, live-verified: alice away+echo → blocked, bob decided).
  `observation.promoted` moves hypothesis→confirmed/refuted with provenance.
  Live E3 (alice+bob+scout, no model cost): 10 events, all gates held.
  Tests 12/12.

## C — DONE: first measured world effect (2026-10-09)

- Operator instruction `tee kaikki` taken as approval for the demo-namespace fix.
- Copied `case-full-1` out of archive, resolved its first proposal's decision
  `yes` as human:alice, ran `executeIfApproved` with `PIO_ALLOW_WRITE=1`:
  `configmap/checkout-config patched` (`0→10`).
- Operator (outside the gate, logged): `rollout restart`, `rollout status`
  successful, new pod Running, logs `database pool ready: 10 connections`.
- Verification + proposal promotion recorded back in the case (18 events).
- Revert if ever needed: patch `POOL_SIZE` back, rollout restart.

## F — DONE (minimal): case brief

- `scripts/brief-case.ts`: compacts a context's log into a `result` artifact
  (TAVOITE/VAHVISTETTU/AVOINNA/PÄÄTÖKSET) with event-count provenance.
  Live brief of `case-full-1` was honest about disagreements and missing logs.
- Full OptChat deferred: briefs + digests cover current history sizes.

## G — DONE (minimal): MCP stdio

- `src/mcp/server.ts`: dependency-free JSON-RPC stdio, tools
  `piople_events/post/observe/answer` on the same Store rules.
  Identity from env `PIO_MCP_ACTOR` (no spoof arg); non-member reads rejected.
  Live-smoked incl. the stranger case. Slack/Teams need credentials we don't
  have — left out deliberately.
## Hardening pass (2026-10-09)

No new core concepts; reliability limits only.

- **Atomic mutations**: state change + its event commit in one transaction
  (`Store.tx`, savepoints nest); migrations commit with their version bump.
- **Replays everywhere**: observation/decision/proposal/resolve with a seen key return
  the original event instead of a constraint error.
- **No privilege escalation via join**: HTTP `join` needs a member caller, who can only
  grant capabilities it holds; unknown capabilities rejected.
- **Expert invitations are single-use and request-bound**: an answer must reference a
  real `assistance.requested`; an invited non-member answers only that request, once.
- **Executor trusts the log, not the caller**: runs the stored `action.proposed`, only
  for its bound decision, once after success; refusals/failures never shadow a retry.
- Repo tool roots derive from the checkout (symlinks resolved); HTTP body capped at 1 MiB,
  inputs validated, SSE/`/events` follow the auth mode; MCP ignores notifications.
- **Pi owns the agent loop** (the conversation's own advice: no second harness). The
  `TOOLCALL`/`PROPOSE`/`OBS:` text protocol, the 3-round tool loop and the raw chat path are
  gone. Tools are a Pi extension (`pi-tools.ts`); Pi validates arguments, runs each call as a
  durable replay-safe task and resumes after a crash. Identity is never a tool argument: the
  conversation id resolves to (context, actor) via `pi_convs`, and every tool goes through the
  Store, so rights are enforced there. `test/agent.test.ts` proves it offline with pi-ai's faux
  provider. `run-case.ts` is always durable now (the `--durable` flag is gone).
- Next, per the design conversation: one real task that is not Kubernetes (a real repo + tests),
  two Pi agents + a human, case memory instead of shared channels. No new core concepts until
  that task shows one is missing.
