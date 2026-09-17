import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolRef } from '../adapters/types.js'
import type { Config } from '../config/schema.js'
import type { JsonlLogger } from '../telemetry/log.js'
import { jsonReplacer } from '../util/bigint.js'
import { nowUtcIso } from '../util/time.js'
import { RaydiumApiClient, filterCpmm, itemsFromPages, poolKeysToHints, raydiumItemToPoolRef, type ApiPoolKeys, type ListRun } from './raydium_api.js'
import { inventoryAgeDays, readPumpswapInventory, type InventoryReadResult } from './local_inventory.js'
import { buildPopulation, renderPopulationMarkdown, type PopulationReport, type ShortlistEntry } from './population.js'

export * from './raydium_api.js'
export * from './local_inventory.js'
export * from './population.js'

/**
 * Discovery orchestrator: Raydium API v3 (HTTPS to api-v3.raydium.io only) + local PumpSwap inventory → population
 * report + shortlist. NO RPC CALLS HERE, by design: on-chain verification is src/state/snapshot.ts' job.
 */
export const LISTV2_CACHE_FILE = 'raydium_listv2_wsol_standard.json'
export const INFOMINT_CACHE_FILE = 'raydium_infomint_wsol_standard.json'
export const POOL_KEYS_CACHE_FILE = 'raydium_pool_keys.json'
export const VERSION_CACHE_FILE = 'raydium_version.json'
export const SHORTLIST_FILE = 'shortlist.json'

export interface DiscoveryOptions {
  /** false → only data/discovery/*.json caches are used (no HTTP at all) */
  network: boolean
  maxPools?: number
  maxMints?: number
  maxPoolsPerMint?: number
  listCap?: number
  pageSize?: number
  /** also list via /pools/info/mint and compare id sets (costs another ceil(cap/pageSize) requests) */
  crossCheckInfoMint?: boolean
  /** network mode only: reuse the cached listing when present (re-rank / refetch pool keys without re-listing) */
  reuseListCache?: boolean
  inventoryPath?: string
  dataDir?: string
  reportsDir?: string
  client?: RaydiumApiClient
  clock?: () => string
  log?: JsonlLogger
}
export interface DiscoveryResult {
  report: PopulationReport; reportJsonPath: string; reportMdPath: string; shortlistPath: string
  raydiumRun: ListRun | null; inventory: InventoryReadResult | null; apiRequests: number; sourcesUsed: string[]
}
interface PoolKeysCache { schema: 'atomarb.raydium_pool_keys_cache.v1'; fetchedAtUtc: string; urls: string[]; keys: ApiPoolKeys[]; missing: string[] }

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T }
function writeJson(path: string, v: unknown): void { writeFileSync(path, JSON.stringify(v, jsonReplacer, 1)) }
export function utcStamp(iso: string): string { return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') }
/** Raydium ListRun (online or cached) → CPMM WSOL PoolRefs, with per-item provenance = the page URL + fetch time. */
export function poolRefsFromRun(run: ListRun): { refs: PoolRef[]; listedStandard: number; cpmm: number; skipped: string[]; duplicateIds: number } {
  const { items, pageOf, duplicateIds } = itemsFromPages(run.pages, run.cap)
  const cpmmItems = filterCpmm(items)
  const refs: PoolRef[] = []; const skipped: string[] = []
  for (const it of cpmmItems) {
    const page = pageOf.get(it.id)!
    const r = raydiumItemToPoolRef(it, page.fetchedAtUtc, page.url)
    if ('ref' in r) refs.push(r.ref); else skipped.push(r.skip)
  }
  return { refs, listedStandard: items.length, cpmm: cpmmItems.length, skipped, duplicateIds }
}
function countBy(xs: { reason: string }[]): Record<string, number> { const o: Record<string, number> = {}; for (const x of xs) o[x.reason] = (o[x.reason] ?? 0) + 1; return o }

export async function runDiscovery(config: Config, opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const log = opts.log; const clock = opts.clock ?? nowUtcIso
  const dataDir = opts.dataDir ?? config.paths.dataDir
  const discoveryDir = join(dataDir, 'discovery'); mkdirSync(discoveryDir, { recursive: true })
  const reportsDir = opts.reportsDir ?? 'reports'; mkdirSync(reportsDir, { recursive: true })
  const maxPools = opts.maxPools ?? config.discovery.maxPools
  const maxMints = opts.maxMints ?? config.discovery.maxMints
  const listCap = opts.listCap ?? 5000
  const sources: Record<string, unknown> = {}; const warnings: string[] = []; const notes: string[] = []; const sourcesUsed: string[] = []
  const client = opts.client ?? new RaydiumApiClient({ ...(log ? { log } : {}), clock })
  const startedAtUtc = clock()
  // ---- PumpSwap local inventory ----
  let inventory: InventoryReadResult | null = null; let pumpswap: PoolRef[] = []
  if (config.discovery.sources.includes('local_pumpswap_inventory')) {
    const invPath = opts.inventoryPath ?? config.discovery.localPumpswapInventoryPath ?? join(dataDir, 'inventory', 'pumpswap_pools.jsonl.gz')
    inventory = readPumpswapInventory(invPath)
    pumpswap = inventory.pools
    const ageDays = inventoryAgeDays(inventory.observedAtUtc, startedAtUtc)
    sources['local_pumpswap_inventory'] = {
      path: inventory.inventoryPath, inventorySha256: inventory.inventorySha256, sourceRef: inventory.sourceRef, provenancePath: inventory.provenancePath, provenance: inventory.provenance,
      observedAtUtc: inventory.observedAtUtc, ageDays, lines: inventory.lines, records: inventory.records, skippedByReason: countBy(inventory.skipped), duplicateAddresses: inventory.duplicateAddresses.length,
    }
    sourcesUsed.push('local_pumpswap_inventory')
    notes.push(`PumpSwap inventory ${inventory.inventoryPath} is ${ageDays} days old (source mtime ${inventory.observedAtUtc}); addresses only, unverified until snapshot; pools created/closed since are not reflected.`)
    if (ageDays > 7) warnings.push(`PUMPSWAP_INVENTORY_STALE: ${ageDays} days old`)
    log?.info('discovery_inventory', { path: invPath, records: inventory.records, skipped: inventory.skipped.length, ageDays })
  }
  // ---- Raydium API v3 ----
  let raydiumRun: ListRun | null = null; let raydium: PoolRef[] = []
  if (config.discovery.sources.includes('raydium_api_v3')) {
    const cachePath = join(discoveryDir, LISTV2_CACHE_FILE)
    const reuse = !opts.network || (opts.reuseListCache === true && existsSync(cachePath))
    if (!reuse) {
      let version: unknown = null
      try { version = await client.version(); writeJson(join(discoveryDir, VERSION_CACHE_FILE), { fetchedAtUtc: clock(), version }) } catch (e) { warnings.push(`RAYDIUM_VERSION_FAILED: ${(e as Error).message}`) }
      raydiumRun = await client.listStandardPoolsByMint({ endpoint: 'list-v2', cap: listCap, ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}) })
      writeJson(cachePath, raydiumRun)
      sources['raydium_api_v3_version'] = version
    } else {
      if (!existsSync(cachePath)) throw new Error(`NO_CACHE: ${cachePath} missing — run discover once without --no-network`)
      raydiumRun = readJson<ListRun>(cachePath)
      if (raydiumRun.schema !== 'atomarb.raydium_api_cache.v1') throw new Error(`BAD_CACHE_SCHEMA ${String(raydiumRun.schema)} in ${cachePath}`)
      notes.push(`Raydium listing came from cache ${cachePath} (fetched ${raydiumRun.startedAtUtc}); ${opts.network ? '--reuse-list' : '--no-network'}`)
      const vp = join(discoveryDir, VERSION_CACHE_FILE); if (existsSync(vp)) sources['raydium_api_v3_version'] = (readJson<{ version: unknown }>(vp)).version
    }
    const conv = poolRefsFromRun(raydiumRun)
    raydium = conv.refs
    if (raydiumRun.capped) warnings.push(`RAYDIUM_LIST_CAPPED: listing stopped at cap=${raydiumRun.cap} Standard pools (sorted by liquidity desc); CPMM pools below that liquidity rank are NOT covered`)
    const ray: Record<string, unknown> = {
      baseUrl: raydiumRun.baseUrl, endpoint: raydiumRun.endpoint, poolType: raydiumRun.poolType, mint: raydiumRun.mint, pageSize: raydiumRun.pageSize, cap: raydiumRun.cap, capped: raydiumRun.capped, stoppedReason: raydiumRun.stoppedReason,
      startedAtUtc: raydiumRun.startedAtUtc, finishedAtUtc: raydiumRun.finishedAtUtc, pages: raydiumRun.pages.length, urls: raydiumRun.pages.map(p => p.url),
      listedStandard: conv.listedStandard, cpmmWsol: conv.cpmm, skipped: conv.skipped, duplicateIds: conv.duplicateIds, cachePath, fromCache: reuse,
    }
    if (opts.crossCheckInfoMint) {
      const cc = join(discoveryDir, INFOMINT_CACHE_FILE)
      let other: ListRun | null = null
      if (opts.network) { other = await client.listStandardPoolsByMint({ endpoint: 'info-mint', cap: listCap, ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}) }); writeJson(cc, other) }
      else if (existsSync(cc)) other = readJson<ListRun>(cc)
      if (other) {
        const a = new Set(itemsFromPages(raydiumRun.pages, raydiumRun.cap).items.map(i => i.id)); const b = new Set(itemsFromPages(other.pages, other.cap).items.map(i => i.id))
        let overlap = 0; for (const id of a) if (b.has(id)) overlap++
        ray['crossCheckInfoMint'] = { pages: other.pages.length, listed: b.size, capped: other.capped, stoppedReason: other.stoppedReason, overlapWithListV2: overlap, onlyListV2: a.size - overlap, onlyInfoMint: b.size - overlap, urls: other.pages.map(p => p.url) }
      }
    }
    sources['raydium_api_v3'] = ray; sourcesUsed.push('raydium_api_v3')
    log?.info('discovery_raydium', { pages: raydiumRun.pages.length, listedStandard: conv.listedStandard, cpmmWsol: conv.cpmm, capped: raydiumRun.capped, fromCache: !opts.network })
  }
  for (const s of config.discovery.sources) if (s !== 'raydium_api_v3' && s !== 'local_pumpswap_inventory') warnings.push(`SOURCE_NOT_IMPLEMENTED: ${s} (ignored)`)
  // ---- population + shortlist ----
  const generatedAtUtc = clock()
  const report = buildPopulation({ raydium, pumpswap, maxPools, maxMints, ...(opts.maxPoolsPerMint !== undefined ? { maxPoolsPerMint: opts.maxPoolsPerMint } : {}), generatedAtUtc, sources, notes, warnings })
  // ---- pool keys (hints) for the Raydium pools on the shortlist ----
  const rayIds = report.shortlist.filter(s => s.adapter === 'raydium_cpmm').map(s => s.address).slice(0, 100)
  if (rayIds.length > 0 && config.discovery.sources.includes('raydium_api_v3')) {
    const keysPath = join(discoveryDir, POOL_KEYS_CACHE_FILE)
    let cache: PoolKeysCache | null = null
    if (opts.network) {
      try {
        const r = await client.poolKeysByIds(rayIds)
        cache = { schema: 'atomarb.raydium_pool_keys_cache.v1', fetchedAtUtc: clock(), urls: r.captures.map(c => c.url), keys: r.keys, missing: r.missing }
        writeJson(keysPath, cache)
      } catch (e) { report.warnings.push(`RAYDIUM_POOL_KEYS_FAILED: ${(e as Error).message}`) }
    } else if (existsSync(keysPath)) cache = readJson<PoolKeysCache>(keysPath)
    if (cache) {
      const byId = new Map(cache.keys.map(k => [k.id, k]))
      let attached = 0
      for (const s of report.shortlist) {
        if (s.adapter !== 'raydium_cpmm') continue
        const k = byId.get(s.address); if (!k) { report.warnings.push(`POOL_KEYS_MISSING: ${s.address}`); continue }
        s.hints = { ...(s.hints ?? {}), ...poolKeysToHints(k), keys_fetchedAtUtc: cache.fetchedAtUtc }; attached++
      }
      ;(report.sources['raydium_api_v3'] as Record<string, unknown> | undefined) && Object.assign(report.sources['raydium_api_v3'] as Record<string, unknown>, { poolKeys: { requested: rayIds.length, attached, urls: cache.urls, fetchedAtUtc: cache.fetchedAtUtc, fromCache: !opts.network } })
    }
  }
  // ---- outputs ----
  const stamp = utcStamp(generatedAtUtc)
  const reportJsonPath = join(reportsDir, `population_${stamp}.json`); const reportMdPath = join(reportsDir, `population_${stamp}.md`)
  writeJson(reportJsonPath, report); writeFileSync(reportMdPath, renderPopulationMarkdown(report))
  const shortlistPath = join(discoveryDir, SHORTLIST_FILE)
  const shortlist: ShortlistEntry[] = report.shortlist
  writeJson(shortlistPath, shortlist)
  log?.info('discovery_done', { reportJsonPath, shortlistPath, shortlist: shortlist.length, apiRequests: client.usage.total })
  return { report, reportJsonPath, reportMdPath, shortlistPath, raydiumRun, inventory, apiRequests: client.usage.total, sourcesUsed }
}
