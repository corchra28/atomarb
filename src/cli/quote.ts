import type { LoadedConfig } from '../config/load.js'
import { resolveEndpoints } from '../config/load.js'
import type { JsonlLogger } from '../telemetry/log.js'
import { RpcClient } from '../state/rpc.js'
import { loadAdapters, requireAdapters } from '../adapters/registry.js'
import { snapshotPools } from '../state/snapshot.js'
import { enumerateCircuits, evaluateCircuit, sizeCircuit } from '../routing/circuit.js'
import { parsePoolsFlag, printBlock, fmtLamports } from './common.js'
import { WSOL_MINT } from '../state/token.js'
import { isUnsupported } from '../adapters/types.js'
import { quoteSummary } from '../simulation/probe.js'
/** quote --pools <a>,<b> --amount <lamports> [--sizing]: QUOTE_ONLY evidence from ONE snapshot (single getMultipleAccounts when the dependents fit in 100 keys). */
export async function quote(loaded: LoadedConfig, flags: Record<string, string | true>, log: JsonlLogger): Promise<number> {
  const { config } = loaded
  const pools = parsePoolsFlag(flags['pools'])
  const amount = BigInt(typeof flags['amount'] === 'string' ? flags['amount'] : '10000000')
  const { adapters: loadedAdapters, missing } = await loadAdapters()
  if (missing.length) { for (const m of missing) console.error(`ADAPTER_MISSING ${m.id}: ${m.error}`) }
  const adapters = requireAdapters(loadedAdapters)
  const ep = resolveEndpoints(config)
  const rpc = new RpcClient(ep.httpUrl, config.rpc, config.rpc.commitment, log)
  const snap = await snapshotPools(rpc, adapters, pools, { requireSingleBatch: false })
  const decoded = []
  for (const o of snap.outcomes) {
    printBlock(`pool ${o.pool.adapter}:${o.pool.address.toBase58()}`, [['status', o.status], ['reasons', o.reasons], ['warnings', o.warnings], ...(o.decoded ? [['reserveA', `${o.decoded.mintA.mint.toBase58().slice(0, 8)}.. ${o.decoded.reserveA}`] as [string, unknown], ['reserveB', `${o.decoded.mintB.mint.toBase58().slice(0, 8)}.. ${o.decoded.reserveB}`] as [string, unknown], ['snapshot', o.decoded.snapshot] as [string, unknown], ['layout', o.decoded.layoutVersion] as [string, unknown]] : [])])
    if (o.status === 'OK' && o.decoded) decoded.push(o.decoded)
  }
  // single-leg quotes both directions
  for (const p of decoded) {
    const other = p.mintA.mint.equals(WSOL_MINT) ? p.mintB.mint : p.mintA.mint
    const q1 = adapters[p.adapter].quoteExactIn(p, WSOL_MINT, amount)
    printBlock(`leg WSOL->token on ${p.address.toBase58().slice(0, 8)}`, [['quote', isUnsupported(q1) ? `${q1.code}: ${q1.reason}` : quoteSummary(q1)]])
    if (!isUnsupported(q1) && q1.amountOutToUser > 0n) {
      const q2 = adapters[p.adapter].quoteExactIn(adapters[p.adapter].applySwap(p, q1) as typeof p, other, q1.amountOutToUser)
      printBlock(`same-pool roundtrip token->WSOL (after applySwap)`, [['quote', isUnsupported(q2) ? `${q2.code}: ${q2.reason}` : quoteSummary(q2)], ['roundtrip_pnl', isUnsupported(q2) ? 'n/a' : fmtLamports(q2.amountOutToUser - amount)]])
    }
  }
  const circuits = enumerateCircuits(decoded)
  if (circuits.length === 0) { console.log('NO_CIRCUIT: need >= 2 valid pools sharing the same token and quoted in WSOL'); return decoded.length ? 0 : 1 }
  for (const c of circuits) {
    const r = evaluateCircuit(adapters, c, amount)
    const rows: [string, unknown][] = [['category', c.category], ['amount_in', fmtLamports(amount)]]
    if (r.ok) rows.push(['legA', quoteSummary(r.value.quoteA)], ['legB', quoteSummary(r.value.quoteB)], ['trading_pnl', fmtLamports(r.value.pnl.pnl)], ['evidence', 'QUOTE_ONLY'])
    else rows.push(['reject', r.reason])
    if (flags['sizing']) {
      const s = sizeCircuit(adapters, c, config.sizing.grid.map(BigInt), BigInt(config.sizing.maxCapitalLamports), config.sizing.refineSteps)
      rows.push(['sizing_best', s.best ? { amountIn: s.best.amountIn, pnl: fmtLamports(s.best.pnl.pnl) } : 'ZERO_TRADE (no positive size)'], ['sizing_points', s.evaluated.length])
    }
    printBlock(`circuit ${c.id}`, rows)
  }
  printBlock('rpc usage', [['requests', rpc.usage.total], ['errors', rpc.usage.errors]])
  return 0
}
