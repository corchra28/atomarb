//! Shared helpers for host tests (no runtime, no AccountInfo): fabricate pool bytes and account views.
#![allow(dead_code)]
use arb_executor::constants::*;
use arb_executor::legs::AccountView;
use solana_program::pubkey::Pubkey;

pub fn pk(seed: u8) -> Pubkey {
    Pubkey::new_from_array([seed; 32])
}

/// Raydium PoolState bytes (637) with the documented offsets filled (raydium_cpmm.md §2).
pub fn raydium_pool_bytes(amm_config: &Pubkey, v0: &Pubkey, v1: &Pubkey, m0: &Pubkey, m1: &Pubkey, p0: &Pubkey, p1: &Pubkey, obs: &Pubkey) -> Vec<u8> {
    let mut d = vec![0u8; RAYDIUM_POOL_LEN];
    d[..8].copy_from_slice(&RAYDIUM_POOL_DISC);
    d[RAYDIUM_OFF_AMM_CONFIG..RAYDIUM_OFF_AMM_CONFIG + 32].copy_from_slice(amm_config.as_ref());
    d[RAYDIUM_OFF_TOKEN_0_VAULT..RAYDIUM_OFF_TOKEN_0_VAULT + 32].copy_from_slice(v0.as_ref());
    d[RAYDIUM_OFF_TOKEN_1_VAULT..RAYDIUM_OFF_TOKEN_1_VAULT + 32].copy_from_slice(v1.as_ref());
    d[RAYDIUM_OFF_TOKEN_0_MINT..RAYDIUM_OFF_TOKEN_0_MINT + 32].copy_from_slice(m0.as_ref());
    d[RAYDIUM_OFF_TOKEN_1_MINT..RAYDIUM_OFF_TOKEN_1_MINT + 32].copy_from_slice(m1.as_ref());
    d[RAYDIUM_OFF_TOKEN_0_PROGRAM..RAYDIUM_OFF_TOKEN_0_PROGRAM + 32].copy_from_slice(p0.as_ref());
    d[RAYDIUM_OFF_TOKEN_1_PROGRAM..RAYDIUM_OFF_TOKEN_1_PROGRAM + 32].copy_from_slice(p1.as_ref());
    d[RAYDIUM_OFF_OBSERVATION_KEY..RAYDIUM_OFF_OBSERVATION_KEY + 32].copy_from_slice(obs.as_ref());
    d
}

/// PumpSwap Pool bytes (`len`, >= 211) with the documented offsets filled (pumpswap.md §2).
pub fn pump_pool_bytes(len: usize, base_mint: &Pubkey, quote_mint: &Pubkey, pool_base_ta: &Pubkey, pool_quote_ta: &Pubkey) -> Vec<u8> {
    let mut d = vec![0u8; len];
    d[..8].copy_from_slice(&PUMP_POOL_DISC);
    d[PUMP_OFF_BASE_MINT..PUMP_OFF_BASE_MINT + 32].copy_from_slice(base_mint.as_ref());
    d[PUMP_OFF_QUOTE_MINT..PUMP_OFF_QUOTE_MINT + 32].copy_from_slice(quote_mint.as_ref());
    d[PUMP_OFF_POOL_BASE_TOKEN_ACCOUNT..PUMP_OFF_POOL_BASE_TOKEN_ACCOUNT + 32].copy_from_slice(pool_base_ta.as_ref());
    d[PUMP_OFF_POOL_QUOTE_TOKEN_ACCOUNT..PUMP_OFF_POOL_QUOTE_TOKEN_ACCOUNT + 32].copy_from_slice(pool_quote_ta.as_ref());
    d
}

/// Owned storage for (key, owner, signer, writable) from which `AccountView`s are borrowed.
pub struct Keys {
    pub entries: Vec<(Pubkey, Pubkey, bool, bool)>,
}
impl Keys {
    pub fn new(entries: Vec<(Pubkey, Pubkey)>) -> Self {
        Keys { entries: entries.into_iter().map(|(k, o)| (k, o, false, false)).collect() }
    }
    pub fn views(&self) -> Vec<AccountView<'_>> {
        self.entries.iter().map(|(k, o, s, w)| AccountView { key: k, owner: o, is_signer: *s, is_writable: *w }).collect()
    }
}

/// Token account bytes (165) — token2022.md §2.2.
pub fn token_account_bytes(mint: &Pubkey, owner: &Pubkey, amount: u64, state: u8) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = state;
    d
}
