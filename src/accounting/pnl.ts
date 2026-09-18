import type { PublicKey } from '@solana/web3.js'
import type { CostItem, TradingPnl, TransactionPnl, OperatingPnl, AttemptAccounting } from './types.js'
import type { Quote } from '../adapters/types.js'
/** Trading PnL of a two-leg circuit in the base asset. Fees inside the quotes are listed for audit but NOT subtracted again. */
export function tradingPnl(baseMint: PublicKey, legA: Quote, legB: Quote): TradingPnl {
  if (!legA.inputMint.equals(baseMint) || !legB.outputMint.equals(baseMint)) throw new Error('tradingPnl: circuit must start and end in baseMint')
  if (legB.amountIn !== legA.amountOutToUser) throw new Error(`tradingPnl: leg B input ${legB.amountIn} != leg A output to user ${legA.amountOutToUser} (no pre-existing inventory may be sold)`)
  const fees = [...legA.fees, ...legB.fees].map(f => ({ name: f.name, unit: 'token_raw' as const, amount: f.amount, mint: f.mint, status: 'INCLUDED_IN_QUOTE' as const, source: f.source }))
  return { baseMint, amountIn: legA.amountIn, amountOut: legB.amountOutToUser, pnl: legB.amountOutToUser - legA.amountIn, feesInsideQuotes: fees }
}
export interface ExternalCostInputs {
  baseFeeLamports: bigint; signatures: number
  computeUnitLimit: number; computeUnitPriceMicroLamports: number
  /** if getFeeForMessage returned a value for the exact message, it already includes base + priority: use it instead of the formula */
  feeForMessageLamports?: bigint | undefined
  jitoTipLamports: bigint
  flashLoanPremiumLamports?: bigint | undefined
  /** rent for accounts created in the tx that will NOT be closed (definitive cost) */
  nonRecoverableRentLamports: bigint
  /** deposits parked in accounts the circuit created: recoverable by a successful close, so NOT a cost — reported in `locked` */
  recoverableRentLamports: bigint
  /** fee of the separate transaction that closes those accounts, when a recovery is actually planned (definitive) */
  recoveryTxFeeLamports?: bigint | undefined
}
export function externalCosts(i: ExternalCostInputs): { costs: CostItem[]; locked: CostItem[]; total: bigint } {
  const costs: CostItem[] = []
  if (i.feeForMessageLamports !== undefined) {
    costs.push({ name: 'network_fee_total', unit: 'lamports', amount: i.feeForMessageLamports, status: 'OBSERVED', source: 'getFeeForMessage(final message)', note: 'includes base fee and prioritization fee; not double counted' })
  } else {
    costs.push({ name: 'base_fee', unit: 'lamports', amount: i.baseFeeLamports * BigInt(i.signatures), status: 'ESTIMATED', source: `${i.baseFeeLamports} lamports x ${i.signatures} signatures` })
    const prio = (BigInt(i.computeUnitLimit) * BigInt(i.computeUnitPriceMicroLamports) + 999_999n) / 1_000_000n
    costs.push({ name: 'priority_fee', unit: 'lamports', amount: prio, status: 'ESTIMATED', source: `ceil(cu_limit ${i.computeUnitLimit} x cu_price ${i.computeUnitPriceMicroLamports} micro-lamports / 1e6)` })
  }
  if (i.jitoTipLamports > 0n) costs.push({ name: 'jito_tip', unit: 'lamports', amount: i.jitoTipLamports, status: 'ESTIMATED', source: 'config.costs.jitoTipLamports' })
  if (i.flashLoanPremiumLamports) costs.push({ name: 'flash_loan_premium', unit: 'lamports', amount: i.flashLoanPremiumLamports, status: 'ESTIMATED', source: 'provider fee' })
  if (i.nonRecoverableRentLamports > 0n) costs.push({ name: 'rent_non_recoverable', unit: 'lamports', amount: i.nonRecoverableRentLamports, status: 'ESTIMATED', source: 'accounts created without close' })
  if (i.recoveryTxFeeLamports) costs.push({ name: 'recovery_tx_fee', unit: 'lamports', amount: i.recoveryTxFeeLamports, status: 'ESTIMATED', source: 'fee of the separate transaction that closes the accounts created by the circuit' })
  const locked: CostItem[] = i.recoverableRentLamports > 0n ? [{ name: 'rent_locked_recoverable', unit: 'lamports', amount: i.recoverableRentLamports, status: 'ESTIMATED', source: 'deposits of accounts created by the circuit; recovered only by a successful close (its fee is a separate definitive cost)' }] : []
  return { costs, locked, total: costs.reduce((s, c) => s + c.amount, 0n) }
}
export function transactionPnl(t: TradingPnl, ext: ReturnType<typeof externalCosts>, incompleteReasons: string[] = []): TransactionPnl {
  return { ...t, externalCosts: ext.costs, lockedCapital: ext.locked, pnlAfterExternal: t.pnl - ext.total, status: incompleteReasons.length ? 'ACCOUNTING_INCOMPLETE' : 'COMPLETE', incompleteReasons }
}
export function operatingPnl(periodStartUtc: string, periodEndUtc: string, txs: TransactionPnl[], failedAttempts: { count: number; costEachLamports: bigint }, infra: CostItem[]): OperatingPnl {
  const sum = txs.reduce((s, t) => s + t.pnlAfterExternal, 0n)
  const failed: CostItem[] = failedAttempts.count > 0 ? [{ name: 'failed_attempts', unit: 'lamports', amount: BigInt(failedAttempts.count) * failedAttempts.costEachLamports, status: 'ESTIMATED', source: `${failedAttempts.count} x ${failedAttempts.costEachLamports}` }] : []
  const infraTotal = infra.reduce((s, c) => s + c.amount, 0n)
  const failedTotal = failed.reduce((s, c) => s + c.amount, 0n)
  const attempts = txs.length + failedAttempts.count
  return { periodStartUtc, periodEndUtc, sumTransactionPnl: sum, failedAttemptCosts: failed, infrastructureCosts: infra, pnl: sum - failedTotal - infraTotal, attempts, status: attempts === 0 ? 'NOT_TESTED' : (txs.some(t => t.status !== 'COMPLETE') ? 'INCOMPLETE' : 'COMPLETE') }
}

export interface FailureScenario { landingRate: number; expectedNetPerAttempt: bigint; attemptsToBreakEven: number | null }
/**
 * Failure-cost scenarios for a candidate whose realised profit would be `pnlIfLanded`: at a landing rate r, the expected net per attempt is
 * r * pnlIfLanded - attemptCost (every attempt pays the network fee, only a landed one earns). `attemptsToBreakEven` = ceil(attemptCost / expectedNet):
 * how many attempts at this rate recover the cost of one failed attempt (null when the expectation is not positive). The landing rate itself is NOT estimated here: it is unknown before live.
 */
export function failureScenarios(pnlIfLanded: bigint, attemptCostLamports: bigint, landingRates: number[] = [1, 0.5, 0.25, 0.1, 0.05, 0.01]): FailureScenario[] {
  return landingRates.map(r => {
    const scaled = (pnlIfLanded * BigInt(Math.round(r * 1e6))) / 1_000_000n
    const net = scaled - attemptCostLamports
    return { landingRate: r, expectedNetPerAttempt: net, attemptsToBreakEven: net > 0n ? Number((attemptCostLamports + net - 1n) / net) : null }
  })
}
/** The landing rate at which a candidate stops losing money, given the cost of an attempt. Null when it is unreachable (pnl <= cost even at rate 1). */
export function breakEvenLandingRate(pnlIfLanded: bigint, attemptCostLamports: bigint): number | null {
  if (pnlIfLanded <= 0n || pnlIfLanded <= attemptCostLamports) return null
  return Number((attemptCostLamports * 1_000_000n) / pnlIfLanded) / 1e6
}

/**
 * Reconciles one attempt end to end (F1 of the independent audit): the listed costs must sum to the total that is deducted, a recoverable deposit is
 * never counted as a loss, and every native lamport that left the wallet must be explained. Anything left over is reported as `unexplained`
 * and downgrades the status instead of silently disappearing into a "COMPLETE" report.
 */
export function reconcileAttempt(input: {
  tradingPnl: bigint
  /** measured native lamports that left the wallet during the attempt (0 when not measured) */
  observedNativeSpend: bigint
  definitiveCosts: CostItem[]
  lockedRecoverable: CostItem[]
  /** measured base-asset delta of the user's token account (defaults to tradingPnl when the attempt executed) */
  baseAssetDelta?: bigint | undefined
  nativeLamportDelta?: bigint | undefined
  incompleteReasons?: string[]
  notes?: string[]
  /** costs that are native-lamport outflows; anything else (e.g. a fee paid in the base token) is excluded from the native reconciliation */
  nativeCostNames?: string[]
}): AttemptAccounting {
  const definitiveTotal = input.definitiveCosts.reduce((s, c) => s + c.amount, 0n)
  const lockedTotal = input.lockedRecoverable.reduce((s, c) => s + c.amount, 0n)
  const nativeNames = new Set(input.nativeCostNames ?? input.definitiveCosts.filter(c => c.unit === 'lamports').map(c => c.name))
  const explainedByCosts = input.definitiveCosts.filter(c => nativeNames.has(c.name)).reduce((s, c) => s + c.amount, 0n)
  const unexplained = input.observedNativeSpend - explainedByCosts - lockedTotal
  const incompleteReasons = [...(input.incompleteReasons ?? [])]
  if (unexplained !== 0n) incompleteReasons.push(`NATIVE_SPEND_UNEXPLAINED: observed ${input.observedNativeSpend} lamports left the wallet, ${explainedByCosts} explained by costs and ${lockedTotal} by recoverable deposits, ${unexplained} unaccounted`)
  const baseAssetDelta = input.baseAssetDelta ?? input.tradingPnl
  const nativeLamportDelta = input.nativeLamportDelta ?? -input.observedNativeSpend
  return {
    tradingPnl: input.tradingPnl, definitiveCosts: input.definitiveCosts, definitiveTotal, lockedRecoverable: input.lockedRecoverable, lockedTotal,
    netAfterDefinitiveCosts: input.tradingPnl - definitiveTotal,
    liquidWalletDelta: baseAssetDelta + nativeLamportDelta,
    reconciliation: { observedNativeSpend: input.observedNativeSpend, explainedByCosts, explainedByLocked: lockedTotal, unexplained, ok: unexplained === 0n },
    status: incompleteReasons.length ? 'ACCOUNTING_INCOMPLETE' : 'COMPLETE',
    incompleteReasons, notes: input.notes ?? [],
  }
}
