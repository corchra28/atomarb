/**
 * Fetch every account the three adapters need to quote the top cross-venue candidates, and write
 * them as bincode-serialized `Account` fixtures — the same format `jupiter-amm-test-kit`'s
 * `PoolSnapshot::load_dir` reads, so the Rust side has no network code at all and uses the
 * loading path the parity tests already exercise.
 *
 * Read-only: getMultipleAccounts only.
 */
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const RPC = process.env.SOLANA_RPC_URL
if (!RPC) throw new Error('SOLANA_RPC_URL not set')

const TOP = Number(process.argv[2] ?? 40)

const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
const WHIRLPOOL = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc')
const DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')
const CLOCK = 'SysvarC1ock11111111111111111111111111111111'

const rpc = async (method: string, params: unknown[]): Promise<any> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!r.ok) {
        await new Promise((s) => setTimeout(s, 500 * (attempt + 1)))
        continue
      }
      const j = (await r.json()) as any
      if (j.error) throw new Error(JSON.stringify(j.error))
      return j.result
    } catch (e) {
      if (attempt === 4) throw e
      await new Promise((s) => setTimeout(s, 500 * (attempt + 1)))
    }
  }
}

type Acc = { data: Buffer; owner: string; lamports: bigint; executable: boolean; rentEpoch: bigint }
const cache = new Map<string, Acc | null>()

async function fetchAccounts(keys: string[]): Promise<void> {
  const need = [...new Set(keys)].filter((k) => !cache.has(k))
  for (let i = 0; i < need.length; i += 100) {
    const batch = need.slice(i, i + 100)
    const res = await rpc('getMultipleAccounts', [batch, { encoding: 'base64' }])
    res.value.forEach((v: any, j: number) => {
      cache.set(
        batch[j]!,
        v
          ? {
              data: Buffer.from(v.data[0], 'base64'),
              owner: v.owner,
              lamports: BigInt(v.lamports),
              executable: !!v.executable,
              rentEpoch: BigInt(v.rentEpoch ?? 0),
            }
          : null,
      )
    })
  }
}

/** bincode `Account`: lamports u64, data as (u64 len + bytes), owner 32, executable u8, rent_epoch u64. */
function serializeAccount(a: Acc): Buffer {
  const head = Buffer.alloc(16)
  head.writeBigUInt64LE(a.lamports, 0)
  head.writeBigUInt64LE(BigInt(a.data.length), 8)
  const tail = Buffer.alloc(41)
  Buffer.from(bs58.decode(a.owner)).copy(tail, 0)
  tail.writeUInt8(a.executable ? 1 : 0, 32)
  // rent_epoch u64::MAX is common and meaningless here; keep whatever the chain reports
  tail.writeBigUInt64LE(a.rentEpoch > 0xffffffffffffffffn ? 0n : a.rentEpoch, 33)
  return Buffer.concat([head, a.data, tail])
}

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), program)[0].toBase58()

const i64le = (n: bigint) => {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(n)
  return b
}

const floorDiv = (a: number, b: number) => Math.floor(a / b)

type Leg = { venue: string; pool: string; wsolLamports: string; wsolIsFirst: boolean }
type Candidate = { mint: string; legs: Leg[]; thinnerSideLamports: string }

const input = JSON.parse(readFileSync('.scratch/clgap/candidates.json', 'utf8')) as {
  candidates: Candidate[]
}
const chosen = input.candidates.slice(0, TOP)
console.log(`snapshotting ${chosen.length} candidates`)

// Round 1: the pool accounts themselves.
const poolKeys = chosen.flatMap((c) => c.legs.map((l) => l.pool))
await fetchAccounts([...poolKeys, CLOCK])
console.log(`  pools fetched: ${poolKeys.length}`)

// Round 2: the dependants, derived from each pool's own state.
const deps: string[] = []
const legAccounts = new Map<string, string[]>() // pool -> accounts it needs

for (const c of chosen) {
  for (const l of c.legs) {
    const a = cache.get(l.pool)
    if (!a) continue
    const d = a.data
    const keys: string[] = [l.pool]
    const pk = (o: number) => bs58.encode(d.subarray(o, o + 32))
    try {
      if (l.venue === 'raydium_cpmm') {
        keys.push(pk(8), pk(72), pk(104), pk(168), pk(200), pk(296))
      } else if (l.venue === 'whirlpool') {
        const tickSpacing = d.readUInt16LE(41)
        const tickCurrent = d.readInt32LE(81)
        const per = 88 * tickSpacing
        const centre = floorDiv(tickCurrent, per) * per
        keys.push(pk(101), pk(133), pk(181), pk(213))
        keys.push(pda([Buffer.from('oracle'), new PublicKey(l.pool).toBuffer()], WHIRLPOOL))
        for (let i = -2; i <= 2; i++) {
          const start = centre + i * per
          keys.push(
            pda(
              [Buffer.from('tick_array'), new PublicKey(l.pool).toBuffer(), Buffer.from(String(start))],
              WHIRLPOOL,
            ),
          )
        }
      } else if (l.venue === 'dlmm') {
        const activeId = d.readInt32LE(76)
        const centre = floorDiv(activeId, 70)
        keys.push(pk(88), pk(120), pk(152), pk(184), pk(552))
        keys.push(pda([Buffer.from('bitmap'), new PublicKey(l.pool).toBuffer()], DLMM))
        for (let i = -3; i <= 3; i++) {
          keys.push(
            pda([Buffer.from('bin_array'), new PublicKey(l.pool).toBuffer(), i64le(BigInt(centre + i))], DLMM),
          )
        }
      }
    } catch {
      continue
    }
    legAccounts.set(l.pool, keys)
    for (const k of keys) deps.push(k)
  }
}
console.log(`  dependent accounts to fetch: ${new Set(deps).size}`)
await fetchAccounts(deps)

// Write one snapshot directory per pool.
let written = 0
let skipped = 0
const manifest: { mint: string; legs: { venue: string; pool: string; dir: string }[] }[] = []
for (const c of chosen) {
  const legs: { venue: string; pool: string; dir: string }[] = []
  for (const l of c.legs) {
    const keys = legAccounts.get(l.pool)
    if (!keys) {
      skipped++
      continue
    }
    const dir = `.scratch/clgap/snapshots/${l.pool}`
    mkdirSync(dir, { recursive: true })
    let ok = true
    for (const k of [...new Set([...keys, CLOCK])]) {
      const a = cache.get(k)
      if (!a) continue // a tick/bin array that was never created is a valid absence
      writeFileSync(`${dir}/${k}.bin`, serializeAccount(a))
    }
    if (!cache.get(l.pool)) ok = false
    if (ok) {
      legs.push({ venue: l.venue, pool: l.pool, dir })
      written++
    }
  }
  if (legs.length >= 2) manifest.push({ mint: c.mint, legs })
}
writeFileSync('.scratch/clgap/manifest.json', JSON.stringify({ candidates: manifest }, null, 1))
console.log(`wrote ${written} pool snapshots, ${manifest.length} candidates with 2+ legs (skipped ${skipped})`)
