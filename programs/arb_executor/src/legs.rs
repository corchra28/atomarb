//! Leg validation and CPI instruction construction.
//! A "leg segment" is `[program_id, cpi_account_0, cpi_account_1, ...]`; `cpi` below always means the accounts AFTER the
//! program id, indexed exactly as the target program's account list (raydium_cpmm.md §6, pumpswap.md §6).
//! Validation works on `AccountView` (key/owner/flags) plus the raw pool bytes so it is unit-testable on the host.
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::pubkey::Pubkey;

use crate::constants::*;
use crate::error::ExecutorError;
use crate::params::{LegRole, KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN, KIND_PUMPSWAP_SELL, KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT};
use crate::token::pubkey_at;

/// Key/owner/flags of one account (no data borrow).
#[derive(Clone, Copy, Debug)]
pub struct AccountView<'a> {
    pub key: &'a Pubkey,
    pub owner: &'a Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

/// The seven fixed accounts of ExecuteCircuit (docs/EXECUTOR_ABI.md "Accounts").
#[derive(Clone, Copy, Debug)]
pub struct FixedKeys<'a> {
    pub user: &'a Pubkey,
    pub base_ta: &'a Pubkey,
    pub inter_ta: &'a Pubkey,
    pub base_mint: &'a Pubkey,
    pub inter_mint: &'a Pubkey,
    pub base_prog: &'a Pubkey,
    pub inter_prog: &'a Pubkey,
}

/// Mainnet program id a leg kind must target (allowlist).
pub fn expected_program(kind: u8) -> Option<Pubkey> {
    match kind {
        KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT => Some(RAYDIUM_CPMM_PROGRAM),
        KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN | KIND_PUMPSWAP_SELL => Some(PUMP_AMM_PROGRAM),
        _ => None,
    }
}

/// Index of the pool account within the CPI accounts (Raydium `pool_state` = 3; PumpSwap `pool` = 0).
pub fn pool_position(kind: u8) -> Option<usize> {
    match kind {
        KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT => Some(3),
        KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN | KIND_PUMPSWAP_SELL => Some(0),
        _ => None,
    }
}

/// Index of the user/payer within the CPI accounts (Raydium `payer` = 0; PumpSwap `user` = 1).
pub fn user_position(kind: u8) -> Option<usize> {
    match kind {
        KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT => Some(0),
        KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN | KIND_PUMPSWAP_SELL => Some(1),
        _ => None,
    }
}

/// (position of accounts[1] = base token account, position of accounts[2] = intermediate token account) within the CPI accounts.
/// Raydium: input_token_account = 4, output_token_account = 5 (leg A: base in / inter out; leg B: inter in / base out).
/// PumpSwap: user_base_token_account = 5 is the POOL base (= our intermediate), user_quote_token_account = 6 is the pool quote (= our base, WSOL).
pub fn user_token_positions(kind: u8, role: LegRole) -> Option<(usize, usize)> {
    match (kind, role) {
        (KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT, LegRole::A) => Some((4, 5)),
        (KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT, LegRole::B) => Some((5, 4)),
        (KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN, _) | (KIND_PUMPSWAP_SELL, _) => Some((6, 5)),
        _ => None,
    }
}

/// Validates the number of CPI accounts (excluding the program id) for a kind.
pub fn check_cpi_count(kind: u8, cpi_len: usize) -> Result<(), ExecutorError> {
    let ok = match kind {
        KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT => cpi_len == RAYDIUM_SWAP_ACCOUNTS,
        KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN => (PUMP_BUY_NAMED_ACCOUNTS..=PUMP_BUY_MAX_ACCOUNTS).contains(&cpi_len),
        KIND_PUMPSWAP_SELL => (PUMP_SELL_NAMED_ACCOUNTS..=PUMP_SELL_MAX_ACCOUNTS).contains(&cpi_len),
        _ => false,
    };
    if ok { Ok(()) } else { Err(ExecutorError::LegAccountCountInvalid) }
}

/// Aliasing guard: accounts[1] / accounts[2] may appear in the CPI list ONLY at their expected user-token-account positions.
/// This also rejects any vault / pool / fee account that equals a user token account.
pub fn check_aliasing(fixed: &FixedKeys, cpi: &[AccountView], pos_base: usize, pos_inter: usize) -> Result<(), ExecutorError> {
    for (i, a) in cpi.iter().enumerate() {
        if a.key == fixed.base_ta && i != pos_base {
            return Err(ExecutorError::Aliasing);
        }
        if a.key == fixed.inter_ta && i != pos_inter {
            return Err(ExecutorError::Aliasing);
        }
    }
    Ok(())
}

fn require_eq(actual: &Pubkey, expected: &Pubkey, err: ExecutorError) -> Result<(), ExecutorError> {
    if actual == expected { Ok(()) } else { Err(err) }
}

/// Full validation of one leg. `cpi` excludes the program id; `pool_data` is the raw data of `cpi[pool_position(kind)]`.
/// The caller has already checked kind-for-role, the program allowlist and the count.
pub fn validate_leg(fixed: &FixedKeys, role: LegRole, kind: u8, cpi: &[AccountView], pool_data: &[u8]) -> Result<(), ExecutorError> {
    let program = expected_program(kind).ok_or(ExecutorError::LegKindUnknown)?;
    check_cpi_count(kind, cpi.len())?;
    let pool_pos = pool_position(kind).ok_or(ExecutorError::LegKindUnknown)?;
    let user_pos = user_position(kind).ok_or(ExecutorError::LegKindUnknown)?;
    let (pos_base, pos_inter) = user_token_positions(kind, role).ok_or(ExecutorError::LegKindUnknown)?;
    // pool owner must be the leg program itself
    require_eq(cpi[pool_pos].owner, &program, ExecutorError::PoolOwnerMismatch)?;
    // the CPI user/payer must be our signer
    require_eq(cpi[user_pos].key, fixed.user, ExecutorError::LegUserMismatch)?;
    // aliasing before role checks so a swapped/duplicated user account is reported as Aliasing
    check_aliasing(fixed, cpi, pos_base, pos_inter)?;
    require_eq(cpi[pos_base].key, fixed.base_ta, ExecutorError::LegUserTokenAccountMismatch)?;
    require_eq(cpi[pos_inter].key, fixed.inter_ta, ExecutorError::LegUserTokenAccountMismatch)?;
    match kind {
        KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT => validate_raydium(fixed, role, cpi, pool_data),
        KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN | KIND_PUMPSWAP_SELL => validate_pump(fixed, kind, cpi, pool_data),
        _ => Err(ExecutorError::LegKindUnknown),
    }
}

/// Raydium `Swap` accounts (raydium_cpmm.md §6) against PoolState fields (raydium_cpmm.md §2).
fn validate_raydium(fixed: &FixedKeys, role: LegRole, cpi: &[AccountView], pool: &[u8]) -> Result<(), ExecutorError> {
    if pool.len() < RAYDIUM_POOL_LEN || pool[..8] != RAYDIUM_POOL_DISC {
        return Err(ExecutorError::PoolDataInvalid);
    }
    let amm_config = pubkey_at(pool, RAYDIUM_OFF_AMM_CONFIG);
    let vault0 = pubkey_at(pool, RAYDIUM_OFF_TOKEN_0_VAULT);
    let vault1 = pubkey_at(pool, RAYDIUM_OFF_TOKEN_1_VAULT);
    let mint0 = pubkey_at(pool, RAYDIUM_OFF_TOKEN_0_MINT);
    let mint1 = pubkey_at(pool, RAYDIUM_OFF_TOKEN_1_MINT);
    let prog0 = pubkey_at(pool, RAYDIUM_OFF_TOKEN_0_PROGRAM);
    let prog1 = pubkey_at(pool, RAYDIUM_OFF_TOKEN_1_PROGRAM);
    let observation = pubkey_at(pool, RAYDIUM_OFF_OBSERVATION_KEY);
    // direction: leg A spends base (accounts[3]) for intermediate (accounts[4]); leg B the reverse
    let (in_mint, out_mint, in_prog, out_prog) = match role {
        LegRole::A => (fixed.base_mint, fixed.inter_mint, fixed.base_prog, fixed.inter_prog),
        LegRole::B => (fixed.inter_mint, fixed.base_mint, fixed.inter_prog, fixed.base_prog),
    };
    let (in_vault, out_vault, pool_in_prog, pool_out_prog) = if *in_mint == mint0 && *out_mint == mint1 {
        (vault0, vault1, prog0, prog1)
    } else if *in_mint == mint1 && *out_mint == mint0 {
        (vault1, vault0, prog1, prog0)
    } else {
        return Err(ExecutorError::LegMintMismatch);
    };
    require_eq(cpi[1].key, &RAYDIUM_CPMM_AUTHORITY, ExecutorError::LegFixedAccountMismatch)?;
    require_eq(cpi[2].key, &amm_config, ExecutorError::LegFixedAccountMismatch)?;
    require_eq(cpi[6].key, &in_vault, ExecutorError::LegVaultMismatch)?;
    require_eq(cpi[7].key, &out_vault, ExecutorError::LegVaultMismatch)?;
    require_eq(cpi[8].key, &pool_in_prog, ExecutorError::LegTokenProgramMismatch)?;
    require_eq(cpi[9].key, &pool_out_prog, ExecutorError::LegTokenProgramMismatch)?;
    require_eq(cpi[8].key, in_prog, ExecutorError::LegTokenProgramMismatch)?;
    require_eq(cpi[9].key, out_prog, ExecutorError::LegTokenProgramMismatch)?;
    require_eq(cpi[10].key, in_mint, ExecutorError::LegMintMismatch)?;
    require_eq(cpi[11].key, out_mint, ExecutorError::LegMintMismatch)?;
    require_eq(cpi[12].key, &observation, ExecutorError::LegFixedAccountMismatch)?;
    Ok(())
}

/// PumpSwap buy_exact_quote_in / sell accounts (pumpswap.md §6) against Pool fields (pumpswap.md §2).
/// Pool base = our intermediate (accounts[4]); pool quote = our base (accounts[3], WSOL).
fn validate_pump(fixed: &FixedKeys, kind: u8, cpi: &[AccountView], pool: &[u8]) -> Result<(), ExecutorError> {
    if pool.len() < PUMP_POOL_MIN_LEN || pool[..8] != PUMP_POOL_DISC {
        return Err(ExecutorError::PoolDataInvalid);
    }
    let pool_base_mint = pubkey_at(pool, PUMP_OFF_BASE_MINT);
    let pool_quote_mint = pubkey_at(pool, PUMP_OFF_QUOTE_MINT);
    let pool_base_ta = pubkey_at(pool, PUMP_OFF_POOL_BASE_TOKEN_ACCOUNT);
    let pool_quote_ta = pubkey_at(pool, PUMP_OFF_POOL_QUOTE_TOKEN_ACCOUNT);
    require_eq(&pool_base_mint, fixed.inter_mint, ExecutorError::LegMintMismatch)?;
    require_eq(&pool_quote_mint, fixed.base_mint, ExecutorError::LegMintMismatch)?;
    require_eq(cpi[2].key, &PUMP_GLOBAL_CONFIG, ExecutorError::GlobalConfigMismatch)?;
    require_eq(cpi[3].key, &pool_base_mint, ExecutorError::LegMintMismatch)?;
    require_eq(cpi[4].key, &pool_quote_mint, ExecutorError::LegMintMismatch)?;
    require_eq(cpi[7].key, &pool_base_ta, ExecutorError::LegVaultMismatch)?;
    require_eq(cpi[8].key, &pool_quote_ta, ExecutorError::LegVaultMismatch)?;
    require_eq(cpi[11].key, fixed.inter_prog, ExecutorError::LegTokenProgramMismatch)?;
    require_eq(cpi[12].key, fixed.base_prog, ExecutorError::LegTokenProgramMismatch)?;
    require_eq(cpi[13].key, &SYSTEM_PROGRAM, ExecutorError::LegFixedAccountMismatch)?;
    require_eq(cpi[14].key, &ASSOCIATED_TOKEN_PROGRAM, ExecutorError::LegFixedAccountMismatch)?;
    require_eq(cpi[15].key, &PUMP_EVENT_AUTHORITY, ExecutorError::LegFixedAccountMismatch)?;
    require_eq(cpi[16].key, &PUMP_AMM_PROGRAM, ExecutorError::LegFixedAccountMismatch)?;
    let (fee_config_pos, fee_program_pos) = if kind == KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN { (21, 22) } else { (19, 20) };
    require_eq(cpi[fee_config_pos].key, &PUMP_FEE_CONFIG, ExecutorError::LegFixedAccountMismatch)?;
    require_eq(cpi[fee_program_pos].key, &PUMP_FEE_PROGRAM, ExecutorError::FeeProgramMismatch)?;
    Ok(())
}

/// Raydium swap_base_input data: disc ‖ amount_in u64 LE ‖ minimum_amount_out u64 LE (24 bytes) — raydium_cpmm.md §6.
pub fn raydium_swap_base_input_data(amount_in: u64, minimum_amount_out: u64) -> [u8; 24] {
    let mut d = [0u8; 24];
    d[..8].copy_from_slice(&RAYDIUM_SWAP_BASE_INPUT_DISC);
    d[8..16].copy_from_slice(&amount_in.to_le_bytes());
    d[16..24].copy_from_slice(&minimum_amount_out.to_le_bytes());
    d
}

/// PumpSwap buy_exact_quote_in data: disc ‖ spendable_quote_in ‖ min_base_amount_out ‖ track_volume OptionBool = 0x01 (25 bytes) — pumpswap.md §6.
pub fn pump_buy_exact_quote_in_data(spendable_quote_in: u64, min_base_amount_out: u64) -> [u8; 25] {
    let mut d = [0u8; 25];
    d[..8].copy_from_slice(&PUMP_BUY_EXACT_QUOTE_IN_DISC);
    d[8..16].copy_from_slice(&spendable_quote_in.to_le_bytes());
    d[16..24].copy_from_slice(&min_base_amount_out.to_le_bytes());
    d[24] = 0x01;
    d
}

/// PumpSwap sell data: disc ‖ base_amount_in ‖ min_quote_amount_out (24 bytes) — pumpswap.md §6.
pub fn pump_sell_data(base_amount_in: u64, min_quote_amount_out: u64) -> [u8; 24] {
    let mut d = [0u8; 24];
    d[..8].copy_from_slice(&PUMP_SELL_DISC);
    d[8..16].copy_from_slice(&base_amount_in.to_le_bytes());
    d[16..24].copy_from_slice(&min_quote_amount_out.to_le_bytes());
    d
}

/// Builds the CPI instruction for a validated leg. Account metas copy the flags the outer instruction gave each account
/// (the runtime forbids escalating them anyway); the user's signer flag passes through `invoke`.
pub fn build_leg_instruction(kind: u8, program_id: &Pubkey, cpi: &[AccountView], amount: u64, min_out: u64) -> Result<Instruction, ExecutorError> {
    let data: Vec<u8> = match kind {
        KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT => raydium_swap_base_input_data(amount, min_out).to_vec(),
        KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN => pump_buy_exact_quote_in_data(amount, min_out).to_vec(),
        KIND_PUMPSWAP_SELL => pump_sell_data(amount, min_out).to_vec(),
        _ => return Err(ExecutorError::LegKindUnknown),
    };
    let accounts = cpi
        .iter()
        .map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer, is_writable: a.is_writable })
        .collect();
    Ok(Instruction { program_id: *program_id, accounts, data })
}
