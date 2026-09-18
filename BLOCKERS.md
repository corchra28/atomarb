# BLOCKERS

Only real blockers. Everything else is implemented, tested and documented.

| # | Blocker | What it blocks | What is needed |
|---|---------|----------------|----------------|
| 1 | `MAINNET_RPC_SIMULATION` of a circuit whose transaction exceeds 1,232 bytes | Any route with a PumpSwap leg and a second swap (observed 1,262–1,684 bytes). A mainnet address lookup table must be created and extended by **transactions**, which this read-only lot does not send. Local probes fabricate a LOCAL-ONLY table instead. | A decision to create an ALT on mainnet (a write), or a provider that accepts oversized simulation payloads (none known). |
| 2 | Mainnet simulation of the *swap path* with a funded identity | With an unfunded identity `simulateTransaction` stops at the first token transfer (`insufficient funds`, custom error 0x1) — the message, accounts, compute budget and fee are verified, the swap arithmetic is not. | `SIM_IDENTITY_PUBKEY` = the **public key** of a wallet that already holds WSOL and the intermediate ATA. No private key is ever needed. |
| 3 | ~~Sustained collection on the public RPC endpoint~~ **RESOLVED** | A private endpoint was supplied and used: a 60-minute run reached 75,542 circuit evaluations at 25 requests/s, and the whole-chain scans since (362,514 pools across three venues) ran on it. The public endpoint's HTTP 429 at 5 requests/s is no longer the binding constraint. | Nothing. Kept here as a record of what changed. |
| 4 | Positive-path CPI through the real DEX programs **on mainnet state that is actually profitable** | `CONFIRMED_EXECUTION` and any claim of realised profit. | Not authorised in this lot: it requires signing and broadcasting. The local executor path is proven on real ELFs with real state (losing routes revert with `ProfitBelowMin`) and on a synthetic positive route. |

Not blockers (status, not obstacles): the Rust executor is built locally and **not deployed**
(`MAINNET_ATOMIC_GUARD_NOT_DEPLOYED`); flash loans are researched but not implemented.

**No longer true:** an earlier version of this line said "Meteora/Jupiter adapters are out of MVP
scope". Three `jupiter-amm-interface` adapters now exist — Raydium CPMM, Orca Whirlpool and
Meteora DLMM — each with its quote proven equal to the on-chain program and a mutation suite in
which every mutation is caught (26 of 26 across the three). They are what the cross-venue scan in
`integrations/gap_scan/` prices circuits with. See `README.md` and `DECISION.md`.

**What is NOT blocked, and did not help:** the coverage gap those adapters closed was real and
measurable, and closing it did not change the verdict. 4,046 circuits with a concentrated-liquidity
leg produced 4 positive gross results and zero positive net. Blocker 4 remains the only thing
between this repository and a realised-profit claim, and `docs/REAL_WORLD_MEV.md` measures why
crossing it would not pay: about $21,000 a day for the whole market, won in an auction, with
capital saturating near $1,538.
