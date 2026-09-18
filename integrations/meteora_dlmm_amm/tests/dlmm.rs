//! Parity suite: the Meteora DLMM `Amm` verified against the real mainnet program.
//!
//!   cargo test -p meteora-dlmm-amm
//!
//! To refresh fixtures from mainnet: `REFRESH=1 RPC=<url> cargo test -p meteora-dlmm-amm`.

use jupiter_amm_test_kit::{PoolTest, assert_pool_parity};
use meteora_dlmm_amm::MeteoraDlmmAmm;
use solana_pubkey::{Pubkey, pubkey};

const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// Deepest WSOL/USDC DLMM pool found: bin step 10, active id -2175, ~7,600 WSOL in reserve.
const DEEP_POOL: Pubkey = pubkey!("BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y");
/// Bin step 50 — five times wider bins, so the price walks fewer of them per unit of size.
const WIDE_POOL: Pubkey = pubkey!("5BoHD7DAHsGCA9D8eUkkZTgWTrnpad6G18MnTq3cUS86");

#[test]
fn dlmm_deep_pool_parity() {
    let test = PoolTest::new(DEEP_POOL)
        .add_swap(WSOL, USDC, 100_000_007)
        .add_swap(USDC, WSOL, 10_000_003);

    assert_pool_parity::<MeteoraDlmmAmm>(&test, encode_swap);
}

#[test]
fn dlmm_wide_bin_pool_parity() {
    let test = PoolTest::new(WIDE_POOL)
        .add_swap(WSOL, USDC, 100_000_007)
        .add_swap(USDC, WSOL, 10_000_003);

    assert_pool_parity::<MeteoraDlmmAmm>(&test, encode_swap);
}

/// `swap` instruction data: `sha256("global:swap")[..8]`, then `amount_in` and `min_amount_out`.
///
/// `min_amount_out` is 0: bounding it would let the program, not the test, decide the output.
///
/// The bin arrays ride as trailing accounts; the `Swap::Placeholder` byte carries how many, which
/// this encoder does not need but `get_swap_and_account_metas` uses to size the account list.
fn encode_swap(swap: &jupiter_amm_interface::Swap, in_amount: u64) -> Vec<u8> {
    let _bin_array_count = match swap {
        jupiter_amm_interface::Swap::Placeholder { data: Some(d) } if !d.is_empty() => d[0],
        other => panic!("unexpected swap variant: {other:?}"),
    };
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&[0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]);
    data.extend_from_slice(&in_amount.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    let _ = _bin_array_count;
    data
}
