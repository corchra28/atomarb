import type { AdapterId, PoolAdapter } from './types.js'
/** Loads the adapters that exist in the build. A missing adapter is reported, never silently mocked. */
export async function loadAdapters(): Promise<{ adapters: Partial<Record<AdapterId, PoolAdapter>>; missing: { id: AdapterId; error: string }[] }> {
  const adapters: Partial<Record<AdapterId, PoolAdapter>> = {}
  const missing: { id: AdapterId; error: string }[] = []
  for (const id of ['pumpswap', 'raydium_cpmm'] as AdapterId[]) {
    const spec = ['.', id, 'index.js'].join('/')
    try {
      const m = (await import(spec)) as Record<string, unknown>
      const cand = [m['adapter'], m['default'], ...Object.values(m)].find(v => v && typeof v === 'object' && (v as PoolAdapter).id === id && typeof (v as PoolAdapter).quoteExactIn === 'function')
      if (!cand) throw new Error(`module ${spec} exports no PoolAdapter with id=${id}`)
      adapters[id] = cand as PoolAdapter
    } catch (e) { missing.push({ id, error: (e as Error).message }) }
  }
  return { adapters, missing }
}
export function requireAdapters(a: Partial<Record<AdapterId, PoolAdapter>>): Record<AdapterId, PoolAdapter> {
  if (!a.pumpswap || !a.raydium_cpmm) throw new Error(`ADAPTERS_MISSING: ${['pumpswap', 'raydium_cpmm'].filter(k => !a[k as AdapterId]).join(',')}`)
  return a as Record<AdapterId, PoolAdapter>
}
