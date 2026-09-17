# PROGRESS / HANDOVER (living file)

Last updated: see `git log -1 --format=%cI PROGRESS.md`. Everything below is recoverable from the repository alone.

## Done and committed

| Area | State | Evidence |
|---|---|---|
| Primary-source verification | 6 notes, 209 facts with URL@sha, 49 open questions | `docs/sources/*.md`, `sources.lock.json` |
| Core engine | utils, adapter contract, config, RPC client (budgets + submit guard), WSS manager, SQLite journal, run control | `src/`, `tests/unit/` |
| Adapters | Raydium CPMM + PumpSwap: layouts, fee schedules, exact math, validation, instruction builders | `src/adapters/`, `tests/unit/raydium_*`, `tests/unit/pumpswap_*` |
| Real-program proof | mainnet ELFs executed in LiteSVM against real accounts; quote == chain to the lamport | `tests/integration/*_local_program.test.ts` |
| Circuit + guard | two-leg circuit reproduces the quote; leg-B failure reverts everything; executor guard reverts losing routes and passes a synthetic profitable one | `tests/integration/circuit_local_program.test.ts`, `tests/integration/executor_guard.test.ts` |
| Rust executor | built locally (41,192 bytes), 22 host tests, 9 LiteSVM rejection-path tests, ABI documented; NOT deployed | `programs/arb_executor/`, `docs/EXECUTOR_ABI.md`, `tests/fixtures/programs/arb_executor.{so,json}` |
| Discovery | Raydium API v3 + local PumpSwap inventory, population report, deterministic shortlist | `src/discovery/`, `reports/population_*.{json,md}`, `data/discovery/shortlist.json` |
| Accounting | trading / transaction / operating PnL, cost provenance, capital ledger with pending positions and conflicts | `src/accounting/`, `tests/unit/accounting.test.ts`, `tests/unit/capital.test.ts` |
| Test quality | 7 fault injections, all caught; independent re-derivation of both curves | `reports/fault_injection.json`, `tests/unit/independent_math.test.ts` |
| Docs | README, ARCHITECTURE, SECURITY_MODEL, ACCOUNTING, FLASH_LOANS, EXECUTOR_ABI, BLOCKERS, DECISION, CHANGELOG | repository root and `docs/` |
| Agent transcripts | every subagent's structured result and the workflow scripts | `docs/agent_runs/` |

## Review findings applied (adversarial reviewer, target: discovery — verdict ACCEPT_WITH_FIXES)

| Severity | Defect (reproduced by the reviewer) | Fix |
|---|---|---|
| MAJOR | only the pool cap was warned about; every other early stop (empty page, no new items, repeated cursor, max pages) reported a truncated population as complete | `RAYDIUM_LIST_INCOMPLETE` warning on any stop that is not the last page |
| MAJOR | a degraded live run overwrote a good listing cache, poisoning every later offline run | the cache is kept and the degraded run is parked beside it with a warning |
| MAJOR | inventory age silently fell back to the file mtime, so a copied file looked fresh | age comes only from the provenance sidecar; a missing sidecar is `PUMPSWAP_INVENTORY_PROVENANCE_MISSING` and counts as stale |
| MAJOR | the pool-keys fetch was sliced at 100 ids while the attach loop iterated all, emitting a false `POOL_KEYS_MISSING` per pool | all ids are chunked by the client |
| MINOR | source-level duplicates and skipped rows never reached the headline counts | `source_duplicates_dropped` / `source_rows_skipped` in the counts and the markdown |
| MINOR | the request timeout did not cover the response body | the abort signal now covers header and body |
| MINOR | the surviving row for a duplicated address depended on input order | deterministic winner (richest hints, then tvl) plus a regression test |
| MINOR | the 2 req/s limit was per client, so two runs doubled it | a lock file refuses a second concurrent `discover` |

Coverage improved while fixing this: raising the listing cap from 5,000 to 25,000 pools took Raydium CPMM WSOL pools from 822 to **3,107**, cross-adapter mints from 17 to **24**, and Raydium-only pairs from 0 to **5**. The listing is still capped, so these remain lower bounds.

## Review findings applied (target: raydium_cpmm — verdict ACCEPT_WITH_FIXES)

| Severity | Defect (reproduced) | Fix |
|---|---|---|
| MAJOR | the creator-fee branch, the one place the note says the Raydium SDK is wrong, was never executed by the real program (no fixture has it enabled) and the unit tests were self-referential | a real-program test patches `enable_creator_fee` and all three `creator_fee_on` positions into a fixture pool and asserts exact equality in both directions, including which token's fee counter receives it |
| MINOR | a quote for a pool the program would refuse (swap bit disabled, open_time in the future) came back with empty `rejectReasons` | the gate is evaluated inside `quoteExactIn`, mirroring the program's order |
| MINOR | `protocol_fee_rate + fund_fee_rate <= 1e6` was not enforced, producing a negative lp_fee item | added as a reject |
| MINOR | the transfer-fee warning reported the pending tier, not the epoch-active one | the warning uses the active tier and adds `TRANSFER_FEE_PENDING` |
| MINOR | the older transfer-fee tier was an undeclared property stashed on `MintInfo` | both tiers are now part of the declared contract |
| MINOR | `transfer_fee_basis_points > 10000` produced negative amounts instead of the Rust `None` | returns null, and a corrupt TLV is rejected at parse time |
| MINOR | `accountsNeeded` double-counted a shared token program, and a test pinned the wrong length | deduplicated, test asserts distinctness |
| MINOR | `FeeItem.bps` on the LP share and on output-side fees did not match its documented meaning | the rate is omitted where no single rate applies |

## Finished

- **60-minute prospective run** (`shadow_2026-09-17T18-09-25-841Z_32a7b818`): 50 pools validated on-chain, 22 routes, 17,676 circuit evaluations over the sizing grid, **zero positive**; stopped on the 10,000-request budget at 55 min; snapshot latency p50 349 ms; no data gaps.
- **Route diagnostic** (80 circuits, one snapshot each): 1 circuit positive, worth 986 lamports at 0.0001 SOL against a 9,000-lamport network fee; median best −420 bps; 54 of 80 routes have a thinner side below 0.01 SOL.
- **Four adversarial reviews** received and applied (see the tables above and `docs/agent_runs/workflow_results.json`); the executor ABI moved to v2 and its binary was rebuilt.
- Final artefacts: `TERMINAL_SUMMARY.txt`, `DECISION.md`, `TEST_REPORT.md`, `reports/runs/<id>/RUN_REPORT.{json,md}`, `reports/route_gaps_*.{json,md}`, `reports/fault_injection.json`, `ARTIFACT_HASHES.txt`.

## What a next session would do

1. Rebuild the PumpSwap inventory from the chain and lift the Raydium listing cap (coverage is the biggest lever; raising it from 5,000 to 25,000 already took the intersection from 17 to 24 mints and Raydium-only pairs from 0 to 5).
2. Re-run `npm run shadow` with a private endpoint so the run is not cut by the public rate limit, ideally with `SOLANA_WSS_URL` set so decisions follow vault notifications instead of a 4-second poll.
3. Only then revisit the blockers in `BLOCKERS.md` (funded simulation identity, mainnet lookup table).

1. Wait for the shadow run to end (deadline or HTTP budget), then `npm run report -- --run <id>` and copy `reports/runs/<id>/RUN_REPORT.{json,md}`.
2. `npx tsx scripts/route_gaps.ts` (needs ~60 RPC requests) for the per-route distance to break-even and the thin-side liquidity.
3. Apply whatever the reviewers report, re-run `npx tsx scripts/test_report.ts` and `npx tsx scripts/fault_injection.ts`.
4. `npx tsx scripts/final_summary.ts > TERMINAL_SUMMARY.txt`, update `CHANGELOG.md`, then `npx tsx scripts/hash_artifacts.ts > ARTIFACT_HASHES.txt`.

## How to resume from nothing

```
cd ~/trading/sol/atomarb && npm install && npm run doctor && npm test
npm run report                 # last run from the SQLite journal
cat PROGRESS.md DECISION.md BLOCKERS.md TEST_REPORT.md
```
Nothing in this project signs or sends a transaction; `execution.live` is a schema literal `false` and the submit RPC methods are refused.
