import { describe, it, expect } from 'vitest'
import { PublicKey, Keypair, TransactionInstruction, SystemProgram } from '@solana/web3.js'
import { buildV0, computeBudgetIxs, MAX_TX_BYTES } from '../../src/simulation/tx_build.js'
import { mainnetSimulate } from '../../src/simulation/probe.js'
import type { RpcClient } from '../../src/state/rpc.js'
const bh = '11111111111111111111111111111111'
describe('transaction limits and compute budget', () => {
  it('encodes SetComputeUnitLimit (0x02, u32) and SetComputeUnitPrice (0x03, u64) and reads them back from the compiled message', () => {
    const payer = Keypair.generate().publicKey
    const b = buildV0(payer, bh, [...computeBudgetIxs(400_000, 12_345), SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })])
    expect(b.inspection.computeUnitLimit).toBe(400_000)
    expect(b.inspection.computeUnitPriceMicroLamports).toBe(12_345n)
    expect(b.inspection.instructions[0]!.discriminatorHex.startsWith('02')).toBe(true)
    expect(b.inspection.instructions[1]!.discriminatorHex.startsWith('03')).toBe(true)
    expect(b.inspection.numSignatures).toBe(1)
    expect(b.inspection.withinSizeLimit).toBe(true)
  })
  it('flags a transaction over the 1232-byte limit instead of truncating it', () => {
    const payer = Keypair.generate().publicKey
    const keys = Array.from({ length: 40 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }))
    const big = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys, data: Buffer.alloc(200) })
    const b = buildV0(payer, bh, [big])
    expect(b.serializedBytes).toBeGreaterThan(MAX_TX_BYTES)
    expect(b.inspection.withinSizeLimit).toBe(false)
    expect(b.inspection.staticAccounts.length).toBe(42)
  })
  it('mainnet simulation refuses an oversized message before making any RPC call', async () => {
    const payer = Keypair.generate().publicKey
    const keys = Array.from({ length: 40 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }))
    const b = buildV0(payer, bh, [new TransactionInstruction({ programId: Keypair.generate().publicKey, keys, data: Buffer.alloc(200) })])
    let called = 0
    const rpc = { simulateTransaction: async () => { called++; throw new Error('must not be called') }, getFeeForMessage: async () => { called++; throw new Error('must not be called') } } as unknown as RpcClient
    const ua = { user: payer, baseAta: PublicKey.unique(), interAta: PublicKey.unique(), baseTokenProgram: PublicKey.unique(), interTokenProgram: PublicKey.unique() }
    const r = await mainnetSimulate(rpc, { built: b }, ua)
    expect(called).toBe(0)
    expect(r.errClass).toMatch(/TX_TOO_LARGE_NEEDS_ALT/)
    expect(r.errDetail.kind).toBe('TxTooLarge')
    expect(r.level).toBe('QUOTE_ONLY')   // not reported as a mainnet result
  })
  it('signer and writable flags of the compiled message match the instruction metas', () => {
    const payer = Keypair.generate().publicKey, ro = Keypair.generate().publicKey, rw = Keypair.generate().publicKey
    const b = buildV0(payer, bh, [new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: rw, isSigner: false, isWritable: true }, { pubkey: ro, isSigner: false, isWritable: false }], data: Buffer.alloc(4) })])
    const ix = b.inspection.instructions[0]!
    expect(ix.accounts.find(a => a.key === rw.toBase58())).toMatchObject({ writable: true, signer: false })
    expect(ix.accounts.find(a => a.key === ro.toBase58())).toMatchObject({ writable: false, signer: false })
    expect(b.inspection.staticAccounts[0]).toBe(payer.toBase58())
  })
})
