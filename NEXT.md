# Remaining work

What is not done after realms, channels, routing, the Jev classifier and the routing evaluation (all merged).
Each item says what blocks it. Delete an item when it is done; do not leave it half-ticked.

## Needs something from the operator

1. **Call the real Jev.** Blocked on: `openrouter.ai` (and/or `api.typesafe.ai`) added to the environment's allowed
   domains, `OPENROUTER_API_KEY` (or `JEV_API_KEY`), and an exact model id in `JEV_MODEL`. Then:
   `npm test` runs `test/jev.live.test.ts` (shape of a real answer), and
   `node src/eval/main.ts --classifier jev --send-to-external --dataset <yours>` measures it.
2. **A real routing dataset.** `eval/routing-synthetic.json` says nothing about real traffic. Needs the
   operator's own messages with the right destination (`expect`, or `null` for "stays unrouted"). Only then
   can `minConfidence` be chosen, and shadow mode be switched to enforce.
3. **Answer the environment/orchestration plan** (the doc "Piople: ympäristöt ja orkestrointi", section
   "Riskit ja avoimet päätökset", eight decisions). Blocks items 6 and 7.

## Can be built now

4. **Urgency (`score`) and direct TypeSafe access.** Blocked on verifying the request shape from TypeSafe's own
   docs (`docs.typesafe.ai`, blocked by the network policy here). Do not guess it.
5. **Remove members** (from a context and from a realm). Today membership can only be added or lowered.
   Effective capabilities already follow the realm, so removal from a realm is the natural first case.
6. **Per-harness environments** (tools, files, network) and their enforcement, starting at process level (E1 in the plan).
7. **OptChat memory.** The original centre of the project: a hierarchical, derived memory over agent
   transcripts, with `memory_zoom`. Decisions must stay structured events, never depend on a summary.
8. **Prevent two hosts serving the same actor.** Today the rule is one replica per actor. Needs a host lease in
   Core or a documented deployment constraint.

## Later, after the above

9. Kubernetes and Temporal adapters (E2, E3 in the plan). Kubernetes tests need a cluster (kind or k3d).
10. Push delivery (SSE or long-poll) instead of inbox polling; signature-based identity; rate limiting; a multi-node Core.
11. A continuously running human harness (a human uses the CLI today, a short-lived participant).

## Known limits to keep in mind

- A participant that omits `--after` on `submit` starts a new hop chain; the 100-waiting-messages cap is the backstop.
- A router sees every unrouted message (inherent to the role); the operator chooses who is one.
- Nothing has been run across two physical machines or in a cluster; remote processes were tested over localhost.
