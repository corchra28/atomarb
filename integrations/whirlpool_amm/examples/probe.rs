//! Find swap sizes that a pool can actually serve within three tick arrays.
use jupiter_amm_interface::{AccountProvider, Amm, AmmContext, ClockRef, KeyedAccount, QuoteParams, SwapMode};
use solana_account::Account;
use jupiter_amm_test_kit::PoolSnapshot;
use solana_pubkey::{pubkey, Pubkey};
use whirlpool_amm::WhirlpoolAmm;

const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

struct SnapshotProvider<'a>(&'a PoolSnapshot);
impl AccountProvider for SnapshotProvider<'_> {
    fn get(&self, pubkey: &Pubkey) -> Option<impl solana_account::ReadableAccount + use<'_>> {
        self.0.get(pubkey).cloned() as Option<Account>
    }
}

fn main() {
    for (name, pool) in [
        ("deep", pubkey!("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE")),
        ("thin", pubkey!("HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ")),
    ] {
        let dir = format!("tests/fixtures/accounts/{pool}");
        let Ok(snapshot) = PoolSnapshot::load_dir(std::path::Path::new(&dir)) else {
            println!("{name}: no fixtures at {dir}");
            continue;
        };
        let ctx = AmmContext { clock_ref: ClockRef::from(snapshot.clock().unwrap_or_default()) };
        let keyed = KeyedAccount { key: pool, account: snapshot.get(&pool).unwrap().clone(), params: None };
        let mut amm = WhirlpoolAmm::from_keyed_account(&keyed, &ctx).unwrap();
        // has_dynamic_accounts: the needed set changes once the pool is decoded, so update twice.
        let provider = SnapshotProvider(&snapshot);
        amm.update(&provider).unwrap();
        amm.update(&provider).unwrap();
        println!("--- {name} {pool} ---");
        for (label, input, output, amounts) in [
            ("WSOL->USDC", WSOL, USDC, vec![100_000_001u64, 1_000_000_007, 5_000_000_011, 20_000_000_003, 50_000_000_003, 200_000_000_011]),
            ("USDC->WSOL", USDC, WSOL, vec![10_000_003u64, 500_000_009, 2_000_000_007, 5_000_000_007, 25_000_000_013, 100_000_000_017]),
        ] {
            for a in amounts {
                let q = amm.quote(&QuoteParams { amount: a, input_mint: input, output_mint: output, swap_mode: SwapMode::ExactIn, fee_mode: Default::default() });
                match q {
                    Ok(q) => println!("  {label} {a:>15} -> out {:>15}", q.out_amount),
                    Err(e) => println!("  {label} {a:>15} -> ERROR {e}"),
                }
            }
        }
    }
}
