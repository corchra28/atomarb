/**
 * How much capital does a winning atomic arbitrage actually deploy?
 *
 * The census recorded each winner's take-home profit but not its trade size. This fetches the
 * transactions and measures the largest single WSOL transfer in each, which for a WSOL circuit is
 * the amount the searcher put at risk for that trade.
 *
 * That turns "how much do I need to invest" into a measured number instead of an assumption, and
 * lets return-on-capital be computed per trade.
 *
 * Read-only: getTransaction only.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const RPC = process.env.SOLANA_RPC_URL
if (!RPC) throw new Error('SOLANA_RPC_URL not set')

const WSOL = 'So11111111111111111111111111111111111111112'
const SOL_USD = 105.75

type Arb = {
  signature: string
  netLamports: number
  tipLamports: number
  feeLamports: number
  venues: string[]
  mintsTouched: number
}

const census = JSON.parse(
  readFileSync('docs/sources/realworld/arb_census_120blocks.json', 'utf8'),
) as { arbs: Arb[] }

const arbs = census.arbs.filter((a) => a.mintsTouched >= 2)
console.log(`strict circuits in census: ${arbs.length}`)

const rpc = async (method: string, params: unknown[]) => {
  for (let attempt = 0; attempt < 4; attempt++) {
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
      const j = (await r.json()) as { result?: unknown; error?: unknown }
      if (j.error) return null
      return j.result
    } catch {
      await new Promise((s) => setTimeout(s, 500 * (attempt + 1)))
    }
  }
  return null
}

type Parsed = {
  meta?: {
    innerInstructions?: {
      instructions: {
        parsed?: { type?: string; info?: Record<string, unknown> }
        program?: string
      }[]
    }[]
    preTokenBalances?: { mint: string; uiTokenAmount: { amount: string } }[]
  }
}

/** The largest single WSOL transfer anywhere in the transaction = the size of the leg. */
function largestWsolTransfer(tx: Parsed): number {
  let max = 0
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      const p = ix.parsed
      if (!p?.info) continue
      const info = p.info as Record<string, any>
      const isTransfer = p.type === 'transfer' || p.type === 'transferChecked'
      if (!isTransfer) continue
      // transferChecked carries the mint; plain transfer does not, so it is only counted when
      // the amount shape matches a lamport-scale WSOL move.
      const mint = info.mint as string | undefined
      const amount = Number(info.tokenAmount?.amount ?? info.amount ?? 0)
      if (mint && mint !== WSOL) continue
      if (!mint) continue // skip unlabelled transfers rather than guess
      if (amount > max) max = amount
    }
  }
  return max
}

const rows: {
  signature: string
  capitalLamports: number
  netLamports: number
  returnBps: number
  venues: string[]
}[] = []

let checked = 0
for (const a of arbs) {
  const tx = (await rpc('getTransaction', [
    a.signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
  ])) as Parsed | null
  checked++
  if (!tx) continue
  const capital = largestWsolTransfer(tx)
  if (capital <= 0) continue
  rows.push({
    signature: a.signature,
    capitalLamports: capital,
    netLamports: a.netLamports,
    returnBps: (a.netLamports / capital) * 10_000,
    venues: a.venues,
  })
  process.stderr.write(`\rfetched ${checked}/${arbs.length}, sized ${rows.length}   `)
}
process.stderr.write('\n')

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

const caps = rows.map((r) => r.capitalLamports)
const rets = rows.map((r) => r.returnBps)
const sol = (l: number) => +(l / 1e9).toFixed(4)
const usd = (l: number) => +((l / 1e9) * SOL_USD).toFixed(2)

const summary = {
  sized: rows.length,
  ofCensus: arbs.length,
  capitalPerTradeSol: {
    p10: sol(pct(caps, 0.1)),
    p50: sol(pct(caps, 0.5)),
    p90: sol(pct(caps, 0.9)),
    max: sol(Math.max(...caps)),
  },
  capitalPerTradeUsd: {
    p10: usd(pct(caps, 0.1)),
    p50: usd(pct(caps, 0.5)),
    p90: usd(pct(caps, 0.9)),
    max: usd(Math.max(...caps)),
  },
  /** Return on the capital deployed, for that one trade. Not annualised: a trade lasts one slot. */
  returnPerTradeBps: {
    p10: +pct(rets, 0.1).toFixed(2),
    p50: +pct(rets, 0.5).toFixed(2),
    p90: +pct(rets, 0.9).toFixed(2),
    max: +Math.max(...rets).toFixed(2),
  },
  /** The largest trade in the sample, which bounds what capital could ever be useful. */
  largestSingleTrade: rows.sort((a, b) => b.capitalLamports - a.capitalLamports).slice(0, 5).map((r) => ({
    capitalSol: sol(r.capitalLamports),
    profitUsd: usd(r.netLamports),
    returnBps: +r.returnBps.toFixed(2),
    venues: r.venues,
  })),
  mostProfitable: [...rows].sort((a, b) => b.netLamports - a.netLamports).slice(0, 5).map((r) => ({
    capitalSol: sol(r.capitalLamports),
    profitUsd: usd(r.netLamports),
    returnBps: +r.returnBps.toFixed(2),
    venues: r.venues,
  })),
}

writeFileSync(
  '.scratch/realworld/capital_per_arb.json',
  JSON.stringify({ summary, rows }, null, 1),
)
console.log(JSON.stringify(summary, null, 1))
