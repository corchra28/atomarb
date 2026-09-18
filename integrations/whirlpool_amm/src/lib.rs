//! Orca Whirlpool as a Jupiter `Amm`.
//!
//! Chosen because the on-chain census in `docs/REAL_WORLD_MEV.md` found that 98 of 104 winning
//! atomic arbitrages include a concentrated-liquidity venue, and Whirlpool is the most frequent
//! at 59 routed hops — while the engine in this repository had no concentrated-liquidity adapter
//! at all.
//!
//! **The swap math is not reimplemented here.** Orca publishes `orca_whirlpools_core`, the same
//! crate their own SDK quotes with, and this calls `swap_quote_by_input_token` from it. Porting
//! several hundred lines of Q64.64 fixed-point tick-crossing math by hand would add a large
//! surface of subtle rounding bugs for no benefit. What this crate owns is the part an integrator
//! actually has to get right: decoding the accounts, deriving and supplying the correct tick
//! arrays, and building the native instruction. `tests/whirlpool.rs` proves that wiring against
//! the real program.
//!
//! Account layout verified byte-for-byte against `orca-so/whirlpools`
//! `programs/whirlpool/src/state/whirlpool.rs` and against live mainnet pools.

use jupiter_amm_interface::{
    AccountProvider, Amm, AmmContext, AmmError, AmmLabel, ClockRef, KeyedAccount, Quote,
    QuoteParams, SingleProgramAmm, Swap, SwapAndAccountMetas, SwapParams, single_program_amm,
};
use orca_whirlpools_core::{
    TickArrayFacade, TickArrays, TickFacade, TransferFee, WhirlpoolFacade,
    WhirlpoolRewardInfoFacade, swap_quote_by_input_token,
};
use solana_account::ReadableAccount;
use solana_instruction::AccountMeta;
use solana_pubkey::{Pubkey, pubkey};
use std::sync::atomic::Ordering;

pub const WHIRLPOOL_PROGRAM: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const MEMO_PROGRAM: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/// `Whirlpool::LEN`, and `sha256("account:Whirlpool")[..8]`.
const WHIRLPOOL_LEN: usize = 653;
const WHIRLPOOL_DISCRIMINATOR: [u8; 8] = [0x3f, 0x95, 0xd1, 0x0c, 0xe1, 0x80, 0x63, 0x09];

/// `TickArray::LEN` = 8 + 4 + 88 * 113 + 32, and `Tick::LEN`.
const TICK_ARRAY_LEN: usize = 9988;
const TICK_ARRAY_SIZE: usize = 88;
const TICK_LEN: usize = 113;

/// How many tick arrays to carry on each side of the current one. The native instruction takes
/// three, so two beyond the current array is what a swap can actually traverse.
const ARRAYS_PER_SIDE: i32 = 2;

// ---------------------------------------------------------------------------------------------
// Byte readers
// ---------------------------------------------------------------------------------------------

fn read_pubkey(d: &[u8], off: usize) -> Pubkey {
    Pubkey::try_from(&d[off..off + 32]).expect("32 bytes")
}
fn read_u16(d: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(d[off..off + 2].try_into().expect("2 bytes"))
}
fn read_i32(d: &[u8], off: usize) -> i32 {
    i32::from_le_bytes(d[off..off + 4].try_into().expect("4 bytes"))
}
fn read_u64(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().expect("8 bytes"))
}
fn read_u128(d: &[u8], off: usize) -> u128 {
    u128::from_le_bytes(d[off..off + 16].try_into().expect("16 bytes"))
}
fn read_i128(d: &[u8], off: usize) -> i128 {
    i128::from_le_bytes(d[off..off + 16].try_into().expect("16 bytes"))
}

// ---------------------------------------------------------------------------------------------
// Tick array addressing
// ---------------------------------------------------------------------------------------------

/// The start tick of the array containing `tick_index`. Floor division toward negative infinity,
/// which is what `Tick::start_tick_index` does and what a truncating `/` would get wrong for
/// negative ticks — and every SOL/USDC pool sits at a negative tick.
fn array_start_tick(tick_index: i32, tick_spacing: u16) -> i32 {
    let ticks_in_array = TICK_ARRAY_SIZE as i32 * tick_spacing as i32;
    let mut start = tick_index / ticks_in_array;
    if tick_index < 0 && tick_index % ticks_in_array != 0 {
        start -= 1;
    }
    start * ticks_in_array
}

/// `[b"tick_array", whirlpool, start_tick_index.to_string()]` — note the start tick is seeded as
/// its **decimal string**, not its bytes.
fn tick_array_pda(whirlpool: &Pubkey, start_tick_index: i32) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"tick_array",
            whirlpool.as_ref(),
            start_tick_index.to_string().as_bytes(),
        ],
        &WHIRLPOOL_PROGRAM,
    )
    .0
}

fn oracle_pda(whirlpool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"oracle", whirlpool.as_ref()], &WHIRLPOOL_PROGRAM).0
}

/// An array that does not exist on chain is a valid state: it simply has no initialised ticks.
fn empty_tick_array(start_tick_index: i32) -> TickArrayFacade {
    TickArrayFacade {
        start_tick_index,
        ticks: [TickFacade {
            initialized: false,
            liquidity_net: 0,
            liquidity_gross: 0,
            fee_growth_outside_a: 0,
            fee_growth_outside_b: 0,
            reward_growths_outside: [0; 3],
        }; TICK_ARRAY_SIZE],
    }
}

fn decode_tick_array(data: &[u8], expected_start: i32) -> TickArrayFacade {
    if data.len() != TICK_ARRAY_LEN {
        return empty_tick_array(expected_start);
    }
    let start_tick_index = read_i32(data, 8);
    let mut ticks = [TickFacade {
        initialized: false,
        liquidity_net: 0,
        liquidity_gross: 0,
        fee_growth_outside_a: 0,
        fee_growth_outside_b: 0,
        reward_growths_outside: [0; 3],
    }; TICK_ARRAY_SIZE];
    for (i, tick) in ticks.iter_mut().enumerate() {
        // Tick: initialized(1) liquidity_net(i128) liquidity_gross(u128)
        //       fee_growth_outside_a(u128) fee_growth_outside_b(u128) rewards(3 * u128)
        let o = 12 + i * TICK_LEN;
        tick.initialized = data[o] != 0;
        tick.liquidity_net = read_i128(data, o + 1);
        tick.liquidity_gross = read_u128(data, o + 17);
        tick.fee_growth_outside_a = read_u128(data, o + 33);
        tick.fee_growth_outside_b = read_u128(data, o + 49);
        for r in 0..3 {
            tick.reward_growths_outside[r] = read_u128(data, o + 65 + r * 16);
        }
    }
    TickArrayFacade {
        start_tick_index,
        ticks,
    }
}

// ---------------------------------------------------------------------------------------------
// Token-2022 transfer fee
// ---------------------------------------------------------------------------------------------

fn parse_transfer_fee(data: &[u8], epoch: u64) -> Option<TransferFee> {
    if data.len() <= 166 || data[165] != 1 {
        return None;
    }
    let mut cursor = 166usize;
    while cursor + 4 <= data.len() {
        let ext_type = read_u16(data, cursor);
        let len = read_u16(data, cursor + 2) as usize;
        let value = cursor + 4;
        if value + len > data.len() {
            return None;
        }
        if ext_type == 1 {
            if len < 108 {
                return None;
            }
            let v = &data[value..value + len];
            // older at 72, newer at 90; each is epoch(8) maximum_fee(8) basis_points(2)
            let (epoch_off, max_off, bps_off) = if epoch >= read_u64(v, 90) {
                (90, 98, 106)
            } else {
                (72, 80, 88)
            };
            let _ = epoch_off;
            return Some(TransferFee {
                fee_bps: read_u16(v, bps_off),
                max_fee: read_u64(v, max_off),
            });
        }
        cursor = value + len;
    }
    None
}

// ---------------------------------------------------------------------------------------------
// The Amm
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct WhirlpoolAmm {
    key: Pubkey,
    oracle: Pubkey,
    token_mint_a: Pubkey,
    token_mint_b: Pubkey,
    token_vault_a: Pubkey,
    token_vault_b: Pubkey,
    tick_spacing: u16,
    fee_tier_index_seed: [u8; 2],
    fee_rate: u16,
    protocol_fee_rate: u16,
    liquidity: u128,
    sqrt_price: u128,
    tick_current_index: i32,
    fee_growth_global_a: u128,
    fee_growth_global_b: u128,
    reward_last_updated_timestamp: u64,
    clock_ref: ClockRef,

    /// `(start_tick_index, address)`, ascending by start tick, spanning the current array plus
    /// `ARRAYS_PER_SIDE` on each side.
    tick_array_addresses: Vec<(i32, Pubkey)>,
    tick_array_facades: Vec<TickArrayFacade>,
    transfer_fee_a: Option<TransferFee>,
    transfer_fee_b: Option<TransferFee>,
}

single_program_amm!(WhirlpoolAmm, WHIRLPOOL_PROGRAM, "Orca Whirlpool");

impl WhirlpoolAmm {
    fn facade(&self) -> WhirlpoolFacade {
        WhirlpoolFacade {
            fee_tier_index_seed: self.fee_tier_index_seed,
            tick_spacing: self.tick_spacing,
            fee_rate: self.fee_rate,
            protocol_fee_rate: self.protocol_fee_rate,
            liquidity: self.liquidity,
            sqrt_price: self.sqrt_price,
            tick_current_index: self.tick_current_index,
            fee_growth_global_a: self.fee_growth_global_a,
            fee_growth_global_b: self.fee_growth_global_b,
            reward_last_updated_timestamp: self.reward_last_updated_timestamp,
            reward_infos: [WhirlpoolRewardInfoFacade::default(); 3],
        }
    }

    /// The start ticks this Amm tracks, ascending.
    fn tracked_start_ticks(&self) -> Vec<i32> {
        let ticks_in_array = TICK_ARRAY_SIZE as i32 * self.tick_spacing as i32;
        let current = array_start_tick(self.tick_current_index, self.tick_spacing);
        (-ARRAYS_PER_SIDE..=ARRAYS_PER_SIDE)
            .map(|i| current + i * ticks_in_array)
            .collect()
    }

    /// The three arrays the native instruction wants, ordered in the direction of travel:
    /// the current array first, then onward.
    fn instruction_tick_arrays(&self, a_to_b: bool) -> Vec<Pubkey> {
        let ticks_in_array = TICK_ARRAY_SIZE as i32 * self.tick_spacing as i32;
        let current = array_start_tick(self.tick_current_index, self.tick_spacing);
        let step = if a_to_b { -ticks_in_array } else { ticks_in_array };
        (0..3)
            .map(|i| tick_array_pda(&self.key, current + i * step))
            .collect()
    }
}

impl Amm for WhirlpoolAmm {
    fn from_keyed_account(
        keyed_account: &KeyedAccount,
        amm_context: &AmmContext,
    ) -> Result<Self, AmmError> {
        if keyed_account.account.owner() != &Self::PROGRAM_ID {
            return Err(AmmError::from("account is not owned by Whirlpool"));
        }
        let d = keyed_account.account.data();
        if d.len() != WHIRLPOOL_LEN {
            return Err(AmmError::from(format!(
                "Whirlpool length {} != {WHIRLPOOL_LEN}",
                d.len()
            )));
        }
        if d[..8] != WHIRLPOOL_DISCRIMINATOR {
            return Err(AmmError::from("Whirlpool discriminator mismatch"));
        }

        let mut amm = Self {
            key: keyed_account.key,
            oracle: oracle_pda(&keyed_account.key),
            tick_spacing: read_u16(d, 41),
            fee_tier_index_seed: [d[43], d[44]],
            fee_rate: read_u16(d, 45),
            protocol_fee_rate: read_u16(d, 47),
            liquidity: read_u128(d, 49),
            sqrt_price: read_u128(d, 65),
            tick_current_index: read_i32(d, 81),
            token_mint_a: read_pubkey(d, 101),
            token_vault_a: read_pubkey(d, 133),
            fee_growth_global_a: read_u128(d, 165),
            token_mint_b: read_pubkey(d, 181),
            token_vault_b: read_pubkey(d, 213),
            fee_growth_global_b: read_u128(d, 245),
            reward_last_updated_timestamp: read_u64(d, 261),
            clock_ref: amm_context.clock_ref.clone(),
            tick_array_addresses: Vec::new(),
            tick_array_facades: Vec::new(),
            transfer_fee_a: None,
            transfer_fee_b: None,
        };

        // An adaptive-fee pool prices through an Oracle account this crate does not read yet.
        // Refusing is better than quoting it with the static fee and being quietly wrong.
        if read_u16(d, 43) != amm.tick_spacing {
            return Err(AmmError::from(
                "adaptive-fee pool: fee_tier_index != tick_spacing, not supported yet",
            ));
        }

        amm.tick_array_addresses = amm
            .tracked_start_ticks()
            .into_iter()
            .map(|start| (start, tick_array_pda(&amm.key, start)))
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
        vec![self.token_mint_a, self.token_mint_b]
    }

    /// The set moves with the price, so this is not constant.
    fn has_dynamic_accounts(&self) -> bool {
        true
    }

    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        let mut accounts = vec![
            self.key,
            self.token_mint_a,
            self.token_mint_b,
            self.token_vault_a,
            self.token_vault_b,
        ];
        accounts.extend(self.tick_array_addresses.iter().map(|(_, k)| *k));
        accounts
    }

    fn update(&mut self, account_provider: impl AccountProvider) -> Result<(), AmmError> {
        // Re-read the pool itself: the price moves, and with it which tick arrays matter.
        if let Some(pool) = account_provider.get(&self.key) {
            let d = pool.data();
            if d.len() == WHIRLPOOL_LEN && d[..8] == WHIRLPOOL_DISCRIMINATOR {
                self.liquidity = read_u128(d, 49);
                self.sqrt_price = read_u128(d, 65);
                self.tick_current_index = read_i32(d, 81);
                self.fee_growth_global_a = read_u128(d, 165);
                self.fee_growth_global_b = read_u128(d, 245);
                self.reward_last_updated_timestamp = read_u64(d, 261);
            }
        }
        self.tick_array_addresses = self
            .tracked_start_ticks()
            .into_iter()
            .map(|start| (start, tick_array_pda(&self.key, start)))
            .collect();

        self.tick_array_facades = self
            .tick_array_addresses
            .iter()
            .map(|(start, address)| match account_provider.get(address) {
                Some(account) => decode_tick_array(account.data(), *start),
                None => empty_tick_array(*start),
            })
            .collect();

        let epoch = self.clock_ref.epoch.load(Ordering::Relaxed);
        let fee_of = |mint: &Pubkey| -> Option<TransferFee> {
            let account = account_provider.get(mint)?;
            if account.owner() != &TOKEN_2022_PROGRAM {
                return None;
            }
            parse_transfer_fee(account.data(), epoch)
        };
        self.transfer_fee_a = fee_of(&self.token_mint_a);
        self.transfer_fee_b = fee_of(&self.token_mint_b);

        Ok(())
    }

    fn quote(&self, quote_params: &QuoteParams) -> Result<Quote, AmmError> {
        let specified_token_a = quote_params.input_mint == self.token_mint_a;
        if !specified_token_a && quote_params.input_mint != self.token_mint_b {
            return Err(AmmError::from("input mint is not in this pool"));
        }
        if self.tick_array_facades.len() < 5 {
            return Err(AmmError::from("tick arrays not loaded; call update first"));
        }

        // Exactly the three arrays the native instruction will carry, in the direction of
        // travel. Supplying more would let the quote traverse further than the on-chain swap
        // possibly can, which would be a quote the program cannot honour.
        let a_to_b = specified_token_a;
        let ticks_in_array = TICK_ARRAY_SIZE as i32 * self.tick_spacing as i32;
        let current = array_start_tick(self.tick_current_index, self.tick_spacing);
        let step = if a_to_b { -ticks_in_array } else { ticks_in_array };
        let pick = |i: i32| -> TickArrayFacade {
            let start = current + i * step;
            self.tick_array_facades
                .iter()
                .find(|f| f.start_tick_index == start)
                .copied()
                .unwrap_or_else(|| empty_tick_array(start))
        };
        // `TickArraySequence::new` sorts these itself and requires them evenly spaced, so the
        // order here is irrelevant to it — but the set must match the instruction exactly.
        let arrays = TickArrays::Three(pick(0), pick(1), pick(2));

        let timestamp = self.clock_ref.unix_timestamp.load(Ordering::Relaxed) as u64;

        let quote = swap_quote_by_input_token(
            quote_params.amount,
            specified_token_a,
            0, // slippage is the caller's business; the parity test needs the exact figure
            self.facade(),
            None,
            arrays,
            timestamp,
            self.transfer_fee_a,
            self.transfer_fee_b,
        )
        .map_err(|e| AmmError::from(format!("whirlpool swap quote failed: {e:?}")))?;

        Ok(Quote {
            in_amount: quote.token_in,
            out_amount: quote.token_est_out,
            fee_amount: quote.trade_fee,
            fee_mint: quote_params.input_mint,
            ..Default::default()
        })
    }

    fn get_swap_and_account_metas(
        &self,
        swap_params: &SwapParams,
    ) -> Result<SwapAndAccountMetas, AmmError> {
        let a_to_b = swap_params.source_mint == self.token_mint_a;
        if !a_to_b && swap_params.source_mint != self.token_mint_b {
            return Err(AmmError::from("source mint is not in this pool"));
        }
        let (owner_a, owner_b) = if a_to_b {
            (
                swap_params.source_token_account,
                swap_params.destination_token_account,
            )
        } else {
            (
                swap_params.destination_token_account,
                swap_params.source_token_account,
            )
        };
        let arrays = self.instruction_tick_arrays(a_to_b);

        // `swap_v2` account order, from the program's SwapV2 context.
        let account_metas = vec![
            AccountMeta::new_readonly(
                if self.transfer_fee_a.is_some() {
                    TOKEN_2022_PROGRAM
                } else {
                    spl_token_program()
                },
                false,
            ),
            AccountMeta::new_readonly(
                if self.transfer_fee_b.is_some() {
                    TOKEN_2022_PROGRAM
                } else {
                    spl_token_program()
                },
                false,
            ),
            AccountMeta::new_readonly(MEMO_PROGRAM, false),
            AccountMeta::new_readonly(swap_params.token_transfer_authority, true),
            AccountMeta::new(self.key, false),
            AccountMeta::new_readonly(self.token_mint_a, false),
            AccountMeta::new_readonly(self.token_mint_b, false),
            AccountMeta::new(owner_a, false),
            AccountMeta::new(self.token_vault_a, false),
            AccountMeta::new(owner_b, false),
            AccountMeta::new(self.token_vault_b, false),
            AccountMeta::new(arrays[0], false),
            AccountMeta::new(arrays[1], false),
            AccountMeta::new(arrays[2], false),
            AccountMeta::new(self.oracle, false),
        ];

        // The encoder needs to know the direction; nothing else.
        Ok(SwapAndAccountMetas {
            swap: Swap::Placeholder {
                data: Some(vec![a_to_b as u8]),
            },
            account_metas,
        })
    }

    fn get_accounts_len(&self) -> usize {
        15
    }

    fn is_active(&self) -> bool {
        self.liquidity > 0
    }
}

fn spl_token_program() -> Pubkey {
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Negative ticks are where this goes wrong with truncating division, and every SOL/USDC
    /// pool sits at a negative tick.
    #[test]
    fn array_start_tick_floors_toward_negative_infinity() {
        // tick_spacing 64 -> 5632 ticks per array
        assert_eq!(array_start_tick(0, 64), 0);
        assert_eq!(array_start_tick(5631, 64), 0);
        assert_eq!(array_start_tick(5632, 64), 5632);
        assert_eq!(array_start_tick(-1, 64), -5632);
        assert_eq!(array_start_tick(-5632, 64), -5632);
        assert_eq!(array_start_tick(-5633, 64), -11264);
        // the real SOL/USDC tick, spacing 4 -> 352 per array
        assert_eq!(array_start_tick(-21762, 4), -21824);
    }
}
