import { describe, it, expect } from 'vitest'
import { CapitalLedger } from '../../src/accounting/capital.js'
const SOL = 1_000_000_000n
const cfg = { capitalLamports: 10n * SOL, maxEpisodeFrac: 0.2, maxAggregateOpenFrac: 0.4, reserveFrac: 0.3, maxConcurrent: 3 }
const res = (l: CapitalLedger, id: string, amountIn: bigint, pools: string[], mint = id) => l.reserve({ id, amountIn, feeBudget: 10_000n, pools, mint, utc: 'u' })
describe('CapitalLedger', () => {
  it('applies the three limits simultaneously: 20% per episode, 40% aggregate, 30% reserve untouched', () => {
    const l = new CapitalLedger(cfg)
    expect(l.budget()).toBe(2n * SOL)                                   // min(20%, 40%, 70%)
    expect(res(l, 'a', 2n * SOL, ['p1']).ok).toBe(false)                // 2 SOL + fee > 20% cap
    expect(res(l, 'a', 2n * SOL - 10_000n, ['p1']).ok).toBe(true)
    expect(l.locked()).toBe(2n * SOL)
    expect(l.budget()).toBe(2n * SOL)                                   // aggregate 4 - 2 = 2
    expect(res(l, 'b', 2n * SOL - 10_000n, ['p2'], 'm2').ok).toBe(true)
    expect(l.budget()).toBe(0n)                                          // aggregate cap reached
    const third = res(l, 'c', SOL, ['p3'], 'm3')
    expect(third.ok).toBe(false); if (!third.ok) expect(third.code).toBe('AGGREGATE_CAP')
  })
  it('never spends the same money twice and never credits before settlement', () => {
    const l = new CapitalLedger(cfg)
    expect(res(l, 'a', SOL, ['p1']).ok).toBe(true)
    expect(l.currentCapital()).toBe(10n * SOL)                           // nothing credited yet
    expect(l.locked()).toBe(SOL + 10_000n)
    const dup = res(l, 'a', SOL, ['p9'], 'm9'); expect(dup.ok).toBe(false); if (!dup.ok) expect(dup.code).toBe('DUPLICATE_ID')
    l.settle({ id: 'a', realisedPnl: 500_000n, feePaid: 5_000n, status: 'FILLED', utc: 'u' })
    expect(l.locked()).toBe(0n)
    expect(l.currentCapital()).toBe(10n * SOL)                           // hypothetical mode: capital unchanged
    expect(l.snapshot()['stats']).toMatchObject({ filled: 1, settled: 1, feesPaid: 5_000n, hypotheticalPnl: 495_000n })
    const real = new CapitalLedger({ ...cfg, hypothetical: false })
    expect(res(real, 'a', SOL, ['p1']).ok).toBe(true)
    real.settle({ id: 'a', realisedPnl: 500_000n, feePaid: 5_000n, status: 'FILLED', utc: 'u' })
    expect(real.currentCapital()).toBe(10n * SOL + 495_000n)             // credited only at settlement
    expect(real.realisedNet()).toBe(495_000n)
  })
  it('a reverted or non-landed attempt costs its fee and returns the capital', () => {
    const real = new CapitalLedger({ ...cfg, hypothetical: false })
    expect(res(real, 'a', SOL, ['p1']).ok).toBe(true)
    real.settle({ id: 'a', realisedPnl: 0n, feePaid: 5_000n, status: 'REVERTED', utc: 'u' })
    expect(real.currentCapital()).toBe(10n * SOL - 5_000n); expect(real.locked()).toBe(0n)
    expect(res(real, 'b', SOL, ['p2'], 'm2').ok).toBe(true)
    real.settle({ id: 'b', realisedPnl: 9_999n, feePaid: 5_000n, status: 'NOT_LANDED', utc: 'u' })
    expect(real.currentCapital()).toBe(10n * SOL - 10_000n)              // a PnL that never landed is not credited
    expect(real.snapshot()['stats']).toMatchObject({ reverted: 1, notLanded: 1 })
  })
  it('refuses overlapping pools, the same mint, and more than the concurrency limit', () => {
    const l = new CapitalLedger({ ...cfg, maxEpisodeFrac: 0.05, maxAggregateOpenFrac: 0.6, maxConcurrent: 2 })
    expect(res(l, 'a', 100_000n, ['p1', 'p2'], 'm1').ok).toBe(true)
    const conflict = res(l, 'b', 100_000n, ['p2', 'p3'], 'm2'); expect(conflict.ok).toBe(false); if (!conflict.ok) expect(conflict.code).toBe('POOL_CONFLICT')
    const sameMint = res(l, 'c', 100_000n, ['p4'], 'm1'); expect(sameMint.ok).toBe(false); if (!sameMint.ok) expect(sameMint.code).toBe('MINT_CONFLICT')
    expect(res(l, 'd', 100_000n, ['p5'], 'm5').ok).toBe(true)
    const third = res(l, 'e', 100_000n, ['p6'], 'm6'); expect(third.ok).toBe(false); if (!third.ok) expect(third.code).toBe('CONCURRENCY')
  })
  it('settling an unknown position is an error, and the ledger invariant holds under interleaving', () => {
    const l = new CapitalLedger(cfg)
    expect(() => l.settle({ id: 'ghost', realisedPnl: 0n, feePaid: 0n, status: 'FILLED', utc: 'u' })).toThrow(/SETTLE_UNKNOWN_POSITION/)
    for (let i = 0; i < 20; i++) {
      const r = res(l, `x${i}`, 500_000_000n, [`pool${i}`], `mint${i}`)
      if (r.ok && i % 2 === 0) l.settle({ id: `x${i}`, realisedPnl: 1n, feePaid: 1n, status: 'FILLED', utc: 'u' })
      expect(l.locked()).toBeGreaterThanOrEqual(0n)
      expect(l.locked()).toBeLessThanOrEqual((l.currentCapital() * 4n) / 10n)
    }
  })
})
