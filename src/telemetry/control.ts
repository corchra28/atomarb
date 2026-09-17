import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { monoMs } from '../util/time.js'
export interface Budgets { maxDurationMs: number; maxHttpRequests: number; maxDiskBytes: number; stopFile: string; dataDir: string }
export type StopReason = 'STOP_FILE' | 'DEADLINE' | 'HTTP_BUDGET' | 'DISK_BUDGET' | 'SIGNAL' | 'ERROR' | null
/** Controlled termination: STOP file, deadline, request/disk budgets, and OS signals. Checked between units of work, never mid-write. */
export class RunControl {
  private readonly start = monoMs()
  private signal: StopReason = null
  constructor(readonly b: Budgets) {
    const on = () => { this.signal = 'SIGNAL' }
    process.once('SIGINT', on); process.once('SIGTERM', on)
  }
  elapsedMs(): number { return monoMs() - this.start }
  check(httpRequests: number): StopReason {
    if (this.signal) return this.signal
    if (existsSync(this.b.stopFile)) return 'STOP_FILE'
    if (this.elapsedMs() >= this.b.maxDurationMs) return 'DEADLINE'
    if (httpRequests >= this.b.maxHttpRequests) return 'HTTP_BUDGET'
    if (dirSize(this.b.dataDir) >= this.b.maxDiskBytes) return 'DISK_BUDGET'
    return null
  }
}
export function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += dirSize(p); else if (e.isFile()) total += statSync(p).size
  }
  return total
}
