import { readFileSync } from 'node:fs'
import { ConfigSchema, type Config } from './schema.js'
import { hashJson } from '../util/hash.js'
export interface LoadedConfig { config: Config; configHash: string; path: string }
export function loadConfig(path: string): LoadedConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`CONFIG_INVALID ${path}: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const config = parsed.data
  if (config.execution.live !== false) throw new Error('LIVE_NOT_AUTHORIZED: execution.live must be false')
  return { config, configHash: hashJson(config), path }
}
/** Reads endpoint URLs from the environment only (never from files outside the project). */
export function resolveEndpoints(config: Config): { httpUrl: string; wssUrl: string | null } {
  const httpUrl = process.env[config.rpc.httpUrlEnv] ?? 'https://api.mainnet-beta.solana.com'
  const wssUrl = process.env[config.rpc.wssUrlEnv] ?? null
  return { httpUrl, wssUrl }
}
