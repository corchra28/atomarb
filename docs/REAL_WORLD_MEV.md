# What the winners actually do — an on-chain census

> **Read this first.** This document is chronological: it records what was measured when, including
> the figures that were later found wrong. **The current numbers are in §12**, from a 3,000-block
> census examining 3.8 million transactions:
>
> | | |
> |---|---|
> | Whole atomic-arbitrage market | **~$124,000 a day** (1,102 SOL) |
> | Median winning trade | **$0.00075** |
> | Share taken by ten trades out of 4,548 | **65%** |
> | Distinct operators, and how many persist between windows | **156**, 91–100% |
>
> The **$21,000 a day** that appears in §2 and §5 below came from a 120-block census whose 90%
> band spans **thirtyfold**. It is left in place because the record of what was believed, and how
> it was corrected, is the more useful artefact — but it is not the answer.

Two audits in this repository returned `NO_VERIFIED_EDGE`. Both asked "can I find a gap?" That is the wrong question, and it is the question a beginner asks. The question a practitioner asks is **"who is taking the money right now, how much, and through what?"**

That is answerable directly, because every arbitrage that lands is public. This document answers it by reading blocks.

**Method.** Read recent confirmed blocks and find transactions that **close a circuit**: the fee payer's non-SOL token balances all return to where they started, and the only thing that changes is SOL, upward. That shape is what separates a searcher from an ordinary user selling a token into SOL through an aggregator. Reported profit is take-home, net of the transaction fee and net of any tip paid for block position.

Read-only, `getBlock` only. Nothing signed, submitted or funded. Script: `docs/sources/realworld/arb_census.ts`.

| | |
|---|---|
| Sample | 120 blocks, stride 9, spanning about 4.8 minutes of chain |
| Transactions examined | 135,552 (115,553 successful) |
| Touching two or more AMM venues | 4,155 |
| **Verified profitable atomic arbitrages** | **104** |
| Distinct signers | 51 |

Two of the 104 were checked by hand against the chain, and the arithmetic reconciles exactly. One shows four mints returning to a delta of zero, wrapped SOL up 5,198,641 lamports, native SOL down 96,451 for fee and tip, take-home 5,102,190.

---

## 1. The first answer: yes, it works

104 people made money doing exactly this, atomically, in one transaction, in under five minutes of chain time. The strategy is real and it is not theoretical. Anything that says otherwise is wrong.

That corrects the framing of the two previous audits. `NO_VERIFIED_EDGE` was an accurate statement about **what I built**. It was never a statement about the strategy.

## 2. The second answer: it is worth almost nothing

| Take-home per trade | lamports | USD |
|---|---:|---:|
| median | 24,585 | **$0.0026** |
| 90th percentile | 1,548,368 | $0.16 |
| best single trade in the sample | 20,107,425 | **$2.13** |

Summed across **every searcher on the network**:

| | |
|---|---|
| Total take-home, 120 blocks | 0.0742 SOL = **$7.84** |
| Per block | **$0.065** |
| Extrapolated per day | ~$21,000 — **superseded, see §12: ~$124,000** |

That last figure is the entire atomic-arbitrage prize pool on Solana, split between everyone competing for it. It is an order-of-magnitude estimate from 32 seconds of chain time, not a precise number, and it covers **atomic arbitrage only**. Sandwiching, liquidations and just-in-time liquidity are separate categories; §8 measures how much room is left for them and finds it is far less than I assumed when I first wrote this line.

A new entrant with no latency advantage is competing for a share of that against 51 incumbents — 156 of them at the larger sample size — and the median winning trade pays well under a cent.

## 3. The third answer: never in the shape I built

This is the part that matters for the code in this repository.

| Combination | Count |
|---|---:|
| Arbitrages using **only** Raydium CPMM + PumpSwap, the two adapters here | **0 of 104** |
| Using both, alongside a third venue | 1 of 104 |
| Touching at least one of the two | 45 of 104 |
| **Including at least one concentrated-liquidity venue** | **98 of 104 (94%)** |

The most common combinations:

| Count | Venues |
|---:|---|
| 11 | Meteora DLMM + Orca Whirlpool |
| 9 | Orca Whirlpool + Raydium CPMM |
| 8 | Meteora DLMM + PumpSwap AMM |
| 7 | Meteora DAMM v2 + PumpSwap AMM |
| 5 | Orca Whirlpool + Tessera V |
| 4 | Meteora DLMM + Orca Whirlpool + Raydium CPMM |
| 4 | Raydium AMM v4 + Raydium CLMM |

**The edge does not live between two constant-product pools. It lives between a concentrated-liquidity venue and something else.** Two constant-product curves of the same token track each other too closely to diverge past their own fees, which is precisely what the whole-chain radar measured when it found 122 wide-gap pairs and zero net positives. A concentrated-liquidity pool prices in ticks and can sit stale inside a range while an AMM moves continuously. That is where the divergence comes from.

The engine's two adapters are not useless: they appear in 45 of the 104 winning routes. They are just never *both sides*. Every time one of them is in the money, the other side is a Whirlpool, a DLMM, a CLMM or a DAMM v2.

This was item 3 on the "next decisive test" list in `DECISION.md`, ranked third, on a hunch. It should have been first, and now it is measured rather than guessed.

## 4. The fourth answer: the cost model was wrong in both directions

| | |
|---|---|
| Real arbitrages paying **only** the 5,000-lamport base fee, no priority fee at all | **58 of 104** |
| Median fee actually paid | 5,000 lamports |
| 90th-percentile fee | 59,096 lamports |
| Real winning trades whose **entire profit** is below the engine's assumed 9,000-lamport cost | **43 of 123** |
| Paying a tip for block position | 51% |
| Median tip | 1,000 lamports |

The engine assumed a flat 9,000 lamports per attempt. More than half of the real winners pay 5,000, and more than a third of all winning trades take home less than 9,000 in total. The engine's floor was set above the entire prize on a third of the real opportunity set, so those opportunities were invisible to it by construction.

**Correction to my own first reading of this.** I initially wrote that a majority pay nothing for block position and concluded this is won on latency rather than bidding. That was wrong, and it was wrong because I looked at the priority fee alone. Splitting it properly:

| | |
|---|---|
| Paying only the 5,000-lamport base fee | 58 of 104 |
| …of those, also paying a Jito tip | **55 of 58** |
| Paying nothing at all for position | **3 of 104** |
| **Paying something for position, by either channel** | **101 of 104** |

Searchers here bid through the tip, not through the priority fee, so a low priority fee reads as "not bidding" only if you forget to look at the other channel. It is an auction after all.

The three that pay nothing are worth **$167 a day network-wide** out of the total. Whatever the total turns out to be, there is no quiet lane.

Compute consumed sits at a median of 138,381 units, so these are short routes: 85 of 104 are two-venue circuits, 35 are three-venue, 3 are four-venue.

---

## 5. What this means, plainly

The honest summary of all three audits together:

1. **Atomic on-chain arbitrage works and is being done profitably right now.** The previous verdicts were about my implementation and my measurement window, not about the strategy.
2. **The total prize is about $124,000 a day for everyone combined** (§12; this line originally said $21,000, from a census ten times shorter), with a median trade worth well under a cent. It is a volume business, not a margin business.
3. **It is an auction, and you have to be fast enough to enter it.** 101 of 104 winners pay for block position, nearly all through the Jito tip. Latency gets you to the auction; the tip wins it. Competing means a co-located node with a direct block-engine or shred feed, not polling a public RPC every four seconds and not a websocket subscription either.
4. **The venue pair matters more than anything else in the engine.** Constant-product against constant-product is the one combination that provably does not pay. Concentrated liquidity against anything is 94% of the real winners.

**What would actually change the result,** in order:

1. Implement an Orca Whirlpool or Meteora DLMM adapter and pair it against the existing Raydium CPMM and PumpSwap adapters. That single change moves the engine from a combination that appears in 0 of 104 winners to combinations that appear in 45 of them.
2. Drop the flat 9,000-lamport assumption and price the fee per attempt from the actual base fee plus the tip the route can afford. A third of the real opportunity set sits under the old floor.
3. Replace polling with a direct feed. Until then the engine is looking at a state that the winners have already traded against.

**What a realistic person concludes.** Even with all three fixed, the addressable prize is a fraction of $21,000 a day, contested by 51 incumbents who already have the infrastructure. The engineering is tractable; the economics of entering are not. That is a different and more useful answer than "no edge exists", and it is the one the data supports.

---

## 6. Limits of this measurement

- 120 blocks is about 32 seconds of chain time. The daily figure is order of magnitude.
- Atomic single-transaction arbitrage only. Multi-transaction strategies, sandwiching, liquidations, just-in-time liquidity and exchange-versus-chain flow are not counted and are larger.
- A searcher who routes profit to an account other than the fee payer is missed by the classifier. 12 of the 123 candidates had no token account owned by the signer and are excluded from the strict count of 104 for that reason.
- Venue labels cover 25 programs. An arbitrage between two venues not on that list is not counted, which biases the count down and makes the concentrated-liquidity share a floor rather than a ceiling.
- SOL priced at $105.75 throughout.

---

## 7. The distribution is the whole story

| | |
|---|---|
| Share of all profit taken by the **top 3** trades of 104 | **56%** |
| Share taken by the top 10 | **81%** |
| Median trade | $0.0026 |

This is not a business with a steady trickle. It is a handful of large hits carrying everything, and those hits are precisely the contested ones that go to whoever is fastest. Winning the long tail instead is not an alternative: the entire uncontested tail is worth $167 a day across the whole network.

So the realistic arithmetic for a new entrant, stated plainly: to earn anything you must win contested opportunities; to win those you need a co-located node and a direct feed, which costs $500 to $2,000 a month; and you are bidding against 51 incumbents who already have both. There is no configuration of this where the expected return covers the running cost.

---

## 8. How big is the rest of it?

Section 6 admits this census covers atomic single-transaction arbitrage only, and calls the other categories "larger". That claim was never measured, so it gets measured here.

**Total tips are the cleanest proxy for the whole market.** Every MEV bundle pays for block position, so the sum of lamports flowing into Jito tip accounts is a floor on what MEV is worth to the people doing it, across every category at once. Over 150 blocks and 141,889 successful transactions:

| | |
|---|---|
| Transactions paying a tip | 3,339 (2.4% of successful) |
| Median tip | 1,995 lamports, about $0.0002 |
| **Total tips, extrapolated** | **~$68,600 a day** |
| Same, excluding the ten largest tips | ~$37,900 a day |
| Share of all tips taken by the top 50 | **70.6%** |

**A correction on the way to that number.** A first pass over 60 blocks returned $413,000 a day. One transaction in that sample tipped 0.517 SOL and carried 72% of the total. Re-running over 150 blocks brought it to $68,600, a factor of six lower. The first figure was one observation wearing a daily rate as a costume, and it is exactly the error this repository keeps catching elsewhere.

**What that implies for the pie.** Tips are what participants pay, not what they keep. Atomic arbitrage take-home was measured at about $21,000 a day. Against $68,600 a day in total tips across every MEV category, the honest reading is that total extracted MEV sits in the low hundreds of thousands of dollars a day at most, and that atomic arbitrage is a real share of it rather than a rounding error.

The premise behind "you measured the small corner" does not survive. **The whole market is small.**

> **This bound no longer holds as stated — see §10.** The evening census puts atomic-arbitrage
> take-home alone at $107,350 a day, which *exceeds* the $68,600 total-tips figure above. That is
> not a contradiction between the two quantities (searchers keep more than they bid, so take-home
> can exceed tips), but it does break the argument built on top of it: tips cannot bound the pie
> at "low hundreds of thousands at most" when one category's take-home is already larger than the
> measured tips. The tips figure has the same weakness as the original take-home figure — one
> 150-block sample, with the top 50 tips carrying 70.6% of the total. Read both as
> order-of-magnitude, and read this paragraph's conclusion as unproven rather than established.

### Liquidations

| | |
|---|---|
| Lending-protocol transactions seen | 13 in 150 blocks |
| Of which liquidations | **2** |

Too few to size. Whatever liquidations are worth, they are not a steady stream at this frequency, and the two observed sent no profit to the fee payer's native balance, so a measurement would need to follow the collateral rather than the lamports.

### Sandwiching — what I could not establish

Conservative detection: two successful transactions in one block by the same signer, sharing a pool account, with a different signer's transaction between them touching that same account, and the bracketing signer ending up ahead.

Across 100 blocks and 14,580 DEX transactions this found **2**, worth $12.96 and $0.003.

**That is not a size estimate and must not be read as one.** Two observations cannot support a daily figure, and the detector requires the same signer on both sides, which is the one thing a sandwich bot has every reason not to do. A real measurement needs front and back matched by pool and direction across *different* signers, which this does not attempt. The honest status is UNKNOWN, and the $68,600 a day in total tips is the bound that actually constrains it.

I am not building a sandwich bot. It profits by making an ordinary user's swap fill worse, and the gain is exactly the user's loss. Measuring the market to understand it is one thing; running that particular extraction is another, and it is not work I will do.

---

## 9. What happened when the recommendation in §5 was carried out

§5 ranked "implement an Orca Whirlpool or Meteora DLMM adapter" first, on the grounds that it
"moves the engine from a combination that appears in 0 of 104 winners to combinations that appear
in 45 of them". That was done — all three adapters now exist, each with its quote proven equal to
the on-chain program and a mutation suite that catches every mutation.

The measurement that followed is in `DECISION.md`. The short version: the coverage argument was
right about coverage and did not change the answer.

| | |
|---|---:|
| Pools scanned across the three venues | 362,514 |
| Mints with WSOL pools on 2+ **different** venues | 10,129 |
| Circuits priced, every one with a concentrated-liquidity leg | 4,046 |
| Positive gross | 4, best **1,892 lamports** |
| Positive net | **0**, at the 9,000-lamport assumption and at the 5,000 base fee alone |

The best gross result is 2.5 times what the constant-product-only radar could find, which is the
coverage improvement appearing exactly where §5 predicted it would. It is still five times short
of the fee. `NO_VERIFIED_EDGE` stands, and the reason has moved from coverage to the auction
measured in §4 and §7.

### A failure mode this document should have warned about

The first run of that scan reported a **371% return** — 0.371 SOL net on 0.1 SOL in — plus six
smaller net-positive circuits. Running each leg against the real program in LiteSVM returned SPL
Token error 17, `Account is frozen`, on every one.

They were stale prices on tokens whose accounts are frozen, unarbitraged for the plain reason that
the swap cannot execute. Jupiter refuses to route either token (`TOKEN_NOT_TRADABLE`) and one
carries a live freeze authority. A guard rejecting any pool that holds a frozen token account
removed 24 circuits and took the net-positive count from 7 to 0.

**The counter-intuitive part: the better a scanner's pool coverage, the more of these it finds.**
Abandoned pools are exactly where large stale prices survive. Any census or scan of this kind
needs the frozen check before it quotes, or its most exciting results will all be phantoms.

---

## 10. Correction: $21,000 a day was a low sample

> **Read §11 with this.** This section reports a fivefold difference between a morning and an
> evening census and leaves time of day as the natural reading. A third census tested that and it
> is wrong: two samples 25 minutes apart in the same regime differ by 3.1x, which is exactly what
> sampling noise predicts at this census size. The size correction below stands; the implied
> explanation does not.

Every conclusion in this document rests on one number, and that number had **one observation**
behind it: 120 blocks, about 32 seconds of chain, at 09:00 UTC on a Friday. That is a sample of
one drawn from a heavily skewed distribution, which is exactly the shape where a single sample
misleads.

Repeating the census 13 hours later, at 22:20–22:45 UTC the same day, with a larger sample:

| | 09:00 UTC, 120 blocks | 22:20 UTC, 300 blocks |
|---|---:|---:|
| Verified circuits | 104 | **453** |
| Circuits per block | 0.87 | 1.51 |
| Total take-home, extrapolated | 200 SOL/day = **$21,173** | 947 SOL/day = **$107,350** |
| Same, excluding the ten largest trades | 38 SOL/day | 170 SOL/day |
| Median trade | 24,585 lamports = $0.0026 | 7,716 lamports = **$0.00087** |
| Top ten trades' share of all profit | 81% | 82% |
| Distinct signers | 44 | 81 |

**The market is roughly five times larger than this document claimed.** The tail scales with it
(4.5x), so it is not one whale distorting a total — the whole distribution shifted up.

A caution on method: a third run was launched at 22:45 and its slot range turned out to overlap
the second's, sharing 53 identical transactions. It is not an independent observation and is not
counted as one. What is reported above is the larger of the two overlapping evening runs. So this
is **two** independent samples, not three, and two is still few.

### What does not change, and why the conclusion stands

Three things are the same in both samples, and they are the ones that decide whether this is
enterable:

- **The concentration is identical.** The top ten trades take 81% of all profit in the morning and
  82% in the evening. Whatever the market's size, the money is in a handful of contested trades.
- **The operators are the same people.** 33 signers appear in both samples, 75% of the smaller
  set, thirteen hours apart. This is a stable roster of incumbents, not a rotating crowd.
- **The median trade got smaller as the market got busier** — $0.0026 down to $0.00087. More
  activity meant thinner margins per trade, not fatter ones.

So the correction is to the size, not to the shape. A new entrant still faces the same problem:
the money is in the contested head, the head goes to whoever is fastest, and the same operators
are there at every hour sampled.

### The methodological lesson, which is the durable part

**A 120-block census extrapolated to a day is unreliable by about a factor of five.** Nine minutes
of chain is not a day, and on a distribution where ten trades carry 82% of the value, the sample
either catches a big one or it does not.

Any figure in this repository derived from a single short census should be read as an
order-of-magnitude estimate with a wide band, not a measurement. The honest range from what has
actually been sampled is **$21,000 to $107,000 a day**, and the true figure could sit outside it.
**It did:** §12 measures it at about $124,000 from a sample ten times larger.

---

## 11. The band does not narrow, and it is not the hour

§10 reported a fivefold difference between a 09:00 and a 22:20 census and offered time of day as
the obvious reading. A third census tests that directly, and the obvious reading is wrong.

Sample C was taken **25 minutes after** sample B, in an all-but-identical regime (chain at 4,500
transactions per second against 5,000, SOL one-minute sigma 6.89 basis points against 6.96), with
the same 300-block size and a **disjoint slot range**.

| | A, 09:00 UTC | B, 22:20 UTC | C, 22:45 UTC |
|---|---:|---:|---:|
| blocks | 120 | 300 | 300 |
| circuits | 104 | 453 | **490** |
| total, extrapolated | 200 SOL/day | **947 SOL/day** | **301 SOL/day** |
| median trade | 24,585 | 7,716 | 6,155 |
| top ten's share | 81% | 82% | 71% |

**B and C differ by 3.1x, 25 minutes apart, in the same regime — and C has more circuits than B.**
Whatever is moving the total, it is not the hour.

### What is stable and what is not

| quantity | spread across the three samples |
|---|---:|
| concentration (top ten's share) | **1.16x** |
| circuits per block | 1.88x |
| median trade | 3.99x |
| tail, excluding the top ten | 4.45x |
| **total** | **4.73x** |

### The band is exactly what sampling noise predicts

Bootstrapping from all 1,047 circuits observed across the three samples, resampling totals at
various census sizes (`docs/sources/realworld/bootstrap.py`):

| census size | 90% band (p05 to p95) |
|---:|---:|
| 120 blocks | **6.9x** |
| 300 blocks | **3.4x** |
| 1,000 blocks | 1.9x |
| 3,000 blocks | 1.5x |
| 10,000 blocks | 1.2x |
| 30,000 blocks | 1.1x |

The observed B-to-C ratio of 3.1x sits inside the 3.4x band predicted for a 300-block census. **No
time-of-day effect is needed to explain any of the variation.** The original 120-block census had
a 6.9x band around it, which is why $21,000 a day was never a measurement.

### What would settle it, and whether it is worth settling

Ten thousand blocks — about 44 minutes of contiguous chain — brings the band to 1.2x, or roughly
±20%. Thirty thousand gets to ±10%. Adding more short samples at more hours does nothing, because
the variance is *within* a regime, not between regimes.

**It is not worth settling, and here is why.** Every conclusion this repository draws rests on the
quantities in the stability table above, not on the total:

- the concentration, which varies by 1.16x and says the money is in a handful of contested trades;
- the signer persistence — 70–75% of operators appear in any two samples, at any hour;
- the median trade, which is between $0.0007 and $0.0026 in every sample, all of them negligible;
- capital saturation near 100 SOL, with returns collapsing from ~40 bps to 0.1 bps above it (`CAPITAL_AND_TARGETS.md` §3).

A better total would move the headline and change nothing else. The honest statement is that the
whole atomic-arbitrage market is **somewhere in the low hundreds of thousands of dollars a day**,
known to about a factor of three, and that is precise enough for every use this repository makes
of it.

---

## 12. The measurement, done properly, and the correction to §11's own arithmetic

A 3,000-block contiguous census — 13 minutes of chain, **3,804,800 transactions examined**, 4,548
verified circuits — is the best measurement in this repository.

| | A, 120 blk | B, 300 blk | C, 300 blk | **D, 3,000 blk** |
|---|---:|---:|---:|---:|
| circuits | 104 | 453 | 490 | **4,548** |
| circuits per block | 0.87 | 1.51 | 1.63 | **1.52** |
| total, extrapolated | 200 SOL/day | 947 | 301 | **1,102 SOL/day** |
| in dollars | $21,173 | $107,350 | $34,045 | **$124,447** |
| median trade | 24,585 | 7,716 | 6,155 | **6,621** |
| top ten's share | 81% | 82% | 71% | **65%** |
| distinct signers | 44 | 81 | 85 | **156** |

**Best estimate: about 1,100 SOL a day, roughly $124,000.** The largest single arbitrage in the
window took home 2.37 SOL.

### §11's bootstrap was too optimistic, and by a lot

§11 bootstrapped from the 1,047 circuits then observed and predicted a 1.5x band at 3,000 blocks.
Resampling from this sample's own distribution instead:

| census size | honest 90% band | chain time |
|---:|---:|---:|
| 120 blocks | **30.7x** | 1 min |
| 300 blocks | **15.2x** | 1 min |
| 1,000 blocks | 5.0x | 4 min |
| 3,000 blocks | **2.5x** | 13 min |
| 10,000 blocks | 1.6x | 44 min |
| 100,000 blocks | 1.2x | 7.4 hours |

The reason the earlier table was wrong is worth stating: it resampled from short censuses whose
largest observed trade was 204 million lamports. This one contains a trade of **2.37 billion** —
eleven times larger. A bootstrap can only reproduce a tail it has already seen, so **every
bootstrap from a short sample understates the variance of a heavy-tailed sum.**

That also means §11's claim that 10,000 blocks buys ±20% was wrong. It buys about ±27%. Reaching
±20% takes roughly 100,000 blocks, or **seven and a half hours of contiguous chain**.

So the honest framing of the original number: **$21,000 a day was a 120-block draw from a
distribution whose 90% band at that size spans thirty-fold.** It was not a low estimate. It was
not an estimate.

### What ten times the sample size did NOT change

This is the part that carries the conclusions, and it holds:

| | short samples | 3,000 blocks |
|---|---|---|
| median trade | $0.0007–$0.0026 | **$0.00075** |
| circuits per block, evening | 1.51–1.63 | **1.52** |
| top ten's share | 71–82% | **65%** |

And the signer persistence got *stronger*, not weaker, at scale:

- **91%** of the morning census's signers reappear in this one;
- **96%** of sample B's;
- **100%** of sample C's — every operator seen at 22:45 is in the 22:50 window.

156 distinct operators in thirteen minutes of chain, and essentially all of the ones seen earlier
are among them. This is a closed, stable roster. That is what "latency-gated" looks like from the
outside: not a crowd that rotates, a fixed set of people who are always there.

### The bottom line, restated with the right number

The market is **about six times larger** than this document originally claimed, and the conclusion
is unchanged, because it never rested on the total. It rests on a median trade worth three
quarters of a thousandth of a dollar, sixty-five per cent of the money sitting in ten trades out of
four and a half thousand, and the same hundred and fifty-odd operators present in every window
sampled.

---

## 13. §8 was wrong about the size of the rest, and by how much is now partly measurable

§8 measured total Jito tips at ~$68,600 a day from **150 blocks** and concluded from it that "the
whole market is small". Both halves of that need replacing.

**The tips figure itself.** Remeasured over 3,000 contiguous blocks — 3,036,263 successful
transactions, **88,658 of them paying a tip**:

| | 150 blocks | **3,000 blocks** |
|---|---:|---:|
| total tips, extrapolated | $68,643/day | **$147,960/day** |
| share taken by the top 50 tips | 70.6% | **40.2%** |
| share taken by the single largest | 72% (of the 60-block pass) | 4.1% |
| median tip | 1,995 lamports | 2,722 lamports |

At 88,658 observations the distribution is far better resolved than the arbitrage one, and much
less concentrated. **$147,960 a day is a real measurement**, not an order of magnitude.

### What fraction of that does arbitrage pay?

The census and the tips measurement cover **disjoint** 3,000-block windows about twenty minutes
apart, so this compares like with like:

| | SOL/day |
|---|---:|
| tips paid by verified arbitrage circuits | 108 |
| tips paid by everything | **1,310** |
| **arbitrage's share of all tip spending** | **8.2%** |

Arbitrage keeps 1,102 SOL a day and pays 108 — a **10.2x** ratio of kept to bid.

### What follows, and what does not

**Follows:** 91.8% of all spending on block position comes from activity this repository has not
measured. Whatever those categories are, they collectively outbid atomic arbitrage by more than
eleven to one. §8's "the whole market is small" does not survive that.

**Does not follow:** a number for total MEV. If every category kept 10.2x what it bids, the total
would be about 13,400 SOL a day, some $1.5 million. That figure is an *extrapolation resting on an
assumption that is probably false*: a heavily contested category bids away more of its edge than a
quiet one, so the keep-to-bid ratio is almost certainly lower elsewhere than in the obscure corners
where atomic arbitrage survives. The honest bound is that total MEV take-home is **larger than
atomic arbitrage's $124,000 a day, by an unknown multiple**.

### Does this change the conclusion? No, and it is worth being precise about why

This repository's verdict is about **atomic cross-pool arbitrage**, which is now measured
directly: $124,000 a day, 156 operators, ten trades out of 4,548 carrying 65% of it, median trade
$0.00075. None of that moves because a different category turns out to be bigger.

What it does change is any sentence implying the *whole* MEV space is small. It is not. It is
mostly somewhere else, and §5 of this document already named where: the categories that were not
measured here are sandwiching, just-in-time liquidity and exchange-versus-chain flow. Sandwiching
profits by making an ordinary user's swap fill worse, which is why it is not built here — but its
size is no longer something this document can call small.

### One thing that got sharper rather than softer

Liquidations: **284 lending-protocol transactions in 3,000 blocks and zero liquidations.** The
earlier reading of 2 in 150 blocks was noise. At this sample size the honest statement is that
liquidations are not a meaningful revenue stream on the timescale sampled.
