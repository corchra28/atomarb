# RUN_REPORT shadow_2026-09-17T18-09-25-841Z_32a7b818

kind=shadow status=STOPPED started=2026-09-17T18:09:25.865Z ended=2026-09-17T19:04:22.890Z stop=HTTP_BUDGET config_hash=32a7b818d3ae58f8

## Counts (from the full SQLite journal)

candidates_total=0 
simulations: none
mainnet_sim_error_classes: none
local_real_program: ok=0 quote_matched_exactly=0
events: none
candidate_concentration_top_mint_share=0.00

## Latency / RPC / WSS / counters

```
{
 "latencyMs": {
  "snapshot": {
   "n": 4860,
   "p50": 349,
   "p95": 1409,
   "p99": 2140
  },
  "quote": {
   "n": 4860,
   "p50": 17,
   "p95": 87,
   "p99": 354
  },
  "build": {
   "n": 0,
   "p50": null,
   "p95": null,
   "p99": null
  },
  "simulation": {
   "n": 0,
   "p50": null,
   "p95": null,
   "p99": null
  },
  "stateAgeAtDecision": {
   "n": 4860,
   "p50": 3,
   "p95": 8,
   "p99": 12
  }
 },
 "rpc": {
  "total": 10000,
  "errors": 276,
  "retries": 276,
  "byMethod": {
   "getMultipleAccounts": {
    "count": 10000,
    "errors": 276,
    "n": 9994,
    "p50": 113,
    "p95": 350,
    "p99": 717
   }
  }
 },
 "wss": null,
 "counters": {
  "polls": 221,
  "routePolls": 4860,
  "snapshotIncomplete": 0,
  "circuitsEvaluated": 17676,
  "positiveEvaluations": 0,
  "candidates": 0,
  "simsAttempted": 0,
  "simsOk": 0,
  "localAttempted": 0,
  "localOk": 0,
  "localMatch": 0,
  "stale": 0,
  "errors": 0
 }
}
```

## Top candidates (QUOTE_ONLY unless simulated)

ts | mint | direction | amount_in | tx_pnl | single_batch

## Failure-cost scenarios

NOT_TESTED: no candidate reached the minimum net profit in this run, so there is no profit to weigh against the cost of failed attempts.

## Terminal summary

```
SIMULATED_POSITIVE_EPISODES = 0
MAINNET_SIM_ATTEMPTED / SUCCEEDED = 0 / 0
LOCAL_REAL_PROGRAM_OK / QUOTE_MATCH = 0 / 0
REALIZED_NET_PNL = NOT_OBSERVED
TRANSACTIONS_BROADCAST = 0
LIVE_TRADING_ENABLED = NO
ECONOMIC_VERDICT = NO_VERIFIED_EDGE
```

Every probe is an independent hypothetical intervention on real state; probe sums are not a realised portfolio. Landing rate and competition cost are unknown before live and are not estimated here.