import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema } from '../../src/config/schema.js'
import { runDiscovery, poolRefsFromRun, utcStamp, LISTV2_CACHE_FILE, POOL_KEYS_CACHE_FILE, SHORTLIST_FILE } from '../../src/discovery/index.js'
import { mockClient, fixedClock, type Call } from '../fixtures/discovery/mock_fetch.js'
const INV = 'tests/fixtures/discovery/pumpswap_inventory_sample.jsonl.gz'
const config = ConfigSchema.parse({ version: 1, rpc: {}, discovery: {}, pools: [], sizing: {}, costs: {} })
describe('runDiscovery (offline, from caches; no RPC, no HTTP)', () => {
  it('rebuilds the population from cached API pages + inventory and writes report/shortlist', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'atomarb-discovery-')); mkdirSync(join(tmp, 'discovery'), { recursive: true })
    const online = mockClient([])
    const run = await online.listStandardPoolsByMint({ pageSize: 5, cap: 100 })
    writeFileSync(join(tmp, 'discovery', LISTV2_CACHE_FILE), JSON.stringify(run))
    const k = await online.poolKeysByIds(poolRefsFromRun(run).refs.map(r => r.address.toBase58()))
    writeFileSync(join(tmp, 'discovery', POOL_KEYS_CACHE_FILE), JSON.stringify({ schema: 'atomarb.raydium_pool_keys_cache.v1', fetchedAtUtc: fixedClock(), urls: k.captures.map(c => c.url), keys: k.keys, missing: k.missing }))
    const offlineCalls: Call[] = []; const offline = mockClient(offlineCalls)
    const res = await runDiscovery(config, { network: false, dataDir: tmp, reportsDir: join(tmp, 'reports'), inventoryPath: INV, client: offline, clock: fixedClock })
    expect(offlineCalls.length).toBe(0); expect(res.apiRequests).toBe(0)
    expect(existsSync(res.reportJsonPath)).toBe(true); expect(existsSync(res.reportMdPath)).toBe(true); expect(res.shortlistPath).toBe(join(tmp, 'discovery', SHORTLIST_FILE)); expect(existsSync(res.shortlistPath)).toBe(true)
    expect(res.reportJsonPath).toContain(`population_${utcStamp(fixedClock())}.json`)
    const c = res.report.counts
    expect(c.raydium_cpmm_wsol_pools).toBe(5); expect(c.pumpswap_wsol_pools).toBe(7); expect(c.pumpswap_mints_with_2plus).toBe(2); expect(c.cross_adapter_mints).toBe(0); expect(c.raydium_mints_with_2plus).toBe(0)
    expect(c).toMatchObject({ shortlist_pools: 5, shortlist_routes: 4, shortlist_mints: 2 })
    const ray = res.report.sources['raydium_api_v3'] as Record<string, unknown>
    expect(ray['fromCache']).toBe(true); expect(ray['listedStandard']).toBe(7); expect(ray['cpmmWsol']).toBe(5); expect(ray['capped']).toBe(false)
    expect(res.report.notes.some(n => /days old/.test(n))).toBe(true); expect(res.report.warnings.some(w => /PUMPSWAP_INVENTORY_STALE/.test(w))).toBe(true)
    const shortlist = JSON.parse(readFileSync(res.shortlistPath, 'utf8')) as { adapter: string; address: string; mint: string; source: { kind: string; ref: string; observedAtUtc: string } }[]
    expect(shortlist.length).toBe(5); for (const s of shortlist) { expect(s.adapter).toBe('pumpswap'); expect(s.address.length).toBeGreaterThan(30); expect(s.source.kind).toBe('local_pumpswap_inventory') }
    const md = readFileSync(res.reportMdPath, 'utf8'); for (const line of md.split('\n')) expect(line.length).toBeLessThanOrEqual(100)
  })
  it('attaches pool-key hints from the cache to shortlisted Raydium pools', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'atomarb-discovery-')); mkdirSync(join(tmp, 'discovery'), { recursive: true })
    const online = mockClient([])
    const run = await online.listStandardPoolsByMint({ pageSize: 5, cap: 100 })
    // make two CPMM items share a mint so a raydium_x2 route exists and Raydium pools reach the shortlist
    const body = run.pages[1]!.body as { data: { mintA: { address: string }; mintB: { address: string } }[] }
    const src = (run.pages[0]!.body as { data: { mintA: { address: string }; mintB: { address: string }; programId: string }[] }).data.find(i => i.programId.startsWith('CPMM'))!
    body.data[0]!.mintA = src.mintA; body.data[0]!.mintB = src.mintB
    writeFileSync(join(tmp, 'discovery', LISTV2_CACHE_FILE), JSON.stringify(run))
    const k = await online.poolKeysByIds(['x'])
    writeFileSync(join(tmp, 'discovery', POOL_KEYS_CACHE_FILE), JSON.stringify({ schema: 'atomarb.raydium_pool_keys_cache.v1', fetchedAtUtc: fixedClock(), urls: [], keys: k.keys, missing: [] }))
    const res = await runDiscovery(config, { network: false, dataDir: tmp, reportsDir: join(tmp, 'reports'), inventoryPath: INV, client: mockClient([]), clock: fixedClock })
    expect(res.report.counts.raydium_mints_with_2plus).toBe(1)
    const rays = res.report.shortlist.filter(s => s.adapter === 'raydium_cpmm'); expect(rays.length).toBe(2)
    for (const s of rays) { expect(typeof s.hints?.['keys_vaultA']).toBe('string'); expect(s.hints?.['keys_fetchedAtUtc']).toBe(fixedClock()) }
  })
  it('refuses to run offline without a cache (no fake success)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'atomarb-discovery-'))
    await expect(runDiscovery(config, { network: false, dataDir: tmp, reportsDir: join(tmp, 'reports'), inventoryPath: INV, client: mockClient([]), clock: fixedClock })).rejects.toThrow(/NO_CACHE/)
  })
  it('discovery code never touches the RPC client', () => {
    for (const f of ['src/cli/discover.ts', 'src/discovery/index.ts', 'src/discovery/raydium_api.ts', 'src/discovery/local_inventory.ts', 'src/discovery/population.ts']) {
      const src = readFileSync(f, 'utf8'); expect(src).not.toMatch(/RpcClient|state\/rpc|sendTransaction|simulateTransaction/)
    }
  })
})
