import { PublicKey } from '@solana/web3.js'
import type { PoolRef } from '../adapters/types.js'
import { WSOL_MINT } from '../state/token.js'
import { monoMs, nowUtcIso, sleep } from '../util/time.js'
import { redactDeep, type JsonlLogger } from '../telemetry/log.js'

/**
 * Raydium API v3 client — DISCOVERY ONLY (pool addresses + unverified hints). Never used for pricing; every address is
 * unverified until src/state/snapshot.ts decodes and validates it on-chain.
 *
 * Facts used here come from docs/sources/raydium_cpmm.md §8 (endpoints, per-endpoint poolType casing, response shapes,
 * "type Standard covers AMM v4 AND CPMM → filter by programId") and docs/sources/discovery_apis.md (live pagination
 * verification, 2026-09-17). Rate limits of the API are UNKNOWN (§8) → we self-limit to <=2 req/s, serialized.
 */
export const RAYDIUM_API_BASE = 'https://api-v3.raydium.io'
/** raydium_cpmm.md §1 (VERIFIED_IN_SOURCE) and §8 (programId filter). */
export const RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
/** raydium_cpmm.md §8: AMM v4 program id that shares `type:"Standard"` with CPMM (must be filtered OUT). */
export const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
export const WSOL_B58 = WSOL_MINT.toBase58()
export const DEFAULT_USER_AGENT = 'atomarb-research'
/** Docs cap (raydium_cpmm.md §8, DOCS_ONLY): pageSize/size <= 1000. Live-verified 2026-09-17 (discovery_apis.md §2). */
export const MAX_PAGE_SIZE = 1000
/** Brief cap: never list more than this many pools per run (logged when hit). */
export const DEFAULT_LIST_CAP = 5000

// ---- API shapes (only the fields we read; extra fields are carried through untouched in raw captures) ----
export interface ApiMintInfo { chainId?: number; address: string; programId: string; decimals: number; symbol?: string; name?: string; tags?: string[] }
export interface ApiCpmmConfig { id: string; index: number; protocolFeeRate: number; tradeFeeRate: number; fundFeeRate: number; createPoolFee: string; creatorFeeRate?: number; showWithUI?: boolean }
/** Item of /pools/info/list-v2 and /pools/info/mint (raydium_cpmm.md §8 item keys). */
export interface ApiPoolItem {
  type: string; programId: string; id: string; mintA: ApiMintInfo; mintB: ApiMintInfo
  config?: ApiCpmmConfig; feeRate?: number; openTime?: string; tvl?: number; price?: number
  mintAmountA?: number; mintAmountB?: number; burnPercent?: number; launchMigratePool?: boolean; hasDynamicFee?: boolean
  [k: string]: unknown
}
/** Item of /pools/key/ids for a CPMM pool (raydium_cpmm.md §8; live-verified equal to on-chain PoolState fields). */
export interface ApiPoolKeys {
  programId: string; id: string; mintA: ApiMintInfo; mintB: ApiMintInfo; lookupTableAccount?: string; openTime?: string
  vault?: { A: string; B: string }; authority?: string; mintLp?: ApiMintInfo; config?: ApiCpmmConfig; observationId?: string
  [k: string]: unknown
}
export interface ApiEnvelope<T> { id?: string; success: boolean; msg?: string; data?: T }
/** /pools/info/list-v2 payload: `{data:[items], nextPageId?}` (§8; nextPageId absent on the last page — discovery_apis.md §2). */
export interface ListV2Page { data: ApiPoolItem[]; nextPageId?: string }
/** /pools/info/mint payload: `{count, hasNextPage, data:[items]}` — `count` is the number of items in THIS page, not a total (discovery_apis.md §2). */
export interface InfoMintPage { count: number; hasNextPage: boolean; data: ApiPoolItem[] }

export type ListEndpoint = 'list-v2' | 'info-mint'
export interface RawCapture { url: string; fetchedAtUtc: string; httpStatus: number; durationMs: number; attempts: number }
export interface ListPage extends RawCapture { itemCount: number; nextPageId: string | null; hasNextPage: boolean; body: unknown }
/** Persisted under data/discovery/*.json; the offline path (`--no-network`) re-derives PoolRefs from `pages` with the same code. */
export interface ListRun {
  schema: 'atomarb.raydium_api_cache.v1'; endpoint: ListEndpoint; baseUrl: string; mint: string; poolType: string; pageSize: number; cap: number
  startedAtUtc: string; finishedAtUtc: string; pages: ListPage[]; stoppedReason: string; capped: boolean; totalItems: number; duplicateIds: number
}

export class RaydiumApiError extends Error {
  constructor(msg: string, readonly url: string, readonly httpStatus?: number, readonly retryable: boolean = false) { super(msg); this.name = 'RaydiumApiError' }
}

export interface RaydiumApiOptions {
  baseUrl?: string
  /** self-imposed; API limit is UNKNOWN (§8). Default 2. */
  maxRequestsPerSecond?: number
  timeoutMs?: number
  maxRetries?: number
  /** hard budget for the life of the client */
  maxTotalRequests?: number
  userAgent?: string
  backoff?: { baseMs: number; maxMs: number; jitter: number }
  /** injection points for deterministic tests */
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
  clock?: () => string
  random?: () => number
  log?: JsonlLogger
}

/** Serialized (concurrency 1), rate-limited GET client with timeout, retries+backoff on transient failures, and a hard request budget. */
export class RaydiumApiClient {
  readonly baseUrl: string
  readonly usage = { total: 0, errors: 0, retries: 0, urls: [] as string[] }
  private readonly minIntervalMs: number
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly maxTotal: number
  private readonly userAgent: string
  private readonly backoff: { baseMs: number; maxMs: number; jitter: number }
  private readonly fetchImpl: typeof fetch
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly clock: () => string
  private readonly random: () => number
  private readonly log: JsonlLogger | undefined
  private lastStartMono = Number.NEGATIVE_INFINITY
  private queue: Promise<unknown> = Promise.resolve()
  constructor(opts: RaydiumApiOptions = {}) {
    this.baseUrl = opts.baseUrl ?? RAYDIUM_API_BASE
    const rps = opts.maxRequestsPerSecond ?? 2
    if (!(rps > 0) || rps > 2) throw new Error(`maxRequestsPerSecond must be in (0, 2], got ${rps}`)
    this.minIntervalMs = Math.ceil(1000 / rps)
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.maxRetries = opts.maxRetries ?? 4
    this.maxTotal = opts.maxTotalRequests ?? 100
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT
    this.backoff = opts.backoff ?? { baseMs: 500, maxMs: 8_000, jitter: 0.3 }
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.sleepImpl = opts.sleepImpl ?? sleep
    this.clock = opts.clock ?? nowUtcIso
    this.random = opts.random ?? Math.random
    this.log = opts.log
  }
  buildUrl(path: string, query: Record<string, string | number | boolean | undefined> = {}): string {
    const u = new URL(path, this.baseUrl)
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v))
    return u.toString()
  }
  /** GET + parse the `{success,data,msg}` envelope. Requests are serialized so the rate limit holds under concurrent callers. */
  async getJson<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<{ data: T; capture: RawCapture }> {
    const url = this.buildUrl(path, query)
    const run = this.queue.then(() => this.getOnce<T>(url))
    this.queue = run.catch(() => undefined)
    return run
  }
  private async getOnce<T>(url: string): Promise<{ data: T; capture: RawCapture }> {
    let attempt = 0
    for (;;) {
      if (this.usage.total >= this.maxTotal) throw new RaydiumApiError(`API_BUDGET_EXHAUSTED after ${this.usage.total} requests`, url)
      const wait = this.lastStartMono + this.minIntervalMs - monoMs()
      if (wait > 0) await this.sleepImpl(wait)
      this.lastStartMono = monoMs()
      this.usage.total++; this.usage.urls.push(url)
      const t0 = monoMs(); const fetchedAtUtc = this.clock()
      try {
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
        let res: Response
        try {
          res = await this.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', 'user-agent': this.userAgent }, signal: ctrl.signal })
        } finally { clearTimeout(timer) }
        const text = await res.text()
        let body: unknown = null
        try { body = JSON.parse(text) } catch { body = null }
        const env = body && typeof body === 'object' ? (body as ApiEnvelope<T>) : null
        // §8: parameter errors come back as HTTP 500 with {"success":false,"msg":"..."} — NOT transient, do not retry.
        if (env && env.success === false) throw new RaydiumApiError(`API_ERROR ${env.msg ?? 'unknown'} (HTTP ${res.status})`, url, res.status, false)
        if (res.status === 429 || res.status >= 500) throw new RaydiumApiError(`HTTP ${res.status}`, url, res.status, true)
        if (!res.ok) throw new RaydiumApiError(`HTTP ${res.status}: ${text.slice(0, 200)}`, url, res.status, false)
        if (!env || env.success !== true || env.data === undefined) throw new RaydiumApiError(`API_BAD_ENVELOPE ${text.slice(0, 200)}`, url, res.status, false)
        const capture: RawCapture = { url, fetchedAtUtc, httpStatus: res.status, durationMs: monoMs() - t0, attempts: attempt + 1 }
        this.log?.debug('raydium_api_ok', { url, httpStatus: res.status, durationMs: capture.durationMs, attempts: capture.attempts })
        return { data: env.data, capture }
      } catch (e) {
        const err = e as Error & { name?: string }
        const transient = err instanceof RaydiumApiError ? err.retryable : (err.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(err.message))
        this.usage.errors++
        if (!transient || attempt >= this.maxRetries) throw err
        attempt++; this.usage.retries++
        const base = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** attempt)
        const backoffMs = Math.max(0, Math.round(base * (1 + this.backoff.jitter * (this.random() * 2 - 1))))
        this.log?.warn('raydium_api_retry', { url, attempt, waitMs: backoffMs, error: err.message })
        await this.sleepImpl(backoffMs)
      }
    }
  }
  /** GET /main/version → {latest, least} (§8). */
  async version(): Promise<{ latest: string; least: string }> { return (await this.getJson<{ latest: string; least: string }>('/main/version')).data }
  /**
   * Lists ALL Standard pools paired with `mint` (WSOL by default), sorted by liquidity desc, paginating until the API says
   * there is no next page or `cap` distinct pools were collected (then `capped=true`, logged). Default endpoint is
   * /pools/info/list-v2 (nextPageId cursor; the SDK 0.2.70 path) — /pools/info/mint (page/pageSize) is kept for
   * cross-checks. Both verified live to paginate fully (discovery_apis.md §2). No RPC is involved.
   */
  async listStandardPoolsByMint(opts: { mint?: string; endpoint?: ListEndpoint; pageSize?: number; cap?: number; maxPages?: number } = {}): Promise<ListRun> {
    const mint = opts.mint ?? WSOL_B58
    const endpoint: ListEndpoint = opts.endpoint ?? 'list-v2'
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(opts.pageSize ?? MAX_PAGE_SIZE)))
    const cap = Math.max(1, Math.floor(opts.cap ?? DEFAULT_LIST_CAP))
    const maxPages = opts.maxPages ?? Math.ceil(cap / pageSize) + 2
    // §8: poolType casing differs per endpoint — list-v2 wants `Standard`, /pools/info/mint wants lowercase `standard`.
    const poolType = endpoint === 'list-v2' ? 'Standard' : 'standard'
    const startedAtUtc = this.clock()
    const pages: ListPage[] = []; const seen = new Set<string>(); const seenCursors = new Set<string>()
    let total = 0, duplicateIds = 0, stoppedReason = '', capped = false, nextPageId: string | null = null, page = 1
    for (;;) {
      if (total >= cap) { capped = true; stoppedReason = `CAP_REACHED cap=${cap}`; this.log?.warn('raydium_api_list_capped', { endpoint, mint, cap, pages: pages.length }); break }
      if (pages.length >= maxPages) { stoppedReason = `MAX_PAGES ${maxPages}`; break }
      const cursor: string | undefined = nextPageId ?? undefined
      const resp: { data: ListV2Page | InfoMintPage; capture: RawCapture } = endpoint === 'list-v2'
        ? await this.getJson<ListV2Page>('/pools/info/list-v2', { size: pageSize, mint1: mint, poolType, sortField: 'liquidity', sortType: 'desc', nextPageId: cursor })
        : await this.getJson<InfoMintPage>('/pools/info/mint', { mint1: mint, poolType, poolSortField: 'liquidity', sortType: 'desc', pageSize, page })
      const { data, capture } = resp
      const items: ApiPoolItem[] = Array.isArray(data.data) ? data.data : []
      let fresh = 0
      for (const it of items) { if (!it || typeof it.id !== 'string') continue; if (seen.has(it.id)) { duplicateIds++; continue } seen.add(it.id); fresh++ }
      total += fresh
      const rawNext: unknown = endpoint === 'list-v2' ? (data as ListV2Page).nextPageId : undefined
      const np: string | null = typeof rawNext === 'string' && rawNext !== '' ? rawNext : null
      const hasNext: boolean = endpoint === 'list-v2' ? np !== null : (data as InfoMintPage).hasNextPage === true
      pages.push({ ...capture, itemCount: items.length, nextPageId: np, hasNextPage: hasNext, body: redactDeep(data) })
      this.log?.info('raydium_api_page', { endpoint, page: pages.length, items: items.length, fresh, total, hasNext })
      if (items.length === 0) { stoppedReason = 'EMPTY_PAGE'; break }
      if (!hasNext) { stoppedReason = 'LAST_PAGE'; break }
      if (fresh === 0) { stoppedReason = 'NO_NEW_ITEMS'; break }
      if (np !== null) { if (seenCursors.has(np)) { stoppedReason = 'NEXT_PAGE_ID_REPEATED'; break } seenCursors.add(np); nextPageId = np }
      page++
    }
    return { schema: 'atomarb.raydium_api_cache.v1', endpoint, baseUrl: this.baseUrl, mint, poolType, pageSize, cap, startedAtUtc, finishedAtUtc: this.clock(), pages, stoppedReason, capped, totalItems: Math.min(total, cap), duplicateIds }
  }
  /** GET /pools/key/ids?ids=… in chunks of <=100 ids. Unknown ids come back as null (SDK filters them with Boolean). */
  async poolKeysByIds(ids: string[]): Promise<{ keys: ApiPoolKeys[]; missing: string[]; captures: RawCapture[] }> {
    const keys: ApiPoolKeys[] = []; const captures: RawCapture[] = []
    const uniq = [...new Set(ids)]
    for (let i = 0; i < uniq.length; i += 100) {
      const chunk = uniq.slice(i, i + 100)
      const { data, capture } = await this.getJson<(ApiPoolKeys | null)[]>('/pools/key/ids', { ids: chunk.join(',') })
      captures.push(capture)
      for (const k of Array.isArray(data) ? data : []) if (k && typeof k.id === 'string') keys.push(redactDeep(k))
    }
    const got = new Set(keys.map(k => k.id))
    return { keys, missing: uniq.filter(id => !got.has(id)), captures }
  }
}

/** Pure: distinct items (by id, first occurrence wins) across persisted pages, truncated at `cap`. Shared by online and `--no-network` paths. */
export function itemsFromPages(pages: ListPage[], cap: number): { items: ApiPoolItem[]; pageOf: Map<string, ListPage>; duplicateIds: number } {
  const seen = new Set<string>(); const items: ApiPoolItem[] = []; const pageOf = new Map<string, ListPage>(); let duplicateIds = 0
  for (const p of pages) {
    const body = p.body as { data?: unknown } | null
    const arr = body && Array.isArray(body.data) ? (body.data as ApiPoolItem[]) : []
    for (const it of arr) {
      if (!it || typeof it !== 'object' || typeof it.id !== 'string') continue
      if (seen.has(it.id)) { duplicateIds++; continue }
      if (items.length >= cap) return { items, pageOf, duplicateIds }
      seen.add(it.id); items.push(it); pageOf.set(it.id, p)
    }
  }
  return { items, pageOf, duplicateIds }
}
/** §8: `type:"Standard"` covers AMM v4 and CPMM → keep only programId == CPMM. */
export function filterCpmm(items: ApiPoolItem[]): ApiPoolItem[] { return items.filter(it => it.programId === RAYDIUM_CPMM_PROGRAM_ID) }
/** The non-WSOL mint of a WSOL pair, or null when the item is not a WSOL pair (both or neither side WSOL). */
export function wsolCounterMint(mintA: string | undefined, mintB: string | undefined): string | null {
  if (!mintA || !mintB) return null
  if (mintA === WSOL_B58 && mintB !== WSOL_B58) return mintB
  if (mintB === WSOL_B58 && mintA !== WSOL_B58) return mintA
  return null
}
function num(x: unknown): number | null { return typeof x === 'number' && Number.isFinite(x) ? x : null }
function str(x: unknown): string | null { return typeof x === 'string' ? x : null }
function bool(x: unknown): boolean | null { return typeof x === 'boolean' ? x : null }
/**
 * API item → PoolRef (adapter raydium_cpmm) with flat hints. Returns null (with a reason) when the id/mints are not valid
 * base58 keys or the programId is not CPMM — never a fake PoolRef. Hints are unverified and never used for quoting.
 */
export function raydiumItemToPoolRef(item: ApiPoolItem, observedAtUtc: string, sourceRef: string): { ref: PoolRef } | { skip: string } {
  if (item.programId !== RAYDIUM_CPMM_PROGRAM_ID) return { skip: `NOT_CPMM programId=${item.programId}` }
  let address: PublicKey
  try { address = new PublicKey(item.id) } catch { return { skip: `BAD_POOL_ID ${item.id}` } }
  const mintA = str(item.mintA?.address), mintB = str(item.mintB?.address)
  if (!mintA || !mintB) return { skip: `MISSING_MINTS ${item.id}` }
  try { new PublicKey(mintA); new PublicKey(mintB) } catch { return { skip: `BAD_MINT ${item.id}` } }
  const hints: Record<string, string | number | boolean | null> = {
    programId: item.programId, type: str(item.type), mintA, mintB,
    mintProgramA: str(item.mintA?.programId), mintProgramB: str(item.mintB?.programId),
    decimalsA: num(item.mintA?.decimals), decimalsB: num(item.mintB?.decimals),
    tvl: num(item.tvl), liquidityHint: num(item.tvl) === null ? 'unknown' : 'raydium_api_tvl_usd',
    openTime: str(item.openTime), configId: str(item.config?.id), configIndex: num(item.config?.index),
    tradeFeeRate: num(item.config?.tradeFeeRate), protocolFeeRate: num(item.config?.protocolFeeRate), fundFeeRate: num(item.config?.fundFeeRate), creatorFeeRate: num(item.config?.creatorFeeRate),
    feeRate: num(item.feeRate), mintAmountA: num(item.mintAmountA), mintAmountB: num(item.mintAmountB),
    burnPercent: num(item.burnPercent), launchMigratePool: bool(item.launchMigratePool), hasDynamicFee: bool(item.hasDynamicFee),
  }
  return { ref: { adapter: 'raydium_cpmm', address, source: { kind: 'raydium_api_v3', ref: sourceRef, observedAtUtc }, hints } }
}
/** /pools/key/ids item → flat `keys_*` hints (vaults, authority, config, observation, LUT). HINTS ONLY — the adapter re-derives/validates on-chain. */
export function poolKeysToHints(k: ApiPoolKeys): Record<string, string | number | boolean | null> {
  return {
    keys_programId: str(k.programId), keys_vaultA: str(k.vault?.A), keys_vaultB: str(k.vault?.B), keys_authority: str(k.authority),
    keys_configId: str(k.config?.id), keys_configIndex: num(k.config?.index), keys_tradeFeeRate: num(k.config?.tradeFeeRate),
    keys_observationId: str(k.observationId), keys_mintLp: str(k.mintLp?.address), keys_lookupTableAccount: str(k.lookupTableAccount), keys_openTime: str(k.openTime),
    keys_mintA: str(k.mintA?.address), keys_mintB: str(k.mintB?.address), keys_mintProgramA: str(k.mintA?.programId), keys_mintProgramB: str(k.mintB?.programId),
  }
}
