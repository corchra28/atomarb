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

## Evidence discipline (why a number in a report can be trusted)

1. **Every external fact is pinned.** `sources.lock.json` holds 209 facts across 6 topics with URL, commit sha / npm version / live-response date and a confidence level (`VERIFIED_IN_SOURCE` > `DOCS_ONLY` > `INFERRED` > `UNKNOWN`), plus 49 open questions that the code must not silently assume away. Adapters cite the note section next to the offsets and discriminators they use.
2. **Layouts are checked, not guessed.** Discriminator plus length; only lengths documented as historical are accepted with defaulted trailing fields; anything else is `UNSUPPORTED: UNKNOWN_LAYOUT`.
3. **Quotes are proven against the real programs.** The mainnet ELF is dumped through RPC (45-byte programdata header), loaded into LiteSVM with the real accounts, and executed; the assertion is exact equality of token deltas, not an approximation.
4. **The circuit is proven end to end.** Leg B consumes exactly leg A's output; the realised WSOL delta equals the quoted PnL; the intermediate balance returns to zero.
5. **The guard is proven both ways.** It reverts real losing routes (`ProfitBelowMin`) and passes a synthetic profitable one at exactly the quoted profit, failing one lamport above.
6. **The tests are proven to bite.** `scripts/fault_injection.ts` breaks one invariant at a time in a tracked file and records which test caught it; a mutation nobody catches is reported as a hole and the run restores every file.
7. **Nothing is reported that was not measured.** Missing data is `NOT_RUN` / `INCOMPLETE` / `UNKNOWN`, never zero; probe sums are never presented as a portfolio.
