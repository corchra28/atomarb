/**
 * Capital ledger for prospective (shadow) probes. Enforces, simultaneously: a per-episode cap, an aggregate open cap, an untouched operating reserve,
 * a concurrency limit, and account conflicts (two pending probes may not touch the same pool or the same intermediate mint).
 * Money is reserved at the decision and released only at settlement; a settled profit is credited ONLY then. A failed attempt costs its network fee.
 * Hypothetical mode (`hypothetical: true`) is the default: settlements never change the capital, they are recorded as independent hypothetical interventions.
 */
import { jsonReplacer } from '../util/bigint.js'

export interface CapitalConfig {
  capitalLamports: bigint
  /** max fraction of current capital per episode (0..1) */
  maxEpisodeFrac: number
  /** max fraction of current capital in open (pending) positions (0..1) */
  maxAggregateOpenFrac: number
  /** fraction of capital that must stay untouched (0..1) */
  reserveFrac: number
  /** max pending probes at once */
  maxConcurrent: number
  /** when true (default) realised PnL does NOT change capital: probes are independent hypotheticals */
  hypothetical?: boolean
}
export interface PendingPosition { id: string; amountIn: bigint; feeBudget: bigint; pools: string[]; mint: string; openedUtc: string }
export type ReserveResult = { ok: true; position: PendingPosition } | { ok: false; code: 'EPISODE_CAP' | 'AGGREGATE_CAP' | 'RESERVE_FLOOR' | 'CONCURRENCY' | 'POOL_CONFLICT' | 'MINT_CONFLICT' | 'DUPLICATE_ID' | 'NON_POSITIVE'; detail: string; budget: bigint }
export interface SettleOutcome { id: string; realisedPnl: bigint; feePaid: bigint; status: 'FILLED' | 'REVERTED' | 'NOT_LANDED' }

export class CapitalLedger {
  private capital: bigint
  private readonly initial: bigint
  private pending = new Map<string, PendingPosition>()
  private lockedAmount = 0n
  readonly journal: Record<string, unknown>[] = []
  readonly stats = { reserved: 0, rejected: 0, settled: 0, filled: 0, reverted: 0, notLanded: 0, feesPaid: 0n, hypotheticalPnl: 0n }
  constructor(readonly cfg: CapitalConfig) {
    if (cfg.maxEpisodeFrac <= 0 || cfg.maxEpisodeFrac > 1 || cfg.maxAggregateOpenFrac <= 0 || cfg.maxAggregateOpenFrac > 1 || cfg.reserveFrac < 0 || cfg.reserveFrac >= 1) throw new Error('CapitalLedger: fractions out of range')
    this.capital = cfg.capitalLamports; this.initial = cfg.capitalLamports
  }
  private frac(x: number): bigint { return (this.capital * BigInt(Math.round(x * 1e6))) / 1_000_000n }
  /** Budget for a NEW position = min(per-episode cap, aggregate cap minus what is already locked, capital minus reserve minus locked). Never negative. */
  budget(): bigint {
    const a = this.frac(this.cfg.maxEpisodeFrac)
    const b = this.frac(this.cfg.maxAggregateOpenFrac) - this.lockedAmount
    const c = this.capital - this.frac(this.cfg.reserveFrac) - this.lockedAmount
    const m = [a, b, c].reduce((x, y) => (y < x ? y : x))
    return m > 0n ? m : 0n
  }
  locked(): bigint { return this.lockedAmount }
  available(): bigint { return this.budget() }
  currentCapital(): bigint { return this.capital }
  realisedNet(): bigint { return this.capital - this.initial }
  openPositions(): PendingPosition[] { return [...this.pending.values()] }
  /** Reserves capital for one probe. `feeBudget` is the network cost that is lost even when the circuit reverts. */
  reserve(p: { id: string; amountIn: bigint; feeBudget: bigint; pools: string[]; mint: string; utc: string }): ReserveResult {
    const budget = this.budget()
    const need = p.amountIn + p.feeBudget
    if (p.amountIn <= 0n) return this.reject('NON_POSITIVE', `amountIn=${p.amountIn}`, budget)
    if (this.pending.has(p.id)) return this.reject('DUPLICATE_ID', p.id, budget)
    if (this.pending.size >= this.cfg.maxConcurrent) return this.reject('CONCURRENCY', `${this.pending.size} pending >= ${this.cfg.maxConcurrent}`, budget)
    for (const q of this.pending.values()) {
      const clash = q.pools.find(x => p.pools.includes(x))
      if (clash) return this.reject('POOL_CONFLICT', `pool ${clash} already used by ${q.id}`, budget)
      if (q.mint === p.mint) return this.reject('MINT_CONFLICT', `mint ${p.mint} already used by ${q.id}`, budget)
    }
    if (need > this.frac(this.cfg.maxEpisodeFrac)) return this.reject('EPISODE_CAP', `need ${need} > episode cap ${this.frac(this.cfg.maxEpisodeFrac)}`, budget)
    if (this.lockedAmount + need > this.frac(this.cfg.maxAggregateOpenFrac)) return this.reject('AGGREGATE_CAP', `locked ${this.lockedAmount} + ${need} > ${this.frac(this.cfg.maxAggregateOpenFrac)}`, budget)
    if (this.lockedAmount + need > this.capital - this.frac(this.cfg.reserveFrac)) return this.reject('RESERVE_FLOOR', `would touch the ${this.cfg.reserveFrac} reserve`, budget)
    const position: PendingPosition = { id: p.id, amountIn: p.amountIn, feeBudget: p.feeBudget, pools: [...p.pools], mint: p.mint, openedUtc: p.utc }
    this.pending.set(p.id, position); this.lockedAmount += need; this.stats.reserved++
    this.journal.push({ event: 'reserve', id: p.id, amountIn: p.amountIn, feeBudget: p.feeBudget, locked: this.lockedAmount, capital: this.capital, utc: p.utc })
    return { ok: true, position }
  }
  private reject(code: Exclude<ReserveResult['ok'] extends true ? never : ReserveResult, { ok: true }>['code'], detail: string, budget: bigint): ReserveResult {
    this.stats.rejected++; this.journal.push({ event: 'reject', code, detail, budget })
    return { ok: false, code, detail, budget }
  }
  /** Settles a pending position. In hypothetical mode capital never changes; only the fee of a failed attempt is accounted separately. */
  settle(o: SettleOutcome & { utc: string }): { ok: boolean; capital: bigint; locked: bigint } {
    const p = this.pending.get(o.id)
    if (!p) throw new Error(`SETTLE_UNKNOWN_POSITION ${o.id}`)
    this.pending.delete(o.id); this.lockedAmount -= p.amountIn + p.feeBudget
    if (this.lockedAmount < 0n) throw new Error('LEDGER_INVARIANT: negative locked')
    this.stats.settled++; this.stats.feesPaid += o.feePaid
    if (o.status === 'FILLED') this.stats.filled++; else if (o.status === 'REVERTED') this.stats.reverted++; else this.stats.notLanded++
    const hypothetical = this.cfg.hypothetical !== false
    if (hypothetical) this.stats.hypotheticalPnl += o.realisedPnl - o.feePaid
    else this.capital += (o.status === 'FILLED' ? o.realisedPnl : 0n) - o.feePaid
    this.journal.push({ event: 'settle', id: o.id, status: o.status, realisedPnl: o.realisedPnl, feePaid: o.feePaid, hypothetical, capital: this.capital, locked: this.lockedAmount, utc: o.utc })
    return { ok: true, capital: this.capital, locked: this.lockedAmount }
  }
  snapshot(): Record<string, unknown> {
    return { capital: this.capital, initial: this.initial, realisedNet: this.realisedNet(), locked: this.lockedAmount, budget: this.budget(), pending: this.openPositions(), stats: { ...this.stats }, hypothetical: this.cfg.hypothetical !== false, note: 'hypothetical mode: probe PnLs are independent interventions and are NOT a portfolio' }
  }
  toJSON(): string { return JSON.stringify(this.snapshot(), jsonReplacer) }
}
