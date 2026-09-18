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

/// Token X is a Token-2022 mint carrying a 300 bps (3%) transfer fee. Bin step 50, active id
/// -841, so this also exercises a negative active id well away from an array boundary.
const T22_POOL: Pubkey = pubkey!("GzaMLXLCkBn23qjbiMws1erULHXbWpJRAfjKy4C1BrbZ");
const T22_X: Pubkey = pubkey!("6LrDt7nBiHraUuk9PZoUL8Qy9WX6pnSpDz1RkWWRR7hN");

/// Deep pool: sizes here barely move the active bin, so this tests the per-bin arithmetic and
/// the fee with almost no walking. Measured: 1e6 in fills at 113.504 out per unit and 2e11 at
/// 113.486 — two hundredths of a percent of impact across five orders of magnitude.
#[test]
fn dlmm_deep_pool_parity() {
    let test = PoolTest::new(DEEP_POOL)
        .add_swap(WSOL, USDC, 1_000_003)
        .add_swap(WSOL, USDC, 1_000_000_003)
        .add_swap(USDC, WSOL, 10_000_003)
        .add_swap(USDC, WSOL, 10_000_000_007);

    assert_pool_parity::<MeteoraDlmmAmm>(&test, encode_swap);
}

/// The one that matters: these sizes walk across many bins, so the quote is only right if
/// liquidity is picked up bin by bin.
///
/// Measured on this pool, output per unit of input:
///
/// | direction | small size | large size | impact |
/// |---|---|---|---|
/// | X to Y | 112.978 at 1e6 | 106.290 at 1e9 | 6% |
/// | Y to X | 8.789 at 1e6 | 4.598 at 2e11 | 48% |
///
/// A single bin cannot produce a 48% move. The engine also reports `bins_crossed: 128` when a
/// larger size runs past the arrays carried.
#[test]
fn dlmm_wide_bin_pool_crosses_bins() {
    let test = PoolTest::new(WIDE_POOL)
        .add_swap(WSOL, USDC, 1_000_003)
        .add_swap(WSOL, USDC, 1_000_000_003)
        .add_swap(USDC, WSOL, 1_000_003)
        .add_swap(USDC, WSOL, 10_000_000_007)
        .add_swap(USDC, WSOL, 200_000_000_011);

    assert_pool_parity::<MeteoraDlmmAmm>(&test, encode_swap);
}

/// The Token-2022 paths. Swapping X in makes the 3% fee apply to the INPUT, so the pool only
/// receives 97% of what was sent; swapping X out makes it apply to the OUTPUT. A quote that
/// ignores it is wrong by 3%.
#[test]
fn dlmm_token2022_transfer_fee_parity() {
    let test = PoolTest::new(T22_POOL)
        .add_swap(T22_X, WSOL, 1_000_003)
        .add_swap(T22_X, WSOL, 100_000_007)
        .add_swap(WSOL, T22_X, 1_000_003)
        .add_swap(WSOL, T22_X, 100_000_007);

    assert_pool_parity::<MeteoraDlmmAmm>(&test, encode_swap);
}

/// A swap that runs past the bin arrays carried must be refused, not quoted. The engine reports
/// having crossed 128 bins before running out; quoting the partial fill would produce a number
/// no transaction can reproduce.
#[test]
fn dlmm_refuses_swaps_beyond_the_carried_bin_arrays() {
    use jupiter_amm_interface::{
        AccountProvider, Amm, AmmContext, ClockRef, KeyedAccount, QuoteParams, SwapMode,
    };
    use jupiter_amm_test_kit::PoolSnapshot;
    use solana_account::Account;

    struct P<'a>(&'a PoolSnapshot);
    impl AccountProvider for P<'_> {
        fn get(&self, pubkey: &Pubkey) -> Option<impl solana_account::ReadableAccount + use<'_>> {
            self.0.get(pubkey).cloned() as Option<Account>
        }
    }

    let dir = format!("tests/fixtures/accounts/{WIDE_POOL}");
    let snapshot = PoolSnapshot::load_dir(std::path::Path::new(&dir)).expect("fixtures");
    let ctx = AmmContext {
        clock_ref: ClockRef::from(snapshot.clock().unwrap_or_default()),
    };
    let keyed = KeyedAccount {
        key: WIDE_POOL,
        account: snapshot.get(&WIDE_POOL).unwrap().clone(),
        params: None,
    };
    let mut amm = MeteoraDlmmAmm::from_keyed_account(&keyed, &ctx).expect("decode");
    let p = P(&snapshot);
    amm.update(&p).expect("update");
    amm.update(&p).expect("update");

    let q = |amount: u64| {
        amm.quote(&QuoteParams {
            amount,
            input_mint: WSOL,
            output_mint: USDC,
            swap_mode: SwapMode::ExactIn,
            fee_mode: Default::default(),
        })
    };
    assert!(q(1_000_000_003).is_ok(), "a size the pool can serve must quote");
    assert!(
        q(10_000_000_007).is_err(),
        "a size that runs past the carried bin arrays must be refused, not quoted"
    );
}

/// `swap2` instruction data: `sha256("global:swap2")[..8]`, then `amount_in`, `min_amount_out`
/// and `remaining_accounts_info`.
///
/// **That last argument is NOT an `Option`, whatever the SDK's IDL says.** Reading the bytes of
/// real `swap2` instructions on chain settles it: the tail is `03000000 0000 0100 0400`, which is
/// a bare `Vec` of three empty slices — `TransferHookX`, `TransferHookY`, `TransferHookReferral`,
/// each of length zero. Prefixing an Option tag is what made every earlier attempt fail with
/// `InstructionDidNotDeserialize`. This reproduces what live clients send.
///
/// `min_amount_out` is 0: bounding it would let the program, not the test, decide the output.
fn encode_swap(swap: &jupiter_amm_interface::Swap, in_amount: u64) -> Vec<u8> {
    let _bin_array_count = match swap {
        jupiter_amm_interface::Swap::Placeholder { data: Some(d) } if !d.is_empty() => d[0],
        other => panic!("unexpected swap variant: {other:?}"),
    };
    let mut data = Vec::with_capacity(34);
    data.extend_from_slice(&[0x41, 0x4b, 0x3f, 0x4c, 0xeb, 0x5b, 0x5b, 0x88]);
    data.extend_from_slice(&in_amount.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&3u32.to_le_bytes()); // three slices, no Option tag
    data.extend_from_slice(&[0, 0]); // TransferHookX, length 0
    data.extend_from_slice(&[1, 0]); // TransferHookY, length 0
    data.extend_from_slice(&[4, 0]); // TransferHookReferral, length 0
    let _ = _bin_array_count;
    data
}
