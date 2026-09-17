/**
 * PumpSwap swap math — integer arithmetic mirroring pumpswap.md §5 (S2 buy.ts / sell.ts, verified against live events).
 * All rounding directions are cited per formula. Reserves: base = raw base vault; quote pricing uses the EFFECTIVE quote
 * reserve = raw quote vault + pool.virtual_quote_reserves (pumpswap.md §5, verified on three live BuyEvents).
 */
import { PublicKey } from '@solana/web3.js'
import { ceilDiv } from '../../util/bigint.js'
import { EXT, MINT_SIZE, TOKEN_2022_PROGRAM_ID, parseTlv } from '../../state/token.js'
import type { MintInfo, RawAccount } from '../types.js'

export interface PoolMathState {
  baseReserve: bigint
  /** raw quote vault balance */
  quoteReserve: bigint
  /** pool.virtual_quote_reserves (i128) */
  virtualQuoteReserves: bigint
}
/** creatorBps must already be 0 when pool.coin_creator == default (fees.ts selectFeeSchedule does that). */
export interface FeeBps { lpBps: bigint; protocolBps: bigint; creatorBps: bigint }
export type MathResult<T> = ({ ok: true } & T) | { ok: false; reject: string; detail: string }

/** pumpswap.md §5 helper: fee(amount, bps) = ceilDiv(amount * bps, 10_000). */
export function feeCeil(amount: bigint, bps: bigint): bigint { return bps === 0n || amount === 0n ? 0n : ceilDiv(amount * bps, 10_000n) }

/** effective quote reserve; rejects negative virtual reserves or a non-positive effective reserve. */
export function effectiveQuoteReserve(s: PoolMathState): MathResult<{ effQ: bigint }> {
  if (s.virtualQuoteReserves < 0n) return { ok: false, reject: 'NEGATIVE_VIRTUAL_QUOTE_RESERVES', detail: `virtual_quote_reserves=${s.virtualQuoteReserves}` }
  const effQ = s.quoteReserve + s.virtualQuoteReserves
  if (effQ <= 0n || s.baseReserve <= 0n) return { ok: false, reject: 'EMPTY_POOL', detail: `baseReserve=${s.baseReserve} effectiveQuote=${effQ}` }
  return { ok: true, effQ }
}

export interface BuyBaseResult { baseOut: bigint; quoteAmountIn: bigint; lpFee: bigint; protocolFee: bigint; creatorFee: bigint; userQuoteIn: bigint; effQ: bigint }
/**
 * pumpswap.md §5a — on-chain `buy(base_amount_out, max_quote_amount_in)`:
 *   quote_amount_in = ceilDiv(effQ * base_out, base_reserve - base_out); fees = ceil each; user pays quote_in + lp + protocol + creator.
 * Live check: base_out 828,079 → quote_in 1,439,176 / lp 2,879 / protocol 720 / creator 720 (sig 5ZD6eMu…).
 */
export function buyBaseInput(s: PoolMathState, fees: FeeBps, baseOut: bigint): MathResult<BuyBaseResult> {
  const e = effectiveQuoteReserve(s); if (!e.ok) return e
  if (baseOut <= 0n) return { ok: false, reject: 'ZERO_AMOUNT', detail: `base_out=${baseOut}` }
  // IDL error 6016 BuyMoreBaseAmountThanPoolReserves; the SDK also rejects base == reserve (denominator zero)
  if (baseOut >= s.baseReserve) return { ok: false, reject: 'BUY_EXCEEDS_RESERVES', detail: `base_out=${baseOut} >= base_reserve=${s.baseReserve}` }
  const quoteAmountIn = ceilDiv(e.effQ * baseOut, s.baseReserve - baseOut)
  const lpFee = feeCeil(quoteAmountIn, fees.lpBps), protocolFee = feeCeil(quoteAmountIn, fees.protocolBps), creatorFee = feeCeil(quoteAmountIn, fees.creatorBps)
  return { ok: true, baseOut, quoteAmountIn, lpFee, protocolFee, creatorFee, userQuoteIn: quoteAmountIn + lpFee + protocolFee + creatorFee, effQ: e.effQ }
}

export interface BuyQuoteResult {
  /** the spendable_quote_in argument */
  spendableQuoteIn: bigint
  /** the post-fee curve input (SDK `internalQuoteWithoutFees`; the SDK localnet test asserts the chain's user_quote_amount_in equals it) */
  effectiveQuote: bigint
  lpFee: bigint; protocolFee: bigint; creatorFee: bigint
  /** effectiveQuote + fees (<= spendableQuoteIn by construction) */
  totalWithFees: bigint
  /** amount fed to the constant-product formula: effectiveQuote - 1 (on-chain behaviour, verified locally; pumpswap.md §11) */
  curveInput: bigint
  baseOut: bigint
  effQ: bigint
}
/**
 * pumpswap.md §5b — SDK inverse of on-chain `buy_exact_quote_in(spendable_quote_in, min_base_amount_out)`:
 *   totalFeeBps = lp + protocol + creator(0 if coin_creator default)
 *   effectiveQuote = floor(quote * 10000 / (10000 + totalFeeBps)); fees = ceil each on effectiveQuote;
 *   if effectiveQuote + fees > quote: effectiveQuote -= excess   (fees are NOT recomputed after the correction — SDK behaviour)
 *   curveInput = effectiveQuote - 1;  base_out = floor(base_reserve * curveInput / (effQ + curveInput))
 * VERIFIED against the real mainnet ELF in LiteSVM (pumpswap.md §11; tests/integration/pumpswap_local_program.test.ts): the program's base_out equals
 * this formula INCLUDING the `- 1`, the user is debited exactly effectiveQuote + fees (totalWithFees, which is spendable or spendable - 1), and the pool
 * quote vault gains effectiveQuote + lpFee. BuyEvent reports quote_amount_in = spendable and user_quote_amount_in = effectiveQuote for this instruction.
 */
export function buyQuoteInput(s: PoolMathState, fees: FeeBps, quote: bigint): MathResult<BuyQuoteResult> {
  const e = effectiveQuoteReserve(s); if (!e.ok) return e
  if (quote <= 0n) return { ok: false, reject: 'ZERO_AMOUNT', detail: `quote=${quote}` }
  const totalFeeBps = fees.lpBps + fees.protocolBps + fees.creatorBps
  let effectiveQuote = (quote * 10_000n) / (10_000n + totalFeeBps)
  const lpFee = feeCeil(effectiveQuote, fees.lpBps), protocolFee = feeCeil(effectiveQuote, fees.protocolBps), creatorFee = feeCeil(effectiveQuote, fees.creatorBps)
  const withFees = effectiveQuote + lpFee + protocolFee + creatorFee
  if (withFees > quote) effectiveQuote -= withFees - quote
  const curveInput = effectiveQuote - 1n
  if (curveInput <= 0n) return { ok: false, reject: 'AMOUNT_TOO_SMALL', detail: `effectiveQuote=${effectiveQuote} leaves no curve input` }
  const baseOut = (s.baseReserve * curveInput) / (e.effQ + curveInput)
  if (baseOut <= 0n) return { ok: false, reject: 'ZERO_OUT', detail: `base_out=0 for quote=${quote}` }
  return { ok: true, spendableQuoteIn: quote, effectiveQuote, lpFee, protocolFee, creatorFee, totalWithFees: effectiveQuote + lpFee + protocolFee + creatorFee, curveInput, baseOut, effQ: e.effQ }
}

export interface SellResult { baseIn: bigint; quoteAmountOut: bigint; lpFee: bigint; protocolFee: bigint; creatorFee: bigint; userQuoteOut: bigint; effQ: bigint }
/**
 * pumpswap.md §5c — on-chain `sell(base_amount_in, min_quote_amount_out)`:
 *   quote_amount_out = floor(effQ * base_in / (base_reserve + base_in)); fees = ceil each; user gets quote_out - lp - protocol - creator.
 *   BOOST cap: require raw quoteReserve >= quote_out - lp_fee (SDK "Insufficient real quote reserves"; IDL error 6063).
 * Live check: base_in 10,000 → quote_out 11,738,771 / lp 29,347 / protocol 5,870 / user 11,703,554 (sig DLeuEpi…).
 */
export function sellBaseInput(s: PoolMathState, fees: FeeBps, baseIn: bigint): MathResult<SellResult> {
  const e = effectiveQuoteReserve(s); if (!e.ok) return e
  if (baseIn <= 0n) return { ok: false, reject: 'ZERO_AMOUNT', detail: `base_in=${baseIn}` }
  const quoteAmountOut = (e.effQ * baseIn) / (s.baseReserve + baseIn)
  const lpFee = feeCeil(quoteAmountOut, fees.lpBps), protocolFee = feeCeil(quoteAmountOut, fees.protocolBps), creatorFee = feeCeil(quoteAmountOut, fees.creatorBps)
  if (s.quoteReserve < quoteAmountOut - lpFee) return { ok: false, reject: 'BOOST_REAL_RESERVE_CAP', detail: `real quote vault ${s.quoteReserve} < quote_out - lp_fee = ${quoteAmountOut - lpFee}` }
  const userQuoteOut = quoteAmountOut - lpFee - protocolFee - creatorFee
  if (userQuoteOut <= 0n) return { ok: false, reject: 'ZERO_OUT', detail: `fees exceed quote_out=${quoteAmountOut}` }
  return { ok: true, baseIn, quoteAmountOut, lpFee, protocolFee, creatorFee, userQuoteOut, effQ: e.effQ }
}

// ---------------------------------------------------------------------------------------------------------------------
// Token-2022 gate (token2022.md §6) — evaluated on the BASE mint (quote is WSOL / SPL Token by validation)
// ---------------------------------------------------------------------------------------------------------------------
export interface Token2022Gate {
  rejects: { code: string; detail: string }[]
  warnings: { code: string; detail: string }[]
  /** transfer fee used for quoting: the LARGER of older/newer TransferFee (the adapter has no Clock; conservative) */
  transferFee: { bps: number; maxFee: bigint; epoch: bigint; basis: string } | null
  /** both scheduled tiers, so the fee can be evaluated exactly at a known epoch, or worst-case per amount when the epoch is unknown */
  transferFeeTiers: { older: { bps: number; maxFee: bigint; epoch: bigint }; newer: { bps: number; maxFee: bigint; epoch: bigint } } | null
}
function isZero32(b: Uint8Array): boolean { for (let i = 0; i < 32; i++) if (b[i] !== 0) return false; return true }
export function token2022Gate(raw: RawAccount, mint: MintInfo): Token2022Gate {
  const g: Token2022Gate = { rejects: [], warnings: [], transferFee: null, transferFeeTiers: null }
  if (mint.freezeAuthority) g.warnings.push({ code: 'FREEZE_AUTHORITY_SET', detail: `mint ${mint.mint.toBase58()} freeze authority ${mint.freezeAuthority.toBase58()} (token2022.md §6: can freeze vault/ATA)` })
  if (!raw.owner.equals(TOKEN_2022_PROGRAM_ID)) return g
  if (raw.data.length <= MINT_SIZE) return g // token2022.md §3: exactly 82 bytes → no extensions
  const tlv = parseTlv(raw.data, MINT_SIZE)
  for (const e of tlv) {
    switch (e.type) {
      case EXT.NonTransferable: g.rejects.push({ code: 'TOKEN2022_NON_TRANSFERABLE', detail: 'mint has NonTransferable (token2022.md §6: every transfer fails)' }); break
      case EXT.Pausable: {
        const paused = e.data.length >= 33 && e.data[32] === 1
        if (paused) g.rejects.push({ code: 'TOKEN2022_PAUSED', detail: 'mint is paused (PausableConfig.paused=1; transfers fail MintPaused)' })
        else g.warnings.push({ code: 'TOKEN2022_PAUSABLE', detail: 'mint is pausable (authority can pause transfers at any time)' })
        break
      }
      case EXT.DefaultAccountState: {
        if (e.data.length >= 1 && e.data[0] === 2) g.rejects.push({ code: 'TOKEN2022_DEFAULT_FROZEN', detail: 'DefaultAccountState=Frozen: new token accounts start frozen (token2022.md §6)' })
        break
      }
      case EXT.TransferHook: {
        const program = e.data.length >= 64 ? e.data.subarray(32, 64) : new Uint8Array(32)
        if (!isZero32(program)) g.rejects.push({ code: 'TOKEN2022_TRANSFER_HOOK', detail: `TransferHook program ${new PublicKey(program).toBase58()} (extra accounts required; token2022.md §6)` })
        else g.warnings.push({ code: 'TOKEN2022_TRANSFER_HOOK_NO_PROGRAM', detail: 'TransferHook extension with no program (no CPI)' })
        break
      }
      case EXT.PermanentDelegate: {
        if (e.data.length >= 32 && !isZero32(e.data.subarray(0, 32))) g.warnings.push({ code: 'TOKEN2022_PERMANENT_DELEGATE', detail: `permanent delegate ${new PublicKey(e.data.subarray(0, 32)).toBase58()} can move vault funds` })
        break
      }
      case EXT.TransferFeeConfig: {
        // token2022.md §4: older fee used while epoch < newer.epoch; without a Clock we take the larger fee (conservative for both legs)
        const older = { epoch: readU64(e.data, 72), maxFee: readU64(e.data, 80), bps: e.data[88]! | (e.data[89]! << 8) }
        const newer = { epoch: readU64(e.data, 90), maxFee: readU64(e.data, 98), bps: e.data[106]! | (e.data[107]! << 8) }
        if (older.bps > 10_000 || newer.bps > 10_000) { g.rejects.push({ code: 'TOKEN2022_TRANSFER_FEE_INVALID', detail: `transfer_fee_basis_points older=${older.bps} newer=${newer.bps} > 10000` }); break }
        g.transferFeeTiers = { older, newer }
        // The tier is chosen by EPOCH (token2022.md §4: newer applies from newer.epoch). Picking by bps is wrong: a scheduled update that lowers bps
        // while raising maximum_fee makes the larger-bps tier the SMALLER fee at real sizes, which would under-charge the leg (review finding).
        const pick = epochOf(raw) !== null ? (epochOf(raw)! >= newer.epoch ? { ...newer, basis: `newer (epoch ${epochOf(raw)} >= ${newer.epoch})` } : { ...older, basis: `older (epoch ${epochOf(raw)} < ${newer.epoch})` }) : { ...older, basis: 'older (epoch unknown; the exact fee is computed per amount as the worst case of both tiers)' }
        g.transferFee = { bps: pick.bps, maxFee: pick.maxFee, epoch: pick.epoch, basis: pick.basis }
        if (pick.bps > 0 || newer.bps > 0 || older.bps > 0) g.warnings.push({ code: 'TOKEN2022_TRANSFER_FEE', detail: `transfer fee tiers older=${older.bps}bps/max ${older.maxFee} (epoch ${older.epoch}), newer=${newer.bps}bps/max ${newer.maxFee} (epoch ${newer.epoch}); applied: ${pick.basis}` })
        break
      }
      default: break
    }
  }
  return g
}
/** Epoch implied by the snapshot slot (mainnet: 432,000 slots per epoch, no warm-up) — the same rule the Raydium adapter uses. */
export const SLOTS_PER_EPOCH = 432_000n
function epochOf(raw: RawAccount): bigint | null { return raw.contextSlot > 0 ? BigInt(Math.floor(raw.contextSlot / Number(SLOTS_PER_EPOCH))) : null }
function readU64(b: Uint8Array, off: number): bigint { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!); return v }
/** Worst case over both scheduled tiers, evaluated per amount (the only sound choice when the epoch is unknown). */
export function transferFeeAmountWorstCase(amount: bigint, tiers: { older: { bps: number; maxFee: bigint }; newer: { bps: number; maxFee: bigint } } | null, fallback: { bps: number; maxFee: bigint } | null): bigint {
  if (!tiers) return transferFeeAmount(amount, fallback)
  const a = transferFeeAmount(amount, tiers.older), b = transferFeeAmount(amount, tiers.newer)
  return a > b ? a : b
}
/** token2022.md §4 calculate_fee: 0 if bps==0 or amount==0 else min(ceil(amount*bps/10000), maximum_fee). */
export function transferFeeAmount(amount: bigint, fee: { bps: number; maxFee: bigint } | null): bigint {
  if (!fee || fee.bps === 0 || amount === 0n) return 0n
  const raw = ceilDiv(amount * BigInt(fee.bps), 10_000n)
  return raw > fee.maxFee ? fee.maxFee : raw
}
