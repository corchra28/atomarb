import * as nodeFs from 'node:fs'
import type { LoadedConfig } from '../config/load.js'
import type { JsonlLogger } from '../telemetry/log.js'
import { runDiscovery } from '../discovery/index.js'

/**
 * `atomarb discover [--config f] [--max-pools N] [--max-mints N] [--no-network] [--cap N] [--api-budget N] [--page-size N] [--max-pools-per-mint N] [--cross-check] [--reuse-list] [--inventory path]`
 * Population discovery: Raydium API v3 (HTTPS only) + local PumpSwap inventory → reports/population_<utc>.{json,md} and
 * data/discovery/shortlist.json. NEVER calls Solana RPC (no RPC client is constructed here; tests grep for it). Exit 0 on success.
 */
function intFlag(flags: Record<string, string | true>, name: string): number | undefined {
  const v = flags[name]; if (v === undefined) return undefined
  if (v === true || !/^\d+$/.test(v)) throw new Error(`--${name} needs a positive integer`)
  return Number(v)
}
/** Refuses a second concurrent run: two clients would double the self-imposed 2 req/s against the same public API (review finding). */
function acquireLock(dir: string): () => void {
  const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = nodeFs
  mkdirSync(dir, { recursive: true })
  const lock = `${dir}/.discover.lock`
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim())
    let alive = false
    try { process.kill(pid, 0); alive = pid !== process.pid } catch { alive = false }
    if (alive) throw new Error(`DISCOVER_ALREADY_RUNNING: pid ${pid} holds ${lock} (two runs would double the API rate); wait for it or remove the file if the process is gone`)
    rmSync(lock)
  }
  writeFileSync(lock, String(process.pid))
  return () => { try { rmSync(lock) } catch { /* already gone */ } }
}
export async function discover(loaded: LoadedConfig, flags: Record<string, string | true>, log: JsonlLogger): Promise<number> {
  const { config } = loaded
  const network = flags['no-network'] !== true
  const maxPools = intFlag(flags, 'max-pools'); const maxMints = intFlag(flags, 'max-mints'); const listCap = intFlag(flags, 'cap'); const pageSize = intFlag(flags, 'page-size'); const maxPoolsPerMint = intFlag(flags, 'max-pools-per-mint'); const apiBudget = intFlag(flags, 'api-budget')
  const inventoryPath = typeof flags['inventory'] === 'string' ? flags['inventory'] : undefined
  const release = network ? acquireLock(`${config.paths.dataDir}/discovery`) : () => {}
  try {
  const res = await runDiscovery(config, {
    network, log,
    ...(maxPools !== undefined ? { maxPools } : {}), ...(maxMints !== undefined ? { maxMints } : {}), ...(listCap !== undefined ? { listCap } : {}), ...(pageSize !== undefined ? { pageSize } : {}), ...(maxPoolsPerMint !== undefined ? { maxPoolsPerMint } : {}), ...(apiBudget !== undefined ? { apiBudget } : {}),
    ...(inventoryPath !== undefined ? { inventoryPath } : {}), crossCheckInfoMint: flags['cross-check'] === true, reuseListCache: flags['reuse-list'] === true,
  })
  const c = res.report.counts; const ray = res.report.sources['raydium_api_v3'] as Record<string, unknown> | undefined
  const rows: [string, string][] = [
    ['config', `${loaded.path} hash=${loaded.configHash.slice(0, 16)}`],
    ['network', network ? `yes (HTTPS api-v3.raydium.io only; no RPC)${flags['reuse-list'] === true ? ' listing reused from cache' : ''}` : 'no (cache only; no HTTP)'],
    ['api_requests', String(res.apiRequests)],
    ['sources', res.sourcesUsed.join(',') || 'none'],
    ['raydium_listed', ray ? `${String(ray['listedStandard'])} Standard WSOL pools in ${String(ray['pages'])} pages, capped=${String(ray['capped'])} (${String(ray['stoppedReason'])})` : 'n/a'],
    ['raydium_cpmm_wsol', String(c.raydium_cpmm_wsol_pools)],
    ['pumpswap_wsol', `${c.pumpswap_wsol_pools} pools / ${c.pumpswap_mints} mints${res.inventory ? ` (inventory ${String((res.report.sources['local_pumpswap_inventory'] as Record<string, unknown>)['ageDays'])} days old)` : ''}`],
    ['cat_a_pumpswap_x2', `${c.pumpswap_mints_with_2plus} mints / ${c.routes_pumpswap_x2} routes`],
    ['cat_b_cross', `${c.cross_adapter_mints} mints / ${c.routes_cross_adapter} routes`],
    ['cat_c_raydium_x2', `${c.raydium_mints_with_2plus} mints / ${c.routes_raydium_x2} routes`],
    ['dedup', `dup_addr=${c.duplicate_addresses} pair_collisions=${c.pair_collisions} not_wsol=${c.excluded_not_wsol_pair}`],
    ['shortlist', `${c.shortlist_pools} pools / ${c.shortlist_routes} routes / ${c.shortlist_mints} mints (maxPools=${res.report.limits.maxPools})`],
    ['report', `${res.reportJsonPath} + .md`],
    ['shortlist_file', res.shortlistPath],
  ]
  for (const [k, v] of rows) console.log(`${k.padEnd(20)} ${v}`)
  for (const w of res.report.warnings) console.log(`WARNING              ${w}`)
  return 0
  } finally { release() }
}
