import { PublicKey } from '@solana/web3.js'
import type { AdapterId, DecodedPool, PoolAdapter, Quote } from '../adapters/types.js'
import { isUnsupported } from '../adapters/types.js'
import { WSOL_MINT } from '../state/token.js'
import { tradingPnl } from '../accounting/pnl.js'
import type { TradingPnl } from '../accounting/types.js'

export interface Circuit {
  /** the intermediate token */
  token: PublicKey
  /** leg A: WSOL -> token */
  poolA: DecodedPool
  /** leg B: token -> WSOL */
  poolB: DecodedPool
  category: 'cross_adapter' | 'same_adapter'
  id: string
}
/** Every ordered pair of DISTINCT pools that share the same token mint and quote in WSOL. Both directions are produced. */
export function enumerateCircuits(pools: DecodedPool[]): Circuit[] {
  const byToken = new Map<string, DecodedPool[]>()
  for (const p of pools) {
    const token = p.mintA.mint.equals(WSOL_MINT) ? p.mintB.mint : (p.mintB.mint.equals(WSOL_MINT) ? p.mintA.mint : null)
    if (!token) continue
    const k = token.toBase58(); const arr = byToken.get(k) ?? []; arr.push(p); byToken.set(k, arr)
  }
  const out: Circuit[] = []
  for (const [k, arr] of byToken) {
    // dedup by pool address
    const uniq = new Map<string, DecodedPool>(); for (const p of arr) uniq.set(p.address.toBase58(), p)
    const list = [...uniq.values()]
    for (const a of list) for (const b of list) {
      if (a.address.equals(b.address)) continue
      out.push({ token: new PublicKey(k), poolA: a, poolB: b, category: a.adapter === b.adapter ? 'same_adapter' : 'cross_adapter', id: `${a.adapter}:${a.address.toBase58()}>${b.adapter}:${b.address.toBase58()}` })
    }
  }
  return out
}
export interface CircuitEval { amountIn: bigint; quoteA: Quote; quoteB: Quote; pnl: TradingPnl }
export type CircuitResult = { ok: true; value: CircuitEval } | { ok: false; reason: string }
/** Evaluates one circuit at one size. Leg B input is EXACTLY leg A's output to the user (no pre-existing inventory). Pure. */
export function evaluateCircuit(adapters: Record<AdapterId, PoolAdapter>, c: Circuit, amountIn: bigint): CircuitResult {
  if (amountIn <= 0n) return { ok: false, reason: 'ZERO_TRADE' }
  const A = adapters[c.poolA.adapter], B = adapters[c.poolB.adapter]
  const qa = A.quoteExactIn(c.poolA, WSOL_MINT, amountIn)
  if (isUnsupported(qa)) return { ok: false, reason: `LEG_A_${qa.code}: ${qa.reason}` }
  if (qa.rejectReasons.length) return { ok: false, reason: `LEG_A_REJECT: ${qa.rejectReasons.join(',')}` }
  if (qa.amountOutToUser <= 0n) return { ok: false, reason: 'LEG_A_ZERO_OUT' }
  const qb = B.quoteExactIn(c.poolB, c.token, qa.amountOutToUser)
  if (isUnsupported(qb)) return { ok: false, reason: `LEG_B_${qb.code}: ${qb.reason}` }
  if (qb.rejectReasons.length) return { ok: false, reason: `LEG_B_REJECT: ${qb.rejectReasons.join(',')}` }
  return { ok: true, value: { amountIn, quoteA: qa, quoteB: qb, pnl: tradingPnl(WSOL_MINT, qa, qb) } }
}
export interface SizingResult {
  best: CircuitEval | null   // null == zero-trade is optimal (no positive size found)
  evaluated: { amountIn: bigint; pnl: bigint | null; reason?: string | undefined }[]
  zeroTradeChosen: boolean
}
/**
 * Deterministic grid, then bounded local refinement around the best grid point. Does NOT assume unimodality: the answer is the best of ALL evaluated points,
 * and zero-trade (pnl 0) is always a candidate. Sizes are capped at maxCapital.
 */
export function sizeCircuit(adapters: Record<AdapterId, PoolAdapter>, c: Circuit, grid: bigint[], maxCapital: bigint, refineSteps: number): SizingResult {
  const evaluated: SizingResult['evaluated'] = []
  const cache = new Map<bigint, CircuitResult>()
  const ev = (x: bigint): CircuitResult => {
    if (x > maxCapital) return { ok: false, reason: 'ABOVE_MAX_CAPITAL' }
    let r = cache.get(x); if (!r) { r = evaluateCircuit(adapters, c, x); cache.set(x, r); evaluated.push(r.ok ? { amountIn: x, pnl: r.value.pnl.pnl } : { amountIn: x, pnl: null, reason: r.reason }) }
    return r
  }
  const sizes = [...new Set(grid.filter(g => g > 0n && g <= maxCapital))].sort((a, b) => (a < b ? -1 : 1))
  let best: CircuitEval | null = null
  const consider = (r: CircuitResult) => { if (r.ok && r.value.pnl.pnl > 0n && (!best || r.value.pnl.pnl > best.pnl.pnl)) best = r.value }
  for (const s of sizes) consider(ev(s))
  if (best) {
    // refine between the neighbours of the best grid point (ternary-style shrink), bounded by refineSteps
    const bi = sizes.findIndex(s => s === (best as CircuitEval).amountIn)
    let lo = bi > 0 ? sizes[bi - 1]! : (best as CircuitEval).amountIn / 2n
    let hi = bi < sizes.length - 1 ? sizes[bi + 1]! : ((best as CircuitEval).amountIn * 2n > maxCapital ? maxCapital : (best as CircuitEval).amountIn * 2n)
    for (let i = 0; i < refineSteps && hi - lo > 1n; i++) {
      const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n
      const r1 = ev(m1), r2 = ev(m2); consider(r1); consider(r2)
      const p1 = r1.ok ? r1.value.pnl.pnl : -(1n << 120n), p2 = r2.ok ? r2.value.pnl.pnl : -(1n << 120n)
      if (p1 < p2) lo = m1; else hi = m2
    }
  }
  return { best, evaluated, zeroTradeChosen: best === null }
}
