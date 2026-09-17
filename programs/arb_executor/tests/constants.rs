//! Re-derive every PDA constant from its documented seeds so a typo cannot survive `cargo test`.
use arb_executor::constants::*;
use solana_program::pubkey::Pubkey;

#[test]
fn pump_pdas() {
    let (gc, bump) = Pubkey::find_program_address(&[PUMP_GLOBAL_CONFIG_SEED], &PUMP_AMM_PROGRAM);
    assert_eq!(gc, PUMP_GLOBAL_CONFIG);
    assert_eq!(bump, 255, "pumpswap.md §1");
    let (ea, _) = Pubkey::find_program_address(&[PUMP_EVENT_AUTHORITY_SEED], &PUMP_AMM_PROGRAM);
    assert_eq!(ea, PUMP_EVENT_AUTHORITY);
    let (fc, bump) = Pubkey::find_program_address(&[PUMP_FEE_CONFIG_SEED, PUMP_AMM_PROGRAM.as_ref()], &PUMP_FEE_PROGRAM);
    assert_eq!(fc, PUMP_FEE_CONFIG);
    assert_eq!(bump, 255, "pumpswap.md §1");
}

#[test]
fn raydium_authority_pda() {
    let (a, bump) = Pubkey::find_program_address(&[RAYDIUM_AUTHORITY_SEED], &RAYDIUM_CPMM_PROGRAM);
    assert_eq!(a, RAYDIUM_CPMM_AUTHORITY);
    assert_eq!(bump, 253, "raydium_cpmm.md §1");
}

#[test]
fn program_ids_are_the_documented_base58() {
    assert_eq!(RAYDIUM_CPMM_PROGRAM.to_string(), "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
    assert_eq!(PUMP_AMM_PROGRAM.to_string(), "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
    assert_eq!(PUMP_FEE_PROGRAM.to_string(), "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
    assert_eq!(TOKEN_PROGRAM.to_string(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    assert_eq!(TOKEN_2022_PROGRAM.to_string(), "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    assert_eq!(SYSTEM_PROGRAM, Pubkey::default());
}

#[test]
fn discriminators_match_anchor_convention() {
    // raydium_cpmm.md §0/§6: sha256("global:swap_base_input")[..8]; §2: sha256("account:PoolState")[..8]
    let h = solana_program::hash::hash(b"global:swap_base_input");
    assert_eq!(&h.to_bytes()[..8], &RAYDIUM_SWAP_BASE_INPUT_DISC);
    let h = solana_program::hash::hash(b"account:PoolState");
    assert_eq!(&h.to_bytes()[..8], &RAYDIUM_POOL_DISC);
    // pumpswap.md §2/§6 (IDL values); the Anchor convention reproduces them
    let h = solana_program::hash::hash(b"account:Pool");
    assert_eq!(&h.to_bytes()[..8], &PUMP_POOL_DISC);
    let h = solana_program::hash::hash(b"global:buy_exact_quote_in");
    assert_eq!(&h.to_bytes()[..8], &PUMP_BUY_EXACT_QUOTE_IN_DISC);
    let h = solana_program::hash::hash(b"global:sell");
    assert_eq!(&h.to_bytes()[..8], &PUMP_SELL_DISC);
}
