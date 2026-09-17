#!/usr/bin/env bash
# NOT LAUNCHED BY THE AGENT. Explicit, bounded 24 h or 48 h read-only shadow collection. Nothing is signed or sent.
#
# Usage:  scripts/long_run.sh 24h|48h
#
# Budget (config/config.longrun.example.json): 3 requests/s, <=2 concurrent, hard cap 520,000 HTTP requests, 2 GiB disk, STOP file (npm run stop).
# Estimate from the 60-minute smoke test (50 pools / 22 routes; see reports/runs/<smoke run>/RUN_REPORT.json):
#   requests: ~3 req/s sustained => ~259,000 per 24 h, ~518,000 per 48 h (the cap stops the run earlier if retries push it higher)
#   disk: the journal stores only candidates, simulations, checkpoints and events; the 60-min smoke test used well under 1 MB => < 100 MB expected for 48 h
#   money: $0 on the public endpoint, but https://api.mainnet-beta.solana.com is rate limited (40 req/10 s per method per IP; the smoke test hit HTTP 429)
#          and is not meant for sustained use. With a private provider the cost is (requests x the plan's price per request) — check your plan's
#          credit price for getMultipleAccounts / simulateTransaction / getFeeForMessage / getLatestBlockhash before running; WSS usage may also be billed.
# The script refuses to start if SOLANA_RPC_URL is unset (public endpoint) unless ALLOW_PUBLIC_RPC=1.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in 24h) MIN=1440 ;; 48h) MIN=2880 ;; *) echo "usage: $0 24h|48h"; exit 2 ;; esac
if [ -z "${SOLANA_RPC_URL:-}" ] && [ "${ALLOW_PUBLIC_RPC:-0}" != "1" ]; then echo "SOLANA_RPC_URL not set; refusing to run $1 against the public endpoint (set ALLOW_PUBLIC_RPC=1 to override)"; exit 2; fi
rm -f data/STOP
exec node --no-warnings=ExperimentalWarning --import tsx src/cli/main.ts shadow --duration "${MIN}m" --config config/config.longrun.example.json --max-sims-per-minute 2 --poll-ms 4000
