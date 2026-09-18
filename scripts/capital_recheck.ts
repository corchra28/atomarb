/**
 * Re-measure the capital a winning arbitrage deploys, from the 3,000-block census.
 *
 * The figure in docs/CAPITAL_AND_TARGETS.md — "capital saturates near $1,538" — came from 96
 * transactions in a 120-block census. That is the same single-short-sample weakness that made
 * the market-size figure wrong by sixfold, and it matters more here: the claim is that more money
 * buys nothing, and it rests on the largest capital seen in a small sample.
 *
 * Sampling design: every circuit whose take-home exceeds 1,000,000 lamports (the ones that could
 * plausibly have deployed large capital), plus a random draw from the rest for the distribution.
 * Read-only: getTransaction only.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const RPC = process.env.SOLANA_RPC_URL
if (!RPC) throw new Error('SOLANA_RPC_URL not set')

const WSOL = 'So11111111111111111111111111111111111111112'
const SOL_USD = 112.93

const rpc = async (method: string, params: unknown[]) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!r.ok) {
        await new Promise((s) => setTimeout(s, 400 * (attempt + 1)))
        continue
      }
      const j = (await r.json()) as any
      if (j.error) return null
      return j.result
    } catch {
      await new Promise((s) => setTimeout(s, 400 * (attempt + 1)))
    }
  }
  return null
}

type Arb = { signature: string; netLamports: number; venues: string[]; mintsTouched: number }
const census = JSON.parse(
  readFileSync('docs/sources/realworld/arb_census_3000blocks.json', 'utf8'),
) as { arbs: Arb[] }
const arbs = census.arbs.filter((a) => a.mintsTouched >= 2)
console.log(`census circuits: ${arbs.length}`)

const big = arbs.filter((a) => a.netLamports > 1_000_000)
const rest = arbs.filter((a) => a.netLamports <= 1_000_000)
// deterministic sample of the rest
const step = Math.max(1, Math.floor(rest.length / 400))
const sampled = rest.filter((_, i) => i % step === 0).slice(0, 400)
const target = [...big, ...sampled]
console.log(`  > 1M lamports: ${big.length} (all of them)`)
console.log(`  <= 1M: ${rest.length}, sampling ${sampled.length}`)
console.log(`fetching ${target.length} transactions...`)

/** Largest single wrapped-SOL transfer in the transaction = the capital put at risk. */
function largestWsolTransfer(tx: any): number {
  let max = 0
  for (const group of tx?.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) {
      const info = ix?.parsed?.info
      if (!info) continue
      const type = ix.parsed?.type
      if (type !== 'transfer' && type !== 'transferChecked') continue
      const mint = info.mint as string | undefined
      if (!mint || mint !== WSOL) continue
      const amount = Number(info.tokenAmount?.amount ?? info.amount ?? 0)
      if (amount > max) max = amount
    }
  }
  return max
}

const rows: { sig: string; capital: number; net: number; returnBps: number; venues: string[] }[] = []
let done = 0
for (const a of target) {
  const tx = await rpc('getTransaction', [
    a.signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
  ])
  done++
  if (done % 50 === 0) process.stderr.write(`\r  ${done}/${target.length}, sized ${rows.length}   `)
  if (!tx) continue
  const capital = largestWsolTransfer(tx)
  if (capital <= 0) continue
  rows.push({
    sig: a.signature,
    capital,
    net: a.netLamports,
    returnBps: (a.netLamports / capital) * 10_000,
    venues: a.venues,
  })
}
process.stderr.write('\n')

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!
}
const caps = rows.map((r) => r.capital)
const sol = (l: number) => +(l / 1e9).toFixed(4)
const usd = (l: number) => +((l / 1e9) * SOL_USD).toFixed(2)

const summary = {
  sized: rows.length,
  ofCircuits: arbs.length,
  allBigIncluded: big.length,
  capitalSol: { p50: sol(pct(caps, 0.5)), p90: sol(pct(caps, 0.9)), p99: sol(pct(caps, 0.99)), max: sol(Math.max(...caps)) },
  capitalUsd: { p50: usd(pct(caps, 0.5)), p90: usd(pct(caps, 0.9)), p99: usd(pct(caps, 0.99)), max: usd(Math.max(...caps)) },
  returnBps: { p50: +pct(rows.map((r) => r.returnBps), 0.5).toFixed(2), p90: +pct(rows.map((r) => r.returnBps), 0.9).toFixed(2) },
  largestByCapital: [...rows]
    .sort((a, b) => b.capital - a.capital)
    .slice(0, 8)
    .map((r) => ({ capitalSol: sol(r.capital), profitUsd: usd(r.net), returnBps: +r.returnBps.toFixed(1), venues: r.venues })),
  mostProfitable: [...rows]
    .sort((a, b) => b.net - a.net)
    .slice(0, 8)
    .map((r) => ({ capitalSol: sol(r.capital), profitUsd: usd(r.net), returnBps: +r.returnBps.toFixed(1), venues: r.venues })),
}
writeFileSync('.scratch/realworld/capital_3000.json', JSON.stringify({ summary, rows }, null, 1))
console.log(JSON.stringify(summary, null, 1))
