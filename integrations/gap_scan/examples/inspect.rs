//! Print the intermediate amounts of a specific circuit, to see whether a headline result is real.
use std::path::Path;
use jupiter_amm_interface::{AccountProvider, Amm, AmmContext, ClockRef, KeyedAccount, QuoteParams, SwapMode};
use jupiter_amm_test_kit::PoolSnapshot;
use meteora_dlmm_amm::MeteoraDlmmAmm;
use raydium_cpmm_amm::RaydiumCpmmAmm;
use solana_account::Account;
use solana_pubkey::{pubkey, Pubkey};
use whirlpool_amm::WhirlpoolAmm;

const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

struct P<'a>(&'a PoolSnapshot);
impl AccountProvider for P<'_> {
    fn get(&self, k: &Pubkey) -> Option<impl solana_account::ReadableAccount + use<'_>> {
        self.0.get(k).cloned() as Option<Account>
    }
}

enum L { R(Box<RaydiumCpmmAmm>), W(Box<WhirlpoolAmm>), D(Box<MeteoraDlmmAmm>) }
impl L {
    fn q(&self, i: Pubkey, o: Pubkey, a: u64) -> Option<u64> {
        let p = QuoteParams { amount: a, input_mint: i, output_mint: o, swap_mode: SwapMode::ExactIn, fee_mode: Default::default() };
        match self { L::R(x) => x.quote(&p), L::W(x) => x.quote(&p), L::D(x) => x.quote(&p) }.ok().map(|q| q.out_amount)
    }
}

fn load(venue: &str, pool: Pubkey) -> Option<(L, PoolSnapshot)> {
    let dir = format!(".scratch/clgap/snapshots/{pool}");
    let s = PoolSnapshot::load_dir(Path::new(&dir)).ok()?;
    let ctx = AmmContext { clock_ref: ClockRef::from(s.clock().unwrap_or_default()) };
    let k = KeyedAccount { key: pool, account: s.get(&pool)?.clone(), params: None };
    let p = P(&s);
    let l = match venue {
        "raydium_cpmm" => { let mut a = RaydiumCpmmAmm::from_keyed_account(&k,&ctx).ok()?; a.update(&p).ok()?; L::R(Box::new(a)) }
        "whirlpool" => { let mut a = WhirlpoolAmm::from_keyed_account(&k,&ctx).ok()?; a.update(&p).ok()?; a.update(&p).ok()?; L::W(Box::new(a)) }
        "dlmm" => { let mut a = MeteoraDlmmAmm::from_keyed_account(&k,&ctx).ok()?; a.update(&p).ok()?; a.update(&p).ok()?; L::D(Box::new(a)) }
        _ => return None,
    };
    drop(p);
    Some((l, s))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let token: Pubkey = args[1].parse().unwrap();
    let (la, _sa) = load(&args[2], args[3].parse().unwrap()).expect("leg A");
    let (lb, _sb) = load(&args[4], args[5].parse().unwrap()).expect("leg B");
    println!("token {token}");
    for size in [1_000_000u64, 10_000_000, 100_000_000, 500_000_000] {
        let mid = la.q(WSOL, token, size);
        let back = mid.and_then(|m| lb.q(token, WSOL, m));
        println!("  in {:>12} -> mid {:>24?} -> back {:>14?}", size, mid, back);
        if let Some(m) = mid {
            println!("      leg A round trip on itself: {:?}  (must be < {})", la.q(token, WSOL, m), size);
        }
    }
}
