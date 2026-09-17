/**
 * Raydium CPMM swap math — a line-by-line port of raydium-cp-swap@59fb845 `curve/fees.rs`, `curve/calculator.rs`,
 * `curve/constant_product.rs`, `utils/math.rs`, `states/pool.rs`, `utils/token.rs` and `instructions/swap_base_{input,output}.rs`
 * (docs/sources/raydium_cpmm.md §5) plus the Token-2022 TransferFee math (docs/sources/token2022.md §4, raydium_cpmm.md §12.4).
 *
 * Conventions: every amount is a bigint. Where the program uses `checked_*` and returns `None` we return `null`; where the program
 * `unwrap()`s (would panic / abort the tx) we throw OverflowError. Rounding direction is stated at each step and mirrors the source.
 */
import { U64_MAX, U128_MAX, OverflowError } from '../../util/bigint.js'
import { FEE_RATE_DENOMINATOR, CREATOR_FEE_ON, type PoolState, type AmmConfig } from './layout.js'

export type TradeDirection = 'ZeroForOne' | 'OneForZero'
export interface FeeRates { tradeFeeRate: bigint; creatorFeeRate: bigint; protocolFeeRate: bigint; fundFeeRate: bigint }

const inU128 = (x: bigint): bigint | null => (x < 0n || x > U128_MAX ? null : x)

// ---------------------------------------------------------------------------------------------------------------------
// §5.2 curve/fees.rs
// ---------------------------------------------------------------------------------------------------------------------
/** `ceil_div(token_amount, num, den) = token_amount.checked_mul(num)?.checked_add(den)?.checked_sub(1)?.checked_div(den)`; None if den == 0. */
export function feeCeilDiv(tokenAmount: bigint, num: bigint, den: bigint): bigint | null {
  if (den === 0n) return null
  const m = inU128(tokenAmount * num); if (m === null) return null
  const a = inU128(m + den); if (a === null) return null
  return (a - 1n) / den
}
/** `floor_div(token_amount, num, den) = token_amount.checked_mul(num)?.checked_div(den)`; None if den == 0. */
export function feeFloorDiv(tokenAmount: bigint, num: bigint, den: bigint): bigint | null {
  if (den === 0n) return null
  const m = inU128(tokenAmount * num); if (m === null) return null
  return m / den
}
/** `Fees::trading_fee` — CEIL. */
export const tradingFee = (amount: bigint, tradeFeeRate: bigint): bigint | null => feeCeilDiv(amount, tradeFeeRate, FEE_RATE_DENOMINATOR)
/** `Fees::protocol_fee(trade_fee, rate)` — FLOOR, carved out of the trade fee. */
export const protocolFeeOf = (tradeFee: bigint, protocolFeeRate: bigint): bigint | null => feeFloorDiv(tradeFee, protocolFeeRate, FEE_RATE_DENOMINATOR)
/** `Fees::fund_fee(trade_fee, rate)` — FLOOR, carved out of the trade fee. */
export const fundFeeOf = (tradeFee: bigint, fundFeeRate: bigint): bigint | null => feeFloorDiv(tradeFee, fundFeeRate, FEE_RATE_DENOMINATOR)
/** `Fees::creator_fee` — CEIL (used when the creator fee is taken on the OUTPUT side). */
export const creatorFeeOf = (amount: bigint, creatorFeeRate: bigint): bigint | null => feeCeilDiv(amount, creatorFeeRate, FEE_RATE_DENOMINATOR)
/** `Fees::split_creator_fee(total_fee, trade_rate, creator_rate) = floor(total_fee * creator_rate / (trade_rate + creator_rate))`. */
export const splitCreatorFee = (totalFee: bigint, tradeFeeRate: bigint, creatorFeeRate: bigint): bigint | null => feeFloorDiv(totalFee, creatorFeeRate, tradeFeeRate + creatorFeeRate)
/** `Fees::calculate_pre_fee_amount(post, rate)`: rate==0 → post; else ceil(post*1e6 / (1e6 - rate)) with u128 checks. */
export function calculatePreFeeAmount(postFeeAmount: bigint, rate: bigint): bigint | null {
  if (rate === 0n) return postFeeAmount
  const numerator = inU128(postFeeAmount * FEE_RATE_DENOMINATOR); if (numerator === null) return null
  const denominator = FEE_RATE_DENOMINATOR - rate; if (denominator < 0n) return null // checked_sub
  const a = inU128(numerator + denominator); if (a === null) return null
  if (denominator === 0n) return null // checked_div
  return (a - 1n) / denominator
}

// ---------------------------------------------------------------------------------------------------------------------
// §5.3 step 5 curve/constant_product.rs + utils/math.rs (these unwrap() → panic; modelled as throw)
// ---------------------------------------------------------------------------------------------------------------------
/** `swap_base_input_without_fees`: out = floor(Δx · y / (x + Δx)), native u128 checked ops with unwrap(). */
export function swapBaseInputWithoutFees(inputAmount: bigint, inputVaultAmount: bigint, outputVaultAmount: bigint): bigint {
  const numerator = inputAmount * outputVaultAmount
  if (numerator > U128_MAX) throw new OverflowError('swap_base_input_without_fees: input_amount*output_vault exceeds u128 (checked_mul unwrap)')
  const denominator = inputVaultAmount + inputAmount
  if (denominator > U128_MAX) throw new OverflowError('swap_base_input_without_fees: input_vault+input_amount exceeds u128 (checked_add unwrap)')
  if (denominator === 0n) throw new OverflowError('swap_base_input_without_fees: division by zero (checked_div unwrap)')
  return numerator / denominator
}
/** `swap_base_output_without_fees`: in = ceil(x · Δy / (y − Δy)) via `checked_ceil_div` (utils/math.rs). */
export function swapBaseOutputWithoutFees(outputAmount: bigint, inputVaultAmount: bigint, outputVaultAmount: bigint): bigint {
  const numerator = inputVaultAmount * outputAmount
  if (numerator > U128_MAX) throw new OverflowError('swap_base_output_without_fees: input_vault*output_amount exceeds u128 (checked_mul unwrap)')
  const denominator = outputVaultAmount - outputAmount
  if (denominator < 0n) throw new OverflowError('swap_base_output_without_fees: output_amount > output_vault (checked_sub unwrap)')
  if (denominator === 0n) throw new OverflowError('swap_base_output_without_fees: division by zero (checked_ceil_div unwrap)')
  const q = numerator / denominator
  const r = numerator % denominator
  const out = r !== 0n ? q + 1n : q
  if (out > U128_MAX) throw new OverflowError('checked_ceil_div: quotient+1 exceeds u128')
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// §5.3 step 5 / §5.4 curve/calculator.rs
// ---------------------------------------------------------------------------------------------------------------------
export interface CurveResult {
  newInputVaultAmount: bigint
  newOutputVaultAmount: bigint
  /** user's input (base-input: excludes Token-2022 transfer fee, includes trade fees) */
  inputAmount: bigint
  /** amount transferred from the vault to the user BEFORE the Token-2022 output transfer fee (net of creator fee on output) */
  outputAmount: bigint
  tradeFee: bigint
  protocolFee: bigint
  fundFee: bigint
  creatorFee: bigint
  /** extra (not in the Rust struct, derived from the same locals): amount that actually hit the curve / left the curve */
  inputAmountLessFees: bigint
  outputAmountSwapped: bigint
}

/** `CurveCalculator::swap_base_input` — returns null where the program returns None (→ ErrorCode::ZeroTradingTokens 6006); throws where it panics. */
export function curveSwapBaseInput(inputAmount: bigint, inputVaultAmount: bigint, outputVaultAmount: bigint, r: FeeRates, isCreatorFeeOnInput: boolean): CurveResult | null {
  let creatorFee = 0n
  let tradeFee: bigint
  let inputAmountLessFees: bigint
  if (isCreatorFeeOnInput) {
    // total = ceil(in * (trade+creator)); creator = floor(total * creator / (trade+creator)); trade = total - creator  (§5.3 step 5)
    const totalFee = tradingFee(inputAmount, r.tradeFeeRate + r.creatorFeeRate); if (totalFee === null) return null
    const cf = splitCreatorFee(totalFee, r.tradeFeeRate, r.creatorFeeRate); if (cf === null) return null
    creatorFee = cf
    tradeFee = totalFee - creatorFee
    if (inputAmount < totalFee) return null // checked_sub
    inputAmountLessFees = inputAmount - totalFee
  } else {
    const tf = tradingFee(inputAmount, r.tradeFeeRate); if (tf === null) return null
    tradeFee = tf
    if (inputAmount < tradeFee) return null
    inputAmountLessFees = inputAmount - tradeFee
  }
  const protocolFee = protocolFeeOf(tradeFee, r.protocolFeeRate); if (protocolFee === null) return null
  const fundFee = fundFeeOf(tradeFee, r.fundFeeRate); if (fundFee === null) return null
  const outputAmountSwapped = swapBaseInputWithoutFees(inputAmountLessFees, inputVaultAmount, outputVaultAmount)
  let outputAmount: bigint
  if (isCreatorFeeOnInput) outputAmount = outputAmountSwapped
  else {
    const cf = creatorFeeOf(outputAmountSwapped, r.creatorFeeRate); if (cf === null) return null
    creatorFee = cf
    if (outputAmountSwapped < creatorFee) return null
    outputAmount = outputAmountSwapped - creatorFee
  }
  const newInputVaultAmount = inU128(inputVaultAmount + inputAmountLessFees); if (newInputVaultAmount === null) return null
  if (outputVaultAmount < outputAmountSwapped) return null
  return { newInputVaultAmount, newOutputVaultAmount: outputVaultAmount - outputAmountSwapped, inputAmount, outputAmount, tradeFee, protocolFee, fundFee, creatorFee, inputAmountLessFees, outputAmountSwapped }
}

/** `CurveCalculator::swap_base_output` (§5.4). `output_amount` here is the amount the vault must send (incl. Token-2022 output transfer fee). */
export function curveSwapBaseOutput(outputAmount: bigint, inputVaultAmount: bigint, outputVaultAmount: bigint, r: FeeRates, isCreatorFeeOnInput: boolean): CurveResult | null {
  let tradeFee: bigint
  let creatorFee = 0n
  let actualOutputAmount: bigint
  if (isCreatorFeeOnInput) actualOutputAmount = outputAmount
  else {
    const w = calculatePreFeeAmount(outputAmount, r.creatorFeeRate); if (w === null) return null
    creatorFee = w - outputAmount
    actualOutputAmount = w
  }
  const inputAmountSwapped = swapBaseOutputWithoutFees(actualOutputAmount, inputVaultAmount, outputVaultAmount)
  let inputAmount: bigint
  if (isCreatorFeeOnInput) {
    const w = calculatePreFeeAmount(inputAmountSwapped, r.tradeFeeRate + r.creatorFeeRate)
    if (w === null) throw new OverflowError('swap_base_output: calculate_pre_fee_amount(trade+creator) unwrap')
    const totalFee = w - inputAmountSwapped
    const cf = splitCreatorFee(totalFee, r.tradeFeeRate, r.creatorFeeRate); if (cf === null) return null
    creatorFee = cf
    tradeFee = totalFee - creatorFee
    inputAmount = w
  } else {
    const w = calculatePreFeeAmount(inputAmountSwapped, r.tradeFeeRate)
    if (w === null) throw new OverflowError('swap_base_output: calculate_pre_fee_amount(trade) unwrap')
    tradeFee = w - inputAmountSwapped
    inputAmount = w
  }
  const protocolFee = protocolFeeOf(tradeFee, r.protocolFeeRate); if (protocolFee === null) return null
  const fundFee = fundFeeOf(tradeFee, r.fundFeeRate); if (fundFee === null) return null
  const newInputVaultAmount = inU128(inputVaultAmount + inputAmountSwapped); if (newInputVaultAmount === null) return null
  if (outputVaultAmount < actualOutputAmount) return null
  return { newInputVaultAmount, newOutputVaultAmount: outputVaultAmount - actualOutputAmount, inputAmount, outputAmount, tradeFee, protocolFee, fundFee, creatorFee, inputAmountLessFees: inputAmountSwapped, outputAmountSwapped: actualOutputAmount }
}

// ---------------------------------------------------------------------------------------------------------------------
// Token-2022 TransferFee (token2022.md §4; T22 interface/src/extension/transfer_fee/mod.rs@18a8005 lines 45-128, 152-167)
// ---------------------------------------------------------------------------------------------------------------------
export const MAX_FEE_BASIS_POINTS = 10_000n
export interface TransferFeeTier { epoch: bigint; maxFee: bigint; bps: number }
export interface TransferFeeConfigView { older: TransferFeeTier; newer: TransferFeeTier }
/** `get_epoch_fee`: newer iff epoch >= newer.epoch. */
export function epochFeeTier(cfg: TransferFeeConfigView, epoch: bigint): TransferFeeTier { return epoch >= cfg.newer.epoch ? cfg.newer : cfg.older }
/** `TransferFee::calculate_fee`: 0 if bps==0 or amount==0; else min(ceil(amount*bps/10000), maximum_fee); None if the raw fee does not fit u64. */
export function transferFeeCalculateFee(tier: TransferFeeTier, preFeeAmount: bigint): bigint | null {
  const bps = BigInt(tier.bps)
  if (bps === 0n || preFeeAmount === 0n) return 0n
  const numerator = preFeeAmount * bps
  const raw = (numerator + MAX_FEE_BASIS_POINTS - 1n) / MAX_FEE_BASIS_POINTS
  if (raw > U64_MAX) return null
  return raw < tier.maxFee ? raw : tier.maxFee
}
/** `TransferFee::calculate_pre_fee_amount` (exact port incl. the maximum_fee branch). */
export function transferFeeCalculatePreFeeAmount(tier: TransferFeeTier, postFeeAmount: bigint): bigint | null {
  const bps = BigInt(tier.bps)
  if (bps === 0n) return postFeeAmount
  if (postFeeAmount === 0n) return 0n
  if (bps === MAX_FEE_BASIS_POINTS) { const s = tier.maxFee + postFeeAmount; return s > U64_MAX ? null : s }
  const numerator = postFeeAmount * MAX_FEE_BASIS_POINTS
  const denominator = MAX_FEE_BASIS_POINTS - bps
  const raw = (numerator + denominator - 1n) / denominator
  if (raw - postFeeAmount >= tier.maxFee) { const s = postFeeAmount + tier.maxFee; return s > U64_MAX ? null : s }
  return raw > U64_MAX ? null : raw
}
/** `TransferFee::calculate_inverse_fee(post) = calculate_fee(calculate_pre_fee_amount(post))`. */
export function transferFeeCalculateInverseFee(tier: TransferFeeTier, postFeeAmount: bigint): bigint | null {
  const pre = transferFeeCalculatePreFeeAmount(tier, postFeeAmount); if (pre === null) return null
  return transferFeeCalculateFee(tier, pre)
}
export interface MintFeeView { program: 'spl_token' | 'token_2022'; transferFee?: TransferFeeConfigView | undefined }
/** raydium `utils/token.rs::get_transfer_fee` (§7.2 of token2022.md): legacy Token → 0; Token-2022 without the extension → 0; else calculate_epoch_fee().unwrap(). */
export function getTransferFee(mint: MintFeeView, epoch: bigint, preFeeAmount: bigint): bigint {
  if (mint.program === 'spl_token' || !mint.transferFee) return 0n
  const fee = transferFeeCalculateFee(epochFeeTier(mint.transferFee, epoch), preFeeAmount)
  if (fee === null) throw new OverflowError('get_transfer_fee: calculate_epoch_fee returned None (unwrap)')
  return fee
}
export type InverseFeeOutcome = { ok: true; fee: bigint } | { ok: false; code: 'INVALID_INPUT' | 'TRANSFER_FEE_CALCULATE_NOT_MATCH'; detail: string }
/** raydium `utils/token.rs::get_transfer_inverse_fee` (raydium_cpmm.md §5.4 / §12.4). */
export function getTransferInverseFee(mint: MintFeeView, epoch: bigint, postFeeAmount: bigint): InverseFeeOutcome {
  if (mint.program === 'spl_token') return { ok: true, fee: 0n }
  if (postFeeAmount === 0n) return { ok: false, code: 'INVALID_INPUT', detail: 'get_transfer_inverse_fee(post_fee_amount=0) → ErrorCode::InvalidInput' }
  if (!mint.transferFee) return { ok: true, fee: 0n }
  const tier = epochFeeTier(mint.transferFee, epoch)
  if (BigInt(tier.bps) === MAX_FEE_BASIS_POINTS) return { ok: true, fee: tier.maxFee }
  const fee = transferFeeCalculateInverseFee(tier, postFeeAmount)
  if (fee === null) throw new OverflowError('get_transfer_inverse_fee: calculate_inverse_epoch_fee None (unwrap)')
  const sum = postFeeAmount + fee
  if (sum > U64_MAX) throw new OverflowError('get_transfer_inverse_fee: post_fee_amount + fee exceeds u64 (checked_add unwrap)')
  const check = transferFeeCalculateFee(tier, sum)
  if (check === null) throw new OverflowError('get_transfer_inverse_fee: calculate_epoch_fee(check) None (unwrap)')
  if (check !== fee) return { ok: false, code: 'TRANSFER_FEE_CALCULATE_NOT_MATCH', detail: `inverse fee ${fee} != calculate_epoch_fee(${sum}) = ${check}` }
  return { ok: true, fee }
}

// ---------------------------------------------------------------------------------------------------------------------
// states/pool.rs helpers (§5.1, §5.3 steps 3-4, step 8)
// ---------------------------------------------------------------------------------------------------------------------
/** `PoolState::is_creator_fee_on_input`; null = ErrorCode::InvalidFeeModel. */
export function isCreatorFeeOnInput(creatorFeeOn: number, direction: TradeDirection): boolean | null {
  if (creatorFeeOn === CREATOR_FEE_ON.BOTH_TOKEN) return true
  if (creatorFeeOn === CREATOR_FEE_ON.ONLY_TOKEN_0) return direction === 'ZeroForOne'
  if (creatorFeeOn === CREATOR_FEE_ON.ONLY_TOKEN_1) return direction === 'OneForZero'
  return null
}
/** `PoolState::adjust_creator_fee_rate`. */
export function adjustCreatorFeeRate(pool: Pick<PoolState, 'enableCreatorFee'>, configCreatorFeeRate: bigint): bigint { return pool.enableCreatorFee ? configCreatorFeeRate : 0n }
export type ReservesOutcome = { ok: true; reserve0: bigint; reserve1: bigint; fees0: bigint; fees1: bigint } | { ok: false; code: 'MATH_OVERFLOW' | 'INSUFFICIENT_VAULT'; detail: string }
/** `PoolState::vault_amount_without_fee` (§5.1): vault.amount − (protocol + fund + creator fees) per token; InsufficientVault on underflow. */
export function vaultAmountWithoutFee(pool: PoolState, vault0Amount: bigint, vault1Amount: bigint): ReservesOutcome {
  const fees0 = pool.protocolFeesToken0 + pool.fundFeesToken0 + pool.creatorFeesToken0
  const fees1 = pool.protocolFeesToken1 + pool.fundFeesToken1 + pool.creatorFeesToken1
  if (fees0 > U64_MAX || fees1 > U64_MAX) return { ok: false, code: 'MATH_OVERFLOW', detail: 'fee counters sum exceeds u64' }
  if (vault0Amount < fees0) return { ok: false, code: 'INSUFFICIENT_VAULT', detail: `vault0 ${vault0Amount} < fees ${fees0}` }
  if (vault1Amount < fees1) return { ok: false, code: 'INSUFFICIENT_VAULT', detail: `vault1 ${vault1Amount} < fees ${fees1}` }
  return { ok: true, reserve0: vault0Amount - fees0, reserve1: vault1Amount - fees1, fees0, fees1 }
}
export function feeRatesOf(config: AmmConfig, pool: Pick<PoolState, 'enableCreatorFee'>): FeeRates {
  return { tradeFeeRate: config.tradeFeeRate, creatorFeeRate: adjustCreatorFeeRate(pool, config.creatorFeeRate), protocolFeeRate: config.protocolFeeRate, fundFeeRate: config.fundFeeRate }
}

// ---------------------------------------------------------------------------------------------------------------------
// instructions/swap_base_input.rs (§5.3) and swap_base_output.rs (§5.4) — instruction-level simulation
// ---------------------------------------------------------------------------------------------------------------------
export interface SwapContext {
  pool: PoolState
  config: AmmConfig
  direction: TradeDirection
  /** raw SPL `amount` of the vaults (bytes 64..72), NOT fee-adjusted */
  inputVaultAmount: bigint
  outputVaultAmount: bigint
  inputMint: MintFeeView
  outputMint: MintFeeView
  /** Clock.epoch used by Token-2022 calculate_epoch_fee */
  epoch: bigint
}
export interface SwapBaseInputOk {
  ok: true
  transferFeeIn: bigint
  actualAmountIn: bigint
  reserveIn: bigint
  reserveOut: bigint
  creatorFeeRate: bigint
  isCreatorFeeOnInput: boolean
  curve: CurveResult
  /** gross amount the vault sends (incl. Token-2022 output transfer fee) */
  amountOut: bigint
  transferFeeOut: bigint
  /** what the user's account is credited with */
  amountReceived: bigint
  constantBefore: bigint
  constantAfter: bigint
  vaultInAfter: bigint
  vaultOutAfter: bigint
}
export interface SwapFail { ok: false; code: string; detail: string }
export type SwapBaseInputOutcome = SwapBaseInputOk | SwapFail
const fail = (code: string, detail: string): SwapFail => ({ ok: false, code, detail })

function reservesFor(ctx: SwapContext): { ok: true; reserveIn: bigint; reserveOut: bigint } | SwapFail {
  const r = ctx.direction === 'ZeroForOne' ? vaultAmountWithoutFee(ctx.pool, ctx.inputVaultAmount, ctx.outputVaultAmount) : vaultAmountWithoutFee(ctx.pool, ctx.outputVaultAmount, ctx.inputVaultAmount)
  if (!r.ok) return fail(r.code, r.detail)
  return ctx.direction === 'ZeroForOne' ? { ok: true, reserveIn: r.reserve0, reserveOut: r.reserve1 } : { ok: true, reserveIn: r.reserve1, reserveOut: r.reserve0 }
}

/** Mirrors `swap_base_input` after the status/open_time gate (which validatePool enforces). Throws OverflowError where the program would panic. */
export function simulateSwapBaseInput(ctx: SwapContext, amountIn: bigint, minimumAmountOut?: bigint): SwapBaseInputOutcome {
  if (amountIn < 0n || amountIn > U64_MAX) return fail('U64_OVERFLOW', `amount_in ${amountIn} is not a u64`)
  // step 1: input transfer fee, saturating_sub, require_gt(actual, 0)
  const transferFeeIn = getTransferFee(ctx.inputMint, ctx.epoch, amountIn)
  const actualAmountIn = amountIn > transferFeeIn ? amountIn - transferFeeIn : 0n
  if (actualAmountIn <= 0n) return fail('REQUIRE_GT_VIOLATED', 'actual_amount_in (amount_in − transfer fee) must be > 0')
  // step 2: reserves and constant_before (u128 checked_mul unwrap)
  const rs = reservesFor(ctx); if (!rs.ok) return rs
  const constantBefore = rs.reserveIn * rs.reserveOut
  if (constantBefore > U128_MAX) throw new OverflowError('constant_before exceeds u128')
  // steps 3-4
  const creatorFeeRate = adjustCreatorFeeRate(ctx.pool, ctx.config.creatorFeeRate)
  const onInput = isCreatorFeeOnInput(ctx.pool.creatorFeeOn, ctx.direction)
  if (onInput === null) return fail('INVALID_FEE_MODEL', `creator_fee_on=${ctx.pool.creatorFeeOn} is not 0/1/2`)
  // step 5
  const rates: FeeRates = { tradeFeeRate: ctx.config.tradeFeeRate, creatorFeeRate, protocolFeeRate: ctx.config.protocolFeeRate, fundFeeRate: ctx.config.fundFeeRate }
  const curve = curveSwapBaseInput(actualAmountIn, rs.reserveIn, rs.reserveOut, rates, onInput)
  if (curve === null) return fail('ZERO_TRADING_TOKENS', 'CurveCalculator::swap_base_input returned None (ErrorCode::ZeroTradingTokens 6006)')
  // step 6
  const constantAfter = curve.newInputVaultAmount * curve.newOutputVaultAmount
  if (constantAfter > U128_MAX) throw new OverflowError('constant_after exceeds u128')
  // step 7
  if (curve.outputAmount > U64_MAX) throw new OverflowError('u64::try_from(result.output_amount) unwrap')
  const amountOut = curve.outputAmount
  const transferFeeOut = getTransferFee(ctx.outputMint, ctx.epoch, amountOut)
  if (amountOut < transferFeeOut) throw new OverflowError('amount_out.checked_sub(transfer_fee) unwrap')
  const amountReceived = amountOut - transferFeeOut
  if (amountReceived <= 0n) return fail('REQUIRE_GT_VIOLATED', 'amount_received must be > 0')
  if (minimumAmountOut !== undefined && amountReceived < minimumAmountOut) return fail('EXCEEDED_SLIPPAGE', `amount_received ${amountReceived} < minimum_amount_out ${minimumAmountOut} (ErrorCode::ExceededSlippage 6005)`)
  // step 8: update_fees (checked_add unwrap on u64 counters)
  if (curve.protocolFee > U64_MAX || curve.fundFee > U64_MAX || curve.creatorFee > U64_MAX) throw new OverflowError('fee u64::try_from unwrap')
  if (constantAfter < constantBefore) return fail('CONSTANT_PRODUCT_DECREASED', 'require_gte!(constant_after, constant_before) violated')
  // step 9: token moves — the vault's u64 amount must not overflow (token program checked_add)
  const vaultInAfter = ctx.inputVaultAmount + actualAmountIn
  if (vaultInAfter > U64_MAX) return fail('U64_OVERFLOW_VAULT', 'input vault amount would exceed u64 on transfer')
  const vaultOutAfter = ctx.outputVaultAmount - amountOut
  if (vaultOutAfter < 0n) return fail('INSUFFICIENT_VAULT', 'output vault cannot cover amount_out')
  return { ok: true, transferFeeIn, actualAmountIn, reserveIn: rs.reserveIn, reserveOut: rs.reserveOut, creatorFeeRate, isCreatorFeeOnInput: onInput, curve, amountOut, transferFeeOut, amountReceived, constantBefore, constantAfter, vaultInAfter, vaultOutAfter }
}

export interface SwapBaseOutputOk {
  ok: true
  outTransferFee: bigint
  amountOutWithTransferFee: bigint
  reserveIn: bigint
  reserveOut: bigint
  creatorFeeRate: bigint
  isCreatorFeeOnInput: boolean
  curve: CurveResult
  /** curve input (excl. transfer fee) */
  inputAmount: bigint
  inputTransferFee: bigint
  /** what the user must send */
  inputTransferAmount: bigint
  constantBefore: bigint
  constantAfter: bigint
  vaultInAfter: bigint
  vaultOutAfter: bigint
}
export type SwapBaseOutputOutcome = SwapBaseOutputOk | SwapFail
/** Mirrors `swap_base_output(max_amount_in, amount_out_received)` (§5.4), for completeness / cross-checks. */
export function simulateSwapBaseOutput(ctx: SwapContext, amountOutReceived: bigint, maxAmountIn?: bigint): SwapBaseOutputOutcome {
  if (amountOutReceived <= 0n) return fail('REQUIRE_GT_VIOLATED', 'amount_out_received must be > 0')
  if (amountOutReceived > U64_MAX) return fail('U64_OVERFLOW', 'amount_out_received is not a u64')
  const inv = getTransferInverseFee(ctx.outputMint, ctx.epoch, amountOutReceived)
  if (!inv.ok) return fail(inv.code, inv.detail)
  const amountOutWithTransferFee = amountOutReceived + inv.fee
  if (amountOutWithTransferFee > U64_MAX) throw new OverflowError('amount_out_received.checked_add(out_transfer_fee) unwrap')
  const rs = reservesFor(ctx); if (!rs.ok) return rs
  const constantBefore = rs.reserveIn * rs.reserveOut
  const creatorFeeRate = adjustCreatorFeeRate(ctx.pool, ctx.config.creatorFeeRate)
  const onInput = isCreatorFeeOnInput(ctx.pool.creatorFeeOn, ctx.direction)
  if (onInput === null) return fail('INVALID_FEE_MODEL', `creator_fee_on=${ctx.pool.creatorFeeOn} is not 0/1/2`)
  const rates: FeeRates = { tradeFeeRate: ctx.config.tradeFeeRate, creatorFeeRate, protocolFeeRate: ctx.config.protocolFeeRate, fundFeeRate: ctx.config.fundFeeRate }
  const curve = curveSwapBaseOutput(amountOutWithTransferFee, rs.reserveIn, rs.reserveOut, rates, onInput)
  if (curve === null) return fail('ZERO_TRADING_TOKENS', 'CurveCalculator::swap_base_output returned None (6006)')
  const constantAfter = curve.newInputVaultAmount * curve.newOutputVaultAmount
  if (constantAfter > U128_MAX) throw new OverflowError('constant_after exceeds u128')
  if (curve.inputAmount > U64_MAX) throw new OverflowError('u64::try_from(result.input_amount) unwrap')
  const inputAmount = curve.inputAmount
  if (inputAmount <= 0n) return fail('REQUIRE_GT_VIOLATED', 'input_amount must be > 0')
  const invIn = getTransferInverseFee(ctx.inputMint, ctx.epoch, inputAmount)
  if (!invIn.ok) return fail(invIn.code, invIn.detail)
  const inputTransferAmount = inputAmount + invIn.fee
  if (inputTransferAmount > U64_MAX) throw new OverflowError('input_amount.checked_add(transfer_fee) unwrap')
  if (maxAmountIn !== undefined && maxAmountIn < inputTransferAmount) return fail('EXCEEDED_SLIPPAGE', `input_transfer_amount ${inputTransferAmount} > max_amount_in ${maxAmountIn}`)
  if (curve.outputAmount !== amountOutWithTransferFee) return fail('REQUIRE_EQ_VIOLATED', 'result.output_amount != amount_out_with_transfer_fee')
  if (constantAfter < constantBefore) return fail('CONSTANT_PRODUCT_DECREASED', 'require_gte!(constant_after, constant_before) violated')
  const vaultInAfter = ctx.inputVaultAmount + inputAmount
  if (vaultInAfter > U64_MAX) return fail('U64_OVERFLOW_VAULT', 'input vault amount would exceed u64 on transfer')
  const vaultOutAfter = ctx.outputVaultAmount - amountOutWithTransferFee
  if (vaultOutAfter < 0n) return fail('INSUFFICIENT_VAULT', 'output vault cannot cover amount_out')
  return { ok: true, outTransferFee: inv.fee, amountOutWithTransferFee, reserveIn: rs.reserveIn, reserveOut: rs.reserveOut, creatorFeeRate, isCreatorFeeOnInput: onInput, curve, inputAmount, inputTransferFee: invIn.fee, inputTransferAmount, constantBefore, constantAfter, vaultInAfter, vaultOutAfter }
}

/** §5.3 step 8 `update_fees`: returns a NEW PoolState with the accrued counters advanced (never mutates). */
export function applyFeeUpdate(pool: PoolState, direction: TradeDirection, isCreatorFeeOnInput: boolean, protocolFee: bigint, fundFee: bigint, creatorFee: bigint): PoolState {
  const next: PoolState = { ...pool }
  if (!pool.enableCreatorFee && creatorFee !== 0n) throw new Error('update_fees: creator_fee must be 0 when enable_creator_fee is false')
  if (direction === 'ZeroForOne') {
    next.protocolFeesToken0 = pool.protocolFeesToken0 + protocolFee
    next.fundFeesToken0 = pool.fundFeesToken0 + fundFee
    if (isCreatorFeeOnInput) next.creatorFeesToken0 = pool.creatorFeesToken0 + creatorFee
    else next.creatorFeesToken1 = pool.creatorFeesToken1 + creatorFee
  } else {
    next.protocolFeesToken1 = pool.protocolFeesToken1 + protocolFee
    next.fundFeesToken1 = pool.fundFeesToken1 + fundFee
    if (isCreatorFeeOnInput) next.creatorFeesToken1 = pool.creatorFeesToken1 + creatorFee
    else next.creatorFeesToken0 = pool.creatorFeesToken0 + creatorFee
  }
  for (const k of ['protocolFeesToken0', 'protocolFeesToken1', 'fundFeesToken0', 'fundFeesToken1', 'creatorFeesToken0', 'creatorFeesToken1'] as const) {
    if (next[k] > U64_MAX) throw new OverflowError(`update_fees: ${k} checked_add unwrap`)
  }
  return next
}
