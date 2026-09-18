import { PublicKey } from '@solana/web3.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LoadedConfig } from '../config/load.js'
import { resolveEndpoints } from '../config/load.js'
import type { JsonlLogger } from '../telemetry/log.js'
import { RpcClient, RpcBudgetExhausted } from '../state/rpc.js'
import { Db } from '../state/db.js'
import { loadAdapters, requireAdapters } from '../adapters/registry.js'
import type { AccountBundle, AdapterId, DecodedPool, PoolAdapter, PoolRef } from '../adapters/types.js'
import { snapshotPools } from '../state/snapshot.js'
import { enumerateCircuits, sizeCircuit, type Circuit, type CircuitEval } from '../routing/circuit.js'
import { RunControl } from '../telemetry/control.js'
import { monoMs, nowUtcIso, percentile, sleep } from '../util/time.js'
import { jsonReplacer } from '../util/bigint.js'
import { buildDirectCircuitTx, mainnetSimulate, localProbe, userAccountsFor, type LocalProbeEvidence, type MainnetSimEvidence } from '../simulation/probe.js'
import { externalCosts } from '../accounting/pnl.js'
import { CapitalLedger, type ReserveResult } from '../accounting/capital.js'
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
  // optional WSS: vault notifications drive the loop. A route is re-polled when one of its vaults changed; the per-key revision lets us detect a
  // notification that arrived WHILE the route was being processed, so it is re-polled instead of being cleared (audit note on the old dirty set).
  const gaps: { fromUtc: string; toUtc: string; reason: string }[] = []
  let wss: WssManager | null = null
  const vaultToToken = new Map<string, string>()
  for (const o of first.outcomes) if (o.decoded) { const t = tokenOf.get(o.pool.address.toBase58())!; vaultToToken.set(o.decoded.vaultA.address.toBase58(), t); vaultToToken.set(o.decoded.vaultB.address.toBase58(), t) }
  if (ep.wssUrl) {
    wss = new WssManager(ep.wssUrl, config.rpc.commitment, { onAccount: n => { db.event(runId, n.account.receivedAtUtc, n.account.receivedMonoMs, 'wss_account', n.account.pubkey.toBase58(), n.account.contextSlot, { identity: n.identity, lamports: n.account.lamports }) }, onGap: g => { gaps.push(g); db.event(runId, nowUtcIso(), monoMs(), 'wss_gap', null, null, g) } }, log)
    try { await wss.start(); wss.subscribe([...vaultToToken.keys()].map(k => new PublicKey(k))) } catch (e) { log.warn('wss_unavailable', { error: (e as Error).message }); wss = null }
  }
  // state age is measured at every stage that matters, from the snapshot's receive time: one number taken right after the snapshot measures nothing (audit finding F2)
  const lat = { snapshot: [] as number[], quote: [] as number[], build: [] as number[], sim: [] as number[], ageAtQuote: [] as number[], ageAtDecision: [] as number[], ageAtBuild: [] as number[], ageAtSim: [] as number[] }
  const episodes = new Map<string, Episode>()
  const counters = { revisionRacesObserved: 0, wssDrivenPolls: 0, capitalRejected: 0, capitalResized: 0, sizingCapExhausted: 0, polls: 0, routePolls: 0, snapshotIncomplete: 0, circuitsEvaluated: 0, positiveEvaluations: 0, candidates: 0, simsAttempted: 0, simsOk: 0, localAttempted: 0, localOk: 0, localMatch: 0, stale: 0, staleAtDecision: 0, staleAtSimulation: 0, errors: 0 }
  const simTimes: number[] = []
  const vaultsOfToken = new Map<string, string[]>()
  for (const [v, t] of vaultToToken) { const a = vaultsOfToken.get(t) ?? []; a.push(v); vaultsOfToken.set(t, a) }
  /** Routes whose vaults changed since we last looked at them, newest change first; empty means nothing moved. */
  const dirtyRoutes = (): string[] => {
    if (!wss) return []
    const seen = new Set<string>()
    for (const key of wss.drainDirty()) { const t = vaultToToken.get(key); if (t) seen.add(t) }
    return [...seen]
  }
  // capital budget, pending positions and concurrency for prospective probes (hypothetical mode: probe PnLs never change capital)
  const ledger = new CapitalLedger({ capitalLamports: BigInt(config.sizing.maxCapitalLamports), maxEpisodeFrac: 0.2, maxAggregateOpenFrac: 0.4, reserveFrac: 0.3, maxConcurrent: 3, hypothetical: true })
  // external costs do not depend on the size (they come from config): one estimate for the whole run. `total` = definitive costs (base fee + priority + tip),
  // `locked` = recoverable deposits of the accounts the circuit creates (ATA rent). Both must be available, only `total` is spent.
  const ext = externalCosts({ baseFeeLamports: BigInt(config.costs.baseFeeLamportsPerSignature), signatures: 1, computeUnitLimit: config.costs.computeUnitLimit, computeUnitPriceMicroLamports: config.costs.computeUnitPriceMicroLamports, jitoTipLamports: BigInt(config.costs.jitoTipLamports), nonRecoverableRentLamports: 0n, recoverableRentLamports: BigInt(config.costs.ataRentLamports) })
  const feeBudget = ext.total
  const depositLamports = ext.locked.reduce((s, c) => s + c.amount, 0n)
  const grid = config.sizing.grid.map(BigInt)
  const maxCapital = BigInt(config.sizing.maxCapitalLamports)
  const stalenessMaxMs = config.execution.stalenessMaxMs
  const closest = new Map<string, { bps: number; amountIn: bigint; utc: string; category: string }>()
  let stopReason: string | null = null
  let warnedSizingCap = false
  const programsCache = new Map<string, boolean>()
  outer: while (true) {
    const stop = control.check(rpc.usage.total); if (stop) { stopReason = stop; break }
    counters.polls++
    const pending = wss ? dirtyRoutes() : []
    const order = pending.length ? [...routes].sort((a, b) => (pending.includes(b[0]) ? 1 : 0) - (pending.includes(a[0]) ? 1 : 0)) : routes
    for (const [token, poolRefs] of order) {
      const revBefore = wss ? wss.maxRevisionOf(vaultsOfToken.get(token) ?? []) : 0
      const stop2 = control.check(rpc.usage.total); if (stop2) { stopReason = stop2; break outer }
      const t0 = monoMs()
      let snap
      try { snap = await snapshotPools(rpc, adapters, poolRefs, { requireSingleBatch: true }) } catch (e) { if (e instanceof RpcBudgetExhausted) { stopReason = 'HTTP_BUDGET'; break outer } counters.errors++; log.warn('snapshot_error', { token, error: (e as Error).message }); continue }
      const tSnap = monoMs() - t0; lat.snapshot.push(tSnap); counters.routePolls++
      const decoded: DecodedPool[] = []
      for (const o of snap.outcomes) { if (o.status === 'OK' && o.decoded) decoded.push(o.decoded); else if (o.status === 'SNAPSHOT_INCOMPLETE') counters.snapshotIncomplete++ }
      const bundle = snap.bundle
      const receivedMonoMs = bundleReceivedMonoMs(bundle)   // the OLDEST account decides the age; no bundle => freshness cannot be attested
      const routeClock = receivedMonoMs === null ? null : newDecisionClock(receivedMonoMs)   // every stage below is timed against this receive instant
      const circuits = enumerateCircuits(decoded)
      const t1 = monoMs()
      const evals: { c: Circuit; best: CircuitEval | null; points: number; cap: bigint }[] = []
      // F7: search inside the budget the ledger will actually grant (its own caps minus the fee budget and the recoverable deposits), not
      // config.sizing.maxCapitalLamports: a size above that cap is refused with EPISODE_CAP every single time. The caps themselves are untouched.
      // (The ledger cannot move during this loop: nothing is reserved before the decision loop below.)
      const cap = effectiveSizingCap(ledger, maxCapital, feeBudget, depositLamports)
      if (cap <= 0n) { counters.sizingCapExhausted++; if (!warnedSizingCap) { warnedSizingCap = true; log.warn('sizing_cap_zero', { budget: ledger.budget(), feeBudget, depositLamports, note: 'no size can be reserved: fee budget + deposits exceed the ledger budget; nothing will be simulated' }) } }
      for (const c of circuits) {
        const s = sizeCircuit(adapters, c, grid, cap, config.sizing.refineSteps); evals.push({ c, best: s.best, points: s.evaluated.length, cap }); counters.circuitsEvaluated++
        // distance to break-even even when no size is positive: best pnl in bps over all evaluated sizes (QUOTE_ONLY)
        for (const e of s.evaluated) if (e.pnl !== null) { const bps = Number((e.pnl * 1_000_000n) / e.amountIn) / 100; const prev = closest.get(c.id); if (prev === undefined || bps > prev.bps) closest.set(c.id, { bps, amountIn: e.amountIn, utc: nowUtcIso(), category: c.category }) }
      }
      lat.quote.push(monoMs() - t1)
      if (routeClock) lat.ageAtQuote.push(markStage(routeClock, 'quoteDone', monoMs()))   // stage 1: receive -> quote done
      const nowIso = nowUtcIso()
      for (const { c, best, cap: sizingCap } of evals) {
        const ep0 = episodes.get(c.id)
        if (!best) { if (ep0 && ep0.open) { ep0.open = false; db.event(runId, nowIso, monoMs(), 'episode_end', c.id, snap.bundle?.maxSlot ?? null, ep0) } continue }
        counters.positiveEvaluations++
        const txPnl = best.pnl.pnl - ext.total
        const candidateId = sha256Hex(`${runId}|${c.id}|${c.poolA.stateHash}|${c.poolB.stateHash}|${best.amountIn}`).slice(0, 24)
        const isCandidate = txPnl >= BigInt(config.costs.minNetProfitLamports)
        if (isCandidate) counters.candidates++
        // F2 stage 2: the age is measured HERE, when the decision is recorded — quoting and sizing already happened since the snapshot
        const clock = routeClock ? { ...routeClock } : null   // one clock per decision, sharing this snapshot's receive and quote-done marks
        const decisionMonoMs = monoMs()
        const atDecision = clock ? stalenessGate(clock.receivedMonoMs, decisionMonoMs, stalenessMaxMs) : null
        if (clock) lat.ageAtDecision.push(markStage(clock, 'decision', decisionMonoMs))
        db.db.prepare('INSERT OR IGNORE INTO candidates (id,run_id,ts_utc,mono_ms,mint,pool_a,pool_b,direction,amount_in,amount_out,trading_pnl,tx_pnl,state_hash,min_slot,max_slot,single_batch,evidence,status,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(candidateId, runId, nowIso, monoMs(), token, c.poolA.address.toBase58(), c.poolB.address.toBase58(), c.category, best.amountIn.toString(), best.quoteB.amountOutToUser.toString(), best.pnl.pnl.toString(), txPnl.toString(), sha256Hex(c.poolA.stateHash + c.poolB.stateHash), snap.bundle?.minSlot ?? null, snap.bundle?.maxSlot ?? null, snap.bundle?.singleBatch ? 1 : 0, 'QUOTE_ONLY', isCandidate ? 'CANDIDATE' : 'BELOW_MIN_NET', JSON.stringify({ legA: { in: best.quoteA.amountIn, out: best.quoteA.amountOutToUser }, legB: { in: best.quoteB.amountIn, out: best.quoteB.amountOutToUser }, ext: ext.costs, locked: ext.locked, sizingCapLamports: sizingCap, stateAgeMsAtDecision: atDecision?.ageMs ?? null, stale: atDecision === null ? true : !atDecision.fresh }, jsonReplacer))
        // episodes: consecutive positive (candidate-level) evaluations of the same circuit
        if (isCandidate) {
          const e = ep0 && ep0.open ? ep0 : { circuitId: c.id, token, category: c.category, startUtc: nowIso, lastUtc: nowIso, refreshes: 0, maxPnl: txPnl, maxPnlAmountIn: best.amountIn, minSlot: snap.bundle?.minSlot ?? 0, maxSlot: snap.bundle?.maxSlot ?? 0, simulated: 0, simOk: 0, localOk: 0, localMatch: 0, open: true }
          e.lastUtc = nowIso; e.refreshes++; if (txPnl > e.maxPnl) { e.maxPnl = txPnl; e.maxPnlAmountIn = best.amountIn } e.maxSlot = Math.max(e.maxSlot, snap.bundle?.maxSlot ?? 0)
          episodes.set(c.id, e)
          if (e.refreshes === 1) db.event(runId, nowIso, monoMs(), 'episode_start', c.id, snap.bundle?.maxSlot ?? null, { txPnl, amountIn: best.amountIn })
          // bounded simulations
          const now = monoMs(); while (simTimes.length && simTimes[0]! < now - 60_000) simTimes.shift()
          if (atDecision === null || !atDecision.fresh) {
            // F2: stale at the decision => skip and re-quote on the next poll; nothing is reserved for state we no longer trust
            counters.stale++; counters.staleAtDecision++
            db.event(runId, nowIso, now, 'stale_at_decision', c.id, snap.bundle?.maxSlot ?? null, { code: atDecision?.code ?? 'NO_BUNDLE', ageMs: atDecision?.ageMs ?? null, maxMs: stalenessMaxMs })
          } else if (simTimes.length < maxSimsPerMinute) {
            // F7: reserve amountIn + fee budget + recoverable deposits; a cap refusal falls back to the largest size the ledger does accept
            const att = reserveBestSize({ adapters, circuit: c, best, grid, refineSteps: config.sizing.refineSteps, maxCapitalLamports: maxCapital, ledger, feeBudget, depositLamports, id: candidateId, pools: [c.poolA.address.toBase58(), c.poolB.address.toBase58()], mint: token, utc: nowIso })
            if (att.refusedFirst && att.hold.ok) { counters.capitalResized++; db.event(runId, nowIso, monoMs(), 'capital_resize', c.id, snap.bundle?.maxSlot ?? null, { refusedFirst: att.refusedFirst, chosenAmountIn: att.chosen.amountIn, capLamports: att.capLamports, feeBudget, depositLamports }) }
            if (!att.hold.ok) { counters.capitalRejected++; db.event(runId, nowIso, monoMs(), 'capital_reject', c.id, snap.bundle?.maxSlot ?? null, { code: att.hold.code, detail: att.hold.detail, budget: att.hold.budget, firstChoice: att.refusedFirst, capLamports: att.capLamports, retried: att.retried }) }
            else {
              const chosen = att.chosen
              let simIssued = false
              const t2 = monoMs()
              try {
                const identity = process.env['SIM_IDENTITY_PUBKEY'] ? new PublicKey(process.env['SIM_IDENTITY_PUBKEY']) : PublicKey.unique()
                const ua = userAccountsFor(identity, c)
                const bh = await rpc.getLatestBlockhash()
                const direct = buildDirectCircuitTx(adapters, c, chosen, ua, bh.value.blockhash, config.costs)
                const buildDoneMonoMs = monoMs()
                lat.build.push(buildDoneMonoMs - t2)
                if (clock) lat.ageAtBuild.push(markStage(clock, 'buildDone', buildDoneMonoMs))   // stage 3: receive -> build done (includes the getLatestBlockhash round trip)
                // F2: gate again at the LAST moment before the simulation is issued — the round trip above can alone exceed the staleness budget
                const simGateMonoMs = monoMs()
                const atSim = clock ? stalenessGate(clock.receivedMonoMs, simGateMonoMs, stalenessMaxMs) : null
                if (atSim === null || !atSim.fresh) {
                  counters.stale++; counters.staleAtSimulation++
                  db.event(runId, nowUtcIso(), monoMs(), 'stale_at_simulation', c.id, snap.bundle?.maxSlot ?? null, { code: atSim?.code ?? 'NO_BUNDLE', ageMs: atSim?.ageMs ?? null, maxMs: stalenessMaxMs, stages: clock ? clockStages(clock) : null })
                } else {
                  if (clock) lat.ageAtSim.push(markStage(clock, 'simIssued', simGateMonoMs))   // stage 4: receive -> simulate issued
                  simIssued = true; simTimes.push(monoMs()); counters.simsAttempted++; e.simulated++
                  const t3 = monoMs()
                  const m: MainnetSimEvidence = await mainnetSimulate(rpc, direct, ua, { minContextSlot: snap.bundle?.maxSlot })
                  lat.sim.push(monoMs() - t3)
                  if (m.err === null) { counters.simsOk++; e.simOk++ }
                  db.db.prepare('INSERT OR REPLACE INTO simulations (id,run_id,candidate_id,ts_utc,environment,context_slot,err,units_consumed,message_hash,payload) VALUES (?,?,?,?,?,?,?,?,?,?)').run(`${candidateId}:mainnet`, runId, candidateId, m.receivedAtUtc, m.environment, m.contextSlot, m.err === null ? null : JSON.stringify(m.err), m.unitsConsumed, m.messageHash, JSON.stringify({ errClass: m.errClass, logsTail: m.logs.slice(-5), fee: m.feeForMessageLamports, post: m.postBalances, txBytes: direct.built.serializedBytes, identity: identity.toBase58(), amountIn: chosen.amountIn, resizedFromLamports: att.retried ? best.amountIn : null, stateAgeMs: { atDecision: atDecision.ageMs, atSimulation: atSim.ageMs } }, jsonReplacer))
                  // local probe (real programs) at most once per episode
                  if (e.localOk === 0 && counters.localAttempted < 20) {
                    counters.localAttempted++
                    const key = c.poolA.programId.toBase58() + c.poolB.programId.toBase58(); programsCache.set(key, true)
                    const l: LocalProbeEvidence = await localProbe(rpc, adapters, c, chosen, config.costs)
                    if (l.ok) { counters.localOk++; e.localOk++ }
                    if (l.realised?.matchesQuote) { counters.localMatch++; e.localMatch++ }
                    db.db.prepare('INSERT OR REPLACE INTO simulations (id,run_id,candidate_id,ts_utc,environment,context_slot,err,units_consumed,message_hash,payload) VALUES (?,?,?,?,?,?,?,?,?,?)').run(`${candidateId}:local`, runId, candidateId, nowUtcIso(), l.environment, l.snapshot.maxSlot, l.err, Number(l.unitsConsumed), direct.built.messageHash, JSON.stringify({ deltas: l.deltas, quoted: l.quoted, realised: l.realised, accounting: l.accounting, synthetic: l.synthetic.length, missing: l.accountsMissingOnChain, logsTail: l.logs.slice(-5) }, jsonReplacer))
                  }
                }
              } catch (err) { counters.errors++; log.warn('sim_error', { circuit: c.id, error: (err as Error).message }) }
              // a probe never lands: an ISSUED simulation costs the modelled fee, one abandoned before issue costs nothing; the deposit is released either way
              finally { ledger.settle({ id: candidateId, realisedPnl: 0n, feePaid: simIssued ? feeBudget : 0n, status: 'NOT_LANDED', utc: nowUtcIso() }) }
            }
          }
        } else if (ep0 && ep0.open) { ep0.open = false; db.event(runId, nowIso, monoMs(), 'episode_end', c.id, snap.bundle?.maxSlot ?? null, ep0) }
      }
      if (wss) {
        const revAfter = wss.maxRevisionOf(vaultsOfToken.get(token) ?? [])
        if (revAfter !== revBefore) { counters.revisionRacesObserved++; db.event(runId, nowUtcIso(), monoMs(), 'route_changed_during_processing', token, snap.bundle?.maxSlot ?? null, { revBefore, revAfter }) }
      }
    }
    db.checkpoint(runId, 'progress', nowUtcIso(), { counters, rpc: rpc.usage.total, episodes: [...episodes.values()].map(e => ({ ...e })), elapsedMs: control.elapsedMs() })
    // wait for the next poll (or a WSS-dirty route)
    const until = monoMs() + pollMs
    while (monoMs() < until) {
      if (wss && wss.dirtyCount > 0) { counters.wssDrivenPolls++; break }   // a vault moved: start the next pass now instead of sleeping it out
      await sleep(wss ? 50 : 200)
      const s = control.check(rpc.usage.total); if (s) { stopReason = s; break outer }
    }
  }
  wss?.stop()
  const pct = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99) } }
  const eps = [...episodes.values()]
  const summary = {
    runId, stopReason, elapsedMs: control.elapsedMs(), durationMin, pools: refs.length, validPools: valid.length, dropped, routes: routes.length, counters,
    // state age per STAGE, all measured from the snapshot's receive time: one number taken right after the snapshot measured neither the decision nor the simulation (F2)
    latencyMs: { snapshot: pct(lat.snapshot), quote: pct(lat.quote), build: pct(lat.build), simulation: pct(lat.sim), stateAgeAtDecision: pct(lat.ageAtDecision), stateAge: { atQuoteDone: pct(lat.ageAtQuote), atDecision: pct(lat.ageAtDecision), atBuildDone: pct(lat.ageAtBuild), atSimulationIssued: pct(lat.ageAtSim), maxMs: stalenessMaxMs } },
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Decision policy (pure, unit-tested in tests/unit/shadow_policy.test.ts). Kept out of the async loop so that the gates can be reproduced without any RPC.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The monotonic marks of ONE decision, all relative to the snapshot's receive time. Every stage carries its own mark because the distance between them
 * (quoting, sizing, capital reservation, a getLatestBlockhash round trip) is exactly what an age measured once, right after the snapshot, cannot see (F2).
 */
export interface DecisionClock {
  /** monotonic ms at which the OLDEST account of the snapshot was received */
  receivedMonoMs: number
  quoteDoneMonoMs: number | null
  decisionMonoMs: number | null
  buildDoneMonoMs: number | null
  simIssuedMonoMs: number | null
}
export type DecisionStage = 'quoteDone' | 'decision' | 'buildDone' | 'simIssued'
export function newDecisionClock(receivedMonoMs: number): DecisionClock {
  return { receivedMonoMs, quoteDoneMonoMs: null, decisionMonoMs: null, buildDoneMonoMs: null, simIssuedMonoMs: null }
}
/** Marks one stage with the clock read AT THAT MOMENT and returns the state age there. Never reuses an age measured at an earlier stage. */
export function markStage(clock: DecisionClock, stage: DecisionStage, nowMonoMs: number): number {
  switch (stage) {
    case 'quoteDone': clock.quoteDoneMonoMs = nowMonoMs; break
    case 'decision': clock.decisionMonoMs = nowMonoMs; break
    case 'buildDone': clock.buildDoneMonoMs = nowMonoMs; break
    case 'simIssued': clock.simIssuedMonoMs = nowMonoMs; break
  }
  return nowMonoMs - clock.receivedMonoMs
}
/** Per-stage ages of a clock, for the latency histogram. */
export function clockStages(clock: DecisionClock): { quoteDone: number | null; decision: number | null; buildDone: number | null; simIssued: number | null } {
  const age = (t: number | null) => (t === null ? null : t - clock.receivedMonoMs)
  return { quoteDone: age(clock.quoteDoneMonoMs), decision: age(clock.decisionMonoMs), buildDone: age(clock.buildDoneMonoMs), simIssued: age(clock.simIssuedMonoMs) }
}
export type StalenessVerdict = { fresh: true; ageMs: number } | { fresh: false; ageMs: number; maxMs: number; code: 'STALE_STATE' }
/** The staleness gate. Pure: `nowMonoMs` is supplied by the caller so that the moment being judged is explicit at every call site. */
export function stalenessGate(receivedMonoMs: number, nowMonoMs: number, maxMs: number): StalenessVerdict {
  const ageMs = nowMonoMs - receivedMonoMs
  return ageMs <= maxMs ? { fresh: true, ageMs } : { fresh: false, ageMs, maxMs, code: 'STALE_STATE' }
}
/** A snapshot is only as fresh as its OLDEST account. Null when there is no bundle: freshness cannot be attested, so nothing may be simulated on it. */
export function bundleReceivedMonoMs(bundle: AccountBundle | null | undefined): number | null {
  if (!bundle || bundle.accounts.size === 0) return null
  let oldest = Infinity
  for (const a of bundle.accounts.values()) if (a.receivedMonoMs < oldest) oldest = a.receivedMonoMs
  return Number.isFinite(oldest) ? oldest : null
}

/** Reserve refusals that are purely about the amount asked for: a smaller size may still be granted, so they are not a reason to give up (F7). */
export const CAPITAL_CAP_CODES: ReadonlySet<string> = new Set(['EPISODE_CAP', 'AGGREGATE_CAP', 'RESERVE_FLOOR'])
/**
 * The cap a sizer may search inside: the smaller of the configured maximum and what the ledger will actually grant once the fee budget and the
 * recoverable deposits are taken out of its budget. This LOWERS the search space; it never raises any capital protection.
 */
export function effectiveSizingCap(ledger: CapitalLedger, maxCapitalLamports: bigint, feeBudget: bigint, depositLamports: bigint): bigint {
  const ledgerCap = ledger.capacityFor({ feeBudget, depositLamports })
  return ledgerCap < maxCapitalLamports ? ledgerCap : maxCapitalLamports
}
export interface ReserveAttempt {
  /** the reservation that stands (the retry's, when the first choice was refused for a cap reason) */
  hold: ReserveResult
  /** the evaluation the caller must build and simulate — the retry's smaller size when a fallback happened */
  chosen: CircuitEval
  capLamports: bigint
  refusedFirst: { code: string; detail: string; amountIn: bigint; budget: bigint } | null
  retried: boolean
}
/**
 * Reserves the sized circuit and, when the ledger refuses the amount (EPISODE_CAP / AGGREGATE_CAP / RESERVE_FLOOR), re-sizes inside the budget the
 * ledger does grant and reserves that instead, recording why the first choice was refused. Giving up on a cap refusal discarded opportunities that
 * were positive at a smaller size (F7). The caps themselves are never relaxed: the fallback size is always <= what `budget()` allows.
 */
export function reserveBestSize(a: {
  adapters: Record<AdapterId, PoolAdapter>
  circuit: Circuit
  best: CircuitEval
  grid: bigint[]
  refineSteps: number
  maxCapitalLamports: bigint
  ledger: CapitalLedger
  feeBudget: bigint
  depositLamports: bigint
  id: string; pools: string[]; mint: string; utc: string
}): ReserveAttempt {
  const capLamports = effectiveSizingCap(a.ledger, a.maxCapitalLamports, a.feeBudget, a.depositLamports)
  const common = { feeBudget: a.feeBudget, depositLamports: a.depositLamports, pools: a.pools, mint: a.mint, utc: a.utc }
  const first = a.ledger.reserve({ id: a.id, amountIn: a.best.amountIn, ...common })
  if (first.ok) return { hold: first, chosen: a.best, capLamports, refusedFirst: null, retried: false }
  const refusedFirst = { code: first.code, detail: first.detail, amountIn: a.best.amountIn, budget: first.budget }
  // only an amount refusal is retryable; a conflict, a duplicate id or the concurrency limit would refuse ANY size
  if (!CAPITAL_CAP_CODES.has(first.code) || capLamports <= 0n || capLamports >= a.best.amountIn) return { hold: first, chosen: a.best, capLamports, refusedFirst, retried: false }
  const smaller = sizeCircuit(a.adapters, a.circuit, a.grid, capLamports, a.refineSteps).best
  if (!smaller) return { hold: first, chosen: a.best, capLamports, refusedFirst, retried: false }
  const second = a.ledger.reserve({ id: a.id, amountIn: smaller.amountIn, ...common })
  return { hold: second, chosen: second.ok ? smaller : a.best, capLamports, refusedFirst, retried: true }
}
