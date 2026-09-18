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
  // --- F7 (independent audit): the reservation ignored the deposits the circuit must park to CREATE accounts, so it under-reserved,
  // and nothing told the sizer how large a size the ledger would actually grant. ---
  it('F7: a recoverable deposit is part of what is locked and is released untouched at settlement', () => {
    const l = new CapitalLedger(cfg)
    const deposit = 2_039_280n, fee = 9_000n, amountIn = SOL
    expect(l.reserve({ id: 'a', amountIn, feeBudget: fee, depositLamports: deposit, pools: ['p1'], mint: 'm1', utc: 'u' }).ok).toBe(true)
    expect(l.locked()).toBe(amountIn + fee + deposit)                    // the deposit is capital that must be AVAILABLE, so it is locked
    expect(l.capacityFor({ feeBudget: fee, depositLamports: deposit })).toBe(2n * SOL - fee - deposit)   // the next probe must fund its own fee and deposit too
    l.settle({ id: 'a', realisedPnl: 0n, feePaid: fee, status: 'NOT_LANDED', utc: 'u' })
    expect(l.locked()).toBe(0n)                                          // released in full: a deposit is recoverable, never a cost
    const real = new CapitalLedger({ ...cfg, hypothetical: false })
    expect(real.reserve({ id: 'a', amountIn, feeBudget: fee, depositLamports: deposit, pools: ['p1'], mint: 'm1', utc: 'u' }).ok).toBe(true)
    real.settle({ id: 'a', realisedPnl: 0n, feePaid: fee, status: 'NOT_LANDED', utc: 'u' })
    expect(real.currentCapital()).toBe(10n * SOL - fee)                  // only the fee is gone; the deposit never left the capital
  })
  it('F7: capacityFor is the exact largest amountIn the ledger will grant, deposits included', () => {
    const l = new CapitalLedger(cfg)                                     // capital 10 SOL, episode cap 20% = 2 SOL
    const fee = 9_000n, deposit = 2_039_280n
    const cap = l.capacityFor({ feeBudget: fee, depositLamports: deposit })
    expect(cap).toBe(2n * SOL - fee - deposit)
    const at = l.reserve({ id: 'at', amountIn: cap, feeBudget: fee, depositLamports: deposit, pools: ['p1'], mint: 'm1', utc: 'u' })
    expect(at.ok).toBe(true)                                             // exactly at the cap is granted
    l.settle({ id: 'at', realisedPnl: 0n, feePaid: 0n, status: 'NOT_LANDED', utc: 'u' })
    const over = l.reserve({ id: 'over', amountIn: cap + 1n, feeBudget: fee, depositLamports: deposit, pools: ['p1'], mint: 'm1', utc: 'u' })
    expect(over.ok).toBe(false); if (!over.ok) expect(over.code).toBe('EPISODE_CAP')   // one lamport above it is still refused: the caps are NOT relaxed
    // and the capacity shrinks as positions are opened, so a second probe cannot re-spend the same money
    expect(l.reserve({ id: 'b', amountIn: SOL, feeBudget: fee, depositLamports: deposit, pools: ['p2'], mint: 'm2', utc: 'u' }).ok).toBe(true)
    expect(l.capacityFor({ feeBudget: fee, depositLamports: deposit })).toBe(l.budget() - fee - deposit)
    expect(l.capacityFor({ feeBudget: 100n * SOL, depositLamports: 0n })).toBe(0n)     // never negative
  })
  it("F7: the auditor's scenario — 0.1 SOL of capital refuses a 0.1 SOL episode but grants the 0.01 SOL one", () => {
    const small = new CapitalLedger({ capitalLamports: SOL / 10n, maxEpisodeFrac: 0.2, maxAggregateOpenFrac: 0.4, reserveFrac: 0.3, maxConcurrent: 3, hypothetical: true })
    const fee = 9_000n, deposit = 2_039_280n
    const whole = small.reserve({ id: 'whole', amountIn: SOL / 10n, feeBudget: fee, depositLamports: deposit, pools: ['p1'], mint: 'm1', utc: 'u' })
    expect(whole.ok).toBe(false); if (!whole.ok) expect(whole.code).toBe('EPISODE_CAP')
    expect(small.capacityFor({ feeBudget: fee, depositLamports: deposit })).toBe(20_000_000n - fee - deposit)   // 20% of 0.1 SOL, fee and deposit taken out
    const smaller = small.reserve({ id: 'smaller', amountIn: SOL / 100n, feeBudget: fee, depositLamports: deposit, pools: ['p1'], mint: 'm1', utc: 'u' })
    expect(smaller.ok).toBe(true)                                        // 0.01 SOL fits inside the same protections
    expect(small.locked()).toBe(SOL / 100n + fee + deposit)
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
