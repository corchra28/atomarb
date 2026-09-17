import { PublicKey } from '@solana/web3.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LoadedConfig } from '../config/load.js'
import { resolveEndpoints } from '../config/load.js'
import type { JsonlLogger } from '../telemetry/log.js'
import { RpcClient } from '../state/rpc.js'
import { loadAdapters, requireAdapters } from '../adapters/registry.js'
import { snapshotPools } from '../state/snapshot.js'
import { enumerateCircuits, evaluateCircuit } from '../routing/circuit.js'
import { parsePoolsFlag, printBlock, fmtLamports } from './common.js'
import { buildDirectCircuitTx, mainnetSimulate, localProbe, localProbeExecutor, userAccountsFor } from '../simulation/probe.js'
import { nowUtcIso } from '../util/time.js'
import { jsonReplacer } from '../util/bigint.js'
/**
 * simulate --pools <a>,<b> --amount <lamports> [--direction 0|1] [--no-mainnet] [--no-local] [--identity <pubkey>]
 * Builds the DIRECT two-swap v0 transaction for the exact route, inspects it, runs MAINNET_RPC_SIMULATION (sigVerify=false; identity = SIM_IDENTITY_PUBKEY or a fresh unfunded key — never funded by us)
 * and LOCAL_REAL_PROGRAM_SIMULATION (real ELFs + real accounts + synthetic user balances, exact deltas). Nothing is broadcast.
 */
export async function simulate(loaded: LoadedConfig, flags: Record<string, string | true>, log: JsonlLogger): Promise<number> {
  const { config } = loaded
  const pools = parsePoolsFlag(flags['pools'])
  const amount = BigInt(typeof flags['amount'] === 'string' ? flags['amount'] : '10000000')
  const { adapters: la, missing } = await loadAdapters(); for (const m of missing) console.error(`ADAPTER_MISSING ${m.id}: ${m.error}`)
  const adapters = requireAdapters(la)
  const ep = resolveEndpoints(config)
  const rpc = new RpcClient(ep.httpUrl, config.rpc, config.rpc.commitment, log)
  const snap = await snapshotPools(rpc, adapters, pools, { requireSingleBatch: true })
  const decoded = snap.outcomes.filter(o => o.status === 'OK' && o.decoded).map(o => o.decoded!)
  for (const o of snap.outcomes) if (o.status !== 'OK') console.error(`POOL ${o.pool.address.toBase58()} ${o.status}: ${o.reasons.join('; ')}`)
  const circuits = enumerateCircuits(decoded)
  if (!circuits.length) { console.error('NO_CIRCUIT'); return 1 }
  const dir = typeof flags['direction'] === 'string' ? Number(flags['direction']) : 0
  const c = circuits[dir] ?? circuits[0]!
  const ev = evaluateCircuit(adapters, c, amount)
  if (!ev.ok) { console.error(`QUOTE_REJECT ${ev.reason}`); return 1 }
  const identityStr = typeof flags['identity'] === 'string' ? flags['identity'] : process.env['SIM_IDENTITY_PUBKEY']
  const identity = identityStr ? new PublicKey(identityStr) : PublicKey.unique()
  const ua = userAccountsFor(identity, c)
  const bh = await rpc.getLatestBlockhash()
  const direct = buildDirectCircuitTx(adapters, c, ev.value, ua, bh.value.blockhash, config.costs)
  const out: Record<string, unknown> = { generatedUtc: nowUtcIso(), circuit: c.id, category: c.category, amountIn: amount, quote: { legA: { in: ev.value.quoteA.amountIn, out: ev.value.quoteA.amountOutToUser, fees: ev.value.quoteA.fees }, legB: { in: ev.value.quoteB.amountIn, out: ev.value.quoteB.amountOutToUser, fees: ev.value.quoteB.fees }, tradingPnl: ev.value.pnl.pnl, stateHashA: c.poolA.stateHash, stateHashB: c.poolB.stateHash, snapshot: { minSlot: Math.min(c.poolA.snapshot.minSlot, c.poolB.snapshot.minSlot), maxSlot: Math.max(c.poolA.snapshot.maxSlot, c.poolB.snapshot.maxSlot), singleBatch: c.poolA.snapshot.singleBatch && c.poolB.snapshot.singleBatch && c.poolA.snapshot.batchIds[0] === c.poolB.snapshot.batchIds[0] } }, tx: { inspection: direct.built.inspection, messageHash: direct.built.messageHash, limitation: direct.limitation }, identity: { pubkey: identity.toBase58(), source: identityStr ? 'provided' : 'fresh_unfunded_random', funded: 'UNKNOWN (never funded by this tool)' } }
  printBlock('route', [['circuit', c.id], ['category', c.category], ['amount_in', fmtLamports(amount)], ['legA_out', ev.value.quoteA.amountOutToUser], ['legB_out', fmtLamports(ev.value.quoteB.amountOutToUser)], ['trading_pnl', fmtLamports(ev.value.pnl.pnl)], ['snapshot_single_batch', (out['quote'] as { snapshot: { singleBatch: boolean } }).snapshot.singleBatch]])
  printBlock('transaction', [['bytes', direct.built.serializedBytes], ['within_1232', direct.built.inspection.withinSizeLimit], ['signatures', direct.built.inspection.numSignatures], ['static_accounts', direct.built.inspection.staticAccounts.length], ['cu_limit', direct.built.inspection.computeUnitLimit], ['cu_price', direct.built.inspection.computeUnitPriceMicroLamports], ['instructions', direct.built.inspection.instructions.map(i => `${i.programId.slice(0, 8)}..:${i.discriminatorHex}:${i.accounts.length}acc`)], ['limitation', direct.limitation]])
  if (!flags['no-mainnet']) {
    const m = await mainnetSimulate(rpc, direct, ua)
    out['mainnet'] = m
    printBlock('MAINNET_RPC_SIMULATION', [['context_slot', m.contextSlot], ['err', m.err ?? null], ['err_detail', m.errDetail], ['err_class', m.errClass], ['units_consumed', m.unitsConsumed], ['fee_for_message', m.feeForMessageLamports], ['post_balances', m.postBalances], ['duration_ms', m.durationMs], ['logs_tail', m.logs.slice(-6)]])
  }
  if (!flags['no-local']) {
    try {
      const l = await localProbe(rpc, adapters, c, ev.value, config.costs)
      out['local'] = l
      printBlock('LOCAL_REAL_PROGRAM_SIMULATION', [['ok', l.ok], ['err', l.err], ['units', l.unitsConsumed], ['deltas', l.deltas], ['quoted', l.quoted], ['realised', l.realised], ['accounting', l.accounting.status], ['pnl_after_external', l.accounting.pnlAfterExternal], ['external_costs', l.accounting.externalCosts.map(x => `${x.name}=${x.amount}(${x.status})`)], ['synthetic', l.synthetic.length], ['programs', l.loadedPrograms], ['accounts_loaded', l.accountsLoaded], ['missing_on_chain', l.accountsMissingOnChain], ['snapshot', l.snapshot], ['logs_tail', l.logs.slice(-8)]])
    } catch (e) { out['local'] = { error: (e as Error).message }; console.error(`LOCAL_PROBE_ERROR ${(e as Error).message}`) }
  }
  if (!flags['no-local'] && !flags['no-executor']) {
    try {
      const x = await localProbeExecutor(rpc, adapters, c, ev.value, config.costs)
      out['executor'] = x
      printBlock('LOCAL_REAL_PROGRAM_SIMULATION + ARB_EXECUTOR guard (local build, NOT deployed)', [['executor_sha256', x.executorSha256.slice(0, 16)], ['tx_bytes', x.txBytes], ['used_alt', x.usedAlt], ['verdict', x.verdict], ...x.runs.map((r, i) => [`run${i}_min_profit=${r.minProfit}`, { ok: r.ok, executorError: r.executorError, err: r.err, units: r.unitsConsumed, deltas: r.deltas, logs: r.logsTail }] as [string, unknown]), ['snapshot', x.snapshot], ['missing_on_chain', x.accountsMissingOnChain]])
    } catch (e) { out['executor'] = { error: (e as Error).message }; console.error(`EXECUTOR_PROBE_ERROR ${(e as Error).message}`) }
  }
  const dirOut = join(config.paths.dataDir, 'simulations'); mkdirSync(dirOut, { recursive: true })
  const file = join(dirOut, `${nowUtcIso().replace(/[:.]/g, '-')}_${c.id.slice(0, 40).replace(/[^A-Za-z0-9]/g, '_')}.json`)
  writeFileSync(file, JSON.stringify(out, jsonReplacer, 1))
  printBlock('saved', [['file', file], ['rpc_requests', rpc.usage.total]])
  return 0
}
