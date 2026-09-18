import { describe, it, expect, afterAll } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { PublicKey } from '@solana/web3.js'
import { WssManager, type WssStartFailed } from '../../src/state/wss.js'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Resolves with 'HUNG' if p has not settled in `ms` (and never leaves the guard timer behind). */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | 'HUNG'> {
  let t: NodeJS.Timeout | undefined
  const guard = new Promise<'HUNG'>(r => { t = setTimeout(() => r('HUNG'), ms) })
  try { return await Promise.race([p, guard]) } finally { clearTimeout(t) }
}
const closeServer = async (s: Server, sockets: Socket[] = []): Promise<void> => { for (const x of sockets) x.destroy(); s.closeAllConnections?.(); await new Promise<void>(r => s.close(() => r())) }
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
const url = () => `ws://127.0.0.1:${(wss.address() as { port: number }).port}`
const sockets: WebSocket[] = []
let subCounter = 100
wss.on('connection', ws => {
  sockets.push(ws)
  ws.on('message', m => { const j = JSON.parse(m.toString()) as { id: number; method: string; params: [string] }; if (j.method === 'accountSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: ++subCounter })) })
})
afterAll(() => wss.close())
const notif = (sub: number, slot: number, data: number[]) => JSON.stringify({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: sub, result: { context: { slot }, value: { data: [Buffer.from(data).toString('base64'), 'base64'], owner: PublicKey.default.toBase58(), lamports: 1, executable: false } } } })
describe('WssManager', () => {
  it('subscribes, delivers notifications with slot, dedups duplicates, marks a GAP on reconnect and resubscribes', async () => {
    const got: number[] = []; const gaps: string[] = []; const status: string[] = []
    const m = new WssManager(url(), 'confirmed', { onAccount: n => got.push(n.account.contextSlot), onGap: g => gaps.push(g.reason), onStatus: s => status.push(s) })
    const pk = PublicKey.unique(); m.subscribe([pk])
    await m.start(); await sleep(100)
    expect(sockets).toHaveLength(1)
    const sub1 = subCounter
    sockets[0]!.send(notif(sub1, 10, [1])); sockets[0]!.send(notif(sub1, 10, [1])); sockets[0]!.send(notif(sub1, 11, [1])); sockets[0]!.send(notif(999, 12, [1]))
    await sleep(100)
    expect(got).toEqual([10, 11]); expect(m.stats.duplicates).toBe(1); expect(m.stats.dropped).toBe(1)
    // drop the connection: manager must reconnect (backoff ~1s), mark the gap, resubscribe with a NEW subscription id
    sockets[0]!.close(); await sleep(2500)
    expect(sockets.length).toBeGreaterThanOrEqual(2); expect(gaps).toHaveLength(1); expect(m.stats.reconnects).toBe(1)
    const sub2 = subCounter; expect(sub2).not.toBe(sub1)
    sockets[sockets.length - 1]!.send(notif(sub2, 20, [2])); sockets[sockets.length - 1]!.send(notif(sub1, 21, [2]))  // old subscription id must be ignored
    await sleep(100)
    expect(got).toEqual([10, 11, 20]); expect(status).toContain('closed')
    m.stop()
  }, 15_000)

  // F3 regression: start() used to resolve only inside the 'open' handler of the FIRST connect attempt. When that
  // handshake failed, the 'close' handler started a new connect() whose promise nobody held, so start() never settled.
  it('F3: start() settles on a LATER attempt (first handshake answered 503) and notifications then flow', async () => {
    let upgrades = 0; let subId = 0
    const accepted: WebSocket[] = []
    const inner = new WebSocketServer({ noServer: true })
    inner.on('connection', ws => {
      accepted.push(ws)
      ws.on('message', m => { const j = JSON.parse(m.toString()) as { id: number; method: string }; if (j.method === 'accountSubscribe') { subId = 9000 + j.id; ws.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: subId })) } })
    })
    const http = createServer((_q, res) => res.end())
    http.on('upgrade', (req, socket, head) => {
      upgrades++
      if (upgrades === 1) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return }   // first handshake refused
      inner.handleUpgrade(req, socket, head, ws => inner.emit('connection', ws, req))
    })
    await new Promise<void>(r => http.listen(0, '127.0.0.1', () => r()))
    const got: number[] = []; const gaps: string[] = []
    const m = new WssManager(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`, 'confirmed', { onAccount: n => got.push(n.account.contextSlot), onGap: g => gaps.push(g.reason) }, undefined, 5000, { retryBaseMs: 60, startTimeoutMs: 5_000 })
    const pk = PublicKey.unique(); m.subscribe([pk])
    const t0 = Date.now()
    expect(await settleWithin(m.start(), 3000)).toBe('open')   // old behaviour: startResolved FALSE after 2s
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(upgrades).toBe(2); expect(accepted).toHaveLength(1); expect(m.stats.connectFailures).toBe(1)
    await sleep(80)                                            // let the accountSubscribe ack land
    accepted[0]!.send(notif(subId, 42, [9])); await sleep(80)
    expect(got).toEqual([42])
    expect(gaps).toEqual([])                                   // a refused handshake subscribed nothing: it is not an outage
    // what the scanner needs instead of a dirty Set it mutates itself (see notes_for_integrator)
    expect(m.revisionOf(pk.toBase58())).toBe(1); expect(m.currentRevision).toBe(1)
    expect(m.drainDirty()).toEqual([pk.toBase58()])
    expect(m.drainDirty()).toEqual([])                         // drain returns and clears in one synchronous step
    m.stop()
    inner.close(); await closeServer(http)
  }, 15_000)

  it('F3: stop() while the handshake is still pending settles start() instead of hanging', async () => {
    const stuck: Socket[] = []
    const hung = createServer((_q, res) => res.end())
    hung.on('upgrade', (_req, socket) => { stuck.push(socket as Socket) })   // never answers: the client stays CONNECTING
    await new Promise<void>(r => hung.listen(0, '127.0.0.1', () => r()))
    const m = new WssManager(`ws://127.0.0.1:${(hung.address() as AddressInfo).port}`, 'confirmed', { onAccount: () => {}, onGap: () => {} }, undefined, 5000, { startTimeoutMs: 30_000, retryBaseMs: 50 })
    const settled = m.start().then(() => 'RESOLVED' as const, (e: Error) => e)
    await sleep(120)
    expect(stuck).toHaveLength(1)
    m.stop()
    const outcome = await settleWithin(settled, 2000)
    expect(outcome).not.toBe('HUNG')
    expect((outcome as Error).name).toBe('WssStartFailed')
    expect((outcome as WssStartFailed).code).toBe('WSS_START_STOPPED')
    await sleep(120)
    expect(stuck).toHaveLength(1)                              // stop() cancels the lifecycle: no retry runs behind the caller's back
    expect(m.stats.reconnects + m.stats.connectFailures).toBe(0)
    await closeServer(hung, stuck)
  }, 15_000)

  it('F3: start() rejects with WSS_START_TIMEOUT and stops retrying when nothing ever opens', async () => {
    let upgrades = 0
    const refuse = createServer((_q, res) => res.end())
    refuse.on('upgrade', (_req, socket) => { upgrades++; socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n') })
    await new Promise<void>(r => refuse.listen(0, '127.0.0.1', () => r()))
    const m = new WssManager(`ws://127.0.0.1:${(refuse.address() as AddressInfo).port}`, 'confirmed', { onAccount: () => {}, onGap: () => {} }, undefined, 5000, { retryBaseMs: 30, startTimeoutMs: 250 })
    const outcome = await settleWithin(m.start().then(() => 'RESOLVED' as const, (e: Error) => e), 2000)
    expect((outcome as WssStartFailed).code).toBe('WSS_START_TIMEOUT')
    const after = upgrades
    await sleep(200)
    expect(upgrades).toBe(after)                               // the timeout stopped the manager, it is not still reconnecting
    await closeServer(refuse)
  }, 15_000)
})
