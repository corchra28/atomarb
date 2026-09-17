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

## Running when this was written

- **60-minute shadow smoke test** on 50 shortlist pools / 22 routes. Journal: `data/atomarb.db` (table `runs`, `candidates`, `simulations`, `checkpoints`, `events`); progress readable at any time with `npm run report`. Result so far: thousands of circuit evaluations, **zero positive**.
- **Four adversarial reviewers** (PumpSwap, Raydium, discovery, executor). Their findings land in `docs/agent_runs/workflow_results.json` once complete.

## Remaining steps (in order)

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
