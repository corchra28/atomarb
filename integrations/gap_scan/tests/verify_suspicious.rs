//! The frozen-pool finding, pinned as a regression test.
//!
//! The first run of the cross-venue scan reported a **371% return** on a pair of pools holding
//! about one SOL each, and a handful of smaller net-positive circuits beside it. A number that
//! good is guilty until proven innocent, so each leg was run against the real program in LiteSVM
//! through the parity harness. All of them failed with SPL Token error 17, `Account is frozen`.
//!
//! Every net-positive candidate in that run was of this kind: a stale price on a token whose
//! accounts are frozen, unarbitraged for the simple reason that the swap cannot execute. Adding
//! the guard removed 24 circuits and took the count of net-positive results from 7 to 0.
//!
//! These tests assert the guard still catches those pools, so the phantom cannot come back.

use gap_scan::has_frozen_token_account;
use jupiter_amm_test_kit::PoolSnapshot;
use std::path::Path;

fn snapshot(pool: &str) -> Option<(PoolSnapshot, String)> {
    let dir = format!("tests/fixtures/snapshots/{pool}");
    PoolSnapshot::load_dir(Path::new(&dir)).ok().map(|s| (s, dir))
}

/// The two legs of the 371% circuit, and the sell leg of the next-largest one.
#[test]
fn the_headline_circuits_are_on_frozen_pools() {
    let frozen = [
        // leg A: Whirlpool, ~1 SOL
        "EaNPTS1Nns49UoVhBdBUqUREt2cCLTTrDtqUVSEWHtNd",
        // leg B: Raydium CPMM, ~1 SOL — this is where the 371% came from
        "GvnNGB54ZXy7Az846tLHUMVTSTbQ35AiwmFAPu9rkZKw",
        // the second candidate's DLMM leg
        "GmZk9UiUtJ5horKduPgTUMKZTyMX9jNuPyUKS6MXqmN1",
    ];
    let mut checked = 0;
    for pool in frozen {
        let (snap, dir) = snapshot(pool).expect("vendored snapshot");
        assert!(
            has_frozen_token_account(&snap, &dir),
            "{pool} holds a frozen token account and must be rejected before quoting"
        );
        checked += 1;
    }
    assert!(checked > 0, "no snapshots present; run scripts/cl_snapshot.ts first");
}

/// A pool that trades normally must not be rejected, or the guard is useless.
#[test]
fn a_healthy_pool_is_not_rejected() {
    // The deep WSOL/USDC Whirlpool used by the whirlpool_amm parity suite.
    // No early return: a missing snapshot must fail the test, not quietly pass it.
    let (snap, dir) = snapshot("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE")
        .expect("the healthy-pool snapshot must be vendored, or this test asserts nothing");
    assert!(!has_frozen_token_account(&snap, &dir));
}
