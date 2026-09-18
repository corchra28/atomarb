# What this project demonstrates

A note for anyone evaluating this repository as evidence of capability, rather than as a trading system.

**The headline is that it reached a negative conclusion and says so.** The engine works, the measurements are exhaustive, and the answer is that the strategy as built does not pay. That is stated in `DECISION.md`, in `TERMINAL_SUMMARY.txt`, and in the three audit documents, with the numbers that force it.

That is the unusual part. "I built an arbitrage bot and it was profitable" is a claim anyone can make and nobody can check. This repository contains the opposite: a claim that can be checked, that took real work to establish, and that was not worth faking.

---

## Specific technical ground covered

**On-chain state, decoded byte-exactly.** Raydium CPMM `PoolState` (637 bytes, discriminator `f7ede3f5d7c3de46`, `vault_amount_without_fee`, ceiling trading fee with floored creator split, status bit 2 and `open_time` gating, authority PDA). PumpSwap pools across nine observed size variants (211 through 301 bytes), with effective quote reserves as vault plus `virtual_quote_reserves`, fee tiers by market capitalisation, and the `user_volume_accumulator` rent account. Token-2022 TLV extensions parsed from offset 166, including `TransferFeeConfig` with older and newer epoch tiers and the capped ceiling calculation.

**Swap math replicated and verified against the real programs.** Quotes are not approximated from a formula in a blog post. Mainnet program binaries are dumped and executed in LiteSVM against real account data, and the engine's predicted output is compared to the program's actual output. They match exactly. `tests/integration/*_local_program.test.ts`.

**An on-chain program.** An Anchor executor in Rust with a 45-byte instruction ABI, 37 distinct error codes, the second leg sized from the measured first-leg delta rather than from a quote, and a spend guard. Built locally and never deployed. `docs/EXECUTOR_ABI.md`.

**Infrastructure that holds under load.** Request budgets reserved atomically, timeouts that cover the whole request body, a WebSocket lifecycle that always settles and tracks state revisions so a stale decision is detectable, and staleness re-checked at both decision time and simulation time. 291 passing tests, plus a fault-injection suite that breaks one invariant at a time and confirms the tests catch it, nine for nine.

**Accounting that reconciles.** Every lamport of an attempt is explained or the attempt is flagged `ACCOUNTING_INCOMPLETE`. Trading profit, definitive costs, locked-but-recoverable deposits and the liquid wallet delta are kept separate, because conflating rent with fees is how a losing strategy looks profitable. `docs/ACCOUNTING.md`.

**It survived an independent audit.** Seven defects were found by an outside reviewer against commit `2c78a61`. All seven are fixed, each with a regression test that fails against the old code. `docs/AUDIT_RESPONSE.md`.

---

## Measurement discipline, which is the rarer half

The repository documents its own errors as prominently as its results. Four that mattered:

- **A denomination error in my own favour.** A reported spread of +6.3 basis points on SOL was the USDC/USDT stablecoin basis, because the on-chain leg was quoted in one dollar and the exchange leg in another. Caught by running both denominations against each other at the same instant, 160 matched samples, none above 5 basis points. `docs/DEX_CEX_AUDIT.md` §1.
- **A daily rate built on one observation.** Total network tips first measured at $413,000 a day over 60 blocks. One transaction carried 72% of that sample. Over 150 blocks the figure is $68,600. `docs/REAL_WORLD_MEV.md` §8.
- **A conclusion drawn from the wrong half of the data.** "Most searchers pay nothing for block position, so this is won on latency" was wrong: 55 of the 58 paying only the base fee also pay a Jito tip, and 101 of 104 pay for position by one channel or the other.
- **A classifier that counted ordinary users as arbitrageurs**, until it was made to require that the circuit actually closes.

Each of these would have produced a confident, wrong, publishable number. Each was found by testing the measurement rather than the strategy.

---

## What the work concluded, in one paragraph

Atomic arbitrage on Solana is real: 104 verified profitable circuits were counted in 120 blocks, from 51 distinct signers. It pays about $21,000 a day across everyone doing it, with a median trade worth a quarter of a cent and the top three trades taking 56% of all profit. It is won through a tip auction that you must be fast enough to enter, which means a co-located node and a direct feed. And it lives between concentrated-liquidity venues and continuous curves — 98 of the 104 winners include a Whirlpool, a DLMM, a CLMM or a DAMM v2, while zero used only the two constant-product adapters this engine implements. Total tips across every category of extraction are about $68,600 a day, so the whole market is small, not merely this corner of it.

---

## Reproducing any of it

Everything above is re-runnable from a clean checkout with a read-only RPC endpoint. No key material exists in the repository, `execution.live` is a schema literal `false`, and every submit method is blocked at the transport layer. Raw data and the scripts that produced it are under `docs/sources/`.
