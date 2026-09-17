import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { MockAdapter, mockPool } from '../helpers/mock_adapter.js'
import { enumerateCircuits, evaluateCircuit, sizeCircuit } from '../../src/routing/circuit.js'
import { WSOL_MINT } from '../../src/state/token.js'
const adapters = { raydium_cpmm: new MockAdapter('raydium_cpmm'), pumpswap: new MockAdapter('pumpswap') }
const SOL = 1_000_000_000n
describe('circuit enumeration', () => {
  it('produces both directions for distinct pools of the same token and labels categories', () => {
    const t = Keypair.generate().publicKey
    const a = mockPool('raydium_cpmm', t, 100n * SOL, 1_000_000n * 1_000_000n, 25)
    const b = mockPool('pumpswap', t, 100n * SOL, 1_000_000n * 1_000_000n, 30)
    const c = mockPool('pumpswap', t, 50n * SOL, 500_000n * 1_000_000n, 30)
    const cs = enumerateCircuits([a, b, c, a]) // duplicate a must be deduped
    expect(cs).toHaveLength(6)
    expect(cs.filter(x => x.category === 'cross_adapter')).toHaveLength(4)
    expect(cs.filter(x => x.category === 'same_adapter')).toHaveLength(2)
    expect(cs.every(x => !x.poolA.address.equals(x.poolB.address))).toBe(true)
  })
  it('ignores pools not quoted in WSOL', () => {
    const t = Keypair.generate().publicKey; const p = mockPool('pumpswap', t, 1n, 1n, 30); p.mintA = { ...p.mintA, mint: Keypair.generate().publicKey }
    expect(enumerateCircuits([p, mockPool('pumpswap', t, 1n, 1n, 30)])).toHaveLength(0)
  })
})
describe('circuit evaluation', () => {
  it('same reserves on both pools with fees never profits at any size (no artificial profit)', () => {
    const t = Keypair.generate().publicKey
    const a = mockPool('raydium_cpmm', t, 100n * SOL, 1_000_000n * 1_000_000n, 25), b = mockPool('pumpswap', t, 100n * SOL, 1_000_000n * 1_000_000n, 25)
    const [c] = enumerateCircuits([a, b])
    for (const x of [1000n, SOL / 100n, SOL, 10n * SOL]) { const r = evaluateCircuit(adapters, c!, x); expect(r.ok).toBe(true); if (r.ok) expect(r.value.pnl.pnl).toBeLessThan(0n) }
    const s = sizeCircuit(adapters, c!, [SOL / 100n, SOL, 10n * SOL], 100n * SOL, 6)
    expect(s.best).toBeNull(); expect(s.zeroTradeChosen).toBe(true)
  })
  it('price discrepancy yields positive pnl in one direction only and leg B consumes exactly leg A output', () => {
    const t = Keypair.generate().publicKey
    const cheap = mockPool('raydium_cpmm', t, 100n * SOL, 1_100_000n * 1_000_000n, 25)   // token cheaper here
    const rich = mockPool('pumpswap', t, 100n * SOL, 1_000_000n * 1_000_000n, 25)
    const cs = enumerateCircuits([cheap, rich])
    const good = cs.find(c => c.poolA.address.equals(cheap.address))!, bad = cs.find(c => c.poolA.address.equals(rich.address))!
    const rg = evaluateCircuit(adapters, good, SOL); const rb = evaluateCircuit(adapters, bad, SOL)
    expect(rg.ok && rg.value.pnl.pnl > 0n).toBe(true)
    expect(rb.ok && rb.value.pnl.pnl < 0n).toBe(true)
    if (rg.ok) { expect(rg.value.quoteB.amountIn).toBe(rg.value.quoteA.amountOutToUser); expect(rg.value.pnl.amountIn).toBe(SOL); expect(rg.value.quoteB.outputMint.equals(WSOL_MINT)).toBe(true) }
  })
  it('sizing finds a better size than the grid and never exceeds max capital', () => {
    const t = Keypair.generate().publicKey
    const cheap = mockPool('raydium_cpmm', t, 100n * SOL, 1_100_000n * 1_000_000n, 25), rich = mockPool('pumpswap', t, 100n * SOL, 1_000_000n * 1_000_000n, 25)
    const good = enumerateCircuits([cheap, rich]).find(c => c.poolA.address.equals(cheap.address))!
    const grid = [SOL / 10n, SOL, 10n * SOL]
    const s = sizeCircuit(adapters, good, grid, 5n * SOL, 10)
    expect(s.best).not.toBeNull()
    const gridBest = grid.filter(g => g <= 5n * SOL).map(g => { const r = evaluateCircuit(adapters, good, g); return r.ok ? r.value.pnl.pnl : -1n }).reduce((m, x) => (x > m ? x : m), -1n)
    expect(s.best!.pnl.pnl).toBeGreaterThanOrEqual(gridBest)
    expect(s.best!.amountIn).toBeLessThanOrEqual(5n * SOL)
    expect(s.evaluated.every(e => e.amountIn <= 5n * SOL)).toBe(true)
  })
  it('a zero-size trade is rejected explicitly', () => {
    const t = Keypair.generate().publicKey
    const [c] = enumerateCircuits([mockPool('raydium_cpmm', t, SOL, SOL, 25), mockPool('pumpswap', t, SOL, SOL, 25)])
    expect(evaluateCircuit(adapters, c!, 0n)).toEqual({ ok: false, reason: 'ZERO_TRADE' })
  })
})

describe('shared pools across routes', () => {
  it('two circuits that share a pool cannot both be evaluated against the untouched state: the second must use the post-swap reserves', () => {
    const t = Keypair.generate().publicKey
    const cheap = mockPool('raydium_cpmm', t, 100n * SOL, 1_100_000n * 1_000_000n, 25)
    const richA = mockPool('pumpswap', t, 100n * SOL, 1_000_000n * 1_000_000n, 25)
    const richB = mockPool('pumpswap', t, 100n * SOL, 1_000_000n * 1_000_000n, 25)
    const circuits = enumerateCircuits([cheap, richA, richB]).filter(c => c.poolA.address.equals(cheap.address))
    expect(circuits).toHaveLength(2)                                   // both sell into a different rich pool but BUY from the same cheap pool
    const size = SOL
    const first = evaluateCircuit(adapters, circuits[0]!, size); expect(first.ok).toBe(true); if (!first.ok) return
    const naiveSecond = evaluateCircuit(adapters, circuits[1]!, size); expect(naiveSecond.ok).toBe(true); if (!naiveSecond.ok) return
    expect(naiveSecond.value.pnl.pnl).toBe(first.value.pnl.pnl)         // identical because both assume the untouched shared pool
    // sequential reality: the shared pool has already been traded by the first circuit
    const usedCheap = adapters.raydium_cpmm.applySwap(cheap, first.value.quoteA)
    const sequential = evaluateCircuit(adapters, { ...circuits[1]!, poolA: usedCheap }, size)
    expect(sequential.ok).toBe(true); if (!sequential.ok) return
    expect(sequential.value.pnl.pnl).toBeLessThan(naiveSecond.value.pnl.pnl)   // no duplicated profit from the same reserves
    expect(sequential.value.quoteA.amountOutToUser).toBeLessThan(first.value.quoteA.amountOutToUser)
  })
  it('applySwap does not mutate the pool it is given', () => {
    const t = Keypair.generate().publicKey
    const p = mockPool('pumpswap', t, 10n * SOL, 1_000_000n * 1_000_000n, 30)
    const before = { a: p.reserveA, b: p.reserveB }
    const q = adapters.pumpswap.quoteExactIn(p, WSOL_MINT, SOL)
    const after = adapters.pumpswap.applySwap(p, q)
    expect({ a: p.reserveA, b: p.reserveB }).toEqual(before)
    expect(after.reserveA).not.toBe(p.reserveA)
  })
})
