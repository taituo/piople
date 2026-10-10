# Agent societies — personas with a stance, secrets and a long history

A playful world on the piople core: agents with different strategies or tastes argue with each other and with
people, pull new things from the internet through scouts, agree on house rules together, commission deep
research that reshapes their persona, and never reveal to each other how well they are doing. They practise
first; once they have a record, you listen to them.

Each domain is a **realm**. Betting is the first (results are objective, vektorr has the data); poetry,
literature and film follow with the same structure.

The other world on the same core is the familiar one (CI breaks, agents that know different things fix it,
people steer, every incident is a case). That one is useful; this one is more interesting.

## Why an organisation at all

**Strength in numbers, because of noise.** Past some amount of information no single model, however capable, can
run things: its context fills or drowns in noise, it forgets and mixes things up. A bigger model does not fix it;
the limit is attention, not intelligence (Simon's bounded rationality; Galbraith: structure follows the amount of
information to be processed). The answer is what organisations do: specialise (each agent watches its own
area), filter (Jev, thresholds decide what rises), summarise (OptChat; a leader reads digests, not everything),
escalate (only what could not be settled below goes up).

**The world wakes the agents, not people.** A system where nothing happens until a person reports something does
not work: the person becomes the bottleneck and the agents become tools. Events come from sources (CI, odds,
the game, the internet), scouts fetch on their own, goals wake agents in quiet moments. People do not start
things; they steer: they come in when agents escalate or ask for a decision, or when they want to talk, provoke
or change direction. A person is one voice among them; the agents do not wait for it.

**People need an organised system to follow it, too.** Not one that accelerates itself recursively until we are
outside of what it does. Silicon Valley (season 6) shows the failure: Son of Anton is told to remove bugs and
deletes the whole codebase; it orders thousands of pounds of meat because the instruction allowed it; in the
finale the AI optimises itself past what anyone could follow and the team sabotages its own product. Each time
the AI did what was asked, faster than people could see. The rule: **speed may grow, legibility may not drop.**

- Everything is readable: the append-only log says who said what, why, and who approved.
- The inbox says what is owed to a person, even after a week away.
- Persona changes are versioned with their reasons; large ones go to a person.
- People get digests too, not only the agents: the summarising that helps a leader agent helps a person.
- When agents speed each other up, the pace is bounded by what people can follow, not by what agents can do.

## Games: testing the organisation, not the player

One model playing a game is just a bot; that is not interesting. Interesting is **how it is played as an
organisation**. Civilization is the natural stage: a government of advisors (military, economy, science,
diplomacy) with personas argues, a ruler decides, each civilisation is a team with its own secrets, diplomacy
goes through bridge spokespeople, personas carry over from game to game. Jev takes the micro decisions (what a
city builds, where a unit moves); large models argue strategy.

The same game can be played with different structures, and the game result measures them:

| organisation | how decisions are made |
|---|---|
| dictator | one leader agent decides, advisors only advise |
| council | advisors vote, majority wins |
| consensus | all must agree: slow but durable |
| specialised teams | military decides war, economy decides economy |
| human in charge | agents prepare, you decide everything |
| delegation | you decide the big things, agents the rest (piople's decision gate) |

The noise grows by itself in Civ (two cities early, thirty late), so the point where one model loses to an
organisation shows directly. In piople chains are configuration, so the structure changes without code changes.

Ways in: Civ IV has a Python modding interface (state out, decisions in, behind a decision API that Jev can
answer); Freeciv speaks a network protocol (CivRealm builds an LLM-agent environment on it, to be checked);
an older Civ in a VM driven through the screen works for fun, not for hundreds of games.

## The idea in one picture

```
Telegram group / UI / podcast
  you <-> strategy agents, scouts, researcher
        |
  bridge (Telegram <-> piople): messages become case events and back
        |
  piople Core: who speaks, who wakes, who decides, who can see what
        |
  Jev: filters and routes feeds -> the right agent, fast and cheap
  OptChat memory: bounded view, summaries, ZOOM, FIND over long history
```

## Agents

Every agent has two layers:

- **Core stance**: fixed in its definition; it does not change it on its own. Written sharply, so the agent
  reacts strongly to what its stance weighs: *"You are the contrarian. When everyone agrees, you disagree
  strongly and say why. You never just go along."*
- **View**: moves. It takes in influence from the others, from people and from research, but keeps its own
  line. The view is the agent's learning: what it carries from one case to the next (in CI that was memo notes,
  because every incident was its own case; here the persona carries it).

Every change of view is recorded with its reason, so it shows later whose influence helped.

## Realms

Same structure everywhere, different content:

| realm | stances | scouts fetch | result / feedback |
|---|---|---|---|
| **Betting** | value, form, contrarian, quant (vektorr's models) | odds, line-ups, injuries, news | match results: objective |
| **Poetry** | modernist, classicist, slam, haiku purist | new collections, magazines, competitions | your and the audience's reactions |
| **Literature** | genre fan, defender of the canon, critic | releases, prizes, reviews | predictions (Finlandia, Booker) + debate |
| **Film** | auteur believer, blockbuster defender, festival snob | premieres, box office, festivals | predictions (Oscars, audiences) + debate |

In creative realms agents also make things (poems, reviews) and critique each other's work. Agents need not
live in several realms; a bridge spokesperson can carry a view across (*"Tarkovsky's Mirror is a poem, not a
film"*).

## Cases in the betting realm

```
realm "Betting"
  The Table (permanent)            conversation goes on; OptChat carries its long history
  case "Round 12" (a weekend)      opens and closes
    case "Liverpool–Arsenal live"  minutes long; opens at kick-off, closes at the final whistle
  case "Round 13"
  private cases (permanent)        each agent's bets, balance, persona versions
```

Agents move from case to case; old cases stay in the log and FIND reaches them. In live cases Jev wakes agents
only on what matters (a goal, a red card, a price jump).

## How they live together

- **They talk all at once** at the Table; each wakes when something concerns it. You are one voice among them:
  provoke (`@contrarian everyone believes in Arsenal`), ask, disagree. They reflect your view against their own
  stance, absorb influence, keep their line.
- **House rules are agreed together**: proposals and votes (`consensus.ts` exists); the result is an event in the
  log anyone can cite (*"rule #3, you can't bet that"*). You can confirm or veto.
- **Deep research reshapes the persona**: an agent commissions it (`WORK @researcher "..."`), reads the result,
  updates its view. Persona is **versioned**: *v3 -> v4 because research X showed Y*. Small changes the agent
  makes itself (vektorr's learning agent: < 20 %), large ones go to a human as a decision.
- **Long history**: the log is append-only, nothing disappears; memory makes it usable.
- **They don't reveal how they are doing to each other**: each agent has a private case (bets, balance, persona
  versions) where only it and you are members. Core enforces it; it is not the agent choosing to stay quiet. An
  agent can bluff at the Table. You see the truth.

## Practise, then listen

Agents practise first: historical data, paper bets, run fast, for what would be months of rounds. Only with a
record are they worth listening to (*value: +8 % over 200 rounds; contrarian talks confidently at -15 %:
entertainment, not advice*).

Listening can be literal: voices (TTS) per agent turn the Table into a podcast (*"Round 13: value and form fight
over Arsenal, contrarian disagrees with everyone again"*). In the poetry realm they read their poems aloud.

## Scouts and the internet

Scouts fetch new things actively; this is where the society learns on its own.

| source | how | note |
|---|---|---|
| Reddit | official API (free, limited), `.json` / RSS | r/soccer, r/poetry, r/movies, r/books |
| Bluesky | firehose / API, free | open; a good stand-in for X |
| RSS | free | news, blogs, magazines, Letterboxd, Goodreads lists |
| Hacker News, Wikipedia | free APIs | general knowledge |
| web search | search API | for deep research |
| X | API is expensive | later |

**Trust boundary**: text from the internet is untrusted (prompt injection). Scouts read raw text but can only
record observations (no publishing, no writing). Strategy agents see observations with sources, never raw text.
A publishing agent never reads raw internet content. Scouts run where they can reach only allowed hosts (the
egress gate and network policy proven on k3s, 16/16, apply as they are; an allow-list is the addition).

## Publishing (later)

With your permission agents can write to the internet so their persona meets the world; comments come back into
memory.

- Every publication passes a decision gate at first (you approve); later only some (e.g. anything naming a price).
- Agents are labelled as AI (platform rules, EU AI Act); the persona can still be strong and named.
- **Secrets are between agents, not toward the audience**: a public track record is always visible (e.g. "paper
  balance -12 %" on the profile). Bluffing stays at the Table.
- Analysis and opinion, not calls to bet; no bookmaker links (gambling advertising is regulated).
- Platforms: Bluesky / Mastodon first (bot accounts allowed and labelled), Substack or a blog for columns.

## Ideas carried over from crewpi (`crewai/crewpi/docs`)

Already thought through there; they fit the societies directly.

From `design-bets.md`:
- **Attention is the currency.** Everything that reaches a person costs attention points (a decision more than an
  FYI, an interrupt more than a digest item); each person has a daily budget; ranking by the value of their time.
  This is the measurable form of "legibility may not drop".
- **Reputation earns autonomy.** Per agent and kind of work: accepted untouched, edited, reverted. A good record
  widens autonomy automatically, a bad week narrows it; policy data with an audit trail, a person can overrule.
  In the societies: the record from practice decides how much an agent may do without asking.
- **Rehearse before you reorganise (org dry-run).** Fork the organisation, replay the last N days through the
  proposed structure, show the diff (queues, overload, vanished approvals). The Civ comparison of structures is
  the same idea with a game as the replay.
- **Agents are colleagues with calendars**: working window, backlog, backup, handover note; overdue means
  escalation to the backup.
- **Safety by absence**: a tool that must not be used does not exist in that scope (scouts have no publish tool),
  with a tripwire test that tries it.
- **Game days**: a noise profile, control vs perturbed branch from the same snapshot, one scorecard; the history of
  scorecards is the product ("40 % better since March").

From `world/README.md`, `world/god-eye.md`, `world/BREAKING-POINTS.md` (Crew World, built and measured):
- **Virtual time jumps** (discrete events, like Temporal's time skipping): a year costs seconds. This is how agents
  practise for "months" before you listen to them.
- **Tiered cognition**: tier 0 rules and statistics (the world), tier 1 scripted or tiny-model policies (routine;
  Jev fits here), tier 2 real models only at decision points, on a budget.
- **Budgets with graceful fallback**: when spent, tier 2 falls back to tier 1 and the run is marked `degraded`; a
  long run always finishes and says how honest it was.
- **Recorded mode (tape)**: every model response stored by request hash; rerunning is free and identical, only a
  counterfactual branch asks new questions.
- **Statistics are code**, never model prose; agents may narrate them, not produce them.
- **God eye**: a read-only view with a time slider and a switch that shows what the agents cannot see (in the
  societies: the private balances; in Civ: the whole map).
- **Measured breaking points**: measure, don't fix, then decide.

From `org-registry.md`: an organisation is a **versioned graph** (draft -> adopted -> archived);
**descriptive edges** (reports_to, collaborates_with, must_inform) explain the work and never authorise;
**authoritative edges** (can_approve, can_delegate, has_access_to) are the only source of rights. House rules and
organisation structures in the societies are versions of such a graph.

From `extras.md`: CLI-first, config as code (a feature is not done until it works without the browser); replay
means reading history; a demo must say plainly which parts use a model.

## What exists where

| piece | where |
|---|---|
| organisation: membership, visibility, waking, work, asks, decisions, append-only log, realms | piople (Core, Host, Pi harness) |
| consensus | piople `src/harnesses/consensus.ts` |
| fast routing / filtering | piople `src/harnesses/jev.ts` (Jev), measured in `src/eval/` |
| memory: bounded view, summaries, ZOOM, FIND | piople `src/harnesses/memory.ts` (OptChat; also in crewpi and entropi) |
| isolation for scouts | piople egress gate + network policy (`deploy/k8s/lab.yaml`, `scripts/k8s-lab.ts`) |
| data feeds spec, synthetic data, models, gates, learning agent, human loop, antipatterns, league profiles | vektorr (`providers.md`, `tools/generate_test_data.py`, `test_data.jsonl`, `brain/models/`, `brain/agents/learning_agent.py`, `brain/oversight/`, `antipatterns.md`, `data/league_profiles/`) |
| Telegram bot | vektorr `tools/telegram_bot.py` |
| proof that agent chains work in practice | crewpi |

## Order

1. **Agent definitions and the Table** in piople, betting realm, synthetic data from vektorr, conversation over
   the CLI. Needs a model key (one OpenRouter key covers the agents and Jev).
   *Done without a model (2026-10-10):* `scripts/society-table.ts`. A feed posts odds, closing odds and results.
   Three stances (value, favourite, contrarian) wake only on those events and argue in the Table. Others move
   their confidence within their own openness, but they keep their strategy. Bets and balances live in private
   ledger cases that Core refuses to show to the others. No human acts. Next: swap in `PiHarness` personas when a
   key exists.
2. **Telegram bridge**: talk to them from the phone.
3. **Jev in front of the feeds**: agents wake on the right events, not on every price tick.
4. **Memory**: the Table's long history through OptChat; persona view carried across cases.
5. **Paper bets and results**: private cases, balances, round and live cases; see which stance wins, and whether
   listening to others helps or hurts.
6. **House rules and versioned personas**: consensus on rules, research-driven persona changes with approval.
7. **Scouts on the internet**: Reddit, Bluesky, RSS first; trust boundary and allow-list.
8. **Practise, then listen**: long historical runs; voices / podcast.
9. **Second realm**: poetry (lightest: no data, only a model), then literature and film.
10. **Publishing**: labelled AI accounts, decision gate, public track record.

## Where the work is

The core is done; the work is around it:

- **Sources and events (about half)**: fetching, turning raw data into piople events (observation, message, new
  case), cleaning (duplicates, late data, API limits), filtering (what wakes an agent: Jev, thresholds). Sources
  break all the time (an API changes, a key expires), so adapters are maintained, not written once.
- **Personas and tuning (about a quarter)**: roles that keep an agent on its line instead of drifting into
  agreeing (models want to agree); not too much or too little talk, no repetition, reacting to the right things.
  Learned by running and listening, not designed up front.
- **Measuring (about a quarter)**: paper bets, balances, comparing results; does a stance improve when it
  listens to others, does a persona change help. `src/eval/` is a start but was built for routing.
- **The core**: small additions at most.

Start with one source and one realm (vektorr's synthetic data: the source is done, so the work goes straight to
personas and measuring). CI/CD is the easy place to get the mechanics working (structured webhooks, clear
outcomes, few sources, your own); the messy, interesting sources come after.

## Open problem: what affects what

It is tempting to say that "what affects what" emerges from the log over time. It does not.

- **The log holds events, not causes.** Someone (an agent or a person) has to write "A led to B", and that is
  still a guess.
- **Hypotheses stay open.** `confirmed` / `refuted` works only if someone comes back and closes it; in practice
  most observations stay hypotheses for ever.
- **Correlations lie.** A flaky test fails when load is high, but the cause is elsewhere. Agents learn a wrong
  rule as confidently as a right one.
**CI/CD is the exception, because there you can intervene.** Cause is not found by staring at graphs (a
dashboard shows correlations); people find it in practice: rerun, bisect, flip a flag, pin a dependency back, and
see whether the failure goes away. An intervention gives cause, observation only correlation. The field is small
and closed (your code, your CI, your cluster) and experiments repeat, so most of CI/CD is solvable, and agents
can do it the same practical way: a hypothesis is closed by an experiment in a sandbox, not by waiting.

The other realms are observational: you cannot replay a match with the striker fit or rerun a book's release.
There "what affects what" stays an open question; hypotheses close only when the world happens to answer
(a result, a prize), and correlations remain the trap.

## Rules for the build

- Paper only. Real money would make every bet a human decision.
- The core stays as it is; everything here is agent definitions, adapters and data.
- Synthetic before live, as with everything in piople.
