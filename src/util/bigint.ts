/** Integer helpers. All on-chain amounts are bigint; never Number for lamports/token amounts. */
export const U64_MAX = (1n << 64n) - 1n
export const U128_MAX = (1n << 128n) - 1n

export class OverflowError extends Error {
  constructor(msg: string) { super(`OVERFLOW: ${msg}`); this.name = 'OverflowError' }
}
export function assertU64(x: bigint, what = 'value'): bigint {
  if (x < 0n || x > U64_MAX) throw new OverflowError(`${what}=${x} not in u64`)
  return x
}
export function assertU128(x: bigint, what = 'value'): bigint {
  if (x < 0n || x > U128_MAX) throw new OverflowError(`${what}=${x} not in u128`)
  return x
}
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero')
  return a / b
}
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero')
  if (a < 0n || b < 0n) throw new Error('ceilDiv expects non-negative operands')
  return (a + b - 1n) / b
}
/** floor(a*b/c) with an explicit u128 intermediate bound, mirroring on-chain U128 math. */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  const p = assertU128(a * b, 'a*b')
  return floorDiv(p, c)
}
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  const p = assertU128(a * b, 'a*b')
  return ceilDiv(p, c)
}
export function bpsOf(amount: bigint, bps: bigint): bigint {
  return floorDiv(amount * bps, 10_000n)
}
export function bpsOfCeil(amount: bigint, bps: bigint): bigint {
  return ceilDiv(amount * bps, 10_000n)
}
export function max(a: bigint, b: bigint): bigint { return a > b ? a : b }
export function min(a: bigint, b: bigint): bigint { return a < b ? a : b }
/** JSON helper: bigint -> string with suffix-free decimal (callers know the units). */
export function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v
}
