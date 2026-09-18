import type { PublicKey } from '@solana/web3.js'
/** Cost provenance. Every cost has a unit, a source and a status. */
export type CostStatus = 'INCLUDED_IN_QUOTE' | 'ESTIMATED' | 'OBSERVED'
export type CostUnit = 'lamports' | 'token_raw' | 'bps'
export interface CostItem {
  name: string
  unit: CostUnit
  amount: bigint
  mint?: PublicKey | undefined
  status: CostStatus
  source: string
  note?: string | undefined
}
/** Trading PnL: net base-asset out minus in, DEX/creator/transfer fees applied exactly once (inside the quotes). */
export interface TradingPnl {
  baseMint: PublicKey
  amountIn: bigint
  amountOut: bigint
  pnl: bigint
  feesInsideQuotes: CostItem[]
}
/** Transaction PnL: trading PnL minus external costs not inside quotes (network base fee, priority fee, tips, flash-loan premium, non-recoverable rent). */
export interface TransactionPnl extends TradingPnl {
  externalCosts: CostItem[]
  /** capital locked but recoverable (ATA rent deposits) — NOT a cost unless the account cannot be closed */
  lockedCapital: CostItem[]
  pnlAfterExternal: bigint
  status: 'COMPLETE' | 'ACCOUNTING_INCOMPLETE'
  incompleteReasons: string[]
}
/** Operating PnL: transaction PnL minus infrastructure allocated to the period and the cost of failed attempts. */
export interface OperatingPnl {
  periodStartUtc: string
  periodEndUtc: string
  sumTransactionPnl: bigint
  failedAttemptCosts: CostItem[]
  infrastructureCosts: CostItem[]
  pnl: bigint
  /** counts used to derive the above; zero probes => NOT_TESTED */
  attempts: number
  status: 'NOT_TESTED' | 'INCOMPLETE' | 'COMPLETE'
}
/**
 * Full reconciliation of one attempt, so that no number in a report can contradict another.
 * Invariants enforced by `reconcileAttempt` and by tests:
 *   sum(definitiveCosts)        === definitiveTotal
 *   netAfterDefinitiveCosts     === tradingPnl - definitiveTotal
 *   observedNativeSpend         === definitiveTotal(native part) + sum(lockedRecoverable) + unexplained
 *   liquidWalletDelta           === baseAssetDelta + nativeLamportDelta   (what the wallet can actually spend next)
 */
export interface AttemptAccounting {
  /** what the swaps produced in the base asset (DEX and transfer fees already inside the quotes) */
  tradingPnl: bigint
  /** costs that are gone for good: network base fee, prioritization fee, tip, flash premium, rent of accounts that will not be closed, close-transaction fees */
  definitiveCosts: CostItem[]
  definitiveTotal: bigint
  /** deposits parked in accounts the circuit created: recoverable ONLY by a successful close, which itself costs a fee */
  lockedRecoverable: CostItem[]
  lockedTotal: bigint
  /** tradingPnl - definitiveTotal (locked capital is NOT a loss) */
  netAfterDefinitiveCosts: bigint
  /** base-asset delta + native lamport delta: how much the spendable wallet moved */
  liquidWalletDelta: bigint
  /** every native lamport that left the wallet must be explained by a definitive cost or a locked deposit */
  reconciliation: { observedNativeSpend: bigint; explainedByCosts: bigint; explainedByLocked: bigint; unexplained: bigint; ok: boolean }
  status: 'COMPLETE' | 'ACCOUNTING_INCOMPLETE'
  incompleteReasons: string[]
  notes: string[]
}
export type EvidenceLevel = 'QUOTE_ONLY' | 'LOCAL_MOCK_SIMULATION' | 'LOCAL_REAL_PROGRAM_SIMULATION' | 'MAINNET_RPC_SIMULATION' | 'CONFIRMED_EXECUTION'
