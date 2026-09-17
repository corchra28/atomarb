import { PublicKey } from '@solana/web3.js'
/** Little-endian readers with bounds checks. Offsets are absolute within `buf`. */
export function readU8(buf: Uint8Array, off: number): number {
  if (off + 1 > buf.length) throw new RangeError(`readU8 @${off} beyond ${buf.length}`)
  return buf[off]!
}
export function readU16LE(buf: Uint8Array, off: number): number {
  if (off + 2 > buf.length) throw new RangeError(`readU16 @${off} beyond ${buf.length}`)
  return buf[off]! | (buf[off + 1]! << 8)
}
export function readU32LE(buf: Uint8Array, off: number): number {
  if (off + 4 > buf.length) throw new RangeError(`readU32 @${off} beyond ${buf.length}`)
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16)) + buf[off + 3]! * 0x1000000
}
export function readU64LE(buf: Uint8Array, off: number): bigint {
  if (off + 8 > buf.length) throw new RangeError(`readU64 @${off} beyond ${buf.length}`)
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]!)
  return v
}
export function readI64LE(buf: Uint8Array, off: number): bigint {
  const u = readU64LE(buf, off)
  return u >= (1n << 63n) ? u - (1n << 64n) : u
}
export function readU128LE(buf: Uint8Array, off: number): bigint {
  if (off + 16 > buf.length) throw new RangeError(`readU128 @${off} beyond ${buf.length}`)
  return readU64LE(buf, off) | (readU64LE(buf, off + 8) << 64n)
}
export function readPubkey(buf: Uint8Array, off: number): PublicKey {
  if (off + 32 > buf.length) throw new RangeError(`readPubkey @${off} beyond ${buf.length}`)
  return new PublicKey(buf.subarray(off, off + 32))
}
export function writeU64LE(v: bigint): Uint8Array {
  if (v < 0n || v > (1n << 64n) - 1n) throw new RangeError(`u64 out of range: ${v}`)
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn)
  return out
}
export function writeU32LE(v: number): Uint8Array {
  const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, v >>> 0, true); return out
}
export function writeU16LE(v: number): Uint8Array {
  const out = new Uint8Array(2); new DataView(out.buffer).setUint16(0, v & 0xffff, true); return out
}
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(n); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
export function hexOf(buf: Uint8Array): string { return Buffer.from(buf).toString('hex') }
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
