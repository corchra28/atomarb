# Which figures in this repository rest on a single short sample

The market-size number was wrong by sixfold because it came from one 120-block census, and the
90% band at that sample size spans thirtyfold. That is a specific failure mode, and the honest
next step is to ask which other numbers here share it — rather than assume they do not.

Not every short sample is weak. The failure mode is specific: **a sum or a maximum over a
heavy-tailed distribution**, where a handful of observations carry most of the value and a short
window either catches one or does not. A proportion, a median, or a mean of a bounded quantity
converges quickly and a short sample is fine.

Sorting every quantitative claim in the repository by that test:

## Vulnerable — same shape as the number that was wrong

| claim | sample it rests on | status |
|---|---|---|
| Total Jito tips ≈ $68,600/day (`REAL_WORLD_MEV.md` §8) | **150 blocks**, top 50 tips carry 70.6% | remeasured at 3,000 blocks — see §8's update |
| "Capital saturates near $1,538" (`CAPITAL_AND_TARGETS.md`) | **96 transactions** from the 120-block census | remeasured against 4,548 circuits |

Both are sums or maxima over heavy tails, both came from windows an order of magnitude too short,
and the second is load-bearing: it is the reason the repository says more money buys nothing.

## Not vulnerable — bounded quantities, where a short sample is adequate

| claim | why it holds |
|---|---|
| DEX-versus-CEX gap, median −0.03 bps (n=13) | A basis-point spread is bounded and its mean converges fast. Independently confirmed by **160 denomination-matched samples** over ten minutes, none above 5 bps. |
| 130 cross-venue CEX observations, **zero** positive | A proportion, not a sum. Zero exceedances out of 130 is informative regardless of any tail. |
| USDC/USDT basis ≈ 7.5 bps | Bounded, and measured continuously over ten minutes with both venues agreeing to 0.01 bps. |
| Cross-venue scan: 4,046 circuits, 0 net positive | A count of exceedances against a threshold, not a sum. |

## Honest absences, already labelled as such

| claim | what it says |
|---|---|
| Liquidations: 2 in 150 blocks | Already reported as "too few to size", with no figure derived from it. |
| Sandwiching: 2 in 100 blocks | Already reported as **UNKNOWN**, with an explicit note that the detector requires one signer on both sides and a real bot would not. |

## Measured at scale, and therefore fine

These now come from the 3,000-block census — 4,548 circuits, 3.8 million transactions examined:

- median trade $0.00075;
- ten trades out of 4,548 carrying 65% of all profit;
- 156 distinct operators, with 91–100% of any earlier sample's operators reappearing;
- 1.52 circuits per block.

## One weakness that is not about sample size

The cross-venue scan prices a **static snapshot**. Arbitrage is transient, so a snapshot answers
"is a gap open right now" and not "how often does one open". That limitation is recorded in
`WIRING_DECISION.md` and is not fixed by a larger sample — it would need a different measurement,
repeated over time. The census already bounds the answer from the other direction, by counting
gaps that actually were taken.
