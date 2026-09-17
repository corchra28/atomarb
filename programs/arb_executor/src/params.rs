//! Instruction data layout (little-endian, exactly 45 bytes) — docs/EXECUTOR_ABI.md "Instruction data".
//! [0]      tag u8            = 0 (ExecuteCircuit)
//! [1..9]   amount_in u64
//! [9..17]  min_profit u64
//! [17..25] leg_a_min_out u64
//! [25..33] leg_b_min_out u64
//! [33]     leg_a_kind u8
//! [34]     leg_a_account_count u8   (includes the leg's program id account)
//! [35]     leg_b_kind u8
//! [36]     leg_b_account_count u8
//! [37..45] max_lamports_spend u64  (native lamports the user may lose inside this instruction: rent for accounts the DEXes create,
//!                                   e.g. PumpSwap's user_volume_accumulator. The transaction fee itself is charged outside the instruction.)
use crate::error::ExecutorError;

pub const TAG_EXECUTE_CIRCUIT: u8 = 0;
pub const EXECUTE_CIRCUIT_DATA_LEN: usize = 45;

pub const KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT: u8 = 0;
pub const KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN: u8 = 1;
pub const KIND_PUMPSWAP_SELL: u8 = 2;

/// Number of fixed accounts before the leg segments.
pub const FIXED_ACCOUNTS: usize = 7;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExecuteCircuitParams {
    pub amount_in: u64,
    pub min_profit: u64,
    pub leg_a_min_out: u64,
    pub leg_b_min_out: u64,
    pub leg_a_kind: u8,
    pub leg_a_account_count: u8,
    pub leg_b_kind: u8,
    pub leg_b_account_count: u8,
    pub max_lamports_spend: u64,
}

#[inline]
fn u64_at(data: &[u8], off: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[off..off + 8]);
    u64::from_le_bytes(b)
}

/// Parses instruction data. Rejects empty data, unknown tags and any length other than 45.
pub fn parse_execute_circuit(data: &[u8]) -> Result<ExecuteCircuitParams, ExecutorError> {
    if data.is_empty() {
        return Err(ExecutorError::InvalidDataLength);
    }
    if data[0] != TAG_EXECUTE_CIRCUIT {
        return Err(ExecutorError::InvalidTag);
    }
    if data.len() != EXECUTE_CIRCUIT_DATA_LEN {
        return Err(ExecutorError::InvalidDataLength);
    }
    Ok(ExecuteCircuitParams {
        amount_in: u64_at(data, 1),
        min_profit: u64_at(data, 9),
        leg_a_min_out: u64_at(data, 17),
        leg_b_min_out: u64_at(data, 25),
        leg_a_kind: data[33],
        leg_a_account_count: data[34],
        leg_b_kind: data[35],
        leg_b_account_count: data[36],
        max_lamports_spend: u64_at(data, 37),
    })
}

/// Total number of accounts the instruction must carry for these params (checked arithmetic; counts are u8 so it cannot overflow usize).
pub fn expected_account_total(p: &ExecuteCircuitParams) -> usize {
    FIXED_ACCOUNTS + p.leg_a_account_count as usize + p.leg_b_account_count as usize
}

/// Checks `accounts_len` against the params: at least the 7 fixed accounts, and exactly 7 + a + b in total.
pub fn check_account_total(p: &ExecuteCircuitParams, accounts_len: usize) -> Result<(), ExecutorError> {
    if accounts_len < FIXED_ACCOUNTS {
        return Err(ExecutorError::NotEnoughAccounts);
    }
    if accounts_len != expected_account_total(p) {
        return Err(ExecutorError::AccountCountMismatch);
    }
    Ok(())
}

/// Leg position: A = base -> intermediate, B = intermediate -> base.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegRole {
    A,
    B,
}

/// kind 0 may appear in either leg; kind 1 (buy: quote WSOL -> base token) only in leg A; kind 2 (sell) only in leg B.
pub fn check_kind_for_role(kind: u8, role: LegRole) -> Result<(), ExecutorError> {
    match kind {
        KIND_RAYDIUM_CPMM_SWAP_BASE_INPUT => Ok(()),
        KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN => {
            if role == LegRole::A { Ok(()) } else { Err(ExecutorError::LegKindInvalidForPosition) }
        }
        KIND_PUMPSWAP_SELL => {
            if role == LegRole::B { Ok(()) } else { Err(ExecutorError::LegKindInvalidForPosition) }
        }
        _ => Err(ExecutorError::LegKindUnknown),
    }
}
