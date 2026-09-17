//! Mainnet program ids and fixed addresses. Every value is cited to a verified section of docs/sources/*.md;
//! the PDAs are re-derived in host unit tests (tests/constants.rs) so a typo cannot survive `cargo test`.
use solana_program::pubkey;
use solana_program::pubkey::Pubkey;

/// Raydium CPMM mainnet program — docs/sources/raydium_cpmm.md §1 (lib.rs declare_id!).
pub const RAYDIUM_CPMM_PROGRAM: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
/// Raydium CPMM authority PDA, seed b"vault_and_lp_mint_auth_seed", bump 253 — raydium_cpmm.md §1.
pub const RAYDIUM_CPMM_AUTHORITY: Pubkey = pubkey!("GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL");
pub const RAYDIUM_AUTHORITY_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";

/// PumpSwap AMM mainnet program — docs/sources/pumpswap.md §1.
pub const PUMP_AMM_PROGRAM: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/// pump fee program — pumpswap.md §1.
pub const PUMP_FEE_PROGRAM: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
/// GlobalConfig PDA seeds ["global_config"] under pump_amm, bump 255 — pumpswap.md §1.
pub const PUMP_GLOBAL_CONFIG: Pubkey = pubkey!("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
pub const PUMP_GLOBAL_CONFIG_SEED: &[u8] = b"global_config";
/// event_authority PDA seeds ["__event_authority"] under pump_amm — pumpswap.md §1.
pub const PUMP_EVENT_AUTHORITY: Pubkey = pubkey!("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
pub const PUMP_EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";
/// FeeConfig PDA seeds ["fee_config", pump_amm program id] under the FEE program, bump 255 — pumpswap.md §1.
pub const PUMP_FEE_CONFIG: Pubkey = pubkey!("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
pub const PUMP_FEE_CONFIG_SEED: &[u8] = b"fee_config";

/// SPL Token / Token-2022 / ATA / System — docs/sources/token2022.md §1.
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM: Pubkey = pubkey!("11111111111111111111111111111111");

/// Raydium `swap_base_input` discriminator = sha256("global:swap_base_input")[..8] — raydium_cpmm.md §6.
pub const RAYDIUM_SWAP_BASE_INPUT_DISC: [u8; 8] = [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];
/// PumpSwap `buy_exact_quote_in` discriminator — pumpswap.md §6.
pub const PUMP_BUY_EXACT_QUOTE_IN_DISC: [u8; 8] = [0xc6, 0x2e, 0x15, 0x52, 0xb4, 0xd9, 0xe8, 0x70];
/// PumpSwap `sell` discriminator — pumpswap.md §6.
pub const PUMP_SELL_DISC: [u8; 8] = [0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad];

/// Raydium PoolState (raydium_cpmm.md §2): zero-copy packed, LEN 637, disc sha256("account:PoolState")[..8].
pub const RAYDIUM_POOL_DISC: [u8; 8] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
pub const RAYDIUM_POOL_LEN: usize = 637;
pub const RAYDIUM_OFF_AMM_CONFIG: usize = 8;
pub const RAYDIUM_OFF_TOKEN_0_VAULT: usize = 72;
pub const RAYDIUM_OFF_TOKEN_1_VAULT: usize = 104;
pub const RAYDIUM_OFF_TOKEN_0_MINT: usize = 168;
pub const RAYDIUM_OFF_TOKEN_1_MINT: usize = 200;
pub const RAYDIUM_OFF_TOKEN_0_PROGRAM: usize = 232;
pub const RAYDIUM_OFF_TOKEN_1_PROGRAM: usize = 264;
pub const RAYDIUM_OFF_OBSERVATION_KEY: usize = 296;

/// PumpSwap Pool (pumpswap.md §2): Anchor account, disc f19a6d0411b16dbc; smallest documented historical length 211
/// (base_mint@43, quote_mint@75, pool_base_token_account@139, pool_quote_token_account@171 all lie within 211 bytes).
pub const PUMP_POOL_DISC: [u8; 8] = [0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc];
pub const PUMP_POOL_MIN_LEN: usize = 211;
pub const PUMP_OFF_BASE_MINT: usize = 43;
pub const PUMP_OFF_QUOTE_MINT: usize = 75;
pub const PUMP_OFF_POOL_BASE_TOKEN_ACCOUNT: usize = 139;
pub const PUMP_OFF_POOL_QUOTE_TOKEN_ACCOUNT: usize = 171;

/// CPI account counts (excluding the leg's program id account).
/// Raydium `Swap`: exactly 13 accounts, no remaining accounts — raydium_cpmm.md §6.
pub const RAYDIUM_SWAP_ACCOUNTS: usize = 13;
/// PumpSwap buy/buy_exact_quote_in: 23 named + 0..3 remaining (cashback ATA, pool-v2, buyback recipient, buyback ATA; observed 26) — pumpswap.md §6.
pub const PUMP_BUY_NAMED_ACCOUNTS: usize = 23;
pub const PUMP_BUY_MAX_ACCOUNTS: usize = 26;
/// PumpSwap sell: 21 named + 0..3 remaining (observed 24) — pumpswap.md §6.
pub const PUMP_SELL_NAMED_ACCOUNTS: usize = 21;
pub const PUMP_SELL_MAX_ACCOUNTS: usize = 24;

/// So11111111111111111111111111111111111111112 — the base asset every circuit of this engine is denominated in
/// (docs/sources/token2022.md §1). The guard certifies profit in accounts[3]; requiring WSOL keeps that meaningful.
pub const WSOL_MINT: Pubkey = solana_program::pubkey!("So11111111111111111111111111111111111111112");
