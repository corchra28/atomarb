import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LoadedConfig } from '../config/load.js'
import type { JsonlLogger } from '../telemetry/log.js'
import { Db } from '../state/db.js'
/** report --run <id>: rebuilds RUN_REPORT.md from the FULL journal in SQLite (not from any preview). */
export async function report(loaded: LoadedConfig, flags: Record<string, string | true>, _log: JsonlLogger): Promise<number> {
  const { config } = loaded
  const dbPath = join(config.paths.dataDir, 'atomarb.db')
  if (!existsSync(dbPath)) { console.error(`NO_DB ${dbPath}`); return 1 }
  const db = new Db(dbPath)
  const runId = typeof flags['run'] === 'string' ? flags['run'] : (db.db.prepare('SELECT id FROM runs ORDER BY started_utc DESC LIMIT 1').get() as { id: string } | undefined)?.id
  if (!runId) { console.error('NO_RUNS'); return 1 }
  const run = db.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as Record<string, unknown> | undefined
  if (!run) { console.error(`RUN_NOT_FOUND ${runId}`); return 1 }
  const summary = run['summary_json'] ? JSON.parse(String(run['summary_json'])) as Record<string, unknown> : {}
  const q = <T>(sql: string, ...p: unknown[]) => db.db.prepare(sql).all(...(p as (string | number | null)[])) as T[]
  const cand = q<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM candidates WHERE run_id=? GROUP BY status', runId)
  const candTotal = q<{ n: number }>('SELECT COUNT(*) n FROM candidates WHERE run_id=?', runId)[0]?.n ?? 0
  const sims = q<{ environment: string; n: number; ok: number }>("SELECT environment, COUNT(*) n, SUM(CASE WHEN err IS NULL THEN 1 ELSE 0 END) ok FROM simulations WHERE run_id=? GROUP BY environment", runId)
  const errClasses = q<{ cls: string; n: number }>("SELECT json_extract(payload,'$.errClass') cls, COUNT(*) n FROM simulations WHERE run_id=? AND environment='MAINNET_RPC_SIMULATION' GROUP BY cls ORDER BY n DESC", runId)
  const localMatch = q<{ n: number }>("SELECT COUNT(*) n FROM simulations WHERE run_id=? AND environment='LOCAL_REAL_PROGRAM_SIMULATION' AND json_extract(payload,'$.realised.matchesQuote')=1", runId)[0]?.n ?? 0
  const localOk = q<{ n: number }>("SELECT COUNT(*) n FROM simulations WHERE run_id=? AND environment='LOCAL_REAL_PROGRAM_SIMULATION' AND err IS NULL", runId)[0]?.n ?? 0
  const topCands = q<{ mint: string; pool_a: string; pool_b: string; direction: string; amount_in: string; tx_pnl: string; ts_utc: string; single_batch: number }>('SELECT mint,pool_a,pool_b,direction,amount_in,tx_pnl,ts_utc,single_batch FROM candidates WHERE run_id=? AND status=\'CANDIDATE\' ORDER BY CAST(tx_pnl AS INTEGER) DESC LIMIT 10', runId)
  const events = q<{ kind: string; n: number }>('SELECT kind, COUNT(*) n FROM events WHERE run_id=? GROUP BY kind', runId)
  const byMint = q<{ mint: string; n: number }>("SELECT mint, COUNT(*) n FROM candidates WHERE run_id=? AND status='CANDIDATE' GROUP BY mint ORDER BY n DESC LIMIT 10", runId)
  const concentration = candTotal && byMint.length ? (byMint[0]!.n / Math.max(1, cand.find(c => c.status === 'CANDIDATE')?.n ?? 1)) : 0
  const positiveEpisodes = (summary['episodes'] as { total?: number } | undefined)?.total ?? 0
  const verdict = candTotal === 0 && (summary['counters'] as { circuitsEvaluated?: number } | undefined)?.circuitsEvaluated === 0 ? 'NOT_TESTED' : (localMatch > 0 && (sims.find(s => s.environment === 'MAINNET_RPC_SIMULATION')?.ok ?? 0) > 0 ? 'SIMULATED_CANDIDATE_EDGE' : (positiveEpisodes > 0 ? 'INCOMPLETE_EVIDENCE' : 'NO_VERIFIED_EDGE'))
  const lines: string[] = []
  lines.push(`# RUN_REPORT ${runId}`, '', `kind=${run['kind']} status=${run['status']} started=${run['started_utc']} ended=${run['ended_utc']} stop=${run['stop_reason']} config_hash=${String(run['config_hash']).slice(0, 16)}`, '')
  lines.push('## Counts (from the full SQLite journal)', '')
  lines.push(`candidates_total=${candTotal} ${cand.map(c => `${c.status}=${c.n}`).join(' ')}`)
  lines.push(`simulations: ${sims.map(s => `${s.environment}: n=${s.n} ok=${s.ok}`).join(' | ') || 'none'}`)
  lines.push(`mainnet_sim_error_classes: ${errClasses.map(e => `${e.cls ?? 'OK'}=${e.n}`).join(', ') || 'none'}`)
  lines.push(`local_real_program: ok=${localOk} quote_matched_exactly=${localMatch}`)
  lines.push(`events: ${events.map(e => `${e.kind}=${e.n}`).join(' ') || 'none'}`)
  lines.push(`candidate_concentration_top_mint_share=${concentration.toFixed(2)}`, '')
  lines.push('## Latency / RPC / WSS (from run summary)', '', '```', JSON.stringify({ latencyMs: summary['latencyMs'], rpc: summary['rpc'], wss: summary['wss'], counters: summary['counters'] }, null, 1), '```', '')
  lines.push('## Top candidates (QUOTE_ONLY unless simulated)', '', 'ts | mint | direction | amount_in | tx_pnl | single_batch', ...topCands.map(c => `${c.ts_utc} | ${c.mint.slice(0, 8)}.. | ${c.direction} | ${c.amount_in} | ${c.tx_pnl} | ${c.single_batch}`), '')
  lines.push('## Terminal summary', '', '```')
  lines.push(`SIMULATED_POSITIVE_EPISODES = ${positiveEpisodes}`, `MAINNET_SIM_ATTEMPTED / SUCCEEDED = ${sims.find(s => s.environment === 'MAINNET_RPC_SIMULATION')?.n ?? 0} / ${sims.find(s => s.environment === 'MAINNET_RPC_SIMULATION')?.ok ?? 0}`, `LOCAL_REAL_PROGRAM_OK / QUOTE_MATCH = ${localOk} / ${localMatch}`, `REALIZED_NET_PNL = NOT_OBSERVED`, `TRANSACTIONS_BROADCAST = 0`, `LIVE_TRADING_ENABLED = NO`, `ECONOMIC_VERDICT = ${verdict}`, '```', '')
  lines.push('Every probe is an independent hypothetical intervention on real state; probe sums are not a realised portfolio. Landing rate and competition cost are unknown before live and are not estimated here.')
  const dir = join(config.paths.reportsDir, runId); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'RUN_REPORT.md'), lines.join('\n'))
  console.log(lines.join('\n')); console.log(`\nwritten: ${join(dir, 'RUN_REPORT.md')}`)
  db.close(); return 0
}
