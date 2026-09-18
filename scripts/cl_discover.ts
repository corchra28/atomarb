/**
 * Find mints quoted against WSOL on more than one of the three venues this repository can now
 * price exactly: Raydium CPMM, Orca Whirlpool, Meteora DLMM.
 *
 * The previous whole-chain radar covered constant-product venues only, which is precisely the
 * coverage gap the census in docs/REAL_WORLD_MEV.md identified: 98 of 104 real winning
 * arbitrages include a concentrated-liquidity venue.
 *
 * Writes `.scratch/clgap/candidates.json`. Read-only: getProgramAccounts and
 * getMultipleAccounts, nothing signed or submitted.
 */
import bs58 from 'bs58'
import { mkdirSync, writeFileSync } from 'node:fs'

const RPC = process.env.SOLANA_RPC_URL
if (!RPC) throw new Error('SOLANA_RPC_URL not set')

const WSOL = 'So11111111111111111111111111111111111111112'

const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'

const rpc = async (method: string, params: unknown[]): Promise<any> => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!r.ok) {
        await new Promise((s) => setTimeout(s, 600 * (attempt + 1)))
        continue
      }
      const j = (await r.json()) as any
      if (j.error) throw new Error(JSON.stringify(j.error))
      return j.result
    } catch (e) {
      if (attempt === 3) throw e
      await new Promise((s) => setTimeout(s, 600 * (attempt + 1)))
    }
  }
}

type Entry = {
  venue: 'raydium_cpmm' | 'whirlpool' | 'dlmm'
  pool: string
  otherMint: string
  /** WSOL side vault/reserve, for ranking by depth */
  wsolVault: string
  /** WSOL is token 0 / A / X on this pool */
  wsolIsFirst: boolean
}

/** One getProgramAccounts per (venue, side), sliced to just the fields needed. */
async function scanVenue(
  venue: Entry['venue'],
  programId: string,
  discriminatorHex: string | null,
  layout: { mintA: number; mintB: number; vaultA: number; vaultB: number; len: number },
): Promise<Entry[]> {
  const out: Entry[] = []
  for (const wsolIsFirst of [true, false]) {
    const wsolOffset = wsolIsFirst ? layout.mintA : layout.mintB
    // Slice covering both mints and both vaults in one range.
    const lo = Math.min(layout.mintA, layout.mintB, layout.vaultA, layout.vaultB)
    const hi = Math.max(layout.mintA, layout.mintB, layout.vaultA, layout.vaultB) + 32
    const filters: unknown[] = [{ memcmp: { offset: wsolOffset, bytes: WSOL } }]
    if (discriminatorHex) {
      filters.unshift({
        memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(discriminatorHex, 'hex')) },
      })
    } else {
      filters.unshift({ dataSize: layout.len })
    }
    const accs = await rpc('getProgramAccounts', [
      programId,
      { encoding: 'base64', dataSlice: { offset: lo, length: hi - lo }, filters },
    ])
    for (const a of accs) {
      const d = Buffer.from(a.account.data[0], 'base64')
      const at = (o: number) => bs58.encode(d.subarray(o - lo, o - lo + 32))
      const otherMint = wsolIsFirst ? at(layout.mintB) : at(layout.mintA)
      if (otherMint === WSOL) continue
      out.push({
        venue,
        pool: a.pubkey,
        otherMint,
        wsolVault: wsolIsFirst ? at(layout.vaultA) : at(layout.vaultB),
        wsolIsFirst,
      })
    }
    process.stderr.write(`\r${venue} wsolFirst=${wsolIsFirst}: ${accs.length}   `)
  }
  process.stderr.write('\n')
  return out
}

const all: Entry[] = []
// push one at a time: spreading a 200k-element array into push() overflows the stack
const absorb = (xs: Entry[]) => { for (const x of xs) all.push(x) }

absorb(
  await scanVenue('raydium_cpmm', RAYDIUM_CPMM, 'f7ede3f5d7c3de46', {
    mintA: 168, mintB: 200, vaultA: 72, vaultB: 104, len: 637,
  }),
)
absorb(
  await scanVenue('whirlpool', WHIRLPOOL, null, {
    mintA: 101, mintB: 181, vaultA: 133, vaultB: 213, len: 653,
  }),
)
absorb(
  await scanVenue('dlmm', DLMM, '210b3162b565b10d', {
    mintA: 88, mintB: 120, vaultA: 152, vaultB: 184, len: 904,
  }),
)

console.log(`pools scanned: ${all.length}`)
const byVenue: Record<string, number> = {}
for (const e of all) byVenue[e.venue] = (byVenue[e.venue] ?? 0) + 1
console.log('by venue:', JSON.stringify(byVenue))

// Group by the non-WSOL mint, keep mints present on two or more DIFFERENT venues.
const byMint = new Map<string, Entry[]>()
for (const e of all) {
  const list = byMint.get(e.otherMint) ?? []
  list.push(e)
  byMint.set(e.otherMint, list)
}
const crossVenue = [...byMint.entries()].filter(([, list]) => new Set(list.map((e) => e.venue)).size >= 2)
console.log(`mints with WSOL pools on 2+ different venues: ${crossVenue.length}`)

// Rank by the depth of the thinner side: a route is only as good as its shallower leg.
const vaults = [...new Set(crossVenue.flatMap(([, l]) => l.map((e) => e.wsolVault)))]
console.log(`fetching ${vaults.length} WSOL vault balances...`)
const balance = new Map<string, bigint>()
for (let i = 0; i < vaults.length; i += 100) {
  const res = await rpc('getMultipleAccounts', [
    vaults.slice(i, i + 100),
    { encoding: 'base64', dataSlice: { offset: 64, length: 8 } },
  ])
  res.value.forEach((v: any, j: number) => {
    if (v) balance.set(vaults[i + j]!, Buffer.from(v.data[0], 'base64').readBigUInt64LE(0))
  })
  if (i % 2000 === 0) process.stderr.write(`\r  ${i}/${vaults.length}   `)
}
process.stderr.write('\n')

type Candidate = {
  mint: string
  legs: { venue: string; pool: string; wsolLamports: string; wsolIsFirst: boolean }[]
  /** lamports on the thinner of the two best legs from different venues */
  thinnerSideLamports: string
}

const candidates: Candidate[] = []
for (const [mint, list] of crossVenue) {
  // best pool per venue by WSOL depth
  const best = new Map<string, Entry>()
  for (const e of list) {
    const cur = best.get(e.venue)
    if (!cur || (balance.get(e.wsolVault) ?? 0n) > (balance.get(cur.wsolVault) ?? 0n)) best.set(e.venue, e)
  }
  const legs = [...best.values()]
    .map((e) => ({
      venue: e.venue,
      pool: e.pool,
      wsolLamports: (balance.get(e.wsolVault) ?? 0n).toString(),
      wsolIsFirst: e.wsolIsFirst,
    }))
    .sort((a, b) => (BigInt(b.wsolLamports) > BigInt(a.wsolLamports) ? 1 : -1))
  if (legs.length < 2) continue
  const thinner = BigInt(legs[1]!.wsolLamports)
  candidates.push({ mint, legs, thinnerSideLamports: thinner.toString() })
}

candidates.sort((a, b) => (BigInt(b.thinnerSideLamports) > BigInt(a.thinnerSideLamports) ? 1 : -1))
console.log(`cross-venue candidates: ${candidates.length}`)
const over1Sol = candidates.filter((c) => BigInt(c.thinnerSideLamports) >= 1_000_000_000n)
console.log(`  with >= 1 SOL on the thinner side: ${over1Sol.length}`)

mkdirSync('.scratch/clgap', { recursive: true })
writeFileSync(
  '.scratch/clgap/candidates.json',
  JSON.stringify(
    {
      generatedUtc: new Date().toISOString(),
      poolsScanned: all.length,
      byVenue,
      crossVenueMints: crossVenue.length,
      candidates: candidates.slice(0, 400),
    },
    null,
    1,
  ),
)
console.log('wrote .scratch/clgap/candidates.json')
for (const c of candidates.slice(0, 10)) {
  console.log(
    ` ${c.mint.slice(0, 10)} thinner ${(Number(c.thinnerSideLamports) / 1e9).toFixed(2)} SOL  ` +
      c.legs.map((l) => `${l.venue}:${(Number(l.wsolLamports) / 1e9).toFixed(1)}`).join('  '),
  )
}
