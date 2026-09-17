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
