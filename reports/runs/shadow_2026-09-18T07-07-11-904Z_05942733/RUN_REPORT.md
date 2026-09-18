# RUN_REPORT shadow_2026-09-18T07-07-11-904Z_05942733

kind=shadow status=COMPLETED started=2026-09-18T07:07:11.905Z ended=2026-09-18T08:07:11.969Z stop=DEADLINE config_hash=059427338b2185a3

## Counts (from the full SQLite journal)

candidates_total=26 BELOW_MIN_NET=26
simulations: none
mainnet_sim_error_classes: none
local_real_program: ok=0 quote_matched_exactly=0
events: route_changed_during_processing=20 wss_account=4560
candidate_concentration_top_mint_share=0.00

## Latency / RPC / WSS / counters

```
{
 "latencyMs": {
  "snapshot": {
   "n": 18670,
   "p50": 160,
   "p95": 288,
   "p99": 365
  },
  "quote": {
   "n": 18670,
   "p50": 17,
   "p95": 95,
   "p99": 122
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
   "n": 26,
   "p50": 21,
   "p95": 28,
   "p99": 48
  },
  "stateAge": {
   "atQuoteDone": {
    "n": 18670,
    "p50": 20,
    "p95": 101,
    "p99": 129
   },
   "atDecision": {
    "n": 26,
    "p50": 21,
    "p95": 28,
    "p99": 48
   },
   "atBuildDone": {
    "n": 0,
    "p50": null,
    "p95": null,
    "p99": null
   },
   "atSimulationIssued": {
    "n": 0,
    "p50": null,
    "p95": null,
    "p99": null
   },
   "maxMs": 1500
  }
 },
 "rpc": {
  "total": 37357,
  "errors": 0,
  "retries": 0,
  "byMethod": {
   "getMultipleAccounts": {
    "count": 37357,
    "errors": 0,
    "n": 37357,
    "p50": 72,
    "p95": 185,
    "p99": 261
   }
  }
 },
 "wss": {
  "notifications": 4560,
  "duplicates": 0,
  "dropped": 0,
  "reconnects": 0,
  "gaps": [],
  "connectFailures": 0
 },
 "counters": {
  "revisionRacesObserved": 20,
  "wssDrivenPolls": 123,
  "capitalRejected": 0,
  "capitalResized": 0,
  "sizingCapExhausted": 0,
  "polls": 124,
  "routePolls": 18670,
  "snapshotIncomplete": 0,
  "circuitsEvaluated": 75542,
  "positiveEvaluations": 26,
  "candidates": 0,
  "simsAttempted": 0,
  "simsOk": 0,
  "localAttempted": 0,
  "localOk": 0,
  "localMatch": 0,
  "stale": 0,
  "staleAtDecision": 0,
  "staleAtSimulation": 0,
  "errors": 0
 }
}
```

## Closest to break-even (QUOTE_ONLY, best pnl in bps over all evaluated sizes)

circuit | bps | amount_in
pumpswap:AEq12Y..>raydium_cpmm:G8kgi7.. | 47.56 | 1000000
pumpswap:BZiqi9..>pumpswap:83QiEe.. | 2.73 | 587792
raydium_cpmm:CeMyZD..>pumpswap:5WguHF.. | -0.28 | 1000000
raydium_cpmm:H5gndJ..>raydium_cpmm:73frby.. | -0.67 | 1000000
raydium_cpmm:9sV7bo..>pumpswap:ArnWdn.. | -1.71 | 1000000
pumpswap:AypFy1..>raydium_cpmm:HMcsLq.. | -1.77 | 1000000
pumpswap:H99xSr..>pumpswap:5bns2j.. | -5.22 | 1000000
raydium_cpmm:BTKGNL..>pumpswap:8jnWKj.. | -14.43 | 1000000
raydium_cpmm:BakaWq..>pumpswap:FDXvtV.. | -18.04 | 1000000
pumpswap:9k62CK..>pumpswap:EswBoy.. | -25.69 | 1000000

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