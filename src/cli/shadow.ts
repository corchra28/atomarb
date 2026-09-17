import type { LoadedConfig } from '../config/load.js'
import type { JsonlLogger } from '../telemetry/log.js'
export async function shadow(_loaded: LoadedConfig, _flags: Record<string, string | true>, _log: JsonlLogger): Promise<number> {
  console.error('NOT_IMPLEMENTED: shadow (adapters pending)')
  return 3
}
