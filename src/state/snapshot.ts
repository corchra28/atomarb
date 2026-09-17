import { PublicKey } from '@solana/web3.js'
import type { AccountBundle, AdapterId, DecodedPool, PoolAdapter, PoolRef, RawAccount } from '../adapters/types.js'
import { isUnsupported } from '../adapters/types.js'
import type { RpcClient } from './rpc.js'
import { sha256Hex } from '../util/hash.js'
export interface SnapshotOutcome { pool: PoolRef; decoded?: DecodedPool | undefined; status: 'OK' | 'UNSUPPORTED' | 'INVALID' | 'SNAPSHOT_INCOMPLETE' | 'STATE_INCONSISTENT'; reasons: string[]; warnings: string[] }
/** Deterministic state hash over the raw bytes + slots of every account the quote depends on, in a fixed order. */
export function stateHashOf(keys: PublicKey[], bundle: AccountBundle): string {
  const parts: string[] = []
  for (const k of keys) { const a = bundle.accounts.get(k.toBase58()); parts.push(`${k.toBase58()}:${a ? a.contextSlot : 'missing'}:${a ? sha256Hex(a.data) : '-'}`) }
  return sha256Hex(parts.join('|'))
}
/**
 * Two-step fetch: (1) pool accounts, (2) ONE getMultipleAccounts with all dependents of ALL pools of a route when they fit in 100 keys — so a route's quote is
 * computed from a single response context. If they do not fit, the bundle is marked as not single-batch and the outcome is SNAPSHOT_INCOMPLETE for atomic claims.
 */
export async function snapshotPools(rpc: RpcClient, adapters: Record<AdapterId, PoolAdapter>, pools: PoolRef[], opts: { requireSingleBatch: boolean }): Promise<{ outcomes: SnapshotOutcome[]; bundle: AccountBundle | null }> {
  const outcomes: SnapshotOutcome[] = []
  const poolKeys = pools.map(p => p.address)
  const first = await rpc.getAccountsBatched(poolKeys)
  const needed: PublicKey[] = []; const perPool = new Map<string, PublicKey[]>()
  for (const p of pools) {
    const acc = first.bundle.accounts.get(p.address.toBase58())
    if (!acc) { outcomes.push({ pool: p, status: 'INVALID', reasons: ['POOL_ACCOUNT_MISSING'], warnings: [] }); continue }
    const req = adapters[p.adapter].requiredAccounts(p, acc)
    if (isUnsupported(req)) { outcomes.push({ pool: p, status: 'UNSUPPORTED', reasons: [`${req.code}: ${req.reason}`], warnings: [] }); continue }
    perPool.set(p.address.toBase58(), req); for (const k of req) if (!needed.some(n => n.equals(k))) needed.push(k)
  }
  if (needed.length === 0) return { outcomes, bundle: null }
  const second = needed.length <= 100 ? (await rpc.getMultipleAccounts(needed)) : await rpc.getAccountsBatched(needed)
  const bundle = second.bundle
  for (const p of pools) {
    const req = perPool.get(p.address.toBase58()); if (!req) continue
    const missing = req.filter(k => !bundle.accounts.has(k.toBase58()))
    if (missing.length) { outcomes.push({ pool: p, status: 'INVALID', reasons: [`ACCOUNTS_MISSING:${missing.map(m => m.toBase58()).join(',')}`], warnings: [] }); continue }
    if (opts.requireSingleBatch && !bundle.singleBatch) { outcomes.push({ pool: p, status: 'SNAPSHOT_INCOMPLETE', reasons: ['MULTI_BATCH_SNAPSHOT: dependents did not fit one getMultipleAccounts'], warnings: [] }); continue }
    const decoded = adapters[p.adapter].decodeSnapshot(p, bundle)
    if (isUnsupported(decoded)) { outcomes.push({ pool: p, status: 'UNSUPPORTED', reasons: [`${decoded.code}: ${decoded.reason}`], warnings: [] }); continue }
    const v = adapters[p.adapter].validatePool(decoded)
    outcomes.push({ pool: p, decoded, status: v.ok ? 'OK' : 'INVALID', reasons: v.rejects.map(r => `${r.code}: ${r.detail}`), warnings: v.warnings.map(w => `${w.code}: ${w.detail}`) })
  }
  return { outcomes, bundle }
}
export function rawFromBundle(bundle: AccountBundle, key: PublicKey): RawAccount {
  const a = bundle.accounts.get(key.toBase58()); if (!a) throw new Error(`ACCOUNT_MISSING ${key.toBase58()}`); return a
}
