import { describe, it, expect } from 'vitest'
import { ceilDiv, floorDiv, mulDivFloor, mulDivCeil, assertU64, OverflowError, U64_MAX } from '../../src/util/bigint.js'
import { readU64LE, writeU64LE, readU16LE, readI64LE, readU128LE } from '../../src/util/bytes.js'
import { canonicalJson, hashJson } from '../../src/util/hash.js'
import { redact } from '../../src/telemetry/log.js'
describe('bigint helpers', () => {
  it('ceil/floor division', () => { expect(ceilDiv(7n, 2n)).toBe(4n); expect(floorDiv(7n, 2n)).toBe(3n); expect(ceilDiv(8n, 2n)).toBe(4n); expect(ceilDiv(0n, 5n)).toBe(0n) })
  it('mulDiv rounding', () => { expect(mulDivFloor(10n, 3n, 4n)).toBe(7n); expect(mulDivCeil(10n, 3n, 4n)).toBe(8n) })
  it('u64 bounds', () => { expect(assertU64(U64_MAX)).toBe(U64_MAX); expect(() => assertU64(U64_MAX + 1n)).toThrow(OverflowError); expect(() => assertU64(-1n)).toThrow(OverflowError) })
  it('u128 overflow in mulDiv is detected', () => { expect(() => mulDivFloor(1n << 100n, 1n << 100n, 1n)).toThrow(OverflowError) })
})
describe('byte readers', () => {
  it('u64 roundtrip', () => { for (const v of [0n, 1n, 255n, 1n << 32n, U64_MAX]) expect(readU64LE(writeU64LE(v), 0)).toBe(v) })
  it('i64 negative', () => { expect(readI64LE(writeU64LE(U64_MAX), 0)).toBe(-1n) })
  it('u16 and u128', () => { const b = new Uint8Array(16); b[0] = 0x34; b[1] = 0x12; expect(readU16LE(b, 0)).toBe(0x1234); b.fill(0); b[8] = 1; expect(readU128LE(b, 0)).toBe(1n << 64n) })
  it('bounds checked', () => { expect(() => readU64LE(new Uint8Array(4), 0)).toThrow(RangeError) })
})
describe('hashing and redaction', () => {
  it('canonical json is key-order independent and bigint safe', () => { expect(canonicalJson({ b: 1n, a: [2n] })).toBe(canonicalJson({ a: [2n], b: 1n })); expect(hashJson({ a: 1 })).toHaveLength(64) })
  it('redacts api keys in urls', () => {
    expect(redact('https://rpc.example.com/?api-key=abcdef123456')).not.toContain('abcdef123456')
    expect(redact('https://mainnet.helius-rpc.com/abcdefghijklmnopqrstuvwxyz0123')).not.toContain('abcdefghijklmnopqrstuvwxyz0123')
    expect(redact('https://api.mainnet-beta.solana.com')).toBe('https://api.mainnet-beta.solana.com')
  })
})
