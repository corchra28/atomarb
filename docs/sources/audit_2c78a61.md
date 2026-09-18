# Independent audit of commit 2c78a61 — what it established

Received 2026-09-18. The auditor worked from a separate clone at the exact commit, with the remote ref checked against the same hash, and reproduced every finding with loopback servers and the archived fixtures. No Solana RPC calls and no broadcast transactions were made by the audit.

## Reproduced by the auditor, confirmed here

| Claim | Evidence quoted by the auditor |
|---|---|
| `npm ci --ignore-scripts` and `npm run typecheck` succeed; `ATOMARB_NETWORK_TESTS=0 npm test` gives 263 tests, 261 passed, 2 skipped | matches the numbers in `TEST_REPORT.md` at that commit |
| All 68 entries of `ARTIFACT_HASHES.txt` match by SHA-256 and by size | the manifest is what it claims to be; it does not claim to list every file in the repository |
| RPC budget race: budget 1, concurrency 1, eight concurrent calls → eight HTTP requests received, eight successes, `usage.total` 8 | `rpcBudgetRace` in the audit output |
| RPC body timeout: timeout 50 ms, body delayed 300 ms → success after ~310 ms, zero errors, recorded latency ~9 ms | `rpcBodyTimeout` |
| WebSocket first-connect failure: two connections, one open, `start()` unresolved after 2 s | `wssFirstConnectFailure` |
| `route_gaps.ts` default budget is `NaN` when `--max-requests` is absent | `defaultRouteGapsBudget` |
| Accounting contradiction: trading PnL −95,553,322, reported net −95,562,322 (only 9,000 deducted) while the listed cost items sum to 3,892,680, and the same rent appears as recoverable capital, status still `COMPLETE` | `accounting` |
| The PumpSwap `user_volume_accumulator` deposit IS recoverable: closing it with the pinned vendor SDK plus closing the empty ATA returned 1,844,400 + 2,039,280 lamports for a 5,000-lamport transaction fee | `depositRecovery` |
| Sizing versus capital: capital 0.1 SOL, selected size 0.1 SOL → `EPISODE_CAP`, while 0.01 SOL is positive in the same (synthetic) quote and reserves fine | `sizingVsCapital`, explicitly marked `SYNTHETIC_RESERVES_QUOTE_ONLY_NOT_PROFIT` |

## What the auditor explicitly did not claim

The Rust program was not recompiled (no toolchain in that environment); the archived binary was executed and the manifest checked, without asserting that a fresh build is byte-identical. The 55-minute historical run was not reconstructed, because the repository publishes aggregated reports rather than every snapshot. None of the defects is claimed to imply that the observed run would have found opportunities if they had been fixed.

## Our verification and changes

See `docs/AUDIT_RESPONSE.md`. The auditor's probe script (SHA-256 `152dc8dafa284a95f61460a33141ff628fde8adc233be4ed38ed3de0c1e22399`) is not vendored here; its findings are reproduced by regression tests inside the suite instead, so a future regression fails the build rather than waiting for the next audit.
