import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { PublicKey } from '@solana/web3.js'
import { RpcClient, RpcBudgetExhausted, RpcTimeout } from '../../src/state/rpc.js'
/** Local JSON-RPC stub: scripted responses per method, counts requests, can emit 429 / delays. */
let server: Server; let url = ''
const calls: { method: string; params: unknown }[] = []
/** delayMs: nothing is written for that long (headers included). bodyDelayMs: headers are flushed at once, the body only later. */
let script: ((method: string, params: unknown, n: number) => { status?: number; body?: unknown; delayMs?: number; bodyDelayMs?: number }) = () => ({ body: { jsonrpc: '2.0', id: 1, result: 1 } })
const pendingTimers: NodeJS.Timeout[] = []
beforeAll(async () => {
  server = createServer((req, res) => {
    let data = ''; req.on('data', c => { data += c }); req.on('end', () => {
      const j = JSON.parse(data) as { id: number; method: string; params: unknown }
      calls.push({ method: j.method, params: j.params })
      const r = script(j.method, j.params, calls.length)
      const payload = () => JSON.stringify(r.body ?? { jsonrpc: '2.0', id: j.id, result: null })
      const send = () => { res.statusCode = r.status ?? 200; res.setHeader('content-type', 'application/json'); res.end(payload()) }
      if (r.bodyDelayMs !== undefined) {
        res.statusCode = r.status ?? 200; res.setHeader('content-type', 'application/json'); res.flushHeaders()   // headers now, body later
        pendingTimers.push(setTimeout(() => { if (!res.writableEnded) res.end(payload()) }, r.bodyDelayMs))
      } else if (r.delayMs) pendingTimers.push(setTimeout(send, r.delayMs))
      else send()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address() as { port: number }; url = `http://127.0.0.1:${a.port}`
})
afterAll(() => { for (const t of pendingTimers) clearTimeout(t); server.closeAllConnections?.(); server.close() })
const limits = { maxRequestsPerSecond: 50, maxConcurrentRequests: 2, maxTotalHttpRequests: 20, requestTimeoutMs: 300, backoff: { baseMs: 10, maxMs: 50, jitter: 0 } }
describe('RpcClient', () => {
  it('forbids submit methods before any network call', async () => {
    const c = new RpcClient(url, limits, 'confirmed'); const before = calls.length
    for (const m of ['sendTransaction', 'sendRawTransaction', 'sendBundle', 'requestAirdrop']) await expect(c.call(m, [])).rejects.toThrow(/LIVE_NOT_AUTHORIZED/)
    expect(calls.length).toBe(before)
  })
  it('retries on HTTP 429 with backoff, then succeeds; counts retries', async () => {
    let n = 0; script = () => (++n < 3 ? { status: 429, body: {} } : { body: { jsonrpc: '2.0', id: 1, result: 42 } })
    const c = new RpcClient(url, limits, 'confirmed')
    expect(await c.call('getSlot', [])).toBe(42); expect(c.usage.retries).toBe(2); expect(c.usage.total).toBe(3)
  })
  it('times out and retries; gives up after 5 attempts', async () => {
    script = () => ({ delayMs: 1000 })
    const c = new RpcClient(url, { ...limits, requestTimeoutMs: 50 }, 'confirmed')
    await expect(c.call('getSlot', [])).rejects.toThrow(); expect(c.usage.total).toBe(5)
  })
  it('hard total budget stops further requests', async () => {
    script = () => ({ body: { jsonrpc: '2.0', id: 1, result: 1 } })
    const c = new RpcClient(url, { ...limits, maxTotalHttpRequests: 3 }, 'confirmed')
    for (let i = 0; i < 3; i++) await c.call('getSlot', [])
    await expect(c.call('getSlot', [])).rejects.toThrow(RpcBudgetExhausted)
  })
  it('non-retryable JSON-RPC errors surface immediately with code', async () => {
    script = () => ({ body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } } })
    const c = new RpcClient(url, limits, 'confirmed')
    await expect(c.call('getSlot', [])).rejects.toThrow(/Invalid params/); expect(c.usage.total).toBe(1)
  })
  it('getMultipleAccounts enforces 1..100 keys and tags accounts with the batch context slot', async () => {
    const keys = Array.from({ length: 3 }, () => PublicKey.unique())
    script = () => ({ body: { jsonrpc: '2.0', id: 1, result: { context: { slot: 777 }, value: [{ data: [Buffer.from([1, 2, 3]).toString('base64'), 'base64'], owner: keys[0]!.toBase58(), lamports: 5, executable: false }, null, { data: ['', 'base64'], owner: keys[1]!.toBase58(), lamports: 0, executable: false }] } } })
    const c = new RpcClient(url, limits, 'confirmed')
    await expect(c.getMultipleAccounts([])).rejects.toThrow(/1\.\.100/)
    await expect(c.getMultipleAccounts(Array.from({ length: 101 }, () => PublicKey.unique()))).rejects.toThrow(/1\.\.100/)
    const r = await c.getMultipleAccounts(keys)
    expect(r.context.slot).toBe(777); expect(r.missing).toHaveLength(1); expect(r.bundle.singleBatch).toBe(true)
    const a = r.bundle.accounts.get(keys[0]!.toBase58())!; expect(a.contextSlot).toBe(777); expect([...a.data]).toEqual([1, 2, 3]); expect(a.lamports).toBe(5n); expect(a.batchId).toBe(r.bundle.batchIds[0])
    const batched = await c.getAccountsBatched(Array.from({ length: 150 }, () => PublicKey.unique()))
    expect(batched.bundle.singleBatch).toBe(false); expect(batched.bundle.batchIds).toHaveLength(2)
  })
  it('rate limiter spaces requests (5 rps => >= 600ms for 4 extra requests)', async () => {
    script = () => ({ body: { jsonrpc: '2.0', id: 1, result: 1 } })
    const c = new RpcClient(url, { ...limits, maxRequestsPerSecond: 5 }, 'confirmed')
    const t0 = Date.now(); for (let i = 0; i < 9; i++) await c.call('getSlot', [])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600)
  })
  // F4 regression: the budget was checked before the concurrency wait and the token-bucket sleep, while usage.total was
  // incremented only after them, so every concurrent caller read the same pre-increment total and all requests went out.
  it('F4: reserves the HTTP budget atomically - 8 concurrent calls with budget 1 send exactly 1 request', async () => {
    script = () => ({ body: { jsonrpc: '2.0', id: 1, result: 42 } })
    const before = calls.length
    const c = new RpcClient(url, { ...limits, maxTotalHttpRequests: 1, maxConcurrentRequests: 1 }, 'confirmed')
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => c.call<number>('getSlot', [])))
    const ok = settled.filter(s => s.status === 'fulfilled')
    const rejected = settled.filter(s => s.status === 'rejected') as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(rejected).toHaveLength(7)
    for (const r of rejected) { expect(r.reason).toBeInstanceOf(RpcBudgetExhausted); expect((r.reason as Error).message).toMatch(/RPC_BUDGET_EXHAUSTED/) }
    expect(calls.length - before).toBe(1)          // the auditor saw 8 HTTP requests here
    expect(c.usage.total).toBe(1)                  // ... and usage.total 8
    expect(c.usage.byMethod['getSlot']!.count).toBe(1)
  })
  // F5 regression: clearTimeout ran as soon as the response HEADERS arrived, so `await res.json()` was unbounded.
  it('F5: a response body that stalls past the timeout rejects and is counted as an error', async () => {
    script = () => ({ bodyDelayMs: 300, body: { jsonrpc: '2.0', id: 1, result: 1 } })   // headers immediately, body only after 300ms
    const c = new RpcClient(url, { ...limits, requestTimeoutMs: 50 }, 'confirmed')
    const t0 = Date.now()
    await expect(c.call('getSlot', [])).rejects.toThrow(RpcTimeout)   // the auditor's old run SUCCEEDED here, after ~310ms
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(2500)
    expect(c.usage.errors).toBe(5)                 // one per attempt; the auditor saw 0
    expect(c.usage.total).toBe(5); expect(c.usage.retries).toBe(4)
    const ms = c.usage.byMethod['getSlot']!.ms
    expect(ms).toHaveLength(5)
    for (const d of ms) expect(d).toBeGreaterThanOrEqual(40)   // full attempt duration, not the ~9ms of the headers
  })
  it('F5: the recorded latency covers the response body, not just the headers', async () => {
    script = () => ({ bodyDelayMs: 120, body: { jsonrpc: '2.0', id: 1, result: 7 } })
    const c = new RpcClient(url, { ...limits, requestTimeoutMs: 1000 }, 'confirmed')
    expect(await c.call<number>('getSlot', [])).toBe(7)
    const ms = c.usage.byMethod['getSlot']!.ms
    expect(ms).toHaveLength(1); expect(ms[0]!).toBeGreaterThanOrEqual(100)
    expect(c.usage.errors).toBe(0)
  })
})
