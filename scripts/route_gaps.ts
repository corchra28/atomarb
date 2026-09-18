/**
 * One-off, read-only diagnostic: for every route in the shortlist, ONE snapshot (getMultipleAccounts x2 per route), then both circuit directions at
 * sizes 1e5..1e9 lamports. Reports per circuit: pnl in bps at each size, DEX fee bps (sum of fee items in WSOL terms at the smallest size),
 * and the implied pre-fee price gap (pnl_bps + fee_bps at the smallest size, where impact is negligible). Shows how far each route is from break-even.
 * Usage: npx tsx scripts/route_gaps.ts [--max-requests 120] [--max-rps 3]
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { loadConfig, resolveEndpoints } from '../src/config/load.js'
import { RpcClient } from '../src/state/rpc.js'
import { loadAdapters, requireAdapters } from '../src/adapters/registry.js'
import type { AdapterId, PoolRef } from '../src/adapters/types.js'
import { snapshotPools } from '../src/state/snapshot.js'
import { enumerateCircuits, evaluateCircuit } from '../src/routing/circuit.js'
import { JsonlLogger } from '../src/telemetry/log.js'
import { WSOL_MINT } from '../src/state/token.js'
import { jsonReplacer } from '../src/util/bigint.js'
import { positiveIntFlag, exitOnFlagError } from '../src/util/flags.js'
// Explicit flag parsing: a missing flag takes the documented default, a present flag must be a positive integer. `Number(argv[indexOf(flag) + 1] || d)`
// parsed argv[0] (the node binary) when the flag was absent and produced NaN, which disabled the HTTP budget entirely (audit finding F6).
const USAGE = 'usage: npx tsx scripts/route_gaps.ts [--max-requests <positive integer, default 120>] [--max-rps <positive integer, default 3>]'
const args = process.argv.slice(2)
const { maxReq, maxRps } = exitOnFlagError(() => ({
  maxReq: positiveIntFlag(args, '--max-requests', 120),
  maxRps: positiveIntFlag(args, '--max-rps', 3),
}), USAGE)
const { config } = loadConfig('config/config.example.json')
const rpc = new RpcClient(resolveEndpoints(config).httpUrl, { ...config.rpc, maxRequestsPerSecond: maxRps, maxTotalHttpRequests: maxReq }, 'confirmed', new JsonlLogger({ stderr: false }))
const adapters = requireAdapters((await loadAdapters()).adapters)
const sl = JSON.parse(readFileSync('data/discovery/shortlist.json', 'utf8')) as { adapter: AdapterId; address: string; mint: string }[]
const byMint = new Map<string, PoolRef[]>()
for (const p of sl) { const a = byMint.get(p.mint) ?? []; a.push({ adapter: p.adapter, address: new PublicKey(p.address), source: { kind: 'shortlist', ref: 'data/discovery/shortlist.json', observedAtUtc: new Date().toISOString() } }); byMint.set(p.mint, a) }
const SIZES = [100_000n, 1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n]
const rows: Record<string, unknown>[] = []
for (const [mint, refs] of byMint) {
  if (refs.length < 2) continue
  let snap
  try { snap = await snapshotPools(rpc, adapters, refs, { requireSingleBatch: true }) } catch (e) { rows.push({ mint, error: (e as Error).message }); break }
  const decoded = snap.outcomes.filter(o => o.status === 'OK' && o.decoded).map(o => o.decoded!)
  for (const c of enumerateCircuits(decoded)) {
    const pts = SIZES.map(s => { const r = evaluateCircuit(adapters, c, s); return r.ok ? { size: s, pnl: r.value.pnl.pnl, bps: Number((r.value.pnl.pnl * 1_000_000n) / s) / 100, legAFeesWsol: r.value.quoteA.fees.filter(f => f.mint.equals(WSOL_MINT)).reduce((x, f) => x + f.amount, 0n), legBFeesWsol: r.value.quoteB.fees.filter(f => f.mint.equals(WSOL_MINT)).reduce((x, f) => x + f.amount, 0n), legBOut: r.value.quoteB.amountOutToUser } : { size: s, reject: r.reason } })
    const p0 = pts[0] as { size: bigint; bps?: number; legAFeesWsol?: bigint; legBFeesWsol?: bigint; legBOut?: bigint }
    // WSOL-denominated DEX fees at the smallest size: leg A fees on WSOL input + leg B fees on WSOL output (token-side fees are not converted and are reported as not included)
    const feeBps = p0.bps !== undefined ? Number(((p0.legAFeesWsol! + p0.legBFeesWsol!) * 1_000_000n) / p0.size) / 100 : null
    const best = pts.filter((p): p is typeof p & { bps: number } => 'bps' in p && typeof (p as { bps?: number }).bps === 'number').sort((a, b) => b.bps - a.bps)[0]
    const wsolReserve = (d: typeof c.poolA): bigint => (d.mintA.mint.equals(WSOL_MINT) ? d.reserveA : d.reserveB)
    const tokenReserve = (d: typeof c.poolA): bigint => (d.mintA.mint.equals(WSOL_MINT) ? d.reserveB : d.reserveA)
    rows.push({ mint, circuit: c.id, category: c.category,
      entryPoolWsolLamports: wsolReserve(c.poolA), exitPoolWsolLamports: wsolReserve(c.poolB),
      minSideWsolSol: Number(wsolReserve(c.poolA) < wsolReserve(c.poolB) ? wsolReserve(c.poolA) : wsolReserve(c.poolB)) / 1e9,
      entryPoolTokenReserve: tokenReserve(c.poolA), exitPoolTokenReserve: tokenReserve(c.poolB), slot: snap.bundle?.maxSlot, singleBatch: snap.bundle?.singleBatch, pnlBpsBySize: Object.fromEntries(pts.map(p => [String(p.size), 'bps' in p ? p.bps : (p as { reject: string }).reject])), bestBps: best?.bps ?? null, wsolSideFeeBpsAtSmallest: feeBps, impliedPreFeeGapBps: p0.bps !== undefined && feeBps !== null ? Math.round((p0.bps + feeBps) * 100) / 100 : null })
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync('reports', { recursive: true })
const sides = rows.map(r => r['minSideWsolSol']).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
const summary = { generatedUtc: new Date().toISOString(), rpcRequests: rpc.usage.total, httpBudget: maxReq, maxRps, circuits: rows.filter(r => 'circuit' in r).length,
  minSideWsolSol: { min: sides[0] ?? null, median: sides.length ? sides[Math.floor(sides.length / 2)] : null, max: sides[sides.length - 1] ?? null }, positiveAtAnySize: rows.filter(r => typeof r['bestBps'] === 'number' && (r['bestBps'] as number) > 0).length, bestBps: Math.max(...rows.map(r => (typeof r['bestBps'] === 'number' ? (r['bestBps'] as number) : -1e9))), note: 'QUOTE_ONLY diagnostic from one snapshot per route; fee bps count only WSOL-side fee items (token-side fees are embedded in the pnl but not in this column); implied gap = pnl_bps + wsol_fee_bps at 1e5 lamports.' }
writeFileSync(`reports/route_gaps_${stamp}.json`, JSON.stringify({ summary, rows }, jsonReplacer, 1))
const md = ['# Route gaps (QUOTE_ONLY)', '', '```', JSON.stringify(summary, jsonReplacer, 1), '```', '', '| category | circuit (A>B) | min side WSOL | best bps | pnl bps @1e5 | @1e7 | @1e9 | wsol fee bps | implied gap bps |', '|---|---|---|---|---|---|---|---|---|',
  ...rows.filter(r => 'circuit' in r).sort((a, b) => ((b['bestBps'] as number) ?? -1e9) - ((a['bestBps'] as number) ?? -1e9)).map(r => { const p = r['pnlBpsBySize'] as Record<string, unknown>; const cid = String(r['circuit']).replace(/(raydium_cpmm|pumpswap):(\w{6})\w+/g, '$1:$2..'); return `| ${r['category']} | ${cid} | ${typeof r['minSideWsolSol'] === 'number' ? (r['minSideWsolSol'] as number).toFixed(4) : '?'} | ${r['bestBps']} | ${p['100000']} | ${p['10000000']} | ${p['1000000000']} | ${r['wsolSideFeeBpsAtSmallest']} | ${r['impliedPreFeeGapBps']} |` })]
writeFileSync(`reports/route_gaps_${stamp}.md`, md.join('\n'))
console.log(md.slice(0, 40).join('\n'))
