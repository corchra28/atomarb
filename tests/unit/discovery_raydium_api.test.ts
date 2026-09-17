import { describe, it, expect } from 'vitest'
import { RaydiumApiClient, RaydiumApiError, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_AMM_V4_PROGRAM_ID, WSOL_B58, filterCpmm, itemsFromPages, raydiumItemToPoolRef, poolKeysToHints, wsolCounterMint, type ApiPoolItem, type ApiPoolKeys } from '../../src/discovery/raydium_api.js'
import { mockClient, mockFetch, json, ERR, PAGE1, KEYS, CURSOR, noSleep, fixedClock, type Call } from '../fixtures/discovery/mock_fetch.js'
const page1Items = (JSON.parse(PAGE1) as { data: { data: ApiPoolItem[] } }).data.data
describe('RaydiumApiClient request layer', () => {
  it('builds URLs with the per-endpoint poolType casing (raydium_cpmm.md §8)', () => {
    const c = new RaydiumApiClient({ fetchImpl: mockFetch([]), sleepImpl: noSleep })
    expect(c.buildUrl('/pools/info/list-v2', { size: 1000, mint1: WSOL_B58, poolType: 'Standard', nextPageId: undefined })).toBe(`https://api-v3.raydium.io/pools/info/list-v2?size=1000&mint1=${WSOL_B58}&poolType=Standard`)
    expect(c.buildUrl('/pools/info/mint', { poolType: 'standard', page: 2 })).toContain('poolType=standard&page=2')
  })
  it('sends the research User-Agent and parses the envelope', async () => {
    const calls: Call[] = []; const c = mockClient(calls)
    const v = await c.version()
    expect(v.latest).toBe('V3.0.1'); expect(calls[0]!.headers['user-agent']).toBe('atomarb-research'); expect(c.usage.total).toBe(1)
  })
  it('rejects rates above 2 req/s and spaces requests at 1/rps', async () => {
    expect(() => new RaydiumApiClient({ maxRequestsPerSecond: 5 })).toThrow(/maxRequestsPerSecond/)
    const waits: number[] = []; const calls: Call[] = []
    const c = new RaydiumApiClient({ fetchImpl: mockFetch(calls), sleepImpl: async ms => { waits.push(ms) }, maxRequestsPerSecond: 2 })
    await Promise.all([c.version(), c.version(), c.version()])
    expect(calls.length).toBe(3); expect(waits.length).toBe(2); for (const w of waits) { expect(w).toBeGreaterThan(300); expect(w).toBeLessThanOrEqual(500) }
  })
  it('API parameter errors ({success:false,msg}) are NOT retried', async () => {
    const calls: Call[] = []; const c = mockClient(calls, {}, () => json(ERR, 500))
    await expect(c.version()).rejects.toThrow(/query poolType type error/)
    expect(calls.length).toBe(1); expect(c.usage.retries).toBe(0)
  })
  it('HTTP 5xx / 429 / network errors are retried with backoff, then succeed or give up', async () => {
    const calls: Call[] = []; const waits: number[] = []
    const c = new RaydiumApiClient({ fetchImpl: mockFetch(calls, (_u, n) => n === 1 ? json('oops', 503) : n === 2 ? json('slow down', 429) : undefined), sleepImpl: async ms => { waits.push(ms) }, maxRetries: 2, random: () => 0.5, maxRequestsPerSecond: 2 })
    const v = await c.version(); expect(v.least).toBe('V3.0.1'); expect(calls.length).toBe(3); expect(c.usage.retries).toBe(2)
    expect(waits.filter(w => w >= 1000).length).toBe(2) // backoff 500*2^1, 500*2^2 (jitter 0 at random=0.5)
    const calls2: Call[] = []; const c2 = mockClient(calls2, { maxRetries: 1 }, () => json('down', 500))
    await expect(c2.version()).rejects.toThrow(/HTTP 500/); expect(calls2.length).toBe(2)
    const calls3: Call[] = []; const c3 = mockClient(calls3, { maxRetries: 1 }, (_u, n) => { if (n === 1) { const e = new Error('aborted'); e.name = 'AbortError'; throw e } return undefined })
    await c3.version(); expect(calls3.length).toBe(2)
  })
  it('bad envelopes and non-JSON bodies are errors; 4xx is not retried', async () => {
    await expect(mockClient([], {}, () => json('{"success":true}')).version()).rejects.toThrow(/API_BAD_ENVELOPE/)
    await expect(mockClient([], {}, () => json('<html>')).version()).rejects.toThrow(/API_BAD_ENVELOPE/)
    const calls: Call[] = []; await expect(mockClient(calls, {}, () => json('nope', 404)).version()).rejects.toThrow(/HTTP 404/); expect(calls.length).toBe(1)
  })
  it('enforces the hard request budget', async () => {
    const c = mockClient([], { maxTotalRequests: 1 })
    await c.version(); await expect(c.version()).rejects.toThrow(/API_BUDGET_EXHAUSTED/)
  })
})
describe('listStandardPoolsByMint pagination', () => {
  it('list-v2 follows nextPageId until the last page and dedups across pages', async () => {
    const calls: Call[] = []; const c = mockClient(calls)
    const run = await c.listStandardPoolsByMint({ pageSize: 5, cap: 100 })
    expect(run.endpoint).toBe('list-v2'); expect(run.poolType).toBe('Standard'); expect(run.pages.length).toBe(2); expect(run.stoppedReason).toBe('LAST_PAGE'); expect(run.capped).toBe(false)
    expect(run.totalItems).toBe(7); expect(run.duplicateIds).toBe(1)
    expect(calls[0]!.url).toContain(`mint1=${WSOL_B58}`); expect(calls[0]!.url).toContain('poolType=Standard'); expect(calls[0]!.url).toContain('size=5'); expect(calls[0]!.url).not.toContain('nextPageId')
    expect(calls[1]!.url).toContain(`nextPageId=${CURSOR}`)
    expect(run.pages[0]!.nextPageId).toBe(CURSOR); expect(run.pages[1]!.nextPageId).toBeNull(); expect(run.pages[1]!.hasNextPage).toBe(false)
    const { items, duplicateIds, pageOf } = itemsFromPages(run.pages, 100)
    expect(items.length).toBe(7); expect(duplicateIds).toBe(1); expect(pageOf.get(items[0]!.id)).toBe(run.pages[0])
  })
  it('stops at the cap and flags it', async () => {
    const calls: Call[] = []; const c = mockClient(calls)
    const run = await c.listStandardPoolsByMint({ pageSize: 5, cap: 3 })
    expect(run.pages.length).toBe(1); expect(run.capped).toBe(true); expect(run.stoppedReason).toMatch(/CAP_REACHED/); expect(run.totalItems).toBe(3)
    expect(itemsFromPages(run.pages, run.cap).items.length).toBe(3)
  })
  it('/pools/info/mint paginates with page/pageSize until hasNextPage=false', async () => {
    const calls: Call[] = []; const c = mockClient(calls)
    const run = await c.listStandardPoolsByMint({ endpoint: 'info-mint', pageSize: 5, cap: 100 })
    expect(run.pages.length).toBe(2); expect(run.stoppedReason).toBe('LAST_PAGE'); expect(run.totalItems).toBe(7)
    expect(calls[0]!.url).toContain('poolType=standard'); expect(calls[0]!.url).toContain('poolSortField=liquidity'); expect(calls[0]!.url).toContain('page=1'); expect(calls[1]!.url).toContain('page=2')
  })
  it('guards against a repeating cursor and empty pages', async () => {
    const loop = mockClient([], {}, () => json(JSON.stringify({ success: true, data: { data: [{ id: 'X', type: 'Standard', programId: 'p', mintA: { address: 'a' }, mintB: { address: 'b' } }], nextPageId: 'same' } })))
    const run = await loop.listStandardPoolsByMint({ pageSize: 5, cap: 100 })
    expect(run.stoppedReason).toBe('NO_NEW_ITEMS'); expect(run.pages.length).toBe(2)
    const empty = mockClient([], {}, () => json('{"success":true,"data":{"data":[]}}'))
    expect((await empty.listStandardPoolsByMint({ pageSize: 5, cap: 100 })).stoppedReason).toBe('EMPTY_PAGE')
  })
})
describe('CPMM filtering and PoolRef conversion', () => {
  it('keeps only CPMM programId (AMM v4 shares type Standard)', () => {
    expect(page1Items.length).toBe(5); expect(page1Items.filter(i => i.programId === RAYDIUM_AMM_V4_PROGRAM_ID).length).toBe(2)
    const cp = filterCpmm(page1Items); expect(cp.length).toBe(3); for (const i of cp) expect(i.programId).toBe(RAYDIUM_CPMM_PROGRAM_ID)
  })
  it('converts items to PoolRefs with flat hints and provenance; never fakes a ref', () => {
    const cpmm = filterCpmm(page1Items)[0]!
    const r = raydiumItemToPoolRef(cpmm, '2026-09-17T00:00:00.000Z', 'https://api-v3.raydium.io/pools/info/list-v2?x')
    expect('ref' in r).toBe(true); if (!('ref' in r)) return
    expect(r.ref.adapter).toBe('raydium_cpmm'); expect(r.ref.address.toBase58()).toBe(cpmm.id); expect(r.ref.source).toEqual({ kind: 'raydium_api_v3', ref: 'https://api-v3.raydium.io/pools/info/list-v2?x', observedAtUtc: '2026-09-17T00:00:00.000Z' })
    expect(r.ref.hints?.['mintA']).toBe(cpmm.mintA.address); expect(r.ref.hints?.['mintB']).toBe(cpmm.mintB.address); expect(typeof r.ref.hints?.['tvl']).toBe('number'); expect(r.ref.hints?.['liquidityHint']).toBe('raydium_api_tvl_usd')
    expect(r.ref.hints?.['configId']).toBe(cpmm.config?.id); expect(r.ref.hints?.['tradeFeeRate']).toBe(cpmm.config?.tradeFeeRate)
    expect(wsolCounterMint(cpmm.mintA.address, cpmm.mintB.address)).not.toBeNull()
    const amm = page1Items.find(i => i.programId === RAYDIUM_AMM_V4_PROGRAM_ID)!
    expect(raydiumItemToPoolRef(amm, 't', 'u')).toEqual({ skip: `NOT_CPMM programId=${RAYDIUM_AMM_V4_PROGRAM_ID}` })
    expect(raydiumItemToPoolRef({ ...cpmm, id: 'not-a-key!' }, 't', 'u')).toEqual({ skip: 'BAD_POOL_ID not-a-key!' })
    expect(raydiumItemToPoolRef({ ...cpmm, mintB: { ...cpmm.mintB, address: '0OIl' } }, 't', 'u')).toEqual({ skip: `BAD_MINT ${cpmm.id}` })
    const noTvl: ApiPoolItem = { ...cpmm }; delete noTvl.tvl
    expect(raydiumItemToPoolRef(noTvl, 't', 'u')).toMatchObject({ ref: { hints: { tvl: null, liquidityHint: 'unknown' } } })
  })
  it('wsolCounterMint handles both sides and non-WSOL pairs', () => {
    expect(wsolCounterMint(WSOL_B58, 'M')).toBe('M'); expect(wsolCounterMint('M', WSOL_B58)).toBe('M'); expect(wsolCounterMint('M', 'N')).toBeNull(); expect(wsolCounterMint(WSOL_B58, WSOL_B58)).toBeNull(); expect(wsolCounterMint(undefined, WSOL_B58)).toBeNull()
  })
  it('poolKeysByIds chunks at 100 ids, reports missing ids, and maps keys to keys_* hints', async () => {
    const keysFixture = (JSON.parse(KEYS) as { data: (ApiPoolKeys | null)[] }).data
    const known = keysFixture.filter((k): k is ApiPoolKeys => k !== null).map(k => k.id)
    const calls: Call[] = []; const c = mockClient(calls)
    const ids = [...known, ...Array.from({ length: 150 - known.length }, (_, i) => `unknown${i}`)]
    const r = await c.poolKeysByIds(ids)
    expect(calls.length).toBe(2); expect(calls[0]!.url).toContain(`ids=${known[0]}`); expect(r.keys.length).toBe(known.length * 2 /* same fixture body served for both chunks */); expect(r.missing.length).toBe(150 - known.length)
    const h = poolKeysToHints(r.keys[0]!)
    expect(typeof h['keys_vaultA']).toBe('string'); expect(typeof h['keys_vaultB']).toBe('string'); expect(typeof h['keys_authority']).toBe('string'); expect(typeof h['keys_observationId']).toBe('string'); expect(h['keys_programId']).toBe(RAYDIUM_CPMM_PROGRAM_ID)
  })
  it('records raw captures with the fixed clock', async () => { const c = mockClient([]); const { capture } = await c.getJson<unknown>('/main/version'); expect(capture.fetchedAtUtc).toBe(fixedClock()); expect(capture.httpStatus).toBe(200); expect(capture.attempts).toBe(1) })
})
