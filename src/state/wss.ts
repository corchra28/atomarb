import WebSocket from 'ws'
import { PublicKey } from '@solana/web3.js'
import { monoMs, nowUtcIso, sleep } from '../util/time.js'
import { sha256Hex } from '../util/hash.js'
import type { RawAccount } from '../adapters/types.js'
import type { JsonlLogger } from '../telemetry/log.js'
export interface AccountNotification { account: RawAccount; subscriptionId: number; /** hash of (pubkey, slot, data) for dedup */ identity: string }
export interface WssEvents { onAccount: (n: AccountNotification) => void; onGap: (gap: { fromUtc: string; toUtc: string; reason: string }) => void; onStatus?: ((s: string) => void) | undefined }
/**
 * accountSubscribe manager: bounded queue, dedup on (pubkey, slot, data-hash), reconnect with backoff + full resubscribe,
 * and explicit GAP marking between disconnect and successful resubscribe. Never sends anything but subscribe/unsubscribe.
 */
export class WssManager {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, string>()   // request id -> pubkey
  private subs = new Map<number, string>()      // subscription id -> pubkey
  private wanted = new Set<string>()
  private seen = new Set<string>()
  private seenOrder: string[] = []
  private closed = false
  private disconnectedAtUtc: string | null = null
  readonly stats = { notifications: 0, duplicates: 0, dropped: 0, reconnects: 0, gaps: 0 }
  constructor(private readonly url: string, private readonly commitment: string, private readonly events: WssEvents, private readonly log?: JsonlLogger, private readonly maxQueue = 5000) {}
  subscribe(pubkeys: PublicKey[]): void { for (const p of pubkeys) this.wanted.add(p.toBase58()); if (this.ws && this.ws.readyState === WebSocket.OPEN) this.flushSubscribes() }
  async start(): Promise<void> { this.closed = false; await this.connect(0) }
  stop(): void { this.closed = true; this.ws?.close(); this.ws = null }
  private connect(attempt: number): Promise<void> {
    return new Promise(resolve => {
      const ws = new WebSocket(this.url, { handshakeTimeout: 15_000 })
      this.ws = ws
      ws.on('open', () => {
        this.events.onStatus?.('open')
        if (this.disconnectedAtUtc) { this.stats.gaps++; this.events.onGap({ fromUtc: this.disconnectedAtUtc, toUtc: nowUtcIso(), reason: 'reconnect: notifications during the outage were not received' }); this.disconnectedAtUtc = null }
        this.pending.clear(); this.subs.clear(); this.flushSubscribes(); resolve()
      })
      ws.on('message', data => this.onMessage(data.toString()))
      ws.on('error', err => { this.log?.warn('wss_error', { error: err.message }) })
      ws.on('close', async () => {
        this.events.onStatus?.('closed')
        if (this.closed) return
        this.disconnectedAtUtc ??= nowUtcIso(); this.stats.reconnects++
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.7 + Math.random() * 0.6)
        await sleep(wait); if (!this.closed) void this.connect(attempt + 1)
      })
    })
  }
  private flushSubscribes(): void {
    const ws = this.ws; if (!ws || ws.readyState !== WebSocket.OPEN) return
    const subscribed = new Set(this.subs.values()); const pendingKeys = new Set(this.pending.values())
    for (const pk of this.wanted) {
      if (subscribed.has(pk) || pendingKeys.has(pk)) continue
      const id = this.nextId++; this.pending.set(id, pk)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'accountSubscribe', params: [pk, { encoding: 'base64', commitment: this.commitment }] }))
    }
  }
  private onMessage(raw: string): void {
    let m: { id?: number; result?: unknown; method?: string; params?: { subscription: number; result: { context: { slot: number }; value: { data: [string, string]; owner: string; lamports: number; executable: boolean } } } }
    try { m = JSON.parse(raw) } catch { this.stats.dropped++; return }
    if (m.id !== undefined && this.pending.has(m.id)) { const pk = this.pending.get(m.id)!; this.pending.delete(m.id); if (typeof m.result === 'number') this.subs.set(m.result, pk); return }
    if (m.method !== 'accountNotification' || !m.params) return
    const pk = this.subs.get(m.params.subscription); if (!pk) { this.stats.dropped++; return }
    const v = m.params.result.value; const slot = m.params.result.context.slot
    const data = new Uint8Array(Buffer.from(v.data[0], 'base64'))
    const identity = sha256Hex(`${pk}|${slot}|${sha256Hex(data)}`)
    if (this.seen.has(identity)) { this.stats.duplicates++; return }
    this.seen.add(identity); this.seenOrder.push(identity)
    if (this.seenOrder.length > this.maxQueue) { const old = this.seenOrder.shift()!; this.seen.delete(old) }
    this.stats.notifications++
    const account: RawAccount = { pubkey: new PublicKey(pk), data, owner: new PublicKey(v.owner), lamports: BigInt(v.lamports), executable: v.executable, contextSlot: slot, receivedAtUtc: nowUtcIso(), receivedMonoMs: monoMs(), batchId: `wss:${m.params.subscription}:${slot}`, provider: 'wss_account' }
    this.events.onAccount({ account, subscriptionId: m.params.subscription, identity })
  }
}
