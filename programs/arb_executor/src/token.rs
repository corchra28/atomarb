//! Minimal SPL Token / Token-2022 token-account reader.
//! Base layout is identical for both programs (docs/sources/token2022.md §2 / §2.2):
//! mint @0 (32), owner @32 (32), amount @64 (u64 LE), state @108 (u8: 0 Uninitialized, 1 Initialized, 2 Frozen), LEN 165.
//! Token-2022 accounts may be longer (TLV extensions after byte 165); the base fields keep their offsets (§3).
use crate::error::ExecutorError;
use solana_program::pubkey::Pubkey;

pub const TOKEN_ACCOUNT_LEN: usize = 165;
pub const OFF_MINT: usize = 0;
pub const OFF_OWNER: usize = 32;
pub const OFF_AMOUNT: usize = 64;
pub const OFF_STATE: usize = 108;
pub const STATE_INITIALIZED: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenAccountView {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub state: u8,
}

#[inline]
pub fn pubkey_at(data: &[u8], off: usize) -> Pubkey {
    let mut b = [0u8; 32];
    b.copy_from_slice(&data[off..off + 32]);
    Pubkey::new_from_array(b)
}

#[inline]
pub fn u64_at(data: &[u8], off: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[off..off + 8]);
    u64::from_le_bytes(b)
}

/// Parses the base fields. Does NOT check the owner program (the caller compares `AccountInfo.owner` against accounts[5]/[6]).
pub fn parse_token_account(data: &[u8]) -> Result<TokenAccountView, ExecutorError> {
    if data.len() < TOKEN_ACCOUNT_LEN {
        return Err(ExecutorError::TokenAccountDataInvalid);
    }
    let state = data[OFF_STATE];
    if state != STATE_INITIALIZED {
        return Err(ExecutorError::TokenAccountNotInitialized);
    }
    Ok(TokenAccountView { mint: pubkey_at(data, OFF_MINT), owner: pubkey_at(data, OFF_OWNER), amount: u64_at(data, OFF_AMOUNT), state })
}

/// Reads only the amount (used after each CPI). Length is re-checked because a CPI could in theory reallocate.
pub fn read_amount(data: &[u8]) -> Result<u64, ExecutorError> {
    if data.len() < TOKEN_ACCOUNT_LEN {
        return Err(ExecutorError::TokenAccountDataInvalid);
    }
    Ok(u64_at(data, OFF_AMOUNT))
}
