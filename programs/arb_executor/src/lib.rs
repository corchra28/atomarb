//! arb_executor — atomarb research executor (native Rust, no Anchor).
//!
//! Instruction 0 `ExecuteCircuit`: two CPIs (leg A: base -> intermediate, leg B: intermediate -> base) into
//! Raydium CPMM `swap_base_input` and/or PumpSwap `buy_exact_quote_in` / `sell`, with leg B sized from the
//! realised leg-A output and an on-chain profit guard. ABI: docs/EXECUTOR_ABI.md. Error codes: src/error.rs.
//!
//! This project is read-only research: the program is only ever loaded into a local LiteSVM; it is never deployed.
pub mod constants;
pub mod error;
pub mod guard;
pub mod legs;
pub mod params;
pub mod token;

use solana_program::account_info::AccountInfo;
use solana_program::entrypoint::ProgramResult;
use solana_program::msg;
use solana_program::program::invoke;
use solana_program::pubkey::Pubkey;

use crate::constants::{TOKEN_2022_PROGRAM, TOKEN_PROGRAM};
use crate::error::ExecutorError;
use crate::legs::{build_leg_instruction, expected_program, pool_position, validate_leg, AccountView, FixedKeys};
use crate::params::{check_account_total, check_kind_for_role, parse_execute_circuit, LegRole, FIXED_ACCOUNTS};
use crate::token::{parse_token_account, read_amount};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let p = parse_execute_circuit(data)?;
    check_account_total(&p, accounts.len())?;

    let user = &accounts[0];
    let base_ta = &accounts[1];
    let inter_ta = &accounts[2];
    let base_mint = &accounts[3];
    let inter_mint = &accounts[4];
    let base_prog = &accounts[5];
    let inter_prog = &accounts[6];

    if !user.is_signer {
        return Err(ExecutorError::UserNotSigner.into());
    }
    validate_fixed(user, base_ta, base_mint, base_prog)?;
    validate_fixed(user, inter_ta, inter_mint, inter_prog)?;
    if base_mint.key == inter_mint.key {
        return Err(ExecutorError::SameMint.into());
    }
    if base_ta.key == inter_ta.key {
        return Err(ExecutorError::Aliasing.into());
    }
    let fixed = FixedKeys {
        user: user.key,
        base_ta: base_ta.key,
        inter_ta: inter_ta.key,
        base_mint: base_mint.key,
        inter_mint: inter_mint.key,
        base_prog: base_prog.key,
        inter_prog: inter_prog.key,
    };

    let base0 = amount_of(base_ta)?;
    let inter0 = amount_of(inter_ta)?;
    guard::check_amount_in(p.amount_in, base0)?;

    let a_end = FIXED_ACCOUNTS + p.leg_a_account_count as usize;
    let b_end = a_end + p.leg_b_account_count as usize;
    let seg_a = &accounts[FIXED_ACCOUNTS..a_end];
    let seg_b = &accounts[a_end..b_end];

    // Validate BOTH legs before invoking anything, so a malformed leg B never leaves leg A executed on its own
    // (the transaction would still revert, but this keeps the failure cheap and the error code meaningful).
    validate_segment(&fixed, LegRole::A, p.leg_a_kind, seg_a)?;
    validate_segment(&fixed, LegRole::B, p.leg_b_kind, seg_b)?;

    msg!("arb_executor leg A kind={} amount_in={} min_out={}", p.leg_a_kind, p.amount_in, p.leg_a_min_out);
    invoke_segment(p.leg_a_kind, seg_a, p.amount_in, p.leg_a_min_out)?;

    let inter1 = amount_of(inter_ta)?;
    let delta = guard::leg_a_delta(inter0, inter1)?;

    msg!("arb_executor leg B kind={} amount_in={} min_out={}", p.leg_b_kind, delta, p.leg_b_min_out);
    invoke_segment(p.leg_b_kind, seg_b, delta, p.leg_b_min_out)?;

    let base1 = amount_of(base_ta)?;
    let inter2 = amount_of(inter_ta)?;
    guard::check_no_leftover(inter0, inter2)?;
    let profit = guard::check_profit(base0, base1, p.min_profit)?;
    msg!("arb_executor ok base0={} base1={} profit={} inter_delta={} min_profit={}", base0, base1, profit, delta, p.min_profit);
    Ok(())
}

/// accounts[1]/[2] must be initialized token accounts owned (program) by accounts[5]/[6] ∈ {Token, Token-2022},
/// with owner field == user and mint field == accounts[3]/[4]; the mint account's owner program must be the same token program.
fn validate_fixed(user: &AccountInfo, ta: &AccountInfo, mint: &AccountInfo, prog: &AccountInfo) -> Result<(), ExecutorError> {
    if *prog.key != TOKEN_PROGRAM && *prog.key != TOKEN_2022_PROGRAM {
        return Err(ExecutorError::TokenProgramNotAllowed);
    }
    if ta.owner != prog.key {
        return Err(ExecutorError::TokenAccountProgramMismatch);
    }
    if mint.owner != prog.key {
        return Err(ExecutorError::MintProgramMismatch);
    }
    let data = ta.try_borrow_data().map_err(|_| ExecutorError::TokenAccountDataInvalid)?;
    let v = parse_token_account(&data)?;
    if v.owner != *user.key {
        return Err(ExecutorError::TokenAccountOwnerMismatch);
    }
    if v.mint != *mint.key {
        return Err(ExecutorError::TokenAccountMintMismatch);
    }
    Ok(())
}

fn amount_of(ta: &AccountInfo) -> Result<u64, ExecutorError> {
    let data = ta.try_borrow_data().map_err(|_| ExecutorError::TokenAccountDataInvalid)?;
    read_amount(&data)
}

fn views<'b>(cpi: &'b [AccountInfo<'_>]) -> Vec<AccountView<'b>> {
    cpi.iter().map(|a| AccountView { key: a.key, owner: a.owner, is_signer: a.is_signer, is_writable: a.is_writable }).collect()
}

/// segment = [program_id, cpi accounts...]
fn validate_segment(fixed: &FixedKeys, role: LegRole, kind: u8, segment: &[AccountInfo]) -> Result<(), ExecutorError> {
    check_kind_for_role(kind, role)?;
    if segment.len() < 2 {
        return Err(ExecutorError::LegAccountCountInvalid);
    }
    let program = &segment[0];
    let cpi = &segment[1..];
    let expected = expected_program(kind).ok_or(ExecutorError::LegKindUnknown)?;
    if *program.key != expected {
        return Err(ExecutorError::LegProgramNotAllowlisted);
    }
    let pool_pos = pool_position(kind).ok_or(ExecutorError::LegKindUnknown)?;
    if pool_pos >= cpi.len() {
        return Err(ExecutorError::LegAccountCountInvalid);
    }
    let v = views(cpi);
    let pool_data = cpi[pool_pos].try_borrow_data().map_err(|_| ExecutorError::PoolDataInvalid)?;
    validate_leg(fixed, role, kind, &v, &pool_data)
}

fn invoke_segment(kind: u8, segment: &[AccountInfo], amount: u64, min_out: u64) -> ProgramResult {
    let program = &segment[0];
    let cpi = &segment[1..];
    let v = views(cpi);
    let ix = build_leg_instruction(kind, program.key, &v, amount, min_out)?;
    invoke(&ix, segment)
}
