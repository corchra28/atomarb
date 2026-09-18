//! Raydium CPMM (`raydium-cp-swap`) as a Jupiter `Amm`.
//!
//! A Rust port of this repository's TypeScript adapter (`src/adapters/raydium_cpmm/`), which was
//! itself a line-by-line port of `raydium-cp-swap@59fb845`: `curve/fees.rs`,
//! `curve/calculator.rs`, `curve/constant_product.rs`, `states/pool.rs` and
//! `instructions/swap_base_input.rs`. Every rounding direction below mirrors the program.
//!
//! Correctness is asserted by `tests/raydium_cpmm.rs` through `jupiter-amm-test-kit`, which runs
//! the real mainnet program in LiteSVM and requires the realized on-chain token delta to equal
//! `quote()` exactly.
//!
//! Three details a naive implementation gets wrong, all of which the test pool exercises:
//!
//! 1. **Reserves are not vault balances.** `PoolState::vault_amount_without_fee` subtracts the
//!    accrued protocol, fund and creator fee counters from each vault.
//! 2. **The trading fee rounds up, the carve-outs round down.** `trading_fee` is a ceiling
//!    division; `protocol_fee` and `fund_fee` are floors taken *out of* that fee.
//! 3. **The creator fee is charged on the input or the output depending on `creator_fee_on` and
//!    the trade direction**, and when it is on the input it is split out of a single combined
//!    ceiling fee rather than computed separately.

use jupiter_amm_interface::{
    AccountProvider, Amm, AmmContext, AmmError, AmmLabel, ClockRef, KeyedAccount, Quote,
    QuoteParams, SingleProgramAmm, Swap, SwapAndAccountMetas, SwapParams, single_program_amm,
};
use solana_account::ReadableAccount;
use solana_instruction::AccountMeta;
use solana_pubkey::{Pubkey, pubkey};
use std::sync::atomic::Ordering;

pub const RAYDIUM_CPMM_PROGRAM: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// `AUTH_SEED` in `lib.rs`; the mainnet authority is `GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL`.
const AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";

/// `PoolState::LEN`, and `sha256("account:PoolState")[..8]`.
const POOL_STATE_LEN: usize = 637;
const POOL_STATE_DISCRIMINATOR: [u8; 8] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
/// `AmmConfig::LEN`, and `sha256("account:AmmConfig")[..8]`.
const AMM_CONFIG_LEN: usize = 236;
const AMM_CONFIG_DISCRIMINATOR: [u8; 8] = [0xda, 0xf4, 0x21, 0x68, 0xcb, 0xcb, 0x2b, 0x6f];

/// `FEE_RATE_DENOMINATOR_VALUE`.
const FEE_RATE_DENOMINATOR: u128 = 1_000_000;
/// Set bit 2 of `PoolState::status` means swapping is DISABLED.
const STATUS_SWAP_DISABLED: u8 = 4;

const MAX_FEE_BASIS_POINTS: u128 = 10_000;

// ---------------------------------------------------------------------------------------------
// Byte readers
// ---------------------------------------------------------------------------------------------

fn read_pubkey(d: &[u8], off: usize) -> Pubkey {
    Pubkey::try_from(&d[off..off + 32]).expect("32 bytes")
}
fn read_u64(d: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(d[off..off + 8].try_into().expect("8 bytes"))
}
fn read_u16(d: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(d[off..off + 2].try_into().expect("2 bytes"))
}

// ---------------------------------------------------------------------------------------------
// Token-2022 transfer fee
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Default, Debug)]
struct TransferFee {
    epoch: u64,
    maximum_fee: u64,
    basis_points: u16,
}

#[derive(Clone, Copy, Debug)]
struct TransferFeeConfig {
    older: TransferFee,
    newer: TransferFee,
}

impl TransferFeeConfig {
    /// `get_epoch_fee`: the newer schedule applies once the epoch reaches its activation epoch.
    fn for_epoch(&self, epoch: u64) -> TransferFee {
        if epoch >= self.newer.epoch {
            self.newer
        } else {
            self.older
        }
    }
}

/// Parse a `TransferFeeConfig` (extension type 1) out of a Token-2022 mint's TLV region.
/// Base mint is 82 bytes, then a 1-byte account type at 165, then TLV entries from 166.
fn parse_transfer_fee_config(data: &[u8]) -> Option<TransferFeeConfig> {
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
            // TransferFeeConfig: authority(32) withdraw_authority(32) withheld(8)
            //                    older TransferFee(18) newer TransferFee(18)
            if len < 108 {
                return None;
            }
            let v = &data[value..value + len];
            let fee_at = |o: usize| TransferFee {
                epoch: read_u64(v, o),
                maximum_fee: read_u64(v, o + 8),
                basis_points: read_u16(v, o + 16),
            };
            return Some(TransferFeeConfig {
                older: fee_at(72),
                newer: fee_at(90),
            });
        }
        cursor = value + len;
    }
    None
}

/// `TransferFee::calculate_fee`: `min(ceil(amount * bps / 10_000), maximum_fee)`.
fn calculate_transfer_fee(fee: &TransferFee, pre_fee_amount: u64) -> Option<u64> {
    let bps = fee.basis_points as u128;
    if bps == 0 || pre_fee_amount == 0 {
        return Some(0);
    }
    let numerator = (pre_fee_amount as u128).checked_mul(bps)?;
    let raw = numerator
        .checked_add(MAX_FEE_BASIS_POINTS)?
        .checked_sub(1)?
        .checked_div(MAX_FEE_BASIS_POINTS)?;
    let raw = u64::try_from(raw).ok()?;
    Some(raw.min(fee.maximum_fee))
}

/// The mint-side view the swap needs: which token program owns it, and its fee schedule.
#[derive(Clone, Copy, Debug)]
struct MintView {
    is_token_2022: bool,
    transfer_fee: Option<TransferFeeConfig>,
}

impl MintView {
    /// `raydium utils/token.rs::get_transfer_fee` — zero for legacy SPL Token and for a
    /// Token-2022 mint without the extension.
    fn transfer_fee(&self, epoch: u64, pre_fee_amount: u64) -> Result<u64, AmmError> {
        if !self.is_token_2022 {
            return Ok(0);
        }
        match self.transfer_fee {
            None => Ok(0),
            Some(cfg) => calculate_transfer_fee(&cfg.for_epoch(epoch), pre_fee_amount)
                .ok_or_else(|| AmmError::from("transfer fee calculation overflowed")),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Curve math — `curve/fees.rs` and `curve/constant_product.rs`
// ---------------------------------------------------------------------------------------------

/// `Fees::ceil_div(amount, num, den)`.
fn fee_ceil_div(amount: u128, num: u128, den: u128) -> Option<u128> {
    if den == 0 {
        return None;
    }
    amount
        .checked_mul(num)?
        .checked_add(den)?
        .checked_sub(1)?
        .checked_div(den)
}

/// `Fees::floor_div(amount, num, den)`.
fn fee_floor_div(amount: u128, num: u128, den: u128) -> Option<u128> {
    if den == 0 {
        return None;
    }
    amount.checked_mul(num)?.checked_div(den)
}

/// `swap_base_input_without_fees`: `floor(dx * y / (x + dx))`.
fn swap_base_input_without_fees(
    input_amount: u128,
    input_vault: u128,
    output_vault: u128,
) -> Option<u128> {
    let numerator = input_amount.checked_mul(output_vault)?;
    let denominator = input_vault.checked_add(input_amount)?;
    numerator.checked_div(denominator)
}

#[derive(Clone, Copy, Debug)]
struct FeeRates {
    trade: u128,
    creator: u128,
    protocol: u128,
    fund: u128,
}

#[derive(Debug)]
struct CurveResult {
    output_amount: u128,
    trade_fee: u128,
    creator_fee: u128,
    #[allow(dead_code)]
    protocol_fee: u128,
    #[allow(dead_code)]
    fund_fee: u128,
}

/// `CurveCalculator::swap_base_input`. `None` is the program's `ZeroTradingTokens` path.
fn curve_swap_base_input(
    input_amount: u128,
    input_vault: u128,
    output_vault: u128,
    r: &FeeRates,
    creator_fee_on_input: bool,
) -> Option<CurveResult> {
    let mut creator_fee: u128 = 0;
    let trade_fee: u128;
    let input_amount_less_fees: u128;

    if creator_fee_on_input {
        // One combined ceiling fee, then the creator's share floored out of it.
        let total_fee = fee_ceil_div(input_amount, r.trade + r.creator, FEE_RATE_DENOMINATOR)?;
        creator_fee = fee_floor_div(total_fee, r.creator, r.trade + r.creator)?;
        trade_fee = total_fee.checked_sub(creator_fee)?;
        input_amount_less_fees = input_amount.checked_sub(total_fee)?;
    } else {
        trade_fee = fee_ceil_div(input_amount, r.trade, FEE_RATE_DENOMINATOR)?;
        input_amount_less_fees = input_amount.checked_sub(trade_fee)?;
    }

    let protocol_fee = fee_floor_div(trade_fee, r.protocol, FEE_RATE_DENOMINATOR)?;
    let fund_fee = fee_floor_div(trade_fee, r.fund, FEE_RATE_DENOMINATOR)?;

    let output_swapped =
        swap_base_input_without_fees(input_amount_less_fees, input_vault, output_vault)?;

    let output_amount = if creator_fee_on_input {
        output_swapped
    } else {
        // Charged on the output side: a ceiling fee deducted from what the vault sends.
        creator_fee = fee_ceil_div(output_swapped, r.creator, FEE_RATE_DENOMINATOR)?;
        output_swapped.checked_sub(creator_fee)?
    };

    if output_vault < output_swapped {
        return None;
    }

    Some(CurveResult {
        output_amount,
        trade_fee,
        creator_fee,
        protocol_fee,
        fund_fee,
    })
}

// ---------------------------------------------------------------------------------------------
// The Amm
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct RaydiumCpmmAmm {
    key: Pubkey,
    authority: Pubkey,
    amm_config: Pubkey,
    token_0_vault: Pubkey,
    token_1_vault: Pubkey,
    token_0_mint: Pubkey,
    token_1_mint: Pubkey,
    token_0_program: Pubkey,
    token_1_program: Pubkey,
    observation_key: Pubkey,
    status: u8,
    open_time: u64,
    creator_fee_on: u8,
    enable_creator_fee: bool,
    /// Accrued, not tradeable: subtracted from the vaults to get the real reserves.
    accrued_fees_0: u64,
    accrued_fees_1: u64,
    clock_ref: ClockRef,

    // Filled by `update`.
    config_trade_fee_rate: u64,
    config_protocol_fee_rate: u64,
    config_fund_fee_rate: u64,
    config_creator_fee_rate: u64,
    vault_0_amount: u64,
    vault_1_amount: u64,
    mint_0_view: MintView,
    mint_1_view: MintView,
}

single_program_amm!(RaydiumCpmmAmm, RAYDIUM_CPMM_PROGRAM, "Raydium CP");

impl RaydiumCpmmAmm {
    fn is_token_2022(&self, program: &Pubkey) -> bool {
        program == &TOKEN_2022_PROGRAM
    }

    /// `PoolState::vault_amount_without_fee` — the tradeable balance of each vault.
    fn reserves(&self) -> Result<(u128, u128), AmmError> {
        let r0 = self
            .vault_0_amount
            .checked_sub(self.accrued_fees_0)
            .ok_or_else(|| AmmError::from("vault 0 cannot cover its accrued fees"))?;
        let r1 = self
            .vault_1_amount
            .checked_sub(self.accrued_fees_1)
            .ok_or_else(|| AmmError::from("vault 1 cannot cover its accrued fees"))?;
        Ok((r0 as u128, r1 as u128))
    }

    /// `PoolState::is_creator_fee_on_input`.
    fn creator_fee_on_input(&self, zero_for_one: bool) -> Result<bool, AmmError> {
        match self.creator_fee_on {
            0 => Ok(true),           // BothToken: always charged on the input
            1 => Ok(zero_for_one),   // OnlyToken0
            2 => Ok(!zero_for_one),  // OnlyToken1
            other => Err(AmmError::from(format!(
                "invalid creator_fee_on {other} (InvalidFeeModel)"
            ))),
        }
    }
}

impl Amm for RaydiumCpmmAmm {
    fn from_keyed_account(
        keyed_account: &KeyedAccount,
        amm_context: &AmmContext,
    ) -> Result<Self, AmmError> {
        if keyed_account.account.owner() != &Self::PROGRAM_ID {
            return Err(AmmError::from("pool is not owned by Raydium CPMM"));
        }
        let d = keyed_account.account.data();
        if d.len() != POOL_STATE_LEN {
            return Err(AmmError::from(format!(
                "PoolState length {} != {POOL_STATE_LEN}",
                d.len()
            )));
        }
        if d[..8] != POOL_STATE_DISCRIMINATOR {
            return Err(AmmError::from("PoolState discriminator mismatch"));
        }

        // Accrued fee counters: protocol (341/349), fund (357/365), creator (397/405).
        let accrued_fees_0 = read_u64(d, 341)
            .checked_add(read_u64(d, 357))
            .and_then(|s| s.checked_add(read_u64(d, 397)))
            .ok_or_else(|| AmmError::from("token 0 fee counters overflow u64"))?;
        let accrued_fees_1 = read_u64(d, 349)
            .checked_add(read_u64(d, 365))
            .and_then(|s| s.checked_add(read_u64(d, 405)))
            .ok_or_else(|| AmmError::from("token 1 fee counters overflow u64"))?;

        Ok(Self {
            key: keyed_account.key,
            authority: Pubkey::find_program_address(&[AUTH_SEED], &Self::PROGRAM_ID).0,
            amm_config: read_pubkey(d, 8),
            token_0_vault: read_pubkey(d, 72),
            token_1_vault: read_pubkey(d, 104),
            token_0_mint: read_pubkey(d, 168),
            token_1_mint: read_pubkey(d, 200),
            token_0_program: read_pubkey(d, 232),
            token_1_program: read_pubkey(d, 264),
            observation_key: read_pubkey(d, 296),
            status: d[329],
            open_time: read_u64(d, 373),
            creator_fee_on: d[389],
            enable_creator_fee: d[390] != 0,
            accrued_fees_0,
            accrued_fees_1,
            clock_ref: amm_context.clock_ref.clone(),
            config_trade_fee_rate: 0,
            config_protocol_fee_rate: 0,
            config_fund_fee_rate: 0,
            config_creator_fee_rate: 0,
            vault_0_amount: 0,
            vault_1_amount: 0,
            mint_0_view: MintView {
                is_token_2022: false,
                transfer_fee: None,
            },
            mint_1_view: MintView {
                is_token_2022: false,
                transfer_fee: None,
            },
        })
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
        vec![self.token_0_mint, self.token_1_mint]
    }

    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        let mut accounts = vec![self.amm_config, self.token_0_vault, self.token_1_vault];
        // Only Token-2022 mints carry a transfer fee that changes the quote.
        if self.is_token_2022(&self.token_0_program) {
            accounts.push(self.token_0_mint);
        }
        if self.is_token_2022(&self.token_1_program) {
            accounts.push(self.token_1_mint);
        }
        accounts
    }

    fn update(&mut self, account_provider: impl AccountProvider) -> Result<(), AmmError> {
        let config = account_provider
            .get(&self.amm_config)
            .ok_or_else(|| AmmError::from("missing amm_config account"))?;
        let c = config.data();
        if c.len() != AMM_CONFIG_LEN {
            return Err(AmmError::from(format!(
                "AmmConfig length {} != {AMM_CONFIG_LEN}",
                c.len()
            )));
        }
        if c[..8] != AMM_CONFIG_DISCRIMINATOR {
            return Err(AmmError::from("AmmConfig discriminator mismatch"));
        }
        self.config_trade_fee_rate = read_u64(c, 12);
        self.config_protocol_fee_rate = read_u64(c, 20);
        self.config_fund_fee_rate = read_u64(c, 28);
        self.config_creator_fee_rate = read_u64(c, 108);
        drop(config);

        let vault_amount = |vault: &Pubkey| -> Result<u64, AmmError> {
            let account = account_provider
                .get(vault)
                .ok_or_else(|| AmmError::from("missing vault account"))?;
            let data = account.data();
            if data.len() < 72 {
                return Err(AmmError::from("vault account too short"));
            }
            Ok(read_u64(data, 64))
        };
        self.vault_0_amount = vault_amount(&self.token_0_vault)?;
        self.vault_1_amount = vault_amount(&self.token_1_vault)?;

        let mint_view = |mint: &Pubkey, program: &Pubkey| -> MintView {
            let is_token_2022 = program == &TOKEN_2022_PROGRAM;
            let transfer_fee = if is_token_2022 {
                account_provider
                    .get(mint)
                    .and_then(|a| parse_transfer_fee_config(a.data()))
            } else {
                None
            };
            MintView {
                is_token_2022,
                transfer_fee,
            }
        };
        self.mint_0_view = mint_view(&self.token_0_mint, &self.token_0_program);
        self.mint_1_view = mint_view(&self.token_1_mint, &self.token_1_program);

        Ok(())
    }

    fn quote(&self, quote_params: &QuoteParams) -> Result<Quote, AmmError> {
        if !self.is_active() {
            return Err(AmmError::from("pool is not open for swaps"));
        }

        let zero_for_one = quote_params.input_mint == self.token_0_mint;
        if !zero_for_one && quote_params.input_mint != self.token_1_mint {
            return Err(AmmError::from("input mint is not in this pool"));
        }

        let epoch = self.clock_ref.epoch.load(Ordering::Relaxed);
        let (reserve_0, reserve_1) = self.reserves()?;
        let (reserve_in, reserve_out, mint_in, mint_out) = if zero_for_one {
            (reserve_0, reserve_1, self.mint_0_view, self.mint_1_view)
        } else {
            (reserve_1, reserve_0, self.mint_1_view, self.mint_0_view)
        };

        // Step 1: the pool only ever sees the amount that survives the input transfer fee.
        let transfer_fee_in = mint_in.transfer_fee(epoch, quote_params.amount)?;
        let actual_amount_in = quote_params.amount.saturating_sub(transfer_fee_in);
        if actual_amount_in == 0 {
            return Err(AmmError::from("amount_in is entirely consumed by the transfer fee"));
        }

        let creator_fee_rate = if self.enable_creator_fee {
            self.config_creator_fee_rate as u128
        } else {
            0
        };
        let rates = FeeRates {
            trade: self.config_trade_fee_rate as u128,
            creator: creator_fee_rate,
            protocol: self.config_protocol_fee_rate as u128,
            fund: self.config_fund_fee_rate as u128,
        };
        let on_input = self.creator_fee_on_input(zero_for_one)?;

        let result = curve_swap_base_input(
            actual_amount_in as u128,
            reserve_in,
            reserve_out,
            &rates,
            on_input,
        )
        .ok_or_else(|| AmmError::from("ZeroTradingTokens"))?;

        let amount_out = u64::try_from(result.output_amount)
            .map_err(|_| AmmError::from("output amount exceeds u64"))?;

        // Step 9: and the user only receives what survives the output transfer fee.
        let transfer_fee_out = mint_out.transfer_fee(epoch, amount_out)?;
        let amount_received = amount_out
            .checked_sub(transfer_fee_out)
            .ok_or_else(|| AmmError::from("output transfer fee exceeds the output"))?;
        if amount_received == 0 {
            return Err(AmmError::from("amount_received is zero"));
        }

        // The fee the taker pays on the input leg. When the creator fee is charged on the
        // output it is not part of this, because it is denominated in the output mint.
        let fee_amount = if on_input {
            result.trade_fee + result.creator_fee
        } else {
            result.trade_fee
        };

        Ok(Quote {
            in_amount: quote_params.amount,
            out_amount: amount_received,
            fee_amount: u64::try_from(fee_amount).unwrap_or(u64::MAX),
            fee_mint: quote_params.input_mint,
            ..Default::default()
        })
    }

    fn get_swap_and_account_metas(
        &self,
        swap_params: &SwapParams,
    ) -> Result<SwapAndAccountMetas, AmmError> {
        let zero_for_one = swap_params.source_mint == self.token_0_mint;
        if !zero_for_one && swap_params.source_mint != self.token_1_mint {
            return Err(AmmError::from("source mint is not in this pool"));
        }
        let (input_vault, output_vault, input_program, output_program, input_mint, output_mint) =
            if zero_for_one {
                (
                    self.token_0_vault,
                    self.token_1_vault,
                    self.token_0_program,
                    self.token_1_program,
                    self.token_0_mint,
                    self.token_1_mint,
                )
            } else {
                (
                    self.token_1_vault,
                    self.token_0_vault,
                    self.token_1_program,
                    self.token_0_program,
                    self.token_1_mint,
                    self.token_0_mint,
                )
            };

        // `swap_base_input` account order, from the program's `Swap` context.
        let account_metas = vec![
            AccountMeta::new_readonly(swap_params.token_transfer_authority, true), // payer
            AccountMeta::new_readonly(self.authority, false),
            AccountMeta::new_readonly(self.amm_config, false),
            AccountMeta::new(self.key, false),
            AccountMeta::new(swap_params.source_token_account, false),
            AccountMeta::new(swap_params.destination_token_account, false),
            AccountMeta::new(input_vault, false),
            AccountMeta::new(output_vault, false),
            AccountMeta::new_readonly(input_program, false),
            AccountMeta::new_readonly(output_program, false),
            AccountMeta::new_readonly(input_mint, false),
            AccountMeta::new_readonly(output_mint, false),
            AccountMeta::new(self.observation_key, false),
        ];

        Ok(SwapAndAccountMetas {
            swap: Swap::Placeholder { data: None },
            account_metas,
        })
    }

    fn get_accounts_len(&self) -> usize {
        13
    }

    /// Swapping is gated on status bit 2 being clear and on `open_time` having passed.
    fn is_active(&self) -> bool {
        let now = self.clock_ref.unix_timestamp.load(Ordering::Relaxed);
        (self.status & STATUS_SWAP_DISABLED) == 0 && (now as u64) >= self.open_time
    }
}
