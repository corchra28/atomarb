import { createHash } from 'node:crypto'
import { jsonReplacer } from './bigint.js'
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}
/** Canonical JSON (sorted keys, bigint as string) for stable hashing of configs and states. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), jsonReplacer)
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k])
    return o
  }
  return v
}
export function hashJson(value: unknown): string { return sha256Hex(canonicalJson(value)) }
