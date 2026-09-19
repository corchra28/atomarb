//! Can a poller see a cross-venue gap at all?
//!
//! The verdict in this repository rests on the claim that atomic arbitrage is **latency-gated**,
//! and that claim currently rests on inference: 101 of 104 winners pay for block position, and the
//! same 156 operators recur in every window sampled. It has never been measured directly.
//!
//! This measures it. It polls a set of cross-venue pairs — taken from pools where verified
//! winners actually operated, not the deepest and most-watched pairs — at a cadence faster than
//! the engine achieves, and records every poll at which a circuit is net positive.
//!
//! **Stated before running, so the result cannot be read to taste:**
//!
//! - **Zero net-positive observations across the window** → the claim is demonstrated. At this
//!   cadence a poller cannot see the opportunity, so it cannot act on it.
//! - **Net-positive observations that persist across two or more consecutive polls** → the claim
//!   is weaker than stated. Observation is not the barrier; submission and block position are.
//!   This must be reported as weakening the verdict's stated reason.
//! - **Net-positive observations appearing in exactly one poll and gone by the next** → the gap
//!   lives for less than the cadence, which supports the claim but does not prove a faster poller
//!   would fail.
//!
//! Read-only: getMultipleAccounts only. Nothing signed or submitted.

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jupiter_amm_interface::{
    AccountProvider, Amm, AmmContext, ClockRef, KeyedAccount, QuoteParams, SwapMode,
};
use meteora_dlmm_amm::MeteoraDlmmAmm;
use raydium_cpmm_amm::RaydiumCpmmAmm;
use solana_account::Account;
use solana_pubkey::{Pubkey, pubkey};
use whirlpool_amm::WhirlpoolAmm;

const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// The repository's standing per-attempt cost assumption, kept for comparability.
const NETWORK_FEE_LAMPORTS: i128 = 9_000;
/// Sizes to price each poll. The census found 84% of real profit is made with 1–100 SOL, and the
/// median winning trade deploys 0.06 SOL, so this spans that range.
const SIZES: &[u64] = &[
    10_000_000,
    100_000_000,
    1_000_000_000,
    5_000_000_000,
    20_000_000_000,
    100_000_000_000,
];

struct MapProvider(HashMap<Pubkey, Account>);
impl AccountProvider for MapProvider {
    fn get(&self, pubkey: &Pubkey) -> Option<impl solana_account::ReadableAccount + use<'_>> {
        self.0.get(pubkey).cloned() as Option<Account>
    }
}

enum Leg {
    Raydium(Box<RaydiumCpmmAmm>),
    Whirlpool(Box<WhirlpoolAmm>),
    Dlmm(Box<MeteoraDlmmAmm>),
}

impl Leg {
    fn build(venue: &str, key: Pubkey, account: Account, ctx: &AmmContext) -> Option<Self> {
        let keyed = KeyedAccount {
            key,
            account,
            params: None,
        };
        Some(match venue {
            "raydium_cpmm" => Leg::Raydium(Box::new(RaydiumCpmmAmm::from_keyed_account(&keyed, ctx).ok()?)),
            "whirlpool" => Leg::Whirlpool(Box::new(WhirlpoolAmm::from_keyed_account(&keyed, ctx).ok()?)),
            "dlmm" => Leg::Dlmm(Box::new(MeteoraDlmmAmm::from_keyed_account(&keyed, ctx).ok()?)),
            _ => return None,
        })
    }
    fn accounts(&self) -> Vec<Pubkey> {
        match self {
            Leg::Raydium(a) => a.get_accounts_to_update(),
            Leg::Whirlpool(a) => a.get_accounts_to_update(),
            Leg::Dlmm(a) => a.get_accounts_to_update(),
        }
    }
    fn update(&mut self, p: &MapProvider) {
        let _ = match self {
            Leg::Raydium(a) => a.update(p),
            Leg::Whirlpool(a) => a.update(p),
            Leg::Dlmm(a) => a.update(p),
        };
    }
    fn quote(&self, i: Pubkey, o: Pubkey, amount: u64) -> Option<u64> {
        let p = QuoteParams {
            amount,
            input_mint: i,
            output_mint: o,
            swap_mode: SwapMode::ExactIn,
            fee_mode: Default::default(),
        };
        match self {
            Leg::Raydium(a) => a.quote(&p),
            Leg::Whirlpool(a) => a.quote(&p),
            Leg::Dlmm(a) => a.quote(&p),
        }
        .ok()
        .map(|q| q.out_amount)
        .filter(|o| *o > 0)
    }
}

// ---------------------------------------------------------------------------------------------
// Minimal JSON-RPC over ureq. No solana-client: it would drag in a conflicting crate generation.
// ---------------------------------------------------------------------------------------------

fn fetch_accounts(url: &str, keys: &[Pubkey]) -> HashMap<Pubkey, Account> {
    use base64::Engine;
    let mut out = HashMap::new();
    for chunk in keys.chunks(100) {
        let list: Vec<String> = chunk.iter().map(|k| k.to_string()).collect();
        let body = serde_json::json!({
            "jsonrpc":"2.0","id":1,"method":"getMultipleAccounts",
            "params":[list, {"encoding":"base64","commitment":"processed"}]
        });
        let Ok(resp) = ureq::post(url).send_json(&body) else { continue };
        let Ok(v): Result<serde_json::Value, _> = resp.into_json() else { continue };
        let Some(values) = v["result"]["value"].as_array() else { continue };
        for (i, item) in values.iter().enumerate() {
            if item.is_null() {
                continue;
            }
            let Some(data_b64) = item["data"][0].as_str() else { continue };
            let Ok(data) = base64::engine::general_purpose::STANDARD.decode(data_b64) else { continue };
            let Some(owner_s) = item["owner"].as_str() else { continue };
            let Ok(owner) = owner_s.parse::<Pubkey>() else { continue };
            out.insert(
                chunk[i],
                Account {
                    lamports: item["lamports"].as_u64().unwrap_or(0),
                    data,
                    owner,
                    executable: item["executable"].as_bool().unwrap_or(false),
                    rent_epoch: 0,
                },
            );
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct PairLeg {
    venue: String,
    pool: String,
}
#[derive(serde::Deserialize)]
struct PairEntry {
    mint: String,
    legs: Vec<PairLeg>,
}
#[derive(serde::Deserialize)]
struct Pairs {
    pairs: Vec<PairEntry>,
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

fn main() {
    let url = std::env::var("SOLANA_RPC_URL").expect("SOLANA_RPC_URL");
    let minutes: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(30);
    let cadence_ms: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(2000);

    let raw = std::fs::read_to_string(".scratch/latency/pairs.json").expect("pairs.json");
    let pairs: Pairs = serde_json::from_str(&raw).expect("parse pairs");

    // Bootstrap: fetch the pool accounts once to construct the Amms.
    let mut pool_keys = Vec::new();
    for p in &pairs.pairs {
        for l in &p.legs {
            if let Ok(k) = l.pool.parse::<Pubkey>() {
                pool_keys.push(k);
            }
        }
    }
    let boot = fetch_accounts(&url, &pool_keys);
    let ctx = AmmContext {
        clock_ref: ClockRef::default(),
    };

    struct Circuit {
        mint: Pubkey,
        label: String,
        a: usize,
        b: usize,
    }
    let mut legs: Vec<(String, Leg)> = Vec::new();
    let mut circuits: Vec<Circuit> = Vec::new();
    for p in &pairs.pairs {
        let Ok(mint) = p.mint.parse::<Pubkey>() else { continue };
        let mut idx = Vec::new();
        for l in &p.legs {
            let Ok(key) = l.pool.parse::<Pubkey>() else { continue };
            let Some(acc) = boot.get(&key) else { continue };
            if let Some(leg) = Leg::build(&l.venue, key, acc.clone(), &ctx) {
                legs.push((l.venue.clone(), leg));
                idx.push((legs.len() - 1, l.venue.clone()));
            }
        }
        for i in 0..idx.len() {
            for j in 0..idx.len() {
                if i == j || idx[i].1 == idx[j].1 {
                    continue;
                }
                circuits.push(Circuit {
                    mint,
                    label: format!("{}.. {} -> {}", &p.mint[..8], idx[i].1, idx[j].1),
                    a: idx[i].0,
                    b: idx[j].0,
                });
            }
        }
    }
    eprintln!("legs {}, circuits {}", legs.len(), circuits.len());
    if circuits.is_empty() {
        eprintln!("no circuits to poll");
        return;
    }

    let deadline = Instant::now() + Duration::from_secs(minutes * 60);
    let mut polls = 0u64;
    let mut quotes = 0u64;
    let mut positive_gross = 0u64;
    let mut positive_net = 0u64;
    let mut best_net: i128 = i128::MIN;
    let mut best_desc = String::new();
    // circuit label -> consecutive polls it has been net positive for
    let mut streak: BTreeMap<String, u32> = BTreeMap::new();
    let mut max_streak: BTreeMap<String, u32> = BTreeMap::new();
    let mut events: Vec<String> = Vec::new();
    let mut fetch_ms_total = 0u128;

    while Instant::now() < deadline {
        let poll_start = Instant::now();
        // The needed account set moves with the price, so re-derive it every poll.
        let mut keys: Vec<Pubkey> = Vec::new();
        for (_, l) in &legs {
            keys.extend(l.accounts());
        }
        keys.sort();
        keys.dedup();
        let t0 = Instant::now();
        let accounts = fetch_accounts(&url, &keys);
        fetch_ms_total += t0.elapsed().as_millis();
        let provider = MapProvider(accounts);
        for (_, l) in legs.iter_mut() {
            l.update(&provider);
            l.update(&provider); // has_dynamic_accounts: the set changes once decoded
        }
        polls += 1;

        let mut positive_this_poll: Vec<String> = Vec::new();
        for c in &circuits {
            for &size in SIZES {
                let Some(mid) = legs[c.a].1.quote(WSOL, c.mint, size) else { continue };
                let Some(back) = legs[c.b].1.quote(c.mint, WSOL, mid) else { continue };
                quotes += 1;
                let gross = back as i128 - size as i128;
                let net = gross - NETWORK_FEE_LAMPORTS;
                if gross > 0 {
                    positive_gross += 1;
                }
                if net > 0 {
                    positive_net += 1;
                    positive_this_poll.push(c.label.clone());
                    if net > best_net {
                        best_net = net;
                        best_desc = format!("{} at {:.3} SOL: net {} lamports", c.label, size as f64 / 1e9, net);
                    }
                }
            }
        }

        // Track how long each net-positive circuit survives, in consecutive polls.
        let seen: std::collections::HashSet<String> = positive_this_poll.into_iter().collect();
        for c in &circuits {
            if seen.contains(&c.label) {
                let e = streak.entry(c.label.clone()).or_insert(0);
                *e += 1;
                let m = max_streak.entry(c.label.clone()).or_insert(0);
                if *e > *m {
                    *m = *e;
                }
                if *e == 1 {
                    events.push(format!("{} poll {} OPEN {}", now_ms(), polls, c.label));
                }
            } else if let Some(e) = streak.get_mut(&c.label) {
                if *e > 0 {
                    events.push(format!("{} poll {} CLOSE {} after {} polls", now_ms(), polls, c.label, *e));
                }
                *e = 0;
            }
        }

        if polls % 30 == 0 {
            eprintln!(
                "poll {polls}  quotes {quotes}  gross+ {positive_gross}  net+ {positive_net}  fetch avg {}ms",
                fetch_ms_total / polls as u128
            );
        }
        let elapsed = poll_start.elapsed();
        if elapsed < Duration::from_millis(cadence_ms) {
            std::thread::sleep(Duration::from_millis(cadence_ms) - elapsed);
        }
    }

    println!("\n=== latency probe ===");
    println!("polls                 : {polls}");
    println!("cadence target        : {cadence_ms} ms");
    println!("mean fetch time       : {} ms", fetch_ms_total / polls.max(1) as u128);
    println!("circuits polled       : {}", circuits.len());
    println!("circuit-size quotes   : {quotes}");
    println!("positive GROSS        : {positive_gross}");
    println!("positive NET          : {positive_net}");
    if positive_net > 0 {
        println!("best net              : {best_net} lamports  ({best_desc})");
        println!("\nlongest consecutive-poll survival per circuit:");
        for (k, v) in max_streak.iter().filter(|(_, v)| **v > 0) {
            println!("  {k:<40} {v} polls");
        }
        println!("\nopen/close events:");
        for e in events.iter().take(60) {
            println!("  {e}");
        }
    }
    let json = serde_json::json!({
        "polls": polls, "cadence_ms": cadence_ms, "circuits": circuits.len(),
        "quotes": quotes, "positive_gross": positive_gross, "positive_net": positive_net,
        "best_net": best_net.to_string(), "best_desc": best_desc,
        "max_streak": max_streak, "events": events,
        "mean_fetch_ms": fetch_ms_total / polls.max(1) as u128,
    });
    let _ = std::fs::write(".scratch/latency/probe_result.json", json.to_string());
}
