# ARCHITECTURE

Read-only Solana atomic cross-pool arbitrage research engine. Circuit: WSOL -> TOKEN (pool A) -> WSOL (pool B), same mint, A != B, one transaction, both directions.

```
src/adapters/      PoolAdapter contract (types.ts) + implementations: raydium_cpmm/, pumpswap/. Unimplemented paths return UNSUPPORTED, never a fake success.
src/state/         rpc.ts (rate-limited, budgeted, read-only JSON-RPC; send* forbidden), wss.ts (accountSubscribe, dedup, reconnect + GAP marking), snapshot.ts (one getMultipleAccounts per route; SNAPSHOT_INCOMPLETE when >100 keys), token.ts (SPL / Token-2022 parsers), db.ts (SQLite journal, transactions, checkpoints)
src/discovery/     index APIs (Raydium API v3) + local PumpSwap inventory -> unverified PoolRefs; population report. Never used for pricing.
src/routing/       circuit.ts: enumeration (cross-adapter and same-adapter), evaluation (leg B input == leg A output), sizing (grid + bounded refine, zero-trade always a candidate)
src/accounting/    trading / transaction / operating PnL with cost provenance (INCLUDED_IN_QUOTE / ESTIMATED / OBSERVED)
src/simulation/    tx_build.ts (v0 message + inspection), probe.ts (direct two-swap tx, MAINNET_RPC_SIMULATION, LOCAL_REAL_PROGRAM_SIMULATION with real ELFs and exact deltas), local_svm.ts (LiteSVM bridge), executor_ix.ts (Rust executor instruction)
src/telemetry/     JSONL logger with redaction, RunControl (STOP file, deadline, HTTP/disk budgets, signals)
src/cli/           doctor | discover | quote | simulate | shadow | report | stop
programs/arb_executor  Rust program: measures the intermediate delta after leg A, uses it for leg B, verifies base delta >= min_profit. Built locally; NOT deployed (MAINNET_ATOMIC_GUARD_NOT_DEPLOYED).
tests/             unit (mock + fixtures), integration (LiteSVM with real program ELFs), fixtures (on-chain accounts with provenance)
docs/sources/      primary-source notes; sources.lock.json pins URL@sha/version/date per fact
```

Data flow (shadow): discovery shortlist -> per-token route -> ONE getMultipleAccounts (context slot recorded) -> decode + validate -> quotes both directions -> sizing -> candidate journal -> bounded simulations (mainnet RPC; local real-program) -> episodes -> RUN_REPORT.

Time: wall-clock UTC at receive, monotonic durations, RPC context slot; slot x 0.4 s is never used as a timestamp; transactionIndex is never fabricated.
Evidence levels: QUOTE_ONLY < LOCAL_REAL_PROGRAM_SIMULATION < MAINNET_RPC_SIMULATION < CONFIRMED_EXECUTION (not authorised).
