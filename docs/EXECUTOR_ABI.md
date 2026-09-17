# arb_executor — ABI (instruction 0 `ExecuteCircuit`)

Native Rust program in `programs/arb_executor` (no Anchor; `solana-program 4.1.0`). Purpose: execute a two-leg atomic circuit
**base (WSOL) → intermediate → base** through Raydium CPMM `swap_base_input` and/or PumpSwap `buy_exact_quote_in` / `sell`,
sizing leg B from the *realised* leg-A output and enforcing an on-chain profit guard, so that a losing or partially filled circuit
reverts as one transaction. This project is read-only research: the program is only loaded into a local LiteSVM
(`tests/fixtures/programs/arb_executor.so`, provenance in `arb_executor.json`) under the LOCAL-ONLY id
`ARB_EXECUTOR_LOCAL_PROGRAM_ID` (`src/simulation/executor_ix.ts`). It is never deployed.

TS builder: `src/simulation/executor_ix.ts` (`buildExecuteCircuitIx`, `legFromInstruction`, `EXECUTOR_ERRORS`, `parseCustomErrorCode`).
Rust: `src/params.rs` (data), `src/legs.rs` (leg validation + CPI data), `src/guard.rs` (deltas), `src/error.rs` (codes), `src/constants.rs` (cited addresses/offsets).

## Instruction data — exactly 45 bytes, little-endian (ABI v2)

| offset | size | field | notes |
|------:|-----:|-------|-------|
| 0 | 1 | `tag` u8 | `0` = ExecuteCircuit (any other tag → `InvalidTag`; any length other than 45 → `InvalidDataLength`; the 37-byte v1 layout is refused) |
| 1 | 8 | `amount_in` u64 | base units spent by leg A; must be ≤ balance of accounts[1] |
| 9 | 8 | `min_profit` u64 | require `base_after ≥ base_before + min_profit` |
| 17 | 8 | `leg_a_min_out` u64 | passed as the DEX's minimum-out for leg A. **Must be ≥ 1 for kind 1**: pump_amm rejects `min_base_amount_out == 0` with 6001 `ZeroBaseAmount`, so the program refuses it first (`ZeroMinOutForPumpBuy`). |
| 25 | 8 | `leg_b_min_out` u64 | passed as the DEX's minimum-out for leg B |
| 33 | 1 | `leg_a_kind` u8 | see kinds |
| 34 | 1 | `leg_a_account_count` u8 | length of leg A's segment **including** its program-id account (= 1 + CPI accounts) |
| 35 | 1 | `leg_b_kind` u8 | |
| 36 | 1 | `leg_b_account_count` u8 | |
| 37 | 8 | `max_lamports_spend` u64 | the user's NATIVE lamports may fall by at most this much inside the instruction (rent for accounts the DEXes create, e.g. PumpSwap's `user_volume_accumulator` ≈ 1,844,400). The transaction fee is charged outside the instruction and is not counted here. |

Kinds: `0` = RAYDIUM_CPMM_SWAP_BASE_INPUT (either leg), `1` = PUMPSWAP_BUY_EXACT_QUOTE_IN (leg A only: WSOL is the pool *quote*, the intermediate is the pool *base*), `2` = PUMPSWAP_SELL (leg B only). Other values → `LegKindUnknown`; a kind in the wrong leg → `LegKindInvalidForPosition`.

## Accounts

`accounts.len()` must equal `7 + leg_a_account_count + leg_b_account_count` (`AccountCountMismatch`).

| index | account | flags | checks |
|------:|---------|-------|--------|
| 0 | user | signer, writable | `is_signer` (`UserNotSigner`) |
| 1 | user base token account (WSOL ATA) | writable | owner program == [5]; a REAL token account of that program (SPL: exactly 165 bytes; Token-2022: ≥165 with account-type byte 2, else `TokenAccountTypeInvalid`); state==1; owner field == user; mint field == [3] |
| 2 | user intermediate token account | writable | owner program == [6]; same checks with mint == [4] |
| 3 | base mint (WSOL) | readonly | owner program == [5]; ≠ [4] (`SameMint`); **must be `So11111111111111111111111111111111111111112`** (`BaseMintNotWsol`) — the guard certifies profit in this token |
| 4 | intermediate mint | readonly | owner program == [6] |
| 5 | base token program | readonly | ∈ {`Tokenkeg…`, `TokenzQd…`} (`TokenProgramNotAllowed`) |
| 6 | intermediate token program | readonly | same |
| 7 … | **leg A segment**: `[7]` = leg program id, then `leg_a_account_count − 1` CPI accounts in exactly the target program's order | as the DEX requires | see below |
| … | **leg B segment**: likewise | | |

Token-account layout facts: `docs/sources/token2022.md` §2.2 (mint@0, owner@32, amount@64, state@108; Token-2022 accounts may be longer, base offsets unchanged).

### Leg segment — kind 0 (Raydium CPMM `swap_base_input`, `docs/sources/raydium_cpmm.md` §6, §2)
Segment = program id (`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`, else `LegProgramNotAllowlisted`) + **exactly 13** CPI accounts (`LegAccountCountInvalid`):

| cpi # | account | executor check |
|--:|---------|----------------|
| 0 | payer | == accounts[0] (`LegUserMismatch`) |
| 1 | authority | == `GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL` (`LegFixedAccountMismatch`) |
| 2 | amm_config | == PoolState.amm_config @8 |
| 3 | pool_state | owner == CPMM program (`PoolOwnerMismatch`); len ≥ 637 and disc `f7ede3f5d7c3de46` (`PoolDataInvalid`) |
| 4 | input_token_account | leg A: == [1]; leg B: == [2] (`LegUserTokenAccountMismatch`) |
| 5 | output_token_account | leg A: == [2]; leg B: == [1] |
| 6 | input_vault | == the pool vault whose mint is the leg's input mint (token_0_vault@72 / token_1_vault@104, matched via token_0_mint@168 / token_1_mint@200) (`LegVaultMismatch`; unmatched mints → `LegMintMismatch`) |
| 7 | output_vault | the other vault |
| 8 | input_token_program | == PoolState.token_{i}_program (@232/@264) **and** == [5]/[6] for that mint (`LegTokenProgramMismatch`) |
| 9 | output_token_program | likewise |
| 10 | input_token_mint | == [3] (leg A) / [4] (leg B) (`LegMintMismatch`) |
| 11 | output_token_mint | == [4] / [3] |
| 12 | observation_state | == PoolState.observation_key @296 (`LegFixedAccountMismatch`) |

CPI data: `8fbe5adac41e33de` ‖ `amount_in` ‖ `minimum_amount_out` (24 bytes). Leg A: `amount_in`, `leg_a_min_out`; leg B: realised delta, `leg_b_min_out`.

### Leg segment — kinds 1 / 2 (PumpSwap `buy_exact_quote_in` / `sell`, `docs/sources/pumpswap.md` §6, §2, §1)
Segment = program id (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`) + CPI accounts: buy **23..26**, sell **21..24** (named + 0..3 remaining: pool-v2, buyback recipient, buyback ATA). A cashback coin adds one remaining account to buy and two to sell: a cashback buy on a pool whose `coin_creator` is default still fits (26) and is accepted, a cashback buy with a coin creator (27) and every cashback sell fall outside the ranges and are refused (`LegAccountCountInvalid`).

| cpi # | account | executor check |
|--:|---------|----------------|
| 0 | pool | owner == pAMM (`PoolOwnerMismatch`); len ≥ 211, disc `f19a6d0411b16dbc` (`PoolDataInvalid`); Pool.base_mint@43 == [4] and Pool.quote_mint@75 == [3] (`LegMintMismatch`) |
| 1 | user | == accounts[0] |
| 2 | global_config | == `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw` = PDA["global_config"] (`GlobalConfigMismatch`) |
| 3 | base_mint | == Pool.base_mint |
| 4 | quote_mint | == Pool.quote_mint |
| 5 | user_base_token_account | == [2] (both kinds) |
| 6 | user_quote_token_account | == [1] (both kinds) |
| 7 | pool_base_token_account | == Pool @139 (`LegVaultMismatch`) |
| 8 | pool_quote_token_account | == Pool @171 |
| 9, 10 | protocol_fee_recipient, its ATA | not checked (the program validates against GlobalConfig); aliasing guard applies |
| 11 | base_token_program | == [6] |
| 12 | quote_token_program | == [5] |
| 13, 14 | system_program, associated_token_program | fixed values (`LegFixedAccountMismatch`) |
| 15 | event_authority | == `GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR` |
| 16 | program | == pAMM |
| 17, 18 | coin_creator_vault_ata, coin_creator_vault_authority | not checked; aliasing guard applies |
| 19, 20 (buy only) | global_volume_accumulator, user_volume_accumulator | not checked |
| 21 / 19 | fee_config | == `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` (`LegFixedAccountMismatch`) |
| 22 / 20 | fee_program | == `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` (`FeeProgramMismatch`) |
| rest | remaining accounts | not checked; aliasing guard applies |

CPI data — buy: `c62e1552b4d9e870` ‖ `spendable_quote_in = amount_in` ‖ `min_base_amount_out = leg_a_min_out` ‖ `0x01` (track_volume, 25 bytes); sell: `33e685a4017f83ad` ‖ `base_amount_in = delta` ‖ `min_quote_amount_out = leg_b_min_out` (24 bytes).

### Aliasing guard (both kinds)
accounts[1] / accounts[2] may appear in a segment **only** at their expected user-token-account positions; any other occurrence (vault, fee ATA, remaining account, observation, …) → `Aliasing`. `accounts[1] == accounts[2]` is also rejected (in practice `SameMint` fires first because [2] must carry mint [4]).

## Behaviour (order of operations)
1. Parse data; check total account count; check user signer; validate [1]..[6] as above.
2. `base0 = amount([1])`, `inter0 = amount([2])`; require `amount_in ≤ base0` (`InsufficientBaseBalance`).
3. Validate **both** leg segments (kind/position, allowlist, count, pool owner/layout, positions, vaults/mints/programs, fixed accounts, aliasing). Nothing is invoked before both legs validate.
4. Build leg A's instruction from the typed params and `invoke()` it with the segment's accounts (the user's signature passes through; account metas copy the flags of the outer instruction).
5. `inter1 = amount([2])`; `delta = inter1 − inter0`, require `delta > 0` (`LegANoOutput`).
6. Build leg B with amount = `delta` and `invoke()`.
7. `base1 = amount([1])`, `inter2 = amount([2])`; require `inter2 == inter0` (`LeftoverIntermediate`) and `base1 ≥ base0 + min_profit` with checked addition (`ArithmeticOverflow` / `ProfitBelowMin`).

Logs (stable format for parsers): `arb_executor leg A kind=<k> amount_in=<n> min_out=<n>`, `arb_executor leg B kind=<k> amount_in=<delta> min_out=<n>`, and on success `arb_executor ok base0=<n> base1=<n> profit=<n> inter_delta=<n> min_profit=<n>`.
Errors from the CPI'd DEX propagate unchanged (Anchor custom codes ≥ 6000 are the DEX's, never ours).

## Error codes (`ProgramError::Custom(code)`) — mirrored in `executor_ix.ts` `EXECUTOR_ERRORS`

| code | name | meaning |
|----:|------|---------|
| 1 | InvalidDataLength | data length ≠ 37 for tag 0, or empty data |
| 2 | InvalidTag | data[0] is not a known tag |
| 3 | UserNotSigner | accounts[0] did not sign |
| 4 | NotEnoughAccounts | fewer than 7 accounts |
| 5 | AccountCountMismatch | accounts.len() ≠ 7 + a + b |
| 6 | TokenProgramNotAllowed | [5]/[6] not Token or Token-2022 |
| 7 | TokenAccountProgramMismatch | owner program of [1]/[2] ≠ [5]/[6] |
| 8 | TokenAccountDataInvalid | [1]/[2] shorter than 165 bytes (or not borrowable) |
| 9 | TokenAccountNotInitialized | state byte ≠ 1 (frozen or uninitialised) |
| 10 | TokenAccountOwnerMismatch | token account owner field ≠ user |
| 11 | TokenAccountMintMismatch | token account mint field ≠ [3]/[4] |
| 12 | MintProgramMismatch | owner program of [3]/[4] ≠ [5]/[6] |
| 13 | SameMint | [3] == [4] |
| 14 | Aliasing | user token account at a foreign leg position, or [1] == [2] |
| 15 | LegKindUnknown | kind ∉ {0,1,2} |
| 16 | LegKindInvalidForPosition | kind 1 not in leg A / kind 2 not in leg B |
| 17 | LegProgramNotAllowlisted | segment[0] is not the mainnet program for the kind |
| 18 | LegAccountCountInvalid | segment count outside 14 (Raydium) / 24..27 (buy) / 22..25 (sell) including the program id |
| 19 | PoolOwnerMismatch | pool account owner ≠ leg program |
| 20 | PoolDataInvalid | pool too short or wrong discriminator |
| 21 | LegUserMismatch | CPI user/payer position ≠ accounts[0] |
| 22 | LegUserTokenAccountMismatch | CPI user token account positions ≠ [1]/[2] in the required roles |
| 23 | LegVaultMismatch | vault position ≠ pool vault field |
| 24 | LegMintMismatch | mint position / pool mint field ≠ [3]/[4] |
| 25 | LegTokenProgramMismatch | token program position ≠ pool field / [5]/[6] |
| 26 | LegFixedAccountMismatch | authority/amm_config/observation (Raydium) or system/ATA/event_authority/program/fee_config (PumpSwap) |
| 27 | GlobalConfigMismatch | PumpSwap global_config ≠ PDA["global_config"] |
| 28 | FeeProgramMismatch | PumpSwap fee_program ≠ `pfeeUxB6…` |
| 29 | InsufficientBaseBalance | amount_in > base0 |
| 30 | LegANoOutput | intermediate balance did not increase after leg A |
| 31 | LeftoverIntermediate | inter2 ≠ inter0 |
| 32 | ProfitBelowMin | base1 < base0 + min_profit |
| 33 | ArithmeticOverflow | base0 + min_profit overflowed u64 |

## Using it from TypeScript
```ts
const legA = legFromInstruction(LEG_KIND.RAYDIUM_CPMM_SWAP_BASE_INPUT, raydiumAdapter.buildSwapInstruction(poolA, {...}).instruction)
const legB = legFromInstruction(LEG_KIND.PUMPSWAP_SELL, pumpAdapter.buildSwapInstruction(poolB, {...}).instruction)
const ix = buildExecuteCircuitIx({ user: { user, userBaseTokenAccount, userIntermediateTokenAccount, baseMint: WSOL_MINT, intermediateMint, baseTokenProgram, intermediateTokenProgram },
                                   params: { amountIn, minProfit, legAMinOut, legBMinOut }, legA, legB })
// LiteSVM: svm.addProgram({ programId: ARB_EXECUTOR_LOCAL_PROGRAM_ID, elf: readFileSync(ARB_EXECUTOR_SO_PATH), ... })
```
The adapters' `buildSwapInstruction` amounts are ignored: the executor writes its own CPI data from the typed params; only the account lists (order + flags) are used.
Transaction size: a Raydium→Raydium circuit fits in one v0 message without a lookup table; any circuit with a PumpSwap leg (≥ 23 mostly unique accounts) needs an address lookup table (`tests/integration/executor_guard.test.ts` shows a LOCAL-ONLY fabricated ALT; layout in `docs/sources/solana_rpc_tx_fees.md` §5).

## Verification status (2026-09-17)
- **VERIFIED by executing the real compiled ELF in LiteSVM** (`tests/integration/executor_guard.test.ts`, 9 tests / 40+ assertions): every rejection code above except 30–33, plus: fully consistent Raydium/PumpSwap segments pass all validation and fail only at `invoke` (no DEX loaded), with and without an ALT; both legs are validated before leg A is invoked.
- **Unit-tested on the host only** (`cargo test`, 22 tests): guard arithmetic for codes 29–33 (`guard.rs`), PDA re-derivation of every baked constant, discriminators vs the Anchor convention, and the leg-validation matrix on fabricated views.
- **Not yet exercised**: the positive path against the real Raydium / PumpSwap ELFs with real pool state (integrator's task: `tests/fixtures/programs/CPMMoo8…so`, `pAMMBay6…so`, `pfeeUxB6…so` are already dumped); codes 30–33 through a real CPI; compute-unit cost of a full circuit.

## Build provenance
`scripts/build_executor.sh` → `tests/fixtures/programs/arb_executor.so` + `arb_executor.json` {sha256, bytes, built_at_utc, rustc_host, rustc_platform_tools, cargo_build_sbf, sbpf_arch_flag, solana_program_crate, source_hash_sha256 (= sha256 of `src/*.rs` concatenated in C-locale order)}. Toolchain: `docs/sources/toolchain.md`.


## How the probe drives it (and what a live deployment would change)

`src/simulation/probe.ts::localProbeExecutor` builds the two leg segments from the adapters' own instruction builders, then lets the **program** write the CPI data
from the typed parameters. It passes `leg_a_min_out` = the quoted leg-A output and `leg_b_min_out` = 1, so the only economic gate is the executor's guard
(`base_after >= base_before + min_profit`) — that is what is being measured. Two runs are made: `min_profit = 0` (does the circuit break even at all?) and
`min_profit = quoted trading PnL` (is the quote reproduced exactly on-chain?).

A live deployment would differ in three ways, all policy rather than measurement: a margin on `leg_a_min_out` (the pool can move between snapshot and landing),
a `min_profit` that covers the network and priority fees plus an uncertainty budget, and an address lookup table for any circuit with a PumpSwap leg
(1,262–1,684 bytes without one). None of that is enabled here: the program is never deployed and nothing is signed or sent.
