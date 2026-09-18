/**
 * Gap radar: scans the WHOLE on-chain population (not a shortlist) for the only thing that can pay — two pools of the same token whose prices
 * differ by more than the round-trip fee, with BOTH sides deep enough to absorb a trade. Read-only.
 *
 *   1. every PumpSwap pool quoted in WSOL            (getProgramAccounts, memcmp on quote_mint)
 *   2. every Raydium CPMM pool with WSOL on either side (getProgramAccounts, memcmp on token_0_mint / token_1_mint)
 *   3. keep mints that have two or more such pools
 *   4. one batched read of every vault of those pools -> reserves
 *   5. rank the pairs by price gap, keeping only pairs whose THINNER side holds >= --min-sol
 *
 * The gap here is pre-fee and pre-impact: it is a filter, not a claim. Whatever survives is then quoted exactly by the adapters
 * (scripts/verify_candidates.ts) which apply fees, impact, the sizing grid and the network cost.
 * Usage: npx tsx scripts/gap_radar.ts [--min-sol 1] [--min-gap-bps 100] [--max-requests 400] [--max-rps 8]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { loadConfig, resolveEndpoints } from '../src/config/load.js'
import { RpcClient } from '../src/state/rpc.js'
import { JsonlLogger } from '../src/telemetry/log.js'
import { positiveIntFlag } from '../src/util/flags.js'
import { readU64LE, readU128LE, readPubkey } from '../src/util/bytes.js'
import { WSOL_MINT } from '../src/state/token.js'
import { nowUtcIso, monoMs } from '../src/util/time.js'
import { jsonReplacer } from '../src/util/bigint.js'
import { PUMP_AMM_PROGRAM_ID } from '../src/adapters/pumpswap/layout.js'
import { RAYDIUM_CPMM_PROGRAM_ID } from '../src/adapters/raydium_cpmm/index.js'

const argv = process.argv
const minSol = positiveIntFlag(argv, '--min-sol-milli', 1000)          // thinner side must hold at least this many milli-SOL (default 1 SOL)
const minGapBps = positiveIntFlag(argv, '--min-gap-bps', 100)
const maxReq = positiveIntFlag(argv, '--max-requests', 400)
const maxRps = positiveIntFlag(argv, '--max-rps', 8)
const { config } = loadConfig('config/config.fast.example.json')
const rpc = new RpcClient(resolveEndpoints(config).httpUrl, { ...config.rpc, maxRequestsPerSecond: maxRps, maxConcurrentRequests: 4, maxTotalHttpRequests: maxReq, requestTimeoutMs: 120_000 }, 'confirmed', new JsonlLogger({ stderr: false }))
interface GpaItem { pubkey: string; account: { data: [string, string] } }
const gpa = async (programId: PublicKey, filters: unknown[], length: number): Promise<{ slot: number; items: { pubkey: string; data: Uint8Array }[] }> => {
  const r = await rpc.call<{ context: { slot: number }; value: GpaItem[] }>('getProgramAccounts', [programId.toBase58(), { encoding: 'base64', withContext: true, dataSlice: { offset: 0, length }, filters }])
  return { slot: r.context.slot, items: r.value.map(v => ({ pubkey: v.pubkey, data: new Uint8Array(Buffer.from(v.account.data[0], 'base64')) })) }
}
interface PoolRow { venue: 'pumpswap' | 'raydium_cpmm'; pool: string; mint: string; wsolVault: string; tokenVault: string; virtualQuote: bigint }
const t0 = monoMs()
// 1. PumpSwap: quote_mint (offset 75) == WSOL
const pump = await gpa(PUMP_AMM_PROGRAM_ID, [{ memcmp: { offset: 75, bytes: WSOL_MINT.toBase58() } }], 271)
const rows: PoolRow[] = []
for (const it of pump.items) {
  if (it.data.length < 211) continue
  const mint = readPubkey(it.data, 43).toBase58()
  const baseVault = readPubkey(it.data, 139).toBase58(), quoteVault = readPubkey(it.data, 171).toBase58()
  const virt = it.data.length >= 261 ? BigInt.asIntN(128, readU128LE(it.data, 245)) : 0n
  rows.push({ venue: 'pumpswap', pool: it.pubkey, mint, wsolVault: quoteVault, tokenVault: baseVault, virtualQuote: virt < 0n ? 0n : virt })
}
// 2. Raydium CPMM: WSOL as token_0 (offset 168) or token_1 (offset 200)
for (const [off, wsolIsToken0] of [[168, true], [200, false]] as const) {
  const r = await gpa(RAYDIUM_CPMM_PROGRAM_ID, [{ memcmp: { offset: off, bytes: WSOL_MINT.toBase58() } }], 637)
  for (const it of r.items) {
    if (it.data.length < 637) continue
    const v0 = readPubkey(it.data, 72).toBase58(), v1 = readPubkey(it.data, 104).toBase58()
    const m0 = readPubkey(it.data, 168).toBase58(), m1 = readPubkey(it.data, 200).toBase58()
    rows.push({ venue: 'raydium_cpmm', pool: it.pubkey, mint: wsolIsToken0 ? m1 : m0, wsolVault: wsolIsToken0 ? v0 : v1, tokenVault: wsolIsToken0 ? v1 : v0, virtualQuote: 0n })
  }
}
// 3. mints with two or more pools
const byMint = new Map<string, PoolRow[]>()
for (const r of rows) { const a = byMint.get(r.mint) ?? []; a.push(r); byMint.set(r.mint, a) }
const multi = [...byMint.entries()].filter(([, v]) => v.length >= 2)
const poolsToPrice = multi.flatMap(([, v]) => v)
// 4. every vault of those pools, batched
const vaultKeys = [...new Set(poolsToPrice.flatMap(p => [p.wsolVault, p.tokenVault]))]
const amounts = new Map<string, bigint>()
for (let i = 0; i < vaultKeys.length; i += 100) {
  if (rpc.usage.total + 1 >= maxReq) break
  const chunk = vaultKeys.slice(i, i + 100).map(k => new PublicKey(k))
  const r = await rpc.getMultipleAccounts(chunk)
  for (const [k, a] of r.bundle.accounts) if (a.data.length >= 72) amounts.set(k, readU64LE(a.data, 64))
}
// 5. price each pool, rank the pairs
interface Priced extends PoolRow { wsol: bigint; token: bigint; price: number }
const priced: Priced[] = []
for (const p of poolsToPrice) {
  const w = amounts.get(p.wsolVault), t = amounts.get(p.tokenVault)
  if (w === undefined || t === undefined || t === 0n) continue
  const wsol = w + p.virtualQuote
  if (wsol === 0n) continue
  priced.push({ ...p, wsol, token: t, price: Number(wsol) / Number(t) })
}
const byMintPriced = new Map<string, Priced[]>()
for (const p of priced) { const a = byMintPriced.get(p.mint) ?? []; a.push(p); byMintPriced.set(p.mint, a) }
const minLamports = BigInt(minSol) * 1_000_000n
interface Pair { mint: string; cheap: Priced; dear: Priced; gapBps: number; thinSol: number }
const pairs: Pair[] = []
for (const [mint, ps] of byMintPriced) {
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i]!, b = ps[j]!
    const [cheap, dear] = a.price <= b.price ? [a, b] : [b, a]
    const gapBps = (dear.price / cheap.price - 1) * 10_000
    const thin = cheap.wsol < dear.wsol ? cheap.wsol : dear.wsol
    if (gapBps >= minGapBps && thin >= minLamports) pairs.push({ mint, cheap, dear, gapBps, thinSol: Number(thin) / 1e9 })
  }
}
pairs.sort((x, y) => (y.gapBps * Math.min(y.thinSol, 50)) - (x.gapBps * Math.min(x.thinSol, 50)))
const summary = {
  generatedUtc: nowUtcIso(), slot: pump.slot, durationMs: monoMs() - t0, rpcRequests: rpc.usage.total,
  pumpswapWsolPools: rows.filter(r => r.venue === 'pumpswap').length, raydiumCpmmWsolPools: rows.filter(r => r.venue === 'raydium_cpmm').length,
  mintsWithTwoOrMorePools: multi.length, poolsPriced: priced.length, vaultsRead: amounts.size,
  filters: { minThinSideSol: minSol / 1000, minGapBps }, pairsPassingFilter: pairs.length,
  note: 'gap is pre-fee and pre-impact: a filter, not an opportunity. Round-trip fees are 45-150 bps and price impact is set by the thinner pool.',
}
mkdirSync('reports', { recursive: true })
const stamp = nowUtcIso().replace(/[:.]/g, '-')
writeFileSync(`reports/gap_radar_${stamp}.json`, JSON.stringify({ summary, pairs: pairs.slice(0, 200).map(p => ({ mint: p.mint, gapBps: Math.round(p.gapBps * 10) / 10, thinSideSol: Math.round(p.thinSol * 1000) / 1000, cheap: { venue: p.cheap.venue, pool: p.cheap.pool, wsol: p.cheap.wsol }, dear: { venue: p.dear.venue, pool: p.dear.pool, wsol: p.dear.wsol } })) }, jsonReplacer, 1))
console.log(JSON.stringify(summary, jsonReplacer, 1))
console.log(`\ntop pairs (gap >= ${minGapBps} bps, thinner side >= ${minSol / 1000} SOL):`)
for (const p of pairs.slice(0, 15)) console.log(`  ${Math.round(p.gapBps).toString().padStart(6)} bps | thin ${p.thinSol.toFixed(3)} SOL | ${p.cheap.venue}:${p.cheap.pool.slice(0, 8)}.. -> ${p.dear.venue}:${p.dear.pool.slice(0, 8)}.. | mint ${p.mint.slice(0, 8)}..`)
