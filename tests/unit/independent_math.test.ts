/**
 * THIRD implementation of both curves, written only from the primary-source notes (docs/sources/raydium_cpmm.md §5, pumpswap.md §5 and §11),
 * deliberately NOT calling the adapters' helpers. Cross-checked against the adapter math on pseudo-random states.
 * Purpose (brief §8): the adapter math must agree with an implementation that does not share its code path — the SDK cross-checks live in
 * tests/unit/raydium_math.test.ts and tests/unit/pumpswap_sdk_crosscheck.test.ts; this file is the independent re-derivation.
 */
import { describe, it, expect } from 'vitest'
import { curveSwapBaseInput, type FeeRates } from '../../src/adapters/raydium_cpmm/math.js'
import { buyQuoteInput, sellBaseInput, type PoolMathState, type FeeBps } from '../../src/adapters/pumpswap/math.js'

// ---- deterministic PRNG so failures are reproducible ----
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }
const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!
const big = (r: () => number, lo: number, hi: number): bigint => BigInt(Math.floor(lo + r() * (hi - lo)))

// ---- independent reference: Raydium CPMM swap_base_input (note §5.2, §5.3) ----
const CEIL = (a: bigint, b: bigint): bigint => (a + b - 1n) / b
const DEN = 1_000_000n
function refRaydiumSwapBaseInput(amountIn: bigint, rIn: bigint, rOut: bigint, f: FeeRates, creatorOnInput: boolean): { out: bigint; tradeFee: bigint; creatorFee: bigint; protocolFee: bigint; fundFee: bigint } {
  let lessFees: bigint, tradeFee: bigint, creatorFee: bigint
  if (creatorOnInput && f.creatorFeeRate > 0n) {
    const total = CEIL(amountIn * (f.tradeFeeRate + f.creatorFeeRate), DEN)          // ceil on the SUM of the two rates
    creatorFee = (total * f.creatorFeeRate) / (f.tradeFeeRate + f.creatorFeeRate)    // floor split
    tradeFee = total - creatorFee
    lessFees = amountIn - total
  } else {
    tradeFee = CEIL(amountIn * f.tradeFeeRate, DEN); creatorFee = 0n; lessFees = amountIn - tradeFee
  }
  let out = (lessFees * rOut) / (rIn + lessFees)                                     // constant product, floored
  if (!creatorOnInput && f.creatorFeeRate > 0n) { creatorFee = CEIL(out * f.creatorFeeRate, DEN); out -= creatorFee }
  return { out, tradeFee, creatorFee, protocolFee: (tradeFee * f.protocolFeeRate) / DEN, fundFee: (tradeFee * f.fundFeeRate) / DEN }
}
// ---- independent reference: PumpSwap (note §5b/§5c + §11 on-chain behaviour) ----
const FEE = (a: bigint, bps: bigint): bigint => (bps === 0n || a === 0n ? 0n : CEIL(a * bps, 10_000n))
function refPumpBuyQuoteIn(effQ: bigint, baseReserve: bigint, spendable: bigint, f: FeeBps): { baseOut: bigint; debit: bigint } {
  const total = f.lpBps + f.protocolBps + f.creatorBps
  let E = (spendable * 10_000n) / (10_000n + total)
  const fees = FEE(E, f.lpBps) + FEE(E, f.protocolBps) + FEE(E, f.creatorBps)   // note §5b: fees are computed once, on the uncorrected E
  if (E + fees > spendable) E -= E + fees - spendable                            // single correction, fees NOT recomputed
  const input = E - 1n
  if (input <= 0n) return { baseOut: 0n, debit: 0n }
  return { baseOut: (baseReserve * input) / (effQ + input), debit: E + fees }
}
function refPumpSell(effQ: bigint, baseReserve: bigint, baseIn: bigint, f: FeeBps): { userOut: bigint; quoteOut: bigint } {
  const quoteOut = (effQ * baseIn) / (baseReserve + baseIn)
  return { userOut: quoteOut - FEE(quoteOut, f.lpBps) - FEE(quoteOut, f.protocolBps) - FEE(quoteOut, f.creatorBps), quoteOut }
}

describe('Raydium CPMM: adapter math vs an independent re-derivation from the note', () => {
  it('agrees on 400 random states (all fee tiers, both creator-fee positions)', () => {
    const r = rng(20260917); let checked = 0
    for (let i = 0; i < 400; i++) {
      const rIn = big(r, 1_000, 5_000_000_000_000), rOut = big(r, 1_000, 5_000_000_000_000)
      const amountIn = big(r, 1, Number(rIn > 10_000_000_000n ? 10_000_000_000n : rIn))
      const f: FeeRates = { tradeFeeRate: pick(r, [2500n, 3000n, 5000n, 10_000n, 15_000n, 20_000n, 25_000n]), creatorFeeRate: pick(r, [0n, 500n, 1000n]), protocolFeeRate: 120_000n, fundFeeRate: 40_000n }
      const onInput = r() < 0.5
      const mine = curveSwapBaseInput(amountIn, rIn, rOut, f, onInput)
      const ref = refRaydiumSwapBaseInput(amountIn, rIn, rOut, f, onInput)
      if (mine === null) { expect(ref.out < 0n || amountIn === 0n).toBe(true); continue }
      expect({ out: mine.outputAmount, trade: mine.tradeFee, creator: mine.creatorFee, protocol: mine.protocolFee, fund: mine.fundFee })
        .toEqual({ out: ref.out, trade: ref.tradeFee, creator: ref.creatorFee, protocol: ref.protocolFee, fund: ref.fundFee })
      checked++
    }
    expect(checked).toBeGreaterThan(350)
  })
})
describe('PumpSwap: adapter math vs an independent re-derivation from the note', () => {
  const state = (quoteVault: bigint, baseReserve: bigint, virtual: bigint): PoolMathState => ({ baseReserve, quoteReserve: quoteVault, virtualQuoteReserves: virtual })
  it('buy_exact_quote_in and sell agree on 400 random states (tiers, creator on/off, boosted pools)', () => {
    const r = rng(776655); let buys = 0, sells = 0
    for (let i = 0; i < 400; i++) {
      const baseReserve = big(r, 1_000_000, 900_000_000_000_000), quoteVault = big(r, 1_000_000, 5_000_000_000_000)
      const virtual = r() < 0.3 ? big(r, 0, 20_000_000_000) : 0n
      const f: FeeBps = pick(r, [{ lpBps: 20n, protocolBps: 5n, creatorBps: 5n }, { lpBps: 2n, protocolBps: 93n, creatorBps: 30n }, { lpBps: 25n, protocolBps: 5n, creatorBps: 0n }, { lpBps: 20n, protocolBps: 5n, creatorBps: 95n }])
      const effQ = quoteVault + virtual
      const spend = big(r, 1_000, 2_000_000_000)
      const mineBuy = buyQuoteInput(state(quoteVault, baseReserve, virtual), f, spend)
      const refBuy = refPumpBuyQuoteIn(effQ, baseReserve, spend, f)
      if (mineBuy.ok && refBuy.baseOut > 0n) { expect({ o: mineBuy.baseOut, d: mineBuy.totalWithFees }).toEqual({ o: refBuy.baseOut, d: refBuy.debit }); buys++ }
      const baseIn = big(r, 1, Number(baseReserve > 1_000_000_000_000n ? 1_000_000_000_000n : baseReserve))
      const mineSell = sellBaseInput(state(quoteVault, baseReserve, virtual), f, baseIn)
      const refSell = refPumpSell(effQ, baseReserve, baseIn, f)
      if (mineSell.ok) { expect({ u: mineSell.userQuoteOut, q: mineSell.quoteAmountOut }).toEqual({ u: refSell.userOut, q: refSell.quoteOut }); sells++ }
      else expect(quoteVault < refSell.quoteOut - FEE(refSell.quoteOut, f.lpBps)).toBe(true)   // only the BOOST real-reserve cap may reject
    }
    expect(buys).toBeGreaterThan(300); expect(sells).toBeGreaterThan(300)
  })
})
