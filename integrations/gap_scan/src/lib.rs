//! The parts of the cross-venue scan worth testing on their own.

use jupiter_amm_test_kit::PoolSnapshot;
use solana_account::ReadableAccount;
use solana_pubkey::{pubkey, Pubkey};

pub const SPL_TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Is any token account in this snapshot frozen?
///
/// This check exists because of a result, not a hunch. Without it the scan reported a 371%
/// return on a pair of ~1 SOL pools, and running each leg against the real program in LiteSVM
/// returned SPL Token error 17, `Account is frozen`. A frozen vault leaves a stale price that
/// nobody has arbitraged for the simple reason that nobody can: the swap cannot execute. Every
/// net-positive candidate in that run was of this kind.
///
/// SPL Token account layout: mint(32) owner(32) amount(8) delegate(36) state(1) — so the state
/// byte sits at offset 108, and 2 means frozen.
pub fn has_frozen_token_account(snapshot: &PoolSnapshot, dir: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let Some(key) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<Pubkey>().ok())
        else {
            continue;
        };
        if let Some(a) = snapshot.get(&key) {
            let owner = *a.owner();
            if (owner == SPL_TOKEN || owner == TOKEN_2022)
                && a.data().len() >= 109
                && a.data()[108] == 2
            {
                return true;
            }
        }
    }
    false
}

