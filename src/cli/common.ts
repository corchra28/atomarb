import { PublicKey } from '@solana/web3.js'
import type { AdapterId, PoolRef } from '../adapters/types.js'
import { nowUtcIso } from '../util/time.js'
import { jsonReplacer } from '../util/bigint.js'
export function parsePoolsFlag(v: string | true | undefined): PoolRef[] {
  if (typeof v !== 'string') throw new Error('usage: --pools <adapter>:<address>,<adapter>:<address>[,...]  (adapter = pumpswap | raydium_cpmm)')
  return v.split(',').map(s => {
    const [adapter, address] = s.trim().split(':')
    if (!adapter || !address || !['pumpswap', 'raydium_cpmm'].includes(adapter)) throw new Error(`bad pool spec '${s}'`)
    return { adapter: adapter as AdapterId, address: new PublicKey(address), source: { kind: 'cli', ref: 'flag', observedAtUtc: nowUtcIso() } }
  })
}
export function fmtLamports(x: bigint): string { const s = x < 0n ? '-' : ''; const a = x < 0n ? -x : x; return `${s}${(Number(a) / 1e9).toFixed(9)} SOL (${x} lamports)` }
export function printBlock(title: string, rows: [string, unknown][]): void {
  console.log(`== ${title}`)
  for (const [k, v] of rows) console.log(`${k.padEnd(28)} ${typeof v === 'string' ? v : JSON.stringify(v, jsonReplacer)}`)
}
