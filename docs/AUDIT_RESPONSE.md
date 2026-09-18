# Response to the independent audit of commit 2c78a61

The audit is accurate. Every one of F1 to F7 reproduces in the code as published, and the auditor's reading of what the numbers do and do not prove matches ours. This file records what was verified, what was changed, and what was deliberately left alone.

## Findings and disposition

| # | Finding | Verified here | Disposition |
|---|---|---|---|
| F1 | `externalCosts()` computes a total, then rent is pushed into the cost list without recomputing it; the same rent is also reported as recoverable capital; the report still says `COMPLETE`. The claim that the PumpSwap `user_volume_accumulator` deposit is unrecoverable is false. | yes, at `probe.ts:194-195` and `pnl.ts:39` | fixed |
| F2 | The staleness gate reuses an age measured before quoting, sizing, capital reservation and a blockhash round trip, so "state age at decision" measures the wrong instant. | yes, `shadow.ts:96` used at `:129` | fixed |
| F3 | If the first WebSocket handshake fails, `start()` never settles and the scanner never reaches its STOP/deadline loop. | yes, `wss.ts:26-44` | fixed |
| F4 | The RPC budget is checked before the concurrency wait and incremented after it, so N concurrent calls all pass a budget of 1. | yes, `rpc.ts:26-45` | fixed |
| F5 | The request timeout is cleared when the headers arrive, so a stalled body is unbounded and the recorded latency excludes it. | yes, `rpc.ts:47-54` | fixed |
| F6 | `scripts/route_gaps.ts` parses `argv[0]` when `--max-requests` is absent, so the budget is `NaN` and the limit silently disappears. | yes, line 17 | fixed |
| F7 | Sizing searches up to the full capital while the ledger caps an episode at 20 % including the fee, and a refused size is never retried smaller; the reservation also ignores the deposits the circuit must pay. | yes, `shadow.ts:101/127` vs `capital.ts` | fixed |

## The auditor's own counter-examples, replayed against the fixed code

| Counter-example | Before (auditor) | After (this repository) |
|---|---|---|
| F4: budget 1, concurrency 1, eight concurrent calls | 8 HTTP requests sent, 8 successes, `usage.total` 8 | **1 HTTP request**, 1 success, 7 rejected with `RPC_BUDGET_EXHAUSTED`, `usage.total` 1 |
| F5: timeout 50 ms, body delayed 300 ms | success after ~310 ms, 0 errors, latency recorded as ~9 ms | **rejects** with `RPC_TIMEOUT: no body within 50ms`, retried as a transient failure, each attempt's latency recorded as ~51 ms |
| F3: first handshake 503, second accepted | `start()` still unresolved after 2 s | **`start()` resolves** on the retry's open (measured 2,321 ms with the default backoff); `stop()` and a start timeout also settle it |
| F6: `--max-requests` absent | budget `NaN`, limit disabled | **120** (the documented default); a present flag must be a positive integer, garbage is refused |

F1, F2 and F7 are covered by regression tests inside the suite rather than by a replay script: `tests/integration/circuit_local_program.test.ts` asserts the reconciliation and the deposit recovery on the real programs, `tests/unit/shadow_policy.test.ts` asserts that an injected delay after the snapshot makes the decision stale, and `tests/unit/capital.test.ts` asserts that a size the ledger refuses is retried smaller with the deposits counted.

## What the fix for F1 actually changes

Four quantities are now separated and reconciled (`src/accounting/types.ts`, `reconcileAttempt` in `src/accounting/pnl.ts`): trading PnL, definitive costs, locked recoverable deposits, and the liquid wallet delta. Two invariants are enforced by tests: the listed costs sum to the total that is deducted, and every native lamport that left the wallet is explained by a cost or by a deposit, otherwise the status is `ACCOUNTING_INCOMPLETE`.

The deposits are measured per account, only for accounts that did not already exist, and the engine can now reclaim them: `buildCloseUserVolumeAccumulatorIx` (discriminator `f945a4da9667548a`, from the pump_amm IDL) plus a plain `CloseAccount`. A test on the real programs closes both and observes exactly the locked amount coming back, minus the 5,000-lamport fee of the closing transaction. The auditor's correction stands: that deposit is capital, not a loss.

## Re-measured on a private endpoint after the fixes

The auditor's coverage objections were answered with data rather than argument. With a paid endpoint (about 150 ms per call instead of 430 ms on the public one) and the WebSocket path working for the first time:

- the scanner now reacts to vault notifications instead of a fixed poll, and records the per-key revision so a notification that lands while a route is being processed re-polls that route instead of being dropped;
- the declared-but-unused `minQuoteReserveLamports` filter is applied, which removes the dust pools that produced every illusory positive in the published sweep;
- a full-population sweep over all 151 eligible mints, one atomic snapshot each, dropped 206 pools below 0.02 SOL and left 96 real circuits: **zero positive at any size, gross or net** (`reports/population_sweep_*.json`).

## What we do not claim, after the fixes

Repairing these defects is not evidence of profit, and none of them would have turned the observed run positive: the run recorded zero positive evaluations out of 17,676, and the population sweep found a largest gross result of 2,663 lamports against a 9,000-lamport fee. The economic verdict is unchanged and remains `NO_VERIFIED_EDGE` for the population and windows observed, with no support for the opposite claim either.

Coverage limits called out by the auditor remain true and are repeated in `DECISION.md`: two pool families, WSOL-based circuits only, no CEX, a PumpSwap address inventory that was 13 days old at the time of the run, 4,501 routes dropped by the per-mint cap, `minQuoteReserveLamports` present in the configuration but not consumed by the filtering, and gap reports that keep rounded basis points rather than every raw account needed for an exact reconstruction.
