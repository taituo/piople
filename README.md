# piople — protocol first

Multi-agent + multi-user collaboration core. Pi runs agents; piople owns the shared protocol.
OptChat comes last. Order so far: synthetic world → real models → read-only tools → gated writes.

Four concepts: `Actor`, `Context` (kind=case), `Event` (append-only), `Artifact`.
Events today: `context.created, member.joined, message.posted, observation.recorded,
assistance.requested/answered, decision.requested/resolved, action.proposed/executed`.

## Current state

```
src/core/    Store (SQLite, migrations), types — imports only itself + node:*
src/agents/  loop.ts (turn: read context → gateway → write back),
             tools.ts (read-only kubectl allowlist), executor.ts (gated writes)
src/http/    server.ts (node:http JSON + SSE, same rules as the core)
test/        synthetic, tools (allowlist), approval (gate), runs (ledger)
scripts/     run-case.ts — unified runner, see --help-ish args in file
data/        live DBs; data/archive/ — frozen V1–V3 runs, keep readable, don't write
```

Needs Node >= 22.19 (`/opt/opencode-go-node/bin` on this host).

```sh
npm install
npm test && npm run typecheck
node scripts/run-case.ts --db ./data/case.sqlite --case case-checkout-2 --rounds 3
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
- Remaining Pi work: Durable `Harness` for persistent conversations (B2);
  the turn loop still rebuilds context from our events each call.
