import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { nowUtcIso, monoMs } from '../util/time.js'
import { jsonReplacer } from '../util/bigint.js'
/** Redacts API keys / tokens from URLs and strings before anything is logged or exported. */
export function redact(s: string): string {
  return s
    .replace(/(api[-_]?key|apikey|token|key|secret|auth)=([^&\s"']+)/gi, '$1=<redacted>')
    .replace(/(https?:\/\/[^\s"'/]+\/)([A-Za-z0-9_-]{16,})(?=[/\s"']|$)/g, '$1<redacted>')
    .replace(/(wss?:\/\/[^\s"'/]+\/)([A-Za-z0-9_-]{16,})(?=[/\s"']|$)/g, '$1<redacted>')
}
export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as unknown as T
  if (Array.isArray(v)) return v.map(redactDeep) as unknown as T
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = redactDeep(x)
    return o as T
  }
  return v
}
export type Level = 'debug' | 'info' | 'warn' | 'error'
export class JsonlLogger {
  private readonly path: string | null
  private readonly stderr: boolean
  private readonly minLevel: number
  private static readonly order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }
  constructor(opts: { path?: string | null; stderr?: boolean; minLevel?: Level }) {
    this.path = opts.path ?? null
    this.stderr = opts.stderr ?? true
    this.minLevel = JsonlLogger.order[opts.minLevel ?? 'info']
    if (this.path) mkdirSync(dirname(this.path), { recursive: true })
  }
  log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
    if (JsonlLogger.order[level] < this.minLevel) return
    const rec = redactDeep({ ts: nowUtcIso(), mono_ms: monoMs(), level, event, ...fields })
    const line = JSON.stringify(rec, jsonReplacer)
    if (this.path) appendFileSync(this.path, line + '\n')
    if (this.stderr) process.stderr.write(line + '\n')
  }
  debug(e: string, f?: Record<string, unknown>): void { this.log('debug', e, f) }
  info(e: string, f?: Record<string, unknown>): void { this.log('info', e, f) }
  warn(e: string, f?: Record<string, unknown>): void { this.log('warn', e, f) }
  error(e: string, f?: Record<string, unknown>): void { this.log('error', e, f) }
}
