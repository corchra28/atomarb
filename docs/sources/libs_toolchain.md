# libs_toolchain — library family + toolchain for the atomarb TS engine (read-only / paper-only)

Consulted: 2026-09-17 (UTC, ~11:47–12:02). Host: Linux x86_64 (kernel 7.0.0-30), Node v24.14.0, npm 11.9.0.
`which rustup cargo solana rustc solana-test-validator cargo-build-sbf` → **nothing installed** (no `~/.cargo`, no `~/.local/share/solana`). Disk: 305 GB free on `/`.

Confidence legend: **VERIFIED_IN_SOURCE** = read code/IDL/package metadata or executed it locally; **DOCS_ONLY** = prose docs; **INFERRED** = derived; **UNKNOWN** = could not establish.

Scratch (gitignore later): `/home/rares/trading/sol/atomarb/.scratch/` — unpacked tarballs in `tarballs/`, shallow clones `raydium-sdk-V2/`, `litesvm/`, `surfpool/`, runnable interop project `interop/` (`interop_test.cjs`, `dump_test.cjs`, `t/smoke.test.ts`), raw sources in `src/`, Agave release in `agave-rel/`.

---

## 0. Recommendation (one family, exact pins)

**Family: `@solana/web3.js` 1.x** (NOT `@solana/kit`). Pin exactly:

| package | pin | why this version |
|---|---|---|
| `@solana/web3.js` | **1.99.0** | npm `latest` (published 2026-09-08T16:22:13Z); only 1.x change since 1.98.4 is "Add v1 Transaction read support #3866" |
| `@raydium-io/raydium-sdk-v2` | **0.2.70-alpha** | npm `latest` (2026-09-15); requires `@solana/web3.js ^1.95.3` |
| `@pump-fun/pump-swap-sdk` | **1.20.0** | npm `latest` (2026-09-10); requires `@solana/web3.js ^1.98.2`, `@coral-xyz/anchor ^0.31.1` |
| `@coral-xyz/anchor` | 0.31.1 (transitive) | pulled by pump-swap-sdk; deps `@solana/web3.js ^1.69.0`, `bn.js ^5.1.2` |
| `@solana/spl-token` | 0.4.15 (transitive) | peer `@solana/web3.js ^1.95.5` |
| `bn.js` | 5.2.5 | single copy resolves for web3.js/anchor/raydium/pump |
| `decimal.js` | 10.6.0 | raydium `^10.4.2` (used in 17 require sites in raydium lib) |
| `litesvm` | **1.4.1** | Node bindings; prebuilt `litesvm-linux-x64-gnu@1.4.1`; brings `@solana/kit@8.3.0` **only as litesvm's own dependency** (see §2 boundary) |
| `ws` | **8.21.3** | latest (2026-08-07), engines `>=10` |
| `vitest` | **5.0.1** | engines `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` — verified on Node 24.14 |
| `tsx` | **4.23.13** | engines `>=18` — verified |
| `typescript` | **5.9.3** | last 5.x (2025-09-30); `latest` tag is 7.0.2 (Go-native, platform binaries) — see §4 |
| `@types/node` | 24.x | |

**Verified resolution (npm 11.9, `npm ls`)**: installing all of the above yields exactly **one** `@solana/web3.js@1.99.0` (every consumer "deduped"), one `bn.js@5.2.5`, one `@coral-xyz/anchor@0.31.1`, one `@solana/spl-token@0.4.15`, one `@solana/kit@8.3.0` (under litesvm only). `bs58` is split 4.0.1 (web3.js/anchor) vs 6.0.0 (raydium/pump) — harmless nesting. — VERIFIED_IN_SOURCE (`.scratch/interop/`).

**Rationale for web3.js 1.x, not kit**
1. Both DEX SDKs are 1.x-typed end-to-end (`PublicKey`, `Connection`, `TransactionInstruction`, `AccountInfo<Buffer>`); neither has a kit build. Raydium: `dependencies["@solana/web3.js"]="^1.95.3"`, no peerDependencies, no anchor. Pump: `"@solana/web3.js":"^1.98.2"`, anchor 0.31.1 (`getPumpAmmProgram(connection): Program<PumpAmm>`). — VERIFIED_IN_SOURCE.
2. `@solana/web3.js@3.0.0-rc.3` (2026-09-02) exists but is a **kit-backed compat layer** (`dependencies: @solana/kit ^8.2.0, @solana/signers, @solana-program/*`), engines `node >=20.18.0`, still RC. Not GA → don't pin. — VERIFIED_IN_SOURCE (npm metadata).
3. 1.x is still maintained (1.99.0 shipped 9 days ago). No `engines` field in 1.99.0 package.json; Node 24 compatibility established empirically (ran it).
4. kit 8.3.0 (tag `v8.3.0` = `7dfaf8827c217105d47aa1940893d301ad9f63c0`, engines `>=20.18.0`) only enters via litesvm; the boundary is bytes, so no dual-family code.

Stale-version trap: Raydium npm has `2.0.0-rc.0..rc.20` and `2.0.1-rc.0` (2024-03/05, deps `@solana/web3.js ^1.75.3`, `@project-serum/serum`) that sort **above** `0.2.70-alpha` by semver. `dist-tags.latest = 0.2.70-alpha`. Never use `^2` or `*`. — VERIFIED_IN_SOURCE.

---

## 1. `@solana/web3.js` 1.99.0 — simulate without keys (item 7)

Source: `tarballs/solana-web3.js-1.99.0/package/lib/index.cjs.js` (npm tarball; GitHub tag `v1.99.0` = `0b600488afc85bb1f4d41827c7b800fb31c034f5` in `solana-foundation/solana-web3.js`). `package.json`: `main lib/index.cjs.js`, `module lib/index.esm.js`, `types lib/index.d.ts`, **no `engines`, no `gitHead`**.

**`VersionedTransaction` needs no signatures to serialize** — constructor fills `numRequiredSignatures` × 64 zero bytes; `serialize()` has no `requireAllSignatures`/`verifySignatures` options (those exist only on legacy `Transaction.serialize({requireAllSignatures, verifySignatures})`, lines 1954–2000). VERIFIED_IN_SOURCE, `lib/index.cjs.js` line 2219ff:

```js
class VersionedTransaction {
  constructor(message, signatures) {
    if (signatures !== undefined) {
      assert(signatures.length === message.header.numRequiredSignatures, ...);
      this.signatures = signatures;
    } else {
      const defaultSignatures = [];
      for (let i = 0; i < message.header.numRequiredSignatures; i++) {
        defaultSignatures.push(new Uint8Array(SIGNATURE_LENGTH_IN_BYTES));
      }
      this.signatures = defaultSignatures;
    }
```

**`Connection.simulateTransaction(VersionedTransaction, config)`** just base64-encodes `versionedTx.serialize()` and forwards `config` (`sigVerify?`, `replaceRecentBlockhash?`, `accounts?`, `innerInstructions?`, `minContextSlot?`, `commitment`) — `sigVerify` is NOT forced (RPC default = false), so a fee payer **public key only** works. Line 8192ff:

```js
async simulateTransaction(transactionOrMessage, configOrSigners, includeAccounts) {
  if ('message' in transactionOrMessage) {
    const versionedTx = transactionOrMessage;
    const wireTransaction = versionedTx.serialize();
    const encodedTransaction = buffer.Buffer.from(wireTransaction).toString('base64');
    ...
    const config = configOrSigners || {};
    config.encoding = 'base64';
    if (!('commitment' in config)) { config.commitment = this.commitment; }
```
(The legacy-`Transaction` branch at line ~8277 sets `config.sigVerify = true` **only** when signers are passed.) `SimulateTransactionConfig` type: `lib/index.d.ts` line 2284 (`sigVerify?`, `replaceRecentBlockhash?`, `minContextSlot?`, `innerInstructions?`).

1.99.0 adds `MessageV1` (line 1186), `VERSION_1_MESSAGE_PREFIX = 0x81` (line 401), `VersionedTransaction.deserializeV1` — read support only.

Empirical: unsigned v0 tx with CB-limit + system transfer serializes to 257 bytes, byte[0]=1 (sig count), signature all-zero — VERIFIED (`interop_test.cjs`).

---

## 2. `litesvm` 1.4.1 (Node bindings) — item 2

npm: version 1.4.1, published 2026-08-24T18:42:04Z, `gitHead bee0fd29642ee1b6a2f16792d1827fcf91471287` = git tag `node-v1.4.1` in `LiteSVM/litesvm` (verified via `git ls-remote --tags`). engines `node >= 20`. deps: `@solana/kit ^8.0.0`, `@solana-program/system ^0.14.0`, `@solana-program/token ^0.16.0`. Package has **no `exports` map** → deep `require('litesvm/dist/internal')` works. — VERIFIED_IN_SOURCE.

**Prebuilt binaries** (`optionalDependencies`): `litesvm-linux-x64-gnu`, `-linux-x64-musl`, `-linux-arm64-gnu`, `-linux-arm64-musl`, `-darwin-x64`, `-darwin-arm64` (all `1.4.1`). No win32 package published (loader code references it). `litesvm-linux-x64-gnu@1.4.1`: `os:[linux] cpu:[x64] libc:[glibc] engines node>=20`, ships `litesvm.linux-x64-gnu.node` = 12,609,840 B, `ELF 64-bit LSB shared object, x86-64, dynamically linked, stripped`. Loader (`dist/internal.js`) picks by `process.platform/arch`, detects musl via `ldd --version`, honours `NAPI_RS_NATIVE_LIBRARY_PATH`. **Installed and loaded fine on this host** (Node 24.14, no build step). — VERIFIED_IN_SOURCE.

Rust side (repo HEAD `d49db92a3d084a015fffc29609d57888c22b949b`, 2026-09-15 "feat: update mainnet active features (#423)"): workspace `litesvm` crate 0.16.0, `rust-version 1.89.0`, agave crates `4.2.1` (`agave-feature-set`, `solana-program-runtime`, `solana-compute-budget`…), `solana-account 4.3.0`. Node crate `crates/node-litesvm` (`litesvm-node 1.4.1`, napi, features `nodejs-internal`,`precompiles`).

### 2.1 API surface (`dist/index.d.ts`, kit-typed wrapper) — VERIFIED_IN_SOURCE
- `new LiteSVM()` / `LiteSVM.default()`; builders: `withComputeBudget(ComputeBudget)`, **`withSigverify(bool)`**, **`withBlockhashCheck(bool)`**, `withSysvars()`, `withFeatureSet(FeatureSet)`, `withBuiltins()`, `withLamports(bigint)`, `withDefaultPrograms()`, `withNativeMints()`, `withTransactionHistory(bigint)` (0 = allow duplicates), `withLogBytesLimit(bigint?)`, `withPrecompiles()`.
- Accounts: `getAccount(address: Address): MaybeEncodedAccount`, `getProgramAccounts(programAddress)`, **`setAccount(account: EncodedAccount)`** — `EncodedAccount = {address, lamports, data: Uint8Array, executable, programAddress, space}`; wrapper does `new internal.Account(BigInt(lamports), data, addressCodec.encode(programAddress), executable, 0n)` (rentEpoch fixed 0). `getBalance`, `airdrop(address, lamports)`, `minimumBalanceForRentExemption`.
- Programs: **`addProgramFromFile(programId: Address, path: string)`**, **`addProgram(programId, programBytes: Uint8Array)`**, `addProgramWithLoader(programId, bytes, loaderId)`.
- Tx: **`sendTransaction(tx: kit Transaction)`**, **`simulateTransaction(tx)`** → `SimulatedTransactionInfo | FailedTransactionMetadata`; `SimulatedTransactionInfo.meta(): TransactionMetadata`, `.postAccounts(): EncodedAccount[]`.
- `TransactionMetadata`: `signature()`, **`logs(): string[]`**, `innerInstructions()`, **`computeUnitsConsumed(): bigint`**, `returnData()`, `prettyLogs()`. `FailedTransactionMetadata`: `err()`, `meta()`.
- Sysvars: `latestBlockhash()`, `expireBlockhash()`, `warpToSlot`, get/set `Clock`, `Rent`, `EpochSchedule`, `EpochRewards`, `SlotHashes`, `SlotHistory`, `StakeHistory`, `LastRestartSlot`.

Wrapper → napi (`dist/index.js` line 292ff): if `getSigverify()` it calls `assertIsFullySignedTransaction(tx)`; then `getTransactionVersionDecoder().decode(tx.messageBytes)`, `getTransactionEncoder().encode(tx)` and dispatches to `internal.sendLegacyTransaction(bytes)` / `internal.sendVersionedTransaction(bytes)` (version 0 **and 1**).

### 2.2 The web3.js-1.x ↔ litesvm boundary (bytes) — VERIFIED by execution
`dist/internal.d.ts` (napi class `LiteSvm`, lines 276–350) takes **raw bytes**: `sendVersionedTransaction(txBytes: Uint8Array)`, `simulateVersionedTransaction(txBytes)`, `sendLegacyTransaction`, `simulateLegacyTransaction`, `setAccount(pubkey: Uint8Array, data: Account)`, `getAccount(pubkey: Uint8Array): Account|null`, `addProgram(programId: Uint8Array, bytes)`, `addProgramFromFile(programId: Uint8Array, path)`, `getSigverify()`, `getComputeBudget()`. The wrapper's `inner` field is TS-private but a plain JS property.

Two working paths (both executed in `.scratch/interop/interop_test.cjs`):
- **A (no kit code at all):** `svm.inner.simulateVersionedTransaction(new VersionedTransaction(msgV0).serialize())` → OK, `computeUnitsConsumed()=300n`, logs `["Program ComputeBudget111… invoke [1]", …, "Program 1111… success"]`, `postAccounts().length=2`.
- **B (wrapper API):** `svm.simulateTransaction(getTransactionDecoder().decode(bytes))` → OK (300n); `sendTransaction` → dest balance 1_000_000_000n.
- `setAccount({address: pk.toBase58(), lamports: 12345n, data, executable:false, programAddress: SystemProgram.programId.toBase58(), space:3n})` round-trips; `svm.inner.setAccount(pk.toBytes(), new internal.Account(777n, data, ownerBytes, false, 0n))` also works. A web3.js `PublicKey.toBase58()` string is a valid kit `Address` at runtime.
- Preconditions: `withSigverify(false)` and (for arbitrary blockhash) `withBlockhashCheck(false)`; fee payer must have lamports (`airdrop`). Rent is enforced: a 1-lamport transfer to a fresh account fails with `InsufficientFundsForRent { account_index: 1 }` (seen in the first vitest run — test bug, not toolchain).

### 2.3 Loading a program dumped from mainnet — 45-byte header — VERIFIED_IN_SOURCE + executed
`anza-xyz/solana-sdk` master `8e8e679ad3072748887d23a678ce2e6a6fb5e41b`, `loader-v3-interface/src/state.rs`:
```rust
    // A ProgramData account.
    ProgramData {
        /// Slot that the program was last modified or deployed in
        slot: u64,
        /// Address of the Program's upgrade authority.
        upgrade_authority_address: Option<Pubkey>,
    },
...
    pub const fn size_of_buffer_metadata() -> usize {
        37 // see test_state_size_of_buffer_metadata
    }
    pub const fn size_of_programdata_metadata() -> usize {
        45 // see test_state_size_of_programdata_metadata
    }
```
Bincode layout: `u32 LE enum tag` (0 Uninitialized, 1 Buffer, 2 Program, 3 ProgramData) @0..4; ProgramData: `slot u64 LE` @4..12; `Option<Pubkey>` tag byte @12 (0=None,1=Some); pubkey @13..45; **ELF starts at 45**. Program account (36 bytes): tag=2 @0..4, `programdata_address` @4..36.

`anza-xyz/agave` master `22f1fca4bcfee3cf7217b8e6f345de568c59e250`, `cli/src/program.rs` `process_dump` (line 2161ff) — `solana program dump` writes exactly `data[45..]`:
```rust
                        if let Ok(UpgradeableLoaderState::ProgramData { .. }) =
                            bincode::deserialize(&programdata_account.data)
                        {
                            let offset = UpgradeableLoaderState::size_of_programdata_metadata();
                            let program_data = &programdata_account.data[offset..];
                            let mut f = File::create(output_location)?;
                            f.write_all(program_data)?;
```
litesvm `crates/litesvm/src/lib.rs` @ `d49db92a` `add_program_internal` (line 1055ff) rebuilds the pair (programdata = 45-byte header {slot: current clock slot, authority: None} + bytes; program account = `Program{programdata_address}` at PDA `[program_id]` under the loader, `executable=true`):
```rust
            let programdata_metadata_len = UpgradeableLoaderState::size_of_programdata_metadata();
            let programdata_len = programdata_metadata_len + program_bytes.len();
            let mut programdata_data = vec![0u8; programdata_len];
            UpgradeableLoaderState::serialize_into(
                &mut programdata_data[..programdata_metadata_len],
                &UpgradeableLoaderState::ProgramData { slot: current_slot, upgrade_authority_address: None },
            ) ...
            programdata_data[programdata_metadata_len..].copy_from_slice(program_bytes);
```
`add_program_from_file` = `std::fs::read(path)` → `add_program`. Loader-v4 is not handled (`InvalidLoader` for anything but bpf_loader_upgradeable / bpf_loader / bpf_loader_deprecated).

**Executed** (`dump_test.cjs`, public RPC `api.mainnet-beta.solana.com`, read-only `getAccountInfo`): PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` → owner `BPFLoaderUpgradeab1e11111111111111111111111`, len 36, tag 2, programdata `6naEzKeUuFh1Jeeu51NXQgr5qkXgXtc9WKNct4xynVJc` (== `findProgramAddressSync([programId], loader)`); programdata len 10,485,760, tag 3, slot 446462733, Option tag 1, authority `7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8`, bytes[45..49] = `7f454c46` (ELF magic). `svm.addProgram(programId, data.subarray(45))` (10,485,715 B) → `getAccount(programId).executable === true`, programdata account created (header `03000000 800a3d1a00000000 00`). `addProgramFromFile` on the written `.so` also OK. Alternative that preserves the real header: `setAccount` both mainnet accounts verbatim (litesvm test `addProgramViaSetAccount.test.ts` shows setAccount-based loading via `setHelloWorldProgram`).

### 2.4 Alternatives
- **surfpool** (txtx/surfpool, HEAD `42e7d7b8a2564d7fbcb3ead0e061cc125a5dff26` 2026-09-16; latest release v1.5.0 2026-07-13, `surfpool-linux-x64.tar.gz` 34,170,467 B; **not on npm**). Built on `litesvm = "0.16.0"` (Cargo.toml:88). `surfpool start [--rpc-url URL] [--network devnet] [--offline] [--no-tui] [--airdrop PK] [--snapshot f.json]` (crates/cli/src/cli/mod.rs:139–158). `DEFAULT_RPC_PORT 8899`, `DEFAULT_WS_PORT 8900`, `DEFAULT_SLOT_TIME_MS 400` (crates/types/src/types.rs:33–38). Fetches missing accounts from the remote datasource on demand (`get_multiple_accounts(&remote_ctx, …)` crates/core/src/rpc/accounts_data.rs:443). 31 `surfnet_*` cheatcodes in source incl. `surfnet_setAccount`, `surfnet_setTokenAccount`, `surfnet_cloneProgramAccount`, `surfnet_writeProgram`, `surfnet_profileTransaction`, `surfnet_getTransactionProfile`, `surfnet_timeTravel`, `surfnet_pauseClock`, `surfnet_exportSnapshot`, `surfnet_resetNetwork`. Install (docs): `curl -sL https://run.surfpool.run/ | bash` or `cargo surfpool-install`. — VERIFIED_IN_SOURCE (methods/ports), DOCS_ONLY (install).
- **solana-test-validator**: bundled in the Agave release (see §3); docs: full single-node cluster, RPC `http://127.0.0.1:8899`, ledger `test-ledger`, `--clone` from a cluster, `--bpf-program`, `--limit-ledger-size`. Slower/heavier than litesvm (litesvm README: "solana-test-validator (slow, unwieldy)"). — DOCS_ONLY.
- Verdict for this engine: litesvm in-process (µs-level, no daemon); surfpool only if an RPC-shaped fork with lazy mainnet cloning is wanted.

---

## 3. Rust / Agave toolchain feasibility (item 3) — nothing installed; sizes are download sizes

**rustup** (https://rustup.rs, verbatim): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` — script is `rustup-init 1.29.1 (3f5811cec 2026-08-12)`, 29,915 B; `rustup-init` binary for x86_64-unknown-linux-gnu 21,113,232 B. Stable channel (`channel-rust-stable.toml`): **rust 1.98.1 (48a229cea 2026-09-01)**. Component `.tar.xz` sizes (x86_64-unknown-linux-gnu, HTTP Content-Length): rustc 79,727,616; rust-std 30,715,684; cargo 11,662,108; rust-docs 24,072,528; clippy 5,400,924; rustfmt 2,486,356. `--profile minimal` = rustc+rust-std+cargo (~122 MB compressed); default adds rust-docs/rustfmt/clippy (~154 MB). Installed footprint: **INFERRED ~0.6–1.5 GB** (not measured). — VERIFIED_IN_SOURCE (sizes/version), DOCS_ONLY (profiles).

**Agave CLI**: docs (https://docs.anza.xyz/cli/install) command `sh -c "$(curl -sSfL https://release.anza.xyz/v4.3.0-rc.1/install)"` (page currently shows an RC tag; `stable`/`beta`/`edge` symbolic channels accepted). The `stable` script (`https://release.anza.xyz/stable/install`, 4,881 B) resolves the tag from `GH_LATEST_RELEASE="https://api.github.com/repos/anza-xyz/agave/releases/latest"` → **v4.2.2** (2026-08-28), downloads `agave-install-init-x86_64-unknown-linux-gnu` (10,372,552 B), which installs `solana-release-x86_64-unknown-linux-gnu.tar.bz2` (**86,382,236 B**). Downloaded & extracted here: **250 MB**, `version.yml`: `channel: v4.2.2, commit: c9c6f3287e26f24e3476e13e751aebe710191e89`. **`bin/` = agave-install, agave-install-init, agave-ledger-tool, cargo-build-sbf, cargo-test-sbf, deps/, solana, solana-keygen, solana-stake-accounts, solana-test-validator, solana-tokens, spl-token** → `solana-test-validator` and `cargo-build-sbf` ARE included. Linux build deps listed in docs (only for building from source): `apt-get install build-essential pkg-config libudev-dev llvm libclang-dev protobuf-compiler`. — VERIFIED_IN_SOURCE (script, tarball), DOCS_ONLY (command text).

**cargo-build-sbf** is now its own repo/crate: `anza-xyz/cargo-build-sbf` (master `3cdec0e0092c3708ef40744ac30b212df46b788e`), crates.io max 4.3.0 (2026-09-03); `cargo install cargo-build-sbf` gives both `cargo-build-sbf` and `cargo-test-sbf`. `cargo-build-sbf/src/toolchain.rs`:
```rust
pub const DEFAULT_PLATFORM_TOOLS_VERSION: &str = "v1.57";
pub(crate) const DEFAULT_RUST_VERSION: &str = "1.95.0";
...
fn find_installed_platform_tools() -> Vec<String> {
    let solana = home_dir().join(".cache").join("solana");
    let package = "platform-tools";
...
    let url = format!("https://github.com/anza-xyz/platform-tools/releases/download/{platform_tools_version}/{download_file_name}");
...
            format!("platform-tools-linux-{arch}.tar.bz2")
```
It shells out to **`rustup toolchain list -v` / `toolchain link`** (lines 368–407) and registers a toolchain named `{DEFAULT_RUST_VERSION}-sbpf-solana-{ver}` (line 346) → **rustup is required** even though platform-tools bundles its own rustc. Cache dir `~/.cache/solana/<ver>/platform-tools`. **platform-tools v1.57** (2026-08-21) `platform-tools-linux-x86_64.tar.bz2` = **531,380,716 B** (downloaded on first `cargo build-sbf`). README: SBPFv3 migration — SIMD-500 (blocks SBPF v0–v2 deploys) "scheduled for activation in Agave v4.3"; minimums: platform-tools v1.53 (v1.56 recommended), cargo-build-sbf v4.2.0, Solana CLI v4.0.0; override with `cargo build-sbf --tools-version v1.53` or `[package.metadata.solana] tools-version`. — VERIFIED_IN_SOURCE.

**Estimates (INFERRED, not measured)**: downloads ≈ 21 MB rustup-init + ~122–154 MB rust + 86 MB agave + 531 MB platform-tools ≈ **0.8 GB**; disk after extraction ≈ rust 0.6–1.5 GB + agave 250 MB (measured) + platform-tools ~1.5–2 GB + `target/` for a small SBF program 0.5–1 GB ⇒ **~3–5 GB**; wall time ~10–25 min on a normal broadband link, first `cargo build-sbf` dominated by the 531 MB download. Deployment is not needed: `cargo build-sbf` emits `target/deploy/<name>.so` which litesvm `addProgramFromFile` loads directly (litesvm's own tests load `program_bytes/counter.so`).

---

## 4. Test framework / TS runner (item 4) — all executed on Node 24.14
- **vitest 5.0.1** (2026-09-15; `latest`; `V4`=4.1.11, `V3`=3.2.7). engines `node ^22.12.0 || ^24.0.0 || >=26.0.0`; peer `vite ^6.4.0 || ^7.0.0 || ^8.0.0`, `@types/node ^22 || >=24`. Ran `t/smoke.test.ts` (imports litesvm, web3.js, kit decoder, raydium `CurveCalculator`, pump `buyQuoteInput`) → **2 passed, ~1 s**, no vite config needed. — VERIFIED.
- **tsx 4.23.13** (2026-08-30; engines `>=18`) runs `.ts`/`.mts` importing all libs. — VERIFIED. **ts-node 10.9.2** last modified 2025-10-13 (stale; not recommended).
- **Node 24 native TS**: `process.features.typescript === "strip"` — `node file.mts` works without flags; a `.ts` with `import` inside a CJS-typed package fails (`Cannot use import statement outside a module`) → use `.mts` or `"type":"module"`; erasable syntax only. — VERIFIED.
- **typescript**: `latest` = **7.0.2** (2026-07-08; Go-native, `@typescript/typescript-linux-x64` platform binaries), `6.0.3` exists, **last 5.x = 5.9.3** (2025-09-30, engines `>=14.17`). `tsc -p` (5.9.3, `strict`, `module NodeNext`, `skipLibCheck`) passes over code importing web3.js 1.99.0, kit 8.3.0 types, litesvm, raydium, pump. Pin 5.9.3 (task constraint); 7.x untested here. — VERIFIED.

## 5. SQLite (item 5) — executed
- **`node:sqlite`** in Node 24.14.0: built-in, **no flag**, exports `DatabaseSync, StatementSync, Session, constants, backup`; SQLite **3.51.2** (`process.versions.sqlite`). Prints `ExperimentalWarning: SQLite is an experimental feature and might change at any time` (silence with `--no-warnings` / `--disable-warning=ExperimentalWarning`). Docs: Stability 1.2 "Release candidate" from v24.15.0; unflagged since v23.4.0/v22.13.0. — VERIFIED (run) / DOCS_ONLY (stability).
- **better-sqlite3 13.0.3** (2026-08-05): engines `node>=22`; tarball (27.3 MB unpacked) ships `prebuilds/linux-x64.node` (+ darwin/arm64/musl/win32), **no `install` script** → no native compile on this host. — VERIFIED_IN_SOURCE.
- Choice: `node:sqlite` (zero deps) — accept the warning; better-sqlite3 only if the experimental API bites.

## 6. WebSocket (item 6)
`ws` **8.21.3** (2026-08-07), engines `>=10`, optional peers `bufferutil ^4.0.1`, `utf-8-validate >=5.0.2`. (web3.js 1.x itself uses `rpc-websockets ^9.0.2` for `onAccountChange`/`onLogs`.) — VERIFIED_IN_SOURCE.

---

## 7. Raydium SDK V2 0.2.70-alpha — CPMM helpers (item 8)
Repo `raydium-io/raydium-sdk-V2` HEAD `c2897835f71873471f4160fa57bd1865b7903d55` (2026-09-15T16:13:06+08:00 "chore: adjust cpmm collect fees ins account order"), `package.json` version `0.2.70-alpha`; `src/raydium/cpmm/` is byte-identical to the npm tarball's `src/` (diff -rq). Tarball 31 MB, ships `lib/` (cjs `index.js`, esm `index.mjs`, `.d.ts`) **and `src/`**. No anchor dependency (0 `require("@coral-xyz/anchor")` in lib). — VERIFIED_IN_SOURCE.

Files (tarball `package/…`, same paths under `src/` with `.ts`):
- `lib/raydium/cpmm/curve/calculator.d.ts` — `CurveCalculator.swapBaseInput(inputAmount, inputVaultAmount, outputVaultAmount, tradeFeeRate, creatorFeeRate, protocolFeeRate, fundFeeRate, isCreatorFeeOnInput): SwapResult` and `swapBaseOutput(outputAmount, …)`; `SwapResult = {newInputVaultAmount, newOutputVaultAmount, inputAmount, outputAmount, tradeFee, protocolFee, fundFee, creatorFee}` (all `BN`). `src/raydium/cpmm/curve/calculator.ts:44`:
```ts
    const tradeFee = Fee.tradingFee(inputAmount, tradeFeeRate);
    let inputAmountLessFees;
    if (isCreatorFeeOnInput) {
      creatorFee = Fee.creatorFee(inputAmount, creatorFeeRate);
      inputAmountLessFees = inputAmount.sub(tradeFee).sub(creatorFee);
    } else {
      inputAmountLessFees = inputAmount.sub(tradeFee);
    }
    const protocolFee = Fee.protocolFee(tradeFee, protocolFeeRate);
    const fundFee = Fee.protocolFee(tradeFee, fundFeeRate);
    const outputAmountSwapped = ConstantProductCurve.swapBaseInputWithoutFees(
      inputAmountLessFees, inputVaultAmount, outputVaultAmount);
```
- `lib/raydium/cpmm/curve/constantProduct.d.ts` — `ConstantProductCurve.swapBaseInputWithoutFees / swapBaseOutputWithoutFees`.
- `lib/raydium/cpmm/curve/fee.d.ts` — `CpmmFee.tradingFee/protocolFee/fundFee/creatorFee/splitCreatorFee/calculatePreFeeAmount`.
- `lib/raydium/cpmm/layout.d.ts` (`src/…/layout.ts`) — `CpmmPoolInfoLayout` span **637**: `configId@8 poolCreator@40 vaultA@72 vaultB@104 mintLp@136 mintA@168 mintB@200 mintProgramA@232 mintProgramB@264 observationId@296` and (SDK-computed `offsetOf`): `bump@328 status@329 lpDecimals@330 mintDecimalA@331 mintDecimalB@332 lpAmount@333 protocolFeesMintA@341 protocolFeesMintB@349 fundFeesMintA@357 fundFeesMintB@365 openTime@373 epoch@381 feeOn@389 enableCreatorFee@390 (6 pad) creatorFeesMintA@397 creatorFeesMintB@405`, then 28×u64 padding. `CpmmConfigInfoLayout` span **236**: `bump@8 disableCreatePool@9 index@10(u16) tradeFeeRate@12 protocolFeeRate@20 fundFeeRate@28 createPoolFee@36 protocolOwner@44 fundOwner@76 creatorFeeRate@108 creatorFeeShareRate@116`, then 14×u64. Reserves are **not** in pool state — `getRpcPoolInfos` decodes the pool then fetches `vaultA/vaultB` token accounts (`src/raydium/cpmm/cpmm.ts:90–130`).
- `lib/raydium/cpmm/pda.d.ts` — `getPdaPoolAuthority(programId)`, `getCpmmPdaAmmConfigId(programId, index)`, `getCpmmPdaPoolId(programId, ammConfigId, mintA, mintB)`, `getPdaLpMint`, `getPdaVault(programId, poolId, mint)`, `getPdaObservationId(programId, poolId)`, `getCreatorFeeSharePda`.
- `lib/raydium/cpmm/instruction.d.ts` — `makeSwapCpmmBaseInInstruction(programId, payer, authority, configId, poolId, userInputAccount, userOutputAccount, inputVault, outputVault, inputTokenProgram, outputTokenProgram, inputMint, outputMint, observationId, amountIn, amounOutMin)` (13 accounts in that order; payer signer; pool/user accts/vaults/observation writable) and `makeSwapCpmmBaseOutInstruction(…, amountInMax, amountOut)`. Discriminators (`src/raydium/cpmm/instruction.ts:29–30`): `swapBaseInput [143,190,90,218,196,30,51,222]` = `8fbe5adac41e33de`; `swapBaseOutput [55,217,98,86,163,74,180,173]` = `37d96256a34ab4ad`; data = disc ‖ u64 amountIn ‖ u64 amounOutMin.
- `src/raydium/cpmm/cpmm.ts` (class `CpmmModule`, exposed as `raydium.cpmm`): `getCpmmPoolKeys`, `getRpcPoolInfo(poolId, fetchConfigInfo?)`, `getRpcPoolInfos(poolIds[], fetchConfigInfo?)`, `toComputePoolInfos`, `getPoolInfoFromRpc(poolId)`, `computeSwapAmount({pool, amountIn, outputMint, slippage, swapBaseIn})` (wraps `CurveCalculator`, `isCreatorFeeOnInput = feeOn ∈ {BothToken, OnlyTokenB}`), `swap(params)`, `createPool`, `addLiquidity`, `withdrawLiquidity`, `lockLp`, …
- Program id: `src/common/programId.ts:29` `CREATE_CPMM_POOL_PROGRAM = CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`.
- Top-level re-exports (`lib/index.d.ts:48–54`): `CpmmPoolInfoLayout, CpmmConfigInfoLayout, CurveCalculator, CpmmFee, getCpmmPdaPoolId, getPdaVault, …` — importable from the package root.

## 8. PumpSwap SDK 1.20.0 — helpers (item 8)
npm gitHead `0e7ebefd5ce7fbc504ab6198f0642480f8a25446`; **`github.com/pump-fun/pump-swap-sdk` is not publicly reachable** ("Repository not found") → tarball is the only primary source; it ships `dist/` (cjs+esm, `.d.ts`) **and `src/`** incl. `src/idl/pump_amm.json` (`address pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, `pump_amm 0.1.0`, 34 instructions). `exports["."]` = `{types: dist/index.d.ts, require: dist/index.js, import: dist/esm/index.js}`. — VERIFIED_IN_SOURCE (tarball).

Files (`package/src/…`; compiled `dist/sdk/*.js`):
- `src/sdk/buy.ts` — pure fns **`buyQuoteInput({quote, slippage, baseReserve, quoteReserve, virtualQuoteReserves?, globalConfig, baseMintAccount: RawMint, baseMint, coinCreator, creator, feeConfig: FeeConfig|null, quoteMint?, isMayhemMode?, creatorFeeBps?}): BuyQuoteInputResult`** and `buyBaseInput({base, …})`.
- `src/sdk/sell.ts` — **`sellBaseInput({base, slippage, baseReserve, quoteReserve, virtualQuoteReserves?, globalConfig, baseMintAccount, baseMint, coinCreator, creator, feeConfig, quoteMint?, isMayhemMode?, creatorFeeBps?})`**, `sellQuoteInput`.
- `src/sdk/offlinePumpAmm.ts` — class **`PumpAmmSdk`** (singleton `PUMP_AMM_SDK`, anchor `OFFLINE_PUMP_AMM_PROGRAM`): `decodeGlobalConfig`, `decodeFeeConfig`, **`decodePool(AccountInfo<Buffer>)`** (pads trailing bytes to `account.pool.size`), `decodePoolNullable`, `buyInstructions`, `buyQuoteInput(swapSolanaState, quote, slippage): Promise<TransactionInstruction[]>` (calls pure `buyQuoteInput` with `pool.virtualQuoteReserves`, `pool.quoteMint`, `pool.isMayhemMode`, `pool.creatorFeeBps`), `sellInstructions`, `sellBaseInput`, private `swapAccounts(swapSolanaState)`. Constants: `POOL_SIZE = 270` (== anchor `account.pool.size`), `POOL_ACCOUNT_NEW_SIZE = 300`, `GLOBAL_CONFIG_SIZE = 949`, `FEE_CONFIG_SIZE_PRE_STABLE 2512 / POST_STABLE 4073 / POST_EXOTIC 4097`.
- `src/sdk/onlinePumpAmm.ts` — class **`OnlinePumpAmmSdk(connection)`**: **`fetchPool(pool): Promise<Pool>`**, `fetchGlobalConfigAccount()`, `fetchFeeConfigAccount()`, `fetchGlobalVolumeAccumulator()`, **`swapSolanaState(poolKey, user, userBaseTokenAccount?, userQuoteTokenAccount?)`** (one `getMultipleAccountsInfo([GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, poolKey])` then mints + pool token accounts), `swapSolanaStateNoPool`, `liquiditySolanaState`, …
- `src/sdk/pda.ts` — `PUMP_AMM_PROGRAM_ID`, `PUMP_PROGRAM_ID`, `PUMP_FEE_PROGRAM_ID = pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`; `GLOBAL_CONFIG_PDA = pumpAmmPda(["global_config"])` = `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw`; `PUMP_AMM_EVENT_AUTHORITY_PDA = pumpAmmPda(["__event_authority"])` = `GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR`; `PUMP_AMM_FEE_CONFIG_PDA = pumpFeePda(["fee_config", PUMP_AMM_PROGRAM_ID])` = `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx`; `poolPda(index, owner, baseMint, quoteMint)` seeds `["pool", u16 LE index, owner, baseMint, quoteMint]`; **`canonicalPumpPoolPda(mint, quoteMint=WSOL)` = `poolPda(0, pumpPoolAuthorityPda(mint), mint, quoteMint)`**; `userVolumeAccumulatorPda(user)`, `coinCreatorVaultAuthorityPda`, `coinCreatorVaultAtaPda`.
- `src/sdk/fees.ts` — `computeFeesBps`, `feesForQuoteMint`, `calculateFeeTier`, `getFeeRecipient`, `isSolLikeQuoteMint`, `isStableQuoteMint`, `USDC_MINT`.
- IDL (`src/idl/pump_amm.json`): `Pool` account discriminator `[241,154,109,4,17,177,109,188]` = `f19a6d0411b16dbc`; fields in order: `pool_bump u8, index u16, creator, base_mint, quote_mint, lp_mint, pool_base_token_account, pool_quote_token_account (pubkeys), lp_supply u64, coin_creator pubkey, is_mayhem_mode bool, is_cashback_coin bool, virtual_quote_reserves i128, creator_fee_bps u64, can_edit_creator_fee bool` (8+1+2+192+8+32+1+1+16+8+1 = 270). `buy` disc `66063d1201daebea`, args `base_amount_out u64, max_quote_amount_in u64, track_volume OptionBool`; accounts: `pool, user, global_config, base_mint, quote_mint, user_base_token_account, user_quote_token_account, pool_base_token_account, pool_quote_token_account, protocol_fee_recipient, protocol_fee_recipient_token_account, base_token_program, quote_token_program, system_program, associated_token_program, event_authority, program, coin_creator_vault_ata, coin_creator_vault_authority, global_volume_accumulator, user_volume_accumulator, fee_config, fee_program` (23). `sell` disc `33e685a4017f83ad` (21 accounts: same minus the two volume accumulators).

---

## 9. Open questions
See StructuredOutput `open_questions` (SBPFv3 vs litesvm 0.16 acceptance; pump repo private; raydium gitHead absent; agave docs RC vs stable; installed sizes unmeasured; kit-typed vs bytes API stability; no real DEX swap simulated in litesvm yet).
