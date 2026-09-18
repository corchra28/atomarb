import WebSocket from 'ws'
import { PublicKey } from '@solana/web3.js'
import { monoMs, nowUtcIso } from '../util/time.js'
import { sha256Hex } from '../util/hash.js'
import type { RawAccount } from '../adapters/types.js'
import type { JsonlLogger } from '../telemetry/log.js'
export interface AccountNotification {
  account: RawAccount
  subscriptionId: number
  /** hash of (pubkey, slot, data) for dedup */ identity: string
  /** manager revision at the moment this notification was accepted; strictly increasing, never reused (see revisionOf) */ revision: number
}
export interface WssEvents { onAccount: (n: AccountNotification) => void; onGap: (gap: { fromUtc: string; toUtc: string; reason: string }) => void; onStatus?: ((s: string) => void) | undefined }
export interface WssOptions {
  /** start() gives up after this long without a single successful open, stops the manager and rejects (0 or Infinity = wait forever). Default 20_000. */
  startTimeoutMs?: number
  /** first reconnect backoff step, doubled per consecutive failed attempt and capped at maxBackoffMs. Default 1000. */
  retryBaseMs?: number
  /** backoff cap. Default 30_000. */
  maxBackoffMs?: number
  /** per-attempt handshake timeout handed to ws. Default 15_000. */
  handshakeTimeoutMs?: number
}
export type WssStartCode = 'WSS_START_STOPPED' | 'WSS_START_TIMEOUT' | 'WSS_START_FAILED'
/** start() never hangs: when it cannot open it rejects with one of the explicit codes above. */
export class WssStartFailed extends Error {
  constructor(readonly code: WssStartCode, message: string) { super(message); this.name = 'WssStartFailed' }
}
/**
 * accountSubscribe manager: bounded queue, dedup on (pubkey, slot, data-hash), reconnect with backoff + full resubscribe,
 * and explicit GAP marking between disconnect and successful resubscribe. Never sends anything but subscribe/unsubscribe.
 *
 * Lifecycle (F3): start/retry/stop share ONE lifecycle and ONE promise. start() settles on the first successful open of
 * ANY attempt (not only the first attempt), and also settles when stop() is called or the start timeout elapses, so the
 * caller can never be left awaiting a promise that nobody will settle.
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
  private startPromise: Promise<'open'> | null = null
  private settle: ((err: WssStartFailed | null) => void) | null = null
  private startTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private revision = 0
  private readonly keyRevisions = new Map<string, number>()
  private readonly dirtyKeys = new Set<string>()
  readonly stats = { notifications: 0, duplicates: 0, dropped: 0, reconnects: 0, gaps: 0, connectFailures: 0 }
  constructor(private readonly url: string, private readonly commitment: string, private readonly events: WssEvents, private readonly log?: JsonlLogger, private readonly maxQueue = 5000, private readonly opts: WssOptions = {}) {}
  /** True while a socket is open (a reconnect window reads false). */
  get connected(): boolean { return this.ws !== null && this.ws.readyState === WebSocket.OPEN }
  subscribe(pubkeys: PublicKey[]): void { for (const p of pubkeys) this.wanted.add(p.toBase58()); if (this.ws && this.ws.readyState === WebSocket.OPEN) this.flushSubscribes() }
  /**
   * Opens the socket and resolves on the first successful open of any attempt. Rejects with WSS_START_TIMEOUT (the
   * manager stops itself: no retry loop is left running behind a caller that gave up) or WSS_START_STOPPED if stop()
   * is called while the handshake is still pending. Calling start() twice returns the same promise.
   */
  start(opts: { timeoutMs?: number } = {}): Promise<'open'> {
    if (this.startPromise) return this.startPromise
    this.closed = false
    const p = new Promise<'open'>((resolve, reject) => {
      this.settle = (err: WssStartFailed | null) => {
        if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null }
        this.settle = null
        if (err) reject(err); else resolve('open')
      }
    })
    p.catch(() => {})   // the caller still sees the rejection; this only keeps an ignored start() from crashing the process
    this.startPromise = p
    const timeoutMs = opts.timeoutMs ?? this.opts.startTimeoutMs ?? 20_000
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      this.startTimer = setTimeout(() => {
        this.settleStart(new WssStartFailed('WSS_START_TIMEOUT', `websocket did not open within ${timeoutMs}ms (${this.stats.connectFailures} failed attempts)`))
        this.stop()   // after settle(), so the timeout code is the one the caller sees
      }, timeoutMs)
    }
    try { this.openSocket(0) } catch (e) {
      this.settleStart(new WssStartFailed('WSS_START_FAILED', (e as Error).message)); this.stop()
    }
    return p
  }
  /** Idempotent: closes the socket, cancels the pending retry, and settles a start() that never opened. */
  stop(): void {
    this.closed = true
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    this.settleStart(new WssStartFailed('WSS_START_STOPPED', 'stop() was called before the websocket opened'))
    const ws = this.ws; this.ws = null
    if (ws) { try { ws.close() } catch { /* already closing */ } }
    this.startPromise = null   // a later start() begins a fresh lifecycle
  }
  private settleStart(err: WssStartFailed | null): void { this.settle?.(err) }   // no-op once settled: exactly one settlement per lifecycle
  /** Keys touched since the last drain, returned and cleared in the same synchronous step (nothing can be lost in between). */
  drainDirty(): string[] { const keys = [...this.dirtyKeys]; this.dirtyKeys.clear(); return keys }
  /** Number of keys currently marked dirty, without clearing. */
  get dirtyCount(): number { return this.dirtyKeys.size }
  /** Global revision, bumped once per accepted notification. Strictly increasing. */
  get currentRevision(): number { return this.revision }
  /** Revision of one account key (0 = never seen). Capture it BEFORE processing a route: a larger value afterwards means a notification arrived while the route was being processed. */
  revisionOf(pubkey: string): number { return this.keyRevisions.get(pubkey) ?? 0 }
  /** Highest revision over a set of keys (e.g. the vaults of one route). */
  maxRevisionOf(pubkeys: Iterable<string>): number { let max = 0; for (const k of pubkeys) { const r = this.keyRevisions.get(k) ?? 0; if (r > max) max = r } return max }
  private openSocket(attempt: number): void {
    if (this.closed) return
    let sawOpen = false
    const ws = new WebSocket(this.url, { handshakeTimeout: this.opts.handshakeTimeoutMs ?? 15_000 })
    this.ws = ws
    ws.on('open', () => {
      if (this.closed) { ws.close(); return }
      sawOpen = true
      this.events.onStatus?.('open')
      if (this.disconnectedAtUtc) { this.stats.gaps++; this.events.onGap({ fromUtc: this.disconnectedAtUtc, toUtc: nowUtcIso(), reason: 'reconnect: notifications during the outage were not received' }); this.disconnectedAtUtc = null }
      this.pending.clear(); this.subs.clear(); this.flushSubscribes()
      this.settleStart(null)   // any attempt may be the one that opens; start() settles here
    })
    ws.on('message', data => this.onMessage(data.toString()))
    ws.on('error', err => { this.log?.warn('wss_error', { error: err.message, attempt }) })
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null
      this.events.onStatus?.('closed')
      if (this.closed) return
      if (sawOpen) {
        // an established connection dropped: notifications during the outage are lost -> GAP on the next open
        this.stats.reconnects++; this.disconnectedAtUtc ??= nowUtcIso()
      } else {
        // a handshake that never opened subscribed nothing, so it is a failed attempt and not an outage
        this.stats.connectFailures++
      }
      const next = sawOpen ? 0 : attempt + 1   // a successful open resets the backoff
      const base = Math.min(this.opts.maxBackoffMs ?? 30_000, (this.opts.retryBaseMs ?? 1000) * 2 ** Math.min(next, 5))
      const wait = base * (0.7 + Math.random() * 0.6)
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.openSocket(next) }, wait)
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
    // revision is bumped BEFORE the callback so a consumer that reads revisionOf() inside onAccount already sees this update
    this.revision++; this.keyRevisions.set(pk, this.revision); this.dirtyKeys.add(pk)
    const account: RawAccount = { pubkey: new PublicKey(pk), data, owner: new PublicKey(v.owner), lamports: BigInt(v.lamports), executable: v.executable, contextSlot: slot, receivedAtUtc: nowUtcIso(), receivedMonoMs: monoMs(), batchId: `wss:${m.params.subscription}:${slot}`, provider: 'wss_account' }
    this.events.onAccount({ account, subscriptionId: m.params.subscription, identity, revision: this.revision })
  }
}
