/**
 * Which pools did the real winners actually use?
 *
 * The cross-venue scan polls the deepest pairs, which are the most watched — so a null result
 * there cannot distinguish "the cadence is too slow" from "wrong pools". This extracts the pool
 * addresses from verified winning circuits in the 3,000-block census, keeping only the venues the
 * three adapters can price, so the latency test polls where arbitrage demonstrably happens.
 *
 * Read-only: getTransaction only.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const RPC = process.env.SOLANA_RPC_URL
if (!RPC) throw new Error('SOLANA_RPC_URL not set')

const PROGRAMS: Record<string, string> = {
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'raydium_cpmm',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'whirlpool',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'dlmm',
}
/** Account length identifying the pool state for each venue. */
const POOL_LEN: Record<string, number> = { raydium_cpmm: 637, whirlpool: 653, dlmm: 904 }

const rpc = async (method: string, params: unknown[]) => {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!r.ok) {
        await new Promise((s) => setTimeout(s, 400 * (a + 1)))
        continue
      }
      const j = (await r.json()) as any
      if (j.error) return null
      return j.result
    } catch {
      await new Promise((s) => setTimeout(s, 400 * (a + 1)))
    }
  }
  return null
}

type Arb = { signature: string; netLamports: number; venues: string[]; mintsTouched: number }
const census = JSON.parse(
  readFileSync('docs/sources/realworld/arb_census_3000blocks.json', 'utf8'),
) as { arbs: Arb[] }

// Only circuits whose venues are all ones the adapters price, and which made enough to matter.
const usable = census.arbs.filter(
  (a) =>
    a.mintsTouched >= 2 &&
    a.netLamports > 100_000 &&
    a.venues.every((v) => ['Raydium CPMM', 'Orca Whirlpool', 'Meteora DLMM'].includes(v)),
)
console.log(`census circuits: ${census.arbs.length}`)
console.log(`  priceable by the three adapters, > 100k lamports: ${usable.length}`)

const target = usable.slice(0, 250)
console.log(`fetching ${target.length} transactions to recover pool addresses...`)

/** Pool-state accounts touched, keyed by venue. Identified by owner program and data length. */
async function poolsOf(sig: string): Promise<{ venue: string; pool: string }[]> {
  const tx = await rpc('getTransaction', [
    sig,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
  ])
  if (!tx) return []
  const keys: string[] = [
    ...(tx.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k.pubkey)),
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ]
  const programs = new Set(keys.filter((k) => PROGRAMS[k]))
  if (programs.size < 2) return []
  // Writable, non-program accounts are the candidates; confirm by fetching and checking the owner.
  return keys.filter((k) => !PROGRAMS[k]).map((k) => ({ venue: '', pool: k }))
}

const candidates = new Set<string>()
let done = 0
for (const a of target) {
  for (const { pool } of await poolsOf(a.signature)) candidates.add(pool)
  done++
  if (done % 25 === 0) process.stderr.write(`\r  ${done}/${target.length}, ${candidates.size} candidate accounts   `)
}
process.stderr.write('\n')

// Confirm which of those are actually pool states, by owner and length.
const list = [...candidates]
console.log(`checking ${list.length} accounts for pool-state shape...`)
const pools: { venue: string; pool: string }[] = []
for (let i = 0; i < list.length; i += 100) {
  const res = await rpc('getMultipleAccounts', [
    list.slice(i, i + 100),
    { encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
  ])
  res?.value?.forEach((v: any, j: number) => {
    if (!v) return
    const venue = PROGRAMS[v.owner]
    if (!venue) return
    if (v.space !== POOL_LEN[venue]) return
    pools.push({ venue, pool: list[i + j]! })
  })
  process.stderr.write(`\r  ${Math.min(i + 100, list.length)}/${list.length}   `)
}
process.stderr.write('\n')

const byVenue: Record<string, number> = {}
for (const p of pools) byVenue[p.venue] = (byVenue[p.venue] ?? 0) + 1
console.log(`pool states found: ${pools.length} — ${JSON.stringify(byVenue)}`)

writeFileSync(
  '.scratch/latency/winner_pools.json',
  JSON.stringify({ generatedUtc: new Date().toISOString(), fromCircuits: target.length, pools }, null, 1),
)
console.log('wrote .scratch/latency/winner_pools.json')
