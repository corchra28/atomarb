# SECURITY_MODEL

Scope of this lot: read-only research. Nothing is signed or broadcast.

- **No keys.** The project never reads, generates for signing, or stores private keys. Simulation identities are public keys only (`SIM_IDENTITY_PUBKEY` or a fresh random key). LiteSVM runs with signature verification disabled and zero signatures.
- **Submit guard.** `RpcClient.call` refuses `sendTransaction`, `sendRawTransaction`, `sendBundle`, `requestAirdrop` (`LIVE_NOT_AUTHORIZED`). `config.execution.live` must be `false` (schema literal); any other value fails config validation. There is no live worker, no Jito transport enabled, no SDK `execute()`.
- **Endpoints.** RPC/WSS URLs come only from environment variables named in the config (`SOLANA_RPC_URL`, `SOLANA_WSS_URL`); default is the public mainnet endpoint. URLs and API keys are redacted in logs/exports.
- **Budgets.** Requests per second, concurrency, total HTTP requests, run duration, disk bytes and a STOP file bound every loop; `stop` writes the STOP file; SIGINT/SIGTERM terminate at the next checkpoint.
- **Pool validation before quoting.** Owner program, vault addresses vs pool fields and PDAs, vault owner/mint, token program, status flags, open_time, Token-2022 extensions, layout length/discriminator. Unknown layouts are refused.
- **Executor (Rust, local only).** Allow-listed CPI targets (Raydium CPMM, PumpSwap AMM), account-role checks against pool data, user token accounts must belong to the signer, aliasing rejected, leg B amount = measured delta, final guard base_after >= base_before + min_profit, intermediate inventory must return to its initial amount. Never deployed in this lot.
- **Data hygiene.** Fixtures contain only public on-chain account bytes with provenance; no credentials; `data/` is gitignored.
- **Not covered here (future, before any live consideration):** key custody, RPC provider trust, MEV/competition, Jito tip economics, flash-loan provider risk.
