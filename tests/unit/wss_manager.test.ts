import { describe, it, expect, afterAll } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { PublicKey } from '@solana/web3.js'
import { WssManager } from '../../src/state/wss.js'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
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
})
