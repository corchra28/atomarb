# toolchain — Rust / Agave build toolchain for `programs/arb_executor` (installed 2026-09-17)

Owner: agent rust_executor. Installer: `scripts/install_toolchain.sh` (idempotent; prints versions). Build: `scripts/build_executor.sh`.
Everything is user-level; **no shell rc file is modified by the script** (`--no-modify-path` is passed to both installers — see "Incident" below). No keypair was configured, nothing was deployed, `solana-test-validator` was never started.

## What was installed (all VERIFIED by running the binaries on this host, 2026-09-17T13:02–13:17Z UTC)

| Component | Version (exact output) | Location | How | Size on disk |
|-----------|------------------------|----------|-----|--------------|
| rustup | `rustup 1.29.1 (d95a37b6a 2026-08-13)` | `~/.cargo/bin`, `~/.rustup` | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs` → `sh rustup-init.sh -y --profile minimal --default-toolchain stable --no-modify-path` | `~/.cargo` 21 MB (+ registry cache after first build), `~/.rustup` 577 MB |
| rustc / cargo (host, stable) | `rustc 1.98.1 (48a229cea 2026-09-01)`, `cargo 1.98.1 (797e8a9bc 2026-08-05)` | `~/.rustup/toolchains/stable-x86_64-unknown-linux-gnu` | same | (in `~/.rustup`) |
| Agave CLI | `solana-cli 4.2.2 (src:e29e5d91; feat:21b0d33a, client:Agave)`; `version.yml`: `commit: e29e5d910f0c2b7176f58174e592e8488099ef75`, `target: x86_64-unknown-linux-gnu` | `~/.local/share/solana/install/active_release/bin` (agave-install, agave-install-init, agave-ledger-tool, cargo-build-sbf, cargo-test-sbf, solana, solana-keygen, solana-stake-accounts, solana-test-validator, solana-tokens, spl-token) | `curl -sSfL https://release.anza.xyz/stable/install` → `sh install --no-modify-path` (installer script sha256 `8443d7940e9bbb336d9c52082759cb7da58bbe1fffa30cc75d21e7f43d0a1a8a`; resolves `stable` via GitHub releases/latest → v4.2.2) | 250 MB |
| cargo-build-sbf | `cargo-build-sbf 4.1.0` (bundled with Agave 4.2.2), default `platform-tools v1.54`; `--arch` default `v0` (possible: v0,v1,v2,v3) | same bin dir | bundled | — |
| solana-test-validator | `solana-test-validator 4.2.2 (src:e29e5d91; feat:21b0d33a, client:Agave)` | same bin dir | bundled — **never run** | — |
| platform-tools | `v1.54`, `rustc 1.89.0-dev` (bundled rustc/cargo/llvm for the SBF target) | `~/.cache/solana/v1.54/platform-tools` | downloaded by `cargo-build-sbf --install-only` from `https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2` | 1.6 GB |
| solana-program crate | `4.1.0` (crates.io; `rust-version = 1.89.0`, satisfied by platform-tools' rustc 1.89.0-dev). Latest is 5.0.0 (same MSRV); 4.1.0 chosen to match the Agave 4.x line the SVM runs. | `~/.cargo/registry` | resolved by cargo | — |

Timing: rustup + Agave install = **35 s** wall (log `install_toolchain.log`); platform-tools download/extract ≈ 3 min; first host `cargo test` (compiling solana-program 4.1.0 + deps) ≈ 1.5 min; `cargo build-sbf` of the executor = **10.9 s** (incremental) — total toolchain work well under 10 min on this link.
Disk after everything: rustup 577 MB + cargo 21 MB (+ registry) + agave 250 MB + platform-tools 1.6 GB + `programs/arb_executor/target` (host + sbf) ≈ 2.5–3 GB.

## Verification that the toolchain output runs
- `cargo build-sbf` → `programs/arb_executor/target/deploy/arb_executor.so` (41,192 bytes; sha256 in `tests/fixtures/programs/arb_executor.json`), SBPF arch default (`v0`).
- Loaded into **litesvm 1.4.1** (Node bindings; agave program-runtime 4.2.x) via `LiteSVM.addProgram` (upgradeable-loader path) and executed: every rejection path in `tests/integration/executor_guard.test.ts` returns the expected `Custom(code)`; consumed CU per rejection ≈ 2.5–3.1k. So a `v0` ELF from cargo-build-sbf 4.1.0 / platform-tools v1.54 is accepted by this litesvm build (no `--arch v3` needed).
- Host `cargo test` (x86_64, solana-program 4.1.0 with the `curve25519` on-host PDA derivation) passes 22 tests.

## Incident / deviations
- The Agave installer (run once **without** `--no-modify-path` on the first attempt) appended `export PATH="/home/rares/.local/share/solana/install/active_release/bin:$PATH"` to `~/.profile` (line 32). That single line was removed again the same minute (`~/.profile` restored to its previous content: ends with the envman block); the script now passes `--no-modify-path` so re-runs never touch rc files. PATH is exported inside the scripts only.
- `rustup` itself was invoked with `--no-modify-path` from the start.

## Sources
- rustup: https://rustup.rs (script `rustup-init 1.29.1`), stable channel `1.98.1 (48a229cea 2026-09-01)` — see also `docs/sources/libs_toolchain.md` §3 (sizes measured there before installing).
- Agave installer: https://release.anza.xyz/stable/install (fetched 2026-09-17T13:03Z; 4,881 B; sha256 above), `GH_LATEST_RELEASE` → https://api.github.com/repos/anza-xyz/agave/releases/latest → `v4.2.2`; docs https://docs.anza.xyz/cli/install.
- platform-tools: https://github.com/anza-xyz/platform-tools/releases/tag/v1.54 (downloaded by cargo-build-sbf 4.1.0's `DEFAULT_PLATFORM_TOOLS_VERSION`).
- solana-program: https://crates.io/crates/solana-program (`cargo info solana-program@4` → `4.1.0`, `rust-version: 1.89.0`; `@5` → `5.0.0`, `1.89.0`; `@3` → `3.0.0`, `1.81.0`), 2026-09-17T13:05Z.
- litesvm loader path: `docs/sources/libs_toolchain.md` §2.3.
