# Raydium CPMM ("raydium-cp-swap") — primary-source verification note

Consulted (UTC): 2026-09-17T11:47:12Z … 2026-09-17T11:58:18Z
Scope: read-only research engine (paper only; nothing is broadcast).

Confidence legend: **VERIFIED_IN_SOURCE** = read in program code / SDK code / decoded from a live mainnet account; **DOCS_ONLY** = prose docs; **INFERRED** = derived/computed and cross-checked; **UNKNOWN** = could not establish.

## 0. Sources

| # | Source | Ref | What it established |
|---|--------|-----|---------------------|
| S1 | https://github.com/raydium-io/raydium-cp-swap (shallow clone, then `--deepen=40`) | master @ `59fb845a9e5bb569c8b2f3415f13b0c0ebcc6b92` (2026-09-10T06:36:22Z, "Chore/upgrade anchor (#77)"); crate `raydium-cp-swap` v0.2.0; anchor-lang `=1.0.2` | program IDs, PoolState/AmmConfig/ObservationState layouts, status bits, swap math, fee rules, Token-2022 transfer-fee handling, Swap accounts, PDA seeds |
| S2 | https://github.com/raydium-io/raydium-sdk-V2 (shallow clone, `--deepen=60`) | HEAD `c2897835f71873471f4160fa57bd1865b7903d55` (2026-09-15, "chore: adjust cpmm collect fees ins account order"); package `@raydium-io/raydium-sdk-v2` **0.2.70-alpha** (npm `latest`, modified 2026-09-15T08:17:53Z) | hard-coded ix discriminators, CpmmPoolInfoLayout/CpmmConfigInfoLayout, swap ix account order, reserve derivation, API v3 URLs, program-id constants, dependency versions |
| S3 | Solana mainnet-beta RPC (`https://api.mainnet-beta.solana.com`), live accounts | slot-time 2026-09-17 ~11:55Z | on-chain AmmConfig idx0, PoolState of CPMM pool `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4`, ObservationState, vault balances, program/programdata (last deploy slot), deployed-ELF string grep |
| S4 | https://api-v3.raydium.io (live) | `/main/version` → `{"latest":"V3.0.1","least":"V3.0.1"}` | pool listing endpoints, `poolType` semantics, response shape, `/main/cpmm-config`, `/pools/key/ids` |
| S5 | https://docs.raydium.io/reference/program-addresses ; https://docs.raydium.io/api-reference/api-v3/overview ; https://docs.raydium.io/ (site root) | fetched 2026-09-17 (no last-updated shown) | program-id table, admin/upgrade authority, API pageSize caps; site says **"Community-maintained. PRs welcome."** |
| S6 | GitHub API: branches / open PRs / commit dates / compare `master...feat/creator-fee-share` (`bdeee23fc064`, 2026-09-15T06:00:05Z); raw files from that branch | — | the unmerged creator-fee-share change the SDK already models |
| S7 | https://github.com/raydium-io/raydium-docs-v1/issues/7 (opened 2026-09-14, open, unanswered) | — | third party asking Raydium for build provenance of deployment slot 445763504; no answer |
| — | Anchor discriminator convention: `sha256("account:<Name>")[..8]`, `sha256("global:<ix_name>")[..8]`, `sha256("event:<Name>")[..8]` | computed locally with `sha256sum` | all instruction discriminators computed this way equal the SDK's hard-coded bytes; all account discriminators computed this way equal the first 8 bytes of live mainnet accounts |

No IDL JSON is committed in S1 (searched `**/idl/*.json`), and there is **no on-chain Anchor IDL account** (derived `3HD1FNEKoNh5aYfvw3VrNWy6WwrEtS6JYx1RmFTE7DMC` → account does not exist). Discriminators therefore come from the convention above, cross-checked as stated.

## 1. Program IDs — VERIFIED_IN_SOURCE (S1 lib.rs, S2 programId.ts, S3, S5)

`programs/cp-swap/src/lib.rs@59fb845`:
```rust
#[cfg(feature = "devnet")]
declare_id!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
#[cfg(not(feature = "devnet"))]
declare_id!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
```
- Mainnet program: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` (docs table and SDK `CREATE_CPMM_POOL_PROGRAM` agree). **Devnet id differs**: `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb`.
- Other constants in lib.rs (mainnet / devnet): admin `GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ` / `DRayqG9RXYi8WHgWEmRQGrUWRWbhjYWYkCRJDd6JBBak`; create-pool fee receiver `DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8` / `3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy`; protocol fee owner `ProCXqRcXJjoUd1RNoo28bSizAA6EEqt9wURZYPDc5u`; fund fee owner `FUNDduJTA7XcckKHKfAoEnnhuSud2JUCUZv6opWEjrBU`.
- Authority PDA (seed `b"vault_and_lp_mint_auth_seed"`): mainnet `GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL`, bump **253** (derived locally; equals SDK `CREATE_CPMM_POOL_AUTH` and live `auth_bump`). Devnet authority per SDK: `CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq`.
- On-chain deployment (S3): program account owner `BPFLoaderUpgradeab1e11111111111111111111111`, programdata `DMawCQzbgNTmbzaESc7o6pvL1KAeetY8zA7jNpzntHhU`, **last deployed slot 445763504 = 2026-09-10T01:54:31Z**, upgrade authority `FytDrVzDybM1TwFQPGb8qaxZR7dBCzNeqT3vtQsceZQK` (docs list the same upgrade authority). ELF size 793,824 bytes.
- Which source is deployed (INFERRED, strong): deployed ELF contains strings `collect_creator_fee_permissionless`, `Lamports calculate error`, `support_mint` (all present on master since PRs #71/#76/#77) and **zero** occurrences of `creator_fee_share` / `create_creator_fee_share` → mainnet runs the master lineage, **not** branch `feat/creator-fee-share`. Exact commit is not published (S7 asks for it; unanswered). Deploy (01:54Z) precedes the merge commit of #77 (06:36Z) by ~5 h; PR #77's branch tip `3b9325ba` is dated 2026-09-07.

## 2. PoolState account — VERIFIED_IN_SOURCE (S1 states/pool.rs) + live decode (S3)

Declared `#[account(zero_copy(unsafe))] #[repr(C, packed)]` → no alignment padding; all integers little-endian. `PoolState::LEN = 8 + 10*32 + 1*5 + 8*7 + 1*2 + 6*1 + 2*8 + 8*28 = 637` (unit test asserts `size_of::<PoolState>() == LEN - 8`).

Discriminator: `sha256("account:PoolState")[..8]` = **`f7 ed e3 f5 d7 c3 de 46`** — matches first 8 bytes of live pool `47hq28mc…` (owner `CPMMoo8…`, data length 637).

| offset | size | type | field | notes |
|-------:|-----:|------|-------|-------|
| 0 | 8 | [u8;8] | discriminator | `f7ede3f5d7c3de46` |
| 8 | 32 | Pubkey | amm_config | |
| 40 | 32 | Pubkey | pool_creator | |
| 72 | 32 | Pubkey | token_0_vault | |
| 104 | 32 | Pubkey | token_1_vault | |
| 136 | 32 | Pubkey | lp_mint | |
| 168 | 32 | Pubkey | token_0_mint | token_0_mint < token_1_mint (bytes) enforced at init |
| 200 | 32 | Pubkey | token_1_mint | |
| 232 | 32 | Pubkey | token_0_program | owner program of mint 0 (Token or Token-2022) |
| 264 | 32 | Pubkey | token_1_program | |
| 296 | 32 | Pubkey | observation_key | |
| 328 | 1 | u8 | auth_bump | |
| 329 | 1 | u8 | status | bitflags, see §4 |
| 330 | 1 | u8 | lp_mint_decimals | always 9 (`mint::decimals = 9` in initialize) |
| 331 | 1 | u8 | mint_0_decimals | |
| 332 | 1 | u8 | mint_1_decimals | |
| 333 | 8 | u64 | lp_supply | |
| 341 | 8 | u64 | protocol_fees_token_0 | accrued, still sitting in vault |
| 349 | 8 | u64 | protocol_fees_token_1 | |
| 357 | 8 | u64 | fund_fees_token_0 | |
| 365 | 8 | u64 | fund_fees_token_1 | |
| 373 | 8 | u64 | open_time | unix seconds; see §4 |
| 381 | 8 | u64 | recent_epoch | |
| 389 | 1 | u8 | creator_fee_on | 0=BothToken, 1=OnlyToken0, 2=OnlyToken1 |
| 390 | 1 | bool(u8) | enable_creator_fee | |
| 391 | 6 | [u8;6] | padding1 | |
| 397 | 8 | u64 | creator_fees_token_0 | |
| 405 | 8 | u64 | creator_fees_token_1 | |
| 413 | 224 | [u64;28] | padding | (unmerged branch would carve `shared_creator_fees_*` here — not on mainnet) |
| 637 | | | END | |

SDK 0.2.70 `CpmmPoolInfoLayout` (`src/raydium/cpmm/layout.ts@c289783`) has the identical sequence (names: configId, poolCreator, vaultA, vaultB, mintLp, mintA, mintB, mintProgramA, mintProgramB, observationId, bump, status, lpDecimals, mintDecimalA, mintDecimalB, lpAmount, protocolFeesMintA/B, fundFeesMintA/B, openTime, epoch, feeOn, enableCreatorFee, seq(u8,6), creatorFeesMintA/B, seq(u64,28)). SDK commit `1703c72` (2026-09-11) reverted a briefly-added `sharedCreatorFeesMintA/B` back to `seq(u64(), 28)`.

Live decode of `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4` (SOL/USDC, config index 5) — every PDA re-derived locally matched: pool = PDA[`b"pool"`, amm_config, mint0, mint1]; vault_i = PDA[`b"pool_vault"`, pool, mint_i]; lp_mint = PDA[`b"pool_lp_mint"`, pool]; observation = PDA[`b"observation"`, pool]; auth_bump 253. Values seen: status 0, lp_mint_decimals 9, mint_0_decimals 9, mint_1_decimals 6, open_time 1749098776, recent_epoch 1036, creator_fee_on 0, enable_creator_fee 0, creator fees 0, padding all zero. (Note: `initialize` also allows a non-PDA "random" pool account signed by the creator — `pool_state: UncheckedAccount`, comment "Or random account: must be signed by cli" — so never assume pool id == PDA; read `amm_config`/vaults from the account.)

## 3. AmmConfig account — VERIFIED_IN_SOURCE (S1 states/config.rs) + live decode (S3)

Borsh (`#[account]`, not zero-copy). `AmmConfig::LEN = 8 + 1 + 1 + 2 + 4*8 + 32*2 + 8 + 8*15 = 236`. PDA seeds: `[b"amm_config", index.to_be_bytes()]` (u16 **big-endian**, per tests/utils/pda.ts and SDK pda.ts `u16ToBytes(..., false)`); index 0 → `D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2` (derived locally, bump 255, matches Anchor.toml/docs).

Discriminator: `sha256("account:AmmConfig")[..8]` = **`da f4 21 68 cb cb 2b 6f`** — matches live account.

| offset | size | type | field |
|------:|-----:|------|-------|
| 0 | 8 | disc | `daf42168cbcb2b6f` |
| 8 | 1 | u8 | bump |
| 9 | 1 | bool | disable_create_pool |
| 10 | 2 | u16 LE | index |
| 12 | 8 | u64 | trade_fee_rate (1e-6 units) |
| 20 | 8 | u64 | protocol_fee_rate (share of trade fee, 1e-6) |
| 28 | 8 | u64 | fund_fee_rate (share of trade fee, 1e-6) |
| 36 | 8 | u64 | create_pool_fee (lamports) |
| 44 | 32 | Pubkey | protocol_owner |
| 76 | 32 | Pubkey | fund_owner |
| 108 | 8 | u64 | creator_fee_rate (1e-6 of input) |
| 116 | 120 | [u64;15] | padding — **SDK 0.2.70 labels bytes 116..124 `creatorFeeShareRate`** (from unmerged branch); live value 0 |
| 236 | | | END |

`FEE_RATE_DENOMINATOR_VALUE: u64 = 1_000_000` (`curve/fees.rs`). Constraints at create: `trade_fee_rate + creator_fee_rate < 1e6`, `protocol_fee_rate + fund_fee_rate <= 1e6`. `update_amm_config(param,value)`: 0 trade_fee_rate, 1 protocol_fee_rate, 2 fund_fee_rate, 3 protocol_owner (remaining acct), 4 fund_owner, 5 create_pool_fee, 6 disable_create_pool, 7 creator_fee_rate — admin only, so fee rates can change; re-read configs periodically.

Live mainnet index 0: trade 2500 (0.25%), protocol 120000 (12% of trade fee), fund 40000 (4%), create_pool_fee 150,000,000 lamports, creator_fee_rate 500, owners as in lib.rs. `/main/cpmm-config` (S4) lists configs: idx0 2500, idx5 3000, idx4 5000, idx1 10000, idx6 15000, idx2 20000, idx7 25000, … (protocol 120000, fund 40000, creatorFeeRate 500 on all shown).

## 4. status bits and open_time — VERIFIED_IN_SOURCE

`states/pool.rs@59fb845`:
```rust
pub enum PoolStatusBitIndex { Deposit, Withdraw, Swap }   // bit0, bit1, bit2
/// bit0, 1: disable deposit(value is 1), 0: normal
/// bit1, 1: disable withdraw(value is 2), 0: normal
/// bit2, 1: disable swap(value is 4), 0: normal
pub status: u8,
pub fn get_status_by_bit(&self, bit: PoolStatusBitIndex) -> bool {
    let status = u8::from(1) << (bit as u8);
    self.status.bitand(status) == 0      // true == enabled
}
```
Swap gate (`swap_base_input.rs` / `swap_base_output.rs`):
```rust
if !pool_state.get_status_by_bit(PoolStatusBitIndex::Swap) || block_timestamp < pool_state.open_time {
    return err!(ErrorCode::NotApproved);
}
```
So swap is allowed iff `(status & 4) == 0 && clock.unix_timestamp >= open_time`. `initialize` forces `open_time = max(open_time, block_timestamp + 1)` → a pool can never be swapped in the very slot it is created. Admin `update_pool_status(status: u8)` writes the raw byte.

## 5. Swap math — VERIFIED_IN_SOURCE (curve/fees.rs, curve/calculator.rs, curve/constant_product.rs, states/pool.rs, utils/token.rs, instructions/swap_base_input.rs)

### 5.1 Reserves used for pricing
`pool.rs`:
```rust
pub fn vault_amount_without_fee(&self, vault_0: u64, vault_1: u64) -> Result<(u64, u64)> {
    let fees_token_0 = self.protocol_fees_token_0 + self.fund_fees_token_0 + self.creator_fees_token_0; // checked_add
    let fees_token_1 = self.protocol_fees_token_1 + self.fund_fees_token_1 + self.creator_fees_token_1;
    Ok((vault_0.checked_sub(fees_token_0)…, vault_1.checked_sub(fees_token_1)…))   // InsufficientVault on underflow
}
```
`get_swap_params` reads `input_vault.amount` / `output_vault.amount` (the SPL token-account `amount`, i.e. bytes 64..72 of the vault account) and subtracts the three accrued fee counters for that token. Direction: `input_vault_key == token_0_vault && output_vault_key == token_1_vault` → `ZeroForOne`; `input == token_1_vault && output == token_0_vault` → `OneForZero`; anything else → `ErrorCode::InvalidVault`. (Direction is by **vault**, and `input_token_mint`/`output_token_mint` are constrained `address = input_vault.mint` / `output_vault.mint`, so matching by mint is equivalent.) Live check: vault0 balance 2,865,499,902 − fees 8,229,208 = reserve 2,857,270,694; SDK `getRpcPoolInfos` does the same subtraction (`cpmm.ts` lines ~153-157: vault − protocolFees − fundFees − creatorFees).

### 5.2 Fee helpers (`curve/fees.rs`, all in u128)
```rust
pub const FEE_RATE_DENOMINATOR_VALUE: u64 = 1_000_000;
fn ceil_div(a, num, den)  -> (a*num + den - 1) / den          // None if den==0
pub fn floor_div(a, num, den) -> (a*num) / den
Fees::trading_fee(amount, trade_fee_rate)      = ceil_div(amount, rate, 1e6)
Fees::protocol_fee(amount, protocol_fee_rate)  = floor_div(amount, rate, 1e6)   // amount = trade_fee
Fees::fund_fee(amount, fund_fee_rate)          = floor_div(amount, rate, 1e6)   // amount = trade_fee
Fees::creator_fee(amount, creator_fee_rate)    = ceil_div(amount, rate, 1e6)
Fees::split_creator_fee(total_fee, trade_rate, creator_rate) = floor_div(total_fee, creator_rate, trade_rate + creator_rate)
Fees::calculate_pre_fee_amount(post, rate)     = rate==0 ? post : ceil(post*1e6 / (1e6 - rate))
```

### 5.3 `swap_base_input(amount_in, minimum_amount_out)` — exact sequence
1. `transfer_fee = get_transfer_fee(input_mint, amount_in)`: 0 if mint owner is legacy Token program; else Token-2022 `TransferFeeConfig::calculate_epoch_fee(current_epoch, amount_in)` (0 if extension absent). `actual_amount_in = amount_in.saturating_sub(transfer_fee)`; require > 0.
2. Reserves `(R_in, R_out)` from §5.1; `constant_before = R_in * R_out` (u128).
3. `creator_fee_rate = enable_creator_fee ? amm_config.creator_fee_rate : 0` (`adjust_creator_fee_rate`).
4. `is_creator_fee_on_input`: `creator_fee_on==0 (BothToken)` → true; `1 (OnlyToken0)` → true iff ZeroForOne; `2 (OnlyToken1)` → true iff OneForZero; else false.
5. `CurveCalculator::swap_base_input(actual_amount_in, R_in, R_out, trade_fee_rate, creator_fee_rate, protocol_fee_rate, fund_fee_rate, on_input)`:
```rust
let input_amount_less_fees = if is_creator_fee_on_input {
    let total_fee = Fees::trading_fee(input_amount, trade_fee_rate + creator_fee_rate)?;   // ceil
    creator_fee = Fees::split_creator_fee(total_fee, trade_fee_rate, creator_fee_rate)?;   // floor
    trade_fee = total_fee - creator_fee;
    input_amount.checked_sub(total_fee)?
} else {
    trade_fee = Fees::trading_fee(input_amount, trade_fee_rate)?;                           // ceil
    input_amount.checked_sub(trade_fee)?
};
let protocol_fee = Fees::protocol_fee(trade_fee, protocol_fee_rate)?;   // floor, carved out of trade_fee
let fund_fee = Fees::fund_fee(trade_fee, fund_fee_rate)?;               // floor, carved out of trade_fee
let output_amount_swapped = ConstantProductCurve::swap_base_input_without_fees(input_amount_less_fees, input_vault_amount, output_vault_amount);
let output_amount = if is_creator_fee_on_input { output_amount_swapped }
                    else { creator_fee = Fees::creator_fee(output_amount_swapped, creator_fee_rate)?; output_amount_swapped.checked_sub(creator_fee)? };
```
   `swap_base_input_without_fees` (`constant_product.rs`): `out = floor(Δx * y / (x + Δx))` using native `u128` `checked_mul/checked_add/checked_div` (the `U128` uint type in utils/math.rs is only used for `integer_sqrt` at init). Output is **floored**; fees on input are **ceiled**. Returns `None` (→ `ErrorCode::ZeroTradingTokens`) on any overflow/underflow, but note `swap_base_input_without_fees` itself `unwrap()`s (panics) on overflow.
6. `constant_after = (R_in + input_amount_less_fees) * (R_out - output_amount_swapped)`; `require_gte!(constant_after, constant_before)`.
7. Output transfer: `amount_out = output_amount`; `transfer_fee_out = get_transfer_fee(output_mint, amount_out)`; `amount_received = amount_out - transfer_fee_out`; require `amount_received > 0` and `amount_received >= minimum_amount_out` else `ErrorCode::ExceededSlippage` (Anchor custom error 6005: NotApproved=6000, InvalidOwner, EmptySupply, InvalidInput, IncorrectLpMint, ExceededSlippage=6005, ZeroTradingTokens=6006, NotSupportMint, InvalidVault=6008, InitLpAmountTooLess, TransferFeeCalculateNotMatch, MathOverflow=6011, InsufficientVault=6012, InvalidFeeModel, NoFeeCollect, LamportsCalculateError).
8. `update_fees`: `protocol_fees_token_{in} += protocol_fee`, `fund_fees_token_{in} += fund_fee`; `creator_fees_token_{in or out} += creator_fee` (input token if on_input else output token). The LP share `trade_fee - protocol_fee - fund_fee` is **not** tracked — it simply remains in the vault and becomes part of the next reserve.
9. Token moves: `transfer_checked(user input ATA → input_vault, amount_in)` signed by payer; `transfer_checked(output_vault → user output ATA, amount_out)` signed by authority PDA `[b"vault_and_lp_mint_auth_seed", [auth_bump]]`. Then `emit!(SwapEvent{…})` (plain `emit!`, not `emit_cpi!` → event is in program logs as `Program data:` base64; `sha256("event:SwapEvent")[..8]` = `40 c6 cd e8 26 08 71 e2` — INFERRED via convention, not cross-checked), oracle observation updated with **pre-swap** prices, `recent_epoch` refreshed.

**Simulation recipe (paper):** `R_in, R_out` per §5.1; `a = amount_in − tf_in`; fees per step 5; `out = floor((a − fee_in) * R_out / (R_in + a − fee_in))`; subtract creator fee if on output; then Token-2022 output fee; the user receives `amount_received`. Post-swap vault balances: `vault_in += amount_in − tf_in` (transfer_checked delivers amount minus fee), `vault_out −= amount_out`; fee counters as step 8.

### 5.4 `swap_base_output(max_amount_in, amount_out)`
`out_wtf = amount_out + get_transfer_inverse_fee(output_mint, amount_out)` (inverse epoch fee, with a re-check `calculate_epoch_fee(out_wtf) == fee` else `TransferFeeCalculateNotMatch`; if mint fee bps == 10000 the fee is `maximum_fee`). If creator fee on output: `actual_out = calculate_pre_fee_amount(out_wtf, creator_fee_rate)`, `creator_fee = actual_out − out_wtf`. `in_swapped = ceil(R_in * actual_out / (R_out − actual_out))` (`checked_ceil_div`, utils/math.rs). If creator fee on input: `in_with_fee = calculate_pre_fee_amount(in_swapped, trade+creator)`, `total = in_with_fee − in_swapped`, `creator = split_creator_fee(total,…)`, `trade_fee = total − creator`; else `in_with_fee = calculate_pre_fee_amount(in_swapped, trade)`. `input_transfer_amount = in_with_fee + get_transfer_inverse_fee(input_mint, in_with_fee)`; require `≤ max_amount_in` (ExceededSlippage). Instruction discriminator `37 d9 62 56 a3 4a b4 ad`; args `(max_amount_in: u64, amount_out: u64)`; same `Swap` accounts.

### 5.5 Creator fee applicability (VERIFIED)
- `initialize` (permissionless pool creation) hard-codes `CreatorFeeOn::BothToken, enable_creator_fee = false` → ordinary CPMM pools have **no creator fee** regardless of `amm_config.creator_fee_rate`.
- `initialize_with_permission` (requires a `Permission` PDA `[b"permission", authority]` created by admin; used for LaunchLab migrations etc.) sets `enable_creator_fee = true` and the caller-chosen `creator_fee_on`.
- Always read `enable_creator_fee` (off 390) and `creator_fee_on` (off 389) per pool; do not assume.

### 5.6 SDK math caveats (INFERRED from reading `src/raydium/cpmm/curve/calculator.ts` and `cpmm.ts@c289783`)
- SDK `CurveCalculator.swapBaseInput` computes `tradeFee = ceil(in*trade)` and `creatorFee = ceil(in*creator)` separately when creator fee is on input, whereas the program computes `ceil(in*(trade+creator))` then floor-splits → can differ by 1 base unit. Also `Fee.fundFee` misuse aside, `protocolFee`/`fundFee` match.
- SDK `computeSwapAmount` sets `isCreatorFeeOnInput = feeOn === BothToken || feeOn === OnlyTokenB` **independent of direction**, which does not match the program's direction-dependent rule for `OnlyToken0/OnlyToken1` pools. → Port the Rust, do not rely on SDK math.
- Supported Token-2022 extensions for pool mints (`is_supported_mint`): TransferFeeConfig, MetadataPointer, TokenMetadata, InterestBearingConfig, ScaledUiAmount, or any mint whitelisted via a `SupportMintAssociated` PDA `[b"support_mint", mint]`.

## 6. `swap_base_input` instruction encoding — VERIFIED_IN_SOURCE (S1 `Swap` accounts struct; S2 `makeSwapCpmmBaseInInstruction`)

Data (24 bytes): `8f be 5a da c4 1e 33 de` ‖ `amount_in: u64 LE` ‖ `minimum_amount_out: u64 LE`. (`sha256("global:swap_base_input")[..8]` == SDK `anchorDataBuf.swapBaseInput = [143,190,90,218,196,30,51,222]`.)

Accounts, in order (program `#[derive(Accounts)] pub struct Swap` and SDK keys list agree exactly):

| # | account | signer | writable | constraint (program) |
|--:|---------|:-----:|:--------:|----------------------|
| 0 | payer | yes | no | `Signer` (no `mut`) |
| 1 | authority | no | no | PDA `seeds=[b"vault_and_lp_mint_auth_seed"]` = `GpMZbSM2…` |
| 2 | amm_config | no | no | `address = pool_state.amm_config` |
| 3 | pool_state | no | yes | `AccountLoader<PoolState>` |
| 4 | input_token_account | no | yes | user token account (owner/delegate enforced by token program on transfer) |
| 5 | output_token_account | no | yes | |
| 6 | input_vault | no | yes | must equal `token_0_vault` or `token_1_vault` |
| 7 | output_vault | no | yes | must equal `token_0_vault` or `token_1_vault` |
| 8 | input_token_program | no | no | `Interface<TokenInterface>` (Token or Token-2022, must match mint owner) |
| 9 | output_token_program | no | no | |
| 10 | input_token_mint | no | no | `address = input_vault.mint` |
| 11 | output_token_mint | no | no | `address = output_vault.mint` |
| 12 | observation_state | no | yes | `address = pool_state.observation_key` |

No `remaining_accounts` are read by swap (only `initialize` reads optional `SupportMintAssociated` remaining accounts; `collect_excess_lamports` uses remaining accounts). `Anchor.toml` test setup clones `D4FPEru…` (config 0) and `DNXgeM…` (fee receiver) from mainnet.

Other PDA seeds (states/*.rs, verified live): `b"pool"`+config+mint0+mint1; `b"pool_vault"`+pool+mint; `b"pool_lp_mint"`+pool; `b"observation"`+pool; `b"amm_config"`+u16 BE index; `b"permission"`+authority; `b"support_mint"`+mint.

ObservationState (`states/oracle.rs`): `#[repr(C, packed)]`, `LEN = 8+1+2+32+40*100+8*4 = 4075` (live length 4075, disc `7a ae c5 35 81 09 a5 84` = `sha256("account:ObservationState")`); offsets: 8 initialized(bool), 9 observation_index(u16), 11 pool_id, 43 observations[100]×{block_timestamp u64, cumulative_token_0_price_x32 u128, cumulative_token_1_price_x32 u128}, 4043 last_update_timestamp, 4051 padding[u64;3]. Prices are Q32.32 (`Q32 = 2^32`), `token_0_price_x32 = R1*2^32/R0` using fee-less reserves.

## 7. Direction — VERIFIED (see §5.1)
Direction is derived from **which vault** is passed as `input_vault`/`output_vault` (`get_swap_params`), with the mints constrained to those vaults' mints. Passing both vaults the same, or vaults from another pool, fails with `InvalidVault` / Anchor constraint error.

## 8. Raydium API v3 — VERIFIED by live calls (S4) + SDK url.ts/api.ts (S2) + docs (S5, DOCS_ONLY)

Base: `https://api-v3.raydium.io` (devnet `https://api-v3-devnet.raydium.io`). Version endpoint `/main/version` → V3.0.1. Requests with curl's default UA worked (500s seen were parameter errors, not UA blocks).

- `GET /pools/info/mint?mint1=<A>&mint2=<B>&poolType=<t>&poolSortField=default&sortType=desc&pageSize=N&page=1` — **`poolType` must be lowercase** here: `standard` / `all` (also `concentrated, allFarm, concentratedFarm, standardFarm` per SDK comment + docs); `poolType=Standard` → HTTP 500 `{"success":false,"msg":"query poolType type error"}`. Response: `{id, success, data:{count, hasNextPage, data:[items]}}`. Docs: pageSize cap 1000.
- `GET /pools/info/list-v2?size=N&mint1=&mint2=&poolType=Standard&sortField=liquidity&sortType=desc[&nextPageId=]` — what SDK 0.2.70 `fetchPoolByMints` actually calls (SDK sorts mint1<mint2 by string compare and maps SOL→WSOL). Here `poolType` is capitalized (`Standard`/`Concentrated`/`all`). Response `{data:{data:[items]}}`. Docs: `size` cap 1000.
- `GET /pools/info/ids?ids=a,b` → `data:[items]`; `GET /pools/key/ids?ids=` → pool keys: `{programId, id, mintA, mintB, lookupTableAccount, openTime, vault:{A,B}, authority, mintLp, config:{id,index,protocolFeeRate,tradeFeeRate,fundFeeRate,createPoolFee,creatorFeeRate,showWithUI}, observationId}` (live-verified equal to on-chain PoolState fields). `GET /main/cpmm-config` → all CPMM configs.
- **Filtering CPMM**: `type:"Standard"` covers BOTH AMM v4 (`programId 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`) and CPMM (`programId CPMMoo8…`); filter by `programId == CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`. Live SOL/USDC list-v2 size=100 returned 31 Standard pools, 14 of them CPMM. Item keys: `burnPercent, config, day, farmFinishedCount, farmOngoingCount, farmUpcomingCount, feeOn, feeRate, hasDynamicFee, id, launchMigratePool, lpAmount, lpMint, lpPrice, mintA, mintAmountA, mintAmountB, mintB, month, openTime, pooltype, price, programId, rewardDefaultInfos, tips, tvl, type, week` (`feeRate` is a fraction, e.g. 0.003 for tradeFeeRate 3000).
- Rate limits: **UNKNOWN** — not stated in the docs pages fetched (docs advise caching `/main/info` and `/mint/list` with 1-hour TTL). Docs site header: "Community-maintained. PRs welcome."

## 9. SDK packaging — VERIFIED_IN_SOURCE (S2 package.json; npm view)
`@raydium-io/raydium-sdk-v2@0.2.70-alpha` (dist-tag latest; modified 2026-09-15T08:17:53Z). **No `peerDependencies`**; regular `dependencies` include `@solana/web3.js ^1.95.3` (web3.js **1.x**), `@solana/spl-token ^0.4.8`, `@solana/buffer-layout ^4.0.1`, `bn.js ^5.2.1`, `decimal.js`, `axios`. **No Anchor dependency** in the SDK (it hand-encodes ix data with its own marshmallow layouts). The program repo's tests use `@anchor-lang/core 1.0.2`; the program builds with `anchor-lang = "=1.0.2"`, `solana_version = "3.1.10"`, Rust 1.91.0 (README).

## 10. Unmerged `feat/creator-fee-share` (S6) — NOT on mainnet; recorded for awareness
Branch `bdeee23fc064` (2026-09-15) adds `AmmConfig.creator_fee_share_rate: u64` at offset 116 (padding → `[u64;14]`, LEN stays 236), a `CreatorFeeShare` account (PDA `[b"creator_fee_share", creator, amm_config]`, LEN 8+1+64+8+64), ixs `create_creator_fee_share`/`close_creator_fee_share`, `Fees::creator_fee_shared_amount = floor_div(amount, share_rate, 1e6)`, and `PoolState::settle_creator_fee` (moves a floor-share of accrued creator fees into `protocol_fees_*` at collect time). **Swap math (`curve/calculator.rs`) is byte-identical to master on that branch**, so even if deployed later it would not change pricing; it only changes who collects accrued creator fees and the `collect_creator_fee*` account lists (SDK 0.2.70 already passes the extra `creatorFeeShare` account, which the deployed program does not expect). Deployed ELF grep: 0 hits for `creator_fee_share`.

## 11. Open questions
1. Exact source commit of the mainnet deployment at slot 445763504 (2026-09-10T01:54:31Z) is unpublished (issue raydium-docs-v1#7 unanswered); strings indicate master lineage (#76/#77 content), not `feat/creator-fee-share`.
2. API v3 rate limits are undocumented on the pages fetched.
3. Event discriminators (`SwapEvent`, `LpChangeEvent`) computed by convention only — not cross-checked against a real log.
4. `/pools/info/mint` vs `/pools/info/list-v2` pagination semantics differ (`page`/`pageSize`+`hasNextPage` vs `size`+`nextPageId`); behaviour beyond the first page not exercised.
5. SDK math deviations (§5.6) are my reading of the TS; not executed against the program.
