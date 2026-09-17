import { statfsSync } from 'node:fs'
import type { LoadedConfig } from '../config/load.js'
import { resolveEndpoints } from '../config/load.js'
import { RpcClient } from '../state/rpc.js'
import type { JsonlLogger } from '../telemetry/log.js'
import { redact } from '../telemetry/log.js'
export async function doctor(loaded: LoadedConfig, log: JsonlLogger): Promise<number> {
  const { config, configHash } = loaded
  const rows: [string, string][] = []
  rows.push(['node', process.version], ['config', `${loaded.path} hash=${configHash.slice(0, 16)}`], ['live_trading', String(config.execution.live)])
  const ep = resolveEndpoints(config)
  rows.push(['rpc_http', redact(ep.httpUrl)], ['rpc_wss', ep.wssUrl ? redact(ep.wssUrl) : 'NOT_SET (shadow mode will poll via HTTP only)'])
  try { const s = statfsSync('.'); rows.push(['disk_free_gib', (Number(s.bavail) * Number(s.bsize) / 1024 ** 3).toFixed(1)]) } catch { rows.push(['disk_free_gib', 'unknown']) }
  try { const { DatabaseSync } = await import('node:sqlite'); new DatabaseSync(':memory:').close(); rows.push(['node_sqlite', 'ok']) } catch (e) { rows.push(['node_sqlite', `FAIL ${(e as Error).message}`]) }
  try { const l = await import('litesvm'); new l.LiteSVM(); rows.push(['litesvm', 'ok']) } catch (e) { rows.push(['litesvm', `FAIL ${(e as Error).message}`]) }
  const rpc = new RpcClient(ep.httpUrl, { ...config.rpc, maxTotalHttpRequests: 5 }, config.rpc.commitment, log)
  try { const v = await rpc.getVersion(); const slot = await rpc.getSlot(); rows.push(['rpc_version', v['solana-core']], ['rpc_slot', String(slot)]) } catch (e) { rows.push(['rpc', `FAIL ${redact((e as Error).message)}`]) }
  try { await rpc.call('sendTransaction', []); rows.push(['send_guard', 'FAIL: sendTransaction was not blocked']) } catch (e) { rows.push(['send_guard', /LIVE_NOT_AUTHORIZED/.test((e as Error).message) ? 'ok (sendTransaction blocked)' : `unexpected ${(e as Error).message}`]) }
  for (const [k, v] of rows) console.log(`${k.padEnd(16)} ${v}`)
  return rows.some(r => r[1].startsWith('FAIL')) ? 1 : 0
}
