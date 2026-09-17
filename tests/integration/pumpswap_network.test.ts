/**
 * Network smoke test (READ-ONLY, public mainnet RPC). Skipped unless ATOMARB_NETWORK_TESTS=1. Uses at most 3 HTTP requests:
 * pool → requiredAccounts → one getMultipleAccounts → decodeSnapshot + validatePool + quote; then getFeeForMessage on a built (unsigned) v0 tx.
 */
import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { RpcClient } from '../../src/state/rpc.js'
import { snapshotPools } from '../../src/state/snapshot.js'
import { buildV0 } from '../../src/simulation/tx_build.js'
import { WSOL_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, associatedTokenAddress } from '../../src/state/token.js'
import { isUnsupported, type PoolRef, type AdapterId, type PoolAdapter } from '../../src/adapters/types.js'
import { pumpswapAdapter, pumpswapParams } from '../../src/adapters/pumpswap/index.js'
import { MockAdapter } from '../helpers/mock_adapter.js'

const enabled = process.env['ATOMARB_NETWORK_TESTS'] === '1'
const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com'

describe.skipIf(!enabled)('pumpswap network smoke (ATOMARB_NETWORK_TESTS=1, <= 3 RPC requests)', () => {
  it('snapshots + validates + quotes the boosted pool from live mainnet state and prices an unsigned buy tx', async () => {
    const rpc = new RpcClient(RPC_URL, { maxRequestsPerSecond: 4, maxConcurrentRequests: 2, maxTotalHttpRequests: 3, requestTimeoutMs: 20_000, backoff: { baseMs: 1000, maxMs: 10_000, jitter: 0.3 } }, 'confirmed')
    const ref: PoolRef = { adapter: 'pumpswap', address: new PublicKey('FruHjS1iY2rR1vdcx7fRXKQmQh7BAGMqNhtqJCtQZLiz'), source: { kind: 'note', ref: 'docs/sources/pumpswap.md §2', observedAtUtc: new Date().toISOString() } }
    const adapters: Record<AdapterId, PoolAdapter> = { pumpswap: pumpswapAdapter, raydium_cpmm: new MockAdapter('raydium_cpmm') }
    const { outcomes } = await snapshotPools(rpc, adapters, [ref], { requireSingleBatch: true })
    expect(outcomes).toHaveLength(1)
    const o = outcomes[0]!
    console.log(`network outcome: ${o.status} ${o.reasons.join(';')} warnings=${o.warnings.join(';')} rpc=${rpc.usage.total}`)
    expect(o.status).toBe('OK'); if (!o.decoded) throw new Error('no decoded')
    const P = pumpswapParams(o.decoded)
    expect(P.canonical).toBe(true); expect(o.decoded.snapshot.singleBatch).toBe(true)
    const q = pumpswapAdapter.quoteExactIn(o.decoded, WSOL_MINT, 10_000_000n); if (isUnsupported(q)) throw new Error(q.reason)
    expect(q.rejectReasons).toEqual([]); expect(q.amountOutToUser > 0n).toBe(true)
    const user = new PublicKey(Buffer.alloc(32, 7)) // simulation identity only; never signs
    const baseTp = o.decoded.mintA.program === 'token_2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    const ix = pumpswapAdapter.buildSwapInstruction(o.decoded, { user, userInputAccount: associatedTokenAddress(user, WSOL_MINT, TOKEN_PROGRAM_ID), userOutputAccount: associatedTokenAddress(user, o.decoded.mintA.mint, baseTp), amountIn: q.amountIn, minimumAmountOut: q.amountOutToUser })
    if (isUnsupported(ix)) throw new Error(ix.reason)
    const built = buildV0(user, '11111111111111111111111111111111', [ix.instruction])
    expect(built.inspection.withinSizeLimit).toBe(true); expect(built.inspection.instructions[0]!.accounts).toHaveLength(26)
    console.log(`quote: in=${q.amountIn} out=${q.amountOutToUser} fees=${q.fees.map(f => `${f.name}=${f.amount}`).join(',')} tier=${P.feeSchedule?.source} slot=${o.decoded.snapshot.maxSlot} tx=${built.serializedBytes}B rpc=${rpc.usage.total}`)
    expect(rpc.usage.total).toBeLessThanOrEqual(3)
  })
})
