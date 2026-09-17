# Token-2022 extensions vs SPL Token — effect on AMM swaps (Raydium CPMM, PumpSwap)

Primary-source verification note. Consulted 2026-09-17 (UTC; individual timestamps below).
Scope: read-only research engine, paper-only. Nothing here was executed on-chain.

Confidence legend: **V** = VERIFIED_IN_SOURCE (read code/IDL), **D** = DOCS_ONLY (prose docs),
**I** = INFERRED (arithmetic/derivation from verified facts), **U** = UNKNOWN.

## 0. Sources (URL @ sha/version, consulted UTC)

| id | source | ref | consulted |
|----|--------|-----|-----------|
| T22 | https://github.com/solana-program/token-2022 (shallow clone in `.scratch/token-2022`) | `18a80055ed7aa2d0dff4df4f613e28efee11cc1a` (2026-09-16 "Publish js@v0.18.0"; crates `spl-token-2022` 11.0.0, `spl-token-2022-interface` 3.1.1; js-legacy `@solana/spl-token` 0.4.15) | 2026-09-17T11:47Z |
| TOK | https://github.com/solana-program/token | `0087ca54bd5a5b07e1df7e1b52303529047a1186` (2026-09-01; `spl-token-interface` 3.0.0) | 2026-09-17T11:52Z |
| ATA | https://github.com/solana-program/associated-token-account | `2dc55ee1009d787eea7e1c401b8f27e6892bff4b` (2026-08-31) | 2026-09-17T11:52Z |
| HOOK | https://github.com/solana-program/transfer-hook | `94dfc28d5e0b3fdd0fb855e03f8817d5d4d0facb` (2026-09-08) | 2026-09-17T11:52Z |
| RAY | https://github.com/raydium-io/raydium-cp-swap | `59fb845a9e5bb569c8b2f3415f13b0c0ebcc6b92` (2026-09-10 "Chore/upgrade anchor (#77)"; anchor-lang/anchor-spl =1.0.2) | 2026-09-17T11:47Z |
| PUMP | https://github.com/pump-fun/pump-public-docs | `81091419e4457566469d4e2a27f64ed84d42419c` (2026-09-14; `idl/pump_amm.json` metadata version 0.1.0) | 2026-09-17T11:52Z |
| SOL1 | https://solana.com/docs/tokens/extensions | last-updated not shown | 2026-09-17T11:50Z |
| SOL2 | https://solana.com/docs/tokens/extensions/transfer-fees | not shown | 2026-09-17T11:53Z |
| SOL3 | https://solana.com/docs/tokens/extensions/transfer-hook | not shown | 2026-09-17T11:50Z |
| SOL4 | https://solana.com/docs/tokens/extensions/transfer-hook-integration | not shown | 2026-09-17T11:53Z |
| SOL5 | https://solana.com/docs/tokens/extensions/non-transferrable-tokens | not shown | 2026-09-17T11:53Z |
| SOL6 | https://solana.com/developers/guides/token-extensions/default-account-state | not shown | 2026-09-17T11:53Z |
| SOL7 | https://solana.com/docs/tokens/extensions/pausable | not shown | 2026-09-17T11:50Z |
| SOL8 | https://solana.com/docs/tokens/extensions/permanent-delegate | not shown | 2026-09-17T11:50Z |
| RAYD1 | https://docs.raydium.io/algorithms/token-2022-transfer-fees | not shown | 2026-09-17T11:52Z |
| RAYD2 | https://docs.raydium.io/user-flows/create-cpmm-pool | not shown | 2026-09-17T11:53Z |

Note: `https://solana.com/docs/tokens/extensions/{transfer-fee,non-transferable,default-account-state}` return 404; the live slugs are `transfer-fees`, `non-transferrable-tokens`, and the default-state page lives under `/developers/guides/token-extensions/`.
`https://docs.raydium.io/raydium/pool-creation/creating-a-constant-product-pool` and `.../for-liquidity-providers/pool-types/cpmm-constant-product` returned 404 at fetch time.

## 1. Program IDs (all **V**)

| program | id | source |
|---------|----|--------|
| SPL Token (legacy) | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | TOK `interface/src/lib.rs:17`; also T22 `interface/src/lib.rs:41` (`inline_spl_token`) |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | T22 `interface/src/lib.rs:29` |
| Associated Token Account | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | ATA `interface/src/lib.rs:11`; T22 `clients/js-legacy/src/constants.ts:10` |
| Native mint (Token) | `So11111111111111111111111111111111111111112` | TOK `interface/src/native_mint.rs:7` |
| Native mint (Token-2022) | `9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP` (decimals 9) | T22 `interface/src/native_mint.rs:4,7` |
| Raydium CPMM (mainnet) | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | RAY `programs/cp-swap/src/lib.rs:25`, `Anchor.toml:13` |
| Raydium CPMM (devnet feature) | `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb` | RAY `lib.rs:23` |
| PumpSwap AMM | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | PUMP `idl/pump_amm.json:2` |

ATA derivation (**V**, ATA `interface/src/address.rs:67-73`): `find_program_address([wallet, token_program_id, mint], ATA_PROGRAM)`. The token program id is part of the seeds, so a wallet has a different ATA for a Token mint vs a Token-2022 mint.

```rust
// ATA interface/src/address.rs@2dc55ee (lines 67-73)
    Pubkey::find_program_address(
        &[
            &wallet_address.to_bytes(),
            &token_program_id.to_bytes(),
            &token_mint_address.to_bytes(),
        ],
        program_id,
```

## 2. Base layouts — identical in Token and Token-2022 (**V**)

Both `TOK interface/src/state.rs` (lines 38-42, 132-136) and `T22 interface/src/state.rs` (lines 49-54, 146-151) use the same `array_refs!` splits.

### 2.1 Mint — 82 bytes

```rust
// T22 interface/src/state.rs@18a8005 (lines 49-54)
impl Pack for Mint {
    const LEN: usize = 82;
    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        let src = array_ref![src, 0, 82];
        let (mint_authority, supply, decimals, is_initialized, freeze_authority) =
            array_refs![src, 36, 8, 1, 1, 36];
```

| field | offset | size | encoding |
|-------|--------|------|----------|
| `mint_authority` COption<Pubkey> | 0 | 36 | tag u32 LE @0..4 (`[0,0,0,0]`=None, `[1,0,0,0]`=Some, anything else = InvalidAccountData); key @4..36 |
| `supply` u64 LE | 36 | 8 | |
| `decimals` u8 | 44 | 1 | |
| `is_initialized` u8 | 45 | 1 | must be 0 or 1 (`[0]=>false, [1]=>true, _=>InvalidAccountData`) |
| `freeze_authority` COption<Pubkey> | 46 | 36 | tag @46..50, key @50..82 |

**Freeze authority present ⇔ `data[46..50] == [1,0,0,0]`** (then key = `data[50..82]`).

COption encoding (**V**, T22 `interface/src/state.rs:274-292`):
```rust
pub(crate) fn unpack_coption_key(src: &[u8; 36]) -> Result<COption<Address>, ProgramError> {
    let (tag, body) = array_refs![src, 4, 32];
    match *tag {
        [0, 0, 0, 0] => Ok(COption::None),
        [1, 0, 0, 0] => Ok(COption::Some(Address::new_from_array(*body))),
        _ => Err(ProgramError::InvalidAccountData),
    }
}
```

### 2.2 Token account — 165 bytes

```rust
// T22 interface/src/state.rs@18a8005 (lines 146-151)
impl Pack for Account {
    const LEN: usize = 165;
    fn unpack_from_slice(src: &[u8]) -> Result<Self, ProgramError> {
        let src = array_ref![src, 0, 165];
        let (mint, owner, amount, delegate, state, is_native, delegated_amount, close_authority) =
            array_refs![src, 32, 32, 8, 36, 1, 12, 8, 36];
```

| field | offset | size | encoding |
|-------|--------|------|----------|
| `mint` Pubkey | 0 | 32 | |
| `owner` Pubkey | 32 | 32 | |
| `amount` u64 LE | 64 | 8 | |
| `delegate` COption<Pubkey> | 72 | 36 | tag @72..76, key @76..108 |
| `state` u8 (`AccountState`) | 108 | 1 | 0=Uninitialized, 1=Initialized, 2=Frozen (`#[repr(u8)]`, implicit order — T22 `state.rs:201-214`, TOK `state.rs:183-196`) |
| `is_native` COption<u64> | 109 | 12 | tag @109..113, u64 LE @113..121 (rent-exempt reserve for wSOL) |
| `delegated_amount` u64 LE | 121 | 8 | |
| `close_authority` COption<Pubkey> | 129 | 36 | tag @129..133, key @133..165 |

**Frozen detection: `data[108] == 2`.** The program's own fast path uses the same index:
```rust
// T22 interface/src/extension/mod.rs@18a8005 (lines 338-345)
fn is_initialized_account(input: &[u8]) -> Result<bool, ProgramError> {
    const ACCOUNT_INITIALIZED_INDEX: usize = 108; // See state.rs#L99
```
and `Account::is_frozen()` is `self.state == AccountState::Frozen` (`state.rs:126-128`).

Multisig is 355 bytes (`Multisig::LEN`, TOK `state.rs:218`). Extensions are never present on a 355-byte account (`check_min_len_and_not_multisig`, T22 `extension/mod.rs:275-281`); when an extended account would land on exactly 355 bytes the program pads it by 2 bytes (`adjust_len_for_multisig`, `mod.rs:123-130`).

## 3. Token-2022 TLV extension layout (**V**)

Rules from T22 `interface/src/extension/mod.rs`:

* Extensions are only possible on accounts owned by Token-2022. An account of exactly 82 (mint) or 165 (token account) bytes has **no** extensions (`try_get_account_len` returns `S::SIZE_OF` when no TLV, `mod.rs:441-452`).
* `BASE_ACCOUNT_LENGTH = Account::LEN = 165` (`mod.rs:311`). **For both mints and accounts, the `AccountType` byte is at absolute offset 165 and the TLV stream starts at 166.** A mint with extensions is `[0..82] base | [82..165] zero padding (must be all zero, else InvalidAccountData) | [165] AccountType | [166..] TLV`.

```rust
// T22 interface/src/extension/mod.rs@18a8005 (lines 316-332)
fn type_and_tlv_indices<S: BaseState>(rest_input: &[u8]) -> Result<Option<(usize, usize)>, ProgramError> {
    if rest_input.is_empty() { Ok(None) } else {
        let account_type_index = BASE_ACCOUNT_LENGTH.saturating_sub(S::SIZE_OF);
        // check padding is all zeroes
        let tlv_start_index = account_type_index.saturating_add(size_of::<AccountType>());
        if rest_input.len() < tlv_start_index { return Err(ProgramError::InvalidAccountData); }
        if rest_input[..account_type_index].iter().any(|&b| b != 0) {
            Err(ProgramError::InvalidAccountData)
        } else { Ok(Some((account_type_index, tlv_start_index))) }
```
(`rest_input` is `input[S::SIZE_OF..]`, so `account_type_index` is absolute 165 for both S=Mint(82) and S=Account(165).)

* `AccountType` (u8, `mod.rs:1054-1064`): 0 = Uninitialized, 1 = Mint, 2 = Account. Unpacking as the wrong base type fails (`check_account_type`).
* TLV entry = `type: u16 LE` (2 bytes) | `length: u16 LE` (2 bytes) | `value[length]`. Iteration stops at the first entry whose type == 0 (`Uninitialized`) or when fewer than 2 bytes remain (`try_for_each_tlv_extension_type`, `mod.rs:203-241`). A `length` that overruns the buffer ⇒ InvalidAccountData.
* The JS client uses the same constants: `TYPE_SIZE = 2; LENGTH_SIZE = 2; ACCOUNT_TYPE_SIZE = 1` (`clients/js-legacy/src/extensions/extensionType.ts:60-61`, `accountType.ts:6`).
* Total size of an extended account = `165 + 1 + Σ(4 + len_i)` (`try_get_account_len`, `mod.rs:441-452`), adjusted +2 if that equals 355.

Parser pseudo-code (I, derived from the above):
```
if owner != TOKEN_2022: no extensions
if len == base_len (82 or 165): no extensions
require data[165] == expected AccountType (1 mint / 2 account)
off = 166
while off + 4 <= len:
    t = u16le(data[off]); L = u16le(data[off+2]); if t == 0: break
    value = data[off+4 : off+4+L]  (require off+4+L <= len)
    off += 4 + L
```

### 3.1 ExtensionType numeric ids (**V**)

Rust enum `#[repr(u16)]` with implicit discriminants starting at 0 (T22 `interface/src/extension/mod.rs:1069-1146`); the JS client pins the tail with explicit numbers (`clients/js-legacy/src/extensions/extensionType.ts:14-45`: `MetadataPointer = 18 … PermissionedBurn = 28`). Both agree:

| id | ExtensionType | applies to | value len (bytes) | len source |
|----|---------------|-----------|-------------------|------------|
| 0 | Uninitialized | — | 0 | V |
| 1 | TransferFeeConfig | mint | 108 | I (repr(C): 32+32+8+18+18; JS `TransferFeeConfigLayout`) |
| 2 | TransferFeeAmount | account | 8 | V (`withheld_amount: U64`) |
| 3 | MintCloseAuthority | mint | 32 | V |
| 4 | ConfidentialTransferMint | mint | 65 | V (JS `getTypeLen` returns 65) |
| 5 | ConfidentialTransferAccount | account | 295 | V (JS returns 295) |
| 6 | DefaultAccountState | mint | 1 | V (`state: PodAccountState`; JS `u8('state')`) |
| 7 | ImmutableOwner | account | 0 | V (unit struct) |
| 8 | MemoTransfer | account | 1 | V (`Bool`) |
| 9 | NonTransferable | mint | 0 | V (unit struct) |
| 10 | InterestBearingConfig | mint | 52 | I (32+8+2+8+2) |
| 11 | CpiGuard | account | 1 | V |
| 12 | PermanentDelegate | mint | 32 | V (`delegate: MaybeNull<Address>`) |
| 13 | NonTransferableAccount | account | 0 | V |
| 14 | TransferHook | mint | 64 | V (`authority`, `program_id`: 2×MaybeNull<Address>; JS 2×publicKey) |
| 15 | TransferHookAccount | account | 1 | V (`transferring: Bool`) |
| 16 | ConfidentialTransferFeeConfig | mint | — | U (not needed) |
| 17 | ConfidentialTransferFeeAmount | account | — | U |
| 18 | MetadataPointer | mint | 64 | V (authority, metadata_address) |
| 19 | TokenMetadata | mint | variable | V (`sized()` returns false only for TokenMetadata, `mod.rs:1172-1180`) |
| 20 | GroupPointer | mint | 64 | I |
| 21 | TokenGroup | mint | — | U |
| 22 | GroupMemberPointer | mint | 64 | I |
| 23 | TokenGroupMember | mint | — | U |
| 24 | ConfidentialMintBurn | mint | — | U |
| 25 | ScaledUiAmount (JS: `ScaledUiAmountConfig`) | mint | 56 | I (32+8+8+8) |
| 26 | Pausable (JS: `PausableConfig`) | mint | 33 | V (`authority: MaybeNull<Address>`, `paused: Bool`; JS `publicKey`+`bool`) |
| 27 | PausableAccount | account | 0 | V (unit struct) |
| 28 | PermissionedBurn (**new; not in the task's list**) | mint | 32 | V (`authority: MaybeNull<Address>`) |

Mint-vs-account classification is from `ExtensionType::get_account_type` (`mod.rs:1254-1292`).

```rust
// T22 interface/src/extension/mod.rs@18a8005 (lines 1069-1075, start of the enum)
#[repr(u16)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
#[cfg_attr(test, derive(strum_macros::EnumIter))]
#[derive(Clone, Copy, Debug, PartialEq, TryFromPrimitive, IntoPrimitive)]
pub enum ExtensionType {
    Uninitialized,
    TransferFeeConfig,
```

`MaybeNull<Address>` (crate `solana_nullable`) is a 32-byte Pod pubkey where the all-zero key means "none" (**I**: `Option::<Address>::from(e.program_id)` in `transfer_hook::get_program_id`, and the JS layout decodes it as a plain `publicKey`; I did not read the `solana_nullable` crate). `Bool` is 1 byte (JS `bool()`).

### 3.2 Account extensions forced by mint extensions (**V**)

```rust
// T22 interface/src/extension/mod.rs@18a8005 (lines 1296-1308)
    fn required_init_account_extensions(&self) -> &'static [Self] {
        match self {
            ExtensionType::TransferFeeConfig => &[ExtensionType::TransferFeeAmount],
            ExtensionType::NonTransferable => &[
                ExtensionType::NonTransferableAccount,
                ExtensionType::ImmutableOwner,
            ],
            ExtensionType::TransferHook => &[ExtensionType::TransferHookAccount],
            ExtensionType::Pausable => &[ExtensionType::PausableAccount],
            _ => &[],
```

The ATA program always issues `InitializeImmutableOwner` and sizes the account with `ImmutableOwner` in addition to the mint-required extensions (ATA `program/src/processor.rs:117-139`). So a Token-2022 ATA is at least `165 + 1 + 4 = 170` bytes (**I**); e.g. for a transfer-fee mint: `170 + (4 + 8) = 182` bytes.

### 3.3 Invalid mint-extension combinations enforced at InitializeMint (**V**, `mod.rs:1326-1375`)

* `ConfidentialTransferFeeConfig` requires both `TransferFeeConfig` and `ConfidentialTransferMint`; conversely `TransferFeeConfig + ConfidentialTransferMint` requires `ConfidentialTransferFeeConfig`.
* `ConfidentialMintBurn` requires `ConfidentialTransferMint`.
* `ScaledUiAmount + InterestBearingConfig` is invalid.
* `NonTransferable + ConfidentialTransferMint` requires `ConfidentialMintBurn`.
* **Not** in source at this sha: any `NonTransferable + TransferFeeConfig` check, although SOL1 prose says "you can't combine the NonTransferable extension with the TransferFeeConfig" (**D**, discrepancy — see open questions).

## 4. TransferFeeConfig — layout and fee math (**V**)

```rust
// T22 interface/src/extension/transfer_fee/mod.rs@18a8005 (lines 26-27, 34-43)
pub const MAX_FEE_BASIS_POINTS: u16 = 10_000;
const ONE_IN_BASIS_POINTS: u128 = MAX_FEE_BASIS_POINTS as u128;
#[repr(C)]
pub struct TransferFee {
    pub epoch: U64,
    pub maximum_fee: U64,
    pub transfer_fee_basis_points: U16,
}
```

```rust
// same file (lines 135-149)
#[repr(C)]
pub struct TransferFeeConfig {
    pub transfer_fee_config_authority: MaybeNull<Address>,
    pub withdraw_withheld_authority: MaybeNull<Address>,
    pub withheld_amount: U64,
    /// Older transfer fee, used if `current epoch < new_transfer_fee.epoch`
    pub older_transfer_fee: TransferFee,
    /// Newer transfer fee, used if `current epoch >= new_transfer_fee.epoch`
    pub newer_transfer_fee: TransferFee,
}
```

Value-relative offsets (**I**, from repr(C) with unaligned pod ints; JS `TransferFeeConfigLayout` = publicKey, publicKey, u64, transferFee, transferFee and `transferFeeLayout` = u64 epoch, u64 maximumFee, u16 transferFeeBasisPoints — `clients/js-legacy/src/extensions/transferFee/state.ts:40-42,56-62`):

| field | offset in value | size |
|-------|-----------------|------|
| transfer_fee_config_authority | 0 | 32 |
| withdraw_withheld_authority | 32 | 32 |
| withheld_amount (u64 LE) | 64 | 8 |
| older.epoch (u64) | 72 | 8 |
| older.maximum_fee (u64) | 80 | 8 |
| older.transfer_fee_basis_points (u16) | 88 | 2 |
| newer.epoch | 90 | 8 |
| newer.maximum_fee | 98 | 8 |
| newer.transfer_fee_basis_points | 106 | 2 |
| **total** | | **108** |

Epoch selection and fee:

```rust
// T22 interface/src/extension/transfer_fee/mod.rs@18a8005 (lines 152-158)
    pub fn get_epoch_fee(&self, epoch: u64) -> &TransferFee {
        if epoch >= self.newer_transfer_fee.epoch.into() {
            &self.newer_transfer_fee
        } else {
            &self.older_transfer_fee
        }
    }
```

```rust
// same file (lines 45-70)
    fn ceil_div(numerator: u128, denominator: u128) -> Option<u128> {
        numerator.checked_add(denominator)?.checked_sub(1)?.checked_div(denominator)
    }
    pub fn calculate_fee(&self, pre_fee_amount: u64) -> Option<u64> {
        let transfer_fee_basis_points = u16::from(self.transfer_fee_basis_points) as u128;
        if transfer_fee_basis_points == 0 || pre_fee_amount == 0 {
            Some(0)
        } else {
            let numerator = (pre_fee_amount as u128).checked_mul(transfer_fee_basis_points)?;
            let raw_fee = Self::ceil_div(numerator, ONE_IN_BASIS_POINTS)?.try_into().ok()?;
            Some(cmp::min(raw_fee, u64::from(self.maximum_fee)))
        }
    }
```

**fee = 0 if bps == 0 or amount == 0; else min(ceil(amount × bps / 10 000), maximum_fee).** Recipient receives `amount − fee`; the fee is withheld in the destination account's `TransferFeeAmount` (SOL2 **D**; the on-chain epoch is `Clock::get()?.epoch`, `program/src/processor.rs:392-396` **V**). Inverse helper `calculate_pre_fee_amount(post)` (lines 89-116): bps=0 ⇒ post; post=0 ⇒ 0; bps=10 000 ⇒ post + maximum_fee; else `ceil(post × 10000 / (10000 − bps))`, capped so that fee ≤ maximum_fee. `calculate_inverse_fee` is not an exact inverse (doc comment lines 118-123: only `calculate_fee(x) >= calculate_inverse_fee(x − calculate_fee(x))` holds).

SOL2 (**D**): `SetTransferFee` "updates the newer transfer fee configuration, which takes effect starting two epochs later" — so a fee change is visible on-chain (in `newer_transfer_fee.epoch`) before it applies; always read the mint fresh and evaluate against the current epoch.

## 5. Transfer-path checks in Token-2022 (`program/src/processor.rs::process_transfer`, **V**)

Instruction discriminants (**V**, `program/src/pod_instruction.rs:61-` repr(u8) enum, and `interface/src/instruction.rs:1053,1115`): `Transfer = 3` (deprecated since 4.0.0, "please use TransferChecked or TransferCheckedWithFee"), `TransferChecked = 12` (data: `[12, amount u64 LE, decimals u8]`), `TransferFeeExtension = 26` with sub-instruction `TransferCheckedWithFee = 1` (data: `[26, 1, amount u64, decimals u8, fee u64]`; `transfer_fee/instruction.rs:178-184`), `FreezeAccount = 10`, `ThawAccount = 11`, `WithdrawExcessLamports = 38`, `UnwrapLamports = 45`.

Account order for `TransferChecked` (**V**, `processor.rs:342-354`): `[0] source (w)`, `[1] mint (r)`, `[2] destination (w)`, `[3] authority (signer, or multisig followed by M signers)`, `[4..] extra accounts forwarded verbatim to the transfer hook` (`account_info_iter.as_slice()`, line 591).

Check order (line numbers in `program/src/processor.rs@18a8005`):

1. 357-358 `check_program_account` on source and destination owners (must be Token-2022).
2. 363-365 source `is_frozen()` ⇒ `TokenError::AccountFrozen`.
3. 367-369 `source.amount < amount` ⇒ `InsufficientFunds`.
4. 370-375 source has `NonTransferableAccount` ⇒ `TokenError::NonTransferable`.
5. With mint (TransferChecked): 380-390 mint owner check, `MintMismatch`, `MintDecimalsMismatch`; 392-397 fee = `TransferFeeConfig.calculate_epoch_fee(Clock.epoch, amount)`; 401-405 `PausableConfig.paused` ⇒ `TokenError::MintPaused`; 407-408 read permanent delegate and hook program id.
6. Without mint (legacy `Transfer`): 417-436 if source has `TransferHookAccount` / `TransferFeeAmount` / `PausableAccount` ⇒ `MintRequiredForTransfer`.
7. 442-446 `TransferCheckedWithFee`: `calculated_fee != fee` ⇒ `FeeMismatch`.
8. 449-460 CpiGuard; 462 authority resolution (`match (source.delegate, maybe_permanent_delegate)`) — a permanent delegate can move funds from any account.
9. 523-524 destination `is_frozen()` ⇒ `AccountFrozen`.
10. 577-600 if hook program id present: set `transferring` flags on both accounts, CPI `spl_transfer_hook_interface::onchain::invoke_execute(program_id, source, mint, destination, authority, remaining, amount)`, unset flags. A failing hook fails the transfer.

```rust
// T22 program/src/processor.rs@18a8005 (lines 363-375)
        if source_account.base.is_frozen() {
            return Err(TokenError::AccountFrozen.into());
        }
        let source_amount = u64::from(source_account.base.amount);
        if source_amount < amount {
            return Err(TokenError::InsufficientFunds.into());
        }
        if source_account
            .get_extension::<NonTransferableAccount>()
            .is_ok()
        {
            return Err(TokenError::NonTransferable.into());
        }
```

```rust
// T22 program/src/processor.rs@18a8005 (lines 392-405)
                let fee = if let Ok(transfer_fee_config) = mint.get_extension::<TransferFeeConfig>()
                {
                    transfer_fee_config
                        .calculate_epoch_fee(Clock::get()?.epoch, amount)
                        .ok_or(TokenError::Overflow)?
                } else {
                    0
                };

                if let Ok(extension) = mint.get_extension::<PausableConfig>() {
                    if extension.paused.into() {
                        return Err(TokenError::MintPaused.into());
                    }
                }
```

Pausable also blocks `MintTo` (1077-1081) and `Burn` (1209-1213) (**V**; SOL7 **D** agrees: "Transfers, Mints, Burns").

Freeze/thaw (`process_toggle_freeze_account`, 1400-1445, **V**): requires `mint.freeze_authority` = Some (else `MintCannotFreeze`), signer = that authority, mint matches, account not native, and toggles `state` between `Frozen` and `Initialized`.

DefaultAccountState (**V**): at `InitializeMint` a `Frozen` default is rejected unless a freeze authority is set (`processor.rs:131-136`, `MintCannotFreeze`); at `InitializeAccount` every new account starts in the mint's default state (`processor.rs:227-233`). So on a DefaultAccountState=Frozen mint, a freshly created ATA is frozen (`data[108]==2`) and cannot send or receive until the freeze authority thaws it (SOL6 **D**: "Token accounts that start frozen cannot be used until the mint's freeze authority thaws them").

### 5.1 Transfer hook mechanics (**V**, HOOK)

```rust
// HOOK interface/src/lib.rs@94dfc28 (lines 27-33, 45-47)
const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";
pub fn get_extra_account_metas_address(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    get_extra_account_metas_address_and_bump_seed(mint, program_id).0
}
pub fn collect_extra_account_metas_seeds(mint: &Pubkey) -> [&[u8]; 2] {
    [EXTRA_ACCOUNT_METAS_SEED, mint.as_ref()]
}
```
* ExtraAccountMetaList PDA = `find_program_address(["extra-account-metas", mint], hook_program_id)`.
* `Execute` discriminator hash input: `"spl-transfer-hook-interface:execute"` (`interface/src/instruction.rs:70-72`, `#[discriminator_hash_input(...)]`). First 8 bytes of sha256 of that string = `0x692565c54bfb661a` (**I**: computed here; the `spl-discriminator` 0.5.1 hashing convention was not read).
* `TransferHook.program_id` all-zero ⇒ `get_program_id` returns `None` ⇒ **no CPI happens** (`interface/src/extension/transfer_hook/mod.rs:60-67`). A mint can carry the extension with no program (PumpSwap's create_v2 docs explicitly allow "a transfer hook with no program").
* SOL4 (**D**): integrators resolve extra accounts off-chain (`addExtraAccountMetasForExecute` / `resolveExtraAccountMetasForExecute`) and must append hook program + ExtraAccountMetaList + resolved metas to `TransferChecked`; "Don't cache either value for longer than a single transfer flow" — the authority can change the hook program or its meta list at any time.

## 6. Which extensions make a swap impossible / blocked / risky (synthesis; each row cites source)

| condition | detect (mint TLV unless noted) | effect on a swap | conf |
|-----------|-------------------------------|------------------|------|
| Mint owned by legacy Token | account owner == `Tokenkeg…` | no extensions possible; only freeze-authority risk applies | V |
| `NonTransferable` (type 9) | present | every transfer fails `NonTransferable` — **impossible** | V (`processor.rs:370-375`) |
| `Pausable` (26) with `paused` | value byte @32 == 1 | transfer/mint/burn fail `MintPaused` — **blocked while paused**; authority can pause at any time (risk even when unpaused) | V (`processor.rs:401-405`) |
| `DefaultAccountState` (6) == Frozen | value byte @0 == 2 | every new token account (incl. a pool vault / your ATA) starts frozen ⇒ transfers to/from it fail `AccountFrozen` until thawed — **blocked** unless already thawed | V (`processor.rs:227-233`, 363, 523) |
| Token account frozen | account `data[108] == 2` | transfer fails `AccountFrozen` (source or destination) — **blocked** | V |
| `freeze_authority` set on mint | mint `data[46..50] == [1,0,0,0]` | authority can freeze any account (yours or the pool vault) at any time — **risk** | V (`processor.rs:1400-1445`) |
| `TransferHook` (14) with non-zero `program_id` | value[32..64] != 0 | every `TransferChecked` CPIs into the hook with extra accounts that must be appended; missing/wrong accounts or a rejecting hook ⇒ transfer fails. An AMM that does not forward the accounts (Raydium CPMM at RAY sha does not) cannot swap it — **blocked/risky** | V (`processor.rs:577-600`), D (SOL3/SOL4) |
| `TransferFeeConfig` (1) | present | swap succeeds but each leg loses `min(ceil(amt×bps/10000), max_fee)`; fee can change (visible ≥ 2 epochs ahead in `newer_transfer_fee`) — **quantifiable cost** | V |
| `PermanentDelegate` (12) non-zero | value[0..32] != 0 | delegate can transfer/burn from any account (incl. pool vaults and your ATA) without consent — **risk** | V (`processor.rs:407, 462`), D (SOL8) |
| `MintCloseAuthority` (3) | present | mint can be closed once supply is 0 — minor risk | V (type exists); effect D |
| `ConfidentialTransferMint` (4) | present | irrelevant to public-balance swaps unless confidential-only; Raydium rejects it at pool creation | V (RAY) |
| `InterestBearingConfig` (10), `ScaledUiAmount` (25) | present | UI-amount display only; raw `amount` u64 unaffected — no swap effect | V (RAY allows both) |
| `MetadataPointer` (18), `TokenMetadata` (19) | present | no swap effect | V |
| `CpiGuard` (11), `MemoTransfer` (8), `ImmutableOwner` (7) | account TLV | account-side only; MemoTransfer on the *destination* requires a memo in the same tx (can fail a transfer to that account — irrelevant for pool vaults, relevant if your own ATA has it) | V (type), effect D |

## 7. Raydium CPMM (RAY @59fb845, `programs/cp-swap/src`) — **V**

### 7.1 Pool creation gate

```rust
// RAY programs/cp-swap/src/utils/token.rs@59fb845 (is_supported_mint)
pub fn is_supported_mint(mint_account: &InterfaceAccount<Mint>, mint_associated_is_initialized: bool) -> Result<bool> {
    let mint_info = mint_account.to_account_info();
    if *mint_info.owner == Token::id() { return Ok(true); }
    if mint_associated_is_initialized { return Ok(true); }
    let mint_data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;
    let extensions = mint.get_extension_types()?;
    for e in extensions {
        if e != ExtensionType::TransferFeeConfig
            && e != ExtensionType::MetadataPointer
            && e != ExtensionType::TokenMetadata
            && e != ExtensionType::InterestBearingConfig
            && e != ExtensionType::ScaledUiAmount
        { return Ok(false); }
    }
    Ok(true)
}
```

* Called from both `initialize` (`instructions/initialize.rs:188-200`) and `initialize_with_permission` (`:200-212`); failure ⇒ `ErrorCode::NotSupportMint` ("Not support token_2022 mint extension", `error.rs:27-28`).
* **Allowed Token-2022 extension set without whitelist: {TransferFeeConfig, MetadataPointer, TokenMetadata, InterestBearingConfig, ScaledUiAmount}.** Any other extension (TransferHook, PermanentDelegate, NonTransferable, DefaultAccountState, Pausable, MintCloseAuthority, ConfidentialTransferMint, Group*, PermissionedBurn, …) is rejected **unless** the mint is whitelisted.
* Whitelist = `SupportMintAssociated` PDA, seeds `["support_mint", mint]` under the CPMM program (`states/support_mint_associated.rs:3`, `LEN = 8+1+32+64 = 105`, fields `bump u8, mint Pubkey, padding [u64;8]`). It is passed in `remaining_accounts` of `initialize` (`utils/token.rs::support_mint_associated_is_initialized`). Created only by `admin::ID` or `Rayv2LG4tFSMizZhMP8aSUYxDPjV8qJtx2NQY9RKYZy` (mainnet; devnet `DRaypyeDL6y1dUusMgwyeDM5JebjhsSi8aRXobKQ9DcQ`), and the mint must be owned by Token-2022 (`instructions/admin/create_support_mint_associated.rs:7-27`). A whitelisted mint bypasses the extension check entirely — so a whitelisted TransferHook/PermanentDelegate mint **can** exist in a CPMM pool.
* **Freeze authority is not checked** anywhere in pool creation or swap (grep: no `freeze_authority` in `programs/cp-swap/src`).
* Mint ordering: `token_0_mint.key() < token_1_mint.key()`; `token_0_program`/`token_1_program` are `Interface<TokenInterface>` (either token program) and are stored in `PoolState.token_0_program / token_1_program` (`states/pool.rs:85-87`).

### 7.2 Transfer-fee handling in swaps

```rust
// RAY programs/cp-swap/src/utils/token.rs@59fb845 (get_transfer_fee)
pub fn get_transfer_fee(mint_info: &AccountInfo, pre_fee_amount: u64) -> Result<u64> {
    if *mint_info.owner == Token::id() { return Ok(0); }
    let mint_data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;
    let fee = if let Ok(transfer_fee_config) = mint.get_extension::<TransferFeeConfig>() {
        transfer_fee_config.calculate_epoch_fee(Clock::get()?.epoch, pre_fee_amount).unwrap()
    } else { 0 };
    Ok(fee)
}
```

`swap_base_input(amount_in, minimum_amount_out)` (`instructions/swap_base_input.rs:75-208`):
1. `transfer_fee = get_transfer_fee(input_mint, amount_in)`; `actual_amount_in = amount_in − transfer_fee` (must be > 0).
2. Curve runs on `actual_amount_in` against vault balances ⇒ `result.output_amount` (gross).
3. `fee_out = get_transfer_fee(output_mint, amount_out)`; `amount_received = amount_out − fee_out`; **`require_gte!(amount_received, minimum_amount_out, ExceededSlippage)`** — slippage is checked on the **net** amount the user receives.
4. CPI `transfer_checked(amount_in)` user→input vault (Token-2022 withholds `transfer_fee`; vault nets `actual_amount_in`), then `transfer_checked(amount_out gross)` vault→user (user nets `amount_received`).
5. `SwapEvent` carries `input_transfer_fee`, `output_transfer_fee`, `trade_fee`, `creator_fee`.

`swap_base_output(max_amount_in, amount_out_received)` (`instructions/swap_base_output.rs:9-100`):
1. `out_transfer_fee = get_transfer_inverse_fee(output_mint, amount_out_received)`; `amount_out_with_transfer_fee = amount_out_received + out_transfer_fee` (the gross the vault must send).
2. Curve solves for `input_amount`; `input fee = get_transfer_inverse_fee(input_mint, input_amount)`; `input_transfer_amount = input_amount + fee`; **`require_gte!(max_amount_in, input_transfer_amount)`**.
3. `get_transfer_inverse_fee` returns `maximum_fee` when bps == 10 000, and otherwise verifies `calculate_epoch_fee(post + inverse_fee) == inverse_fee`, else `TransferFeeCalculateNotMatch` (`utils/token.rs`).

Simulation formula (**I**, from the above): for base-input, `net_out = C(amount_in − F_in(amount_in)) − F_out(C(...))` where `C` is the curve and `F_x(a) = min(ceil(a·bps_x/10000), max_fee_x)` at the current epoch.

### 7.3 Transfer hooks are NOT forwarded at this sha

`transfer_from_user_to_pool_vault` / `transfer_from_pool_vault_to_user` build `token_2022::transfer_checked` with exactly `{from, to, authority, mint}` (`utils/token.rs:17-70`); `ctx.remaining_accounts` is only read in `initialize*` (whitelist PDA), `collect_excess_lamports`, `update_config` (grep over `programs/cp-swap/src`). No `spl_transfer_hook_interface`/`invoke_transfer_checked` usage. Therefore, at RAY HEAD, a (whitelisted) hook mint whose hook needs extra accounts cannot be swapped through CPMM.

### 7.4 Raydium docs vs source (RAYD1/RAYD2 **D**)

* RAYD2: "Non-transferable mints cannot be used in CPMM pools" — consistent with source. "If either mint has a transfer hook, swaps depend on that hook program… the pool may become hard to use" — implies hook pools can exist (only via whitelist in source).
* RAYD1 claims "Raydium CPMM supports these [transfer hooks] — the swap instruction forwards the hook accounts" and "minAmountOut … is checked against out_gross … not against what the user receives". **Both contradict the source at 59fb845** (no forwarding; slippage on net). Either the docs are stale or the deployed binary differs from GitHub HEAD — open question.

## 8. PumpSwap (PUMP @8109141) — IDL + prose only; program is closed-source

* Program `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` (**V**, `idl/pump_amm.json:2`). Constant-product AMM; instructions `create_pool, deposit, withdraw, buy, sell, extend_account, …` (`docs/PUMP_SWAP_README.md:182-226`).
* `buy` / `sell` accounts include **`base_token_program` and `quote_token_program` as free (non-fixed) accounts** — only `system_program`, `associated_token_program` (`ATokenGP…`) and `program` carry fixed `address` fields (`idl/pump_amm.json:577-760`; grep of `"name": "…token_program"` at lines 527/530, 700/703, 1131/1134, 2488/2491, 3429/3432). ⇒ each side may be Token or Token-2022, chosen per mint (**V** for the IDL shape; the on-chain validation logic is **U**).
* `Pool` account fields (`pump_amm.json` type `Pool`): `pool_bump u8, index u16, creator, base_mint, quote_mint, lp_mint, pool_base_token_account, pool_quote_token_account, lp_supply u64, coin_creator, is_mayhem_mode bool, is_cashback_coin bool, virtual_quote_reserves i128, creator_fee_bps u64, can_edit_creator_fee bool` — **no token-program fields**; the token program must be inferred from each mint's owner (**V**).
* Errors: `6006 UnsupportedBaseMint`, `6007 UnsupportedQuoteMint`, `6008 InvalidBaseMint`, `6009 InvalidQuoteMint`, `6010 InvalidLpMint` (**V**, `pump_amm.json:5640-5665`). What makes a mint "Unsupported" is not documented (**U**).
* Bonding-curve program (`idl/pump.json`, `create_v2` docs, lines 4432-4452, **V** as IDL prose): "Creates a new spl-22 coin" — **new pump.fun coins are Token-2022 mints** (decimals 6, metadata pointer = mint; `docs/instructions/COIN_CREATION.md:8,15`). `docs/instructions/BUY.md:13`: "`base_token_program` … For `create_v2` coins this is Token-2022: `TokenzQd…`". Quote mints: "`quote_token_program` (SPL Token or Token-2022; must own the mint)… The Token-2022 native mint is rejected, and a Token-2022 quote mint may only carry the xStock operable extension set (metadata pointer/metadata, permanent delegate, initialized default account state, scaled UI amount, pausable, confidential-transfer mint, and a transfer hook with no program)."
* `PUMP_SWAP_README.md` has **no** statement about which Token-2022 extensions `create_pool` accepts, nor about transfer-fee handling in `buy`/`sell` (**U**). A web summary (DeepWiki, not primary) claims PumpSwap LP mints use Token-2022 — not verified.

## 9. Solana docs statements used (all **D**)

* SOL1 lists 27 extension names (no `PermissionedBurn`, which exists in source as id 28) and says "Most extensions can't be added after an account is initialized" and "you can't combine the NonTransferable extension with the TransferFeeConfig".
* SOL3: "For every token transfer involving tokens from the Mint Account, the Token Extensions program makes a Cross Program Invocation (CPI) to execute an instruction on the Transfer Hook program… If this fails, the initial token transfer fails."
* SOL5: "Transfer and TransferChecked fail with TokenError::NonTransferable"; burn and close (at zero balance) still allowed; accounts get `NonTransferableAccount` and `ImmutableOwner`.
* SOL7: paused mint rejects Transfers, Mints, Burns; `PausableConfig` "stores the pause authority and whether the mint is currently paused".
* SOL8: permanent delegate can "authorize transfers and burns for any token account for that mint"; "token account owners cannot revoke the permanent delegate".

## 10. Open questions

1. Does the deployed mainnet CPMM binary (`CPMMoo8L…`) match RAY GitHub HEAD 59fb845? Raydium's own docs (RAYD1) describe hook-account forwarding and gross-based slippage, which the source does not do. Verify by comparing the on-chain program hash / IDL, or by inspecting a real hook-mint swap tx.
2. PumpSwap `create_pool`/`buy`/`sell`: which Token-2022 extensions are accepted (`UnsupportedBaseMint`/`UnsupportedQuoteMint` triggers) and whether transfer fees are netted in quotes — program is closed-source; only the bonding-curve `create_v2` quote-mint rule is documented.
3. `NonTransferable + TransferFeeConfig`: SOL1 says the combination is disallowed, but `check_for_invalid_mint_extension_combinations` at 18a8005 has no such rule. Irrelevant for swaps (NonTransferable already blocks), but the docs/source mismatch is noted.
4. Exact byte sizes for `ConfidentialTransferFeeConfig/Amount`, `TokenGroup`, `TokenGroupMember`, `ConfidentialMintBurn` were not derived (not needed for swap gating).
5. `MaybeNull<Address>` "none" encoding assumed to be the all-zero pubkey (crate `solana_nullable` not read).
6. The transfer-hook `Execute` 8-byte discriminator (`692565c54bfb661a`) is computed from the verified hash-input string assuming sha256-first-8-bytes (`spl-discriminator` 0.5.1 not read).
7. Whether PumpSwap LP mints are Token-2022 (only a non-primary web summary claims this).
