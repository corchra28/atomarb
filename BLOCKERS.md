# BLOCKERS

Only real blockers. Everything else is implemented, tested and documented.

| # | Blocker | What it blocks | What is needed |
|---|---------|----------------|----------------|
| 1 | `MAINNET_RPC_SIMULATION` of a circuit whose transaction exceeds 1,232 bytes | Any route with a PumpSwap leg and a second swap (observed 1,262–1,684 bytes). A mainnet address lookup table must be created and extended by **transactions**, which this read-only lot does not send. Local probes fabricate a LOCAL-ONLY table instead. | A decision to create an ALT on mainnet (a write), or a provider that accepts oversized simulation payloads (none known). |
| 2 | Mainnet simulation of the *swap path* with a funded identity | With an unfunded identity `simulateTransaction` stops at the first token transfer (`insufficient funds`, custom error 0x1) — the message, accounts, compute budget and fee are verified, the swap arithmetic is not. | `SIM_IDENTITY_PUBKEY` = the **public key** of a wallet that already holds WSOL and the intermediate ATA. No private key is ever needed. |
| 3 | Sustained collection on the public RPC endpoint | The 24/48 h run (`scripts/long_run.sh`, not launched). `https://api.mainnet-beta.solana.com` returned HTTP 429 during the 60-minute smoke test at 5 requests/s (documented limit: 40 requests per 10 s per method per IP). | `SOLANA_RPC_URL` (and optionally `SOLANA_WSS_URL`) for a private endpoint, plus the plan's price per request. |
| 4 | Positive-path CPI through the real DEX programs **on mainnet state that is actually profitable** | `CONFIRMED_EXECUTION` and any claim of realised profit. | Not authorised in this lot: it requires signing and broadcasting. The local executor path is proven on real ELFs with real state (losing routes revert with `ProfitBelowMin`) and on a synthetic positive route. |

Not blockers (status, not obstacles): the Rust executor is built locally and **not deployed** (`MAINNET_ATOMIC_GUARD_NOT_DEPLOYED`); flash loans are researched but not implemented; Meteora/Jupiter adapters are out of MVP scope.
