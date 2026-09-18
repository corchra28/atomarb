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
    for (name, pool, mint_a, mint_b) in [
        ("deep", pubkey!("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"), WSOL, USDC),
        ("thin", pubkey!("HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ"), WSOL, USDC),
        ("dyn", pubkey!("949myKpLQJn2G9x22FBWUa33JA4fiEspz3sKNumGiz1v"),
            pubkey!("555XtgMJYBefyiJWdvSj5yPqEtTBN6WRuAuPfKcob2ux"), USDC),
        ("t22", pubkey!("3qjhHaRKT1U1FQyKak6Qjk1Geea4na1WKGMRSQCuSmDc"),
            pubkey!("5SyfywcaD8kiEGyrt7cg4FnVqxTcuut5KCcWgh44o3UG"),
            pubkey!("5YfJXwwEpjPBNntMaEYGUoC6xGuw1hnyckGtwKL5URuS")),
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
            ("A->B", mint_a, mint_b, vec![1_003u64, 10_007, 100_003, 1_000_003, 10_000_003, 100_000_007]),
            ("B->A", mint_b, mint_a, vec![1_003u64, 10_007, 100_003, 1_000_003, 10_000_003, 50_000_011]),
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
