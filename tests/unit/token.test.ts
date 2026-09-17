import { describe, it, expect } from 'vitest'
import { PublicKey, Keypair } from '@solana/web3.js'
import { parseMint, parseTokenAccount, transferFeeOn, transferFeeInverse, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, EXT } from '../../src/state/token.js'
import { writeU64LE, writeU16LE, writeU32LE, concatBytes } from '../../src/util/bytes.js'
import type { RawAccount } from '../../src/adapters/types.js'
const raw = (pk: PublicKey, owner: PublicKey, data: Uint8Array): RawAccount => ({ pubkey: pk, owner, data, lamports: 1n, executable: false, contextSlot: 1, receivedAtUtc: 'x', receivedMonoMs: 0, batchId: 'b', provider: 'local_fixture' })
function mintBytes(decimals: number, supply: bigint, freeze: PublicKey | null): Uint8Array {
  const b = new Uint8Array(82); b.set(writeU32LE(0), 0); b.set(writeU64LE(supply), 36); b[44] = decimals; b[45] = 1
  if (freeze) { b.set(writeU32LE(1), 46); b.set(freeze.toBytes(), 50) }
  return b
}
function tokenAccountBytes(mint: PublicKey, owner: PublicKey, amount: bigint, state = 1): Uint8Array {
  const b = new Uint8Array(165); b.set(mint.toBytes(), 0); b.set(owner.toBytes(), 32); b.set(writeU64LE(amount), 64); b[108] = state; return b
}
describe('SPL token parsing', () => {
  const mint = Keypair.generate().publicKey, owner = Keypair.generate().publicKey, fz = Keypair.generate().publicKey
  it('parses mint with freeze authority', () => { const m = parseMint(raw(mint, TOKEN_PROGRAM_ID, mintBytes(6, 1_000_000n, fz))); expect(m.decimals).toBe(6); expect(m.supply).toBe(1_000_000n); expect(m.freezeAuthority?.equals(fz)).toBe(true); expect(m.program).toBe('spl_token') })
  it('parses token account and frozen state', () => { const a = parseTokenAccount(raw(owner, TOKEN_PROGRAM_ID, tokenAccountBytes(mint, owner, 42n, 2))); expect(a.amount).toBe(42n); expect(a.state).toBe(2); expect(a.mint.equals(mint)).toBe(true) })
  it('rejects wrong owner program', () => { expect(() => parseMint(raw(mint, Keypair.generate().publicKey, mintBytes(6, 1n, null)))).toThrow(/MINT_OWNER_UNKNOWN/) })
  it('rejects wrong length for spl_token', () => { expect(() => parseMint(raw(mint, TOKEN_PROGRAM_ID, new Uint8Array(90)))).toThrow(/UNEXPECTED_LEN/) })
})
describe('Token-2022 TLV', () => {
  const mint = Keypair.generate().publicKey
  it('parses transfer fee config and non-transferable', () => {
    const base = new Uint8Array(165); base.set(mintBytes(9, 5n, null), 0); base[165 - 165] = base[0]!
    const typeByte = new Uint8Array([1])
    const tf = new Uint8Array(108); tf.set(writeU64LE(10n), 72); tf.set(writeU64LE(1000n), 80); tf.set(writeU16LE(100), 88); tf.set(writeU64LE(11n), 90); tf.set(writeU64LE(5000n), 98); tf.set(writeU16LE(250), 106)
    const tlv = concatBytes(writeU16LE(EXT.TransferFeeConfig), writeU16LE(108), tf, writeU16LE(EXT.NonTransferable), writeU16LE(0))
    const data = concatBytes(base, typeByte, tlv)
    const m = parseMint(raw(mint, TOKEN_2022_PROGRAM_ID, data))
    expect(m.program).toBe('token_2022'); expect(m.extensions).toEqual([EXT.TransferFeeConfig, EXT.NonTransferable]); expect(m.transferFee).toEqual({ bps: 250, maxFee: 5000n, epoch: 11n })
  })
  it('transfer fee math: ceil and cap; inverse restores net', () => {
    expect(transferFeeOn(10_000n, { bps: 250, maxFee: 5000n })).toBe(250n)
    expect(transferFeeOn(10_001n, { bps: 250, maxFee: 5000n })).toBe(251n)
    expect(transferFeeOn(10_000_000n, { bps: 250, maxFee: 5000n })).toBe(5000n)
    expect(transferFeeOn(1n, undefined)).toBe(0n)
    for (const net of [1n, 999n, 10_000n, 123_457n]) { const fee = transferFeeInverse(net, { bps: 250, maxFee: 1n << 60n }); expect(net + fee - transferFeeOn(net + fee, { bps: 250, maxFee: 1n << 60n })).toBeGreaterThanOrEqual(net) }
  })
})
