//! Cross-venue circuit scan with concentrated liquidity included.
//!
//! Reads the snapshots written by `scripts/cl_snapshot.ts` and prices the circuit
//! `WSOL -> TOKEN (venue A) -> WSOL (venue B)` through the three adapters in this repository,
//! whose quotes are each proven equal to the on-chain program by their own parity suites.
//!
//! This is the measurement the census called for: `docs/REAL_WORLD_MEV.md` found that 98 of 104
//! real winning arbitrages include a concentrated-liquidity venue, while the earlier whole-chain
//! radar covered constant-product venues only.
//!
//! No network, no signing, no submission — it loads account bytes from disk and does arithmetic.

use std::collections::BTreeMap;
use std::path::Path;

use jupiter_amm_interface::{
    AccountProvider, Amm, AmmContext, ClockRef, KeyedAccount, QuoteParams, SwapMode,
};
use jupiter_amm_test_kit::PoolSnapshot;
use meteora_dlmm_amm::MeteoraDlmmAmm;
use raydium_cpmm_amm::RaydiumCpmmAmm;
use solana_account::Account;
use solana_pubkey::{Pubkey, pubkey};
use whirlpool_amm::WhirlpoolAmm;

const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// The repository's standing assumption for a landed attempt: 5,000 base + 4,000 priority.
/// `docs/REAL_WORLD_MEV.md` measured what real winners actually pay, which is 5,000 base plus a
/// tip; this keeps the original number so the result is comparable with the earlier radar.
const NETWORK_FEE_LAMPORTS: i128 = 9_000;

use gap_scan::has_frozen_token_account;

struct SnapshotProvider<'a>(&'a PoolSnapshot);
impl AccountProvider for SnapshotProvider<'_> {
    fn get(&self, pubkey: &Pubkey) -> Option<impl solana_account::ReadableAccount + use<'_>> {
        self.0.get(pubkey).cloned() as Option<Account>
    }
}

/// One venue's pool, behind whichever adapter prices it.
enum Leg {
    Raydium(Box<RaydiumCpmmAmm>),
    Whirlpool(Box<WhirlpoolAmm>),
    Dlmm(Box<MeteoraDlmmAmm>),
}

impl Leg {
    fn load(venue: &str, pool: Pubkey, dir: &str) -> Option<(Self, PoolSnapshot)> {
        let snapshot = PoolSnapshot::load_dir(Path::new(dir)).ok()?;
        let ctx = AmmContext {
            clock_ref: ClockRef::from(snapshot.clock().unwrap_or_default()),
        };
        let keyed = KeyedAccount {
            key: pool,
            account: snapshot.get(&pool)?.clone(),
            params: None,
        };
        // Reject before quoting: a frozen vault means the swap cannot execute, whatever the
        // arithmetic says.
        if has_frozen_token_account(&snapshot, dir) {
            return None;
        }
        let provider = SnapshotProvider(&snapshot);
        let leg = match venue {
            "raydium_cpmm" => {
                let mut a = RaydiumCpmmAmm::from_keyed_account(&keyed, &ctx).ok()?;
                a.update(&provider).ok()?;
                Leg::Raydium(Box::new(a))
            }
            "whirlpool" => {
                let mut a = WhirlpoolAmm::from_keyed_account(&keyed, &ctx).ok()?;
                // has_dynamic_accounts: the needed set is known only once the pool is decoded.
                a.update(&provider).ok()?;
                a.update(&provider).ok()?;
                Leg::Whirlpool(Box::new(a))
            }
            "dlmm" => {
                let mut a = MeteoraDlmmAmm::from_keyed_account(&keyed, &ctx).ok()?;
                a.update(&provider).ok()?;
                a.update(&provider).ok()?;
                Leg::Dlmm(Box::new(a))
            }
            _ => return None,
        };
        drop(provider);
        Some((leg, snapshot))
    }

    fn quote(&self, input_mint: Pubkey, output_mint: Pubkey, amount: u64) -> Option<u64> {
        let p = QuoteParams {
            amount,
            input_mint,
            output_mint,
            swap_mode: SwapMode::ExactIn,
            fee_mode: Default::default(),
        };
        let q = match self {
            Leg::Raydium(a) => a.quote(&p),
            Leg::Whirlpool(a) => a.quote(&p),
            Leg::Dlmm(a) => a.quote(&p),
        };
        q.ok().map(|q| q.out_amount).filter(|o| *o > 0)
    }

    fn mints(&self) -> Vec<Pubkey> {
        match self {
            Leg::Raydium(a) => a.get_reserve_mints(),
            Leg::Whirlpool(a) => a.get_reserve_mints(),
            Leg::Dlmm(a) => a.get_reserve_mints(),
        }
    }
}

#[derive(serde::Deserialize)]
struct ManifestLeg {
    venue: String,
    pool: String,
    dir: String,
}
#[derive(serde::Deserialize)]
struct ManifestEntry {
    mint: String,
    legs: Vec<ManifestLeg>,
}
#[derive(serde::Deserialize)]
struct Manifest {
    candidates: Vec<ManifestEntry>,
}

/// Sizes to try, in lamports of WSOL. Spanning four orders of magnitude, because the census found
/// the median winning trade deployed 0.0235 SOL and the largest anywhere was 14.5.
const SIZES: &[u64] = &[
    1_000_000,
    10_000_000,
    100_000_000,
    500_000_000,
    1_000_000_000,
    5_000_000_000,
    20_000_000_000,
];

fn main() {
    let raw = std::fs::read_to_string(".scratch/clgap/manifest.json").expect("manifest");
    let manifest: Manifest = serde_json::from_str(&raw).expect("parse manifest");

    let mut circuits_priced = 0usize;
    let mut positive_gross = 0usize;
    let mut positive_net = 0usize;
    // The census measured what winners actually pay: 5,000 base plus a tip, and 43 of 123
    // winning trades take home less than the 9,000 this repo originally assumed. Reporting
    // against the base fee too shows whether the assumption is what decides the answer.
    let mut positive_net_base_fee = 0usize;
    let mut best_gross: i128 = i128::MIN;
    let mut best_net: i128 = i128::MIN;
    let mut best_desc = String::new();
    let mut venue_pairs: BTreeMap<String, usize> = BTreeMap::new();
    let mut cl_involved = 0usize;
    let mut rows: Vec<(i128, String)> = Vec::new();

    for entry in &manifest.candidates {
        let token: Pubkey = match entry.mint.parse() {
            Ok(k) => k,
            Err(_) => continue,
        };
        // Load every leg once; keep the snapshots alive alongside.
        let mut legs: Vec<(String, Leg)> = Vec::new();
        let mut _keep: Vec<PoolSnapshot> = Vec::new();
        for l in &entry.legs {
            let Ok(pool) = l.pool.parse::<Pubkey>() else { continue };
            if let Some((leg, snap)) = Leg::load(&l.venue, pool, &l.dir) {
                if leg.mints().contains(&WSOL) && leg.mints().contains(&token) {
                    legs.push((l.venue.clone(), leg));
                    _keep.push(snap);
                }
            }
        }
        if legs.len() < 2 {
            continue;
        }

        for i in 0..legs.len() {
            for j in 0..legs.len() {
                if i == j || legs[i].0 == legs[j].0 {
                    continue; // same venue on both legs is not what this is measuring
                }
                let pair = format!("{} -> {}", legs[i].0, legs[j].0);
                for &size in SIZES {
                    let Some(mid) = legs[i].1.quote(WSOL, token, size) else { continue };
                    let Some(back) = legs[j].1.quote(token, WSOL, mid) else { continue };
                    circuits_priced += 1;
                    *venue_pairs.entry(pair.clone()).or_default() += 1;
                    if legs[i].0 != "raydium_cpmm" || legs[j].0 != "raydium_cpmm" {
                        cl_involved += 1;
                    }
                    let gross = back as i128 - size as i128;
                    let net = gross - NETWORK_FEE_LAMPORTS;
                    if gross > 0 {
                        positive_gross += 1;
                    }
                    if gross - 5_000 > 0 {
                        positive_net_base_fee += 1;
                    }
                    if net > 0 {
                        positive_net += 1;
                        rows.push((
                            net,
                            format!(
                                "{} {} size {:.4} SOL -> net {} lamports",
                                &entry.mint[..8.min(entry.mint.len())],
                                pair,
                                size as f64 / 1e9,
                                net
                            ),
                        ));
                    }
                    if gross > best_gross {
                        best_gross = gross;
                    }
                    if net > best_net {
                        best_net = net;
                        best_desc = format!(
                            "{} {} at {:.4} SOL: gross {} net {} lamports",
                            &entry.mint[..8.min(entry.mint.len())],
                            pair,
                            size as f64 / 1e9,
                            gross,
                            net
                        );
                    }
                }
            }
        }
    }

    println!("candidates in manifest      : {}", manifest.candidates.len());
    println!("circuits priced             : {circuits_priced}");
    println!("  involving a CL venue      : {cl_involved}");
    println!("positive GROSS (before fee) : {positive_gross}");
    println!("positive NET (after {NETWORK_FEE_LAMPORTS} lamports) : {positive_net}");
    println!("positive NET (after 5,000 base fee only)  : {positive_net_base_fee}");
    println!("best gross                  : {best_gross} lamports");
    println!("best net                    : {best_net} lamports");
    println!("best circuit                : {best_desc}");
    println!("\nvenue pairs priced:");
    for (k, v) in &venue_pairs {
        println!("  {k:<32} {v}");
    }
    if !rows.is_empty() {
        rows.sort_by(|a, b| b.0.cmp(&a.0));
        println!("\nnet-positive circuits (top 20):");
        for (_, d) in rows.iter().take(20) {
            println!("  {d}");
        }
    }
}
