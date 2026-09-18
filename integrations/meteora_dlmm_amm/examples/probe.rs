//! Find swap sizes a pool can actually serve within the bin arrays carried.
//!
//! Writing test sizes before probing cost real time on the Whirlpool adapter; this exists so it
//! does not happen again.
use jupiter_amm_interface::{
    AccountProvider, Amm, AmmContext, ClockRef, KeyedAccount, QuoteParams, SwapMode,
};
use jupiter_amm_test_kit::PoolSnapshot;
use meteora_dlmm_amm::MeteoraDlmmAmm;
use solana_account::Account;
use solana_pubkey::{Pubkey, pubkey};

const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

struct SnapshotProvider<'a>(&'a PoolSnapshot);
impl AccountProvider for SnapshotProvider<'_> {
    fn get(&self, pubkey: &Pubkey) -> Option<impl solana_account::ReadableAccount + use<'_>> {
        self.0.get(pubkey).cloned() as Option<Account>
    }
}

fn main() {
    let pools: Vec<(&str, Pubkey, Pubkey, Pubkey)> = vec![
        (
            "binstep10",
            pubkey!("BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y"),
            WSOL,
            USDC,
        ),
        (
            "binstep50",
            pubkey!("5BoHD7DAHsGCA9D8eUkkZTgWTrnpad6G18MnTq3cUS86"),
            WSOL,
            USDC,
        ),
        (
            "binstep75",
            pubkey!("9Q1njS4j8svdjCnGd2xJn7RAkqrJ2vqjaPs3sXRZ6UR7"),
            WSOL,
            USDC,
        ),
    ];

    for (name, pool, mint_x, mint_y) in pools {
        let dir = format!("tests/fixtures/accounts/{pool}");
        let Ok(snapshot) = PoolSnapshot::load_dir(std::path::Path::new(&dir)) else {
            println!("--- {name} {pool}: no fixtures ---");
            continue;
        };
        let ctx = AmmContext {
            clock_ref: ClockRef::from(snapshot.clock().unwrap_or_default()),
        };
        let keyed = KeyedAccount {
            key: pool,
            account: snapshot.get(&pool).unwrap().clone(),
            params: None,
        };
        let mut amm = match MeteoraDlmmAmm::from_keyed_account(&keyed, &ctx) {
            Ok(a) => a,
            Err(e) => {
                println!("--- {name}: decode failed: {e} ---");
                continue;
            }
        };
        let provider = SnapshotProvider(&snapshot);
        // has_dynamic_accounts: the needed set is known only after the pool is decoded.
        let _ = amm.update(&provider);
        let _ = amm.update(&provider);
        println!("--- {name} {pool} ---");

        for (label, input, output, amounts) in [
            (
                "X->Y",
                mint_x,
                mint_y,
                vec![
                    1_000_003u64,
                    100_000_007,
                    1_000_000_003,
                    10_000_000_007,
                    50_000_000_003,
                    200_000_000_011,
                ],
            ),
            (
                "Y->X",
                mint_y,
                mint_x,
                vec![
                    1_000_003u64,
                    100_000_007,
                    1_000_000_003,
                    10_000_000_007,
                    50_000_000_003,
                    200_000_000_011,
                ],
            ),
        ] {
            for a in amounts {
                match amm.quote(&QuoteParams {
                    amount: a,
                    input_mint: input,
                    output_mint: output,
                    swap_mode: SwapMode::ExactIn,
                    fee_mode: Default::default(),
                }) {
                    Ok(q) => println!("  {label} {a:>15} -> out {:>16}", q.out_amount),
                    Err(e) => println!("  {label} {a:>15} -> ERROR {e}"),
                }
            }
        }
    }
}
