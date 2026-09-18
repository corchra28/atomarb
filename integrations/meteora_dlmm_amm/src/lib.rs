//! Meteora DLMM as a Jupiter `Amm`.
//!
//! Chosen because the on-chain census in `docs/REAL_WORLD_MEV.md` found Meteora DLMM to be the
//! second most frequent venue among the 104 winning atomic arbitrages, 51 routed hops against
//! Orca Whirlpool's 59.
//!
//! **The swap math is not reimplemented here**, for the same reason as the Whirlpool adapter, but
//! with a different answer. Orca publishes a dependency-light core crate; Meteora does not. Its
//! official `commons` crate exposes `quote_exact_in` but is built on solana-sdk 2.1 and
//! anchor-lang 0.31, which cannot coexist with the solana 3/4 generation litesvm needs — the same
//! wall Jupiter's own reference example hits with `spl-token-swap`. This uses `meteora-dlmm`, a
//! zero-dependency engine, and proves it against the real program in `tests/dlmm.rs`. That a
//! dependency is small and third-party is exactly why the parity suite exists.
//!
//! Account layout taken from the official IDL in `MeteoraAg/dlmm-sdk` and verified against live
//! mainnet pools.

use jupiter_amm_interface::{
    AccountProvider, Amm, AmmContext, AmmError, AmmLabel, ClockRef, KeyedAccount, Quote,
    QuoteParams, SingleProgramAmm, Swap, SwapAndAccountMetas, SwapParams, single_program_amm,
};
use meteora_dlmm::decode::PoolState;
use meteora_dlmm::quote::quote_with_mints;
use meteora_dlmm::token2022::{MintInfo, parse_mint};
use solana_account::ReadableAccount;
use solana_instruction::AccountMeta;
use solana_pubkey::{Pubkey, pubkey};
use std::sync::atomic::Ordering;

pub const DLMM_PROGRAM: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const MEMO_PROGRAM: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/// `sha256("account:LbPair")[..8]`, confirmed against the 159,244 such accounts on chain.
const LB_PAIR_DISCRIMINATOR: [u8; 8] = [0x21, 0x0b, 0x31, 0x62, 0xb5, 0x65, 0xb1, 0x0d];
const LB_PAIR_LEN: usize = 904;

/// Offsets resolved from the official IDL by walking the struct.
const OFF_ACTIVE_ID: usize = 76; // i32
const OFF_BIN_STEP: usize = 80; // u16
const OFF_STATUS: usize = 82; // u8
const OFF_TOKEN_X_MINT: usize = 88;
const OFF_TOKEN_Y_MINT: usize = 120;
const OFF_RESERVE_X: usize = 152;
const OFF_RESERVE_Y: usize = 184;
const OFF_ORACLE: usize = 552;

/// Bins per `BinArray`, from the engine's own constant.
const BINS_PER_ARRAY: i64 = 70;

/// How many bin arrays to carry on each side of the active one. `swap2` puts bin arrays in its
/// remaining accounts, so this is a coverage choice rather than a hard protocol limit; three a
/// side is what the official clients use.
const ARRAYS_PER_SIDE: i64 = 3;

fn read_i32(d: &[u8], off: usize) -> i32 {
    i32::from_le_bytes(d[off..off + 4].try_into().expect("4 bytes"))
}
fn read_u16(d: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(d[off..off + 2].try_into().expect("2 bytes"))
}
fn read_pubkey(d: &[u8], off: usize) -> Pubkey {
    Pubkey::try_from(&d[off..off + 32]).expect("32 bytes")
}

/// The array holding `bin_id`. Floor division toward negative infinity — a truncating `/` puts
/// every negative bin in the wrong array, and negative active ids are ordinary here.
fn array_index_of(bin_id: i64) -> i64 {
    if bin_id >= 0 {
        bin_id / BINS_PER_ARRAY
    } else {
        -((-bin_id + BINS_PER_ARRAY - 1) / BINS_PER_ARRAY)
    }
}

/// `[b"bin_array", lb_pair, index as i64 little-endian]`.
fn bin_array_pda(lb_pair: &Pubkey, index: i64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"bin_array", lb_pair.as_ref(), &index.to_le_bytes()],
        &DLMM_PROGRAM,
    )
    .0
}

fn bitmap_extension_pda(lb_pair: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"bitmap", lb_pair.as_ref()], &DLMM_PROGRAM).0
}

fn event_authority_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &DLMM_PROGRAM).0
}

#[derive(Clone)]
pub struct MeteoraDlmmAmm {
    key: Pubkey,
    oracle: Pubkey,
    bitmap_extension: Pubkey,
    event_authority: Pubkey,
    token_x_mint: Pubkey,
    token_y_mint: Pubkey,
    reserve_x: Pubkey,
    reserve_y: Pubkey,
    active_id: i32,
    bin_step: u16,
    status: u8,
    clock_ref: ClockRef,

    /// Raw `LbPair` bytes: the engine decodes the pool from them directly, so they are kept
    /// rather than unpacked field by field.
    lb_pair_data: Vec<u8>,
    /// `(array_index, address)` for the arrays this Amm tracks, ascending.
    tracked_arrays: Vec<(i64, Pubkey)>,
    /// Only the arrays that actually exist on chain, with their raw bytes.
    loaded_arrays: Vec<(i64, Pubkey, Vec<u8>)>,
    mint_x_info: Option<MintInfo>,
    mint_y_info: Option<MintInfo>,
    x_is_token_2022: bool,
    y_is_token_2022: bool,
}

single_program_amm!(MeteoraDlmmAmm, DLMM_PROGRAM, "Meteora DLMM");

impl MeteoraDlmmAmm {
    fn tracked_indices(&self) -> Vec<i64> {
        let centre = array_index_of(self.active_id as i64);
        (-ARRAYS_PER_SIDE..=ARRAYS_PER_SIDE)
            .map(|i| centre + i)
            .collect()
    }

    /// Build the engine's pool view from the bytes currently held.
    fn pool_state(&self) -> Result<PoolState, AmmError> {
        let arrays: Vec<Vec<u8>> = self
            .loaded_arrays
            .iter()
            .map(|(_, _, bytes)| bytes.clone())
            .collect();
        let dec_x = self.mint_x_info.as_ref().map(|m| m.decimals).unwrap_or(0);
        let dec_y = self.mint_y_info.as_ref().map(|m| m.decimals).unwrap_or(0);
        PoolState::from_accounts(
            &self.lb_pair_data,
            &arrays,
            dec_x,
            dec_y,
            Some(&self.key.to_bytes()),
            // Not exhaustive: only a window around the active bin is carried, so a short fill
            // means under-fetched rather than drained, and `strict` turns that into an error.
            false,
        )
        .map_err(|e| AmmError::from(format!("dlmm decode failed: {e:?}")))
    }

    /// Bin arrays for the instruction's remaining accounts, in the direction of travel, and only
    /// those that exist: the program cannot traverse an account that was never created.
    fn instruction_bin_arrays(&self, swap_for_y: bool) -> Vec<Pubkey> {
        let centre = array_index_of(self.active_id as i64);
        let step: i64 = if swap_for_y { -1 } else { 1 };
        let mut out = Vec::new();
        for i in 0..=ARRAYS_PER_SIDE {
            let idx = centre + i * step;
            if let Some((_, address, _)) = self.loaded_arrays.iter().find(|(k, _, _)| *k == idx) {
                out.push(*address);
            } else {
                break;
            }
        }
        out
    }
}

impl Amm for MeteoraDlmmAmm {
    fn from_keyed_account(
        keyed_account: &KeyedAccount,
        amm_context: &AmmContext,
    ) -> Result<Self, AmmError> {
        if keyed_account.account.owner() != &Self::PROGRAM_ID {
            return Err(AmmError::from("account is not owned by Meteora DLMM"));
        }
        let d = keyed_account.account.data();
        if d.len() < LB_PAIR_LEN {
            return Err(AmmError::from(format!(
                "LbPair length {} < {LB_PAIR_LEN}",
                d.len()
            )));
        }
        if d[..8] != LB_PAIR_DISCRIMINATOR {
            return Err(AmmError::from("LbPair discriminator mismatch"));
        }

        let mut amm = Self {
            key: keyed_account.key,
            oracle: read_pubkey(d, OFF_ORACLE),
            bitmap_extension: bitmap_extension_pda(&keyed_account.key),
            event_authority: event_authority_pda(),
            token_x_mint: read_pubkey(d, OFF_TOKEN_X_MINT),
            token_y_mint: read_pubkey(d, OFF_TOKEN_Y_MINT),
            reserve_x: read_pubkey(d, OFF_RESERVE_X),
            reserve_y: read_pubkey(d, OFF_RESERVE_Y),
            active_id: read_i32(d, OFF_ACTIVE_ID),
            bin_step: read_u16(d, OFF_BIN_STEP),
            status: d[OFF_STATUS],
            clock_ref: amm_context.clock_ref.clone(),
            lb_pair_data: d.to_vec(),
            tracked_arrays: Vec::new(),
            loaded_arrays: Vec::new(),
            mint_x_info: None,
            mint_y_info: None,
            x_is_token_2022: false,
            y_is_token_2022: false,
        };
        amm.tracked_arrays = amm
            .tracked_indices()
            .into_iter()
            .map(|i| (i, bin_array_pda(&amm.key, i)))
            .collect();
        Ok(amm)
    }

    fn label(&self) -> AmmLabel {
        Self::LABEL
    }
    fn program_id(&self) -> Pubkey {
        Self::PROGRAM_ID
    }
    fn key(&self) -> Pubkey {
        self.key
    }
    fn get_reserve_mints(&self) -> Vec<Pubkey> {
        vec![self.token_x_mint, self.token_y_mint]
    }

    /// The window of bin arrays moves with the active bin.
    fn has_dynamic_accounts(&self) -> bool {
        true
    }

    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        let mut accounts = vec![
            self.key,
            self.token_x_mint,
            self.token_y_mint,
            self.reserve_x,
            self.reserve_y,
            self.bitmap_extension,
        ];
        accounts.extend(self.tracked_arrays.iter().map(|(_, k)| *k));
        accounts
    }

    fn update(&mut self, account_provider: impl AccountProvider) -> Result<(), AmmError> {
        if let Some(pool) = account_provider.get(&self.key) {
            let d = pool.data();
            if d.len() >= LB_PAIR_LEN && d[..8] == LB_PAIR_DISCRIMINATOR {
                self.active_id = read_i32(d, OFF_ACTIVE_ID);
                self.status = d[OFF_STATUS];
                self.lb_pair_data = d.to_vec();
            }
        }
        self.tracked_arrays = self
            .tracked_indices()
            .into_iter()
            .map(|i| (i, bin_array_pda(&self.key, i)))
            .collect();

        self.loaded_arrays.clear();
        for (index, address) in &self.tracked_arrays {
            if let Some(account) = account_provider.get(address) {
                if account.owner() == &Self::PROGRAM_ID && account.data().len() > 56 {
                    self.loaded_arrays
                        .push((*index, *address, account.data().to_vec()));
                }
            }
        }

        let mint_of = |mint: &Pubkey| -> (Option<MintInfo>, bool) {
            match account_provider.get(mint) {
                None => (None, false),
                Some(account) => {
                    let owner = *account.owner();
                    let is_2022 = owner == TOKEN_2022_PROGRAM;
                    (
                        parse_mint(account.data(), &owner.to_bytes()).ok(),
                        is_2022,
                    )
                }
            }
        };
        let (mx, x22) = mint_of(&self.token_x_mint);
        let (my, y22) = mint_of(&self.token_y_mint);
        self.mint_x_info = mx;
        self.mint_y_info = my;
        self.x_is_token_2022 = x22;
        self.y_is_token_2022 = y22;

        Ok(())
    }

    fn quote(&self, quote_params: &QuoteParams) -> Result<Quote, AmmError> {
        let swap_for_y = quote_params.input_mint == self.token_x_mint;
        if !swap_for_y && quote_params.input_mint != self.token_y_mint {
            return Err(AmmError::from("input mint is not in this pool"));
        }
        let (Some(mint_x), Some(mint_y)) = (&self.mint_x_info, &self.mint_y_info) else {
            return Err(AmmError::from("mints not loaded; call update first"));
        };
        if self.loaded_arrays.is_empty() {
            return Err(AmmError::from("no bin array loaded; call update first"));
        }

        let pool = self.pool_state()?;
        let timestamp = self.clock_ref.unix_timestamp.load(Ordering::Relaxed);

        let quote = quote_with_mints(
            &pool,
            quote_params.amount as u128,
            swap_for_y,
            mint_x,
            mint_y,
            timestamp,
            // Limit orders are a newer pool feature the engine does not model. Passing false is
            // the conservative reading; a pool that uses them will disagree with the chain and
            // the parity suite is what would say so.
            false,
            // strict: refuse to quote past the bin arrays actually carried, rather than return a
            // partial fill the transaction cannot reproduce.
            true,
        )
        .map_err(|e| AmmError::from(format!("dlmm quote failed: {e:?}")))?;

        if !quote.complete {
            return Err(AmmError::from("dlmm quote incomplete"));
        }
        let out = u64::try_from(quote.amount_out)
            .map_err(|_| AmmError::from("output exceeds u64"))?;

        Ok(Quote {
            in_amount: quote_params.amount,
            out_amount: out,
            fee_amount: 0,
            fee_mint: quote_params.input_mint,
            ..Default::default()
        })
    }

    fn get_swap_and_account_metas(
        &self,
        swap_params: &SwapParams,
    ) -> Result<SwapAndAccountMetas, AmmError> {
        let swap_for_y = swap_params.source_mint == self.token_x_mint;
        if !swap_for_y && swap_params.source_mint != self.token_y_mint {
            return Err(AmmError::from("source mint is not in this pool"));
        }
        let x_program = if self.x_is_token_2022 {
            TOKEN_2022_PROGRAM
        } else {
            TOKEN_PROGRAM
        };
        let y_program = if self.y_is_token_2022 {
            TOKEN_2022_PROGRAM
        } else {
            TOKEN_PROGRAM
        };

        // `swap` account order, from the official IDL. Optional accounts are filled with the
        // program id, which is how this program spells "absent". The newer `swap2` takes a
        // `remaining_accounts_info` argument whose encoding in the deployed program does not
        // match the SDK's IDL, and this adapter has no transfer-hook pools to justify it.
        let mut account_metas = vec![
            AccountMeta::new(self.key, false),
            AccountMeta::new_readonly(Self::PROGRAM_ID, false), // bin_array_bitmap_extension: none
            AccountMeta::new(self.reserve_x, false),
            AccountMeta::new(self.reserve_y, false),
            AccountMeta::new(swap_params.source_token_account, false),
            AccountMeta::new(swap_params.destination_token_account, false),
            AccountMeta::new_readonly(self.token_x_mint, false),
            AccountMeta::new_readonly(self.token_y_mint, false),
            AccountMeta::new(self.oracle, false),
            AccountMeta::new_readonly(Self::PROGRAM_ID, false), // host_fee_in: none
            AccountMeta::new_readonly(swap_params.token_transfer_authority, true),
            AccountMeta::new_readonly(x_program, false),
            AccountMeta::new_readonly(y_program, false),
            AccountMeta::new_readonly(self.event_authority, false),
            AccountMeta::new_readonly(Self::PROGRAM_ID, false),
        ];
        // Bin arrays ride in the remaining accounts, in the direction of travel.
        let arrays = self.instruction_bin_arrays(swap_for_y);
        if arrays.is_empty() {
            return Err(AmmError::from("no bin array exists for this pool"));
        }
        for a in &arrays {
            account_metas.push(AccountMeta::new(*a, false));
        }

        Ok(SwapAndAccountMetas {
            swap: Swap::Placeholder {
                data: Some(vec![arrays.len() as u8]),
            },
            account_metas,
        })
    }

    fn get_accounts_len(&self) -> usize {
        15 + ARRAYS_PER_SIDE as usize + 1
    }

    fn is_active(&self) -> bool {
        self.status == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Negative bin ids are ordinary in DLMM, and truncating division puts them in the wrong
    /// array. 70 bins per array.
    #[test]
    fn array_index_floors_toward_negative_infinity() {
        assert_eq!(array_index_of(0), 0);
        assert_eq!(array_index_of(69), 0);
        assert_eq!(array_index_of(70), 1);
        assert_eq!(array_index_of(139), 1);
        assert_eq!(array_index_of(-1), -1);
        assert_eq!(array_index_of(-70), -1);
        assert_eq!(array_index_of(-71), -2);
        assert_eq!(array_index_of(-140), -2);
        assert_eq!(array_index_of(-141), -3);
    }
}
