import type { LoadedConfig } from '../config/load.js'
import type { JsonlLogger } from '../telemetry/log.js'
export async function discover(_loaded: LoadedConfig, _flags: Record<string, string | true>, _log: JsonlLogger): Promise<number> {
  console.error('NOT_IMPLEMENTED: discover (adapters pending)')
  return 3
}
