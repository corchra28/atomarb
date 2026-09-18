/**
 * A/B test of the denomination artifact.
 *
 * Same asset, same instant, two measurements:
 *   - unmatched: Jupiter quote in USDC vs Binance book in USDT  (what my first scan did)
 *   - matched:   Jupiter quote in USDT vs Binance book in USDT  (correct)
 *
 * The difference between the two IS the USDC/USDT basis, which is also measured
 * directly on both venues. Read-only public endpoints, no keys, no orders.
 */
import { writeFileSync } from 'node:fs'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

const ASSETS: [string, string, string, number][] = [
  ['SOL', 'So11111111111111111111111111111111111111112', 'SOLUSDT', 9],
  ['JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUPUSDT', 6],
  ['TRUMP', '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', 'TRUMPUSDT', 6],
]

const NOTIONAL = 2_000
const MINUTES = Number(process.argv[2] ?? 12)

const jq = async (a: string, b: string, amt: bigint): Promise<bigint | null> => {
  const r = await fetch(
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${a}&outputMint=${b}&amount=${amt}&slippageBps=0&restrictIntermediateTokens=true`,
  )
  if (!r.ok) return null
  const j = (await r.json()) as { outAmount?: string }
  return j.outAmount ? BigInt(j.outAmount) : null
}

/** Walk a book side until `usd` of quote is consumed. Returns average price and units. */
const walk = (levels: [string, string][], usd: number) => {
  let spent = 0
  let units = 0
  for (const [p, q] of levels) {
    const price = Number(p)
    const take = Math.min(price * Number(q), usd - spent)
    if (take <= 0) break
    spent += take
    units += take / price
  }
  return spent > usd * 0.98 ? { avg: spent / units, units } : null
}

type Row = {
  t: string
  unmatchedBps: number | null // DEX buy in USDC -> CEX sell in USDT
  matchedBps: number | null // DEX buy in USDT -> CEX sell in USDT
  basisDexBps: number | null // USDC->USDT on Jupiter, in bps away from parity
  basisCexBps: number | null // USDC/USDT on Binance, in bps away from parity
}

const samples: Record<string, Row[]> = {}
const t0 = Date.now()

while (Date.now() - t0 < MINUTES * 60_000) {
  // Stablecoin basis, both venues, once per sweep.
  let basisDexBps: number | null = null
  let basisCexBps: number | null = null
  try {
    const out = await jq(USDC, USDT, 2_000_000_000n) // 2,000 USDC
    if (out) basisDexBps = (Number(out) / 2_000_000_000 - 1) * 1e4
    const bk = (await (
      await fetch('https://api.binance.com/api/v3/depth?symbol=USDCUSDT&limit=20')
    ).json()) as { bids: [string, string][] }
    const sell = walk(bk.bids, 2_000)
    if (sell) basisCexBps = (sell.avg - 1) * 1e4
  } catch {
    /* transient */
  }

  for (const [name, mint, symbol, dec] of ASSETS) {
    try {
      const book = (await (
        await fetch(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=50`)
      ).json()) as { bids: [string, string][]; asks: [string, string][] }
      const sell = walk(book.bids, NOTIONAL)

      const outUsdc = await jq(USDC, mint, BigInt(NOTIONAL) * 1_000_000n)
      const outUsdt = await jq(USDT, mint, BigInt(NOTIONAL) * 1_000_000n)

      const gap = (out: bigint | null) => {
        if (!out || !sell) return null
        const units = Number(out) / 10 ** dec
        const dexPx = NOTIONAL / units
        return ((sell.avg - dexPx) / dexPx) * 1e4
      }

      ;(samples[name] ??= []).push({
        t: new Date().toISOString(),
        unmatchedBps: gap(outUsdc),
        matchedBps: gap(outUsdt),
        basisDexBps,
        basisCexBps,
      })
    } catch {
      /* transient: skip this sample */
    }
  }
  await new Promise((r) => setTimeout(r, 8000))
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return null
  return {
    n: s.length,
    min: +s[0].toFixed(2),
    p50: +s[Math.floor(s.length / 2)].toFixed(2),
    p95: +s[Math.floor(s.length * 0.95)].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
  }
}

const out: Record<string, unknown> = {
  notionalUsd: NOTIONAL,
  minutes: MINUTES,
  note: 'unmatched = Jupiter USDC quote vs Binance USDT book; matched = Jupiter USDT quote vs Binance USDT book',
}

for (const [name] of ASSETS) {
  const rows = samples[name] ?? []
  const um = rows.map((r) => r.unmatchedBps).filter((x): x is number => x !== null)
  const m = rows.map((r) => r.matchedBps).filter((x): x is number => x !== null)
  const bd = rows.map((r) => r.basisDexBps).filter((x): x is number => x !== null)
  const bc = rows.map((r) => r.basisCexBps).filter((x): x is number => x !== null)
  out[name] = {
    samples: rows.length,
    unmatchedBps: stats(um),
    matchedBps: stats(m),
    basisDexBps: stats(bd),
    basisCexBps: stats(bc),
    matchedOver5bps: m.filter((x) => x > 5).length,
    matchedOver10bps: m.filter((x) => x > 10).length,
    unmatchedOver5bps: um.filter((x) => x > 5).length,
  }
}

writeFileSync(
  '.scratch/dexcex/window_scan_matched.json',
  JSON.stringify({ out, samples }, null, 1),
)
console.log(JSON.stringify(out, null, 1))
