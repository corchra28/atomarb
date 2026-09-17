import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { PublicKey } from '@solana/web3.js'
import { RpcClient, RpcBudgetExhausted } from '../../src/state/rpc.js'
/** Local JSON-RPC stub: scripted responses per method, counts requests, can emit 429 / delays. */
let server: Server; let url = ''
const calls: { method: string; params: unknown }[] = []
let script: ((method: string, params: unknown, n: number) => { status?: number; body?: unknown; delayMs?: number }) = () => ({ body: { jsonrpc: '2.0', id: 1, result: 1 } })
beforeAll(async () => {
  server = createServer((req, res) => {
    let data = ''; req.on('data', c => { data += c }); req.on('end', () => {
      const j = JSON.parse(data) as { id: number; method: string; params: unknown }
      calls.push({ method: j.method, params: j.params })
      const r = script(j.method, j.params, calls.length)
      const send = () => { res.statusCode = r.status ?? 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r.body ?? { jsonrpc: '2.0', id: j.id, result: null })) }
      if (r.delayMs) setTimeout(send, r.delayMs); else send()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address() as { port: number }; url = `http://127.0.0.1:${a.port}`
})
afterAll(() => server.close())
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
})
