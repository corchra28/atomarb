import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import type { PoolRef } from '../../src/adapters/types.js'
import { WSOL_MINT } from '../../src/state/token.js'
import { buildPopulation, renderPopulationMarkdown, compareRoutes, counterMintOf, mintPairOf, shortKey, type CandidateRoute } from '../../src/discovery/population.js'
const W = WSOL_MINT.toBase58()
function key(n: number): PublicKey { const b = new Uint8Array(32); b[0] = n & 0xff; b[1] = n >> 8; b[31] = 7; return new PublicKey(b) }
const M = (n: number) => key(1000 + n).toBase58()
function ray(n: number, mint: string, tvl: number | null, configIndex = 0): PoolRef {
  const [a, b] = W < mint ? [W, mint] : [mint, W]
  return { adapter: 'raydium_cpmm', address: key(n), source: { kind: 'raydium_api_v3', ref: 'u', observedAtUtc: 'T' }, hints: { mintA: a, mintB: b, tvl, configIndex } }
}
function pump(n: number, mint: string, index = 0, canonical = true, quote = W): PoolRef {
  return { adapter: 'pumpswap', address: key(n), source: { kind: 'local_pumpswap_inventory', ref: 'sha', observedAtUtc: 'T' }, hints: { base_mint: mint, quote_mint: quote, index, canonical, tvl: null, liquidityHint: 'unknown' } }
}
const raydium = [ray(1, M(1), 100), ray(3, M(2), 50), ray(4, M(2), 500, 1), ray(8, M(4), 5000), { ...ray(12, M(1), 1), hints: { mintA: M(1), mintB: M(2), tvl: 1 } }]
const pumpswap = [pump(2, M(1)), pump(5, M(3), 0, true), pump(6, M(3), 1, false), pump(7, M(3), 0, false), pump(9, M(4)), pump(10, M(4)), pump(11, M(5)), pump(9, M(4)), pump(13, M(5), 0, true, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')]
const base = { raydium, pumpswap, maxPools: 50, maxMints: 2000, generatedAtUtc: '2026-09-17T00:00:00.000Z' }
const addr = (n: number) => key(n).toBase58()
describe('population categories, dedup and collisions', () => {
  const rep = buildPopulation(base)
  it('counts pools, mints and categories', () => {
    expect(rep.counts).toMatchObject({ raydium_cpmm_wsol_pools: 4, pumpswap_wsol_pools: 7, raydium_mints: 3, pumpswap_mints: 4, pumpswap_mints_with_2plus: 2, cross_adapter_mints: 2, raydium_mints_with_2plus: 1, routes_pumpswap_x2: 4, routes_cross_adapter: 3, routes_raydium_x2: 1, routes_total: 8, duplicate_addresses: 1, pair_collisions: 3, excluded_not_wsol_pair: 2 })
    expect(rep.categories.pumpswap_x2.map(c => c.mint)).toEqual([M(3), M(4)].sort()); expect(rep.categories.cross_adapter.map(c => c.mint).sort()).toEqual([M(1), M(4)].sort()); expect(rep.categories.raydium_x2[0]?.mint).toBe(M(2))
    expect(rep.dedup.duplicateAddresses).toEqual([{ adapter: 'pumpswap', address: addr(9), occurrences: 2 }])
    expect(rep.dedup.excludedNotWsolPair.map(e => e.address).sort()).toEqual([addr(12), addr(13)].sort())
    const rayColl = rep.dedup.pairCollisions.find(c => c.adapter === 'raydium_cpmm')!; expect(rayColl.addresses).toEqual([addr(3), addr(4)].sort()); expect([rayColl.mintA, rayColl.mintB]).toContain(W)
    expect(rep.dedup.pairCollisions.filter(c => c.adapter === 'pumpswap').map(c => c.mintA).sort()).toEqual([M(3), M(4)].sort())
  })
  it('ranks routes: known liquidity desc (min_tvl / raydium_tvl_only), unknown last with canonical tiebreak, fully deterministic', () => {
    const r = rep.routes
    expect(r.slice(0, 2).every(x => x.mint === M(4) && x.liquidityRank === 5000 && x.liquidityBasis === 'raydium_tvl_only' && x.poolA.adapter === 'raydium_cpmm' && x.poolB.adapter === 'pumpswap')).toBe(true)
    expect(r[2]).toMatchObject({ mint: M(1), liquidityRank: 100, liquidityBasis: 'raydium_tvl_only', category: 'cross_adapter' })
    expect(r[3]).toMatchObject({ mint: M(2), liquidityRank: 50, liquidityBasis: 'min_tvl', category: 'raydium_x2' })
    expect(r.slice(4).every(x => x.liquidityRank === null && x.liquidityBasis === 'unknown_liquidity' && x.category === 'pumpswap_x2')).toBe(true)
    const m3 = r.filter(x => x.mint === M(3)); expect(m3.map(x => x.canonicalCount)).toEqual([1, 1, 0])
    for (let i = 1; i < r.length; i++) expect(compareRoutes(r[i - 1]!, r[i]!)).toBeLessThanOrEqual(0)
    const again = buildPopulation({ ...base, raydium: [...raydium].reverse(), pumpswap: [...pumpswap].reverse() })
    expect(JSON.stringify(again)).toBe(JSON.stringify(rep))
  })
  it('shortlist walks ranked routes within maxPools / maxMints / maxPoolsPerMint', () => {
    expect(rep.counts).toMatchObject({ shortlist_pools: 10, shortlist_routes: 8, shortlist_mints: 4 })
    for (const s of rep.shortlist) { expect(['raydium_cpmm', 'pumpswap']).toContain(s.adapter); expect(typeof s.mint).toBe('string'); expect(s.source.kind).toBeTruthy(); expect(s.hints).toBeDefined() }
    const three = buildPopulation({ ...base, maxPools: 3 }); expect(three.counts).toMatchObject({ shortlist_pools: 3, shortlist_routes: 2, shortlist_mints: 1 }); expect(three.shortlist.every(s => s.mint === M(4))).toBe(true)
    const oneMint = buildPopulation({ ...base, maxMints: 1 }); expect(oneMint.counts).toMatchObject({ shortlist_pools: 3, shortlist_routes: 3, shortlist_mints: 1 }) // the M4 pumpswap pair adds no new pool, so it is admitted
    const perMint = buildPopulation({ ...base, maxPoolsPerMint: 2 }); expect(perMint.counts).toMatchObject({ shortlist_pools: 8, shortlist_routes: 4 }); expect(perMint.limits.maxPoolsPerMint).toBe(2)
    const capped = buildPopulation({ ...base, maxRoutesPerMint: 2 }); expect(capped.counts.routes_truncated_by_per_mint_cap).toBe(1); expect(capped.counts.routes_total).toBe(7)
  })
  it('markdown is <= 100 columns and copy-pasteable', () => {
    const md = renderPopulationMarkdown(rep)
    for (const line of md.split('\n')) expect(line.length).toBeLessThanOrEqual(100)
    expect(md).toContain('| (b) cross-adapter mints (both) | 2 |'); expect(md).toContain(shortKey(addr(8))); expect(md).toContain(addr(8))
    const wide = buildPopulation({ ...base, notes: ['x'.repeat(150)], warnings: ['w'.repeat(120)] })
    for (const line of renderPopulationMarkdown(wide).split('\n')) expect(line.length).toBeLessThanOrEqual(100)
  })
  it('helpers: mint pair / counter mint / shortKey', () => {
    expect(mintPairOf(pump(2, M(1)))).toEqual({ mintA: M(1), mintB: W }); expect(counterMintOf(ray(1, M(1), 1))).toBe(M(1)); expect(counterMintOf(raydium[4]!)).toBeNull()
    expect(counterMintOf({ ...pump(2, M(1)), hints: {} })).toBeNull(); expect(shortKey('abc')).toBe('abc'); expect(shortKey(addr(1)).length).toBe(12)
  })
  it('empty inputs produce an empty but well-formed report', () => {
    const e = buildPopulation({ ...base, raydium: [], pumpswap: [] })
    expect(e.counts.routes_total).toBe(0); expect(e.shortlist).toEqual([]); expect(renderPopulationMarkdown(e)).toContain('## Shortlist pools (0)')
    const r: CandidateRoute[] = e.routes; expect(r).toEqual([])
  })
})

// Regressions for the adversarial review (docs/agent_runs/workflow_results.json, target "discovery")
import { buildPopulation as buildPop2 } from '../../src/discovery/population.js'
import { PublicKey as PK2 } from '@solana/web3.js'
describe('review regressions: duplicate rows must not depend on input order', () => {
  const addr = PK2.unique(), mint = PK2.unique(), wsol = new PK2('So11111111111111111111111111111111111111112')
  const row = (tvl: number) => ({ adapter: 'raydium_cpmm' as const, address: addr, source: { kind: 'raydium_api_v3', ref: 'p', observedAtUtc: 'u' }, hints: { mintA: wsol.toBase58(), mintB: mint.toBase58(), tvl } })
  const other = { adapter: 'pumpswap' as const, address: PK2.unique(), source: { kind: 'local_pumpswap_inventory', ref: 'i', observedAtUtc: 'u' }, hints: { base_mint: mint.toBase58(), quote_mint: wsol.toBase58(), tvl: null } }
  it('keeps the same row whichever order the duplicates arrive in', () => {
    const forward = buildPop2({ raydium: [row(9_000_000), row(3)], pumpswap: [other], maxPools: 10, maxMints: 10, generatedAtUtc: 'g', sources: {}, notes: [], warnings: [] })
    const reversed = buildPop2({ raydium: [row(3), row(9_000_000)], pumpswap: [other], maxPools: 10, maxMints: 10, generatedAtUtc: 'g', sources: {}, notes: [], warnings: [] })
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward))
    expect(forward.routes[0]!.liquidityRank).toBe(9_000_000)   // the richer row wins in both orders
  })
})
