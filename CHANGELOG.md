# CHANGELOG

## 0.1.0 (2026-09-17) — MVP, read-only
- Core: adapter contract, integer math utilities, SPL/Token-2022 parsers, rate-limited read-only RPC client with hard budgets and submit guard, WSS manager with dedup/reconnect/gap marking, SQLite journal, run control (STOP file, deadline, budgets).
- Routing: circuit enumeration (cross-adapter + same-adapter, both directions), evaluation with leg B input == leg A output, sizing (grid + bounded refine, zero-trade candidate).
- Accounting: trading / transaction / operating PnL with cost provenance; getFeeForMessage used for the final message (no double counting).
- Simulation: v0 transaction builder + inspection, MAINNET_RPC_SIMULATION, LOCAL_REAL_PROGRAM_SIMULATION (LiteSVM with mainnet-dumped ELFs, synthetic labelled balances, exact deltas).
- CLI: doctor, discover, quote, simulate, shadow, report, stop.
- Primary-source notes (docs/sources) + sources.lock.json.
- Adapters (Raydium CPMM, PumpSwap) proven against the real mainnet ELFs in LiteSVM: quote == chain to the lamport on 5 + 3 fixture pools, both directions.
- Rust executor `arb_executor` built locally (ABI v2, 45-byte data, 37 error codes), never deployed.
- Discovery: Raydium API v3 (3,107 CPMM WSOL pools listed) + local PumpSwap inventory (25,061), population report, deterministic shortlist.
- Evidence: 263 tests (261 pass, 2 network tests skipped by default), 23 Rust host tests, 7 fault injections all caught, an independent re-derivation of both curve maths.
- First prospective run: 17,676 circuit evaluations, zero positive; verdict NO_VERIFIED_EDGE.

### Applied after adversarial review (four independent reviewers, `docs/agent_runs/workflow_results.json`)
- discovery: warn on any early stop, never clobber a good listing cache, age only from provenance, chunk all pool-key ids, timeout covers the body, order-independent duplicate resolution, single-run lock.
- raydium_cpmm: creator-fee path executed on the real program in all three positions, swap gate inside `quoteExactIn`, protocol+fund invariant, epoch-active transfer-fee warning, declared older fee tier, `bps > 10000` returns null, deduplicated `accountsNeeded`.
- pumpswap: transfer-fee tier chosen by epoch (worst case per amount when unknown), sell prices the gross `base_amount_in` as the program does, u64 bounds, `applySwap` state-hash guard, zero min-out refused on buy.
- arb_executor: native-lamport allowance guard (PumpSwap's 1,844,400 rent was invisible to the old guard), base mint must be WSOL, PumpSwap buy needs `min_out >= 1`, strict token-account type, reachable aliasing check.
