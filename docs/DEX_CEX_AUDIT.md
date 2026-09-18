# DEX–CEX arbitrage on Solana — audit

**Question asked:** the DEX–DEX circuit in this repository returned `NO_VERIFIED_EDGE`. Is DEX-versus-centralised-exchange different, and are there safe strategies there?

**Answer:** no, and the failure is for a different reason. DEX–DEX died on costs. DEX–CEX dies on two things costs cannot fix: the gap is not there once you measure it correctly, and the cycle is not atomic, so the holding-period variance is several times the prize.

**Verdict: `NO_VERIFIED_EDGE`.** Nothing here was executed. No orders were placed, no transaction was signed or submitted, no credential file was read. Every number comes from public unauthenticated market-data endpoints.

- **Measurement window:** 2026-09-18, 08:44Z – 09:13Z
- **Venues:** Binance, OKX, MEXC, Gate (spot), Jupiter aggregator, Solana mainnet RPC
- **Raw data and scripts:** `docs/sources/dexcex/` — `cex_side.{md,json}`, `mechanics.{md,json}`, `dex_side.json`, `window_scan.json`, `window_scan_matched.json`, and the samplers that produced them

---

## 1. The correction that changes the headline

My first pass on this question reported a positive gross spread of **+6.3 bps on SOL** in the DEX→CEX direction, and said it was the only asset of eight with a consistently positive sign. That number was an artifact of my own measurement, and it is wrong.

I quoted the DEX leg in **USDC** and the CEX leg in **USDT**. Those are not the same unit. The stablecoin basis is worth roughly 7.5 bps right now, and both venues price it almost identically, so subtracting one from the other manufactures a spread that is exactly the size that looks tradeable.

Measured directly, three consecutive samples at 09:03Z, $2,000 notional:

| Measurement | Sample 1 | Sample 2 | Sample 3 |
|---|---:|---:|---:|
| USDC/USDT basis, Jupiter | 7.65 | 7.64 | 7.62 |
| USDC/USDT basis, Binance | 7.50 | 7.50 | 7.50 |
| SOL gap, **unmatched** (DEX in USDC vs CEX in USDT) | +7.56 | +7.36 | +6.76 |
| SOL gap, **matched** (USDT on both sides) | **−0.31** | **−0.28** | **−0.84** |

All figures in basis points. Script: `.scratch/dexcex/basis.ts`.

The unmatched gap tracks the basis to within a fraction of a basis point. The matched gap is slightly negative. The two venues agree on the value of a dollar to 0.01 bps, and once both legs are denominated in the same dollar there is nothing left.

This generalises into a rule for any scanner: **match the quote currency on both legs before comparing prices.** A scanner that does not will emit a steady stream of ~7.5 bps false positives, all of them above a 5 bps cost floor, all of them untradeable.

### The same test, run for ten minutes side by side

Three samples are an anecdote, so the A/B was run continuously: same asset, same instant, both denominations, 55 sweeps per asset at $2,000 notional, 09:02Z–09:12Z. Script `.scratch/dexcex/window_scan_matched.ts`, output `window_scan_matched.json`.

| Asset | Denomination | median | max | samples above 5 bps |
|---|---|---:|---:|---:|
| SOL | unmatched (USDC vs USDT) | +6.76 | +8.45 | **51 of 54** |
| SOL | matched (USDT vs USDT) | **−0.84** | **+0.70** | **0 of 54** |
| JUP | unmatched | −0.14 | +3.16 | 0 of 51 |
| JUP | matched | **−7.77** | −4.51 | **0 of 52** |
| TRUMP | unmatched | +2.80 | +7.81 | 13 of 51 |
| TRUMP | matched | **−5.36** | +3.26 | **0 of 54** |

Across **160 denomination-matched observations on three assets, not one exceeded 5 bps**, and the best single observation anywhere was +0.70 bps on SOL. The unmatched version of the identical measurement produced 64 readings above 5 bps. Every one of them was the stablecoin basis.

The Binance USDC/USDT basis held at a median of 7.50 bps through the whole window, with a range of 7.40 to 7.70. On the Jupiter side the median was 7.67 bps; that series has occasional outliers from bad quotes, so the median is the robust figure and the mean is not reportable.

An earlier 12-minute run of the uncorrected scanner, 69 sweeps per asset, agrees: SOL showed a median best-direction gap of +6.92 bps with **66 of 67 samples above 5 bps and zero above 10 bps**. A signal that clusters just under the basis and never exceeds it is the basis.

---

## 2. Where the money goes — the cost stack on the best possible asset

SOL, $10,000 clip, the most liquid asset in the sample and the most favourable case in every respect.

| Component | bps | Confidence |
|---|---:|---|
| CEX taker fee, cheapest venue obtainable (MEXC) | 5.00 | MEASURED, `api.mexc.com/api/v3/exchangeInfo` |
| CEX slippage vs mid at $10k | 0.47 | MEASURED, book walked level by level |
| DEX leg, one way, fee + price impact | 0.19 | MEASURED, Jupiter quote |
| Solana network fee at $10k | 0.001 | MEASURED |
| Solana withdrawal fee (Binance, 0.001 SOL) | 0.11 | MEASURED |
| SOL↔USDT conversion forced by the absence of `/SOL` pairs (§4) | ≥ 5.00 | MEASURED, second taker fee |
| **Deterministic floor** | **≈ 10.8** | |
| 1-minute holding-period risk, 1σ | ± 7.55 | MEASURED, 1,000 one-minute bars |

Against that floor, the correctly-denominated gap on SOL had a median of **−0.03 bps** and a maximum of **+4.95 bps** across 13 simultaneous samples. The single best observation in the entire sample fails to clear even the 5 bps MEXC taker fee, by 0.08 bps.

Two costs I expected to bind, and which do not:

- **The withdrawal fee is negligible.** Binance normalises Solana-network SPL withdrawals to about $0.50 flat and SOL itself to $0.106. At a $10k clip that is 0.5 bps, at a $100k rebalance 0.03 bps. I had carried over the intuition from the 9,000-lamport toll that killed the DEX–DEX circuit. It does not transfer: that fee was fixed against sub-$100 circuits, this one against $10k clips.
- **The DEX side is essentially free on the majors.** SOL costs 0.19 bps one way at $10k and 0.96 bps at $50k. Price impact, the second DEX–DEX blocker, effectively vanishes for the top assets.

So the two engineering problems from the previous study are genuinely solved here. The strategy still loses.

---

## 3. The control experiment: 130 cross-venue observations, zero positive

If venue-level mispricings on Solana assets existed at a harvestable size, the cheapest place to see them is between two centralised exchanges, where there is no chain, no pool fee and no confirmation delay.

For 24 Solana-native assets, across every ordered venue pair, at three notionals, in two snapshots five minutes apart, walking both books level by level and comparing **gross of all fees**:

| | |
|---|---|
| Observations | 130 |
| Positive before any fee | **0** |
| Best gross gap, any asset, any size | **0.00 bps** (SOL, exactly zero) |
| Widest mid-to-mid disagreement in the sample | 14.3 bps (DRIFT) |
| Cost of crossing the spread on DRIFT at $10k | ~5,000 bps |

The ordering in the full table is the tell: the gap gets *more* negative as the asset gets less liquid and as size grows. That is the signature of a market with no dispersion where you are simply paying two spreads. Dispersion and executability are inversely related across the whole sample.

The dispersion that does exist is noise, not a basis. Between the two snapshots the best route **reversed direction on 13 of 24 assets**, and where prices moved they moved together — MEW went +26.9 bps on OKX, +25.7 on MEXC and +28.1 on Gate simultaneously. A real venue-level basis has a sign that persists. A sign that flips inside five minutes is quote noise around a common mid.

---

## 4. The cycle does not close: there is no `/SOL` quote pair

Filtering the full spot catalogues of all four venues for `quoteAsset == SOL` across these 24 assets returns **nothing**. Binance has exactly one SOL-quoted spot pair in its entire catalogue, `BNSOL/SOL`, and that is a liquid-staking wrapper rather than a token market.

A Solana pool prices `TOKEN/SOL`. Every CEX prices `TOKEN/USDT`. Buying a token on-chain with SOL and selling it on a CEX for USDT leaves you long USDT and short SOL. Closing that needs a third leg, which costs another taker fee plus another spread and re-introduces SOL price risk for its duration.

The DEX–DEX engine in this repository never had this problem, because both legs were denominated in WSOL and the circuit closed by construction. Any DEX–CEX profit-and-loss figure that ignores this leg is overstated by at least one taker fee.

---

## 5. Why "safe" does not apply

The user's question used the word *sigure*. The strategy is not atomic, and that is the whole difference. In the DEX–DEX engine both legs land in one transaction or neither does. Here there is a gap between the legs, and the gap is priced in variance.

There are only two ways to run it.

**Inventory on both sides.** Pre-fund both venues, fire both legs at once, rebalance later. The exposure window is zero, and this is the only version that deserves the word arbitrage. The price is capital: for working size `S` you hold `S` on-chain and `S` at the exchange, and to absorb `k` consecutive same-side trades before rebalancing you need `2·k·S`. A $10,000 trade size with ten trades between rebalances is **$200,000 of capital**, and the return is computed on that, not on the clip. Half of it sits permanently inside a counterparty.

**Sequential.** Buy here, transfer, sell there. Capital is `S`, but the position is naked while the transfer settles.

Measured settlement asymmetry:

| Side | Time |
|---|---|
| Solana slot | 0.2655 s |
| `confirmed` − `finalized` | ~7.97 s |
| Binance published SOL arrival estimate | 1 minute |
| MEXC published withdrawal ceiling | 60 minutes |
| Gate `Manual` review status | no published SLA |

The chain settles a leg in a quarter of a second. The only venue of the four that publishes a withdrawal SLA documents it at up to an hour, and the slow side is off-chain and discretionary.

Realised SOL volatility over that window, from 1,000 one-minute bars:

| Horizon | 1σ |
|---|---:|
| 1 min | 7.54 bps |
| 5 min | 16.87 bps |
| 30 min | 41.32 bps |
| 60 min | 58.43 bps |

**The one-minute sigma is larger than the largest correctly-denominated gap observed anywhere in the sample.** At the published 60-minute ceiling it is roughly twelve times the best observed edge. The sequential version is not arbitrage. It is an unhedged directional bet on SOL with a coupon of at most 5 bps attached.

Five further conditions, each with a source in `.scratch/dexcex/mechanics.md`, that the word "safe" has to survive and does not:

1. **Withdrawals get suspended while trading continues.** OKX suspended Solana-network deposits and withdrawals for about three hours in February 2026 and stated explicitly that trading of those tokens was unaffected. That is precisely the failure mode for the inventory model: you cannot rebalance, the market keeps moving, and your two inventories diverge.
2. **Chain halts force open-ended suspension.** Gate suspended SOL deposits during a Solana outage with no end date, resuming only when the network did.
3. **Frozen legs are a live condition, not a tail event.** Of the 61 assets Binance lists on the Solana network right now, five have deposits disabled and five have withdrawals disabled. About **one asset in nine has at least one leg frozen at this moment.**
4. **Discretionary review sits inside the settlement path.** Gate documents a `Manual` deposit status with no SLA; MEXC documents `Under Review` at 5–60 minutes.
5. **Fee reclassification flips the sign overnight.** OKX re-snapshots fee tiers daily and has a spot fee change effective 2026-09-25, a week after this measurement. At a 2–5 bps edge, one tier slip is the whole result.

---

## 6. Break-even, stated as a table

Jupiter's output amount is already net of pool fees and DEX price impact, so the test reduces to whether the gap beats the CEX fee plus the network fee plus the exposure cost.

| Scenario | Taker | Cost floor | Net at median gap | Net at best of 13 | Verdict |
|---|---|---:|---:|---:|---|
| Inventory, Binance entry tier | 10 bps | 10.03 | −10.06 | −5.08 | negative |
| Inventory, MEXC (API-measured) | 5 bps | 5.03 | −5.06 | **−0.08** | negative — even the best sample misses |
| Inventory, OKX VIP 9 | 1.75 bps | 1.78 | −1.81 | +3.17 | positive on ~1 observation in 13 |
| Sequential, 1 min | 5 bps | 12.57 | −12.60 | −7.62 | negative |
| Sequential, 60 min | 5 bps | 63.46 | −63.49 | −58.51 | negative by an order of magnitude |

The only cell that is ever positive requires **$5 billion of 30-day volume** to reach OKX VIP 9, *and* winning a latency race, for a 3 bps prize on one observation in thirteen. Note also that the VIP 9 tier carries a *negative* maker fee. A participant quoting at −0.0075% rather than crossing is market making, and carries adverse selection instead of fee cost. That is a different strategy with a different failure mode and it should not be smuggled in under the word arbitrage.

---

## 7. A finding about this repository's own engine

The DEX-side agent recorded which venues Jupiter actually routes through, across 244 routed hops in 80 quote legs:

| Venue | Hops |
|---|---:|
| Scorch | 45 |
| Whirlpool | 33 |
| HumidiFi | 27 |
| BisonFi | 25 |
| TesseraV | 18 |
| Manifest | 15 |
| GoonFi V2, Raydium CLMM | 12 each |
| Quantum | 10 |
| Raydium (AMM v4) | 9 |
| **Raydium CP + Pump.fun AMM — the two adapters in this engine** | **5** |

The engine's two adapters cover **2.05%** of routed hops, or 5.74% if Raydium AMM v4 is counted generously. Exactly **1 leg of 80** routed entirely within venues the engine can model.

This is a coverage result, not a bug, and it is worth recording plainly: the previous whole-chain radar established that the engine sees the right *pools* for the venues it supports, but real order flow on Solana is dominated by proprietary market-maker venues — Scorch, HumidiFi, BisonFi, TesseraV — that the engine has no adapter for and that do not publish pool state in a form it could read. Any future work on DEX arbitrage has to start there rather than with more Raydium and PumpSwap pools.

---

## 8. What I could not measure

| Gap | Why | What would close it |
|---|---|---|
| MEXC withdrawal fee | needs an API key | read-scoped key on `GET /api/v3/capital/config/getall`. **Highest value** — MEXC is the cheapest taker venue for 15 of 24 assets |
| OKX spot taker fee | every public fee page is client-rendered or login-gated | authenticated `GET /api/v5/account/trade-fee` |
| OKX, Gate withdrawal fees | authenticated endpoints only | `GET /api/v5/asset/currencies`, `GET /api/v4/wallet/withdraw_status` |
| Deposit/withdraw enabled on OKX and MEXC | authenticated endpoints only | same keys |
| Real end-to-end transfer latency | Binance's 1 minute is its own estimate and excludes approval queueing | time actual transfers; treat 1 minute as a lower bound |
| Whether quoted depth is real | a book is a promise, not a fill | a live taker order, out of scope here — which is why every figure above is a floor |
| Whether the gap widens on thin pairs or in volatility | only SOL, JUP and TRUMP sampled, in a quiet market | run the simultaneous sampler across the CEX ∩ Solana-DEX intersection for days, conditioning on realised volatility. That population is small and enumerable: Binance lists 61 assets on the Solana network |

Every figure marked MEASURED above is a floor on cost and a ceiling on edge. Nothing was executed, so none of it accounts for the difference between a quoted book and a fill.

---

## 9. Assessment

DEX–DEX failed on costs, and costs are an engineering problem: better routing, cheaper venues, bigger clips. I could name the 275 bps median round-trip pool fee that killed it and say exactly what would have to change.

DEX–CEX removes those costs almost entirely — 5 bps taker against 275 bps of pool fees is a fiftyfold improvement on the binding constraint — and still loses, for reasons no amount of execution quality addresses:

- **The gap is not there.** Zero of 130 cross-venue observations were positive before any fee, and zero of 160 denomination-matched DEX-versus-CEX observations cleared 5 bps. The correctly-denominated gap on SOL has a median of −0.84 bps and a maximum of +0.70. What looked like +6.3 bps was the stablecoin basis, and both venues price that basis to within 0.01 bps of each other.
- **The floor is about 11 bps** on the single best asset, once the forced SOL↔USDT conversion is counted.
- **The cycle is not atomic**, and one minute of exposure carries 7.55 bps of 1σ price risk on SOL — more than the entire edge budget, on the asset where that budget is largest.

The word *sigur* does not apply to any version of this. The inventory version is genuinely market-neutral but converts market risk into counterparty risk and doubles the capital base; a three-hour withdrawal suspension of the kind OKX ran in February leaves two inventories diverging with no way to rebalance. The sequential version is an unhedged directional position for as long as an exchange takes to process a withdrawal, which no participant controls.

**Verdict: `NO_VERIFIED_EDGE`.** Same conclusion as the DEX–DEX study, reached independently, by a different mechanism.
