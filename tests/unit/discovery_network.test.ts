import { describe, it, expect } from 'vitest'
import { RaydiumApiClient, RAYDIUM_CPMM_PROGRAM_ID, WSOL_B58, itemsFromPages } from '../../src/discovery/raydium_api.js'
/** Live check of api-v3.raydium.io (HTTPS only, no RPC). Skipped unless ATOMARB_NETWORK_TESTS=1; uses exactly 3 requests. */
const ENABLED = process.env['ATOMARB_NETWORK_TESTS'] === '1'
describe.skipIf(!ENABLED)('raydium api v3 live (ATOMARB_NETWORK_TESTS=1)', () => {
  it('version, one list-v2 page of WSOL Standard pools, pool keys for a known CPMM pool', async () => {
    const c = new RaydiumApiClient({ maxTotalRequests: 3 })
    const v = await c.version(); expect(v.latest).toMatch(/^V\d/)
    const run = await c.listStandardPoolsByMint({ pageSize: 5, cap: 5 })
    expect(run.pages.length).toBe(1); expect(run.pages[0]!.itemCount).toBe(5); expect(run.pages[0]!.nextPageId).toBeTruthy(); expect(run.capped).toBe(true)
    for (const it of itemsFromPages(run.pages, 5).items) { expect(it.type).toBe('Standard'); expect([it.mintA.address, it.mintB.address]).toContain(WSOL_B58); expect(typeof it.tvl).toBe('number') }
    // CPMM pool live-decoded in docs/sources/raydium_cpmm.md §0 (S3) / §8
    const k = await c.poolKeysByIds(['47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4'])
    expect(k.keys.length).toBe(1); expect(k.missing).toEqual([]); expect(k.keys[0]!.programId).toBe(RAYDIUM_CPMM_PROGRAM_ID); expect(typeof k.keys[0]!.vault?.A).toBe('string'); expect(typeof k.keys[0]!.observationId).toBe('string')
    expect(c.usage.total).toBe(3)
  }, 60_000)
})
