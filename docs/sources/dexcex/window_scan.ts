/** Does the DEX-CEX spread ever open past the taker fee? Samples both directions every ~8 s. Read-only public endpoints, no keys, no orders. */
import { writeFileSync } from 'node:fs'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ASSETS: [string, string, string, number][] = [
  ['SOL', 'So11111111111111111111111111111111111111112', 'SOLUSDT', 9],
  ['JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUPUSDT', 6],
  ['TRUMP', '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', 'TRUMPUSDT', 6],
]
const NOTIONAL = 2_000, MINUTES = Number(process.argv[2] ?? 10)
const jq = async (a: string, b: string, amt: bigint) => { const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${a}&outputMint=${b}&amount=${amt}&slippageBps=0`); if (!r.ok) return null; const j = await r.json() as { outAmount?: string }; return j.outAmount ? BigInt(j.outAmount) : null }
const walk = (levels: [string, string][], usd: number) => { let s = 0, u = 0; for (const [p, q] of levels) { const price = Number(p), take = Math.min(price * Number(q), usd - s); if (take <= 0) break; s += take; u += take / price } return s > usd * 0.98 ? { avg: s / u, units: u } : null }
const samples: Record<string, { t: string; dexToCex: number | null; cexToDex: number | null }[]> = {}
const t0 = Date.now()
while (Date.now() - t0 < MINUTES * 60_000) {
  for (const [name, mint, symbol, dec] of ASSETS) {
    try {
      const book = await (await fetch(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=50`)).json() as { bids: [string, string][]; asks: [string, string][] }
      const out = await jq(USDC, mint, BigInt(NOTIONAL) * 1_000_000n)
      const sell = walk(book.bids, NOTIONAL), buy = walk(book.asks, NOTIONAL)
      let d2c: number | null = null, c2d: number | null = null
      if (out && sell) { const units = Number(out) / 10 ** dec; d2c = ((sell.avg - NOTIONAL / units) / (NOTIONAL / units)) * 1e4 }
      if (buy) { const back = await jq(mint, USDC, BigInt(Math.floor(buy.units * 10 ** dec))); if (back) { const usdc = Number(back) / 1e6; c2d = ((usdc / buy.units - buy.avg) / buy.avg) * 1e4 } }
      ;(samples[name] ??= []).push({ t: new Date().toISOString(), dexToCex: d2c, cexToDex: c2d })
    } catch { /* transient: skip this sample */ }
  }
  await new Promise(r => setTimeout(r, 8000))
}
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, min: s[0], p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] } }
const out: Record<string, unknown> = { notionalUsd: NOTIONAL, minutes: MINUTES, takerFeeBps: 10 }
for (const [name] of ASSETS) {
  const rows = samples[name] ?? []
  const best = rows.map(r => Math.max(r.dexToCex ?? -1e9, r.cexToDex ?? -1e9)).filter(x => x > -1e8)
  out[name] = { samples: rows.length, bestDirectionBps: stats(best), over5bps: best.filter(x => x > 5).length, over10bps: best.filter(x => x > 10).length, over20bps: best.filter(x => x > 20).length }
}
writeFileSync('.scratch/dexcex/window_scan.json', JSON.stringify({ out, samples }, null, 1))
console.log(JSON.stringify(out, null, 1))
