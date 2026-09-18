//! Parity suite: the Raydium CPMM `Amm` verified against the real mainnet program.
//!
//! The test-kit snapshots the pool's accounts, runs `Amm::quote()`, then executes the program's
//! native `swap_base_input` in LiteSVM and asserts the realized token delta equals the quote.
//!
//!   cargo test -p raydium-cpmm-amm
//!
//! To refresh fixtures from mainnet: `REFRESH=1 RPC=<url> cargo test -p raydium-cpmm-amm`.
//!
//! Fixture pool `Q2sPHPd…` is a WSOL pair on the mainnet CPMM deployment. It is deliberately
//! chosen because its vaults carry **non-zero accrued protocol and fund fees**, so the quote is
//! only correct if `vault_amount_without_fee` is applied. An implementation that reads the raw
//! vault balances passes on a fresh pool and fails here.

use jupiter_amm_test_kit::{PoolTest, assert_pool_parity};
use raydium_cpmm_amm::RaydiumCpmmAmm;
use solana_pubkey::{Pubkey, pubkey};

const POOL: Pubkey = pubkey!("Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp");
const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const TOKEN: Pubkey = pubkey!("Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk");

/// A pool with `enable_creator_fee = true` and `creator_fee_on = OnlyToken0`, so the creator fee
/// is charged on the INPUT when swapping token 0 in, and on the OUTPUT in the other direction.
/// One pool, both branches.
const CREATOR_FEE_POOL: Pubkey = pubkey!("BCqvsgJWJn62dRYibSjz8QdqMHjy1fU3Dy4hHaetczFq");
const CREATOR_FEE_TOKEN: Pubkey = pubkey!("91RxDpxbxVhBJV2Yn9P4SbVBgZitjtceFxn5dDtDbonk");

/// A pool whose token 1 is a Token-2022 mint carrying a 500 bps (5%) `TransferFeeConfig` with an
/// uncapped maximum. The pool never sees the fee: it is taken by the token program on the way in
/// and on the way out, so the quote has to model it on both legs.
const T22_POOL: Pubkey = pubkey!("9eNQLCp7serzsg61hxAYqsLBiZYgDPi1XL1736FXzLfC");
const T22_TOKEN: Pubkey = pubkey!("7cC5S2uoKB5nQofua8Mobdd7bnf7uGiM8WiLJc8a1MGJ");

#[test]
fn raydium_cpmm_wsol_pair_parity() {
    let test = PoolTest::new(POOL)
        // Amounts are deliberately NOT multiples of 1e6/trade_fee_rate (= 400 here): with a
        // round amount the fee divides exactly and ceil() and floor() agree, so the test cannot
        // tell a correct implementation from one that rounds the trading fee the wrong way.
        // A mutation that floors the trade fee passes on round amounts and fails on these.
        .add_swap(WSOL, TOKEN, 100_000_001) // ~0.1 SOL
        .add_swap(WSOL, TOKEN, 5_000_000_123) // ~5 SOL, enough to move the price
        .add_swap(TOKEN, WSOL, 1_000_000_007) // and the other direction
        .add_swap(TOKEN, WSOL, 250_000_000_999);

    assert_pool_parity::<RaydiumCpmmAmm>(&test, encode_swap);
}

/// The creator-fee paths. Without this pool an implementation that charges the creator fee on the
/// wrong side still passes, because the first pool has `enable_creator_fee = false` and both
/// branches collapse to the same arithmetic.
#[test]
fn raydium_cpmm_creator_fee_parity() {
    let test = PoolTest::new(CREATOR_FEE_POOL)
        // token 0 in: creator fee is taken on the input, split out of one combined ceiling fee.
        .add_swap(WSOL, CREATOR_FEE_TOKEN, 50_000_001)
        .add_swap(WSOL, CREATOR_FEE_TOKEN, 2_000_000_777)
        // token 1 in: creator fee is a separate ceiling fee deducted from the output.
        .add_swap(CREATOR_FEE_TOKEN, WSOL, 1_000_000_007)
        .add_swap(CREATOR_FEE_TOKEN, WSOL, 500_000_000_333);

    assert_pool_parity::<RaydiumCpmmAmm>(&test, encode_swap);
}

/// The Token-2022 transfer-fee paths. Swapping WSOL in makes the fee apply to the OUTPUT;
/// swapping the fee-bearing token in makes it apply to the INPUT, so the pool only ever receives
/// 95% of what the user sent.
#[test]
fn raydium_cpmm_token2022_transfer_fee_parity() {
    let test = PoolTest::new(T22_POOL)
        .add_swap(WSOL, T22_TOKEN, 20_000_001)
        .add_swap(WSOL, T22_TOKEN, 1_000_000_333)
        .add_swap(T22_TOKEN, WSOL, 1_000_000_007)
        .add_swap(T22_TOKEN, WSOL, 100_000_000_777);

    assert_pool_parity::<RaydiumCpmmAmm>(&test, encode_swap);
}

/// `swap_base_input` instruction data: the Anchor discriminator
/// `sha256("global:swap_base_input")[..8]`, then `amount_in` and `minimum_amount_out`.
///
/// `minimum_amount_out` is left at 0 — asserting the exact output is the harness's job, and a
/// non-zero bound would make the program, not the test, decide whether the quote was right.
fn encode_swap(swap: &jupiter_amm_interface::Swap, in_amount: u64) -> Vec<u8> {
    match swap {
        jupiter_amm_interface::Swap::Placeholder { .. } => {
            let mut data = Vec::with_capacity(24);
            data.extend_from_slice(&[0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde]);
            data.extend_from_slice(&in_amount.to_le_bytes());
            data.extend_from_slice(&0u64.to_le_bytes());
            data
        }
        other => panic!("unexpected swap variant: {other:?}"),
    }
}
