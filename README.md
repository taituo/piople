# piople — protocol core

Multi-agent + multi-user collaboration core, cut down to the protocol and two
process-level faces: a **CLI** and an **MCP stdio server**. No runtime
dependencies — Node ≥ 22.19 (`node:sqlite`, `node:test`, native `.ts`).

Agents, model gateway, kubectl tools, executor, HTTP server and runner scripts
were removed; the full history up to `c5a5b16` stays in git.

## Concepts

`Actor` (`human:*` / `agent:*`), `Context` (kind=case), `Event` (append-only), `Artifact`.
Events: `context.created, member.joined, message.posted, observation.recorded,
observation.promoted, assistance.requested/answered, decision.requested/resolved,
action.proposed/executed, presence.changed`.

```
src/core/      Store (SQLite, migrations) + types — imports only itself + node:*
src/ops.ts     the one operation table; identity is fixed by the process, never an argument
src/cli/       one process = one op, JSON on stdout
src/mcp/       stdio JSON-RPC; same ops as tools piople_<op>
test/          core rules in-process; CLI+MCP as real processes on one DB file
```

## Use

```sh
npm install && npm test && npm run typecheck

alias piople='node --no-warnings src/cli/main.ts --db ./data/p.sqlite'
piople --as human:alice actor
piople --as human:alice create --id c1 --title "Checkout down" --goal "find cause"
piople --as human:alice join --context c1 --actor agent:scout --caps read,write
piople --as agent:scout observe --context c1 --text "POOL_SIZE=0" --evidence k8s:cm/checkout
piople --as agent:scout decision-request --context c1 --id d1 --question "Patch to 10?"
piople --as human:alice decide --context c1 --decision d1 --answer yes
piople --as human:alice events --context c1
piople help

# MCP (e.g. from an agent host): identity comes from the env the host sets
PIO_DATA=./data/p.sqlite PIO_ACTOR=agent:scout node --no-warnings src/mcp/server.ts
```

## Rules (enforced in Store, so identical for CLI and MCP)

- Membership + capability (`read|write|decide`) checked on every op.
- **Joining is granted, not taken**: the granter needs `decide` and cannot hand
  out capabilities it does not hold. The creator starts with all three.
- Every mutation has an idempotency `key`; a replay returns the original event.
- `events` is append-only (SQLite triggers).
- Proposals never execute; a decision binds them. Echo delegates (away human)
  may answer but never decide. Invited experts may answer without membership.

## Toward distribution (not built)

The core is already shaped for it: events are keyed per `(context, key)`, so
appending the same event twice is a no-op, and readers page by `seq`. The
natural next step is **joining across runtimes**: a remote runtime gets
`member.joined` granted by a local `decide` holder, then syncs a context by
pulling `events --after <seq>` and pushing its own keyed events, which the
owning runtime re-checks with the same Store rules. Open questions before
building it: verified actor identity (signatures instead of a trusted
`--as`), which runtime owns a context's ordering, and whether `seq` stays
local with a per-origin cursor.
