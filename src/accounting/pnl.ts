import type { PublicKey } from '@solana/web3.js'
import type { CostItem, TradingPnl, TransactionPnl, OperatingPnl } from './types.js'
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
  /** rent for accounts created and closed in the same tx or already existing (locked, recoverable) */
  recoverableRentLamports: bigint
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
  const locked: CostItem[] = i.recoverableRentLamports > 0n ? [{ name: 'rent_locked_recoverable', unit: 'lamports', amount: i.recoverableRentLamports, status: 'ESTIMATED', source: 'ATA rent, recoverable only after CloseAccount succeeds' }] : []
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
