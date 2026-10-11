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
Events: `context.created, member.joined, member.removed, message.posted, observation.recorded,
observation.promoted, assistance.requested/answered, decision.requested/resolved,
work.requested/claimed/completed/failed, message.submitted, route.classified/resolved/shadowed/unresolved,
action.proposed/executed, presence.changed`.

```
src/core/      Store (SQLite, migrations) + types — imports only itself + node:*
src/ops.ts     the one operation table; identity is fixed by the process, never an argument
src/cli/       one process = one op, JSON on stdout
src/mcp/       stdio JSON-RPC; same ops as tools piople_<op>
src/http/      Core over HTTP: POST /v1/ops/<op>, identity = bearer token
src/hosts/     Harness contract + Host (+ HttpCore client): many participants per process
src/harnesses/ synthetic.ts (no model), router.ts + jev.ts (routing), pi.ts (the only file that imports Pi)
src/eval/      routing evaluation: labelled messages -> measured thresholds
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
piople --as human:alice join --context c1 --actor agent:web --caps read,write   # claiming needs membership with write
piople --as human:alice work-request --context c1 --id w1 --skill web.search --input '{"q":"docs"}'
piople --as agent:web work-claim --context c1 --next true          # -> {event, work:{attempt:1,...}} or {work:null}
piople --as agent:web work-complete --context c1 --id w1 --attempt 1 --result '"found"'
piople help

# MCP (e.g. from an agent host). Same machine as the database: identity from the env the host sets
PIO_DATA=./data/p.sqlite PIO_ACTOR=agent:scout node --no-warnings src/mcp/server.ts
# MCP from another machine, over HTTP: identity is the token's actor (PIO_ACTOR, if set, must agree)
PIO_CORE_URL=http://core:8899 PIO_TOKEN=pio_... node --no-warnings src/mcp/server.ts
```

## Rules (enforced in Store, so identical for CLI and MCP)

- Membership + capability (`read|write|decide`) checked on every op, including reads, and bounded by the
  context's realm.
- **Joining is granted, not taken**: the granter needs `decide` and cannot hand
  out capabilities it does not hold. The creator starts with all three.
- **One write path.** Every mutation runs in a single `BEGIN IMMEDIATE`
  transaction: check, idempotency lookup, side-table writes, event insert.
  Replaying a key returns the original event and writes nothing; the same key
  for another operation or actor is a `key-conflict`. A key the caller chose itself (`--key`, an HTTP or MCP `key`)
  also names one request: the same key with different content is a `key-conflict` too (a hash of the request is kept
  with the event). Keys a host derives for its own steps, and the deterministic defaults, still replay whatever comes
  back, because a retried step may legitimately send other content. Keys are unique per case, so some are
  not free to name: a key that starts with an actor's id and `@` (the form a host derives, `agent:x@c1#0.1`, and
  the form it mints ids in) is that actor's own, and a key a caller names may not start with a prefix Core uses
  itself (`claim:`, `complete:`, `fail:`, `work:`, `decision:`, `create:`, `artifact:`, `proposal:`, `presence:`,
  `promote:`, `classified:`, `resolved:`, `shadowed:`, `unresolved:`, `route:`): otherwise a writer could take
  `claim:w1:1` before the worker and nobody could claim `w1`. Ids and actors must be in Unicode form NFC and
  contain no invisible characters (zero-width, direction overrides). A failed write leaves no
  half-done rows. Concurrent processes on one SQLite file queue on the write
  lock (`busy_timeout`) instead of failing.
- `events` is append-only (SQLite triggers).
- A decision is answered with one of its options (`yes,no` unless `--options` says otherwise); anything else is refused
  (`bad-answer`) and the decision stays open. Actors are `human:<id>` or `agent:<id>`; ids are 1 to 200 characters.
- Proposals never execute; a decision binds them. Echo delegates (away human)
  may answer but never decide. Invited experts may answer without membership.

### Realms and channels

A **realm** is the outer boundary of a collaboration area, a **channel** a topic stream inside it, a
**case** a bounded piece of work. All three are contexts of a different `kind`, so they share events,
membership, inbox and cursors; nothing else was added to Core.

```sh
piople --as human:alice create --kind realm   --id realm-infra --title "Infrastructure"
piople --as human:alice join   --context realm-infra --actor human:bob --caps read,write
piople --as human:bob   create --kind channel --realm realm-infra --id ch-incidents --title "Incidents"
piople --as human:bob   create --realm realm-infra --parent ch-incidents --title "Checkout down"   # a case in the channel
piople --as human:bob   targets    # what I may address: contexts I can write to, with my effective capabilities
```

- **The realm is the upper bound.** What an actor effectively holds in a context is its own
  capabilities there cut down to what it holds in the context's realm, checked at every access. Lowering
  a realm role lowers it everywhere inside the realm at once; a non-member of the realm has nothing in it.
- **Joining** a context in a realm needs the target to be a member of the realm already, and cannot grant
  more than the target holds there (`not-in-realm`, `forbidden`).
- **Realm membership does not confer channel membership.** Joining a channel or case stays explicit.
- **Creating inside a realm** needs `write` in the realm (and in the parent channel for a case). The
  creator starts with everything its realm role allows.
- A case under a channel lives in the channel's realm. Channels need a realm and have no parent. Contexts
  without a realm behave exactly as before.
- `inbox` shows each context's `kind` and `realm`.

### Removing members

```sh
piople --as human:alice remove-member --context ch-1 --actor agent:carol   # needs decide
piople --as agent:carol leave --context ch-1                                # my own membership
```

- **Immediate and visible**: access (read, write, inbox, targets) ends at once and a `member.removed` event is
  written. History stays readable by the others.
- **Never the last decider**: removing the last effective holder of `decide` is refused (`forbidden`), so no
  context is left that nobody can govern.
- **A realm removal cascades**: the actor leaves every context inside the realm in the same transaction, one
  `member.removed` (reason `realm-removed`) per context. Re-adding them to the realm does not restore old roles.
- **Held work is reopened** with its attempt kept; someone else can claim it (attempt + 1). Their read cursor is
  dropped. Identity, tokens and presence are untouched: membership is not identity.
- A rejoin after a removal is a new join (the default join key includes the number of removals).

Core provides the addressing (`targets`) and the rules above; routing is below.

### Routing: saying a message without saying where it goes

```sh
piople --as human:bob submit --text "production servers keep crashing, please look into it"
node src/cli/admin.ts --db ./data/p.sqlite add-router --actor agent:router    # the operator designates routers
```

A submitted message waits in its sender's own **ingress** (a context Core creates on first submit) until a
**router** resolves it. A router is an ordinary harness (`src/harnesses/router.ts`) that reads the queue
(`route-pending`), asks a classifier, and calls `route-resolve` or `route-unresolved`. Core holds only the rules:

- **Delivery is as the sender, only where the sender may write.** `route-resolve` posts the message into the
  chosen context as the sender (or, with `--as work --skill/--to`, requests work as the sender). A router, and
  the classifier behind it, can never reach a place the sender cannot: the choice is refused and recorded
  nothing, and the message stays pending. A classifier suggests, Core decides.
- **The classifier sees only what the sender may address** (`route-targets`), never anything else.
- **Every decision is an event** in the sender's ingress: `route.classified` (classifier name and version,
  rule version, mode, choice, confidence, top probabilities, stages), then exactly one of `route.resolved`
  (delivered), `route.shadowed` (shadow mode: valid, recorded, deliberately not delivered) or
  `route.unresolved`. `resolved` therefore always means delivered. The sender can read them, so an uncertain
  message is not lost: it stays visible and the sender can clarify with a new message.
- **Shadow mode** (`mode: "shadow"`): the same decision is validated and recorded (`route.shadowed`) but
  nothing is delivered. Start there, compare against what people actually chose, then enforce. Messages
  submitted during the shadow period stay undelivered: they are not replayed when you switch to enforce.
- **The queue is a table**: submissions waiting for a route are listed in `route_queue`, so polling costs
  the queue, not the whole history. Keys starting `resolved:`, `shadowed:`, `unresolved:` or `classified:`
  belong to the router and are refused on submit; ids starting `ingress:` are reserved for ingress contexts.
- **No invented thresholds**: `minConfidence` is a required option; derive it from measured results.
- **Loops are bounded**: `submit --after-context/--after-seq` chains hops (refused past 5); one actor may have
  at most 100 messages waiting. A participant that omits `--after` starts a new chain, so the cap is the backstop.
- **Too many targets for one question** (classifiers take a limited number of options) are routed realm
  first, then within the chosen realm.
- A classifier outage leaves messages **pending** (retried), it never turns them into unresolved ones; a
  classification recorded before a crash is reused, not paid for twice.
- Who may route is the operator's decision (`add-router`), like credentials: it is not an op and not an event.

The `Classifier` interface (`classify({text, targets, stage}) -> {choice, probabilities, confidence, skill?}`)
has a deterministic `keywordClassifier()` for tests and as an offline baseline, and `jevClassifier()`
(`src/harnesses/jev.ts`) for Jev.

**Jev** (plain fetch, no SDK; request/response shapes follow the open-source jev-classifier client):

```ts
const router = new RouterHarness({
  classifier: jevClassifier({ apiKey, model: "<exact model id>" }),   // no default model: pin it
  mode: "shadow", minConfidence: /* from measured results */ 0.7, ruleVersion: "r1",
  external: { allowRealms: ["realm-infra"] },                          // default: none
  needsHumanAbove: 0.8,                                                // optional; unset = never gate
});
```

- One call asks two questions: `target` (`choice` over the offered destinations plus an explicit
  "none fits" option, so the model is never forced to pick) and `needs_human` (`noul`). Urgency (`score`)
  is not asked yet: its request shape is not verified.
- **Privacy: nothing leaves by default.** Destination names are realm-private, so an *external* classifier
  is offered only targets in `external.allowRealms`; with none configured every message is left
  `no-permitted-targets` and not a single request is made. Only the message text is sent (no sender, no hop
  count). Note that the text of a message is sent whenever at least one allowed realm is a candidate.
- **Pinned model**: `model` is required and recorded with every decision (`classifier.version`). A moving
  alias would make recorded decisions uninterpretable.
- **Strict parsing**: a missing/unoffered choice, an incomplete or out-of-range distribution, or a wrong
  answer type is an error, never a guess. Where the confidence came from (`answer`, `providerMetadata`, or the
  chosen option's own probability) is recorded in `extras.confidenceSource`.
- Errors never echo the request, the provider's body or the key; redirects are refused; 30 s timeout.
  Failures are classified (`ClassifierError`): *transient* (408, 429, 5xx, unreachable) and *config* (401,
  402, 403, 404) leave every message pending and fail loudly, so a wrong key can never turn messages into
  unresolved ones; *message* (other 4xx, an unusable answer) is retried `maxAttempts` times (default 3) and then
  that one message is left unresolved (`classifier-error`) so it cannot hold up the queue.
- `test/jev.test.ts` runs against a local stand-in endpoint. `test/jev.live.test.ts` calls the real one and is
  skipped unless `OPENROUTER_API_KEY` (or `JEV_API_KEY`) and `JEV_MODEL` are set.

### Measuring routing before trusting it

```sh
node src/eval/main.ts                                  # keyword baseline on eval/routing-synthetic.json
node src/eval/main.ts --dataset my-messages.json --target-precision 0.95 [--json]
OPENROUTER_API_KEY=... JEV_MODEL=<exact id> node src/eval/main.ts --classifier jev --send-to-external --dataset my-messages.json
```

Real labelled data comes from real use: when people post straight into a channel they choose the destination
themselves, so those posts are labels nobody has to write.

```sh
node src/eval/export-main.ts --db ./data/p.sqlite --out my-messages.json [--redact] [--since SEQ]
node src/eval/main.ts --dataset my-messages.json --context 1                 # keyword baseline, with the previous message as context
OPENROUTER_API_KEY=... JEV_MODEL=<exact id> node src/eval/main.ts --classifier jev --send-to-external --context 1 --needs-human-above 0.3 --dataset my-messages.json
```

The export leaves out what a router delivered (its choice is not a human label), agent posts, ingress contexts and
very short texts. The file holds real text: keep it local; `--send-to-external` shows it to a third party. `--redact`
masks e-mails, URLs and long numbers and does not make text safe to share. `--context K` shows the classifier the K
messages before each one (replies need them); the live router does the same with `recentLimit` (messages the sender
may read; an external classifier only gets allowed realms), and `needsHumanAbove` hands messages to people when the
classifier says a person must decide. `eval/*.results.md` records what these did on invented sets.

A dataset is a small world (contexts, who is a member where) plus labelled messages: `{id, sender, text, expect}`
where `expect` is the destination a reasonable person would pick among what that sender may address, or `null`
when the message should stay unrouted. The runner builds the world, submits every message and runs the router in
**shadow mode** (nothing is delivered), then reports per `minConfidence`: how many messages are routed, how many
are right, false routes, precision, coverage and the share of right destinations found, plus latency.

- **The threshold is measured, not invented.** The suggestion is the lowest `minConfidence` that reaches your
  target precision with enough routed messages, with a 95% Wilson lower bound; it says "not yet confident" when
  the dataset is too small, and "no threshold reaches the target" when none does.
- A message the sender cannot route anywhere is part of the measurement (`expect: null`); so are senders
  without access, other languages, and off-topic text that shares words with a channel (see the synthetic set).
- Evaluating an external classifier shows the dataset's texts and destination names to an outside service: it
  requires `--send-to-external`.
- `eval/routing-synthetic.json` was written together with the keyword baseline. It exercises the harness and
  shows failure modes; **it says nothing about real traffic**. Build a dataset from your own messages.
- Not measurable offline: how often people re-route by hand, and latency/cost under production load.

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

- **Nothing a writer sends can make a read unbounded.** One read of a case returns at most 4 MB of events (the
  first event always comes; the host acks what it got and the next read continues). The inbox lists at most 50
  open work items, asks and decisions, or 200,000 characters of them (`moreOpen`, `moreAssistance`,
  `moreDecisions` say how many were left out), and `work-list` is cut at 4 MB. Text that goes to a model or a
  person is cut as well: a Pi prompt clips each owed line (4,000) and all of them (40,000), the Jev classifier
  and the model summariser send at most `maxChars` (4,000) of a message, and the console prints at most 4,000
  characters of a line, saying how much it left out and how to read it whole.
- **Nothing waits for ever.** `Host.stop()` waits for a step in flight up to `stopTimeoutMs` (15 s), one Pi
  round takes at most `runTimeoutMs` (5 min), and `kubectl create` at most `timeoutMs` (60 s); after that they fail
  with a plain error and are retried.
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

### Memory for long-lived agents (OptChat)

A Pi agent that lives for weeks cannot carry one ever-growing transcript. With `memory`, `PiHarness` starts each
delivery in a fresh conversation whose first prompt holds a **bounded view** of the case: the newest events
verbatim, older ones folded into summaries (chunks of `k`, summaries of summaries above), every line with an id.
The agent reads what a summary stands for with `ZOOM: <id>` (children, down to the original lines) and searches the
whole kept history for exact words with `FIND: <words>` (newest match last: a later line may correct an earlier one).

```ts
import { extractiveSummarizer, modelSummarizer } from "./src/harnesses/memory.ts";
await PiHarness.open({ /* ... */, memory: {
  summarizer: modelSummarizer({ baseUrl, apiKey, modelId: "<exact id>" }),   // or extractiveSummarizer() offline
  k: 8, recent: 20, budgetTokens: 1500 } });
```

- **Derived, never authoritative.** The tree lives beside the harness (`<actor>.memory.sqlite`), is built from the
  event log (`events`, so the agent's own writes are in it too) and can be rebuilt: the same summariser gives the
  same tree. Core knows nothing of it.
- **Obligations and decisions never live only in a summary.** Open asks, decisions and work come from Core's
  `pending` on every step; decisions already taken or asked are pinned verbatim in the view after their event was
  folded away.
- **Bounded.** Over budget the texts shrink evenly, then the most detailed old entries are left out (the broad
  summaries last, the newest three events never), and the prompt says so.
- **A summariser is pinned.** `modelSummarizer` takes an exact model id; a memory refuses to open under another
  summariser (`memory-summarizer-mismatch`). Strict: an empty answer, or one cut off by `max_tokens`, is an error;
  a reasoning model needs room to think (default 2000 tokens), a small non-reasoning model is the better fit. Extra
  `headers` are for gateways that want them (opencode Go: `x-opencode-session`).
- **A down summariser never fails a delivery**: the tree is left as it was, the view just stays longer until the
  next try (`harness.memoryErrors` counts them).
- Measured with fakes: after 40 messages the prompt stays within budget, a fact planted deep in the history is
  absent from the view and found by zooming down, and a decision made long ago is still visible verbatim. How well a
  *real* model summarises and navigates is not measured here; do it as routing is measured, not assumed.
- **Against Pi's own compaction** (`scripts/live-compaction.ts`, `gpt-4.1-mini` as agent and summariser, 70 messages
  delivered one at a time, then the same five questions; one run each, Pi's books for the cost):

  | | recall | tokens (all-in) |
  | --- | --- | --- |
  | whole transcript, no compaction | 5/5 | 48 k |
  | Pi compaction (one linear summary, run once by hand) | 5/5 | 51 k |
  | case memory (this section) | 3/5 (0/5 before a fix, below) | 113 k |

  **At that size the memory does not pay for itself.** 70 short messages are about 5 k tokens, so the whole transcript
  fits and is cheapest; Pi's compaction kept every planted fact; the case memory put a view into each of ~80 prompts
  (twice the tokens). That test could not tell the designs apart, so there is a harder one.

- **The harder benchmark** (`scripts/bench-recall.ts`): 1000 messages in bursts of 20, 24 fine-grained facts (hex tokens,
  ports, thresholds, owners) among 40 near-duplicate distractors, 4 later corrections, 24 questions that need the exact
  current value. `gpt-4.1-mini` as agent, Pi's window set to 16 k so its compaction fires repeatedly. Two seeds:

  | | exact recall (seed 1 / seed 2) | tokens, all-in |
  | --- | --- | --- |
  | whole transcript (fits a 128 k window; the ceiling) | 24/24 / 23/24 | ~125 k |
  | Pi automatic compaction (2 compactions) | **3/24 / 2/24** | ~125 k |
  | case memory with `FIND` and `ZOOM` | **19/24 / 13/24** | ~265 k |

  Where the history outgrows the window, **Pi's linear summary kept almost no exact values and the agent filled the gap
  with confident inventions** (`token prefix 1a98-5117`, ports `24444`, `24448`, `24418`: plausible, wrong, despite
  "never guess"). The case memory recovered 54 to 79 %, and when it failed it mostly said it did not know. It costs
  about twice the tokens of the whole transcript, so it earns its place only once the transcript no longer fits.
  Caveats: one agent model, two seeds, Pi's window shrunk to force compaction (a real 128 k window would need ~5000
  messages), and Pi's default compaction prompt may suit coding sessions better than exact identifiers.
  What mattered inside the memory: **`ZOOM` alone was not enough** (a needle query means guessing a branch of the tree;
  first score 3/8 at 200 messages), an exact-word **`FIND`** over the kept original lines fixed that; and the agent
  must be told to try `FIND` before saying it does not know (three misses were "not available" without a search).
  Not measured: other agent models (the weaker the model, the more the protocol detours cost), the summariser's own
  quality in isolation, longer runs, and what a smarter summary prompt for Pi's compaction would change.
- **Prefer, by size:** history that fits the window: keep the transcript (or Pi's compaction as it nears the window);
  history that outgrows it and where exact values matter: the case memory. A fair Pi run also needs a normal window:
  with a tiny one Pi leaves its own output (and its summariser) one token of room and loops; and on the opencode Go
  gateway Pi's compaction request lacks the `x-opencode-session` header the gateway demands, so it fails there.
- Each delivery is its own small durable Pi conversation; they accumulate in the Pi store (not pruned yet).
- **Measured with real models** (`scripts/live-memory.ts`): four facts and one human decision planted in a 70-message
  case, asked back one at a time. Agent `deepseek-v4-flash`: no memory 1/5 (only the fact still inside the newest
  events), offline summariser 5/5, `gpt-4.1-mini` summariser 5/5. Agent `glm-5.3-flash`: 1/5 (rescored, see the
  script), 4/5, 5/5. In every memory run the agent found the fact by zooming one or two levels down; the model
  summariser needed about half the model calls of the offline one (9 vs 18) because its summaries keep detail.
  One run per arm, two agent models, one small synthetic case: a sign that the design works, not a benchmark. The
  summariser's own tokens are not in these counts.

### A human as a running participant

```sh
node src/hosts/watch.ts --as human:alice --db ./data/p.sqlite                      # next to the database
PIO_TOKEN=pio_... node src/hosts/watch.ts --as human:alice --url http://core:8899   # over HTTP
```

`HumanHarness` (`src/harnesses/human.ts`) shows what is new and what is owed (asks, decisions you may resolve,
work you may take or hold) and reads commands: `say`, `answer <key> | <text>`, `decide <id> <option>`, `claim`,
`done`, `fail`, `help`. An empty line or Ctrl-D leaves; **looking resolves nothing**, so whatever is still owed
stays pending in Core. No model, and no extra power: every command is an ordinary op run as that actor, so
deciding still needs `decide` (a `human:*` name grants nothing, and an agent with the same harness is judged the
same way). I/O goes through a `Console` interface (`scriptedConsole` in tests); the CLI one-shot commands are
unchanged. The host takes the actor's lease, so one `watch` per person at a time.

### Environments (process level)

What an agent can *do* is fixed by the **operator's profile** for it, never by what it declares or what Core stores:

```ts
await PiHarness.open({ /* ... */, environment: { name: "reader", tools: ["read_file", "list_dir"], files: { root: "/srv/docs" } } });
```

The agent calls `TOOL: <name> | <json>` (offered in its protocol only when it has a profile). Each call runs in its
own child process (`src/harnesses/tools.ts`, tools in `src/tools/`):

- **Node permission model**: read access only to the profile's directory and the tool's own code; no writes, no
  child processes, no workers. Reads outside are stopped by the *runtime* (`ERR_ACCESS_DENIED`); a test drives a
  naive tool with raw `fs` calls to prove it is not the tool's own checks doing the work.
- **Empty environment**: the child gets only the profile's explicit `env`. The host's token and keys never reach a
  tool, and tool output is all the model ever sees.
- **Limits**: a time limit (default 10 s, then SIGKILL) and an output cap; every failure comes back to the agent as
  `REFUSED TOOL ...` feedback, like a refused command. An agent without a profile has no tools whatever it writes.
- **Known limits, pinned by tests**: the permission model does not restrict the **network** (a network profile
  waits for containers / network policy), and it **follows a symlink inside the directory that points outside**; the
  bundled tools close that with a realpath check, and a test fails if Node's behaviour changes. A harness that uses
  tools should run in its own process; synthetic agents and humans may share one.
- **Native Pi tools** (`nativeTools: true`): the profile's tools are offered as Pi tools (function calls) instead of the
  `TOOL:` command. Each call is then a **durable Pi task**: the intent is committed before it runs, the result is a
  tool message in the transcript, spend is accounted by Pi, and a call interrupted by a crash reruns on recovery
  (the bundled tools only read, so they are declared `replay: "safe"`). The confinement is unchanged: the work still
  runs through `runTool` in its own restricted child process. Pi's own `ExecutionEnv` (`NodeExecutionEnv`) confines
  nothing (a `cwd`, and `bash` runs an unrestricted shell); isolation is meant to live in the environment, which is
  what the child process provides. Pi's `beforeTool` hook is the natural place to gate a tool call on a Core decision
  (not built yet).
- **Approval gate** (`approval: { tools: ["read_file"] }`, both modes): a call to a listed tool opens a Core decision
  ("allow"/"deny") and is blocked; the model is told to wait. When someone holding `decide` resolves it the agent is
  shown the resolution and calls again: "allow" lets that exact call (tool and arguments) through, "deny" blocks it and
  says who denied. Non-blocking and durable (nothing waits inside a task; the decision is an ordinary Core item, so it
  shows in the inbox, survives restarts and works from `piople watch`, the CLI or Temporal), one decision per distinct
  call, and the agent cannot approve itself: that needs `decide`, which Core grants separately. This is Pi's
  `beforeTool` hook used as the point where a human enters the loop.
- **Tool-call cap** (`maxToolCalls`, default 16 per delivery, native tools): Pi runs a model's tool calls for as long as
  the model makes them, with no limit of its own, so a model retrying a blocked call would loop at your cost. Over the cap
  the tool answers with `terminate` (the only thing that ends a Pi run; aborting the conversation does not stop a run that
  has queued its next request, measured) and the agent says in the case that it stopped.
- Checked with real models (`scripts/live-tools.ts`, `LIVE_NATIVE=1` for native tools): an agent reads a runbook
  inside its directory and is refused when asked for a file outside; the canary in that file never reached it.
- **A reply with no command line and no `NOOP` is not silence**: the model is told once ("nothing happened") and may
  answer. Found live: a reasoning model sometimes ends a tool round with an empty reply, and the person got no answer.


### One host per actor

A host takes a **lease** on each actor it serves (`host-lease`, a TTL in Core; not an event). While the lease
is live, a second host for the same actor is refused (`already-hosted`, 409) and only the holder may `inbox` and
`ack` for it, so nothing is processed twice. `Host` acquires at `add`, renews when half the TTL has passed and
releases at `close`. A holder that comes back after another took over (a paused process waking up) has its `ack`
refused, so it cannot move the cursor; the cursor lives in Core, so the new holder resumes where the actor was.

- `new Host(core, { holder, leaseMs })`: `holder` defaults to a random id. Give a service a **stable** one, so a
  restart after a crash renews its own lease at once instead of waiting for it to expire. `leaseMs` defaults to 30 s.
- Writes made through `step.run` are not fenced: they are idempotent by key. An actor without a lease (a human
  using the CLI) behaves as before.
- The lease is operational state, not authority: it grants nothing and Core's membership rules are unchanged.

## Kubernetes

Core, Host and the harnesses do not change; a cluster is just another place participants run
(`src/adapters/k8s.ts`, `src/hosts/worker.ts`, `deploy/`).

- **Launcher** (`K8sLauncher`): an ordinary participant, **read-only** in the contexts it watches, that starts a Job
  for work nobody took within `delayMs`. It sees work through `work-list` (read is enough; it cannot take it) and
  is the only component with cluster permissions. The Job name is derived from the work id, so Kubernetes refuses a
  duplicate: a second or restarted launcher cannot start the same work twice. It never sees a credential: the Job
  refers to a Secret by name, provisioned by the operator. The pod is non-root, read-only root filesystem, no
  capabilities, no service account, with a deadline and a TTL. Plain `kubectl` behind a `JobRunner` seam.
- **One-shot worker** (`src/hosts/worker.ts`): claims exactly its work, runs the executor for its skill
  (`src/hosts/executors.ts`) and completes it. A pod killed mid-work and replaced gets **its own claim back** (same
  attempt) and finishes once; if the work is already done or taken by another it just exits. Executors get
  `work:<id>:<attempt>` to pass on as an idempotency key.
- **Network policy** (`deploy/k8s/lab.yaml`): default-deny in both directions, DNS allowed, workers may reach Core
  and nothing else, only workers may reach Core.
- **Egress gate** (`egressGate` in the profile): an init container *without the token* that must see a canary address
  refused several times in a row before the worker container starts. Measured on k3s (kube-router): a new pod's rules
  land a fraction of a second after its container starts, and one connection in three test runs got out in that
  window; the gate closes it, and it **fails closed** where egress is not restricted at all (tested in a namespace with
  no policies). Only connect-level outcomes (refused, unreachable, timeout) count as "blocked": a canary name that does not
  resolve, or a bad port, leaves the gate shut (found by the second session's bug hunt: a typo used to open it). Give the
  canary as an **IP address**, in case DNS is itself behind the policy. Note that an established connection stays open when the policy arrives (and Node's `fetch` reuses
  connections), so measure with fresh ones.

```sh
node scripts/k8s-lab.ts            # builds the image, runs it all in namespace piople-lab on your cluster, deletes it
```

The lab (`scripts/k8s-lab.ts`, not part of `npm test`) needs `kubectl`, `podman` and passwordless `sudo k3s ctr`. It
checks, on a real k3s cluster: one Job per work; the pod killed mid-work and the work finished once by the
replacement, same attempt, one claim and one completion in the log; the launcher never took the work; the gate
passed; a worker reaches Core but not the internet, the Kubernetes API, the node, or another namespace; and the gate
refuses to open in a namespace with no policies. **Not covered:** a cluster other than k3s (kind, a managed one), a
launcher running inside the cluster (it uses your kubeconfig; an in-cluster one would need a ServiceAccount, a Role
for Jobs and a REST `JobRunner`), Pi workers (the image carries the Pi packages, but the lab's task is the echo
executor), the Temporal worker in-cluster (see Temporal above).

## Temporal (orchestrator only)

`src/adapters/temporal/` (optional `@temporalio/*` packages, confined there by a boundary test). Temporal decides
progression; **Piople agents do the work**. Workflows are deterministic and call Piople only through Activities, as
one ordinary actor (the orchestrator, needs `write` in the cases it drives):

- `requestWork` / `awaitWork` / `requestDecision` / `awaitDecision`. Ids are derived from a key the workflow builds
  from its own workflow id and step name, so an Activity retry, a replayed workflow or a restarted worker **replays in
  Core instead of duplicating**. Waiting Activities heartbeat, so a dead worker is noticed in seconds.
- **Work is addressed to a named actor**, never to a skill: a skill-addressed item is fair game for the Kubernetes
  launcher, and two orchestrators must never start the same work.
- `piopleChain` is an example: ask an agent, put the result to a human (a real Core decision, with `decide`
  required), and only on "yes" ask a second agent. `node src/adapters/temporal/worker.ts` runs the worker
  (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `PIO_CORE_URL`, `PIO_TOKEN`, `PIO_ACTOR`; the
  bundler needs `HOME`/`TMPDIR`, so do not start it with a bare environment).
- Tested against a local Temporal dev server that the SDK downloads (skipped when the packages or the server are
  unavailable): the chain; a "no" from the human stops it; the Activities are idempotent; and a worker process
  **SIGKILLed while waiting on an agent** is replaced by a new one that finishes the chain with exactly one item per
  step, each claimed and completed once. Not run against the Temporal in the cluster, and not in-cluster.

## Across processes and machines

```sh
# operator, next to the database: one credential per actor (shown once, stored hashed)
node src/cli/admin.ts --db ./data/p.sqlite issue-token --actor agent:fetch [--ttl-ms 3600000]
node src/cli/admin.ts --db ./data/p.sqlite list-tokens --actor agent:fetch    # created / expires / last used, never the secret
node src/cli/admin.ts --db ./data/p.sqlite revoke-tokens --actor agent:fetch

PIO_DATA=./data/p.sqlite PIO_PORT=8899 node src/http/main.ts      # binds 127.0.0.1 by default
```

```ts
// anywhere that can reach it; same Host, same harnesses
const core = new HttpCore("http://core:8899", { "agent:fetch": tokenA, "agent:review": tokenB });
const host = new Host(core);
```

- **Identity is the token and nothing else.** The server derives the actor from the bearer
  token; no argument can name another caller. A host that serves several actors holds one
  token per actor and can speak only as those. Tokens are stored as SHA-256 hashes, can
  expire (`--ttl-ms`), record when they were last used (at most one write a minute), can be
  revoked, and are minted only by the operator (not an op, not an event).
- **Membership and capabilities are unchanged**: the same Store rules judge HTTP calls as
  CLI and MCP calls. A valid token buys identity, not power.
- **Reconnecting resumes from the cursor.** Cursors, open asks/decisions and held work live
  in Core, so a host that was away, killed or replaced by a process on another machine picks
  up where its actor left off. A replacement holding the same credential *is* that actor.
- **Retries are safe.** `HttpCore` fixes an idempotency key/id before the first attempt, so
  a lost response replays on the server instead of duplicating. `work-claim --next` is the one
  op never retried blindly; a lost claim shows up under `work.mine` and is resumed.
- **Bounded inputs.** One read returns at most 1000 events (page with the cursor); a work lease
  must be a positive whole number of milliseconds; request bodies are capped.
- Status codes: 401 no/bad/expired token, 403 not allowed, 404 unknown op, 409 conflict (key reused,
  stale claim, not open), 400 bad request, 413 too large.
- **Plain HTTP.** A bearer token is a password: terminate TLS in front (ingress, proxy), keep
  the port off the open internet. There is no push channel yet; hosts poll their inbox.
- Not in this phase: signature-based identity, multi-node Core, rate limiting, long-poll/SSE.

## Not built yet

- **Container-level environments** beyond what the lab shows (per-pod secrets, quotas, non-k3s clusters); the process-level file profile and the network-policy lab exist.
- Push delivery (SSE/long-poll), signature-based identity, a multi-node Core.

