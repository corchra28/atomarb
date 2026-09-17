import type { LoadedConfig } from '../config/load.js'
import type { JsonlLogger } from '../telemetry/log.js'
export async function quote(_loaded: LoadedConfig, _flags: Record<string, string | true>, _log: JsonlLogger): Promise<number> {
  console.error('NOT_IMPLEMENTED: quote (adapters pending)')
  return 3
}
