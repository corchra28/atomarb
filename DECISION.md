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

## Economic result

See the terminal block in `TERMINAL_SUMMARY.txt` and `reports/runs/<runId>/RUN_REPORT.md`. On the population actually measured, every circuit is negative at every size: the executable price gap between two pools of the same mint is smaller than the fees those two pools charge. This is a result about **this** population in **this** window, not a proof that Solana atomic arbitrage is impossible.

## The next test that could change the conclusion

Ranked by how much they would change the answer per unit of work:

1. **Cover the pools that were excluded.** The 5,000-pool cap and the 13-day-old PumpSwap inventory hide exactly the venues where gaps are widest: newly migrated, thin, fast-moving pools. Rebuild the inventory from the chain (a program-account scan or an indexer) and re-run the same engine. This is the single largest lever and costs only data.
2. **Look at the moment a gap appears, not at a 4-second poll.** The engine currently polls; subscribing to the vaults over WSS (already implemented) and re-quoting on notification measures whether gaps exist between polls. Needs a private endpoint.
3. **Add one adapter with a different fee model** (Meteora DAMM v2 or DLMM). Two constant-product pools of the same token with 25 to 125 bps of fees rarely diverge enough; a different curve family changes that arithmetic.
4. **Only then**: a funded simulation identity, a mainnet lookup table, and the landing-rate question (which cannot be answered before live).

Nothing in this lot supports enabling live trading, and a simulated positive candidate would not change that on its own.
