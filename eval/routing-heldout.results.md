# routing-heldout: do the improvements hold on messages nobody tuned for? (2026-10-10)

`routing-heldout.json`: a second invented week (85 messages, same company and channels), **written and labelled before the first run and not relabelled afterwards**. It is still invented by the same author, so it is a check against over-fitting to `routing-story`, not evidence about real traffic.

Jev `typesafe/jev-1.13-20260917`, 3 runs each.

| set | keyword | Jev, no context | Jev, context 1 (+ channel-before-realm prompt) |
|---|---|---|---|
| routing-story (104, tuned on) | 18 | 67 / 67 / 67 | 75 / 75 / 75 |
| routing-heldout (85, not tuned on) | 25 | 49 / 48 / 48 | **59 / 59 / 59** |

The reply-context gain holds out of sample: +10 to +11 correct on 85 messages (58% to 69%), +8 on the tuned set (64% to 72%). Held-out is a little lower overall (69% against 72%), as expected.

Weak spots on the held-out set: terse messages (3 of 7), shared-word traps (0 of 3), "no access" (2 of 5), and `ch-design` conversations, which go to `ch-deploys` or `realm-infra` (the design channel's topics overlap with deploys and infrastructure).

## Gating on "a person is needed" (`needsHumanAbove`)

Jev also returns the probability that a person must decide (`noul`). Offline analysis on the story set (tuned) suggested that routing only when that probability is below 0.3 raises precision a lot. It was then run end to end (`--needs-human-above 0.3`, the router leaves such messages unresolved), 3 runs per set:

| set | minConfidence | routed / right | precision | coverage |
|---|---|---|---|---|
| story (tuned) | 0.8 | 28-31 / 27-29 | 94-97% | 27-30% |
| held-out | 0.8 | 22-23 / 20-21 | 91% | 26-27% |
| story | 0.7 | 32-36 / 30-34 | 91-94% | 31-35% |
| held-out | 0.7 | 25-28 / 23-26 | 92-93% | 29-33% |

Without the gate at 0.8 the same runs gave 88-92% (story) and 83% (held-out) at about 50% coverage. So the gate buys roughly +5 to +8 points of precision for about 20 points of coverage, and the gain is confirmed on the held-out set (83% to 91%). It is a trade: half of what could be routed is handed back to people.

Pooled over both sets (189 messages, run 1, minConfidence 0.8 + gate 0.3): 50 routed, 47 right, 94%, Wilson lower bound 84%. **Still short of "95% with confidence"**: the sample is small and the lower bound is 84%.

## Evaluation bug found on the way
The eval counted a message as routed when the classifier had chosen something, even if the router then held it back for `needs-human`; the first end-to-end gate run therefore showed no effect. Fixed (`predicted` is null for held-back messages); numbers above are from after the fix.

## Suggested shadow setting, not an enforcement recommendation
`minConfidence 0.7-0.8`, `needsHumanAbove 0.3`, `recentLimit 1`, Jev pinned to `typesafe/jev-1.13-20260917`, mode `shadow`. Compare with what people really chose for a few weeks before enforcing anything.
