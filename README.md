# atomarb — Solana atomic cross-pool arbitrage research engine (read-only)

Detects, quotes exactly, builds and **simulates** the circuit `WSOL -> TOKEN (pool A) -> WSOL (pool B)` for the same mint, in one transaction, both directions. It never signs or broadcasts: `execution.live` is a schema literal `false`, every submit RPC method is blocked (`LIVE_NOT_AUTHORIZED`), and no private key exists in the project.

**Verdict: `NO_VERIFIED_EDGE`.** Reached three independent ways, then re-measured after the coverage objection was answered. The short version, with everything measured rather than assumed:

| | |
|---|---|
| Venues priced exactly | Raydium CPMM, Orca Whirlpool, Meteora DLMM |
| Pools scanned | 362,514 WSOL pairs across those three |
| Mints with pools on 2+ **different** venues | 10,129 |
| Circuits priced, all with a concentrated-liquidity leg | 4,046 |
| Positive gross / positive net | 4 / **0** |
| Whole atomic-arb market, best census (3,000 blocks) | **~$124,000 a day** |

The reason is no longer coverage. It is the auction: 101 of 104 real winners pay for block position, the **top ten trades take 81–82% of all profit in every sample**, 75% of the operators are the same people thirteen hours apart, and the largest capital deployed in any winning trade observed was $1,538 — so more money buys nothing. The market-size figure carries a 2.5x band even at 3,000 blocks, and the repository's original $21,000 came from a 120-block census whose band spans **thirtyfold**; see `docs/REAL_WORLD_MEV.md` §12.

## The three Rust adapters

Each implements [`jupiter-amm-interface`](https://github.com/jup-ag/jupiter-amm-interface) and has its quote **proven equal to the on-chain program**: snapshot a live pool, run `quote()`, execute the program's native swap in LiteSVM, assert the realized token delta matches exactly.

| crate | parity | mutations caught |
|---|---|---|
| `integrations/raydium_cpmm_amm/` | 3 tests, 12 swaps | 6 of 6 |
| `integrations/whirlpool_amm/` | 5 tests, 17 swaps + 2 unit | 10 of 10 |
| `integrations/meteora_dlmm_amm/` | 4 tests, 13 swaps + 1 unit | 10 of 10 |
| `integrations/gap_scan/` | the cross-venue scan + 2 regression tests | — |

Each carries a `mutation_test.sh` that breaks one piece of the math at a time and requires the suite to notice. All of it runs from a clean clone with **no RPC** — the fixtures are committed.

```
cd integrations/whirlpool_amm && cargo test && ./mutation_test.sh
```

Evidence levels: `QUOTE_ONLY` -> `LOCAL_REAL_PROGRAM_SIMULATION` (real program ELFs + real accounts in LiteSVM, synthetic labelled balances, exact deltas) -> `MAINNET_RPC_SIMULATION` (`simulateTransaction`, `sigVerify=false`) -> `CONFIRMED_EXECUTION` (not authorised in this lot).

## Install (Linux or WSL; Node >= 22.13, npm)

The TypeScript engine runs anywhere Node runs, but `litesvm` ships prebuilt binaries for Linux and macOS only, and `cargo build-sbf` (the Rust executor) is Linux/macOS: on Windows use WSL. `npm run doctor` prints what is present on the current machine.

```
cd ~/trading/sol/atomarb
npm install                      # pinned versions, package-lock.json
cp .env.example .env             # optional: SOLANA_RPC_URL / SOLANA_WSS_URL (read-only endpoints), SIM_IDENTITY_PUBKEY
npm run doctor                   # node, config hash, RPC reachability, node:sqlite, litesvm, send guard
```
Rust executor (optional, local build only): `scripts/install_toolchain.sh` then `scripts/build_executor.sh` (see docs/EXECUTOR_ABI.md). The executor is **not deployed** anywhere.

## Commands
```
npm run typecheck
npm test                                              # unit + fixture + LiteSVM real-program integration tests
npm run discover -- --config config/config.example.json      # population + shortlist (index APIs + local inventory; no RPC)
npm run discover -- --no-network                              # same, from the cached API responses (0 HTTP requests)
#   extra flags: --cap N --page-size N --max-pools N --max-mints N --max-pools-per-mint N --cross-check --reuse-list --inventory <path>
npm run quote    -- --pools pumpswap:<POOL>,raydium_cpmm:<POOL> --amount 10000000 [--sizing]
npm run simulate -- --pools pumpswap:<POOL>,pumpswap:<POOL2> --amount 10000000 [--direction 0|1] [--no-mainnet] [--no-local] [--no-executor] [--identity <pubkey>] [--landing-check]
npm run shadow   -- --duration 60m --config config/config.example.json [--pools-file data/discovery/shortlist.json] [--max-sims-per-minute 2]
#   with a private endpoint (25 req/s, 400 pools, WebSocket-driven):
#   export SOLANA_RPC_URL=... SOLANA_WSS_URL=...   &&  npm run shadow -- --duration 60m --config config/config.fast.example.json
npm run report   -- --run <runId>
npm run stop                                          # writes data/STOP; loops exit at the next checkpoint
scripts/long_run.sh 24h|48h                           # explicit, bounded collection (NOT launched by default; needs SOLANA_RPC_URL)
npx tsx scripts/route_gaps.ts                         # one snapshot per route: pnl in bps by size, fee bps, implied pre-fee gap
npx tsx scripts/fault_injection.ts                    # breaks one invariant at a time and checks the suite catches it
npx tsx scripts/test_report.ts                        # regenerates TEST_REPORT.md
npx tsx scripts/final_summary.ts                      # the terminal summary block, from artefacts only
npx tsx scripts/hash_artifacts.ts                     # sha256 + size of every reported artefact
```
All commands read the config file (`config/config.example.json` by default; copy and edit). Limits (requests/s, concurrency, total requests, duration, pools, disk) are in the config and enforced.

## Layout
See `docs/ARCHITECTURE.md`. Provenance for every external fact: `docs/sources/*.md` and `sources.lock.json`. Security boundaries: `docs/SECURITY_MODEL.md`. PnL definitions: `docs/ACCOUNTING.md`. Test evidence: `TEST_REPORT.md`. Run evidence: `reports/runs/<runId>/RUN_REPORT.{json,md}`. Decision: `DECISION.md`. Real blockers only: `BLOCKERS.md`.

## Where the evidence is

| Question | File |
|---|---|
| Does the quote match the real program? | `TEST_REPORT.md` (local_real_program_integration), `tests/integration/*_local_program.test.ts` |
| Does the two-leg circuit reproduce it, and does the guard hold? | `tests/integration/circuit_local_program.test.ts` |
| Would a broken invariant be noticed? | `reports/fault_injection.json` |
| What does the population look like? | `reports/population_*.md` |
| How far from break-even is each route? | `reports/route_gaps_*.md` |
| What happened in a run? | `reports/runs/<runId>/RUN_REPORT.{json,md}`, `data/atomarb.db` |
| Where does each external fact come from? | `docs/sources/*.md`, `sources.lock.json` |
| Is DEX-versus-centralised-exchange any different? | `docs/DEX_CEX_AUDIT.md`, raw data in `docs/sources/dexcex/` |
| Who is actually winning at this on-chain, and with what? | `docs/REAL_WORLD_MEV.md`, raw data in `docs/sources/realworld/` |
| Does the verdict survive adding concentrated liquidity? | `DECISION.md` (2026-09-19 section), `integrations/gap_scan/` |
| Why the adapters were built in Rust and not ported to TypeScript | `docs/WIRING_DECISION.md` |
| How much capital does this need, and what would it earn? | `docs/CAPITAL_AND_TARGETS.md` |

## What this is not
Not a bot, not a profit claim. A simulated positive candidate does not enable live trading; a negative window does not prove universal impossibility. Landing rate and competition cost are unknown before live and are not estimated here.
