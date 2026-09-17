import { readFileSync, statSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { PublicKey } from '@solana/web3.js'
import type { PoolRef } from '../adapters/types.js'
import { WSOL_MINT } from '../state/token.js'
import { sha256Hex } from '../util/hash.js'

/**
 * Reader for the local PumpSwap pool inventory (gzip JSONL, one record per line:
 * {pool, index, base_mint, quote_mint, canonical}) with its sibling `<name>.provenance.json`.
 * The inventory is ADDRESSES ONLY (data/inventory/pumpswap_pools.provenance.json: "addresses only; unverified until
 * decoded on-chain"); nothing here is used for pricing. Semantics of `index`/`canonical`: docs/sources/pumpswap.md §2
 * (index u16; canonical pools use index 0) and §7 (canonical pool rule) — carried as hints only.
 */
export interface InventoryProvenance {
  source_file?: string; source_sha256?: string; source_mtime_utc?: string; exported_at_utc?: string
  records_total?: number; records_kept_wsol_quote?: number; note?: string
}
export interface InventoryRecord { pool: string; index: number; base_mint: string; quote_mint: string; canonical: boolean }
export interface InventorySkip { line: number; reason: string; detail: string }
export interface InventoryReadResult {
  pools: PoolRef[]
  inventoryPath: string
  provenancePath: string | null
  provenance: InventoryProvenance | null
  /** sha256 of the gz file actually read */
  inventorySha256: string
  /** provenance.source_mtime_utc when present, else the inventory file's mtime (UTC ISO) */
  /** null when the provenance sidecar is missing: the age is then UNKNOWN and must be treated as stale */
  observedAtUtc: string | null
  fileMtimeUtc: string
  /** PoolRef.source.ref: provenance.source_sha256 when present, else the inventory file sha256 */
  sourceRef: string
  lines: number
  records: number
  skipped: InventorySkip[]
  /** addresses seen more than once (first occurrence kept) */
  duplicateAddresses: string[]
}
export const PUMPSWAP_INVENTORY_SOURCE_KIND = 'local_pumpswap_inventory'

export function provenancePathFor(inventoryPath: string): string {
  return inventoryPath.replace(/\.jsonl\.gz$/, '') + '.provenance.json'
}
function parseRecord(line: string): { rec: InventoryRecord } | { reason: string; detail: string } {
  let v: unknown
  try { v = JSON.parse(line) } catch (e) { return { reason: 'BAD_JSON', detail: (e as Error).message } }
  if (!v || typeof v !== 'object') return { reason: 'NOT_OBJECT', detail: line.slice(0, 80) }
  const o = v as Record<string, unknown>
  if (typeof o['pool'] !== 'string' || typeof o['base_mint'] !== 'string' || typeof o['quote_mint'] !== 'string') return { reason: 'MISSING_FIELDS', detail: Object.keys(o).join(',') }
  if (typeof o['index'] !== 'number' || !Number.isInteger(o['index']) || o['index'] < 0 || o['index'] > 0xffff) return { reason: 'BAD_INDEX', detail: String(o['index']) }
  if (typeof o['canonical'] !== 'boolean') return { reason: 'BAD_CANONICAL', detail: String(o['canonical']) }
  for (const k of ['pool', 'base_mint', 'quote_mint'] as const) {
    try { new PublicKey(o[k] as string) } catch { return { reason: 'BAD_PUBKEY', detail: `${k}=${String(o[k])}` } }
  }
  return { rec: { pool: o['pool'], index: o['index'], base_mint: o['base_mint'], quote_mint: o['quote_mint'], canonical: o['canonical'] } }
}
/**
 * Reads the gz JSONL inventory into PoolRef[] (adapter 'pumpswap'). Records whose quote mint is not `requireQuoteMint`
 * (WSOL by default), malformed lines and duplicate addresses are skipped and reported — never silently dropped.
 */
export function readPumpswapInventory(inventoryPath: string, opts: { requireQuoteMint?: string } = {}): InventoryReadResult {
  if (!existsSync(inventoryPath)) throw new Error(`INVENTORY_MISSING ${inventoryPath}`)
  const requireQuote = opts.requireQuoteMint ?? WSOL_MINT.toBase58()
  const gz = readFileSync(inventoryPath)
  const inventorySha256 = sha256Hex(gz)
  const text = gunzipSync(gz).toString('utf8')
  const provPath = provenancePathFor(inventoryPath)
  let provenance: InventoryProvenance | null = null
  if (existsSync(provPath)) {
    const p = JSON.parse(readFileSync(provPath, 'utf8')) as unknown
    provenance = p && typeof p === 'object' ? (p as InventoryProvenance) : null
  }
  const fileMtimeUtc = new Date(statSync(inventoryPath).mtimeMs).toISOString()
  // Age comes from the provenance sidecar. A file mtime is NOT provenance (a copy or a checkout resets it), so without the sidecar the age is unknown.
  const provenanceAgeKnown = typeof provenance?.source_mtime_utc === 'string'
  const observedAtUtc = provenanceAgeKnown ? new Date(provenance!.source_mtime_utc as string).toISOString() : null
  void fileMtimeUtc
  const sourceRef = typeof provenance?.source_sha256 === 'string' ? provenance.source_sha256 : inventorySha256
  const pools: PoolRef[] = []; const skipped: InventorySkip[] = []; const seen = new Set<string>(); const duplicateAddresses: string[] = []
  let lines = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim(); if (line === '') continue
    lines++
    const parsed = parseRecord(line)
    if (!('rec' in parsed)) { skipped.push({ line: lines, reason: parsed.reason, detail: parsed.detail }); continue }
    const r = parsed.rec
    if (r.quote_mint !== requireQuote) { skipped.push({ line: lines, reason: 'QUOTE_NOT_REQUIRED_MINT', detail: `${r.pool} quote=${r.quote_mint}` }); continue }
    if (r.base_mint === r.quote_mint) { skipped.push({ line: lines, reason: 'BASE_EQUALS_QUOTE', detail: r.pool }); continue }
    if (seen.has(r.pool)) { duplicateAddresses.push(r.pool); continue }
    seen.add(r.pool)
    pools.push({
      adapter: 'pumpswap', address: new PublicKey(r.pool),
      source: { kind: PUMPSWAP_INVENTORY_SOURCE_KIND, ref: sourceRef, observedAtUtc: observedAtUtc ?? 'UNKNOWN (no provenance sidecar)' },
      hints: { base_mint: r.base_mint, quote_mint: r.quote_mint, index: r.index, canonical: r.canonical, tvl: null, liquidityHint: 'unknown' },
    })
  }
  return { pools, inventoryPath, provenancePath: existsSync(provPath) ? provPath : null, provenance, inventorySha256, observedAtUtc, fileMtimeUtc, sourceRef, lines, records: pools.length, skipped, duplicateAddresses }
}
/** Groups PumpSwap PoolRefs by their base mint hint (insertion order preserved; deterministic for a given file). */
export function groupByBaseMint(pools: PoolRef[]): Map<string, PoolRef[]> {
  const m = new Map<string, PoolRef[]>()
  for (const p of pools) {
    const base = p.hints?.['base_mint']; if (typeof base !== 'string') continue
    const arr = m.get(base); if (arr) arr.push(p); else m.set(base, [p])
  }
  return m
}
/** Age of the inventory in days relative to `nowUtc` (fractional, 1 decimal). */
export function inventoryAgeDays(observedAtUtc: string | null, nowUtc: string): number | null {
  if (!observedAtUtc) return null
  return Math.round(((Date.parse(nowUtc) - Date.parse(observedAtUtc)) / 86_400_000) * 10) / 10
}
