# DECISION

*Filled from artefacts only. Run-specific numbers come from `reports/runs/<runId>/RUN_REPORT.json`, `reports/population_*.json`, `reports/route_gaps_*.json`, `reports/fault_injection.json` and `TEST_REPORT.md`.*

## What works (verified, with the evidence that proves it)

- **Exact quoting against the real programs.** For both adapters, the quoted output equals the on-chain result to the lamport: the user's output token account delta equals `amountOutToUser` and the input delta equals `amountIn`, executed in LiteSVM with the **mainnet program ELFs** and **real account snapshots**. Raydium CPMM: 5 fixture pools, both directions, `minimum_amount_out = quote + 1` fails with `ExceededSlippage` (the quote is tight). PumpSwap: 3 fixture pools (canonical, boosted with non-zero virtual reserves, non-canonical), 6 sizes.
- **The two-leg circuit reproduces the quote.** On the two captured routes (cross-adapter Raydium+PumpSwap, and PumpSwap+PumpSwap), both directions, six sizes each (24 combinations): realised WSOL delta equals the quoted trading PnL exactly, with zero leftover intermediate inventory.
- **The atomic guard works.** The Rust executor (built locally, never deployed) sizes leg B from the **measured** intermediate delta, requires the intermediate balance to return to its initial value, and requires `base_after >= base_before + min_profit`. On real state it reverts the losing circuits with `ProfitBelowMin` after both real CPIs; on a synthetic positive route it passes at exactly the quoted profit and fails one lamport above it.
- **The accounting does not invent money.** Fees inside the quotes are listed but never subtracted twice; `getFeeForMessage` replaces the base+priority formula when available; ATA rent is locked capital, and the PumpSwap first-buy rent for `user_volume_accumulator` (1,844,400 lamports) is measured as an observed cost. Fault injection: 7 deliberate defects (dropped creator fee, raw vault reserves, double-counted fees, selling pre-existing inventory, copied instead of measured PnL, unblocked submit methods, a multi-call fetch claimed as atomic) were each caught by the suite.
- **The read-only boundary holds.** Submit RPC methods are refused before any network call; `execution.live` cannot be true; no private key exists anywhere in the project.

## What does not work yet (and why)

- **Mainnet simulation of the swap path** stops at the first token transfer with an unfunded identity. The transaction, its accounts, size, compute budget and fee are verified on mainnet; the swap arithmetic on mainnet state is verified locally instead. Needs a funded wallet's **public key** (`SIM_IDENTITY_PUBKEY`).
- **Any circuit with a PumpSwap leg exceeds the 1,232-byte transaction limit** (1,262 to 1,684 bytes observed) and needs an address lookup table. Creating one is a write, which this lot does not do; local probes fabricate a LOCAL-ONLY table.
- **The executor is not deployed** (`MAINNET_ATOMIC_GUARD_NOT_DEPLOYED`), so the dynamic-amount circuit cannot land on mainnet even if it were profitable.
- **Coverage is a lower bound.** The Raydium listing was capped at the 5,000 most liquid Standard WSOL pools (tvl floor about $10.3k) and the PumpSwap inventory is a snapshot from 2026-09-04. Pools below that rank or created since are not covered.

## Economic result — re-measured on a private endpoint (2026-09-18)

The public endpoint was the binding limit in the first run. With a paid endpoint (about 150 ms per call), the WebSocket path working, and the audit fixes in place, the same engine ran the full hour over 367 pools and 151 routes:

| | first run (public) | second run (private) |
|---|---|---|
| duration / stop reason | 55 min, HTTP budget | **60 min, deadline** |
| route snapshots | 4,860 | **18,670** |
| circuit evaluations | 17,676 | **75,542** |
| positive gross evaluations | 0 | **26** |
| candidates above the minimum net profit | 0 | **0** |
| RPC requests / errors | 10,000 / 276 rate-limited | **37,357 / 0** |
| WebSocket | not used | **4,560 notifications, 0 dropped, 0 gaps, 0 reconnects** |
| state age at the decision (p50) | 3 ms, measured at the wrong instant | **21 ms, measured at the decision itself** |

The 26 positive evaluations are the first ever recorded, and they say exactly what the sweep said: all of them fall on one mint, at about 0.0015 SOL, worth 5,123 to 5,489 lamports gross, which is **3,511 to 3,877 lamports short of the 9,000-lamport network fee**. The gap persisted across thirteen minutes and twelve consecutive observations, so it was not a snapshot artefact; it was simply never large enough to pay for the transaction that would capture it.

The full-population sweep with the liquidity filter tells the same story without any time dimension: 151 mints, 206 dust pools dropped, 96 real circuits, zero positive at any size.

Two things the fixes bought that are worth recording: the scanner saw 20 cases where a vault notification landed while the route was being processed, each of which the old dirty-set would have dropped, and not a single decision was stale at the 1,500 ms threshold.

## Economic result (first run, public endpoint)

**NO_VERIFIED_EDGE.** Two independent measurements say the same thing.

*The 60-minute prospective run* (`reports/runs/shadow_2026-09-17T18-09-25-841Z_32a7b818/`): 50 pools validated on-chain, 22 routes, 221 polls, 4,860 route snapshots, **17,676 circuit evaluations across the whole sizing grid, zero positive**. It stopped on its 10,000-request budget at 55 minutes, with 276 HTTP 429s from the public endpoint and no data gaps (`snapshot_incomplete = 0`, `errors = 0`). Decision latency was small compared to a slot: snapshot p50 349 ms / p95 1,409 ms, quoting p50 17 ms, state age at the decision p50 3 ms.

*The population sweep* (`reports/route_gaps_*.md`, 612 circuits over 151 mints, 302 requests, one snapshot per mint) is the decisive measurement:

| measure | value |
|---|---|
| circuits measured | 612 (544 same-adapter PumpSwap, 68 cross-adapter) |
| circuits with positive **gross** PnL at some size | 22, every one of them only at 0.0001 to 0.001 SOL |
| largest gross PnL seen anywhere | **2,663 lamports**, against a network fee of 9,000 |
| circuits with positive **net** PnL at any size | **0** |
| median best gross PnL across circuits | −454 bps |
| routes whose thinner pool holds < 0.01 SOL | 458 of 612 |

A coverage experiment ran alongside it: listing 100,000 Standard WSOL pools instead of 25,000 (Raydium CPMM pools with WSOL: 3,107 → 12,043) moved the cross-adapter intersection from 24 mints to **26** and the Raydium-only pairs from 5 to 7. Coverage is therefore not what is missing; the same-mint pairs that exist are simply too thin on one side.

*The earlier 80-circuit diagnostic* said the same thing on a smaller sample:

| measure | value |
|---|---|
| circuits with positive gross PnL at any size | 1 of 80 |
| that circuit's best gross PnL | 986 lamports at 0.0001 SOL (network fee alone: 9,000 lamports) |
| the same circuit one size up (0.001 SOL) | −105,506 lamports |
| median best gross PnL across circuits | −420 bps |
| routes whose thinner pool holds < 0.01 SOL | 54 of 80 |

The reason is liquidity, not fees: the cross-adapter intersection pairs a normal Raydium pool with a PumpSwap pool holding a few thousandths of a SOL, so price impact swamps any gap above dust size. Where both sides are deep, the gap is smaller than the fees. This is a result about **this** population in **this** window, not a proof that Solana atomic arbitrage is impossible.

## The wide-gap search, run over the entire chain (2026-09-18)

The obvious objection to everything above is "you only looked at a shortlist; filter for pools with a gap above 100 bps and look there". That search now exists (`scripts/gap_radar.ts`) and it reads the whole population directly from the chain rather than from an index API:

| | via index API (before) | direct from chain (now) |
|---|---|---|
| PumpSwap pools quoted in WSOL | 25,061 (a 13-day-old file) | **322,557** |
| Raydium CPMM pools with WSOL | 12,043 (listing capped) | **218,303** |
| mints with two or more such pools | 156 | **7,405** |
| cost of the scan | — | 362 requests, about 2 minutes |

Filtering for a price gap of at least 100 bps with at least 1 SOL on the thinner side leaves **122 pairs**. Quoting the best 60 of them through the real engine (`scripts/verify_candidates.ts`), with fees, impact, the sizing grid and the network cost: **zero are net positive**, and the best gross result anywhere is **754 lamports against a 9,000-lamport fee**.

The 118 circuits break down into exactly three structural reasons, which is the real answer to "why are there no gaps left":

1. **58 % of them: the gap is smaller than the two pools' own fees.** The median round-trip fee across these pairs is 275 bps, because one side is usually a high-fee tier (4 % pools are common). A gap of 150 bps between a 25 bps pool and a 400 bps pool is not an inefficiency, it is the fee wall itself.
2. **17 %: the "gap" is a Token-2022 transfer fee.** Moving the token between pools costs a percentage, so the price difference is permanent and uncapturable.
3. **The remaining 25 %: the gap is real but the pool is not.** Median headroom above fees is 38 bps, on a thinner side of 1 to 3 SOL. The engine's best size there is 0.001 SOL, worth a few hundred lamports, far under the fee.

That is the same wall from three directions: whatever survives on-chain is precisely what cannot be taken by someone paying 9,000 lamports per attempt.

## The next test that could change the conclusion

Ranked by how much they would change the answer per unit of work:

1. **~~Cover the pools that were excluded~~ — tested, and it did not change the answer.** Quadrupling the Raydium listing (25,000 → 100,000 pools) added two cross-adapter mints and two Raydium-only pairs, and the 612-circuit sweep still found no size with a positive net. What remains untested on this axis is a **fresh** PumpSwap inventory built from the chain: the current one is 13 days old, and a token's first hours after migration are exactly when two pools of the same mint can diverge. That is a data-collection job (program-account scan or an indexer), not an engine change.
2. **Look at the moment a gap appears, not at a 4-second poll.** The engine currently polls; subscribing to the vaults over WSS (already implemented) and re-quoting on notification measures whether gaps exist between polls. Needs a private endpoint.
3. **Add one adapter with a different fee model** (Meteora DAMM v2 or DLMM). Two constant-product pools of the same token with 25 to 125 bps of fees rarely diverge enough; a different curve family changes that arithmetic.
4. **Only then**: a funded simulation identity, a mainnet lookup table, and the landing-rate question (which cannot be answered before live).

Nothing in this lot supports enabling live trading, and a simulated positive candidate would not change that on its own.

## The DEX–CEX question, audited separately (2026-09-18)

A natural follow-up: if two on-chain pools no longer disagree, does a pool disagree with a centralised exchange? Audited in `docs/DEX_CEX_AUDIT.md`, over 24 Solana-native assets on Binance, OKX, MEXC and Gate. Same verdict, different mechanism.

The headline is a correction of my own first measurement. Quoting the DEX leg in USDC against a CEX book in USDT manufactures a spread equal to the stablecoin basis, about 7.5 bps, which is exactly the size that looks tradeable against a 5 bps taker fee. Denominated correctly, the SOL gap has a median of **−0.03 bps**.

| | |
|---|---|
| cross-venue observations, gross of all fees | 130 |
| of which positive | **0** |
| best gross gap, any asset, any size | 0.00 bps (SOL, exactly zero) |
| deterministic cost floor on the best asset | ~10.8 bps |
| 1-minute price risk carried between the legs, SOL | ±7.55 bps (1σ) |
| `/SOL`-quoted spot pairs across all four venues | **0** |

Two DEX–DEX blockers genuinely disappear here: the taker fee is 5 bps against a 275 bps median round-trip pool fee, and the withdrawal fee is about $0.50 flat, which is 0.5 bps at a $10k clip. The strategy still loses, because the cycle is not atomic and the unhedged variance over the transfer window exceeds the entire edge budget.

One finding from that audit applies directly to this engine: across 244 hops that Jupiter actually routed, the two adapters here (Raydium CP and PumpSwap) covered **2.05 %**, and exactly 1 leg of 80 routed entirely inside them. Real flow is dominated by proprietary market-maker venues — Scorch, HumidiFi, BisonFi, TesseraV — with no public pool state to read. That reorders item 3 in the list above: the gap in coverage is not another constant-product adapter, it is a venue class this engine cannot see at all.

## Who is actually winning, measured on-chain (2026-09-18)

The two audits above both asked "can I find a gap?" An on-chain census asks the practitioner's question instead — who is taking the money right now, and through what. Full result in `docs/REAL_WORLD_MEV.md`.

Reading 120 blocks and isolating transactions that close a circuit (all non-SOL token balances return to their start, only SOL rises) finds **104 verified profitable atomic arbitrages** among 135,552 transactions, from 51 distinct signers. So the strategy works. `NO_VERIFIED_EDGE` was a correct statement about this implementation, not about the strategy, and that distinction was not drawn clearly enough above.

Three measured facts reorder everything in the "next decisive test" list:

| | |
|---|---|
| arbitrages using only Raydium CPMM + PumpSwap, the two adapters here | **0 of 104** |
| touching at least one of the two | 45 of 104 |
| including at least one concentrated-liquidity venue | **98 of 104** |
| paying only the 5,000-lamport base fee (but 55 of those still tip) | 58 of 104 |
| paying nothing at all for block position | 3 of 104, worth $167 a day network-wide |
| share of all profit taken by the top 3 trades of 104 | 56% (top 10: 81%) |
| real winning trades whose entire profit is below the assumed 9,000-lamport cost | 43 of 123 |
| median take-home per trade | 24,585 lamports, about $0.0026 |
| total take-home across every searcher, per block | about $0.065, roughly $21,000 a day network-wide |

The engine was built on the one venue combination that never appears among the winners. Constant-product against constant-product tracks too closely to diverge past its own fees, which is exactly what the whole-chain radar found. The divergence lives between a concentrated-liquidity pool, which prices in ticks and can sit stale inside a range, and a continuous curve.

Revised order for the next decisive test:

1. **Add an Orca Whirlpool or Meteora DLMM adapter** and pair it against the existing two. This moves the engine from a combination appearing in 0 of 104 winners to combinations appearing in 45.
2. **Drop the flat 9,000-lamport fee assumption.** A majority of real winners pay 5,000 and no tip; the old floor sat above the entire profit of a third of the real opportunity set.
3. **Replace polling with a direct feed.** 101 of 104 winners pay for block position, most of them through the Jito tip rather than the priority fee, so seeing the state first is what lets you bid at all.

Even with all three done, the addressable prize is a fraction of $21,000 a day against 51 incumbents with existing infrastructure. The engineering is tractable; the economics of entering are the real blocker. That is a more useful conclusion than "no edge exists" and it is what the data supports.
