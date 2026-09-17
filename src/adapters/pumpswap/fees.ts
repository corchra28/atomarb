/**
 * PumpSwap fee-schedule selection — mirrors pumpswap.md §4 (S2 `src/sdk/fees.ts` / `util.ts`, "rust reference:
 * pump-fees FeeConfig::fees_for_quote_mint()", "pump-fees-math::calculate_fee_tier()", "pump-amm Pool::market_cap()").
 */
import { PublicKey } from '@solana/web3.js'
import { WSOL_MINT } from '../../state/token.js'
import { unsupported, type Unsupported } from '../types.js'
import { pumpPoolAuthorityPda, type Fees, type FeeTier, type PumpFeeConfig, type PumpGlobalConfig, type PumpPool } from './layout.js'

/** token2022.md §1: Token-2022 native mint (SOL-like quote per pumpswap.md §4). */
export const NATIVE_MINT_2022 = new PublicKey('9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP')
/** pumpswap.md §4: the only stable quote mint (S2 STABLE_QUOTE_MINTS). */
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
/** pumpswap.md §4: circulating supply used for the market cap of mayhem-mode pools (S2 PUMP_AMM_TOTAL_TOKEN_SUPPLY). */
export const PUMP_AMM_TOTAL_TOKEN_SUPPLY = 1_000_000_000_000_000n

/** pumpswap.md §4: SOL-like quote mints = Pubkey::default, WSOL, Token-2022 native mint. */
export function isSolLikeQuoteMint(quoteMint: PublicKey): boolean {
  return quoteMint.equals(PublicKey.default) || quoteMint.equals(WSOL_MINT) || quoteMint.equals(NATIVE_MINT_2022)
}
export function isStableQuoteMint(quoteMint: PublicKey): boolean { return quoteMint.equals(USDC_MINT) }
export function isZeroFees(f: Fees): boolean { return f.lpFeeBps === 0n && f.protocolFeeBps === 0n && f.creatorFeeBps === 0n }
/** pumpswap.md §4/§7: canonical ("pump") pool iff pool.creator == PDA["pool-authority", base_mint] under the pump program (NOT coin_creator). */
export function isPumpPool(baseMint: PublicKey, poolCreator: PublicKey): boolean { return pumpPoolAuthorityPda(baseMint).equals(poolCreator) }

/**
 * pumpswap.md §4: marketCap = floor(effectiveQuoteReserve * circulatingSupply / baseReserve), circulatingSupply = isMayhemMode ?
 * 1e15 : base mint supply. Returns null when baseReserve == 0 (SDK throws "Division by zero").
 */
export function poolMarketCap(p: { effectiveQuoteReserve: bigint; baseReserve: bigint; baseMintSupply: bigint; isMayhemMode: boolean }): bigint | null {
  if (p.baseReserve === 0n) return null
  const circulating = p.isMayhemMode ? PUMP_AMM_TOTAL_TOKEN_SUPPLY : p.baseMintSupply
  return (p.effectiveQuoteReserve * circulating) / p.baseReserve
}

/** pumpswap.md §4 calculateFeeTier: below tier0 threshold → tier0; else the highest tier whose threshold <= marketCap. */
export function calculateFeeTier(feeTiers: FeeTier[], marketCap: bigint): { fees: Fees; tierIndex: number } {
  if (feeTiers.length === 0) throw new Error('fee tiers cannot be empty')
  const first = feeTiers[0]!
  if (marketCap < first.marketCapLamportsThreshold) return { fees: first.fees, tierIndex: 0 }
  for (let i = feeTiers.length - 1; i >= 0; i--) { const t = feeTiers[i]!; if (marketCap >= t.marketCapLamportsThreshold) return { fees: t.fees, tierIndex: i } }
  return { fees: first.fees, tierIndex: 0 }
}

/** pumpswap.md §4 feesForQuoteMint. */
export function feesForQuoteMint(p: { feeConfig: PumpFeeConfig; isPumpPool: boolean; marketCap: bigint; quoteMint: PublicKey }): { fees: Fees; source: string; tierIndex: number | null } {
  const { feeConfig } = p
  if (!p.isPumpPool) return { fees: feeConfig.flatFees, source: 'fee_config.flat_fees (non-canonical pool)', tierIndex: null }
  if (isSolLikeQuoteMint(p.quoteMint)) { const t = calculateFeeTier(feeConfig.feeTiers, p.marketCap); return { fees: t.fees, source: `fee_config.fee_tiers[${t.tierIndex}] (SOL-like quote, market cap ${p.marketCap} lamports)`, tierIndex: t.tierIndex } }
  if (isStableQuoteMint(p.quoteMint)) {
    const tiers = feeConfig.stableFeeTiers.length > 0 ? feeConfig.stableFeeTiers : feeConfig.feeTiers
    const t = calculateFeeTier(tiers, p.marketCap)
    return { fees: t.fees, source: `fee_config.${feeConfig.stableFeeTiers.length > 0 ? 'stable_fee_tiers' : 'fee_tiers'}[${t.tierIndex}] (stable quote)`, tierIndex: t.tierIndex }
  }
  return isZeroFees(feeConfig.exoticFlatFees) ? { fees: feeConfig.flatFees, source: 'fee_config.flat_fees (exotic quote, exotic_flat_fees unset)', tierIndex: null } : { fees: feeConfig.exoticFlatFees, source: 'fee_config.exotic_flat_fees', tierIndex: null }
}

export interface FeeSchedule {
  lpBps: bigint
  protocolBps: bigint
  /** creator fee actually charged: 0 when pool.coin_creator == Pubkey::default (pumpswap.md §4/§5) */
  creatorBps: bigint
  /** the schedule's creator rate before the coin_creator==default zeroing (after the per-pool override) */
  scheduleCreatorBps: bigint
  creatorFeeApplies: boolean
  overrideApplied: boolean
  isPumpPool: boolean
  marketCapLamports: bigint
  tierIndex: number | null
  source: string
}

/**
 * pumpswap.md §4 computeFeesBps: schedule by (isPumpPool, quote mint, market cap); per-pool creator_fee_bps override when
 * globalConfig.creator_fee_configurable && pool.creator_fee_bps > 0; creator fee zero when coin_creator == default.
 * The GlobalConfig lp/protocol/creator fallback is unreachable on-chain (fee_config is mandatory) and is NOT implemented.
 */
export function selectFeeSchedule(p: { pool: PumpPool; globalConfig: PumpGlobalConfig; feeConfig: PumpFeeConfig; baseMintSupply: bigint; baseReserve: bigint; effectiveQuoteReserve: bigint }): FeeSchedule | Unsupported {
  const marketCap = poolMarketCap({ effectiveQuoteReserve: p.effectiveQuoteReserve, baseReserve: p.baseReserve, baseMintSupply: p.baseMintSupply, isMayhemMode: p.pool.isMayhemMode })
  if (marketCap === null) return unsupported('EMPTY_POOL', 'base reserve is zero: market cap undefined')
  const pump = isPumpPool(p.pool.baseMint, p.pool.creator)
  const sel = feesForQuoteMint({ feeConfig: p.feeConfig, isPumpPool: pump, marketCap, quoteMint: p.pool.quoteMint })
  let fees = sel.fees
  let overrideApplied = false
  if (p.globalConfig.creatorFeeConfigurable && p.pool.creatorFeeBps > 0n) { fees = { ...fees, creatorFeeBps: p.pool.creatorFeeBps }; overrideApplied = true }
  const creatorFeeApplies = !p.pool.coinCreator.equals(PublicKey.default)
  return {
    lpBps: fees.lpFeeBps, protocolBps: fees.protocolFeeBps, creatorBps: creatorFeeApplies ? fees.creatorFeeBps : 0n, scheduleCreatorBps: fees.creatorFeeBps, creatorFeeApplies, overrideApplied,
    isPumpPool: pump, marketCapLamports: marketCap, tierIndex: sel.tierIndex, source: sel.source + (overrideApplied ? ` + pool.creator_fee_bps override=${p.pool.creatorFeeBps}` : '') + (creatorFeeApplies ? '' : ' (coin_creator=default → creator fee 0)'),
  }
}
