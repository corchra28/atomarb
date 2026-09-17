import { PublicKey } from '@solana/web3.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LoadedConfig } from '../config/load.js'
import { resolveEndpoints } from '../config/load.js'
import type { JsonlLogger } from '../telemetry/log.js'
import { RpcClient, RpcBudgetExhausted } from '../state/rpc.js'
import { Db } from '../state/db.js'
import { loadAdapters, requireAdapters } from '../adapters/registry.js'
import type { AdapterId, DecodedPool, PoolRef } from '../adapters/types.js'
import { snapshotPools } from '../state/snapshot.js'
import { enumerateCircuits, sizeCircuit, type Circuit, type CircuitEval } from '../routing/circuit.js'
import { RunControl } from '../telemetry/control.js'
import { monoMs, nowUtcIso, percentile, sleep } from '../util/time.js'
import { jsonReplacer } from '../util/bigint.js'
import { buildDirectCircuitTx, mainnetSimulate, localProbe, userAccountsFor, type LocalProbeEvidence, type MainnetSimEvidence } from '../simulation/probe.js'
import { externalCosts } from '../accounting/pnl.js'
import { CapitalLedger } from '../accounting/capital.js'
import { WssManager } from '../state/wss.js'
import { sha256Hex } from '../util/hash.js'
import { WSOL_MINT } from '../state/token.js'

interface Episode { circuitId: string; token: string; category: string; startUtc: string; lastUtc: string; refreshes: number; maxPnl: bigint; maxPnlAmountIn: bigint; minSlot: number; maxSlot: number; simulated: number; simOk: number; localOk: number; localMatch: number; open: boolean }
/**
 * shadow --duration 60m [--config f] [--pools-file data/discovery/shortlist.json] [--max-sims-per-minute 2] [--poll-ms 4000]
 * Prospective, read-only. Each poll = ONE getMultipleAccounts per token route (all dependents), quotes, sizing, episode tracking; positive candidates get bounded
 * mainnet + local simulations. Every probe is an independent hypothetical intervention; sums are NOT a realised portfolio. Budgets: duration, HTTP requests, disk, STOP file.
 */
export async function shadow(loaded: LoadedConfig, flags: Record<string, string | true>, log: JsonlLogger): Promise<number> {
  const { config, configHash } = loaded
  const durationMin = Math.min(config.smoke.maxDurationMinutes, parseDuration(typeof flags['duration'] === 'string' ? flags['duration'] : '60m'))
  const pollMs = Number(typeof flags['poll-ms'] === 'string' ? flags['poll-ms'] : 4000)
  const maxSimsPerMinute = Number(typeof flags['max-sims-per-minute'] === 'string' ? flags['max-sims-per-minute'] : 2)
  const { adapters: la, missing } = await loadAdapters(); for (const m of missing) console.error(`ADAPTER_MISSING ${m.id}: ${m.error}`)
  const adapters = requireAdapters(la)
  const ep = resolveEndpoints(config)
  const rpc = new RpcClient(ep.httpUrl, config.rpc, config.rpc.commitment, log)
  const runId = `shadow_${nowUtcIso().replace(/[:.]/g, '-')}_${configHash.slice(0, 8)}`
  const runDir = join(config.paths.reportsDir, runId); mkdirSync(runDir, { recursive: true })
  const db = new Db(join(config.paths.dataDir, 'atomarb.db'))
  db.startRun(runId, 'shadow', configHash, config, nowUtcIso())
  const control = new RunControl({ maxDurationMs: durationMin * 60_000, maxHttpRequests: config.rpc.maxTotalHttpRequests, maxDiskBytes: config.smoke.maxDiskBytes, stopFile: join(config.paths.dataDir, 'STOP'), dataDir: config.paths.dataDir })
  // pool list: config.pools or shortlist file
  const poolsFile = typeof flags['pools-file'] === 'string' ? flags['pools-file'] : join(config.paths.dataDir, 'discovery', 'shortlist.json')
  let refs: PoolRef[] = config.pools.map(p => ({ adapter: p.adapter, address: new PublicKey(p.address), source: { kind: 'config', ref: configHash, observedAtUtc: nowUtcIso() } }))
  if (!refs.length && existsSync(poolsFile)) {
    const sl = JSON.parse(readFileSync(poolsFile, 'utf8')) as { adapter: AdapterId; address: string; mint?: string; source?: unknown }[]
    refs = sl.map(p => ({ adapter: p.adapter, address: new PublicKey(p.address), source: { kind: 'shortlist', ref: poolsFile, observedAtUtc: nowUtcIso() } }))
  }
  refs = refs.slice(0, config.smoke.maxPools)
  if (!refs.length) { console.error(`NO_POOLS: provide config.pools or run discover (expected ${poolsFile})`); db.endRun(runId, 'FAILED', nowUtcIso(), 'NO_POOLS', {}); return 1 }
  log.info('shadow_start', { runId, pools: refs.length, durationMin, pollMs, maxSimsPerMinute })
  // first snapshot to learn token groups; pools that fail validation are dropped for the run (recorded)
  const first = await snapshotPools(rpc, adapters, refs, { requireSingleBatch: false })
  const valid: PoolRef[] = []; const dropped: { pool: string; status: string; reasons: string[] }[] = []
  const tokenOf = new Map<string, string>()
  for (const o of first.outcomes) {
    if (o.status === 'OK' && o.decoded) { valid.push(o.pool); const t = o.decoded.mintA.mint.equals(WSOL_MINT) ? o.decoded.mintB.mint : o.decoded.mintA.mint; tokenOf.set(o.pool.address.toBase58(), t.toBase58()) }
    else dropped.push({ pool: o.pool.address.toBase58(), status: o.status, reasons: o.reasons })
  }
  const groups = new Map<string, PoolRef[]>()
  for (const p of valid) { const t = tokenOf.get(p.address.toBase58())!; const g = groups.get(t) ?? []; g.push(p); groups.set(t, g) }
  const routes = [...groups.entries()].filter(([, g]) => g.length >= 2)
  log.info('shadow_routes', { valid: valid.length, dropped: dropped.length, routes: routes.length })
  db.checkpoint(runId, 'setup', nowUtcIso(), { valid: valid.map(v => v.address.toBase58()), dropped, routes: routes.map(([t, g]) => ({ token: t, pools: g.map(p => p.address.toBase58()) })) })
  // optional WSS: vault subscriptions trigger an immediate re-poll of the affected route
  const dirty = new Set<string>(); const gaps: { fromUtc: string; toUtc: string; reason: string }[] = []
  let wss: WssManager | null = null
  const vaultToToken = new Map<string, string>()
  for (const o of first.outcomes) if (o.decoded) { const t = tokenOf.get(o.pool.address.toBase58())!; vaultToToken.set(o.decoded.vaultA.address.toBase58(), t); vaultToToken.set(o.decoded.vaultB.address.toBase58(), t) }
  if (ep.wssUrl) {
    wss = new WssManager(ep.wssUrl, config.rpc.commitment, { onAccount: n => { const t = vaultToToken.get(n.account.pubkey.toBase58()); if (t) dirty.add(t); db.event(runId, n.account.receivedAtUtc, n.account.receivedMonoMs, 'wss_account', n.account.pubkey.toBase58(), n.account.contextSlot, { identity: n.identity, lamports: n.account.lamports }) }, onGap: g => { gaps.push(g); db.event(runId, nowUtcIso(), monoMs(), 'wss_gap', null, null, g) } }, log)
    try { await wss.start(); wss.subscribe([...vaultToToken.keys()].map(k => new PublicKey(k))) } catch (e) { log.warn('wss_unavailable', { error: (e as Error).message }); wss = null }
  }
  const lat = { snapshot: [] as number[], quote: [] as number[], build: [] as number[], sim: [] as number[], age: [] as number[] }
  const episodes = new Map<string, Episode>()
  const counters = { capitalRejected: 0, polls: 0, routePolls: 0, snapshotIncomplete: 0, circuitsEvaluated: 0, positiveEvaluations: 0, candidates: 0, simsAttempted: 0, simsOk: 0, localAttempted: 0, localOk: 0, localMatch: 0, stale: 0, errors: 0 }
  const simTimes: number[] = []
  // capital budget, pending positions and concurrency for prospective probes (hypothetical mode: probe PnLs never change capital)
  const ledger = new CapitalLedger({ capitalLamports: BigInt(config.sizing.maxCapitalLamports), maxEpisodeFrac: 0.2, maxAggregateOpenFrac: 0.4, reserveFrac: 0.3, maxConcurrent: 3, hypothetical: true })
  const closest = new Map<string, { bps: number; amountIn: bigint; utc: string; category: string }>()
  let stopReason: string | null = null
  const programsCache = new Map<string, boolean>()
  outer: while (true) {
    const stop = control.check(rpc.usage.total); if (stop) { stopReason = stop; break }
    counters.polls++
    for (const [token, poolRefs] of routes) {
      const stop2 = control.check(rpc.usage.total); if (stop2) { stopReason = stop2; break outer }
      const t0 = monoMs()
      let snap
      try { snap = await snapshotPools(rpc, adapters, poolRefs, { requireSingleBatch: true }) } catch (e) { if (e instanceof RpcBudgetExhausted) { stopReason = 'HTTP_BUDGET'; break outer } counters.errors++; log.warn('snapshot_error', { token, error: (e as Error).message }); continue }
      const tSnap = monoMs() - t0; lat.snapshot.push(tSnap); counters.routePolls++
      const decoded: DecodedPool[] = []
      for (const o of snap.outcomes) { if (o.status === 'OK' && o.decoded) decoded.push(o.decoded); else if (o.status === 'SNAPSHOT_INCOMPLETE') counters.snapshotIncomplete++ }
      const bundle = snap.bundle
      const stateAgeMs = bundle ? monoMs() - [...bundle.accounts.values()][0]!.receivedMonoMs : 0
      const circuits = enumerateCircuits(decoded)
      const t1 = monoMs()
      const evals: { c: Circuit; best: CircuitEval | null; points: number }[] = []
      for (const c of circuits) {
        const s = sizeCircuit(adapters, c, config.sizing.grid.map(BigInt), BigInt(config.sizing.maxCapitalLamports), config.sizing.refineSteps); evals.push({ c, best: s.best, points: s.evaluated.length }); counters.circuitsEvaluated++
        // distance to break-even even when no size is positive: best pnl in bps over all evaluated sizes (QUOTE_ONLY)
        for (const e of s.evaluated) if (e.pnl !== null) { const bps = Number((e.pnl * 1_000_000n) / e.amountIn) / 100; const prev = closest.get(c.id); if (prev === undefined || bps > prev.bps) closest.set(c.id, { bps, amountIn: e.amountIn, utc: nowUtcIso(), category: c.category }) }
      }
      lat.quote.push(monoMs() - t1)
      const nowIso = nowUtcIso()
      for (const { c, best } of evals) {
        const ep0 = episodes.get(c.id)
        if (!best) { if (ep0 && ep0.open) { ep0.open = false; db.event(runId, nowIso, monoMs(), 'episode_end', c.id, snap.bundle?.maxSlot ?? null, ep0) } continue }
        counters.positiveEvaluations++
        // external cost estimate (formula; getFeeForMessage is used in the simulation path)
        const ext = externalCosts({ baseFeeLamports: BigInt(config.costs.baseFeeLamportsPerSignature), signatures: 1, computeUnitLimit: config.costs.computeUnitLimit, computeUnitPriceMicroLamports: config.costs.computeUnitPriceMicroLamports, jitoTipLamports: BigInt(config.costs.jitoTipLamports), nonRecoverableRentLamports: 0n, recoverableRentLamports: BigInt(config.costs.ataRentLamports) })
        const txPnl = best.pnl.pnl - ext.total
        const candidateId = sha256Hex(`${runId}|${c.id}|${c.poolA.stateHash}|${c.poolB.stateHash}|${best.amountIn}`).slice(0, 24)
        const isCandidate = txPnl >= BigInt(config.costs.minNetProfitLamports)
        if (isCandidate) counters.candidates++
        db.db.prepare('INSERT OR IGNORE INTO candidates (id,run_id,ts_utc,mono_ms,mint,pool_a,pool_b,direction,amount_in,amount_out,trading_pnl,tx_pnl,state_hash,min_slot,max_slot,single_batch,evidence,status,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(candidateId, runId, nowIso, monoMs(), token, c.poolA.address.toBase58(), c.poolB.address.toBase58(), c.category, best.amountIn.toString(), best.quoteB.amountOutToUser.toString(), best.pnl.pnl.toString(), txPnl.toString(), sha256Hex(c.poolA.stateHash + c.poolB.stateHash), snap.bundle?.minSlot ?? null, snap.bundle?.maxSlot ?? null, snap.bundle?.singleBatch ? 1 : 0, 'QUOTE_ONLY', isCandidate ? 'CANDIDATE' : 'BELOW_MIN_NET', JSON.stringify({ legA: { in: best.quoteA.amountIn, out: best.quoteA.amountOutToUser }, legB: { in: best.quoteB.amountIn, out: best.quoteB.amountOutToUser }, ext: ext.costs, stateAgeMs }, jsonReplacer))
        // episodes: consecutive positive (candidate-level) evaluations of the same circuit
        if (isCandidate) {
          const e = ep0 && ep0.open ? ep0 : { circuitId: c.id, token, category: c.category, startUtc: nowIso, lastUtc: nowIso, refreshes: 0, maxPnl: txPnl, maxPnlAmountIn: best.amountIn, minSlot: snap.bundle?.minSlot ?? 0, maxSlot: snap.bundle?.maxSlot ?? 0, simulated: 0, simOk: 0, localOk: 0, localMatch: 0, open: true }
          e.lastUtc = nowIso; e.refreshes++; if (txPnl > e.maxPnl) { e.maxPnl = txPnl; e.maxPnlAmountIn = best.amountIn } e.maxSlot = Math.max(e.maxSlot, snap.bundle?.maxSlot ?? 0)
          episodes.set(c.id, e)
          if (e.refreshes === 1) db.event(runId, nowIso, monoMs(), 'episode_start', c.id, snap.bundle?.maxSlot ?? null, { txPnl, amountIn: best.amountIn })
          // bounded simulations
          const now = monoMs(); while (simTimes.length && simTimes[0]! < now - 60_000) simTimes.shift()
          const feeBudget = ext.total
          const hold = ledger.reserve({ id: candidateId, amountIn: best.amountIn, feeBudget, pools: [c.poolA.address.toBase58(), c.poolB.address.toBase58()], mint: token, utc: nowIso })
          if (!hold.ok) { counters.capitalRejected++; db.event(runId, nowIso, monoMs(), 'capital_reject', c.id, snap.bundle?.maxSlot ?? null, { code: hold.code, detail: hold.detail, budget: hold.budget }) }
          if (hold.ok && simTimes.length < maxSimsPerMinute && stateAgeMs <= config.execution.stalenessMaxMs) {
            simTimes.push(now); counters.simsAttempted++; e.simulated++
            const t2 = monoMs()
            try {
              const identity = process.env['SIM_IDENTITY_PUBKEY'] ? new PublicKey(process.env['SIM_IDENTITY_PUBKEY']) : PublicKey.unique()
              const ua = userAccountsFor(identity, c)
              const bh = await rpc.getLatestBlockhash()
              const direct = buildDirectCircuitTx(adapters, c, best, ua, bh.value.blockhash, config.costs)
              lat.build.push(monoMs() - t2)
              const t3 = monoMs()
              const m: MainnetSimEvidence = await mainnetSimulate(rpc, direct, ua, { minContextSlot: snap.bundle?.maxSlot })
              lat.sim.push(monoMs() - t3)
              if (m.err === null) { counters.simsOk++; e.simOk++ }
              db.db.prepare('INSERT OR REPLACE INTO simulations (id,run_id,candidate_id,ts_utc,environment,context_slot,err,units_consumed,message_hash,payload) VALUES (?,?,?,?,?,?,?,?,?,?)').run(`${candidateId}:mainnet`, runId, candidateId, m.receivedAtUtc, m.environment, m.contextSlot, m.err === null ? null : JSON.stringify(m.err), m.unitsConsumed, m.messageHash, JSON.stringify({ errClass: m.errClass, logsTail: m.logs.slice(-5), fee: m.feeForMessageLamports, post: m.postBalances, txBytes: direct.built.serializedBytes, identity: identity.toBase58() }, jsonReplacer))
              // local probe (real programs) at most once per episode
              if (e.localOk === 0 && counters.localAttempted < 20) {
                counters.localAttempted++
                const key = c.poolA.programId.toBase58() + c.poolB.programId.toBase58(); programsCache.set(key, true)
                const l: LocalProbeEvidence = await localProbe(rpc, adapters, c, best, config.costs)
                if (l.ok) { counters.localOk++; e.localOk++ }
                if (l.realised?.matchesQuote) { counters.localMatch++; e.localMatch++ }
                db.db.prepare('INSERT OR REPLACE INTO simulations (id,run_id,candidate_id,ts_utc,environment,context_slot,err,units_consumed,message_hash,payload) VALUES (?,?,?,?,?,?,?,?,?,?)').run(`${candidateId}:local`, runId, candidateId, nowUtcIso(), l.environment, l.snapshot.maxSlot, l.err, Number(l.unitsConsumed), direct.built.messageHash, JSON.stringify({ deltas: l.deltas, quoted: l.quoted, realised: l.realised, accounting: l.accounting, synthetic: l.synthetic.length, missing: l.accountsMissingOnChain, logsTail: l.logs.slice(-5) }, jsonReplacer))
              }
            } catch (err) { counters.errors++; log.warn('sim_error', { circuit: c.id, error: (err as Error).message }) }
            finally { ledger.settle({ id: candidateId, realisedPnl: 0n, feePaid: ext.total, status: 'NOT_LANDED', utc: nowUtcIso() }) }   // a probe never lands: it costs the modelled fee and credits nothing
          } else {
            if (hold.ok) ledger.settle({ id: candidateId, realisedPnl: 0n, feePaid: 0n, status: 'NOT_LANDED', utc: nowUtcIso() })          // not simulated: release without cost
            if (stateAgeMs > config.execution.stalenessMaxMs) counters.stale++
          }
        } else if (ep0 && ep0.open) { ep0.open = false; db.event(runId, nowIso, monoMs(), 'episode_end', c.id, snap.bundle?.maxSlot ?? null, ep0) }
      }
      lat.age.push(stateAgeMs)
      dirty.delete(token)
    }
    db.checkpoint(runId, 'progress', nowUtcIso(), { counters, rpc: rpc.usage.total, episodes: [...episodes.values()].map(e => ({ ...e })), elapsedMs: control.elapsedMs() })
    // wait for the next poll (or a WSS-dirty route)
    const until = monoMs() + pollMs
    while (monoMs() < until) { if (dirty.size) break; await sleep(200); const s = control.check(rpc.usage.total); if (s) { stopReason = s; break outer } }
  }
  wss?.stop()
  const pct = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99) } }
  const eps = [...episodes.values()]
  const summary = {
    runId, stopReason, elapsedMs: control.elapsedMs(), durationMin, pools: refs.length, validPools: valid.length, dropped, routes: routes.length, counters,
    latencyMs: { snapshot: pct(lat.snapshot), quote: pct(lat.quote), build: pct(lat.build), simulation: pct(lat.sim), stateAgeAtDecision: pct(lat.age) },
    rpc: { total: rpc.usage.total, errors: rpc.usage.errors, retries: rpc.usage.retries, byMethod: Object.fromEntries(Object.entries(rpc.usage.byMethod).map(([k, v]) => [k, { count: v.count, errors: v.errors, ...pct(v.ms) }])) },
    wss: wss ? { ...wss.stats, gaps } : null,
    capital: ledger.snapshot(),
    closestToBreakeven: [...closest.entries()].map(([id, v]) => ({ circuit: id, ...v })).sort((a, b) => b.bps - a.bps).slice(0, 20),
    episodes: { total: eps.length, byCategory: countBy(eps.map(e => e.category)), byToken: countBy(eps.map(e => e.token)), maxRefreshes: Math.max(0, ...eps.map(e => e.refreshes)), simulatedOk: eps.filter(e => e.simOk > 0).length, localOk: eps.filter(e => e.localOk > 0).length, localMatch: eps.filter(e => e.localMatch > 0).length, list: eps.map(e => ({ ...e })) },
    note: 'Every probe is an independent hypothetical intervention on real state; probe sums are not a realised portfolio. REALIZED_NET_PNL = NOT_OBSERVED. TRANSACTIONS_BROADCAST = 0.',
  }
  writeFileSync(join(runDir, 'RUN_REPORT.json'), JSON.stringify(summary, jsonReplacer, 1))
  db.endRun(runId, stopReason === 'DEADLINE' || stopReason === 'STOP_FILE' ? 'COMPLETED' : 'STOPPED', nowUtcIso(), stopReason, summary)
  db.close()
  console.log(JSON.stringify({ runId, stopReason, counters, episodes: summary.episodes.total, rpc: rpc.usage.total, report: join(runDir, 'RUN_REPORT.json') }, jsonReplacer))
  console.log(`Next: npm run -s report -- --run ${runId}`)
  return 0
}
function countBy(xs: string[]): Record<string, number> { const o: Record<string, number> = {}; for (const x of xs) o[x] = (o[x] ?? 0) + 1; return o }
export function parseDuration(s: string): number { const m = /^(\d+)(m|h|s)?$/.exec(s.trim()); if (!m) throw new Error(`bad duration ${s}`); const n = Number(m[1]); return m[2] === 'h' ? n * 60 : m[2] === 's' ? n / 60 : n }
