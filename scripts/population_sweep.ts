/**
 * Full-population sweep with a private endpoint: every mint that has two or more eligible pools, one atomic snapshot each, both directions,
 * the whole sizing grid plus the bounded refinement — i.e. the same decision the scanner makes, but once per route instead of repeatedly.
 * Read-only, bounded by --max-requests. Usage: npx tsx scripts/population_sweep.ts [--max-requests 4000] [--max-rps 20] [--amount-grid ...]
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { loadConfig, resolveEndpoints } from '../src/config/load.js'
import { RpcClient } from '../src/state/rpc.js'
import { loadAdapters, requireAdapters } from '../src/adapters/registry.js'
import type { AdapterId, PoolRef } from '../src/adapters/types.js'
import { snapshotPools } from '../src/state/snapshot.js'
import { enumerateCircuits, sizeCircuit, evaluateCircuit, filterByMinQuoteReserve } from '../src/routing/circuit.js'
import { JsonlLogger } from '../src/telemetry/log.js'
import { WSOL_MINT } from '../src/state/token.js'
import { jsonReplacer } from '../src/util/bigint.js'
import { positiveIntFlag } from '../src/util/flags.js'
import { nowUtcIso, monoMs } from '../src/util/time.js'
const argv = process.argv
const maxReq = positiveIntFlag(argv, '--max-requests', 4000)
const maxRps = positiveIntFlag(argv, '--max-rps', 20)
const configPath = 'config/config.fast.example.json'
const { config } = loadConfig(configPath)
const rpc = new RpcClient(resolveEndpoints(config).httpUrl, { ...config.rpc, maxRequestsPerSecond: maxRps, maxTotalHttpRequests: maxReq }, 'confirmed', new JsonlLogger({ stderr: false }))
const adapters = requireAdapters((await loadAdapters()).adapters)
const sl = JSON.parse(readFileSync('data/discovery/shortlist.json', 'utf8')) as { adapter: AdapterId; address: string; mint: string }[]
const byMint = new Map<string, PoolRef[]>()
for (const p of sl) { const a = byMint.get(p.mint) ?? []; a.push({ adapter: p.adapter, address: new PublicKey(p.address), source: { kind: 'shortlist', ref: 'data/discovery/shortlist.json', observedAtUtc: nowUtcIso() } }); byMint.set(p.mint, a) }
const grid = config.sizing.grid.map(BigInt)
const minReserve = BigInt(config.discovery.minQuoteReserveLamports)
const rows: Record<string, unknown>[] = []
const t0 = monoMs()
let groups = 0, thinDropped = 0
for (const [mint, refs] of byMint) {
  if (refs.length < 2) continue
  if (rpc.usage.total + 4 > maxReq) { rows.push({ stopped: 'REQUEST_BUDGET', atGroup: groups }); break }
  let snap
  try { snap = await snapshotPools(rpc, adapters, refs, { requireSingleBatch: true }) } catch (e) { rows.push({ mint, error: (e as Error).message }); break }
  groups++
  const ok = snap.outcomes.filter(o => o.status === 'OK' && o.decoded).map(o => o.decoded!)
  const f = filterByMinQuoteReserve(ok, minReserve)
  thinDropped += f.dropped.length
  for (const c of enumerateCircuits(f.kept)) {
    const s = sizeCircuit(adapters, c, grid, BigInt(config.sizing.maxCapitalLamports), config.sizing.refineSteps)
    const points = s.evaluated.filter(e => e.pnl !== null)
    const best = points.reduce((m, e) => (m === null || e.pnl! > m.pnl! ? e : m), null as typeof points[number] | null)
    const smallest = evaluateCircuit(adapters, c, grid[0]!)
    rows.push({
      mint, circuit: c.id, category: c.category, slot: snap.bundle?.maxSlot, singleBatch: snap.bundle?.singleBatch,
      entryWsol: (c.poolA.mintA.mint.equals(WSOL_MINT) ? c.poolA.reserveA : c.poolA.reserveB),
      exitWsol: (c.poolB.mintA.mint.equals(WSOL_MINT) ? c.poolB.reserveA : c.poolB.reserveB),
      sizesEvaluated: s.evaluated.length, bestAmountIn: best?.amountIn ?? null, bestPnl: best?.pnl ?? null,
      bestBps: best && best.pnl !== null ? Number((best.pnl * 1_000_000n) / best.amountIn) / 100 : null,
      positiveAtAnySize: s.best !== null, pnlAtSmallest: smallest.ok ? smallest.value.pnl.pnl : null,
    })
  }
}
const positives = rows.filter(r => r['positiveAtAnySize'] === true)
const FEE = BigInt(config.costs.baseFeeLamportsPerSignature) + (BigInt(config.costs.computeUnitLimit) * BigInt(config.costs.computeUnitPriceMicroLamports) + 999_999n) / 1_000_000n
const netPositive = positives.filter(r => (r['bestPnl'] as bigint) > FEE)
const summary = {
  generatedUtc: nowUtcIso(), endpoint: 'private (env)', configHash: configPath, groups, thinPoolsDropped: thinDropped,
  circuits: rows.filter(r => 'circuit' in r).length, positiveGrossAtAnySize: positives.length, netPositiveAfterFee: netPositive.length,
  feeLamports: FEE, bestGrossLamports: positives.length ? positives.map(r => r['bestPnl'] as bigint).reduce((a, b) => (b > a ? b : a)) : 0n,
  rpcRequests: rpc.usage.total, rpcErrors: rpc.usage.errors, durationMs: monoMs() - t0,
  note: 'QUOTE_ONLY, one atomic snapshot per mint; the sizing grid plus bounded refinement, i.e. the same decision the scanner makes.',
}
mkdirSync('reports', { recursive: true })
const stamp = nowUtcIso().replace(/[:.]/g, '-')
writeFileSync(`reports/population_sweep_${stamp}.json`, JSON.stringify({ summary, rows }, jsonReplacer, 1))
console.log(JSON.stringify(summary, jsonReplacer, 1))
for (const r of netPositive.slice(0, 10)) console.log('NET POSITIVE:', JSON.stringify(r, jsonReplacer))
