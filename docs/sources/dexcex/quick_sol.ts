/** Independent cross-check: executable DEX price (Jupiter) vs executable CEX price (Binance book, walked) for SOL, both directions, several sizes. */
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SOL = 'So11111111111111111111111111111111111111112'
const j = async (inMint: string, outMint: string, amount: bigint) => {
  const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=0`)
  return await r.json() as { inAmount: string; outAmount: string; priceImpactPct: string; routePlan: { swapInfo: { label?: string } }[] }
}
const book = await (await fetch('https://api.binance.com/api/v3/depth?symbol=SOLUSDT&limit=100')).json() as { bids: [string, string][]; asks: [string, string][] }
const walk = (levels: [string, string][], notionalUsd: number, buying: boolean) => {
  let spent = 0, got = 0
  for (const [p, q] of levels) {
    const price = Number(p), qty = Number(q)
    const cost = buying ? price * qty : price * qty
    const take = Math.min(cost, notionalUsd - spent)
    if (take <= 0) break
    spent += take; got += take / price
    if (spent >= notionalUsd - 1e-9) break
  }
  return spent > 0 ? { units: got, avgPrice: spent / got, filled: spent } : null
}
const topBid = Number(book.bids[0]![0]), topAsk = Number(book.asks[0]![0])
console.log(`Binance SOL/USDT top of book: bid ${topBid} ask ${topAsk} spread ${(((topAsk - topBid) / topBid) * 1e4).toFixed(2)} bps`)
console.log(`\n${'size USD'.padStart(9)} ${'DEX buy px'.padStart(11)} ${'CEX sell px'.padStart(11)} ${'gross bps'.padStart(10)} ${'after 10bp taker'.padStart(17)} ${'impact'.padStart(8)}  route`)
for (const usd of [100, 1_000, 10_000, 50_000]) {
  const q = await j(USDC, SOL, BigInt(usd) * 1_000_000n)                       // USDC -> SOL on chain
  const solOut = Number(q.outAmount) / 1e9
  const dexBuy = usd / solOut
  const cexSell = walk(book.bids, usd, false)                                   // sell the same notional into the CEX bid
  if (!cexSell) continue
  const grossBps = ((cexSell.avgPrice - dexBuy) / dexBuy) * 1e4
  const route = q.routePlan.map(r => r.swapInfo.label ?? '?').join('+')
  console.log(`${String(usd).padStart(9)} ${dexBuy.toFixed(4).padStart(11)} ${cexSell.avgPrice.toFixed(4).padStart(11)} ${grossBps.toFixed(1).padStart(10)} ${(grossBps - 10).toFixed(1).padStart(17)} ${Number(q.priceImpactPct).toFixed(4).padStart(8)}  ${route}`)
}
console.log(`\n${'size USD'.padStart(9)} ${'CEX buy px'.padStart(11)} ${'DEX sell px'.padStart(11)} ${'gross bps'.padStart(10)} ${'after 10bp taker'.padStart(17)}  route`)
for (const usd of [100, 1_000, 10_000, 50_000]) {
  const cexBuy = walk(book.asks, usd, true)
  if (!cexBuy) continue
  const solIn = BigInt(Math.floor(cexBuy.units * 1e9))
  const q = await j(SOL, USDC, solIn)                                           // sell the same SOL on chain
  const usdcOut = Number(q.outAmount) / 1e6
  const dexSell = usdcOut / cexBuy.units
  const grossBps = ((dexSell - cexBuy.avgPrice) / cexBuy.avgPrice) * 1e4
  console.log(`${String(usd).padStart(9)} ${cexBuy.avgPrice.toFixed(4).padStart(11)} ${dexSell.toFixed(4).padStart(11)} ${grossBps.toFixed(1).padStart(10)} ${(grossBps - 10).toFixed(1).padStart(17)}  ${q.routePlan.map(r => r.swapInfo.label ?? '?').join('+')}`)
}
