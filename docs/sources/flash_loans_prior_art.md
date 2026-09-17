# Flash loans on Solana mainnet + prior art — primary-source verification

- Topic: `flash_loans_and_prior_art`
- Consulted (UTC): 2026-09-17T11:47:11Z .. 2026-09-17T11:53:07Z
- Scope: research only, read-only, paper-only. Nothing is built, signed or broadcast.
- Confidence legend: **VERIFIED_IN_SOURCE** = read in code/IDL at the pinned sha; **DOCS_ONLY** = prose docs; **INFERRED** = derived, not read; **UNKNOWN** = could not see it (→ open questions).
- No RPC was used. Every "live value" (fees actually configured per reserve, available WSOL liquidity, reserve/bank pubkeys) is **TODO (RPC)**.

## 0. Sources (pinned)

| # | Source | Ref | What it established |
|---|--------|-----|---------------------|
| S1 | https://github.com/Kamino-Finance/klend | `a08760976f51a3a58c4a0c6ea27b4a0e565bca79` (branch `master`, commit 2026-08-18) | Kamino Lend flash ix handlers, sysvar checks, fee math, seeds, program id, license |
| S2 | npm `@kamino-finance/klend-sdk` | `12.0.0` (embedded IDL `kamino_lending` 1.25.0, `src/@codegen/klend/…`) | Discriminator bytes, account order, optional-account placeholder convention |
| S3 | https://github.com/mrgnlabs/marginfi-v2 | `35b5c66aa6897c43e7199bd6c598134041e89f99` (branch `main`, commit 2026-09-16) | marginfi flashloan bracket, discriminators, CPI checks, program ids, license |
| S4 | https://github.com/solendprotocol/solana-program-library | `d04ce00bbf4356c4fd32b3be38eb9760b696bb3e` (default branch `mainnet`, commit 2025-07-02) | Solend/Save FlashBorrow/FlashRepay tags, accounts, fee math, CPI checks, program id |
| S5 | https://github.com/arashdm2020/titanarb-engine | `eb5b64b139fe84cbb8a1cbdfbbf426cf5e10a478` (branch `master`, commit 2026-09-06); GitHub API `license: null` | README claims, license status (README + LICENSE only, as instructed) |
| S6 | https://docs.meteora.ag/developer-guides/dlmm , https://docs.meteora.ag/developer-guides/damm-v2 , https://docs.meteora.ag/core-products/dlmm/what-is-dlmm , https://docs.meteora.ag/developer-guides/dlmm/program/accounts.md | last-updated: UNKNOWN (not shown) | DLMM / DAMM v2 program ids (prose), bin step / bin array prose |
| S7 | https://github.com/MeteoraAg/dlmm-sdk | `576919e3e4368e542c402f000b4264724f7f23ec` (HEAD 2026-09-03) — files `idls/dlmm.json`, `commons/src/constants.rs`, `commons/src/math/price_math.rs`, `commons/src/lib.rs` | DLMM program id from IDL, bin-price formula, bin constants |
| S8 | https://github.com/MeteoraAg/damm-v2 | raw `main/programs/cp-amm/src/lib.rs`; `main` HEAD at fetch time = `a85c926607433f23f0ea60f4ca7b1ae92f4156cb` (2026-09-08) | DAMM v2 `declare_id!` |
| S9 | https://docs.save.finance/developers/flash-loans | last-updated: UNKNOWN | Save (ex-Solend) docs state (says "limited", no fee/program id shown) |
| S10 | GitHub REST API (`gh api repos/...`) | queried 2026-09-17 | default branches, license fields, `save-finance` org does not exist (404) |

Local clones: `/home/rares/trading/sol/atomarb/.scratch/{klend,marginfi-v2,solend-spl,titanarb-engine,klend-sdk-npm}`.

---

## TOPIC A — Flash-loan providers on Solana mainnet

### A.0 Common design (all three providers) — VERIFIED_IN_SOURCE

Solana has no callback-style flash loan (no `executeOperation`). All three live designs are **instruction-bracket** designs:

1. A top-level **borrow/start** instruction and a top-level **repay/end** instruction in the **same transaction**.
2. The program reads the **Instructions sysvar** (`solana_program::sysvar::instructions::ID`; the literal address is not read in these repos → INFERRED to be `Sysvar1nstructions1111111111111111111111111`) with `load_current_index_checked` / `load_instruction_at_checked` to introspect the rest of the transaction.
3. **CPI is forbidden** for the flash ixs themselves: each program errors if `get_stack_height() > TRANSACTION_LEVEL_STACK_HEIGHT` **or** if the instruction at the current sysvar index is not its own program id (the sysvar only lists top-level ixs, so a CPI caller would appear as the outer program). The swaps *between* borrow and repay may be anything (incl. CPI-heavy aggregators).
4. Repay carries a `borrow_instruction_index` (u8) pointing at the borrow ix; the borrow ix scans forward for exactly one matching repay.

Consequence for an atomic-arb tx: `[ComputeBudget…] [flash_borrow] [swap ix …] [flash_repay]` — one transaction, borrow and repay both top-level, at most one Kamino/Solend flash borrow per tx per program (see A.1/A.3).

---

### A.1 Kamino Lend (klend) — S1 @ `a0876097`, S2

| Item | Value | Confidence |
|------|-------|------------|
| Program id (mainnet) | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` | VERIFIED_IN_SOURCE (`programs/klend/src/lib.rs:30`, `#[cfg(not(feature="staging"))]`; also S2 `programId.ts`; also marginfi `Anchor.toml`) |
| Program id (staging) | `SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh` | VERIFIED_IN_SOURCE (`lib.rs:27`) |
| Framework | Anchor `0.29.0` (Cargo.lock), crate `kamino_lending` 1.25.0, `PROGRAM_VERSION = 1` | VERIFIED_IN_SOURCE |
| Instruction | `flash_borrow_reserve_liquidity(liquidity_amount: u64)` | VERIFIED_IN_SOURCE (`lib.rs:393-398`) |
| Instruction | `flash_repay_reserve_liquidity(liquidity_amount: u64, borrow_instruction_index: u8)` | VERIFIED_IN_SOURCE (`lib.rs:380-390`) |
| Discriminator borrow | `87e734a70734d4c1` = `[135,231,52,167,7,52,212,193]` | VERIFIED_IN_SOURCE (S2 `flashBorrowReserveLiquidity.ts:18`; = sha256("global:flash_borrow_reserve_liquidity")[..8], recomputed locally) |
| Discriminator repay | `b97500cb60f5b4ba` = `[185,117,0,203,96,245,180,186]` | VERIFIED_IN_SOURCE (S2 `flashRepayReserveLiquidity.ts:18`; = sha256("global:flash_repay_reserve_liquidity")[..8]) |
| Data layout borrow | bytes `[0..8)` disc, `[8..16)` `liquidity_amount` u64 LE (16 bytes) | VERIFIED_IN_SOURCE (`flash_ixs.rs:59` reads `ixn.data[8..16]`) |
| Data layout repay | `[0..8)` disc, `[8..16)` u64 LE amount, `[16]` u8 `borrow_instruction_index` (17 bytes) | VERIFIED_IN_SOURCE (Borsh of `FlashRepayReserveLiquidityArgs`, `flash_ixs.rs:151`) |
| Lending-market authority PDA | seeds `[b"lma", lending_market]` under klend | VERIFIED_IN_SOURCE (`utils/seeds.rs:1`, handler `#[account(seeds=…)]`) |
| Fee field | `Reserve.config.fees.flash_loan_fee_sf: u64` — a `U68F60` fixed-point (`Fraction`, 60 fractional bits) rate; `u64::MAX` = flash loans disabled | VERIFIED_IN_SOURCE (`state/reserve.rs:2096`, `utils/fraction.rs:2`) |
| Fee rule | `fee = round(max(amount * rate, 1))` (Exclusive); error `BorrowTooSmall` if `fee >= amount`; if referrer present and `lending_market.referral_fee_bps > 0`: `referral = floor(fee * referral_bps/10000)` (or all if 10000), `protocol_fee = fee - referral` | VERIFIED_IN_SOURCE (`state/reserve.rs:2261-2320`) |
| Fee transfers at repay | `amount + referrer_fee` user_source → supply vault; `protocol_fee` user_source → `reserve.liquidity.fee_vault` | VERIFIED_IN_SOURCE (`handler_flash_repay_reserve_liquidity.rs:65-87`) |
| **Live fee bps for WSOL reserve** | **TODO (RPC: read `Reserve.config.fees.flash_loan_fee_sf`, convert /2^60)** | UNKNOWN |
| **Available WSOL liquidity** | **TODO (RPC)** | UNKNOWN |
| License | Business Source License 1.1, Change Date 2027-11-17 (StroudGlobal S.A.) | VERIFIED_IN_SOURCE (`LICENSE`, `NOTICE`) |

**Accounts (12, identical positions for borrow and repay; the program requires identical pubkeys at every index between the pair):**

| idx | borrow name | repay name | mut/signer | constraint (source) |
|----:|-------------|------------|------------|---------------------|
| 0 | `user_transfer_authority` | same | signer | — |
| 1 | `lending_market_authority` | same | ro | PDA `[b"lma", lending_market]`, bump = `lending_market.bump_seed` |
| 2 | `lending_market` | same | ro | `AccountLoader<LendingMarket>` |
| 3 | `reserve` | same | mut | `has_one = lending_market`; repay checks borrow's `accounts[3] == reserve` |
| 4 | `reserve_liquidity_mint` | same | ro | `address = reserve.liquidity.mint_pubkey`, `mint::token_program = token_program` |
| 5 | `reserve_source_liquidity` | `reserve_destination_liquidity` | mut | `address = reserve.liquidity.supply_vault` |
| 6 | `user_destination_liquidity` | `user_source_liquidity` | mut | must NOT equal supply vault (`lending_checks.rs:375,413`) |
| 7 | `reserve_liquidity_fee_receiver` | same | mut | `address = reserve.liquidity.fee_vault` |
| 8 | `referrer_token_state` | same | mut, **optional** | `Option<AccountLoader<ReferrerTokenState>>`; SDK passes **program id** as placeholder when None |
| 9 | `referrer_account` | same | mut, **optional** | `Option<AccountInfo>`; placeholder = program id |
| 10 | `sysvar_info` | same | ro | `address = sysvar::instructions::ID` |
| 11 | `token_program` | same | ro | `Interface<TokenInterface>` (Token or Token-2022) |

(Source: `handler_flash_borrow_reserve_liquidity.rs:67-120`, `handler_flash_repay_reserve_liquidity.rs:104-153`, S2 IDL `flashBorrowReserveLiquidity`/`flashRepayReserveLiquidity`, S2 codegen lines 49-71.)

**Constraints as coded (VERIFIED_IN_SOURCE, `lending_market/flash_ixs.rs`, `ix_utils.rs`):**

- Both ixs: `#[access_control(emergency_mode_disabled(lending_market))]` → `GlobalEmergencyMode` if `lending_market.emergency_mode > 0`; `check_reserve_emergency_mode(reserve)`; reserve `version` must equal program version; reserve status `Obsolete` → error; `flash_loan_fee_sf == u64::MAX` → `FlashLoansDisabled`; Token-2022 extension whitelist check on borrow.
- **No CPI**: `is_flash_forbidden_cpi_call()` = (current sysvar ix `program_id != klend`) OR (`get_stack_height() > TRANSACTION_LEVEL_STACK_HEIGHT`) → `FlashBorrowCpi` / `FlashRepayCpi`.
- **Borrow scans every later ix** in the tx: any second klend ix with the borrow discriminator → `MultipleFlashBorrows`; a second repay → `MultipleFlashBorrows`; no repay → `NoFlashRepayFound`. So **max one Kamino flash borrow per transaction**.
- **Repay must match borrow**: same `liquidity_amount`; `borrow_instruction_index == borrow's own index`; same `accounts.len()`; every account pubkey equal index-by-index (`flash_ixs.rs:145-187`). Repay additionally re-checks the borrow ix at `borrow_instruction_index` (`<= current index`, program id, discriminator, `accounts[3] == reserve`, amount).
- Reserve is `refresh_reserve`d at borrow, `mark_stale()` after both ixs. Post-transfer vault-balance invariants are asserted (`post_transfer_vault_balance_liquidity_reserve_checks`).
- The `RESTRICTED_PROGRAMS` list (`[jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi]`) is only enforced on `repay_obligation_liquidity` (`handler_repay_obligation_liquidity.rs:152`), **not** on the flash ixs.

Excerpt — `programs/klend/src/lending_market/flash_ixs.rs@a08760976f51a3a58c4a0c6ea27b4a0e565bca79` (borrow-side scan):
```rust
    for ixn in ix_iterator {
        let ixn = ixn?;
        if ixn.program_id != crate::ID {
            continue;
        }
        if ixn.data[..8] == flash_borrow_discriminator {
            xmsg!("Multiple flash borrows not allowed");
            return err!(LendingError::MultipleFlashBorrows);
        }
        if ixn.data[..8] == flash_repay_discriminator {
            if found_repay_ix {
                xmsg!("Multiple flash repays not allowed");
                return err!(LendingError::MultipleFlashBorrows);
            }
            flash_borrow_check_matching_repay(liquidity_amount, &borrow_ix, &ixn, current_index)?;
```

Excerpt — `programs/klend/src/lending_market/ix_utils.rs@a0876097…` (CPI detection):
```rust
    fn is_flash_forbidden_cpi_call(&self) -> Result<bool> {
        let current_index = self.load_current_index()? as usize;
        let current_ixn = self.load_instruction_at(current_index)?;
        if crate::ID != current_ixn.program_id {
            return Ok(true);
        }
        if get_stack_height() > TRANSACTION_LEVEL_STACK_HEIGHT {
            return Ok(true);
        }
        Ok(false)
    }
```

Excerpt — `programs/klend/src/state/reserve.rs@a0876097…` (fee):
```rust
    pub fn calculate_flash_loan_fees(&self, flash_loan_amount_f: Fraction,
        referral_fee_bps: u16, has_referrer: bool) -> Result<(u64, u64)> {
        let (protocol_fee, referral_fee) = self.calculate_fees(
            flash_loan_amount_f, self.flash_loan_fee_sf,
            FeeCalculation::Exclusive, referral_fee_bps, has_referrer)?;
        Ok((protocol_fee, referral_fee))
    }
    // inside calculate_fees:
    //   FeeCalculation::Exclusive => amount.mul(origination_fee_rate),
    //   let origination_fee_f = origination_fee_amount.max(minimum_fee.into()); // minimum_fee = 1
    //   if origination_fee_f >= amount { return err!(LendingError::BorrowTooSmall); }
    //   let origination_fee: u64 = origination_fee_f.to_round();
```

---

### A.2 marginfi v2 — S3 @ `35b5c66a`

| Item | Value | Confidence |
|------|-------|------------|
| Program id (mainnet) | `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` | VERIFIED_IN_SOURCE (`id-crate/src/lib.rs`, feature `mainnet-beta` = default; `Anchor.toml [programs.mainnet]`) |
| Program id (devnet / staging / stagingalt / localnet) | `neetcne3Ctrrud7vLdt2ypMm21gZHGN2mCmqWaMVcBQ` / `stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct` / `5UDghkpgW1HfYSrmEj2iAApHShqU44H6PKTAar9LL9bY` / `2jGhuVUuy3umdzByFx8sNWUAaf5vaeuDm78RDPEnhrMr` | VERIFIED_IN_SOURCE (`id-crate/src/lib.rs`) |
| Framework | Anchor `1.0.2`, solana `3.1.13` (Anchor.toml); crate `marginfi` 0.1.11 | VERIFIED_IN_SOURCE |
| Instruction | `lending_account_start_flashloan(end_index: u64)` | VERIFIED_IN_SOURCE (`lib.rs:466-471`) |
| Instruction | `lending_account_end_flashloan()` (no args; uses `remaining_accounts` for health check) | VERIFIED_IN_SOURCE (`lib.rs:474-478`) |
| Discriminator start | `0e8321dc51bab46b` = `[14,131,33,220,81,186,180,107]` | VERIFIED_IN_SOURCE (`type-crate/src/constants.rs:242`; = sha256("global:lending_account_start_flashloan")[..8], recomputed; `get_discrim_hash("global", …)` in `flashloan.rs:66`) |
| Discriminator end | `697cc96a9902089c` = `[105,124,201,106,153,2,8,156]` | VERIFIED_IN_SOURCE (`constants.rs:243`; recomputed) |
| Data layout start | `[0..8)` disc, `[8..16)` `end_index` u64 LE | VERIFIED_IN_SOURCE |
| Mechanism | **Not a token flash loan.** `start` sets flag `ACCOUNT_IN_FLASHLOAN` on the user's `MarginfiAccount`; while set, `check_account_init_health` returns `Ok(())` immediately ("Risk checks are skipped during flashloans"), so ordinary `lending_account_borrow` / `withdraw` ixs in between are not health-checked. `end` clears the flag and runs the initial-health check (+ `run_cb_price_gate` if liabilities remain). | VERIFIED_IN_SOURCE (`flashloan.rs:23-37,115-132`; `state/marginfi_account.rs:1414-1423`) |
| Fee | No dedicated flash fee. The in-bracket `lending_account_borrow` charges the bank's `config.interest_rate_config.protocol_origination_fee` (I80F48 rate) on the borrowed amount (`borrow.rs:94-127`); plus group `program_fee_rate` applies to bank fees. **Live value per bank: TODO (RPC)**. | VERIFIED_IN_SOURCE (rule) / UNKNOWN (value) |
| Pre-requisite | An existing `MarginfiAccount` (owned by `authority`, in a `MarginfiGroup`) is required; the bracket wraps standard borrow/repay ixs that each need bank + vault + oracle accounts | VERIFIED_IN_SOURCE (account structs) |
| License | Apache-2.0 | VERIFIED_IN_SOURCE (`LICENSE`; GitHub API `Apache-2.0`) |

**Accounts — `LendingAccountStartFlashloan` (3):** 0 `marginfi_account` (mut, `has_one = authority`, constraint: not already IN_FLASHLOAN / IN_DELEVERAGE / IN_RECEIVERSHIP / DISABLED / FROZEN / IN_ORDER_EXECUTION, else `IllegalFlashloan`), 1 `authority` (signer), 2 `ixs_sysvar` (`address = solana_instructions_sysvar::ID`).

**Accounts — `LendingAccountEndFlashloan` (3 + remaining):** 0 `marginfi_account` (mut, `has_one = group`, `has_one = authority`, flag IN_FLASHLOAN must be set), 1 `group`, 2 `authority` (signer); `remaining_accounts` = banks/oracles for the health check.

**Constraints as coded (VERIFIED_IN_SOURCE, `instructions/marginfi_account/flashloan.rs`, `ix_utils.rs:141-160`):**

- start: `validate_not_cpi_with_sysvar` (current sysvar ix must be marginfi → else `NotAllowedInCPI` 6091), `current_ix_idx < end_index` (else `IllegalFlashloan` 6038), `validate_not_cpi_by_stack_height` (`get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT`), ix at `end_index` must exist, have discriminator `END_FLASHLOAN`, program id marginfi, and its `accounts[0]` must be the same `marginfi_account`.
- end: `validate_not_cpi_by_stack_height`; then clears flag; health check with `remaining_accounts`.
- While the flag is set: health-component fetches, liquidation, account transfer, closing are refused (`AccountInFlashloan` 6037; `can_be_closed()` false).
- Errors: `6037 AccountInFlashloan`, `6038 IllegalFlashloan`, `6091 NotAllowedInCPI` ("Start and end liquidation and flashloan must be top-level instructions").
- Note (source comment): flash loans are not explicitly disabled by a protocol pause but are disabled in effect because borrow/withdraw/deposit/repay are.

Excerpt — `programs/marginfi/src/instructions/marginfi_account/flashloan.rs@35b5c66aa6897c43e7199bd6c598134041e89f99`:
```rust
pub fn check_flashloan_can_start(marginfi_account: &AccountLoader<MarginfiAccount>,
    sysvar_ixs: &AccountInfo, end_fl_idx: usize) -> MarginfiResult<()> {
    let current_ix_idx: usize = validate_not_cpi_with_sysvar(sysvar_ixs)?;
    check!(current_ix_idx < end_fl_idx, MarginfiError::IllegalFlashloan);
    validate_not_cpi_by_stack_height()?;
    let unchecked_end_fl_ix = load_instruction_at_checked(end_fl_idx, sysvar_ixs)?;
    let discrim = &unchecked_end_fl_ix.data[..8];
    if discrim != END_FLASHLOAN { /* … */ return err!(MarginfiError::IllegalFlashloan); }
    check!(unchecked_end_fl_ix.program_id.eq(&crate::ID), MarginfiError::IllegalFlashloan);
    let end_fl_marginfi_account = end_fl_ix.accounts.get(END_FL_IX_MARGINFI_ACCOUNT_AI_IDX) // = 0
        .ok_or(MarginfiError::IllegalFlashloan)?;
    check!(end_fl_marginfi_account.pubkey.eq(&marginfi_account.key()), MarginfiError::IllegalFlashloan);
    Ok(())
}
```

Excerpt — `programs/marginfi/src/state/marginfi_account.rs@35b5c66a…`:
```rust
pub fn check_account_init_health<'info>(marginfi_account: &MarginfiAccount, group: &MarginfiGroup,
    remaining_ais: &'info [AccountInfo<'info>], health_cache: &mut Option<&mut HealthCache>) -> MarginfiResult {
    if marginfi_account.get_flag(ACCOUNT_IN_FLASHLOAN) {
        // Risk checks are skipped during flashloans
        return Ok(());
    }
```

---

### A.3 Solend / Save (token-lending fork) — S4 @ `d04ce00b`

| Item | Value | Confidence |
|------|-------|------------|
| Program id (mainnet) | `So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo` | VERIFIED_IN_SOURCE (`token-lending/program/src/lib.rs:12`; `token-lending/README.md:21`; marginfi `Anchor.toml`) |
| Framework | native (non-Anchor), `solana-program = 1.16.20`, crate `solend-program` 2.0.2, `spl-token 3.3.0` (Token-2022 not supported by these ixs) | VERIFIED_IN_SOURCE (`program/Cargo.toml`) |
| Instruction tag 13 | `FlashLoan { amount }` — **deprecated**: processor returns error `"This instruction has been deprecated. Use FlashBorrowReserveLiquidity instead"` | VERIFIED_IN_SOURCE (`processor.rs:130-132`, `sdk/src/instruction.rs:289`) |
| Instruction tag 19 | `FlashBorrowReserveLiquidity { liquidity_amount: u64 }` — data = `[19]` + u64 LE (9 bytes) | VERIFIED_IN_SOURCE (`instruction.rs:451,761,1062`) |
| Instruction tag 20 | `FlashRepayReserveLiquidity { liquidity_amount: u64, borrow_instruction_index: u8 }` — data = `[20]` + u64 LE + u8 (10 bytes) | VERIFIED_IN_SOURCE (`instruction.rs:472,766,1066`) |
| Lending-market authority PDA | seeds `[lending_market_pubkey]` (32 bytes) + stored bump, under program | VERIFIED_IN_SOURCE (`processor.rs:2670-2675`; builder `instruction.rs:1748`) |
| Fee field | `ReserveConfig.fees.flash_loan_fee_wad: u64` (WAD: 1e18 = 100%; comment example "0.3% (Aave) = 3_000_000_000_000_000" is illustrative, **not** the live value); `host_fee_percentage: u8`; `u64::MAX` = disabled | VERIFIED_IN_SOURCE (`sdk/src/state/reserve.rs:1131-1136`) |
| Fee rule | `total = round(max(amount*rate, min))`, min = 2 if host fee > 0 else 1; `host_fee = max(1, round(total*host_pct/100))` if host pct > 0; `origination = total - host`; `BorrowTooSmall` if `total >= amount` | VERIFIED_IN_SOURCE (`reserve.rs:1150-1212`) |
| Fee transfers at repay | `amount` user_source → supply; `host_fee` → `host_fee_receiver`; `origination_fee` → `reserve.config.fee_receiver`; all signed by `user_transfer_authority` | VERIFIED_IN_SOURCE (`processor.rs:2919-2950`) |
| **Live fee / host pct for WSOL reserve** | **TODO (RPC)** | UNKNOWN |
| **Available WSOL liquidity** | **TODO (RPC)** | UNKNOWN |
| License | Apache-2.0 (LICENSE; Cargo `license = "Apache-2.0"`; GitHub API shows `NOASSERTION`) | VERIFIED_IN_SOURCE |
| Docs status | https://docs.save.finance/developers/flash-loans says functionality is "limited" and the team is "working on a working flash loan program"; shows no fee, no program id. Contradicts/lags the code above. | DOCS_ONLY |
| `save-finance` GitHub org | does not exist (404); code lives under `solendprotocol` (org page titled "Save"), last push 2026-02-04 | VERIFIED (S10) |

**Accounts — `FlashBorrowReserveLiquidity` (7; processor reads exactly these):**
0 `source_liquidity` (mut; must equal `reserve.liquidity.supply_pubkey`), 1 `destination_liquidity` (mut; must NOT be the supply), 2 `reserve` (mut), 3 `lending_market`, 4 `lending_market_authority` (PDA), 5 Instructions sysvar, 6 SPL Token program. (Doc comment lists an optional 7th "Clock sysvar … will be removed soon"; the processor uses `Clock::get()` and does not read it.)

**Accounts — `FlashRepayReserveLiquidity` (9):**
0 `source_liquidity` (mut; user's; must NOT be the supply), 1 `destination_liquidity` (mut; must equal supply), 2 `reserve_liquidity_fee_receiver` (mut; must equal `reserve.config.fee_receiver`), 3 `host_fee_receiver` (mut; any), 4 `reserve` (mut), 5 `lending_market`, 6 `user_transfer_authority` (signer), 7 Instructions sysvar, 8 SPL Token program.

**Constraints as coded (VERIFIED_IN_SOURCE, `processor.rs:2599-2960, 3447-3475`):**

- `is_cpi_call`: current sysvar ix `program_id != Solend` OR `get_stack_height() > TRANSACTION_LEVEL_STACK_HEIGHT` → `FlashBorrowCpi` / `FlashRepayCpi`.
- Borrow scans **all** subsequent ixs (`load_instruction_at_checked` until `InvalidArgument`): for every Solend ix it `LendingInstruction::unpack`s the data; exactly one `FlashRepayReserveLiquidity` with `repay.accounts[4] == reserve`, same amount, `borrow_instruction_index == current_index`; another `FlashBorrowReserveLiquidity` → `MultipleFlashBorrows`; none → `NoFlashRepayFound`. So **max one Solend flash borrow per transaction**.
- Repay: `borrow_instruction_index <= current_index`; ix there must be Solend `FlashBorrowReserveLiquidity` with `accounts[2] == reserve` and equal amount.
- Kamino's design is a direct descendant of this (same error names; klend NOTICE credits the SPL token-lending program).

Excerpt — `token-lending/program/src/processor.rs@d04ce00bbf4356c4fd32b3be38eb9760b696bb3e`:
```rust
fn is_cpi_call(program_id: &Pubkey, current_index: usize, sysvar_info: &AccountInfo)
    -> Result<bool, ProgramError> {
    // tldr; instructions sysvar only stores top-level instructions, never CPI instructions.
    let current_ixn = load_instruction_at_checked(current_index, sysvar_info)?;
    // the current ixn must match the flash_* ix. otherwise, it's a CPI. Comparing program_ids is a
    // cheaper way of verifying this property, bc token-lending doesn't allow re-entrancy anywhere.
    if *program_id != current_ixn.program_id { return Ok(true); }
    if get_stack_height() > TRANSACTION_LEVEL_STACK_HEIGHT { return Ok(true); }
    Ok(false)
}
```

Excerpt — `token-lending/sdk/src/state/reserve.rs@d04ce00b…`:
```rust
    /// Fee for flash loan, expressed as a Wad.
    /// 0.3% (Aave flash loan fee) = 3_000_000_000_000_000
    pub flash_loan_fee_wad: u64,
    /// Amount of fee going to host account, if provided in liquidate and repay
    pub host_fee_percentage: u8,
```

---

### A.4 Cross-provider summary for the arb engine (research only)

| | Kamino klend | marginfi v2 | Solend/Save |
|---|---|---|---|
| Model | token flash borrow/repay bracket | health-check suspension bracket around normal borrow/repay | token flash borrow/repay bracket |
| Extra setup account | none (any token account) | needs a `MarginfiAccount` | none |
| Token-2022 | yes (`TokenInterface`) | (not checked here) | no (`spl_token` only) |
| Fee | per-reserve `flash_loan_fee_sf` (U68F60) + optional referral split — **value TODO** | bank `protocol_origination_fee` on borrow — **value TODO** | per-reserve `flash_loan_fee_wad` (+ host %) — **value TODO** |
| Max flash borrows / tx | 1 (program-wide scan) | 1 flag per MarginfiAccount (INFERRED: multiple accounts could each bracket) | 1 (program-wide scan) |
| Must be top-level | yes (both ixs) | yes (both ixs) | yes (both ixs) |
| Repay ↔ borrow binding | index + amount + identical 12 accounts | end ix index + same marginfi_account | index + amount + reserve at fixed positions |
| Liquidity WSOL | TODO (RPC) | TODO (RPC) | TODO (RPC) |
| Deployed bytecode == this sha? | UNKNOWN | UNKNOWN | UNKNOWN |

---

## TOPIC B — Prior art: `arashdm2020/titanarb-engine` — S5 @ `eb5b64b1` (README + LICENSE only)

- **Chain:** Arbitrum One (`chainId 42161`), EVM. README banner: "ARBITRUM ONE ARBITRAGE ENGINE". Runtime: Go (`go/`), with a legacy Python/Polygon history retained "for engineering history". — VERIFIED_IN_SOURCE (README lines 9-66, 430-445).
- **Flash liquidity:** Aave V3 (`Pool 0x794a61358D6845594F94dc1DB02A252b5b4814aD`), callback model (`executeOperation`, per `foundry.toml` comment). DEXes: Uniswap V3 (`Router 0xE592427A0AEce92De3Edee1F18E0157C05861564`), Camelot V3/Algebra. Contracts: `contracts/FlashArbitrageExecutor.sol`, `contracts/adapters/{UniswapV3Adapter,CamelotV3Adapter}.sol`, legacy `FlashTriangularArbitrage.sol`; Solidity `0.8.19`, `via_ir = true`. Deployed executor `0xdc63781E4f880F3911260Ecf0f1208eB32756666`. — VERIFIED_IN_SOURCE (README "Smart contracts", `foundry.toml`).
- **Claims (README):** "production-grade, live-capable"; 2/3/4-hop route search; "executable economics" gating (Aave premium, DEX fees, L1 data fee + L2 gas, slippage, price impact, liquidity, block freshness, repayment); adaptive loan-size optimizer; bounded quote budgets; RouteMemory/PairScore with 70/20/10 exploit/explore/new scheduling; tiered multi-provider RPC (Alchemy/Ankr/Chainstack/QuickNode/official); single-owner WSS; benchmark table "Dirty market cycle ~16.6s → ~2.56s, RPC calls/cycle ~128 → ~15". These are self-reported; no third-party verification. — DOCS_ONLY (README prose).
- **License:** **No `LICENSE`/`COPYING` file in the repo** (`git ls-files | grep -i licen` → empty); GitHub API `license: null`; README has no license/copyright section. The four `.sol` files carry `// SPDX-License-Identifier: MIT` headers; the Go and Python sources carry no license headers. Net: the repository as a whole is **unlicensed (all rights reserved by default)**; only the Solidity files self-declare MIT. — VERIFIED_IN_SOURCE + S10.
- **Reusability for Solana: none.** It is Solidity + Aave V3 `executeOperation` callback + EVM JSON-RPC (Go `ethclient`) + Uniswap/Camelot router ABIs. Solana flash loans (A.0) are instruction-bracket + Instructions-sysvar designs with no callback; accounts, PDAs, CU budgets, ALTs, Jito/leader scheduling have no EVM analogue. Nothing from this repo — code, ABIs, addresses, contracts, RPC layer — is portable. At most, the *abstract* engineering ideas (bounded quote budgets, near-miss telemetry, economics-before-broadcast gating) are generic and would have to be re-derived from scratch for Solana; given the missing license, no text or code should be copied.

---

## TOPIC C — Meteora program ids (shallow, as instructed)

| Item | Value | Confidence |
|------|-------|------------|
| DLMM (`lb_clmm`) program id | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | VERIFIED_IN_SOURCE (S7 `idls/dlmm.json` → `address`, IDL `lb_clmm` 0.12.0 @ `576919e3…`); docs (S6) say the same id is used on mainnet and devnet — DOCS_ONLY |
| DAMM v2 (`cp_amm`) program id | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | VERIFIED_IN_SOURCE (S8 `programs/cp-amm/src/lib.rs:42 declare_id!`, `main` HEAD `a85c9266…` at fetch); docs (S6) same, "same on mainnet and devnet" — DOCS_ONLY |
| DLMM needs bin math | yes — liquidity is discretized in price bins; `price(bin_id) = (1 + bin_step/10000)^bin_id` in fixed point: `get_price_from_id(active_id, bin_step)` computes `bps = (bin_step << SCALE_OFFSET) / BASIS_POINT_MAX; base = ONE + bps; pow(base, active_id)` | VERIFIED_IN_SOURCE (S7 `commons/src/math/price_math.rs:3-13`); `SCALE_OFFSET`/`ONE` values not fetched → UNKNOWN |
| DLMM constants | `BASIS_POINT_MAX = 10000`, `MAX_BIN_PER_ARRAY = 70`, `MAX_BIN_STEP = 400`, `MIN_BIN_ID = -443636`, `MAX_BIN_ID = 443636` | VERIFIED_IN_SOURCE (S7 `commons/src/constants.rs`) |
| Bin-array index | `floor(bin_id / 70)` with adjustment for negative remainders; each bin array covers 70 consecutive bin ids | DOCS_ONLY (S6 accounts page) |
| DLMM base fee | "Base fee rate = base_factor × bin_step × 10 × 10^base_fee_power_factor (1e9 units)" | DOCS_ONLY (S6 accounts page) — not verified in source |

Excerpt — `commons/src/math/price_math.rs@576919e3e4368e542c402f000b4264724f7f23ec` (MeteoraAg/dlmm-sdk):
```rust
pub fn get_price_from_id(active_id: i32, bin_step: u16) -> Result<u128> {
    let bps = u128::from(bin_step)
        .checked_shl(SCALE_OFFSET.into())
        .context("overflow")?
        .checked_div(BASIS_POINT_MAX as u128)
        .context("overflow")?;
    let base = ONE.checked_add(bps).context("overflow")?;
    pow(base, active_id).context("overflow")
}
```

Not explored (by instruction): DLMM swap ix layout, bin-array account derivation, dynamic/variable fees, DAMM v2 math.

---

## Open questions / TODO (need RPC or further verification)

1. Kamino: live `flash_loan_fee_sf` (→ bps) for the WSOL reserve(s) in the main market; `lending_market` and WSOL `reserve` pubkeys; `referral_fee_bps` of the market; available liquidity. (RPC)
2. Solend/Save: live `flash_loan_fee_wad`, `host_fee_percentage` for the WSOL reserve; whether the deployed program at `So1endDq…` is at/after this sha (docs claim flash loans "limited"); available liquidity. (RPC + verifiable-build check)
3. marginfi: live `protocol_origination_fee` for the SOL bank; whether start/borrow/swaps/repay/end fits the 1232-byte tx and CU limits with oracle `remaining_accounts` (needs an ALT); cost of creating a `MarginfiAccount`. (RPC)
4. Deployed bytecode vs. repo HEAD for all three programs is UNKNOWN (no on-chain hash / verifiable-build check performed).
5. The literal Instructions-sysvar address was not read from these sources (code references `sysvar::instructions::ID`) — INFERRED.
6. DLMM `SCALE_OFFSET` / `ONE` constants (fixed-point scale of `get_price_from_id`) — not fetched.
7. Whether a single tx may hold one Kamino flash borrow **and** one Solend flash borrow (each program only scans for its own ixs) — INFERRED yes, not tested.
8. Meteora docs pages show no last-updated date; treat DOCS_ONLY items as of 2026-09-17.
