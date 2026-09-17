//! Leg validation on the host: account-count rules, allowlist, pool owner/layout, role positions, vault/mint checks,
//! PumpSwap fixed accounts, aliasing detection, CPI data encoding.
mod common;
use arb_executor::constants::*;
use arb_executor::error::ExecutorError;
use arb_executor::legs::*;
use arb_executor::params::*;
use common::*;
use solana_program::pubkey::Pubkey;

struct Fx {
    user: Pubkey,
    base_ta: Pubkey,
    inter_ta: Pubkey,
    base_mint: Pubkey,
    inter_mint: Pubkey,
}
impl Fx {
    fn new() -> Self {
        Fx { user: pk(1), base_ta: pk(2), inter_ta: pk(3), base_mint: pk(4), inter_mint: pk(5) }
    }
    fn keys(&self) -> FixedKeys<'_> {
        FixedKeys { user: &self.user, base_ta: &self.base_ta, inter_ta: &self.inter_ta, base_mint: &self.base_mint, inter_mint: &self.inter_mint, base_prog: &TOKEN_PROGRAM, inter_prog: &TOKEN_2022_PROGRAM }
    }
}

/// A well-formed Raydium leg for `role` where token_0 = base (WSOL) and token_1 = intermediate (Token-2022).
fn raydium_leg(fx: &Fx, role: LegRole) -> (Keys, Vec<u8>) {
    let (amm_config, v0, v1, obs, pool) = (pk(10), pk(11), pk(12), pk(13), pk(14));
    let pool_data = raydium_pool_bytes(&amm_config, &v0, &v1, &fx.base_mint, &fx.inter_mint, &TOKEN_PROGRAM, &TOKEN_2022_PROGRAM, &obs);
    let (in_ta, out_ta, in_v, out_v, in_p, out_p, in_m, out_m) = match role {
        LegRole::A => (fx.base_ta, fx.inter_ta, v0, v1, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, fx.base_mint, fx.inter_mint),
        LegRole::B => (fx.inter_ta, fx.base_ta, v1, v0, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, fx.inter_mint, fx.base_mint),
    };
    let o = pk(0);
    let keys = Keys::new(vec![
        (fx.user, o),
        (RAYDIUM_CPMM_AUTHORITY, RAYDIUM_CPMM_PROGRAM),
        (amm_config, RAYDIUM_CPMM_PROGRAM),
        (pool, RAYDIUM_CPMM_PROGRAM),
        (in_ta, in_p),
        (out_ta, out_p),
        (in_v, in_p),
        (out_v, out_p),
        (in_p, o),
        (out_p, o),
        (in_m, in_p),
        (out_m, out_p),
        (obs, RAYDIUM_CPMM_PROGRAM),
    ]);
    (keys, pool_data)
}

/// A well-formed PumpSwap leg (buy for A / sell for B) with `extra` remaining accounts.
fn pump_leg(fx: &Fx, kind: u8, extra: usize) -> (Keys, Vec<u8>) {
    let (pool, pool_base_ta, pool_quote_ta) = (pk(20), pk(21), pk(22));
    let pool_data = pump_pool_bytes(300, &fx.inter_mint, &fx.base_mint, &pool_base_ta, &pool_quote_ta);
    let o = pk(0);
    let mut v = vec![
        (pool, PUMP_AMM_PROGRAM),
        (fx.user, o),
        (PUMP_GLOBAL_CONFIG, PUMP_AMM_PROGRAM),
        (fx.inter_mint, TOKEN_2022_PROGRAM),
        (fx.base_mint, TOKEN_PROGRAM),
        (fx.inter_ta, TOKEN_2022_PROGRAM),
        (fx.base_ta, TOKEN_PROGRAM),
        (pool_base_ta, TOKEN_2022_PROGRAM),
        (pool_quote_ta, TOKEN_PROGRAM),
        (pk(23), o),
        (pk(24), TOKEN_PROGRAM),
        (TOKEN_2022_PROGRAM, o),
        (TOKEN_PROGRAM, o),
        (SYSTEM_PROGRAM, o),
        (ASSOCIATED_TOKEN_PROGRAM, o),
        (PUMP_EVENT_AUTHORITY, PUMP_AMM_PROGRAM),
        (PUMP_AMM_PROGRAM, o),
        (pk(25), TOKEN_PROGRAM),
        (pk(26), PUMP_AMM_PROGRAM),
    ];
    if kind == KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN {
        v.push((pk(27), PUMP_AMM_PROGRAM));
        v.push((pk(28), PUMP_AMM_PROGRAM));
    }
    v.push((PUMP_FEE_CONFIG, PUMP_FEE_PROGRAM));
    v.push((PUMP_FEE_PROGRAM, o));
    for i in 0..extra {
        v.push((pk(40 + i as u8), o));
    }
    (Keys::new(v), pool_data)
}

#[test]
fn raydium_valid_both_roles() {
    let fx = Fx::new();
    for role in [LegRole::A, LegRole::B] {
        let (k, pool) = raydium_leg(&fx, role);
        assert_eq!(validate_leg(&fx.keys(), role, 0, &k.views(), &pool), Ok(()), "{role:?}");
    }
}

#[test]
fn raydium_reversed_token_order_in_pool() {
    // token_0 = intermediate, token_1 = base: the vault/program pairing must follow the mints, not the fixed slots.
    let fx = Fx::new();
    let (amm_config, v0, v1, obs, pool) = (pk(10), pk(11), pk(12), pk(13), pk(14));
    let pool_data = raydium_pool_bytes(&amm_config, &v0, &v1, &fx.inter_mint, &fx.base_mint, &TOKEN_2022_PROGRAM, &TOKEN_PROGRAM, &obs);
    let o = pk(0);
    // leg A: input = base (= token_1) -> input_vault = v1
    let k = Keys::new(vec![
        (fx.user, o), (RAYDIUM_CPMM_AUTHORITY, o), (amm_config, o), (pool, RAYDIUM_CPMM_PROGRAM), (fx.base_ta, o), (fx.inter_ta, o),
        (v1, o), (v0, o), (TOKEN_PROGRAM, o), (TOKEN_2022_PROGRAM, o), (fx.base_mint, o), (fx.inter_mint, o), (obs, o),
    ]);
    assert_eq!(validate_leg(&fx.keys(), LegRole::A, 0, &k.views(), &pool_data), Ok(()));
    // swapping the vaults must fail
    let k2 = Keys::new(vec![
        (fx.user, o), (RAYDIUM_CPMM_AUTHORITY, o), (amm_config, o), (pool, RAYDIUM_CPMM_PROGRAM), (fx.base_ta, o), (fx.inter_ta, o),
        (v0, o), (v1, o), (TOKEN_PROGRAM, o), (TOKEN_2022_PROGRAM, o), (fx.base_mint, o), (fx.inter_mint, o), (obs, o),
    ]);
    assert_eq!(validate_leg(&fx.keys(), LegRole::A, 0, &k2.views(), &pool_data), Err(ExecutorError::LegVaultMismatch));
}

#[test]
fn raydium_rejections() {
    let fx = Fx::new();
    let (k, pool) = raydium_leg(&fx, LegRole::A);
    let f = fx.keys();
    // count
    assert_eq!(validate_leg(&f, LegRole::A, 0, &k.views()[..12], &pool), Err(ExecutorError::LegAccountCountInvalid));
    let mut more = k.entries.clone();
    more.push((pk(99), pk(0), false, false));
    let km = Keys { entries: more };
    assert_eq!(validate_leg(&f, LegRole::A, 0, &km.views(), &pool), Err(ExecutorError::LegAccountCountInvalid));
    // pool owner
    let mut e = k.entries.clone();
    e[3].1 = PUMP_AMM_PROGRAM;
    assert_eq!(validate_leg(&f, LegRole::A, 0, &Keys { entries: e }.views(), &pool), Err(ExecutorError::PoolOwnerMismatch));
    // pool data: short / bad disc
    assert_eq!(validate_leg(&f, LegRole::A, 0, &k.views(), &pool[..636]), Err(ExecutorError::PoolDataInvalid));
    let mut bad = pool.clone();
    bad[0] ^= 1;
    assert_eq!(validate_leg(&f, LegRole::A, 0, &k.views(), &bad), Err(ExecutorError::PoolDataInvalid));
    // payer
    let mut e = k.entries.clone();
    e[0].0 = pk(77);
    assert_eq!(validate_leg(&f, LegRole::A, 0, &Keys { entries: e }.views(), &pool), Err(ExecutorError::LegUserMismatch));
    // authority / amm_config / observation
    for (i, err) in [(1usize, ExecutorError::LegFixedAccountMismatch), (2, ExecutorError::LegFixedAccountMismatch), (12, ExecutorError::LegFixedAccountMismatch)] {
        let mut e = k.entries.clone();
        e[i].0 = pk(77);
        assert_eq!(validate_leg(&f, LegRole::A, 0, &Keys { entries: e }.views(), &pool), Err(err), "pos {i}");
    }
    // user token accounts in the wrong roles (swapped) -> aliasing (each appears at the other's position)
    let mut e = k.entries.clone();
    e.swap(4, 5);
    assert_eq!(validate_leg(&f, LegRole::A, 0, &Keys { entries: e }.views(), &pool), Err(ExecutorError::Aliasing));
    // foreign token account at the input position
    let mut e = k.entries.clone();
    e[4].0 = pk(77);
    assert_eq!(validate_leg(&f, LegRole::A, 0, &Keys { entries: e }.views(), &pool), Err(ExecutorError::LegUserTokenAccountMismatch));
    // vaults / programs / mints
    for (i, err) in [(6usize, ExecutorError::LegVaultMismatch), (7, ExecutorError::LegVaultMismatch), (8, ExecutorError::LegTokenProgramMismatch), (9, ExecutorError::LegTokenProgramMismatch), (10, ExecutorError::LegMintMismatch), (11, ExecutorError::LegMintMismatch)] {
        let mut e = k.entries.clone();
        e[i].0 = pk(77);
        assert_eq!(validate_leg(&f, LegRole::A, 0, &Keys { entries: e }.views(), &pool), Err(err), "pos {i}");
    }
    // pool whose mints are not ours
    let foreign = raydium_pool_bytes(&pk(10), &pk(11), &pk(12), &pk(60), &pk(61), &TOKEN_PROGRAM, &TOKEN_PROGRAM, &pk(13));
    assert_eq!(validate_leg(&f, LegRole::A, 0, &k.views(), &foreign), Err(ExecutorError::LegMintMismatch));
    // role B with a leg built for role A: input/output positions are swapped -> aliasing
    assert_eq!(validate_leg(&f, LegRole::B, 0, &k.views(), &pool), Err(ExecutorError::Aliasing));
}

#[test]
fn raydium_aliasing_vault_equals_user_token_account() {
    let fx = Fx::new();
    let (k, _pool) = raydium_leg(&fx, LegRole::A);
    let f = fx.keys();
    // pool whose input vault IS the user's base token account
    let pool = raydium_pool_bytes(&pk(10), &fx.base_ta, &pk(12), &fx.base_mint, &fx.inter_mint, &TOKEN_PROGRAM, &TOKEN_2022_PROGRAM, &pk(13));
    let mut e = k.entries.clone();
    e[6].0 = fx.base_ta;
    assert_eq!(validate_leg(&f, LegRole::A, 0, &Keys { entries: e }.views(), &pool), Err(ExecutorError::Aliasing));
    // user intermediate account at the observation position
    let mut e = k.entries.clone();
    e[12].0 = fx.inter_ta;
    assert_eq!(validate_leg(&f, LegRole::A, 0, &Keys { entries: e }.views(), &_pool), Err(ExecutorError::Aliasing));
    // user base account at the payer position
    let mut e = k.entries.clone();
    e[0].0 = fx.base_ta;
    assert_eq!(validate_leg(&f, LegRole::A, 0, &Keys { entries: e }.views(), &_pool), Err(ExecutorError::LegUserMismatch), "payer check runs before aliasing");
}

#[test]
fn pump_valid_counts_and_remaining() {
    let fx = Fx::new();
    let f = fx.keys();
    for extra in 0..=3 {
        let (k, pool) = pump_leg(&fx, KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN, extra);
        assert_eq!(k.entries.len(), 23 + extra);
        assert_eq!(validate_leg(&f, LegRole::A, 1, &k.views(), &pool), Ok(()), "buy extra={extra}");
        let (k, pool) = pump_leg(&fx, KIND_PUMPSWAP_SELL, extra);
        assert_eq!(k.entries.len(), 21 + extra);
        assert_eq!(validate_leg(&f, LegRole::B, 2, &k.views(), &pool), Ok(()), "sell extra={extra}");
    }
    let (k, pool) = pump_leg(&fx, KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN, 4);
    assert_eq!(validate_leg(&f, LegRole::A, 1, &k.views(), &pool), Err(ExecutorError::LegAccountCountInvalid));
    let (k, pool) = pump_leg(&fx, KIND_PUMPSWAP_SELL, 4);
    assert_eq!(validate_leg(&f, LegRole::B, 2, &k.views(), &pool), Err(ExecutorError::LegAccountCountInvalid));
    let (k, pool) = pump_leg(&fx, KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN, 0);
    assert_eq!(validate_leg(&f, LegRole::A, 1, &k.views()[..22], &pool), Err(ExecutorError::LegAccountCountInvalid));
    // shortest documented pool layout (211 bytes) is accepted; 210 is not
    let short = pump_pool_bytes(211, &fx.inter_mint, &fx.base_mint, &pk(21), &pk(22));
    assert_eq!(validate_leg(&f, LegRole::A, 1, &k.views(), &short), Ok(()));
    assert_eq!(validate_leg(&f, LegRole::A, 1, &k.views(), &short[..210]), Err(ExecutorError::PoolDataInvalid));
}

#[test]
fn pump_rejections() {
    let fx = Fx::new();
    let f = fx.keys();
    let (k, pool) = pump_leg(&fx, KIND_PUMPSWAP_BUY_EXACT_QUOTE_IN, 3);
    let cases: Vec<(usize, ExecutorError)> = vec![
        (1, ExecutorError::LegUserMismatch),
        (2, ExecutorError::GlobalConfigMismatch),
        (3, ExecutorError::LegMintMismatch),
        (4, ExecutorError::LegMintMismatch),
        (5, ExecutorError::LegUserTokenAccountMismatch),
        (6, ExecutorError::LegUserTokenAccountMismatch),
        (7, ExecutorError::LegVaultMismatch),
        (8, ExecutorError::LegVaultMismatch),
        (11, ExecutorError::LegTokenProgramMismatch),
        (12, ExecutorError::LegTokenProgramMismatch),
        (13, ExecutorError::LegFixedAccountMismatch),
        (14, ExecutorError::LegFixedAccountMismatch),
        (15, ExecutorError::LegFixedAccountMismatch),
        (16, ExecutorError::LegFixedAccountMismatch),
        (21, ExecutorError::LegFixedAccountMismatch),
        (22, ExecutorError::FeeProgramMismatch),
    ];
    for (i, err) in cases {
        let mut e = k.entries.clone();
        e[i].0 = pk(77);
        assert_eq!(validate_leg(&f, LegRole::A, 1, &Keys { entries: e }.views(), &pool), Err(err), "buy pos {i}");
    }
    // sell: fee_config @19, fee_program @20
    let (ks, pools) = pump_leg(&fx, KIND_PUMPSWAP_SELL, 0);
    for (i, err) in [(19usize, ExecutorError::LegFixedAccountMismatch), (20, ExecutorError::FeeProgramMismatch)] {
        let mut e = ks.entries.clone();
        e[i].0 = pk(77);
        assert_eq!(validate_leg(&f, LegRole::B, 2, &Keys { entries: e }.views(), &pools), Err(err), "sell pos {i}");
    }
    // pool owner / disc
    let mut e = k.entries.clone();
    e[0].1 = RAYDIUM_CPMM_PROGRAM;
    assert_eq!(validate_leg(&f, LegRole::A, 1, &Keys { entries: e }.views(), &pool), Err(ExecutorError::PoolOwnerMismatch));
    let mut bad = pool.clone();
    bad[7] ^= 0xff;
    assert_eq!(validate_leg(&f, LegRole::A, 1, &k.views(), &bad), Err(ExecutorError::PoolDataInvalid));
    // pool whose base mint is not our intermediate (e.g. a different token's canonical pool)
    let other = pump_pool_bytes(300, &pk(60), &fx.base_mint, &pk(21), &pk(22));
    assert_eq!(validate_leg(&f, LegRole::A, 1, &k.views(), &other), Err(ExecutorError::LegMintMismatch));
    // pool whose quote is not WSOL/base
    let other = pump_pool_bytes(300, &fx.inter_mint, &pk(61), &pk(21), &pk(22));
    assert_eq!(validate_leg(&f, LegRole::A, 1, &k.views(), &other), Err(ExecutorError::LegMintMismatch));
    // aliasing: user base account as protocol fee recipient ATA / as remaining account / as pool vault
    for i in [10usize, 17, 23, 25] {
        let mut e = k.entries.clone();
        e[i].0 = fx.base_ta;
        assert_eq!(validate_leg(&f, LegRole::A, 1, &Keys { entries: e }.views(), &pool), Err(ExecutorError::Aliasing), "pos {i}");
        let mut e = k.entries.clone();
        e[i].0 = fx.inter_ta;
        assert_eq!(validate_leg(&f, LegRole::A, 1, &Keys { entries: e }.views(), &pool), Err(ExecutorError::Aliasing), "pos {i}");
    }
    let alias_pool = pump_pool_bytes(300, &fx.inter_mint, &fx.base_mint, &fx.inter_ta, &pk(22));
    let mut e = k.entries.clone();
    e[7].0 = fx.inter_ta;
    assert_eq!(validate_leg(&f, LegRole::A, 1, &Keys { entries: e }.views(), &alias_pool), Err(ExecutorError::Aliasing));
    // swapped user accounts
    let mut e = k.entries.clone();
    e.swap(5, 6);
    assert_eq!(validate_leg(&f, LegRole::A, 1, &Keys { entries: e }.views(), &pool), Err(ExecutorError::Aliasing));
}

#[test]
fn allowlist_and_positions() {
    assert_eq!(expected_program(0), Some(RAYDIUM_CPMM_PROGRAM));
    assert_eq!(expected_program(1), Some(PUMP_AMM_PROGRAM));
    assert_eq!(expected_program(2), Some(PUMP_AMM_PROGRAM));
    assert_eq!(expected_program(3), None);
    assert_eq!(pool_position(0), Some(3));
    assert_eq!(pool_position(1), Some(0));
    assert_eq!(user_position(0), Some(0));
    assert_eq!(user_position(2), Some(1));
    assert_eq!(user_token_positions(0, LegRole::A), Some((4, 5)));
    assert_eq!(user_token_positions(0, LegRole::B), Some((5, 4)));
    assert_eq!(user_token_positions(1, LegRole::A), Some((6, 5)));
    assert_eq!(user_token_positions(2, LegRole::B), Some((6, 5)));
    assert_eq!(check_cpi_count(0, 13), Ok(()));
    assert_eq!(check_cpi_count(0, 14), Err(ExecutorError::LegAccountCountInvalid));
    assert_eq!(check_cpi_count(1, 22), Err(ExecutorError::LegAccountCountInvalid));
    assert_eq!(check_cpi_count(1, 26), Ok(()));
    assert_eq!(check_cpi_count(1, 27), Err(ExecutorError::LegAccountCountInvalid));
    assert_eq!(check_cpi_count(2, 21), Ok(()));
    assert_eq!(check_cpi_count(2, 24), Ok(()));
    assert_eq!(check_cpi_count(2, 25), Err(ExecutorError::LegAccountCountInvalid));
}

#[test]
fn cpi_data_encoding() {
    let r = raydium_swap_base_input_data(0x0102030405060708, 0x1112131415161718);
    assert_eq!(&r[..8], &[0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde]);
    assert_eq!(&r[8..16], &[8, 7, 6, 5, 4, 3, 2, 1]);
    assert_eq!(&r[16..24], &[0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11]);
    let b = pump_buy_exact_quote_in_data(1, 2);
    assert_eq!(b.len(), 25);
    assert_eq!(&b[..8], &[0xc6, 0x2e, 0x15, 0x52, 0xb4, 0xd9, 0xe8, 0x70]);
    assert_eq!(&b[8..16], &1u64.to_le_bytes());
    assert_eq!(&b[16..24], &2u64.to_le_bytes());
    assert_eq!(b[24], 1, "track_volume OptionBool(true)");
    let s = pump_sell_data(3, 4);
    assert_eq!(s.len(), 24);
    assert_eq!(&s[..8], &[0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);
    assert_eq!(&s[8..16], &3u64.to_le_bytes());
    assert_eq!(&s[16..24], &4u64.to_le_bytes());
}

#[test]
fn instruction_metas_copy_flags() {
    let fx = Fx::new();
    let (mut k, _) = raydium_leg(&fx, LegRole::A);
    k.entries[0].2 = true; // user signer
    k.entries[3].3 = true; // pool writable
    let ix = build_leg_instruction(0, &RAYDIUM_CPMM_PROGRAM, &k.views(), 5, 6).unwrap();
    assert_eq!(ix.program_id, RAYDIUM_CPMM_PROGRAM);
    assert_eq!(ix.accounts.len(), 13);
    assert!(ix.accounts[0].is_signer && !ix.accounts[0].is_writable);
    assert!(ix.accounts[3].is_writable && !ix.accounts[3].is_signer);
    assert_eq!(ix.data, raydium_swap_base_input_data(5, 6).to_vec());
    assert_eq!(build_leg_instruction(9, &RAYDIUM_CPMM_PROGRAM, &k.views(), 5, 6).unwrap_err(), ExecutorError::LegKindUnknown);
}
