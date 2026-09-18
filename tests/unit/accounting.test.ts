import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { externalCosts, transactionPnl, tradingPnl, operatingPnl } from '../../src/accounting/pnl.js'
import { MockAdapter, mockPool } from '../helpers/mock_adapter.js'
import { WSOL_MINT } from '../../src/state/token.js'
import { parseDuration } from '../../src/cli/shadow.js'
const SOL = 1_000_000_000n
describe('external costs', () => {
  it('formula path: base + ceil(cu*price/1e6), no double counting when getFeeForMessage is present', () => {
    const a = externalCosts({ baseFeeLamports: 5000n, signatures: 1, computeUnitLimit: 400_000, computeUnitPriceMicroLamports: 10_000, jitoTipLamports: 0n, nonRecoverableRentLamports: 0n, recoverableRentLamports: 2_039_280n })
    expect(a.costs.map(c => c.name)).toEqual(['base_fee', 'priority_fee']); expect(a.total).toBe(5000n + 4000n)
    expect(a.locked[0]!.amount).toBe(2_039_280n)   // rent is locked, not a cost
    const b = externalCosts({ baseFeeLamports: 5000n, signatures: 1, computeUnitLimit: 400_000, computeUnitPriceMicroLamports: 10_000, feeForMessageLamports: 9000n, jitoTipLamports: 0n, nonRecoverableRentLamports: 0n, recoverableRentLamports: 0n })
    expect(b.costs).toHaveLength(1); expect(b.total).toBe(9000n); expect(b.costs[0]!.status).toBe('OBSERVED')
  })
  it('priority fee rounds up (1 micro-lamport per CU over 100k CU = 1 lamport)', () => {
    const a = externalCosts({ baseFeeLamports: 5000n, signatures: 1, computeUnitLimit: 100_000, computeUnitPriceMicroLamports: 1, jitoTipLamports: 0n, nonRecoverableRentLamports: 0n, recoverableRentLamports: 0n })
    expect(a.total).toBe(5001n)
  })
})
describe('pnl classes', () => {
  const adapters = { raydium_cpmm: new MockAdapter('raydium_cpmm'), pumpswap: new MockAdapter('pumpswap') }
  const t = Keypair.generate().publicKey
  const a = mockPool('raydium_cpmm', t, 100n * SOL, 1_100_000n * 1_000_000n, 25), b = mockPool('pumpswap', t, 100n * SOL, 1_000_000n * 1_000_000n, 25)
  it('trading pnl requires leg B input == leg A output (no inventory sale) and lists fees without subtracting them again', () => {
    const qa = adapters.raydium_cpmm.quoteExactIn(a, WSOL_MINT, SOL); const qb = adapters.pumpswap.quoteExactIn(b, t, qa.amountOutToUser)
    const p = tradingPnl(WSOL_MINT, qa, qb)
    expect(p.pnl).toBe(qb.amountOutToUser - SOL); expect(p.feesInsideQuotes).toHaveLength(2); expect(p.feesInsideQuotes.every(f => f.status === 'INCLUDED_IN_QUOTE')).toBe(true)
    const qbBad = adapters.pumpswap.quoteExactIn(b, t, qa.amountOutToUser + 1n)
    expect(() => tradingPnl(WSOL_MINT, qa, qbBad)).toThrow(/no pre-existing inventory/)
  })
  it('transaction and operating pnl statuses', () => {
    const qa = adapters.raydium_cpmm.quoteExactIn(a, WSOL_MINT, SOL); const qb = adapters.pumpswap.quoteExactIn(b, t, qa.amountOutToUser)
    const tp = transactionPnl(tradingPnl(WSOL_MINT, qa, qb), externalCosts({ baseFeeLamports: 5000n, signatures: 1, computeUnitLimit: 200_000, computeUnitPriceMicroLamports: 0, jitoTipLamports: 0n, nonRecoverableRentLamports: 0n, recoverableRentLamports: 0n }))
    expect(tp.pnlAfterExternal).toBe(tp.pnl - 5000n); expect(tp.status).toBe('COMPLETE')
    expect(operatingPnl('a', 'b', [], { count: 0, costEachLamports: 5000n }, []).status).toBe('NOT_TESTED')
    const op = operatingPnl('a', 'b', [tp], { count: 3, costEachLamports: 5000n }, [{ name: 'rpc', unit: 'lamports', amount: 100n, status: 'ESTIMATED', source: 'x' }])
    expect(op.pnl).toBe(tp.pnlAfterExternal - 15_000n - 100n); expect(op.attempts).toBe(4); expect(op.status).toBe('COMPLETE')
    const inc = transactionPnl(tradingPnl(WSOL_MINT, qa, qb), externalCosts({ baseFeeLamports: 5000n, signatures: 1, computeUnitLimit: 1, computeUnitPriceMicroLamports: 0, jitoTipLamports: 0n, nonRecoverableRentLamports: 0n, recoverableRentLamports: 0n }), ['missing fee'])
    expect(operatingPnl('a', 'b', [inc], { count: 0, costEachLamports: 0n }, []).status).toBe('INCOMPLETE')
  })
})
describe('duration parsing', () => { it('parses m/h/s', () => { expect(parseDuration('60m')).toBe(60); expect(parseDuration('2h')).toBe(120); expect(parseDuration('90s')).toBe(1.5); expect(() => parseDuration('x')).toThrow() }) })

import { parseSimError, classifySimError } from '../../src/simulation/probe.js'
describe('simulation error identity', () => {
  it('extracts the failing instruction index and custom code of the TESTED message', () => {
    expect(parseSimError({ InstructionError: [3, { Custom: 6001 }] }, ['Program log: AnchorError … Error Code: ZeroBaseAmount. Error Number: 6001.']))
      .toEqual({ instructionIndex: 3, kind: 'Custom', customCode: 6001, programLogError: expect.stringContaining('ZeroBaseAmount') })
    expect(parseSimError({ InstructionError: [0, 'InsufficientFunds'] }, [])).toEqual({ instructionIndex: 0, kind: 'InsufficientFunds', customCode: null, programLogError: null })
    expect(parseSimError('BlockhashNotFound', [])).toEqual({ instructionIndex: null, kind: 'BlockhashNotFound', customCode: null, programLogError: null })
    expect(parseSimError(null, [])).toEqual({ instructionIndex: null, kind: null, customCode: null, programLogError: null })
    expect(classifySimError(null, [])).toBe('OK')
    expect(classifySimError({ InstructionError: [3, { Custom: 1 }] }, ['Program log: Error: insufficient funds'])).toMatch(/INSUFFICIENT_FUNDS/)
  })
})

import { failureScenarios, breakEvenLandingRate } from '../../src/accounting/pnl.js'
describe('failure-cost scenarios', () => {
  it('every attempt pays the fee, only a landed one earns', () => {
    const s = failureScenarios(100_000n, 9_000n, [1, 0.5, 0.1, 0.05])
    expect(s[0]!.expectedNetPerAttempt).toBe(91_000n)
    expect(s[1]!.expectedNetPerAttempt).toBe(41_000n)
    expect(s[2]!.expectedNetPerAttempt).toBe(1_000n)
    expect(s[3]!.expectedNetPerAttempt).toBe(-4_000n)
    expect(s[3]!.attemptsToBreakEven).toBeNull()
    expect(s[2]!.attemptsToBreakEven).toBe(9)     // ceil(attempt cost 9000 / expected net 1000)
  })
  it('break-even landing rate is fee / profit, and null when the profit cannot cover one attempt', () => {
    expect(breakEvenLandingRate(100_000n, 9_000n)).toBeCloseTo(0.09, 6)
    expect(breakEvenLandingRate(9_000n, 9_000n)).toBeNull()
    expect(breakEvenLandingRate(-1n, 9_000n)).toBeNull()
  })
})


import { reconcileAttempt } from '../../src/accounting/pnl.js'
import type { CostItem } from '../../src/accounting/types.js'
const lam = (name: string, amount: bigint, status: CostItem['status'] = 'OBSERVED'): CostItem => ({ name, unit: 'lamports', amount, status, source: 't' })
describe('attempt reconciliation (audit finding F1)', () => {
  it('the listed costs sum to the deducted total and a deposit is never a cost', () => {
    const a = reconcileAttempt({ tradingPnl: -95_553_322n, observedNativeSpend: 3_892_680n,
      definitiveCosts: [lam('base_fee', 5_000n), lam('priority_fee', 4_000n)],
      lockedRecoverable: [lam('deposit:intermediate_ata', 2_039_280n), lam('deposit:pumpswap_user_volume_accumulator', 1_844_400n)],
      baseAssetDelta: -95_553_322n, nativeLamportDelta: -3_892_680n })
    expect(a.definitiveTotal).toBe(9_000n)
    expect(a.definitiveCosts.reduce((s, c) => s + c.amount, 0n)).toBe(a.definitiveTotal)
    expect(a.netAfterDefinitiveCosts).toBe(-95_562_322n)
    expect(a.lockedTotal).toBe(3_883_680n)
    expect(a.liquidWalletDelta).toBe(-99_446_002n)          // the number the wallet actually feels
    expect(a.reconciliation).toMatchObject({ observedNativeSpend: 3_892_680n, explainedByCosts: 9_000n, explainedByLocked: 3_883_680n, unexplained: 0n, ok: true })
    expect(a.status).toBe('COMPLETE')
  })
  it('an unexplained native outflow downgrades the status instead of disappearing', () => {
    const a = reconcileAttempt({ tradingPnl: 0n, observedNativeSpend: 3_892_680n, definitiveCosts: [lam('base_fee', 5_000n), lam('priority_fee', 4_000n)], lockedRecoverable: [] })
    expect(a.reconciliation.unexplained).toBe(3_883_680n)
    expect(a.reconciliation.ok).toBe(false)
    expect(a.status).toBe('ACCOUNTING_INCOMPLETE')
    expect(a.incompleteReasons[0]).toMatch(/NATIVE_SPEND_UNEXPLAINED/)
  })
  it('the close fee of a planned recovery is a definitive cost, the deposit itself is not', () => {
    const e = externalCosts({ baseFeeLamports: 5_000n, signatures: 1, computeUnitLimit: 0, computeUnitPriceMicroLamports: 0, jitoTipLamports: 0n, nonRecoverableRentLamports: 0n, recoverableRentLamports: 2_039_280n, recoveryTxFeeLamports: 5_000n })
    expect(e.costs.map(c => c.name)).toContain('recovery_tx_fee')
    expect(e.total).toBe(10_000n)
    expect(e.locked.reduce((s, c) => s + c.amount, 0n)).toBe(2_039_280n)
    expect(e.costs.some(c => c.amount === 2_039_280n)).toBe(false)
  })
})
