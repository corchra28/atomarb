# CHANGELOG

## 0.1.0 (2026-09-17) — MVP, read-only
- Core: adapter contract, integer math utilities, SPL/Token-2022 parsers, rate-limited read-only RPC client with hard budgets and submit guard, WSS manager with dedup/reconnect/gap marking, SQLite journal, run control (STOP file, deadline, budgets).
- Routing: circuit enumeration (cross-adapter + same-adapter, both directions), evaluation with leg B input == leg A output, sizing (grid + bounded refine, zero-trade candidate).
- Accounting: trading / transaction / operating PnL with cost provenance; getFeeForMessage used for the final message (no double counting).
- Simulation: v0 transaction builder + inspection, MAINNET_RPC_SIMULATION, LOCAL_REAL_PROGRAM_SIMULATION (LiteSVM with mainnet-dumped ELFs, synthetic labelled balances, exact deltas).
- CLI: doctor, discover, quote, simulate, shadow, report, stop.
- Primary-source notes (docs/sources) + sources.lock.json.
- Adapters (Raydium CPMM, PumpSwap), discovery module and Rust executor: see TEST_REPORT.md for what was verified.
