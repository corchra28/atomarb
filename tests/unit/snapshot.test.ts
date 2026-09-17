import { describe, it, expect } from 'vitest'
import { PublicKey, Keypair } from '@solana/web3.js'
import { snapshotPools, stateHashOf } from '../../src/state/snapshot.js'
import type { AccountBundle, PoolAdapter, PoolRef, RawAccount, DecodedPool } from '../../src/adapters/types.js'
import type { RpcClient } from '../../src/state/rpc.js'
import { mockPool } from '../helpers/mock_adapter.js'
import { WSOL_MINT } from '../../src/state/token.js'
const raw = (pk: PublicKey, slot: number, batchId: string, data = new Uint8Array([1])): RawAccount => ({ pubkey: pk, owner: PublicKey.default, data, lamports: 1n, executable: false, contextSlot: slot, receivedAtUtc: 'u', receivedMonoMs: 0, batchId, provider: 'stub' })
function bundle(accs: RawAccount[], singleBatch: boolean): AccountBundle {
  const m = new Map(accs.map(a => [a.pubkey.toBase58(), a]))
  const slots = accs.map(a => a.contextSlot)
  return { accounts: m, singleBatch, minSlot: Math.min(...slots), maxSlot: Math.max(...slots), batchIds: [...new Set(accs.map(a => a.batchId))] }
}
/** Adapter whose pool needs two dependent accounts; decoding succeeds only when both are present. */
function stubAdapter(dep: PublicKey[], token: PublicKey): PoolAdapter {
  return {
    id: 'pumpswap', programId: PublicKey.default,
    requiredAccounts: (p: PoolRef) => [p.address, ...dep],
    decodeSnapshot: (p: PoolRef, b: AccountBundle): DecodedPool => {
      const keys = [p.address, ...dep]
      const d = mockPool('pumpswap', token, 1_000n, 1_000n, 25, p.address)
      return { ...d, dependsOn: keys, stateHash: stateHashOf(keys, b), snapshot: { minSlot: b.minSlot, maxSlot: b.maxSlot, singleBatch: b.singleBatch, batchIds: b.batchIds, receivedAtUtc: 'u' } }
    },
    validatePool: () => ({ ok: true, rejects: [], warnings: [] }),
    quoteExactIn: () => ({ status: 'UNSUPPORTED', code: 'NOT_NEEDED', reason: 'stub' }),
    applySwap: () => ({ status: 'UNSUPPORTED', code: 'NOT_NEEDED', reason: 'stub' }),
    buildSwapInstruction: () => ({ status: 'UNSUPPORTED', code: 'NOT_NEEDED', reason: 'stub' }),
  } as unknown as PoolAdapter
}
describe('snapshot service', () => {
  const pool = Keypair.generate().publicKey, dep1 = Keypair.generate().publicKey, dep2 = Keypair.generate().publicKey, token = Keypair.generate().publicKey
  const ref: PoolRef = { adapter: 'pumpswap', address: pool, source: { kind: 't', ref: 't', observedAtUtc: 'u' } }
  const adapters = { pumpswap: stubAdapter([dep1, dep2], token), raydium_cpmm: stubAdapter([dep1], token) } as unknown as Record<'pumpswap' | 'raydium_cpmm', PoolAdapter>
  it('refuses to call a multi-response fetch an atomic snapshot when requireSingleBatch is set', async () => {
    const rpc = {
      getAccountsBatched: async (keys: PublicKey[]) => ({ bundle: bundle(keys.map((k, i) => raw(k, 100 + i, `b${i}`)), false), missing: [] }),
      getMultipleAccounts: async (keys: PublicKey[]) => ({ bundle: bundle(keys.map(k => raw(k, 100, 'single')), true), context: { slot: 100 }, missing: [] }),
    } as unknown as RpcClient
    // dependents fit in one call -> single batch -> OK
    const ok = await snapshotPools(rpc, adapters, [ref], { requireSingleBatch: true })
    expect(ok.outcomes[0]!.status).toBe('OK')
    expect(ok.outcomes[0]!.decoded!.snapshot.singleBatch).toBe(true)
    // same call, but the stub now answers with two batches (as it would for >100 keys)
    const split = { ...rpc, getMultipleAccounts: async (keys: PublicKey[]) => ({ bundle: bundle(keys.map((k, i) => raw(k, 100 + i, `b${i}`)), false), context: { slot: 100 }, missing: [] }) } as unknown as RpcClient
    const bad = await snapshotPools(split, adapters, [ref], { requireSingleBatch: true })
    expect(bad.outcomes[0]!.status).toBe('SNAPSHOT_INCOMPLETE')
    expect(bad.outcomes[0]!.reasons[0]).toMatch(/MULTI_BATCH_SNAPSHOT/)
    const tolerated = await snapshotPools(split, adapters, [ref], { requireSingleBatch: false })
    expect(tolerated.outcomes[0]!.status).toBe('OK')
    expect(tolerated.outcomes[0]!.decoded!.snapshot.singleBatch).toBe(false)   // still recorded honestly
  })
  it('reports a missing dependent instead of decoding a partial state', async () => {
    const rpc = {
      getAccountsBatched: async (keys: PublicKey[]) => ({ bundle: bundle(keys.map(k => raw(k, 7, 'x')), true), missing: [] }),
      getMultipleAccounts: async (keys: PublicKey[]) => ({ bundle: bundle(keys.filter(k => !k.equals(dep2)).map(k => raw(k, 7, 'x')), true), context: { slot: 7 }, missing: [dep2] }),
    } as unknown as RpcClient
    const r = await snapshotPools(rpc, adapters, [ref], { requireSingleBatch: true })
    expect(r.outcomes[0]!.status).toBe('INVALID')
    expect(r.outcomes[0]!.reasons[0]).toMatch(/ACCOUNTS_MISSING/)
  })
  it('the state hash changes when any dependent byte or slot changes, and is order-stable', () => {
    const keys = [pool, dep1, dep2]
    const b1 = bundle([raw(pool, 5, 'a'), raw(dep1, 5, 'a'), raw(dep2, 5, 'a')], true)
    const b2 = bundle([raw(dep2, 5, 'a'), raw(dep1, 5, 'a'), raw(pool, 5, 'a')], true)     // same content, inserted in another order
    expect(stateHashOf(keys, b1)).toBe(stateHashOf(keys, b2))
    const changedData = bundle([raw(pool, 5, 'a'), raw(dep1, 5, 'a', new Uint8Array([2])), raw(dep2, 5, 'a')], true)
    expect(stateHashOf(keys, changedData)).not.toBe(stateHashOf(keys, b1))
    const changedSlot = bundle([raw(pool, 6, 'a'), raw(dep1, 5, 'a'), raw(dep2, 5, 'a')], true)
    expect(stateHashOf(keys, changedSlot)).not.toBe(stateHashOf(keys, b1))
    const missing = bundle([raw(pool, 5, 'a'), raw(dep1, 5, 'a')], true)
    expect(stateHashOf(keys, missing)).not.toBe(stateHashOf(keys, b1))
    expect(WSOL_MINT.toBase58()).toBe('So11111111111111111111111111111111111111112')
  })
})
