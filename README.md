# piople V0 — protocol first

Multi-agent + multi-user collaboration core. Pi runs agents; piople owns the shared protocol.
OptChat comes last. No LLM in V0 — synthetic actors prove the protocol.

Four concepts: `Actor`, `Context` (kind=case), `Event` (append-only), `Artifact`.

## Run

Needs Node >= 22.19 (`/opt/opencode-go-node/bin` on this host).

```sh
npm install
npm test                    # synthetic 2+2 world, no model
npm run typecheck
PIO_PORT=8899 PIO_DATA=./data/piople.sqlite node src/http/server.ts
```

HTTP (`x-piople-actor` header carries the verified identity; `PIO_TEST_USER` is dev-only):

```
GET  /healthz
POST /api/v1/contexts      { id?, title, goal }
POST /api/v1/join          { context, member?, capabilities, key? }
POST /api/v1/messages      { context, key?, text }
POST /api/v1/observations  { context, text, status?, evidence? }
POST /api/v1/assistance    { context, key?, to, question, snapshot } | { context, key?, requestKey, answer, evidence }
POST /api/v1/decisions     { context, question, options? } | { context, decisionId, answer, key? }
GET  /events?context=&after=            (JSON; SSE with Accept: text/event-stream)
```

Rules: membership + capability checked at the boundary (`read|write|decide`);
every mutation takes an idempotency `key` and replays return the original event;
`events` table is append-only (triggers); creator auto-joins with full caps.

## Verified 2026-10-09

- `npm test`: 2/2 green (full 4-actor loop, replay, non-member blocked, append-only).
- HTTP smoke `:8899`: create → join → message → same-key replay (same seq) → restart → events persist.
- Gateway live: `http://10.91.1.1:8788/v1` (bearer `gateway-bearer`) served 30 models;
  `deepseek-v4-flash` answered a probe (23+5 tokens). Cheap model for V1 agents,
  `gpt-5.6-luna` for harder calls (same as entropi deploy uses).
- k3s single node `tiny` Ready; `entropi` + `checkout-api` running — V1 reference workload available.

## Next (V1) — DONE 2026-10-09

`scripts/run-v1.ts`: same protocol, two gateway-backed agents
(`deepseek-v4-flash`), one real case (checkout-api restart crash).

- Round 1, no evidence: both agents **refused to invent a cause** and asked
  for logs/config — correct behaviour, not a failure.
- Real bug found in the process: `observation.recorded` events carried only
  artifactId, so the next agent couldn't see the content (the TR-context-loss
  problem live). Fixed: event data now includes `text` + `evidence`.
- Round 2, human posted real evidence (ConfigMap `POOL_SIZE=0` + `exit 1`
  start-script): builder proposed the exact fix
  (patch ConfigMap → rollout restart → verify), scout asked the right
  scope question (which env, full script?).
- Cost round 2: ~2.5k in + 1.3k out tokens on the cheap model. Decision left
  open for the human.

Gap for V2: agents still can't run tools themselves (no kubectl/repo read) —
they reason over human-posted evidence only. That's `ask_expert` + case-memory work.

## V2 (2026-10-09) — read-only tools, no human evidence

- `src/agents/tools.ts`: allowlist `kubectl get|describe|logs` on
  `configmap|deployment|pod|service|events` in `demo-apps` only.
  `test/tools.test.ts` pins it: patch/delete/kube-system/secrets/non-k8s all blocked.
- `agentTurn` now does up to 3 tool rounds (`TOOLCALL {…}` lines), then a final
  answer; tool calls land in the observation's `evidence`. Case digest
  (confirmed findings) heads the prompt.
- Fresh case, zero human evidence: scout fetched `POOL_SIZE=0` itself,
  both agents converged on the exact fix (patch → rollout restart → verify).
  Builder's patch proposal stays text — the allowlist would block it if
  attempted; human decides.
- Cost: ~5.3k in + 2.3k out tokens. `npm test` 3/3 green, `tsc` clean.

Remaining: write-path approval (proposal → decision → gated invoke),
`ask_expert` across contexts, Pi Durable persistence under the loop,
OptChat last.

## V3 (2026-10-09) — proposal → decision → gated invoke

- New events `action.proposed` / `action.executed`; `Artifact` kind `proposal`.
- Agent replies `PROPOSE: {verb,res,ns,name,patch,why}` → stored as proposal
  + bound `decision.requested` (no execution at propose time).
- `src/agents/executor.ts`: runs ONLY if decision resolved `yes` AND
  `PIO_ALLOW_WRITE=1`; write-allowlist is `patch configmap` in `demo-apps`.
  Every refusal is recorded as `action.executed{ok:false}`.
- `test/approval.test.ts`: open decision refused, approval-without-opt-in
  refused (dry-run default), `no` blocks even with opt-in.
- Live: 4 proposals, all `patch checkout-config POOL_SIZE→10`, each with own
  decision. Gate verified: `refused: decision … is open`. **Not applied —
  awaiting human approval.** `npm test` 6/6 green.
