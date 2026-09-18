/**
 * Takes the gap radar's pairs and puts them through the ACTUAL engine: one atomic snapshot per pair, decode, validate, quote both directions over the
 * sizing grid with bounded refinement, then the network cost. The radar's gap is pre-fee and pre-impact; this is what it is really worth.
 * Usage: npx tsx scripts/verify_candidates.ts [--top 40] [--max-requests 300] [--max-rps 8]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PublicKey } from '@solana/web3.js'
import { loadConfig, resolveEndpoints } from '../src/config/load.js'
import { RpcClient } from '../src/state/rpc.js'
import { loadAdapters, requireAdapters } from '../src/adapters/registry.js'
import { snapshotPools } from '../src/state/snapshot.js'
import { enumerateCircuits, sizeCircuit } from '../src/routing/circuit.js'
import { WSOL_MINT } from '../src/state/token.js'
import { isUnsupported } from '../src/adapters/types.js'
import { JsonlLogger } from '../src/telemetry/log.js'
import { positiveIntFlag } from '../src/util/flags.js'
import { nowUtcIso, monoMs } from '../src/util/time.js'
import { jsonReplacer } from '../src/util/bigint.js'
import type { AdapterId, PoolRef } from '../src/adapters/types.js'
const argv = process.argv
const top = positiveIntFlag(argv, '--top', 40)
const { config } = loadConfig('config/config.fast.example.json')
const rpc = new RpcClient(resolveEndpoints(config).httpUrl, { ...config.rpc, maxRequestsPerSecond: positiveIntFlag(argv, '--max-rps', 8), maxTotalHttpRequests: positiveIntFlag(argv, '--max-requests', 300) }, 'confirmed', new JsonlLogger({ stderr: false }))
const adapters = requireAdapters((await loadAdapters()).adapters)
const file = readdirSync('reports').filter(f => f.startsWith('gap_radar_')).sort().pop()!
const radar = JSON.parse(readFileSync(join('reports', file), 'utf8')) as { summary: Record<string, unknown>; pairs: { mint: string; gapBps: number; thinSideSol: number; cheap: { venue: AdapterId; pool: string }; dear: { venue: AdapterId; pool: string } }[] }
const FEE = BigInt(config.costs.baseFeeLamportsPerSignature) + (BigInt(config.costs.computeUnitLimit) * BigInt(config.costs.computeUnitPriceMicroLamports) + 999_999n) / 1_000_000n
const grid = config.sizing.grid.map(BigInt)
const out: Record<string, unknown>[] = []
const t0 = monoMs()
for (const p of radar.pairs.slice(0, top)) {
  const refs: PoolRef[] = [p.cheap, p.dear].map(x => ({ adapter: x.venue, address: new PublicKey(x.pool), source: { kind: 'gap_radar', ref: file, observedAtUtc: nowUtcIso() } }))
  let snap
  try { snap = await snapshotPools(rpc, adapters, refs, { requireSingleBatch: true }) } catch (e) { out.push({ mint: p.mint, error: (e as Error).message }); break }
  const bad = snap.outcomes.filter(o => o.status !== 'OK')
  const decoded = snap.outcomes.filter(o => o.status === 'OK' && o.decoded).map(o => o.decoded!)
  if (decoded.length < 2) { out.push({ mint: p.mint, radarGapBps: p.gapBps, thinSideSol: p.thinSideSol, rejected: bad.map(b => ({ pool: b.pool.address.toBase58(), status: b.status, reasons: b.reasons })) }); continue }
  for (const c of enumerateCircuits(decoded)) {
    // The fee wall of a circuit is the sum of BOTH pools' advertised rates. Reading it from the quote's fee items is wrong: the second leg pays its fee
    // in the intermediate token, so a WSOL-only sum silently reports zero for it. The rates come from the decoded pool parameters instead.
    const feeBpsOfPool = (d: typeof c.poolA): number | null => {
      if (d.adapter === 'raydium_cpmm') {
        const p = d.params as { config?: { tradeFeeRate?: bigint; creatorFeeRate?: bigint }; pool?: { enableCreatorFee?: boolean } }
        if (!p.config?.tradeFeeRate) return null
        const creator = p.pool?.enableCreatorFee ? (p.config.creatorFeeRate ?? 0n) : 0n
        return Number((p.config.tradeFeeRate + creator) / 100n)          // 1e-6 units -> bps
      }
      const p = d.params as { feeSchedule?: { lpBps?: bigint; protocolBps?: bigint; creatorBps?: bigint } }
      const f = p.feeSchedule
      return f ? Number((f.lpBps ?? 0n) + (f.protocolBps ?? 0n) + (f.creatorBps ?? 0n)) : null
    }
    const legAFeeBps = feeBpsOfPool(c.poolA), legBFeeBps = feeBpsOfPool(c.poolB)
    const probe = 1_000_000n
    const qa = adapters[c.poolA.adapter].quoteExactIn(c.poolA, WSOL_MINT, probe)
    const qb = !isUnsupported(qa) && qa.amountOutToUser > 0n ? adapters[c.poolB.adapter].quoteExactIn(c.poolB, c.token, qa.amountOutToUser) : null
    const transferFee = [qa, qb].some(q => q && !isUnsupported(q) && q.fees.some(f => f.name.includes('transfer_fee') && f.amount > 0n))
    const s = sizeCircuit(adapters, c, grid, BigInt(config.sizing.maxCapitalLamports), config.sizing.refineSteps)
    const pts = s.evaluated.filter(e => e.pnl !== null)
    const best = pts.reduce((m, e) => (m === null || e.pnl! > m.pnl! ? e : m), null as typeof pts[number] | null)
    out.push({ mint: p.mint, circuit: c.id, category: c.category, radarGapBps: p.gapBps, thinSideSol: p.thinSideSol, slot: snap.bundle?.maxSlot, singleBatch: snap.bundle?.singleBatch,
      bestAmountIn: best?.amountIn ?? null, bestGross: best?.pnl ?? null, netAfterFee: best?.pnl != null ? best.pnl - FEE : null, positiveNet: best?.pnl != null && best.pnl > FEE,
      legAFeeBps, legBFeeBps, roundTripFeeBps: legAFeeBps !== null && legBFeeBps !== null ? legAFeeBps + legBFeeBps : null, tokenTransferFee: transferFee,
      gapCoversFees: legAFeeBps !== null && legBFeeBps !== null ? p.gapBps > legAFeeBps + legBFeeBps : null,
      rejects: pts.length === 0 ? s.evaluated.slice(0, 2).map(e => e.reason) : [] })
  }
}
const winners = out.filter(r => r['positiveNet'] === true)
const withFees = out.filter(r => r['roundTripFeeBps'] !== null && r['roundTripFeeBps'] !== undefined)
const summary = { generatedUtc: nowUtcIso(), radarFile: file,
  gapBelowFeeWall: withFees.filter(r => r['gapCoversFees'] === false).length, gapAboveFeeWall: withFees.filter(r => r['gapCoversFees'] === true).length,
  withTokenTransferFee: out.filter(r => r['tokenTransferFee'] === true).length,
  medianRoundTripFeeBps: withFees.length ? [...withFees.map(r => r['roundTripFeeBps'] as number)].sort((a, b) => a - b)[Math.floor(withFees.length / 2)] : null, pairsChecked: Math.min(top, radar.pairs.length), circuitsQuoted: out.filter(r => 'circuit' in r).length, feeLamports: FEE,
  positiveNet: winners.length, bestNetLamports: winners.length ? winners.map(w => w['netAfterFee'] as bigint).reduce((a, b) => (b > a ? b : a)) : 0n,
  rejectedPairs: out.filter(r => 'rejected' in r).length, rpcRequests: rpc.usage.total, durationMs: monoMs() - t0 }
writeFileSync(`reports/verify_candidates_${nowUtcIso().replace(/[:.]/g, '-')}.json`, JSON.stringify({ summary, rows: out }, jsonReplacer, 1))
console.log(JSON.stringify(summary, jsonReplacer, 1))
for (const w of winners.sort((a, b) => Number((b['netAfterFee'] as bigint) - (a['netAfterFee'] as bigint))).slice(0, 15)) console.log('POSITIVE NET:', JSON.stringify(w, jsonReplacer))
const rej = out.filter(r => 'rejected' in r).slice(0, 5)
for (const r of rej) console.log('pair rejected by validation:', JSON.stringify(r, jsonReplacer).slice(0, 300))
