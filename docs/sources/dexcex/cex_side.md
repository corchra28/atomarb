# CEX side of a DEX–CEX arbitrage on Solana assets — measured

Agent: `cex_side`. Read-only. Public unauthenticated market-data endpoints only. No orders placed, signed or simulated. No credential files read.

**Measurement windows (UTC)**
- Snapshot 1: `2026-09-18T08:46:27Z` → `08:46:57Z`
- Snapshot 2: `2026-09-18T08:51:17Z` → `08:51:47Z`

85 order books per snapshot, 170 books total. 24 assets × 4 venues (where listed). Raw data: `raw_books.json`, `raw_books_t2.json`, consolidated in `cex_side.json`.

---

## 1. The headline numbers

| Quantity | Value |
|---|---|
| Assets measured | 24 |
| Order books walked | 170 (85 × 2 snapshots) |
| Median top-of-book spread | **7.28 bps** |
| Cheapest achievable CEX leg at $10k (taker fee + slippage) | **5.47 bps** (SOL on MEXC) |
| Binance Solana withdrawal fee, typical SPL token | **~$0.52 flat** → 0.5 bps at $10k |
| Realised 1-minute volatility, SOL → BONK | **7.55 → 22.98 bps (1σ)** |
| `/SOL`-quoted spot pairs found across all four venues | **0** |
| Cross-CEX gross gaps observed | 130 |
| …of which **positive before any fee** | **0** |
| Best gross cross-CEX gap seen, any asset, any size, either snapshot | **0.00 bps** (SOL — exactly zero, not a rounding artifact) |

The cross-CEX result is the control experiment for the whole question, and it is emphatic: across 24 Solana-native assets and two independent snapshots five minutes apart, **not one venue pair produced a positive gap even gross of fees**. The cheapest structurally-possible CEX leg is 5.47 bps, and that is on SOL itself — the single deepest asset on the list.

---

## 2. Asset universe and listing coverage

All ten requested assets (SOL, BONK, WIF, JUP, JTO, PYTH, RAY, W, PENGU, TRUMP) are listed with a live USDT spot market on **all four** venues. I added 14 further Solana-native assets that are listed on at least two.

| Asset | Binance | Gate | MEXC | OKX | Venues |
|---|:-:|:-:|:-:|:-:|:-:|
| SOL, BONK, WIF, JUP, JTO, PYTH, RAY, W, PENGU, TRUMP | ✓ | ✓ | ✓ | ✓ | 4 |
| BOME, KMNO, ME, PUMP, RENDER, TNSR | ✓ | ✓ | ✓ | ✓ | 4 |
| IO, ORCA | ✓ | ✓ | ✓ | — | 3 |
| GRASS, MEW, MOODENG | — | ✓ | ✓ | ✓ | 3 |
| DRIFT, FARTCOIN, POPCAT | — | ✓ | ✓ | — | 2 |

Sources (fetched 2026-09-18T08:44–08:45Z):
`https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT` ·
`https://www.okx.com/api/v5/public/instruments?instType=SPOT` ·
`https://api.mexc.com/api/v3/exchangeInfo` ·
`https://api.gateio.ws/api/v4/spot/currency_pairs`

### 2a. There is no `/SOL` quote pair. This is a structural problem, not a detail.

Filtering all four exchange-info dumps for `quoteAsset == SOL` across these 24 bases returns **nothing**. Binance has exactly one SOL-quoted spot pair in its entire catalogue — `BNSOL/SOL` — and it is a liquid-staking wrapper, not a token market.

Consequence for the strategy: a Solana DEX pool prices `TOKEN/SOL` (or `TOKEN/USDC`). The CEX prices `TOKEN/USDT`. A cycle that buys TOKEN on-chain with SOL and sells it on a CEX for USDT does **not** close — it leaves you long USDT and short SOL. Closing it needs a third leg (sell USDT→SOL somewhere, then bridge SOL back), which adds another taker fee plus another spread, and re-introduces SOL price risk for the duration. The DEX-DEX engine in this repo never had this problem because both legs were denominated in the same asset. Any DEX-CEX P&L that ignores this leg is overstated.

---

## 3. Method — how the execution numbers were produced

Books were **walked level by level**, never derived from the mid:

- Depth requested: `limit=100` on Binance / Gate / MEXC, `sz=400` on OKX. Actual level counts are recorded per book in `cex_side.json`.
- For a target quote notional *N* (100, 1 000, 10 000, 50 000 USDT), consume levels on the relevant side until *N* USDT of quote is spent or received.
- Average fill price = (quote spent) ÷ (base received).
- Where the returned book is exhausted before *N* is filled, the result is flagged `book_exhausted: true` and excluded from best-venue selection rather than being reported as a fill. This matters: several small-cap books cannot absorb $50k at all within 100 levels.
- Slippage reported **both** vs top-of-book (as requested) and vs mid. The vs-mid figure is the one used for cost arithmetic, because a DEX quote should be compared against a venue's mid, not against the side of the book you are about to hit.

Endpoints, all unauthenticated:

```
https://api.binance.com/api/v3/depth?symbol={SYM}&limit=100
https://api.gateio.ws/api/v4/spot/order_book?currency_pair={SYM}&limit=100
https://api.mexc.com/api/v3/depth?symbol={SYM}&limit=100
https://www.okx.com/api/v5/market/books?instId={SYM}&sz=400
```

---

## 4. Book quality — spread and depth (snapshot 1, 08:46:27Z)

Buy-side slippage vs top of book, in bps, walking the ask side.

| Asset | Venue | Spread bps | Depth ±10 bps (bid/ask, USDT) | Depth ±50 bps (bid/ask, USDT) | slip@1k | slip@10k | slip@50k |
|---|---|---:|---:|---:|---:|---:|---:|
| SOL | binance | 0.94 | 458 697 / 532 554 | 1 637 781 / 4 143 911 | 0.0 | 0.0 | 0.0 |
| SOL | mexc | 0.94 | 633 928 / 758 828 | 998 415 / 2 054 430 | 0.0 | 0.0 | 0.0 |
| SOL | okx | 0.94 | 290 730 / 239 876 | 1 151 630 / 1 021 720 | 0.0 | 0.0 | 1.0 |
| SOL | gate | 0.94 | 37 373 / 40 245 | 220 962 / 244 384 | 0.0 | 0.3 | 6.8 |
| PENGU | binance | 1.32 | 11 956 / 15 567 | 111 304 / 94 289 | 0.0 | 4.0 | 14.5 |
| PENGU | mexc | 1.32 | 20 517 / 19 965 | 70 118 / 52 079 | 0.0 | 3.2 | 9.4 |
| PUMP | binance | 2.37 | 13 265 / 19 386 | 139 571 / 121 055 | 0.3 | 4.2 | 9.4 |
| PUMP | mexc | 2.37 | 15 234 / 14 222 | 177 675 / 187 251 | 0.2 | 4.6 | 9.6 |
| TRUMP | binance | 4.88 | 17 903 / 16 008 | 165 072 / 128 451 | 0.0 | 3.6 | 11.0 |
| TRUMP | okx | 4.88 | 22 195 / 13 482 | 245 630 / 148 639 | 2.6 | 4.7 | 10.3 |
| WIF | binance | 5.18 | 6 949 / 2 800 | 38 978 / 97 610 | 2.3 | 10.6 | 26.0 |
| JUP | mexc | 3.94 | 19 483 / 12 010 | 119 332 / 74 704 | 3.9 | 7.4 | 22.5 |
| PYTH | okx | 1.66 | 138 / 1 077 | 10 933 / 13 457 | 6.0 | 19.6 | 62.9 |
| JTO | okx | 2.20 | 886 / 571 | 62 774 / 51 711 | 8.2 | 19.6 | 35.7 |
| RAY | binance | 5.80 | 2 154 / 2 877 | 20 394 / 30 889 | 0.9 | 10.8 | 46.0 |
| W | okx | 13.68 | 512 / 271 | 38 371 / 35 962 | 3.6 | 28.8 | 61.1 |
| BONK | okx | 3.55 | 14 037 / 4 628 | 51 290 / 43 533 | 3.5 | 9.0 | 24.3 |
| MOODENG | okx | 9.32 | 429 / 556 | 7 454 / 4 243 | 5.0 | 49.9 | 1 333.9 |
| MEW | mexc | 14.66 | 51 / 50 | 642 / 241 | 366.3 | 34 618.8 | 69 186.6 |
| POPCAT | mexc | 21.25 | 0 / 0 | 1 901 / 525 | 36.7 | 4 874.5 | 4 874.5 |
| DRIFT | mexc | 34.97 | 0 / 0 | 9 / 9 | 63.5 | 9 937.3 | 48 096.1 |

Full 85-row table is in `cex_side.json` under `assets.<A>.venues.<V>`.

Three regimes are visible and they are sharply separated:

1. **SOL** — 0.94 bps spread on all four venues simultaneously, and 0.0 bps slippage on $50k at three of them. Over $4.1m rests within 50 bps of the mid on Binance's ask alone. There is no execution cost to speak of here.
2. **Large Solana tokens** (PENGU, PUMP, TRUMP, WIF, JUP, BONK) — 1.3–5.2 bps spreads, single-digit-to-20 bps slippage at $10k. Tradeable.
3. **Everything below the top ten** — MEW, POPCAT, DRIFT, MOODENG show *zero* resting size within 10 bps of their own mid and four-figure slippage at $10k. MEXC's DRIFT book holds **$9** within 50 bps of the mid. These books are decorative.

---

## 5. Taker fees

| Venue | Taker | Maker | Confidence | Source |
|---|---:|---:|---|---|
| MEXC | **5.0 bps** | 0.0 bps | **MEASURED** | `api.mexc.com/api/v3/exchangeInfo` → `takerCommission: "0.0005"`, `makerCommission: "0"`, identical on all 24 symbols. Fetched 08:44Z |
| Binance | **10.0 bps** | 10.0 bps | DOCS_ONLY | <https://www.binance.com/en/fee/schedule> — "Regular User", <1 M USD 30-day volume, 0 BNB. 7.5 bps with the 25 % BNB discount. Fetched 08:48Z |
| Gate | **20.0 bps** | 20.0 bps | **MEASURED** | `api.gateio.ws/api/v4/spot/currency_pairs` → `fee: "0.2"`, identical on all 24 pairs. Fetched 08:45Z |
| OKX | **UNKNOWN** | UNKNOWN | **UNKNOWN** | see below |

MEXC additionally advertises a 20 % MX-holder discount and 50 % above 500 MX at <https://www.mexc.com/fee> — not applied in any figure here.

### OKX taker fee could not be established from a primary source

I tried `www.okx.com/fees`, `www.okx.com/en-us/fees`, `www.okx.com/help/okx-trading-fees` (404), `www.okx.com/en-us/help/trading-fee-rules-faq`, and the August-2026 fee-group consolidation notice. Every one of them either renders the fee table client-side — the numbers are absent from the served HTML — or explicitly states that rates are visible only after login. I will not substitute a remembered figure for a measured one. Where arithmetic required a number I used **10.0 bps and flagged it** (`okx*` in the table below).

**What would measure it:** authenticated `GET /api/v5/account/trade-fee?instType=SPOT`, or a logged-in capture of okx.com/fees.

**Live caveat:** OKX has announced a spot fee *reduction* for regular clients effective **2026-09-25**, seven days after this measurement — <https://www.okx.com/en-us/help/advance-notice-spot-and-futures-trading-fee-adjustment-090926>. Any OKX figure here has a known expiry date.

---

## 6. Withdrawal fees — MEASURED on Binance, UNKNOWN on OKX and MEXC

The authenticated endpoints refuse, as expected (probed 08:47Z):

| Endpoint | Result |
|---|---|
| `api.binance.com/sapi/v1/capital/config/getall` | HTTP 400 `{"code":-2014,"msg":"API-key format invalid."}` |
| `www.okx.com/api/v5/asset/currencies?ccy=SOL` | HTTP 401 `{"code":"50103","msg":"Request header OK-ACCESS-KEY can not be empty."}` |
| `api.mexc.com/api/v3/capital/config/getall` | HTTP 400 `{"code":400,"msg":"api key required"}` |
| `api.gateio.ws/api/v4/wallet/withdraw_status?currency=SOL` | HTTP 400 `MISSING_REQUIRED_HEADER` |
| `www.mexc.com/api/platform/asset/*` | WAF `Access Denied` |
| `www.okx.com/v2/asset/currency/list`, `/priapi/v5/asset/currencies` | HTTP 404 |

**But Binance publishes the whole table unauthenticated**, and my first pass missed it:

```
GET https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll
→ HTTP 200, success=true, 959 coins, 2.24 MB
```

Fetched **2026-09-18T08:56:49Z**. Same payload shape as the authenticated `sapi` route. Confidence: **MEASURED**.

### Binance Solana-network withdrawal fee, priced in bps of the clip

| Asset | Fee (token) | Fee (USD) | @ $1k | @ $10k | @ $50k | Min withdrawal |
|---|---:|---:|---:|---:|---:|---:|
| SOL | 0.001 | 0.106 | 1.06 | **0.11** | 0.02 | 0.01 |
| KMNO | 18 | 0.495 | 4.95 | 0.49 | 0.10 | 36 |
| TNSR | 14 | 0.491 | 4.91 | 0.49 | 0.10 | 28 |
| BOME | 530 | 0.505 | 5.05 | 0.51 | 0.10 | 1 060 |
| W | 50 | 0.512 | 5.12 | 0.51 | 0.10 | 100 |
| RENDER | 0.34 | 0.516 | 5.16 | 0.52 | 0.10 | 0.68 |
| JTO | 1.14 | 0.518 | 5.18 | 0.52 | 0.10 | 2.28 |
| GRASS | 1.52 | 0.518 | 5.18 | 0.52 | 0.10 | 3.04 |
| POPCAT | 11 | 0.518 | 5.18 | 0.52 | 0.10 | 22 |
| BONK | 184 466 | 0.519 | 5.19 | 0.52 | 0.10 | 368 932 |
| WIF | 2.7 | 0.521 | 5.21 | 0.52 | 0.10 | 5.4 |
| PENGU | 69 | 0.522 | 5.22 | 0.52 | 0.10 | 138 |
| ME | 8.03 | 0.522 | 5.22 | 0.52 | 0.10 | 16 |
| MEW | 1 283 | 0.525 | 5.25 | 0.53 | 0.11 | 2 566 |
| PUMP | 125 | 0.528 | 5.28 | 0.53 | 0.11 | 250 |
| IO | 3.84 | 0.530 | 5.30 | 0.53 | 0.11 | 7.68 |
| ORCA | 0.37 | 0.531 | 5.31 | 0.53 | 0.11 | 0.74 |
| TRUMP | 0.26 | 0.533 | 5.33 | 0.53 | 0.11 | 0.52 |
| PYTH | 8.91 | 0.536 | 5.36 | 0.54 | 0.11 | 17 |
| JUP | 2.13 | 0.541 | 5.41 | 0.54 | 0.11 | 4.26 |
| RAY | 0.34 | 0.586 | 5.86 | 0.59 | 0.12 | 0.68 |
| MOODENG | 10 | 0.429 | 4.29 | 0.43 | 0.09 | 100 |
| FARTCOIN | 3 | 0.456 | 4.56 | 0.46 | 0.09 | 6 |

DRIFT is not listed on Binance, consistent with §2.

**I was wrong to assume this would be the binding cost.** Binance normalises SPL-token withdrawals to roughly **$0.50 flat**, and SOL itself to $0.106. At a $10k clip that is **0.5 bps** — a rounding error, not a barrier. The fixed-cost intuition carried over from the 9 000-lamport DEX-DEX result does not transfer: that fee was fixed against sub-$100 circuits, this one is fixed against $10k clips. The withdrawal fee only bites below roughly $1 000 per transfer, where it costs ~5 bps.

**Still UNKNOWN:** OKX and MEXC withdrawal fees, and Gate's (Gate publishes the minimum and the enabled flags but not the fee). Since MEXC is the cheapest venue on the taker leg for 15 of 24 assets, its unknown withdrawal fee is the one that matters most. **What would measure it:** read-scoped API key on `GET /api/v3/capital/config/getall` (MEXC), `GET /api/v5/asset/currencies` (OKX), `GET /api/v4/wallet/withdraw_status` (Gate).

---

## 7. Cross-CEX executable gap — the control experiment

For each asset, across every ordered venue pair, walking both books for the same notional: buy at the best achievable average on one venue, sell at the best achievable average on another. **Gross of all fees.** Negative = no gap exists.

| Asset | Mid dispersion bps | gap@1k | gap@10k | gap@50k | Best route @10k |
|---|---:|---:|---:|---:|---|
| SOL | 0.95 | **0.0** | **0.0** | −1.4 | okx → binance |
| TRUMP | 4.88 | −2.6 | −6.4 | −18.4 | okx → binance |
| PUMP | 4.73 | −1.9 | −10.1 | −22.8 | okx → mexc |
| PENGU | 3.97 | −4.3 | −9.9 | −23.9 | binance → mexc |
| JUP | 5.91 | −5.1 | −12.3 | −46.8 | mexc → binance |
| PYTH | 4.99 | −5.6 | −15.3 | −66.6 | mexc → binance |
| WIF | 0.00 | −5.2 | −16.5 | −45.4 | okx → mexc |
| RENDER | 3.30 | −11.8 | −16.8 | −44.4 | binance → mexc |
| BONK | 10.66 | −9.3 | −14.8 | −50.2 | binance → okx |
| GRASS | 5.87 | −11.9 | −20.2 | −48.6 | gate → okx |
| RAY | 10.73 | −12.3 | −32.9 | −128.9 | binance → okx |
| BOME | 4.20 | −12.8 | −33.8 | n/a | mexc → binance |
| JTO | 1.10 | −12.9 | −40.7 | −76.5 | mexc → okx |
| IO | 1.81 | −17.8 | −50.8 | −127.1 | mexc → binance |
| ORCA | 3.48 | −14.7 | −51.6 | n/a | binance → mexc |
| KMNO | 9.10 | −15.3 | −52.0 | −172.9 | binance → mexc |
| W | 7.81 | −17.2 | −59.2 | −314.5 | mexc → okx |
| FARTCOIN | 3.62 | −9.0 | −64.7 | n/a | gate → mexc |
| ME | 13.08 | −22.2 | −65.7 | −1 123.7 | mexc → binance |
| TNSR | 11.41 | −18.7 | −75.8 | −208.4 | mexc → binance |
| MOODENG | 8.16 | −29.0 | −687.6 | n/a | okx → gate |
| MEW | 0.00 | −37.9 | −916.9 | n/a | okx → gate |
| POPCAT | 9.56 | −56.4 | −1 270.0 | n/a | gate → mexc |
| DRIFT | 14.30 | −134.9 | −5 081.9 | n/a | mexc → gate |

**130 observations across 24 assets × 3 sizes × 2 snapshots. Zero positive.** The maximum is SOL at exactly 0.00 bps — the four venues' books are locked together to the tick.

Read the ordering: the gap gets *more* negative as the asset gets less liquid, and as size grows. That is the signature of a market with no dispersion in which you are simply paying two spreads. The mid dispersion column shows why — the widest mid-to-mid disagreement in the entire sample is 14.3 bps (DRIFT), and on that asset crossing the spread costs 5 000 bps. Dispersion and executability are inversely related here, which is the standard reason a spread that looks visible on a chart is not a trade.

### Persistence: the dispersion is not a mispricing, it is noise that moves together

Comparing the two snapshots 4 min 50 s apart:

- No asset flipped to a positive gap in either snapshot.
- The "best route" flipped direction on 13 of 24 assets between snapshots (e.g. PENGU `binance→mexc` became `mexc→binance`, JTO `mexc→okx` became `okx→mexc`). A genuine venue-level basis has a sign that persists; a sign that reverses inside five minutes is quote noise around a common mid.
- Where prices moved, they moved **together**. MEW: +26.9 bps (OKX), +25.7 (MEXC), +28.1 (Gate). TRUMP: −9.8 (Binance), −4.9 (OKX), −9.8 (MEXC), −9.0 (Gate). The common factor absorbs essentially all the variance; there is no venue-specific residual to harvest.

---

## 8. The number the DEX side needs: cost of the CEX leg

A DEX-CEX cycle touches the CEX **once** per leg. So the CEX-side cost of "sell the token on a CEX" is:

> `cost_bps = taker_fee_bps + sell_slippage_vs_mid_bps`

Best achievable across venues (OKX marked `*` — assumed 10 bps taker, unconfirmed). `—` = book exhausted before the notional filled.

| Asset | $1 000 | venue | $10 000 | venue | $50 000 | venue |
|---|---:|---|---:|---|---:|---|
| **SOL** | **5.5** | mexc | **5.5** | mexc | **5.9** | mexc |
| PYTH | 6.7 | mexc | 6.7 | mexc | 12.7 | mexc |
| JUP | 7.0 | mexc | 7.0 | mexc | 18.4 | mexc |
| FARTCOIN | 7.0 | mexc | 40.0 | gate | 211.4 | mexc |
| TRUMP | 7.4 | mexc | 9.6 | mexc | 15.6 | mexc |
| WIF | 7.6 | mexc | 10.3 | mexc | 25.5 | mexc |
| PUMP | 8.0 | mexc | 11.0 | mexc | 17.2 | mexc |
| PENGU | 8.7 | mexc | 10.2 | mexc | 15.7 | mexc |
| JTO | 11.5 | mexc | 27.7 | okx* | 42.7 | okx* |
| KMNO | 11.7 | mexc | 32.2 | mexc | 91.0 | binance |
| BONK | 11.8 | okx* | 15.9 | okx* | 28.1 | okx* |
| GRASS | 12.3 | mexc | 25.9 | okx* | 40.7 | okx* |
| RENDER | 13.5 | mexc | 14.7 | mexc | 25.9 | mexc |
| ORCA | 14.4 | mexc | 28.5 | mexc | 517.2 | binance |
| RAY | 14.9 | mexc | 27.9 | okx* | 55.4 | binance |
| IO | 15.5 | mexc | 24.7 | mexc | 56.8 | mexc |
| BOME | 17.3 | okx* | 25.3 | mexc | — | — |
| ME | 18.9 | mexc | 61.7 | okx* | 141.9 | binance |
| W | 19.7 | okx* | 33.2 | okx* | 60.0 | okx* |
| MOODENG | 20.2 | okx* | 48.5 | okx* | 1 281.0 | okx* |
| MEW | 20.7 | okx* | 647.7 | gate | — | — |
| TNSR | 24.3 | binance | 40.1 | binance | 114.1 | binance |
| POPCAT | 38.9 | gate | 186.0 | gate | — | — |
| DRIFT | 60.8 | gate | 183.4 | gate | — | — |

**This is a floor, not an estimate.** It excludes the withdrawal fee (§6, UNKNOWN), the SOL/USDT conversion leg forced by §2a, and every on-chain cost.

### What the DEX side has to beat

The full CEX-side stack for the *most favourable* asset in the sample, $10k clip on SOL:

| Component | bps | Confidence |
|---|---:|---|
| Taker fee, cheapest venue (MEXC 5.0) | 5.00 | MEASURED |
| Slippage vs mid at $10k | 0.47 | MEASURED |
| Solana withdrawal fee (Binance $0.106) | 0.11 | MEASURED |
| SOL↔USDT conversion forced by the absence of `/SOL` pairs (§2a) | ≥ 5.00 | MEASURED (second taker fee) |
| **Deterministic CEX-side subtotal** | **≈ 10.6** | |
| 1-minute inventory risk, 1σ (§9a) | ± 7.55 | MEASURED |
| DEX leg: pool fee + impact + 9 000 lamports | — | DEX agent |
| MEXC withdrawal fee | UNKNOWN | — |

So the DEX side must produce a gap **larger than ~11 bps deterministic cost, consistently enough to survive ±7.6 bps of per-cycle noise**, on the single most liquid asset on Solana — and it must do so against a CEX quote that, as §7 shows, never disagreed with any other CEX quote by more than 0.00 bps in 130 observations.

For anything outside the top eight assets the deterministic CEX subtotal is 25–60 bps and the per-cycle noise is 10–23 bps, which lands in the same region as the 275 bps median round-trip pool fee that already defeated the DEX-DEX circuit.

---

## 9. Solana deposit / withdraw status

**Gate — MEASURED.** All 24 assets have a live Solana chain with deposits and withdrawals enabled at 08:49Z. Source: `https://api.gateio.ws/api/v4/wallet/currency_chains?currency={ASSET}` and `/api/v4/spot/currencies/{ASSET}`.

| Asset | SOL chain | Deposit | Withdraw | Min withdrawal | Mint |
|---|:-:|:-:|:-:|---:|---|
| SOL | yes | OK | OK | 0.1 | native |
| BONK | yes | OK | OK | 3 547.35722 | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |
| WIF | yes | OK | OK | 0.051948 | `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` |
| JUP | yes | OK | OK | 0.039401 | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` |
| JTO | yes | OK | OK | 0.02207018 | `jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL` |
| PYTH | yes | OK | OK | 0.166279 | `HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3` |
| RAY | yes | OK | OK | 0.005794 | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` |
| W | yes | OK | OK | 0.980969 | `85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ` |
| PENGU | yes | OK | OK | 1.32503 | `2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv` |
| TRUMP | yes | OK | OK | 0.004885 | `6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN` |
| ORCA | yes | OK | OK | 0.006977 | `orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE` |
| ME | yes | OK | OK | 0.15456 | `MEFNBXixkEbait3xn9bkm8WsJzXtVsaJEn4c8Sam21u` |
| KMNO | yes | OK | OK | 0.363901 | `KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS` |
| TNSR | yes | OK | OK | 0.28522533 | `TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6` |
| IO | yes | OK | OK | 0.07263219 | `BZLbGTNCSFfoth2GYDtwr7e4imWzpR5jqcUuGEwr646K` |
| BOME | yes | OK | OK | 10.471204 | `ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82` |
| PUMP | yes | OK | OK | 2.375466 | `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` |
| RENDER | yes | OK | OK | 0.00659935 | `rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof` |
| GRASS | yes | OK | OK | 0.02938584 | `Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs` |
| MOODENG | yes | OK | OK | 0.232234 | `ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY` |
| MEW | yes | OK | OK | 24.43196 | `MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5` |
| POPCAT | yes | OK | OK | 0.21290185 | `7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr` |
| FARTCOIN | yes | OK | OK | 0.065837 | `9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump` |
| DRIFT | yes | OK | OK | 0.569606 | `DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7` |

The mint addresses are worth handing to the DEX agent: they are Gate's own declaration of which SPL mint it credits, which removes the "wrong mint" failure mode when pairing a CEX symbol to an on-chain pool.

**Binance — MEASURED**, via the public `bapi` endpoint in §6, fetched 08:56:49Z. All 23 Binance-listed assets show `depositEnable: true` and `withdrawEnable: true` on the Solana network, with `minConfirm: 1` and `estimatedArrivalTime: 1` minute. No asset on the list is currently halted on either venue that I could measure.

One counter-example in the same payload proves the flags are live rather than decorative: HNT on Solana returns `depositEnable: false, withdrawEnable: false`. The field does go false in practice.

**OKX, MEXC — UNKNOWN.** Both expose network status only behind authenticated wallet endpoints (§6). I could not confirm from a public source whether SOL-network deposits or withdrawals are currently enabled on either, for any asset.

This matters more than it looks. A halted Solana network on the venue holding your inventory converts a market-neutral position into an outright directional bet for the duration of the halt, and halts correlate with exactly the volatility that produces the gaps you were trying to trade. Since MEXC is the cheapest execution venue for 15 of 24 assets (§8), its unmeasured halt status is a live hole in the risk model.

---

## 9a. The transfer window, and why it decides the question

A DEX–CEX cycle is **not atomic**. Between the two legs the position sits on the wire. Binance publishes its own estimate of that window: `minConfirm: 1`, `estimatedArrivalTime: 1` minute.

So: how much can the price move in one minute? Measured from public 1-minute klines, last 1 000 bars, `https://api.binance.com/api/v3/klines?symbol={SYM}&interval=1m&limit=1000`, fetched 08:57Z:

| Asset | σ over 1 min (bps) | σ over 5 min (bps) | 95th pct \|1-min move\| (bps) |
|---|---:|---:|---:|
| SOL | **7.55** | 16.88 | 16.07 |
| PENGU | 9.35 | 20.90 | 19.79 |
| WIF | 9.37 | 20.96 | 20.78 |
| TRUMP | 10.62 | 23.75 | 20.44 |
| PYTH | 14.23 | 31.82 | 31.31 |
| PUMP | 16.39 | 36.65 | 30.90 |
| JUP | 17.53 | 39.20 | 34.95 |
| BONK | **22.98** | 51.38 | 36.90 |

Put this next to the edge budget. On SOL — the best case in every other respect — the cheapest CEX leg costs 5.47 bps, the gross cross-venue gap is 0.00 bps, and the one-minute price risk you must carry to capture it is **7.55 bps at one sigma**. The noise is larger than the entire prize, before the DEX leg is priced at all.

And one minute is the optimistic figure: it is Binance's own arrival estimate for a *single* transfer, and it excludes the venue's internal withdrawal-approval queue, the DEX transaction's own confirmation, and the rebalancing round trip needed to reset inventory. A realistic window is minutes, where σ scales as √t — 16.9 bps for SOL at five minutes, 51.4 bps for BONK.

This is the structural break from the DEX-DEX work. That engine failed on *costs* — pool fees and a fixed lamport toll — and a cost problem can in principle be engineered away. This fails on *variance*: the strategy is not market-neutral over its holding period, and the un-hedged exposure is several times the edge. Calling it arbitrage is a category error.

---

## 10. What I could not measure

| Gap | Why | What would close it |
|---|---|---|
| **MEXC withdrawal fee** | `capital/config/getall` needs a key; web endpoints WAF-blocked | read-scoped MEXC API key. **Highest value** — MEXC is the cheapest taker venue for 15 of 24 assets, so it is the venue the strategy would actually use |
| OKX spot taker fee | every public fee page is client-rendered or login-gated | authenticated `GET /api/v5/account/trade-fee?instType=SPOT` |
| OKX / Gate withdrawal fees | authenticated endpoints only | `GET /api/v5/asset/currencies`, `GET /api/v4/wallet/withdraw_status` |
| Deposit/withdraw enabled — OKX, MEXC | authenticated endpoints only | same keys |
| Real end-to-end transfer latency | Binance's 1-minute figure is its own estimate, and excludes withdrawal-approval queueing | time actual transfers; until then treat 1 min as a lower bound |
| Whether quoted depth is real | a book is a promise, not a fill | a live taker order — out of scope here, and the reason every number above is a floor |
| Per-asset MEXC/Gate fee discounts for this account | account-specific | authenticated fee endpoint |
| DEX-side prices at the same instants | out of this agent's scope | the `dex_side` agent, ideally timestamp-aligned to 08:46:27Z and 08:51:17Z |

Note one correction against my own first pass: I initially recorded withdrawal fees as UNKNOWN on all four venues and reasoned that they would be the binding constraint, by analogy with the 9 000-lamport DEX-DEX toll. Binance publishes them without authentication, they are ~$0.50 flat, and at $10k that is 0.5 bps. The analogy was wrong and the assumption was pessimistic in the wrong place. The binding constraint is elsewhere — §9a.

---

## 11. Assessment

The CEX side does not supply the edge the DEX side was missing.

What genuinely improved versus DEX-DEX:

- **The taker fee is far cheaper than a pool fee.** 5 bps at MEXC against a 275 bps median round-trip pool fee is a 50× improvement on the single cost that killed the previous circuit.
- **The withdrawal fee is negligible at size.** ~$0.50 flat, 0.5 bps at $10k. I expected this to be the killer and it is not.
- **Depth is real on the majors.** $4.1m rests within 50 bps of the mid on Binance's SOL ask. Price impact, the second DEX-DEX blocker, effectively vanishes for the top eight assets.

What kills it anyway:

- **There is no dispersion to harvest. Zero of 130 cross-venue observations showed a positive gap before any fee.** The maximum was SOL at exactly 0.00 bps. Where mids did disagree, the disagreement reversed sign within five minutes and the venues moved together (MEW: +26.9/+25.7/+28.1 bps simultaneously). That is common-factor noise, not a basis.
- **The floor cost is ~11 bps** on the best asset: 5.0 taker + 0.47 slippage + 0.11 withdrawal + ≥5.0 for the SOL↔USDT conversion that the total absence of `/SOL` spot pairs forces on every cycle.
- **The cycle is not atomic, and the gap between the legs is priced in variance, not fees.** One minute of exposure is 7.55 bps of 1σ move on SOL and 22.98 bps on BONK — larger than the entire edge budget, on the asset where the edge budget is largest.

The last point is the real answer, and it is a different failure mode from the DEX-DEX result. That engine failed on costs, and costs are an engineering problem: better routing, cheaper venues, bigger clips. This fails on the holding period. The position is directional for as long as the transfer takes, the un-hedged variance is several multiples of the edge, and no amount of execution quality shortens a Solana withdrawal.

**So: not a safe strategy, and specifically not an arbitrage.** A DEX-CEX gap large enough to clear ~11 bps of deterministic cost would have to come entirely from the DEX side, and would have to persist across a multi-minute transfer rather than one Solana slot. A trade held for minutes on unhedged inventory to capture a single-digit-bps spread is a directional carry position with an arbitrage label on it — the same mislabelling already recorded in this account's funding-settlement (§541) and funding-carry work, where the apparent edge turned out to be the payment for a risk being carried.

Two caveats that could move this conclusion, both stated so they can be checked rather than assumed:

1. Every figure is a **floor**. Quoted depth is a promise; only a live order measures the fill. If real depth is thinner than quoted, the costs above rise and the conclusion strengthens.
2. This is **two snapshots on one quiet morning**. Cross-venue dispersion is a fat-tailed, event-driven quantity: the interesting gaps appear during listings, depegs, halts and liquidation cascades, and none of those occurred in this 5-minute window. What I have measured rules out a *persistent, harvestable* baseline spread — which is the thing the strategy would need. It does not rule out event-driven dislocations, and it says nothing about whether those are capturable, since they coincide exactly with the network halts and withdrawal queues that §9 could not measure on MEXC and OKX.

---

## Files

- `/home/rares/trading/sol/atomarb/.scratch/dexcex/cex_side.md` — this note
- `/home/rares/trading/sol/atomarb/.scratch/dexcex/cex_side.json` — consolidated measurements, per asset/venue/size, with source URL and fetch timestamp on every figure
- `/home/rares/trading/sol/atomarb/.scratch/dexcex/raw_books.json` — snapshot 1, top 30 levels per side per book
- `/home/rares/trading/sol/atomarb/.scratch/dexcex/raw_books_t2.json` — snapshot 2
- `/home/rares/trading/sol/atomarb/.scratch/dexcex/gate_networks.json` — Gate chain status, minimums, mints
- `/home/rares/trading/sol/atomarb/.scratch/dexcex/cex_leg_cost.json` — CEX-leg cost table
- `/home/rares/trading/sol/atomarb/.scratch/dexcex/binance_sol_networks.json` — Binance Solana deposit/withdraw status, fees, minimums, confirmations
- `/home/rares/trading/sol/atomarb/.scratch/dexcex/binance_withdraw_bps.json` — withdrawal fees converted to bps per clip size
- `/home/rares/trading/sol/atomarb/.scratch/dexcex/realised_vol.json` — 1-minute realised volatility per asset

No file under `src/` or `tests/` was touched. No git command was run. No order was placed, signed or simulated.
