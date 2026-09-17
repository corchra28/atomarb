import type { AdapterId, PoolRef } from '../adapters/types.js'
import { wsolCounterMint } from './raydium_api.js'

/**
 * Population report: which mints have >=2 candidate pools (same adapter or cross adapter), dedup/collision accounting,
 * and a DETERMINISTIC shortlist ranked by liquidity hints. Pure: no I/O, no RPC. Every address here is unverified until
 * src/state/snapshot.ts decodes + validates it; liquidity hints come from the Raydium API (tvl USD) or are unknown
 * (PumpSwap inventory has none) and are never used for quoting.
 */
export type RouteCategory = 'pumpswap_x2' | 'cross_adapter' | 'raydium_x2'
export type LiquidityBasis = 'min_tvl' | 'raydium_tvl_only' | 'unknown_liquidity'
export interface PoolLite { adapter: AdapterId; address: string; tvl: number | null; index?: number | null; canonical?: boolean | null; configIndex?: number | null }
export interface CandidateRoute { category: RouteCategory; mint: string; poolA: PoolLite; poolB: PoolLite; liquidityRank: number | null; liquidityBasis: LiquidityBasis; canonicalCount: number }
export interface ShortlistEntry { adapter: AdapterId; address: string; mint: string; source: PoolRef['source']; hints?: Record<string, string | number | boolean | null> }
export interface PairCollision { adapter: AdapterId; mintA: string; mintB: string; addresses: string[] }
export interface PopulationCounts {
  raydium_cpmm_wsol_pools: number; pumpswap_wsol_pools: number
  raydium_mints: number; pumpswap_mints: number
  pumpswap_mints_with_2plus: number; cross_adapter_mints: number; raydium_mints_with_2plus: number
  routes_pumpswap_x2: number; routes_cross_adapter: number; routes_raydium_x2: number; routes_total: number; routes_truncated_by_per_mint_cap: number
  duplicate_addresses: number; pair_collisions: number; excluded_not_wsol_pair: number
  shortlist_pools: number; shortlist_routes: number; shortlist_mints: number
}
export interface PopulationReport {
  schema: 'atomarb.population.v1'
  generatedAtUtc: string
  limits: { maxPools: number; maxMints: number; maxRoutesPerMint: number; maxPoolsPerMint: number }
  sources: Record<string, unknown>
  counts: PopulationCounts
  dedup: { duplicateAddresses: { adapter: AdapterId; address: string; occurrences: number }[]; pairCollisions: PairCollision[]; excludedNotWsolPair: { adapter: AdapterId; address: string }[] }
  categories: {
    pumpswap_x2: { mint: string; pools: PoolLite[] }[]
    cross_adapter: { mint: string; raydium: PoolLite[]; pumpswap: PoolLite[] }[]
    raydium_x2: { mint: string; pools: PoolLite[] }[]
  }
  routes: CandidateRoute[]
  shortlist: ShortlistEntry[]
  shortlistRoutes: CandidateRoute[]
  notes: string[]
  warnings: string[]
}
export interface PopulationInput {
  raydium: PoolRef[]; pumpswap: PoolRef[]
  maxPools: number; maxMints: number
  /** deterministic guard against combinatorial blow-up for mints with many pools (default 32) */
  maxRoutesPerMint?: number
  /** shortlist diversification: at most this many pools of one mint enter the shortlist (default 6) */
  maxPoolsPerMint?: number
  generatedAtUtc: string
  sources?: Record<string, unknown>
  notes?: string[]; warnings?: string[]
}

function hintStr(p: PoolRef, k: string): string | null { const v = p.hints?.[k]; return typeof v === 'string' ? v : null }
function hintNum(p: PoolRef, k: string): number | null { const v = p.hints?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : null }
function hintBool(p: PoolRef, k: string): boolean | null { const v = p.hints?.[k]; return typeof v === 'boolean' ? v : null }
/** Ordered mint pair as the source reports it: Raydium (mintA, mintB) — CPMM enforces mintA < mintB; PumpSwap (base, quote). */
export function mintPairOf(p: PoolRef): { mintA: string; mintB: string } | null {
  if (p.adapter === 'raydium_cpmm') { const a = hintStr(p, 'mintA'), b = hintStr(p, 'mintB'); return a && b ? { mintA: a, mintB: b } : null }
  const a = hintStr(p, 'base_mint'), b = hintStr(p, 'quote_mint'); return a && b ? { mintA: a, mintB: b } : null
}
/** The non-WSOL mint of the pool, or null if it is not a WSOL pair. */
export function counterMintOf(p: PoolRef): string | null { const pair = mintPairOf(p); return pair ? wsolCounterMint(pair.mintA, pair.mintB) : null }
export function toPoolLite(p: PoolRef): PoolLite {
  const lite: PoolLite = { adapter: p.adapter, address: p.address.toBase58(), tvl: hintNum(p, 'tvl') }
  if (p.adapter === 'pumpswap') { lite.index = hintNum(p, 'index'); lite.canonical = hintBool(p, 'canonical') }
  else lite.configIndex = hintNum(p, 'configIndex')
  return lite
}
function cmpStr(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
/** Deterministic total order for routes: known liquidity desc first, then unknown; ties → more canonical pools, then mint, then addresses. */
export function compareRoutes(x: CandidateRoute, y: CandidateRoute): number {
  const xr = x.liquidityRank, yr = y.liquidityRank
  if (xr !== null && yr !== null && xr !== yr) return yr - xr
  if (xr === null && yr !== null) return 1
  if (xr !== null && yr === null) return -1
  if (x.canonicalCount !== y.canonicalCount) return y.canonicalCount - x.canonicalCount
  return cmpStr(x.mint, y.mint) || cmpStr(x.poolA.address, y.poolA.address) || cmpStr(x.poolB.address, y.poolB.address)
}
function makeRoute(category: RouteCategory, mint: string, a: PoolRef, b: PoolRef): CandidateRoute {
  let [pa, pb] = [toPoolLite(a), toPoolLite(b)]
  if (category === 'cross_adapter') { if (pa.adapter !== 'raydium_cpmm') [pa, pb] = [pb, pa] }
  else if (cmpStr(pa.address, pb.address) > 0) [pa, pb] = [pb, pa]
  let liquidityRank: number | null, liquidityBasis: LiquidityBasis
  if (pa.tvl !== null && pb.tvl !== null) { liquidityRank = Math.min(pa.tvl, pb.tvl); liquidityBasis = 'min_tvl' }
  else if (category === 'cross_adapter' && pa.tvl !== null) { liquidityRank = pa.tvl; liquidityBasis = 'raydium_tvl_only' }
  else { liquidityRank = null; liquidityBasis = 'unknown_liquidity' }
  const canonicalCount = (pa.canonical === true ? 1 : 0) + (pb.canonical === true ? 1 : 0)
  return { category, mint, poolA: pa, poolB: pb, liquidityRank, liquidityBasis, canonicalCount }
}
/** Pairs ranked by compareRoutes, truncated to `cap` per mint (deterministic). */
function rankedPairs(category: RouteCategory, mint: string, left: PoolRef[], right: PoolRef[] | null, cap: number): { routes: CandidateRoute[]; truncated: number } {
  const all: CandidateRoute[] = []
  if (right === null) { for (let i = 0; i < left.length; i++) for (let j = i + 1; j < left.length; j++) all.push(makeRoute(category, mint, left[i]!, left[j]!)) }
  else { for (const a of left) for (const b of right) all.push(makeRoute(category, mint, a, b)) }
  all.sort(compareRoutes)
  return { routes: all.slice(0, cap), truncated: Math.max(0, all.length - cap) }
}
/** Dedup by address (first occurrence wins) and index by (adapter, mintA, mintB); pools that are not WSOL pairs are excluded and listed. */
function dedupAndIndex(pools: PoolRef[], adapter: AdapterId) {
  const byAddr = new Map<string, { ref: PoolRef; occurrences: number }>()
  const excluded: { adapter: AdapterId; address: string }[] = []
  for (const p of pools) {
    if (p.adapter !== adapter) continue
    const k = p.address.toBase58()
    const e = byAddr.get(k); if (e) { e.occurrences++; continue }
    byAddr.set(k, { ref: p, occurrences: 1 })
  }
  const byMint = new Map<string, PoolRef[]>(); const byPair = new Map<string, PoolRef[]>()
  const kept: PoolRef[] = []
  for (const { ref } of byAddr.values()) {
    const mint = counterMintOf(ref)
    if (mint === null) { excluded.push({ adapter, address: ref.address.toBase58() }); continue }
    kept.push(ref)
    const arr = byMint.get(mint); if (arr) arr.push(ref); else byMint.set(mint, [ref])
    const pair = mintPairOf(ref)!; const pk = `${pair.mintA}|${pair.mintB}`
    const parr = byPair.get(pk); if (parr) parr.push(ref); else byPair.set(pk, [ref])
  }
  // every list is sorted so the report is byte-identical regardless of input order
  const duplicates = [...byAddr.entries()].filter(([, v]) => v.occurrences > 1).map(([address, v]) => ({ adapter, address, occurrences: v.occurrences })).sort((x, y) => cmpStr(x.address, y.address))
  const collisions: PairCollision[] = [...byPair.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => { const [mintA, mintB] = k.split('|') as [string, string]; return { adapter, mintA, mintB, addresses: v.map(r => r.address.toBase58()).sort(cmpStr) } }).sort((x, y) => cmpStr(x.mintA, y.mintA) || cmpStr(x.mintB, y.mintB))
  excluded.sort((x, y) => cmpStr(x.address, y.address))
  kept.sort((x, y) => cmpStr(x.address.toBase58(), y.address.toBase58()))
  return { kept, byMint, duplicates, collisions, excluded }
}
export function buildPopulation(input: PopulationInput): PopulationReport {
  const maxRoutesPerMint = input.maxRoutesPerMint ?? 32
  const maxPoolsPerMint = Math.max(2, input.maxPoolsPerMint ?? 6)
  const ray = dedupAndIndex(input.raydium, 'raydium_cpmm')
  const pump = dedupAndIndex(input.pumpswap, 'pumpswap')
  const sortedMints = (m: Map<string, PoolRef[]>) => [...m.keys()].sort(cmpStr)
  const routes: CandidateRoute[] = []; let truncated = 0
  // (a) same-adapter PumpSwap: mints with >=2 PumpSwap WSOL pools
  const catA: PopulationReport['categories']['pumpswap_x2'] = []
  for (const mint of sortedMints(pump.byMint)) {
    const pools = pump.byMint.get(mint)!; if (pools.length < 2) continue
    catA.push({ mint, pools: pools.map(toPoolLite).sort((x, y) => cmpStr(x.address, y.address)) })
    const r = rankedPairs('pumpswap_x2', mint, pools, null, maxRoutesPerMint); routes.push(...r.routes); truncated += r.truncated
  }
  // (b) cross-adapter: mints with BOTH a Raydium CPMM WSOL pool and a PumpSwap WSOL pool
  const catB: PopulationReport['categories']['cross_adapter'] = []
  for (const mint of sortedMints(ray.byMint)) {
    const rp = ray.byMint.get(mint)!; const pp = pump.byMint.get(mint); if (!pp) continue
    catB.push({ mint, raydium: rp.map(toPoolLite).sort((x, y) => cmpStr(x.address, y.address)), pumpswap: pp.map(toPoolLite).sort((x, y) => cmpStr(x.address, y.address)) })
    const r = rankedPairs('cross_adapter', mint, rp, pp, maxRoutesPerMint); routes.push(...r.routes); truncated += r.truncated
  }
  // (c) same-adapter Raydium: mints with >=2 CPMM WSOL pools
  const catC: PopulationReport['categories']['raydium_x2'] = []
  for (const mint of sortedMints(ray.byMint)) {
    const pools = ray.byMint.get(mint)!; if (pools.length < 2) continue
    catC.push({ mint, pools: pools.map(toPoolLite).sort((x, y) => cmpStr(x.address, y.address)) })
    const r = rankedPairs('raydium_x2', mint, pools, null, maxRoutesPerMint); routes.push(...r.routes); truncated += r.truncated
  }
  routes.sort(compareRoutes)
  // shortlist: walk ranked routes, add both pools while within maxPools / maxMints
  const refByAddr = new Map<string, PoolRef>()
  for (const p of [...ray.kept, ...pump.kept]) refByAddr.set(p.address.toBase58(), p)
  const selected = new Map<string, ShortlistEntry>(); const selectedMints = new Set<string>(); const shortlistRoutes: CandidateRoute[] = []
  const poolsPerMint = new Map<string, number>()
  for (const r of routes) {
    if (selected.size >= input.maxPools) break
    const fresh = [r.poolA, r.poolB].filter(p => !selected.has(p.address))
    if (selected.size + fresh.length > input.maxPools) continue
    const have = poolsPerMint.get(r.mint) ?? 0
    if (have + fresh.length > maxPoolsPerMint) continue
    if (!selectedMints.has(r.mint) && selectedMints.size >= input.maxMints) continue
    for (const p of fresh) {
      const ref = refByAddr.get(p.address)!
      const entry: ShortlistEntry = { adapter: ref.adapter, address: p.address, mint: r.mint, source: ref.source }
      if (ref.hints) entry.hints = ref.hints
      selected.set(p.address, entry)
    }
    poolsPerMint.set(r.mint, have + fresh.length); selectedMints.add(r.mint); shortlistRoutes.push(r)
  }
  const shortlist = [...selected.values()]
  const counts: PopulationCounts = {
    raydium_cpmm_wsol_pools: ray.kept.length, pumpswap_wsol_pools: pump.kept.length,
    raydium_mints: ray.byMint.size, pumpswap_mints: pump.byMint.size,
    pumpswap_mints_with_2plus: catA.length, cross_adapter_mints: catB.length, raydium_mints_with_2plus: catC.length,
    routes_pumpswap_x2: routes.filter(r => r.category === 'pumpswap_x2').length, routes_cross_adapter: routes.filter(r => r.category === 'cross_adapter').length, routes_raydium_x2: routes.filter(r => r.category === 'raydium_x2').length,
    routes_total: routes.length, routes_truncated_by_per_mint_cap: truncated,
    duplicate_addresses: ray.duplicates.length + pump.duplicates.length, pair_collisions: ray.collisions.length + pump.collisions.length, excluded_not_wsol_pair: ray.excluded.length + pump.excluded.length,
    shortlist_pools: shortlist.length, shortlist_routes: shortlistRoutes.length, shortlist_mints: selectedMints.size,
  }
  const notes = [
    'All addresses are UNVERIFIED discovery output: on-chain decode + validation happens in src/state/snapshot.ts with the adapters.',
    'Liquidity hints: Raydium API tvl (USD, unverified); the PumpSwap inventory carries no liquidity → unknown_liquidity ranks last (ties broken by canonical-pool count, then mint/address order).',
    `Route enumeration is capped at ${maxRoutesPerMint} ranked pairs per mint (deterministic); truncated pairs are counted in counts.routes_truncated_by_per_mint_cap.`,
    `Shortlist selection walks the ranked routes and admits at most ${maxPoolsPerMint} pools per mint (diversification), ${input.maxPools} pools and ${input.maxMints} mints in total.`,
    ...(input.notes ?? []),
  ]
  return {
    schema: 'atomarb.population.v1', generatedAtUtc: input.generatedAtUtc,
    limits: { maxPools: input.maxPools, maxMints: input.maxMints, maxRoutesPerMint, maxPoolsPerMint },
    sources: input.sources ?? {},
    counts,
    dedup: { duplicateAddresses: [...ray.duplicates, ...pump.duplicates], pairCollisions: [...ray.collisions, ...pump.collisions], excludedNotWsolPair: [...ray.excluded, ...pump.excluded] },
    categories: { pumpswap_x2: catA, cross_adapter: catB, raydium_x2: catC },
    routes, shortlist, shortlistRoutes, notes, warnings: input.warnings ?? [],
  }
}
/** Short id for tables: first 6 + '…' + last 4. */
export function shortKey(s: string): string { return s.length <= 12 ? s : `${s.slice(0, 6)}..${s.slice(-4)}` }
function fmtLiq(r: CandidateRoute): string { return r.liquidityRank === null ? 'unknown' : r.liquidityRank >= 1000 ? `${Math.round(r.liquidityRank).toLocaleString('en-US')}` : r.liquidityRank.toFixed(2) }
/** Markdown summary; every line is <= 100 columns (checked by tests) so it pastes cleanly into chat/terminals. */
export function renderPopulationMarkdown(rep: PopulationReport, opts: { maxRouteRows?: number } = {}): string {
  const c = rep.counts; const L: string[] = []
  L.push(`# Population report ${rep.generatedAtUtc}`, '')
  L.push('| metric | value |', '|---|---|')
  const rows: [string, string | number][] = [
    ['raydium_cpmm WSOL pools (API, unverified)', c.raydium_cpmm_wsol_pools], ['pumpswap WSOL pools (inventory, unverified)', c.pumpswap_wsol_pools],
    ['raydium mints / pumpswap mints', `${c.raydium_mints} / ${c.pumpswap_mints}`],
    ['(a) pumpswap mints with >=2 pools', c.pumpswap_mints_with_2plus], ['(b) cross-adapter mints (both)', c.cross_adapter_mints], ['(c) raydium mints with >=2 pools', c.raydium_mints_with_2plus],
    ['routes a / b / c', `${c.routes_pumpswap_x2} / ${c.routes_cross_adapter} / ${c.routes_raydium_x2}`], ['routes truncated (per-mint cap)', c.routes_truncated_by_per_mint_cap],
    ['dup addresses / pair collisions / not-WSOL', `${c.duplicate_addresses} / ${c.pair_collisions} / ${c.excluded_not_wsol_pair}`],
    ['shortlist pools / routes / mints', `${c.shortlist_pools} / ${c.shortlist_routes} / ${c.shortlist_mints}`],
    ['limits maxPools / maxMints / perMint', `${rep.limits.maxPools} / ${rep.limits.maxMints} / ${rep.limits.maxPoolsPerMint}`],
  ]
  for (const [k, v] of rows) L.push(`| ${k} | ${v} |`)
  L.push('', `## Shortlist routes (top ${Math.min(rep.shortlistRoutes.length, opts.maxRouteRows ?? 60)} of ${rep.shortlistRoutes.length})`, '')
  L.push('| # | category | mint | poolA | poolB | liq_hint | basis |', '|---|---|---|---|---|---|---|')
  rep.shortlistRoutes.slice(0, opts.maxRouteRows ?? 60).forEach((r, i) => {
    L.push(`| ${i + 1} | ${r.category} | ${shortKey(r.mint)} | ${shortKey(r.poolA.address)} | ${shortKey(r.poolB.address)} | ${fmtLiq(r)} | ${r.liquidityBasis} |`)
  })
  L.push('', `## Shortlist pools (${rep.shortlist.length})`, '', '| # | adapter | address | mint |', '|---|---|---|---|')
  rep.shortlist.forEach((s, i) => L.push(`| ${i + 1} | ${s.adapter} | ${s.address} | ${shortKey(s.mint)} |`))
  L.push('', '## Notes', '')
  for (const n of [...rep.notes, ...rep.warnings.map(w => `WARNING: ${w}`)]) L.push(...wrap(`- ${n}`, 96))
  L.push('')
  return L.join('\n')
}
function wrap(s: string, width: number): string[] {
  const out: string[] = []; let line = ''
  const words: string[] = []
  for (const w of s.split(' ')) { let rest = w; while (rest.length > width - 2) { words.push(rest.slice(0, width - 2)); rest = rest.slice(width - 2) } words.push(rest) } // hard-break tokens longer than a line (e.g. URLs)
  for (const w of words) {
    if (line.length + w.length + 1 > width && line !== '') { out.push(line); line = '  ' + w }
    else line = line === '' ? w : `${line} ${w}`
  }
  if (line !== '') out.push(line)
  return out
}
