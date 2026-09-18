# Two questions answered with measurements

1. If the arbitrage process were fully automated and run with a given sum, what would the profit be?
2. Which protocols are worth approaching, and which have a missing or stale Jupiter integration?

---

## 1. The capital question: it saturates at about $1,500

> **Superseded by §3.** This section rests on 96 transactions from a 120-block census. Remeasured
> over 641 transactions from a 3,000-block census, the largest deployment observed is **302 SOL
> ($34,126)**, not $1,538 — twenty-one times higher — and the saturation point is **about 100 SOL
> (~$11,000)**. The conclusion that more capital buys nothing beyond saturation is unchanged and
> in fact sharper; only the number moved. The reasoning below is left as the record of how it was
> first measured.

The census in `docs/REAL_WORLD_MEV.md` recorded 104 verified winning arbitrages but not their trade sizes. This adds that: for 96 of them the transactions were fetched and the largest single wrapped-SOL transfer measured, which for a WSOL circuit is the capital the searcher actually put at risk.

Script: `docs/sources/realworld/capital_per_arb.ts`. Data: `capital_per_arb.json`.

### What a winning trade actually costs to run

| | SOL | USD |
|---|---:|---:|
| 10th percentile | 0.0006 | $0.07 |
| **median** | **0.0235** | **$2.49** |
| 90th percentile | 0.9885 | $104.53 |
| largest in the sample | 14.5432 | $1,537.94 |

Return on the capital deployed, for that one trade: median **10.86 bps**, 90th percentile 398 bps, best 4,526 bps.

### The finding that answers the question

**Profit does not scale with capital, and the biggest trades are the worst ones.**

| Capital deployed | Profit | Return |
|---:|---:|---:|
| 14.543 SOL | $0.02 | 0.1 bps |
| 12.430 SOL | $0.27 | 2.0 bps |
| 11.753 SOL | $0.30 | 2.4 bps |

against the most profitable trades in the same sample:

| Capital deployed | Profit | Return |
|---:|---:|---:|
| 1.073 SOL | $2.13 | 187 bps |
| 0.129 SOL | $0.64 | 469 bps |
| 0.073 SOL | $0.39 | 505 bps |

Trade size is set by the price gap and the depth of the thinner pool, not by the size of your wallet. Push more capital into a circuit than the gap supports and you move the price against yourself, which is exactly what the three largest trades show.

### The simulation

Total profit of **every searcher on the network** in the 120-block sample was $7.83, which extrapolates to about **$21,200 a day** (superseded: ~$124,000, see `REAL_WORLD_MEV.md` §12). The largest single trade needed $1,538 (superseded: $34,126). So:

| Capital | 1% capture | 5% capture | 20% capture |
|---:|---:|---:|---:|
| $200 | $27.60/day | $138/day | $552/day |
| $2,000 | $212/day | $1,061/day | $4,245/day |
| $20,000 | $212/day | $1,061/day | $4,245/day |
| $200,000 | $212/day | $1,061/day | $4,245/day |

Read the last three rows: **identical.** Above roughly $1,500 more capital buys nothing at all, it only divides the same profit over a bigger base, so the return collapses from 53% a day to 0.53%.

The variable that matters is the capture rate, and capture rate is latency. `docs/REAL_WORLD_MEV.md` established that 101 of 104 winners pay for block position and that the top 3 trades take 56% of all profit. You cannot buy your way into that with a larger balance; the auction is won by whoever sees the state first and bids, from a co-located node costing $500–2,000 a month.

**So the honest answer to "simulate it with a fictional sum": the sum is not the input that matters.** A simulation parameterised on capital returns the same number for $2,000 and $200,000. The engine in this repository already runs the simulation, in shadow mode, and reached `NO_VERIFIED_EDGE` three independent ways.

---

## 2. Where the integration work is, ranked

Source: GitHub code search for `jupiter-amm-interface` in `Cargo.toml`, 109 hits, 59 unique repositories resolved with their last-push dates. Data: `docs/sources/realworld/jupiter_integrations.json`. Cross-referenced against the 21 venues this repository observed Jupiter actually routing through.

### The structural finding

**The highest-volume venues have no public integration at all.** Scorch (45 routed hops in the sample), HumidiFi (27), BisonFi (25), TesseraV (18), Quantum (10), AlphaQ (8), Riptide, GoonFi, SolFi and ZeroFi appear nowhere in the public repository list. They are proprietary market makers who integrated privately. That is a closed door, not an opportunity.

The public integrations split three ways.

### Active, and routing live — these are funded and working

| Repository | Last push | Note |
|---|---:|---|
| `Bonasa-Tech/manifest` | 1 day | Manifest appears in live routing |
| `Quay-Markets/quay-jupiter-integration` | 23 days | Quay appears in live routing |
| `deriverse/jupiter-deriverse` | 42 days | Deriverse appears in live routing |

Three protocols that are demonstrably alive, demonstrably integrated, and demonstrably getting order flow. If any of them is hiring, the crate in `integrations/raydium_cpmm_amm/` is the exact artefact to show.

### Active, building, not yet visible in routing

`hylo-so/sdk` (today), `ballista-tech/archer-jup` (1 day), `metaDAOproject/programs` (2 days), `quineco/bankineco-amm-interface` (29 days), `DFlowProtocol/dflow-amm-interface` (50 days), `igneous-labs/sanctum-router-jup-interface` (91 days), `byreal-git/byreal-jupiter-integration` (93 days), `Still-Tech/k2-amm-sdk` (149 days), `trends-fun/bonding-curve-jup-sdk` (141 days), `MetalLegBob/drfraudsworth-jupiter-adapter` (62 days).

Two of these are on personal accounts rather than protocol organisations — `kylesamani/lemmingsfi-jupiter` and `MetalLegBob/drfraudsworth-jupiter-adapter` — which is the only direct evidence found that this work is sometimes done by an individual rather than in-house.

### Stale: over a year untouched, and absent from live routing

25 repositories, including `woonetwork/woofi-jupiter-integration` (505 days), `openbook-dex/openbook-v2` (794), `dmsoltech/obric-jupiter-integration` (838), `GooseFX1/gfx-ssl-v2-sdk` (966), `Ellipsis-Labs/jupiter-plasma` (496), `solayer-labs/jupiter-amm-integration` (680), `AdrenaFoundation/jupiter-adrena` (699).

**Do not read these as opportunities.** None of them appeared in the routing census, so the integration is not stale because it was forgotten, it is stale because the venue stopped mattering. A stale integration on a dead venue is not a job.

### What this changes about the earlier framing

`docs/WHERE_THE_OPPORTUNITY_IS.md` presented DEX integration as recurring contract work. The ownership evidence weakens that: of 59 repositories, nearly all sit under the protocol's own organisation, so the work is normally in-house. Two individual-owned repositories are the only counter-evidence found, and no price for the work was located anywhere.

The honest revision: this is **a credential, not a market.** It is evidence for a conversation with one of the roughly twenty protocols that are alive and doing this work, at the rates measured in `WHERE_THE_OPPORTUNITY_IS.md` ($50/hour for a Romania-based senior, $70k–180k salaried), rather than a stream of integration contracts to bid on.

---

## 3. The capital figure, remeasured — and the answer is different

§1 said capital saturates near **$1,538**, from 96 transactions in a 120-block census. That is the
same single-short-sample weakness that made the market-size number wrong by sixfold, and it
matters more here because the claim is load-bearing: it is the reason this repository says more
money buys nothing.

Remeasured against the 3,000-block census — every circuit taking home more than 1,000,000 lamports
(all 259 of them) plus a systematic sample of the rest, 641 transactions fetched in total:

| | 96 transactions | **641 transactions** |
|---|---:|---:|
| median capital deployed | 0.0235 SOL = $2.49 | 0.0616 SOL = **$6.96** |
| 90th percentile | 0.9885 SOL | 2.944 SOL |
| **largest observed** | 14.54 SOL = $1,538 | **302.18 SOL = $34,126** |

**The old maximum was twenty-one times too low.** People do deploy tens of thousands of dollars.

### And the conclusion is stronger, not weaker

Median return, by how much capital the trade put at risk:

| capital | trades | median return | share of all profit |
|---|---:|---:|---:|
| under 0.01 SOL | 242 | 41.9 bps | 0.1% |
| 0.01 – 0.1 | 104 | 22.7 bps | 1.2% |
| 0.1 – 1 | 171 | 53.6 bps | 9.7% |
| **1 – 10** | 82 | 42.4 bps | **51.6%** |
| **10 – 100** | 18 | 41.6 bps | **32.0%** |
| over 100 SOL | 24 | **0.1 bps** | 5.4% |

Returns sit between 20 and 55 basis points across four orders of magnitude of size — and then
**collapse to a tenth of a basis point above 100 SOL.** The twenty-four largest deployments, each
around $34,000, earned a median of thirty cents.

So the saturation point is **about 100 SOL, roughly $11,000** — not $1,538 — and **84% of all
profit is made with between 1 and 100 SOL** of capital. Below 1 SOL the returns are just as good
in percentage terms but the absolute amounts are negligible; above 100 SOL the percentage
evaporates.

### A detail worth noticing

The trades above 100 SOL cluster at almost exactly the same size: 302.178, 302.183, 302.184 SOL,
fourteen distinct values across twenty-four trades. That is not a wallet balance, it is a fixed
parameter — most plausibly a flash-loan size. Somebody is borrowing three hundred SOL per attempt
and clearing thirty cents on it.

### What this changes

The number in §1 is corrected from $1,538 to about $11,000, and the shape of the argument
survives intact: **beyond the saturation point more capital buys nothing at all**, and the
saturation point is low enough that it is not the binding constraint on entering this market.
Latency is.
