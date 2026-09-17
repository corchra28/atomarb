import { readFileSync } from 'node:fs'
import type { RaydiumApiOptions } from '../../../src/discovery/raydium_api.js'
import { RaydiumApiClient } from '../../../src/discovery/raydium_api.js'
/** Deterministic fetch that serves the saved (redacted) Raydium API v3 fixtures by URL; no network. */
export const FX_DIR = 'tests/fixtures/discovery'
export const fx = (name: string): string => readFileSync(`${FX_DIR}/${name}`, 'utf8')
export const PAGE1 = fx('raydium_listv2_page1.json'), PAGE2 = fx('raydium_listv2_page2.json'), MINT1 = fx('raydium_infomint_page1.json'), MINT2 = fx('raydium_infomint_page2.json'), KEYS = fx('raydium_pool_keys.json'), ERR = fx('raydium_error_pooltype.json')
export const CURSOR = (JSON.parse(PAGE1) as { data: { nextPageId: string } }).data.nextPageId
export interface Call { url: string; headers: Record<string, string> }
export const json = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'application/json' } })
export function mockFetch(calls: Call[], handler?: (url: URL, n: number) => Response | undefined): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    calls.push({ url: url.toString(), headers: { ...((init?.headers ?? {}) as Record<string, string>) } })
    const custom = handler?.(url, calls.length); if (custom) return custom
    if (url.pathname === '/pools/info/list-v2') return json(url.searchParams.get('nextPageId') === CURSOR ? PAGE2 : PAGE1)
    if (url.pathname === '/pools/info/mint') return json(url.searchParams.get('page') === '2' ? MINT2 : MINT1)
    if (url.pathname === '/pools/key/ids') return json(KEYS)
    if (url.pathname === '/main/version') return json('{"id":"x","success":true,"data":{"latest":"V3.0.1","least":"V3.0.1"}}')
    return json('not found', 404)
  }) as typeof fetch
}
export const noSleep = async (): Promise<void> => {}
export const fixedClock = (): string => '2026-09-17T00:00:00.000Z'
export function mockClient(calls: Call[], extra: RaydiumApiOptions = {}, handler?: (url: URL, n: number) => Response | undefined): RaydiumApiClient {
  return new RaydiumApiClient({ fetchImpl: mockFetch(calls, handler), sleepImpl: noSleep, clock: fixedClock, random: () => 0.5, ...extra })
}
