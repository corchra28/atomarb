/** Same measurement as quick_sol, across the Solana assets listed on Binance. Read-only public endpoints, no keys, no orders. */
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ASSETS: [string, string, string, number][] = [
  ['SOL', 'So11111111111111111111111111111111111111112', 'SOLUSDT', 9],
  ['BONK', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONKUSDT', 5],
  ['WIF', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIFUSDT', 6],
  ['JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUPUSDT', 6],
  ['JTO', 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', 'JTOUSDT', 9],
  ['PYTH', 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', 'PYTHUSDT', 6],
  ['RAY', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'RAYUSDT', 6],
  ['TRUMP', '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', 'TRUMPUSDT', 6],
]
const jq = async (inMint: string, outMint: string, amount: bigint) => {
  const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=0`)
  if (!r.ok) return null
  const j = await r.json() as { outAmount?: string; priceImpactPct?: string; routePlan?: { swapInfo: { label?: string } }[]; error?: string }
  return j.outAmount ? j : null
}
const walk = (levels: [string, string][], usd: number) => {
  let spent = 0, units = 0
  for (const [p, q] of levels) {
    const price = Number(p), take = Math.min(price * Number(q), usd - spent)
    if (take <= 0) break
    spent += take; units += take / price
  }
  return spent > usd * 0.98 ? { avg: spent / units, units } : null
}
console.log(`${'asset'.padEnd(6)} ${'size'.padStart(7)} ${'spread'.padStart(7)} ${'DEX->CEX'.padStart(9)} ${'CEX->DEX'.padStart(9)}  best gross bps (before the CEX taker fee)`)
for (const [name, mint, symbol, dec] of ASSETS) {
  const res = await fetch(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=100`)
  if (!res.ok) { console.log(`${name.padEnd(6)} not listed / no book`); continue }
  const book = await res.json() as { bids: [string, string][]; asks: [string, string][] }
  const spreadBps = ((Number(book.asks[0]![0]) - Number(book.bids[0]![0])) / Number(book.bids[0]![0])) * 1e4
  for (const usd of [1_000, 10_000]) {
    const buy = await jq(USDC, mint, BigInt(usd) * 1_000_000n)                       // buy on chain
    const sellCex = walk(book.bids, usd)
    let a = NaN
    if (buy && sellCex) { const units = Number(buy.outAmount) / 10 ** dec; a = ((sellCex.avg - usd / units) / (usd / units)) * 1e4 }
    const buyCex = walk(book.asks, usd)
    let b = NaN
    if (buyCex) { const q = await jq(mint, USDC, BigInt(Math.floor(buyCex.units * 10 ** dec))); if (q) { const out = Number(q.outAmount) / 1e6; b = ((out / buyCex.units - buyCex.avg) / buyCex.avg) * 1e4 } }
    console.log(`${name.padEnd(6)} ${String(usd).padStart(7)} ${spreadBps.toFixed(1).padStart(7)} ${(isNaN(a) ? '-' : a.toFixed(1)).padStart(9)} ${(isNaN(b) ? '-' : b.toFixed(1)).padStart(9)}  ${Math.max(isNaN(a) ? -999 : a, isNaN(b) ? -999 : b).toFixed(1)}`)
  }
}
