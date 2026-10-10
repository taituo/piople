# piople — protocol core

Multi-agent + multi-user collaboration core, cut down to the protocol and two
process-level faces: a **CLI** and an **MCP stdio server**, plus a **Host**
that runs many participants (Pi agents, synthetic ones) in one process.
Core, CLI, MCP, Host and the synthetic harness have no runtime dependencies —
Node ≥ 22.19 (`node:sqlite`, `node:test`, native `.ts`). Only
`src/harnesses/pi.ts` needs the Pi packages (optional dependencies).

Agents, model gateway, kubectl tools, executor, HTTP server and runner scripts
of the first version were removed; the full history up to `c5a5b16` stays in git.

## Concepts

`Actor` (`human:*` / `agent:*`), `Context` (kind=case), `Event` (append-only), `Artifact`.
Events: `context.created, member.joined, message.posted, observation.recorded,
observation.promoted, assistance.requested/answered, decision.requested/resolved,
work.requested/claimed/completed/failed, action.proposed/executed, presence.changed`.

```
src/core/      Store (SQLite, migrations) + types — imports only itself + node:*
src/ops.ts     the one operation table; identity is fixed by the process, never an argument
src/cli/       one process = one op, JSON on stdout
src/mcp/       stdio JSON-RPC; same ops as tools piople_<op>
src/hosts/     Harness contract + Host: one process, many participants, each its own actor
src/harnesses/ synthetic.ts (no model) and pi.ts (the only file that imports Pi)
test/          core rules in-process; CLI+MCP+Host as real processes; boundary tests
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

# away for a week? inbox is what you owe; ack only moves the cursor, it resolves nothing
piople --as human:alice inbox
piople --as human:alice inbox --context c1
piople --as human:alice ack --context c1 --seq 42

# work: route by actor or declared skill; claims are atomic
piople --as agent:web actor --skills web.search
piople --as human:alice work-request --context c1 --id w1 --skill web.search --input '{"q":"docs"}'
piople --as agent:web work-claim --context c1 --next true          # -> {event, work:{attempt:1,...}} or {work:null}
piople --as agent:web work-complete --context c1 --id w1 --attempt 1 --result '"found"'
piople help

# MCP (e.g. from an agent host): identity comes from the env the host sets
PIO_DATA=./data/p.sqlite PIO_ACTOR=agent:scout node --no-warnings src/mcp/server.ts
```

## Rules (enforced in Store, so identical for CLI and MCP)

- Membership + capability (`read|write|decide`) checked on every op, including reads.
- **Joining is granted, not taken**: the granter needs `decide` and cannot hand
  out capabilities it does not hold. The creator starts with all three.
- **One write path.** Every mutation runs in a single `BEGIN IMMEDIATE`
  transaction: check, idempotency lookup, side-table writes, event insert.
  Replaying a key returns the original event and writes nothing; the same key
  for another operation or actor is a `key-conflict`. A failed write leaves no
  half-done rows. Concurrent processes on one SQLite file queue on the write
  lock (`busy_timeout`) instead of failing.
- `events` is append-only (SQLite triggers).
- Proposals never execute; a decision binds them. Echo delegates (away human)
  may answer but never decide. Invited experts may answer without membership.

### Inbox: a participant need not be running

Core keeps a read cursor per `(context, actor)` and derives what is owed from
open state. `inbox` lists my cases (unread from others, pending count);
`inbox --context` returns the events after my cursor plus `pending`:
assistance asked of me, open decisions I may resolve (needs `decide`, not an
echo delegate), work I can take, and work I hold. `ack` moves the cursor
forward only and never past the log's end. **Acknowledging is not resolving**:
pending is computed from state, so an acked decision stays pending until
someone decides it. The cursor is private state, not an event.

### Work

`work-request` addresses an actor (`--to`) and/or anyone who declared a skill
(`--skill`). Skills are self-declared routing hints and grant nothing: claiming
needs membership with `write`.

`open -> claimed -> done | failed`. A claim is one atomic step; exactly one
claimant wins a race. Each claim increments `attempt`, and completion must
present the attempt it was given, so a claimant that was replaced (lease
expired, someone else claimed) is refused with `stale-claim` while the current
one finishes. A claimant claiming again while its claim is live gets the same
claim back (restart-safe). Leases are optional and chosen by the claimer
(`--lease-ms`); without one a claim never expires. `work-fail --retry true`
reopens the work; otherwise `failed` is final.

Core guarantees one holder and one accepted completion per attempt. It cannot
undo side effects outside itself, so an executor should pass
`work:<id>:<attempt>` on as its own idempotency key.

## Hosting participants

A **harness** turns what is new into protocol actions; the **host** only delivers.
One process can host many harnesses, each its own actor:

```ts
const host = new Host(new LocalCore(store));
await host.add({ actor: "agent:fetch", skills: ["web.search"],
  harness: new SyntheticHarness({ behaviors: [behave.worker((input) => lookup(input))] }) });
await host.add({ actor: "agent:researcher",
  harness: await PiHarness.open({ actor: "agent:researcher", dir: "./data/pi", role: "You research.",
    provider: { baseUrl: "https://…/v1", apiKey }, modelId: "…" }) });
host.start();            // or: await host.settle() in tests/scripts
```

- **Delivery is at-least-once.** The host polls each actor's inbox and calls
  `harness.step({context, events, pending, run})` when others have written (or,
  once after start, when something is still owed). The cursor moves only after
  `step` returns, so a crash re-delivers. Calls made through `step.run` get keys
  derived from `(actor, context, cursor, call number)`, so a retried step replays
  instead of duplicating.
- **Membership is never granted by the host.** A `decide`-holder joins actors
  through Core; a hosted actor that names itself `human:*` gets no more power than
  its capabilities, and a Pi model's refused command goes back to it as feedback.
- **A harness need not be running** for its actor to exist: the cursor, the open
  asks/decisions and any work it holds are in Core. A restarted harness resumes
  its own claim (no re-claim, no new attempt) and is not re-sent what it saw.
- **PiHarness** keeps the agent's conversation in Pi (durable, one per case) and a
  tiny private map + reply memo beside it. Command protocol:
  `POST OBSERVE ASK ANSWER DECIDE WORK CLAIM DONE FAIL` (else `NOOP`). A failed
  model call throws (never looks like an empty answer) and is retried with a
  fresh request.
- Tests drive the real Pi runtime against a deterministic OpenAI-compatible fake
  endpoint (`test/fake-model.ts`). A live model run is deliberately not part of the
  suite and has not been run in this repo's current form.

Not yet: a continuously-running human harness (a human uses the CLI, which is a
short-lived participant), environments (tools/filesystem/network per harness), and
anything over a network — `CoreClient` is the seam for that (phase D).

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
