/**
 * Re-runnable builder of the small, redacted Raydium API v3 fixtures used by tests/unit/discovery_*.test.ts.
 *   npx tsx scripts/fetch_discovery_fixtures.ts          # from data/discovery/*.json caches written by `atomarb discover` (0 HTTP requests)
 *   npx tsx scripts/fetch_discovery_fixtures.ts --live   # 2 HTTPS requests to api-v3.raydium.io (list-v2 size=100, /pools/key/ids); no RPC
 * Output: tests/fixtures/discovery/raydium_*.json — real ids/mints/config/tvl, with logoURI/name/tags/lpMint/stats dropped.
 * The two-page chain is SYNTHETIC (built from real items) so pagination, cross-page dedup and programId filtering are exercised deterministically.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RaydiumApiClient, RAYDIUM_AMM_V4_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, itemsFromPages, type ApiMintInfo, type ApiPoolItem, type ApiPoolKeys, type ListRun } from '../src/discovery/raydium_api.js'
import { LISTV2_CACHE_FILE, POOL_KEYS_CACHE_FILE } from '../src/discovery/index.js'
import { nowUtcIso } from '../src/util/time.js'

const OUT = 'tests/fixtures/discovery'
const CACHE_DIR = 'data/discovery'
const live = process.argv.includes('--live')
type Compact<T> = { [K in keyof T]: Exclude<T[K], undefined> }
function compact<T extends object>(o: T): Compact<T> { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Compact<T> }
function trimMint(m: ApiMintInfo): ApiMintInfo { return compact({ address: m.address, programId: m.programId, decimals: m.decimals, symbol: m.symbol }) }
function trimItem(it: ApiPoolItem): ApiPoolItem {
  return compact({ type: it.type, programId: it.programId, id: it.id, mintA: trimMint(it.mintA), mintB: trimMint(it.mintB), config: it.config, feeRate: it.feeRate, openTime: it.openTime, tvl: it.tvl, mintAmountA: it.mintAmountA, mintAmountB: it.mintAmountB, burnPercent: it.burnPercent, launchMigratePool: it.launchMigratePool, hasDynamicFee: it.hasDynamicFee })
}
function trimKeys(k: ApiPoolKeys): ApiPoolKeys {
  return compact({ programId: k.programId, id: k.id, mintA: trimMint(k.mintA), mintB: trimMint(k.mintB), lookupTableAccount: k.lookupTableAccount, openTime: k.openTime, vault: k.vault, authority: k.authority, mintLp: k.mintLp ? trimMint(k.mintLp) : undefined, config: k.config, observationId: k.observationId })
}
async function main(): Promise<void> {
  const client = new RaydiumApiClient({ maxTotalRequests: 4 })
  let items: ApiPoolItem[]; let keys: ApiPoolKeys[]; let cursor: string; let source: string; let fetchedAtUtc: string
  const cachePath = join(CACHE_DIR, LISTV2_CACHE_FILE)
  if (!live && existsSync(cachePath)) {
    const run = JSON.parse(readFileSync(cachePath, 'utf8')) as ListRun
    items = itemsFromPages(run.pages, run.cap).items
    cursor = run.pages[0]?.nextPageId ?? 'fixture-cursor-page-2'
    source = `${cachePath} (list-v2 fetched ${run.startedAtUtc})`; fetchedAtUtc = run.startedAtUtc
    const kp = join(CACHE_DIR, POOL_KEYS_CACHE_FILE)
    keys = existsSync(kp) ? (JSON.parse(readFileSync(kp, 'utf8')) as { keys: ApiPoolKeys[] }).keys : []
  } else {
    const run = await client.listStandardPoolsByMint({ pageSize: 100, cap: 100 }) // 1 request
    items = itemsFromPages(run.pages, run.cap).items
    cursor = run.pages[0]?.nextPageId ?? 'fixture-cursor-page-2'
    source = `live ${run.pages[0]?.url ?? ''}`; fetchedAtUtc = run.startedAtUtc
    const cpmmIds = items.filter(i => i.programId === RAYDIUM_CPMM_PROGRAM_ID).slice(0, 5).map(i => i.id)
    keys = (await client.poolKeysByIds(cpmmIds)).keys // 1 request
  }
  const keyIds = new Set(keys.map(k => k.id))
  const amm = items.filter(i => i.programId === RAYDIUM_AMM_V4_PROGRAM_ID).slice(0, 2).map(trimItem)
  let cpmm = items.filter(i => i.programId === RAYDIUM_CPMM_PROGRAM_ID && keyIds.has(i.id)).slice(0, 5).map(trimItem)
  if (cpmm.length < 5) cpmm = items.filter(i => i.programId === RAYDIUM_CPMM_PROGRAM_ID).slice(0, 5).map(trimItem)
  if (amm.length < 2 || cpmm.length < 5) throw new Error(`not enough items for fixtures: amm=${amm.length} cpmm=${cpmm.length}`)
  const page1 = [amm[0]!, cpmm[0]!, cpmm[1]!, amm[1]!, cpmm[2]!]
  const page2 = [cpmm[3]!, cpmm[0]!, cpmm[4]!]
  const meta = (note: string) => ({ builtAtUtc: nowUtcIso(), source, fetchedAtUtc, note, redaction: 'logoURI/name/tags/lpMint/day-week-month stats dropped; ids, mints, config, tvl, openTime are real API values; no credentials involved' })
  mkdirSync(OUT, { recursive: true })
  const w = (name: string, v: unknown) => writeFileSync(join(OUT, name), JSON.stringify(v, null, 1) + '\n')
  w('raydium_listv2_page1.json', { id: 'fixture', success: true, data: { data: page1, nextPageId: cursor }, _fixture: meta('page 1 of a synthetic 2-page chain: items [AMMv4, CPMM, CPMM, AMMv4, CPMM]; nextPageId is a real cursor value') })
  w('raydium_listv2_page2.json', { id: 'fixture', success: true, data: { data: page2 }, _fixture: meta('last page (no nextPageId): [CPMM(new), CPMM(duplicate of page 1 item 2), CPMM(new)] to test cross-page dedup') })
  w('raydium_infomint_page1.json', { id: 'fixture', success: true, data: { count: page1.length, hasNextPage: true, data: page1 }, _fixture: meta('/pools/info/mint shape; count = items in this page (live-verified 2026-09-17), hasNextPage true') })
  w('raydium_infomint_page2.json', { id: 'fixture', success: true, data: { count: page2.length, hasNextPage: false, data: page2 }, _fixture: meta('/pools/info/mint last page: hasNextPage false') })
  const fixtureKeys = cpmm.map(c => keys.find(k => k.id === c.id)).filter((k): k is ApiPoolKeys => k !== undefined).map(trimKeys)
  w('raydium_pool_keys.json', { id: 'fixture', success: true, data: [...fixtureKeys, null], _fixture: meta('/pools/key/ids: keys for the fixture CPMM ids + a null for an unknown id (the API returns null entries; SDK filters them with Boolean)') })
  w('raydium_error_pooltype.json', { id: 'fixture', success: false, msg: 'query poolType type error', _fixture: meta('real error body observed for /pools/info/mint?poolType=Standard (HTTP 500) — raydium_cpmm.md §8') })
  console.log(`fixtures written to ${OUT}: page1=${page1.length} page2=${page2.length} keys=${fixtureKeys.length} http_requests=${client.usage.total}`)
}
main().catch(e => { console.error(e); process.exit(1) })
