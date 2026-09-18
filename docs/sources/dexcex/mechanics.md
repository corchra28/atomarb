# DEX-CEX arbitrage on Solana — mechanics and risk audit

**Agent:** mechanics · **Measurement window:** 2026-09-18 08:44:32Z – 08:53:16Z
**Method:** public unauthenticated HTTPS endpoints + published exchange documentation. No API keys, no account endpoints, no orders placed or simulated.
**Raw data:** `mechanics.json`, `raw_gap_samples.json`, `raw_venue_snapshot.json`, `raw_binance_sol_network.json`

---

## 0. The short answer

The question was whether DEX-CEX is different from the DEX-DEX result. It is different in *where* it fails, and it fails anyway.

DEX-DEX died on costs measured in hundreds of basis points (275 bps median round-trip pool fees, thin-pool impact). Those costs are largely **absent** here: on the majors the DEX side is deep (0.012 bp of price impact on a $105,800 route) and the withdrawal fee amortises to 0.03 bp at a $100k rebalance. The 9,000-lamport network fee, which mattered in the DEX-DEX study, is **0.001 bp at $10,000 notional** — irrelevant.

DEX-CEX dies on a different constraint: **the gap itself is already gone.**

Across 13 simultaneous DEX-vs-CEX samples on SOL/USDT, the price difference had a **median of −0.03 bp and a maximum of 4.95 bp**, against a realistic cost floor of **5 bp** (MEXC, the cheapest taker actually obtainable) to **10 bp** (entry tier anywhere else). The single best observation in the entire sample still fails to clear a 5 bp taker fee, by 0.08 bp.

> Swapping DEX-DEX for DEX-CEX trades a large, structural, measurable cost (pool fees) for a small cost you cannot get below (taker fee), chasing a spread that participants paying 1.75 bp have already flattened. The population changed; the sign did not.

---

## 1. Settlement asymmetry

### The chain side (measured)

| Quantity | Measured | Source |
|---|---|---|
| Slot time | **0.2655 s** (3.767 slots/s, 1130 slots / 300 s) | `getRecentPerformanceSamples`, api.mainnet-beta.solana.com, 08:45:58Z |
| `confirmed` − `finalized` lag | **30 slots ≈ 7.97 s** | `getSlot` at both commitments, 08:45:58Z |

Solana's own docs define the commitments qualitatively, not as a slot count ([solana.com/docs/rpc](https://solana.com/docs/rpc)):

- **processed** — "the node's most recent processed block. This is the newest view, but it can still be rolled back."
- **confirmed** — "a block directly voted on by a supermajority of stake, meaning more than two-thirds of the network's active stake."
- **finalized** — "a block the cluster recognizes as finalized with maximum lockout."

The 30-slot figure is measured, not documented. Note this for what follows: **the chain is not the bottleneck.**

### The exchange side (per venue)

| Venue | SOL deposit confirmations | Withdrawal delay (published) | Batched? |
|---|---|---|---|
| **Binance** | **1** (`minConfirm: 1`, `lockConfirm: 0`, no separate unlock threshold) — measured across all 61 SOL-network assets | `estimatedArrivalTime: 1` minute; **no approval SLA published** | UNKNOWN |
| **OKX** | **UNKNOWN** — publishes no per-network table | not published | UNKNOWN |
| **Gate** | **UNKNOWN** — "different blockchain confirmation requirements for deposits of different coins"; number shown only on the login-gated deposit page | not published; documents a **`Manual` review** status with no SLA | UNKNOWN |
| **MEXC** | **UNKNOWN** | **"TxID typically generated within 1 to 60 minutes"**; `Under Review` status "5–60 minutes" | UNKNOWN |

Binance figures: [getNetworkCoinAll](https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll), fetched 08:44:46Z (MEASURED).
Gate statuses: [help/guide/deposit_withdrawa/17395](https://www.gate.com/help/guide/deposit_withdrawa/17395).
MEXC delays: [withdrawal FAQ](https://www.mexc.com/support/crypto-deposit-withdrawals/withdrawal-faq).

**The asymmetry, stated precisely:** the chain settles a leg in **0.27 s**. The only venue of the four that publishes a withdrawal SLA documents it at up to **3,600 s**. That is a **13,000× ratio**, and the slow side is off-chain, discretionary, and unbounded once a manual review triggers.

Three of four venues do not publish their Solana confirmation count at all. None publishes a batching policy. *To measure batching without an account:* watch each exchange's known hot wallet on-chain and test whether distinct user withdrawals share a transaction signature or cluster at fixed intervals — that is public chain data.

---

## 2. The two ways this is actually run

### (a) Inventory on both sides

Pre-fund both venues, fire both legs simultaneously, rebalance later. **No transfer sits in the critical path**, so the exposure window is zero.

**Capital:** for working size `S` you hold `S` on the CEX and `S` on-chain → **2S minimum**. To absorb a run of `k` consecutive same-side trades before rebalancing you need `k·S` on the draining side → **capital = 2·k·S**.

Worked example:

| | |
|---|---|
| Trade size | $10,000 |
| Trades between rebalances | 10 |
| Inventory each side | $100,000 |
| **Total capital** | **$200,000** |
| Rebalance cost (USDC off Binance) | $0.30 |
| **Amortised withdrawal cost per trade** | **0.0003 bp** |

The rebalancing cost is **nothing**. Flat withdrawal fees vanish at size: Binance charges 0.001 SOL ($0.106) for SOL and a flat 0.3 USDC — that is 0.03 bp on a $100k rebalance. **The withdrawal fee is not the obstacle. The withdrawal *delay* and *availability* are** (§3).

The real price of model (a) is that you must permanently park half your capital inside a counterparty, and your return is computed on `2S`, not `S`.

### (b) Sequential

Buy here, transfer, sell there. Capital is `1S` but the position is **naked during the transfer**.

Exposure window, from the documented numbers in §1:

- **Best case 1 minute** (Binance's published SOL-network arrival estimate)
- **Worst case 60 minutes** (MEXC's published withdrawal TxID ceiling)
- **Unbounded** if a `Manual` / `Under Review` hold triggers

Measured SOL volatility over that window — 1,000 one-minute bars, 2026-09-17 16:14Z → 2026-09-18 08:53Z ([Binance klines](https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=1000), 08:53:16Z):

| Window | σ | Realised \|move\| median / p90 / max |
|---|---|---|
| 1 min | **7.54 bp** | 3.9 / 12.9 / 35.0 bp |
| 5 min | 16.87 bp | |
| 10 min | 23.85 bp | |
| 30 min | 41.32 bp | |
| 60 min | **58.43 bp** | 33.6 / 103.4 / 219.5 bp |

**The one-minute sigma (7.54 bp) is larger than the largest DEX-CEX gap observed anywhere in the sample (4.95 bp).** At the 60-minute ceiling, sigma is ~12× the best observed edge.

Model (b) is not arbitrage. It is an unhedged directional bet on SOL with a ≤5 bp coupon attached.

---

## 3. Why "risk-free" is wrong — each with a source

1. **Network suspension while trading continues.** OKX: *"Deposits and withdrawals for SOLANA, TRON, IOTA, SUI, and TON tokens will be suspended starting from 09:00 am (UTC+8) on Feb 27, 2026"*, resuming 12:00 pm — ~3 hours. Critically: *"Trading of SOLANA, TRON, IOTA, SUI, and TON tokens is not affected."* ([source](https://www.okx.com/en-us/help/okx-wallet-maintenance-for-multiple-networks)) — **This is precisely the failure mode for model (a): you cannot rebalance, but the market keeps moving and your two inventories keep diverging. Three hours at a 41 bp 30-minute sigma.**

2. **Chain halt forcing open-ended suspension.** Gate suspended SOL deposits because *"the Solana Mainnet is experiencing an outage and not processing transactions"*, with no end date — only *"as soon as the Solana network works normally again."* ([source](https://www.gate.com/article/28185))

3. **Intermittent withdrawal suspension for backlog.** Binance publishes a *"Notice on the Intermittent Suspension of Withdrawals on Solana (SOL) Network"*; support states SOL-network withdrawals *"may be paused from time to time to clear the backlog."* ([source](https://www.binance.com/en/support/announcement/notice-on-the-intermittent-suspension-of-withdrawals-on-solana-sol-network-4fd0cd11c66642e9be99830070c6b038)) — DOCS_ONLY; the announcement body did not render for automated fetch.

4. **Per-asset freezes are a live condition, not a tail event.** MEASURED: of the **61** assets Binance lists on the SOL network right now, **5 have deposits disabled** (HNT, SNS, SRM, GST, AVA) and **5 have withdrawals disabled** (HNT, SRM, GMT, GST, AVA). **~11.5% of the Solana asset universe on Binance has at least one leg frozen at this moment.** Any strategy assuming it can always move what it just bought is wrong about roughly one asset in nine. ([source](https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll), 08:44:46Z)

5. **Discretionary manual review inside the settlement path.** Gate documents a deposit status *"Manual — the deposit is being manually reviewed. It will be credited after review"*, with no published SLA. ([source](https://www.gate.com/help/guide/deposit_withdrawa/17395))

6. **Withdrawal approval delay.** MEXC: TxID *"typically generated within 1 to 60 minutes"*; `Under Review` *"5–60 minutes"*; escalate to support if no TxID within an hour. ([source](https://www.mexc.com/support/crypto-deposit-withdrawals/withdrawal-faq))

7. **Minimum withdrawal amounts floor the trade size.** Binance SOL network: SOL 0.01, USDT 5, USDC 3. Gate: SOL 0.1, USDT 1, USDC 0.01, **BONK 3,547.35722**. (MEASURED, both public APIs)

8. **Memos / address formats.** On Solana specifically this risk is low — Binance reports `memoRegex` empty and `withdrawIsTag: false` for SOL, USDT and USDC. But `sameAddress: false`, and Binance warns *"SOL addresses are case sensitive."* A wrong-network or wrong-case send is unrecoverable; there is no on-chain reversal.

9. **Price moves during the transfer window.** Quantified in §2(b): 7.54 bp per minute of sigma.

10. **The CEX leg is a claim on the exchange, not an asset you hold.** Structural, and evidenced by every item above: Gate's `Manual` status, MEXC's `Under Review`, and OKX's and Binance's unilateral power to suspend a network. Model (a) *requires* leaving half the capital inside that claim. The "risk-free" framing silently converts market risk into counterparty and operational risk.

11. **Fee reclassification changes your economics overnight.** OKX publishes *"Important Notice: Spot Trading Pair Fee Group Adjustment — Effective August 5, 2026"* and re-snapshots tiers **daily** (*"Fee tiers are updated daily between 4:00 AM and 6:00 AM (UTC+8)"*). ([source](https://www.okx.com/en-us/help/trading-fee-rules-faq)) At a 2–5 bp edge, one tier slip flips the sign.

---

## 4. Public fee tiers — what a serious participant actually pays

Taker is the binding number: the CEX leg must cross the spread to be *certain* of the fill.

**Binance spot** ([fee schedule](https://www.binance.com/en/fee/schedule)) — VIP 0 `0.100%/0.100%` → VIP 9 `0.011%/0.023%` (≥$4bn 30d + ≥5,500 BNB). 25% off paying in BNB. **Taker range: 10 bp → 2.3 bp.**

**OKX spot** ([global fee framework](https://www.okx.com/en-us/help/updates-to-global-fee-framework), Group 1 pairs):

| Tier | Requirement | Maker | Taker |
|---|---|---|---|
| Regular | <$100k assets / <$1M vol | 0.08% | 0.10% |
| VIP 3 | ≥$500k / ≥$10M | 0.055% | 0.065% |
| VIP 6 | ≥$10M / ≥$200M | **0%** | 0.03% |
| VIP 7 | ≥$500M vol | **−0.002%** | 0.025% |
| VIP 8 | ≥$1bn vol | **−0.005%** | 0.02% |
| VIP 9 | ≥$5bn vol | **−0.0075%** | **0.0175%** |

**Taker range: 10 bp → 1.75 bp**, with genuine maker rebates from VIP 7.

**MEXC** — MEASURED from [its own exchangeInfo API](https://api.mexc.com/api/v3/exchangeInfo): `SOLUSDT maker 0, taker 0.0005` (**5 bp**).

> ⚠️ **Discrepancy worth flagging.** MEXC's press release of 2025-12-22 claims *"0% Maker and 0% Taker fees"* on *"all Spot trading pairs"* with *"All VIP tier restrictions and asset-holding requirements have been removed"* ([source](https://blog.mexc.com/press-release/mexc-upgrades-0-fee-spot-trading-to-cover-all-pairs/)). **MEXC's own API contradicts this:** 1,610 of 1,983 symbols (81%) carry `takerCommission 0.0005`, including SOLUSDT; only 251 show 0. Treat the headline as marketing and the API as operative. An edge model built on the press release would be wrong by 5 bp — which, as §5 shows, is the entire question.

**Gate** — MEASURED from [its public API](https://api.gateio.ws/api/v4/spot/currency_pairs/SOL_USDT): `SOL_USDT fee: 0.2` → **20 bp base**. VIP tiers (VIP0 0.20% → VIP9 0.02%) are **INFERRED** from Gate-domain search summaries, not a fetched table — the fee page is login-gated.

**Best realistic taker: 1.75 bp (OKX VIP 9), requiring ≥$5,000,000,000 of 30-day volume.** For anyone building this from scratch the honest number is **5 bp (MEXC) to 10 bp (entry tier anywhere else)**.

---

## 5. Break-even for a single round trip

**Condition:**

```
gap_bp > cex_taker_bp + dex_swap_fee_bp + price_impact_bp(both sides)
         + network_fee_bp + amortised_withdrawal_bp + exposure_cost_bp
```

**Important:** Jupiter's `outAmount` is already net of pool fees and price impact, so in every gap figure below `dex_swap_fee_bp` and the DEX-side impact are **already subtracted**. The test reduces to:

```
gap_bp > cex_taker_bp + network_fee_bp + amortised_withdrawal_bp + exposure_cost_bp
```

**Measured inputs** (SOL/USDT, 10 SOL ≈ $1,058, DEX quote and CEX book fetched in parallel threads, n=13, 08:50:16Z–08:51:17Z):

| Input | Value |
|---|---|
| Gap, median | **−0.03 bp** |
| Gap, best single observation | **+4.95 bp** |
| Binance top-of-book spread, median | 0.94 bp |
| Network fee @ $10k notional | 0.001 bp |
| Amortised withdrawal @ $100k rebalance | 0.03 bp |
| Exposure cost, model (a) | 0 bp |
| Exposure cost, model (b) @ 1 min | 7.54 bp |
| Exposure cost, model (b) @ 60 min | 58.43 bp |

**Result:**

| Scenario | Taker | Cost floor | Net @ median | Net @ best obs | Verdict |
|---|---|---|---|---|---|
| (a) Binance VIP 0 | 10 bp | 10.03 bp | −10.06 bp | −5.08 bp | NEGATIVE |
| (a) MEXC (API-measured) | 5 bp | 5.03 bp | −5.06 bp | **−0.08 bp** | NEGATIVE — even the best of 13 misses |
| (a) OKX VIP 9 | 1.75 bp | 1.78 bp | −1.81 bp | +3.17 bp | Positive on ~1 of 13 observations only |
| (b) sequential, 1 min | 5 bp | 12.57 bp | −12.60 bp | −7.62 bp | NEGATIVE |
| (b) sequential, 60 min | 5 bp | 63.46 bp | −63.49 bp | −58.51 bp | NEGATIVE by an order of magnitude |

**Plainly:** the price difference had a median of roughly zero and a maximum of 4.95 bp, against a cost floor of 5–10 bp. Underwater at the median for **every fee tier below OKX VIP 9**. The only positive cell requires $5bn of monthly volume *and* winning a latency race for a 3 bp prize on one observation in thirteen.

---

## 6. The trap that will generate false positives

**The largest apparent DEX-CEX gap I observed was not an arbitrage — it was a denomination artifact.**

At 08:48:43Z:

| | |
|---|---|
| Binance SOL/USDC bid | 105.81 |
| Binance SOL/USDT bid | 105.89 |
| Implied cross-pair basis | **7.6 bp** |
| Binance USDC/USDT bid / ask | 1.00077 / 1.00078 |
| Jupiter USDC→USDT exec price | **1.000781** |
| **DEX vs CEX agreement on the basis** | **0.01 bp** |

Quoting a Solana SOL/**USDC** pool against a CEX SOL/**USDT** book manufactures a phantom ~7.6 bp edge — comfortably above the 5 bp cost floor, and therefore exactly the size that looks tradeable. It is entirely the stablecoin basis, and the DEX and the CEX price that basis **identically** (1.000781 vs 1.00077).

Any scanner that does not match quote currencies will emit a steady stream of these. If the engine has already produced "promising" DEX-CEX candidates, **check the quote currency of both legs first.**

---

## 7. What I could not measure (and what would measure it)

| Unknown | Why | How to close it |
|---|---|---|
| Solana confirmation counts for **OKX, Gate, MEXC** | Login-gated or key-gated; OKX `/api/v5/asset/currencies` returns `50103 Request header OK-ACCESS-KEY can not be empty` | Authenticated read of each capital-config endpoint |
| Whether **any** venue batches withdrawals | None publishes a policy; MEXC's 1–60 min range is *consistent* with batching but doesn't establish it | **Public chain data:** watch each exchange hot wallet, test whether distinct withdrawals share a signature or cluster at fixed intervals |
| Binance withdrawal **approval SLA** | Publishes arrival estimate, not processing SLA | Timestamp deltas between submission and on-chain broadcast |
| Whether the gap widens on **thinner pairs or in volatility** | Only SOL/USDT sampled, n=13, 61 seconds, quiet market (all 150 sampled slots had priority fee 0) | Run the same simultaneous sampler across the **CEX ∩ Solana-DEX intersection** for days, conditioning on realised vol. That population is small and enumerable — Binance lists 61 assets on the SOL network |
| Gate VIP maker/taker splits | Fee page login-gated; only the 0.2% base is confirmed | Authenticated `GET /api/v4/spot/fee` |

**Caveat on sample size, stated honestly:** n=13 over 61 seconds in a quiet market is a probe, not a distribution. It is enough to establish that the gap is *of the same order as the fee* rather than multiples of it — which is the decisive fact — but it cannot rule out that thin, newly-listed, or high-volatility assets behave differently. That is the one question worth spending more measurement on, and §7 row 4 says how.

**One structural note the sample does not need to establish:** the profitable cell in §5 sits at OKX VIP 9 with a **negative maker fee**. A participant at −0.0075% maker who quotes rather than crosses is not doing arbitrage — they are market making, and they carry adverse-selection risk instead of fee cost. That is a different strategy with a different failure mode, and it should not be smuggled in under the word "arbitrage."
