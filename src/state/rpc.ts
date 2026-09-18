import { PublicKey, VersionedTransaction, type Commitment } from '@solana/web3.js'
import { monoMs, nowUtcIso, sleep } from '../util/time.js'
import type { RawAccount, AccountBundle } from '../adapters/types.js'
import type { JsonlLogger } from '../telemetry/log.js'

export interface RpcLimits { maxRequestsPerSecond: number; maxConcurrentRequests: number; maxTotalHttpRequests: number; requestTimeoutMs: number; backoff: { baseMs: number; maxMs: number; jitter: number } }
export class RpcBudgetExhausted extends Error { constructor(n: number) { super(`RPC_BUDGET_EXHAUSTED after ${n} requests`); this.name = 'RpcBudgetExhausted' } }
export class RpcError extends Error { constructor(msg: string, readonly code?: number, readonly data?: unknown) { super(msg); this.name = 'RpcError' } }
/** The request timeout covers headers AND body; `phase` says where it fired. Always retried like any other transient failure. */
export class RpcTimeout extends RpcError {
  readonly retryable = true
  constructor(readonly phase: 'headers' | 'body', readonly timeoutMs: number) { super(`RPC_TIMEOUT: no ${phase} within ${timeoutMs}ms`); this.name = 'RpcTimeout' }
}

interface JsonRpcResponse<T> { jsonrpc: '2.0'; id: number; result?: T; error?: { code: number; message: string; data?: unknown } }
export interface RpcContext { slot: number; apiVersion?: string }
export interface UsageStats { total: number; errors: number; retries: number; byMethod: Record<string, { count: number; errors: number; ms: number[] }> }

/** JSON-RPC client with token-bucket rate limiting, bounded concurrency, hard total budget, backoff+jitter, timeouts, and per-call timing. Read-only: send* methods are NOT implemented on purpose. */
export class RpcClient {
  private inflight = 0
  private readonly waiters: (() => void)[] = []
  private tokens: number
  private lastRefill = monoMs()
  private nextId = 1
  readonly usage: UsageStats = { total: 0, errors: 0, retries: 0, byMethod: {} }
  constructor(readonly url: string, readonly limits: RpcLimits, readonly commitment: Commitment, private readonly log?: JsonlLogger) {
    this.tokens = limits.maxRequestsPerSecond
  }
  private static readonly FORBIDDEN = new Set(['sendTransaction', 'sendRawTransaction', 'sendBundle', 'requestAirdrop'])
  /**
   * Reserves ONE budget unit, then a concurrency slot, then a rate-limit token. The budget check and the reservation
   * (usage.total++) run in the same synchronous step on purpose (F4): with an await in between — the concurrency wait
   * or the token-bucket sleep — N concurrent callers all read the same pre-increment total, all pass a budget of 1 and
   * all N requests get sent. Every attempt reserves, so retries consume the same budget as first attempts.
   * Throws before taking any slot, so an exhausted budget releases nothing it never reserved.
   */
  private async acquire(stat: { count: number }): Promise<void> {
    if (this.usage.total >= this.limits.maxTotalHttpRequests) throw new RpcBudgetExhausted(this.usage.total)
    this.usage.total++; stat.count++
    while (this.inflight >= this.limits.maxConcurrentRequests) await new Promise<void>(r => this.waiters.push(r))
    this.inflight++
    // token bucket
    for (;;) {
      const now = monoMs(); const elapsed = (now - this.lastRefill) / 1000
      this.tokens = Math.min(this.limits.maxRequestsPerSecond, this.tokens + elapsed * this.limits.maxRequestsPerSecond); this.lastRefill = now
      if (this.tokens >= 1) { this.tokens -= 1; return }
      await sleep(Math.ceil((1 - this.tokens) / this.limits.maxRequestsPerSecond * 1000))
    }
  }
  private release(): void { this.inflight--; const w = this.waiters.shift(); if (w) w() }
  /**
   * One HTTP attempt, fully covered by the abort signal (F5): fetch() only rejects on the *headers*, so clearing the
   * timer once the headers arrive leaves `res.json()` running unbounded — a stalled body then hangs the caller forever
   * and the recorded latency is the header time, not the real one. The timer is therefore cleared only after the body
   * is parsed, and the duration pushed to usage.byMethod[].ms spans start -> parsed body for every attempt.
   */
  private async attempt<T>(method: string, params: unknown[], stat: { ms: number[] }): Promise<JsonRpcResponse<T>> {
    const t0 = monoMs()
    const ctrl = new AbortController(); let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, this.limits.requestTimeoutMs)
    try {
      let res: Response
      try {
        res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }), signal: ctrl.signal })
      } catch (e) { throw timedOut ? new RpcTimeout('headers', this.limits.requestTimeoutMs) : e }
      if (res.status === 429 || res.status >= 500) {
        void res.body?.cancel().catch(() => {})   // the body of an error response is never read: free the socket instead of leaking it
        throw new RpcError(`HTTP ${res.status}`, res.status)
      }
      try { return (await res.json()) as JsonRpcResponse<T> }
      catch (e) { throw timedOut ? new RpcTimeout('body', this.limits.requestTimeoutMs) : e }
    } finally { clearTimeout(timer); stat.ms.push(monoMs() - t0) }
  }
  async call<T>(method: string, params: unknown[]): Promise<T> {
    if (RpcClient.FORBIDDEN.has(method)) throw new Error(`LIVE_NOT_AUTHORIZED: ${method} is forbidden in this project`)
    const stat = (this.usage.byMethod[method] ??= { count: 0, errors: 0, ms: [] })
    let attempt = 0
    for (;;) {
      await this.acquire(stat)
      try {
        const body = await this.attempt<T>(method, params, stat)
        if (body.error) {
          const retryable = body.error.code === -32005 || body.error.code === -32004 || body.error.code === -32014 // node unhealthy / block not available / slot skipped
          const err = new RpcError(`${method}: ${body.error.message}`, body.error.code, body.error.data)
          if (!retryable) throw err   // counted once, in the catch below
          throw Object.assign(err, { retryable: true })
        }
        return body.result as T
      } catch (e) {
        const err = e as Error & { code?: number; retryable?: boolean; name?: string }
        // RpcTimeout (headers or body) carries retryable=true; AbortError is the raw form if one ever escapes
        const transient = err.retryable === true || err.name === 'AbortError' || err.name === 'RpcTimeout' || err.code === 429 || (typeof err.code === 'number' && err.code >= 500) || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(err.message)
        stat.errors++; this.usage.errors++   // exactly one error per failed attempt (the JSON-RPC branch no longer double-counts)
        if (!transient || attempt >= 4) throw err
        attempt++; this.usage.retries++
        const base = Math.min(this.limits.backoff.maxMs, this.limits.backoff.baseMs * 2 ** attempt)
        const wait = base * (1 + this.limits.backoff.jitter * (Math.random() * 2 - 1))
        this.log?.warn('rpc_retry', { method, attempt, waitMs: Math.round(wait), error: err.message })
        await sleep(wait)
      } finally { this.release() }
    }
  }
  async getSlot(): Promise<number> { return this.call<number>('getSlot', [{ commitment: this.commitment }]) }
  async getVersion(): Promise<{ 'solana-core': string; 'feature-set': number }> { return this.call('getVersion', []) }
  async getLatestBlockhash(): Promise<{ context: RpcContext; value: { blockhash: string; lastValidBlockHeight: number } }> {
    return this.call('getLatestBlockhash', [{ commitment: this.commitment }])
  }
  /** One getMultipleAccounts call (<=100 keys). Returns accounts tagged with the response context slot and a batch id. Missing accounts are absent from the map. */
  async getMultipleAccounts(keys: PublicKey[], opts: { minContextSlot?: number } = {}): Promise<{ bundle: AccountBundle; context: RpcContext; missing: PublicKey[] }> {
    if (keys.length === 0 || keys.length > 100) throw new Error(`getMultipleAccounts requires 1..100 keys, got ${keys.length}`)
    const receivedAtUtc = nowUtcIso()
    const cfg: Record<string, unknown> = { commitment: this.commitment, encoding: 'base64' }
    if (opts.minContextSlot !== undefined) cfg['minContextSlot'] = opts.minContextSlot
    const r = await this.call<{ context: RpcContext; value: ({ data: [string, string]; owner: string; lamports: number; executable: boolean } | null)[] }>('getMultipleAccounts', [keys.map(k => k.toBase58()), cfg])
    const receivedMonoMs = monoMs()
    const batchId = `gma:${r.context.slot}:${receivedMonoMs}:${this.nextId}`
    const accounts = new Map<string, RawAccount>(); const missing: PublicKey[] = []
    r.value.forEach((v, i) => {
      const pk = keys[i]!
      if (!v) { missing.push(pk); return }
      accounts.set(pk.toBase58(), { pubkey: pk, data: new Uint8Array(Buffer.from(v.data[0], 'base64')), owner: new PublicKey(v.owner), lamports: BigInt(v.lamports), executable: v.executable, contextSlot: r.context.slot, receivedAtUtc, receivedMonoMs, batchId, provider: 'rpc_gma' })
    })
    return { bundle: { accounts, singleBatch: true, minSlot: r.context.slot, maxSlot: r.context.slot, batchIds: [batchId] }, context: r.context, missing }
  }
  /** Fetch >100 keys in several batches. The result is explicitly NOT a single atomic snapshot (singleBatch=false when more than one call was needed). */
  async getAccountsBatched(keys: PublicKey[]): Promise<{ bundle: AccountBundle; missing: PublicKey[] }> {
    const accounts = new Map<string, RawAccount>(); const missing: PublicKey[] = []; const batchIds: string[] = []
    let minSlot = Number.MAX_SAFE_INTEGER, maxSlot = 0
    for (let i = 0; i < keys.length; i += 100) {
      const r = await this.getMultipleAccounts(keys.slice(i, i + 100))
      for (const [k, v] of r.bundle.accounts) accounts.set(k, v)
      missing.push(...r.missing); batchIds.push(...r.bundle.batchIds)
      minSlot = Math.min(minSlot, r.context.slot); maxSlot = Math.max(maxSlot, r.context.slot)
    }
    return { bundle: { accounts, singleBatch: batchIds.length === 1, minSlot: keys.length ? minSlot : 0, maxSlot, batchIds }, missing }
  }
  async getFeeForMessage(messageBase64: string): Promise<{ context: RpcContext; value: number | null }> {
    return this.call('getFeeForMessage', [messageBase64, { commitment: this.commitment }])
  }
  async simulateTransaction(tx: VersionedTransaction, opts: { sigVerify?: boolean; replaceRecentBlockhash?: boolean; accounts?: PublicKey[]; innerInstructions?: boolean; minContextSlot?: number } = {}): Promise<SimulateResult> {
    const b64 = Buffer.from(tx.serialize()).toString('base64')
    const cfg: Record<string, unknown> = { commitment: this.commitment, encoding: 'base64', sigVerify: opts.sigVerify ?? false, replaceRecentBlockhash: opts.replaceRecentBlockhash ?? !(opts.sigVerify ?? false), innerInstructions: opts.innerInstructions ?? true }
    if (opts.accounts && opts.accounts.length) cfg['accounts'] = { encoding: 'base64', addresses: opts.accounts.map(a => a.toBase58()) }
    if (opts.minContextSlot !== undefined) cfg['minContextSlot'] = opts.minContextSlot
    const t0 = monoMs()
    const r = await this.call<{ context: RpcContext; value: SimulateValue }>('simulateTransaction', [b64, cfg])
    return { context: r.context, value: r.value, requestConfig: cfg, txBase64: b64, durationMs: monoMs() - t0, receivedAtUtc: nowUtcIso() }
  }
}
export interface SimulateValue {
  err: unknown | null
  logs: string[] | null
  accounts: ({ data: [string, string]; owner: string; lamports: number; executable: boolean } | null)[] | null
  unitsConsumed?: number
  returnData?: { programId: string; data: [string, string] } | null
  innerInstructions?: unknown
  replacementBlockhash?: { blockhash: string; lastValidBlockHeight: number } | null
}
export interface SimulateResult { context: RpcContext; value: SimulateValue; requestConfig: Record<string, unknown>; txBase64: string; durationMs: number; receivedAtUtc: string }
