/** Observed wall-clock (UTC ISO) + monotonic durations. Never derive timestamps from slots. */
export function nowUtcIso(): string { return new Date().toISOString() }
export function monoMs(): number { return Number(process.hrtime.bigint() / 1_000_000n) }
export function monoNs(): bigint { return process.hrtime.bigint() }
export function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}
