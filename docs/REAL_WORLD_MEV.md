# What the winners actually do — an on-chain census

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
| Extrapolated per day | **~$21,000** |

That last figure is the entire atomic-arbitrage prize pool on Solana, split between everyone competing for it. It is an order-of-magnitude estimate from 32 seconds of chain time, not a precise number, and it covers **atomic arbitrage only** — sandwiching, liquidations, just-in-time liquidity and exchange-versus-chain flow are separate and larger categories not measured here.

A new entrant with no latency advantage is competing for a share of $21,000 a day against 51 incumbents. The median winning trade pays a quarter of a cent.

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

Note what the fee distribution says about how this is won. A majority pay no priority fee and no tip. They are not outbidding anyone. They are **first**, which is a latency property, not a budget property. The half that do tip pay a median of 1,000 lamports. This is not an auction that money wins.

Compute consumed sits at a median of 138,381 units, so these are short routes: 85 of 104 are two-venue circuits, 35 are three-venue, 3 are four-venue.

---

## 5. What this means, plainly

The honest summary of all three audits together:

1. **Atomic on-chain arbitrage works and is being done profitably right now.** The previous verdicts were about my implementation and my measurement window, not about the strategy.
2. **The total prize is about $21,000 a day for everyone combined**, with a median trade worth a quarter of a cent. It is a volume business, not a margin business.
3. **It is won on latency, not on capital or on fee budget.** A majority of winners pay the base fee and no tip. Competing means seeing state before the next person does, which means a co-located node with a direct block-engine or shred feed, not polling a public RPC every four seconds and not a websocket subscription either.
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
