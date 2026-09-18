//! Parity suite: the Orca Whirlpool `Amm` verified against the real mainnet program.
//!
//!   cargo test -p whirlpool-amm
//!
//! To refresh fixtures from mainnet: `REFRESH=1 RPC=<url> cargo test -p whirlpool-amm`.
//!
//! Two pools, chosen to separate the two things that can be wrong in a concentrated-liquidity
//! quote:
//!
//! - `Czfq3xZ…` — SOL/USDC, tick spacing 4, very deep. Small swaps stay inside one tick range,
//!   so this tests the curve arithmetic with no tick crossing.
//! - `HJPjoWU…` — SOL/USDC, tick spacing 64, four orders of magnitude less liquidity. Large
//!   swaps here must cross tick boundaries, which is the part a constant-product intuition gets
//!   wrong and the reason this adapter exists.

use jupiter_amm_test_kit::{PoolTest, assert_pool_parity};
use solana_pubkey::{Pubkey, pubkey};
use whirlpool_amm::WhirlpoolAmm;

const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// Deep pool, tick spacing 4, fee 0.04%.
const DEEP_POOL: Pubkey = pubkey!("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");
/// Thin pool, tick spacing 64, fee 0.3% — liquidity is ~3000x smaller.
const THIN_POOL: Pubkey = pubkey!("HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ");

#[test]
fn whirlpool_deep_pool_parity() {
    let test = PoolTest::new(DEEP_POOL)
        .add_swap(WSOL, USDC, 100_000_001) // ~0.1 SOL
        .add_swap(WSOL, USDC, 1_000_000_007) // ~1 SOL
        .add_swap(USDC, WSOL, 10_000_003) // ~10 USDC
        .add_swap(USDC, WSOL, 500_000_009); // ~500 USDC

    assert_pool_parity::<WhirlpoolAmm>(&test, encode_swap);
}

/// The one that matters. On a pool this thin these sizes move the price past tick boundaries, so
/// the quote is only right if liquidity is updated on every crossing.
#[test]
fn whirlpool_thin_pool_crosses_ticks() {
    let test = PoolTest::new(THIN_POOL)
        // Measured price impact on this pool: 0.1 SOL fills at 113.3 USDC/SOL, 200 SOL at
        // 90.1 — a 20% move. A single tick range cannot produce that, so these sizes
        // demonstrably cross tick boundaries.
        .add_swap(WSOL, USDC, 20_000_000_003) // ~20 SOL
        .add_swap(WSOL, USDC, 200_000_000_011) // ~200 SOL
        .add_swap(USDC, WSOL, 2_000_000_007) // ~2,000 USDC
        .add_swap(USDC, WSOL, 5_000_000_007); // ~5,000 USDC, near the 3-array limit

    assert_pool_parity::<WhirlpoolAmm>(&test, encode_swap);
}

/// `swap_v2` instruction data: `sha256("global:swap_v2")[..8]`, then
/// `amount`, `other_amount_threshold`, `sqrt_price_limit`, `amount_specified_is_input`, `a_to_b`,
/// and a `None` for `remaining_accounts_info`.
///
/// `other_amount_threshold` is 0 and `sqrt_price_limit` is `NO_EXPLICIT_SQRT_PRICE_LIMIT`:
/// bounding either would let the program, rather than the test, decide the output.
///
/// The direction comes from the `Swap::Placeholder` byte the `Amm` returned, which is the only
/// decision the encoder cannot re-derive.
fn encode_swap(swap: &jupiter_amm_interface::Swap, in_amount: u64) -> Vec<u8> {
    let a_to_b = match swap {
        jupiter_amm_interface::Swap::Placeholder { data: Some(d) } if !d.is_empty() => d[0] != 0,
        other => panic!("unexpected swap variant: {other:?}"),
    };
    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1 + 1 + 1);
    data.extend_from_slice(&[0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);
    data.extend_from_slice(&in_amount.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // other_amount_threshold
    data.extend_from_slice(&0u128.to_le_bytes()); // NO_EXPLICIT_SQRT_PRICE_LIMIT
    data.push(1); // amount_specified_is_input
    data.push(a_to_b as u8);
    data.push(0); // remaining_accounts_info: None
    data
}
