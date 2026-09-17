/**
 * Cross-checks the adapter's offline math against @pump-fun/pump-swap-sdk 1.20.0 (devDependency; pure functions, no network)
 * on 200 seeded random states. Any difference must be 0 (or an explained, asserted equivalence such as reject vs. throw).
 */
import { describe, it, expect } from 'vitest'
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { buyQuoteInput as sdkBuyQuoteInput, sellBaseInput as sdkSellBaseInput, buyBaseInput as sdkBuyBaseInput, computeFeesBps as sdkComputeFeesBps } from '@pump-fun/pump-swap-sdk'
import { loadFixture, fixtureToRaw } from '../helpers/fixtures.js'
import { isUnsupported } from '../../src/adapters/types.js'
import { WSOL_MINT } from '../../src/state/token.js'
import { decodeGlobalConfig, decodeFeeConfig, pumpPoolAuthorityPda, type PumpPool, type PumpGlobalConfig, type PumpFeeConfig, type Fees } from '../../src/adapters/pumpswap/layout.js'
import { selectFeeSchedule } from '../../src/adapters/pumpswap/fees.js'
import { buyQuoteInput, sellBaseInput, buyBaseInput } from '../../src/adapters/pumpswap/math.js'

type SdkArgs = Parameters<typeof sdkBuyQuoteInput>[0]
type SdkGlobalConfig = SdkArgs['globalConfig']
type SdkFeeConfig = NonNullable<SdkArgs['feeConfig']>
const bn = (x: bigint) => new BN(x.toString())
const fees = (f: Fees) => ({ lpFeeBps: bn(f.lpFeeBps), protocolFeeBps: bn(f.protocolFeeBps), creatorFeeBps: bn(f.creatorFeeBps) })
function sdkGlobalConfig(g: PumpGlobalConfig): SdkGlobalConfig {
  return {
    admin: g.admin, lpFeeBasisPoints: bn(g.lpFeeBasisPoints), protocolFeeBasisPoints: bn(g.protocolFeeBasisPoints), disableFlags: g.disableFlags, protocolFeeRecipients: g.protocolFeeRecipients,
    coinCreatorFeeBasisPoints: bn(g.coinCreatorFeeBasisPoints), adminSetCoinCreatorAuthority: g.adminSetCoinCreatorAuthority, whitelistPda: g.whitelistPda, reservedFeeRecipient: g.reservedFeeRecipient,
    mayhemModeEnabled: g.mayhemModeEnabled, reservedFeeRecipients: g.reservedFeeRecipients, isCashbackEnabled: g.isCashbackEnabled, buybackFeeRecipients: g.buybackFeeRecipients, buybackBasisPoints: bn(g.buybackBasisPoints),
    boostAuthority: g.boostAuthority, boostEnabled: g.boostEnabled, creatorFeeConfigurable: g.creatorFeeConfigurable, maxConfigurableCreatorFeeBps: bn(g.maxConfigurableCreatorFeeBps),
  }
}
function sdkFeeConfig(f: PumpFeeConfig): SdkFeeConfig {
  return { admin: f.admin, flatFees: fees(f.flatFees), feeTiers: f.feeTiers.map(t => ({ marketCapLamportsThreshold: bn(t.marketCapLamportsThreshold), fees: fees(t.fees) })), stableFeeTiers: f.stableFeeTiers.map(t => ({ marketCapLamportsThreshold: bn(t.marketCapLamportsThreshold), fees: fees(t.fees) })), exoticFlatFees: fees(f.exoticFlatFees) }
}
/** deterministic PRNG (mulberry32) */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const randBig = (r: () => number, lo: bigint, hi: bigint): bigint => { const span = hi - lo; const bits = BigInt(Math.floor(r() * 2 ** 32)) * 2n ** 32n + BigInt(Math.floor(r() * 2 ** 32)); return lo + (bits % (span + 1n)) }
const randKey = (r: () => number): PublicKey => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = Math.floor(r() * 256); return new PublicKey(b) }

const globals = loadFixture('tests/fixtures/pumpswap/global.json')
const gc = decodeGlobalConfig(fixtureToRaw(globals.accounts.find(a => a.note?.startsWith('GlobalConfig'))!).data); if (isUnsupported(gc)) throw new Error(gc.reason)
const fc = decodeFeeConfig(fixtureToRaw(globals.accounts.find(a => a.note?.startsWith('FeeConfig'))!).data); if (isUnsupported(fc)) throw new Error(fc.reason)
const SGC = sdkGlobalConfig(gc), SFC = sdkFeeConfig(fc)

describe('pumpswap math vs @pump-fun/pump-swap-sdk 1.20.0 offline functions (200 seeded random states)', () => {
  it('fee schedule, buyQuoteInput, sellBaseInput, buyBaseInput agree exactly', () => {
    const r = rng(20260917)
    const stats = { states: 0, feeAgree: 0, buyQuote: 0, sell: 0, sellRejectBoth: 0, buyBase: 0, canonical: 0, creatorSet: 0, boosted: 0, override: 0, mayhem: 0 }
    const diffs: string[] = []
    for (let i = 0; i < 200; i++) {
      const baseMint = randKey(r)
      const canonical = r() < 0.7; const creator = canonical ? pumpPoolAuthorityPda(baseMint) : randKey(r)
      const coinCreator = r() < 0.3 ? PublicKey.default : randKey(r)
      const isMayhemMode = r() < 0.1; const creatorFeeBps = r() < 0.15 ? randBig(r, 1n, 300n) : 0n
      const baseReserve = randBig(r, 1_000_000n, 1_000_000_000_000_000n)
      const quoteReserve = randBig(r, 1_000_000n, 10_000_000_000_000n)
      const virtualQuoteReserves = r() < 0.6 ? 0n : r() < 0.5 ? 17_584_505_289n : randBig(r, 1n, 100_000_000_000n)
      const baseMintSupply = baseReserve + randBig(r, 0n, 1_000_000_000_000_000n)
      const pool: PumpPool = { poolBump: 0, index: canonical ? 0 : 1, creator, baseMint, quoteMint: WSOL_MINT, lpMint: PublicKey.default, poolBaseTokenAccount: PublicKey.default, poolQuoteTokenAccount: PublicKey.default, lpSupply: 0n, coinCreator, isMayhemMode, isCashbackCoin: false, virtualQuoteReserves, creatorFeeBps, canEditCreatorFee: false, isHolderReward: false, layoutLength: 271, defaultedFields: [] }
      const effQ = quoteReserve + virtualQuoteReserves
      const mine = selectFeeSchedule({ pool, globalConfig: gc, feeConfig: fc, baseMintSupply, baseReserve, effectiveQuoteReserve: effQ }); if (isUnsupported(mine)) throw new Error(mine.reason)
      const common = { baseReserve: bn(baseReserve), quoteReserve: bn(quoteReserve), virtualQuoteReserves: bn(virtualQuoteReserves), globalConfig: SGC, baseMintAccount: { supply: baseMintSupply } as unknown as SdkArgs['baseMintAccount'], baseMint, coinCreator, creator, feeConfig: SFC, quoteMint: WSOL_MINT, isMayhemMode, creatorFeeBps: bn(creatorFeeBps) }
      const sdkFees = sdkComputeFeesBps({ globalConfig: SGC, feeConfig: SFC, creator, baseMintSupply: bn(baseMintSupply), baseMint, baseReserve: bn(baseReserve), quoteReserve: bn(effQ), quoteMint: WSOL_MINT, isMayhemMode, creatorFeeBps: bn(creatorFeeBps) })
      stats.states++; if (canonical) stats.canonical++; if (!coinCreator.equals(PublicKey.default)) stats.creatorSet++; if (virtualQuoteReserves > 0n) stats.boosted++; if (mine.overrideApplied) stats.override++; if (isMayhemMode) stats.mayhem++
      if (sdkFees.lpFeeBps.toString() === mine.lpBps.toString() && sdkFees.protocolFeeBps.toString() === mine.protocolBps.toString() && sdkFees.creatorFeeBps.toString() === mine.scheduleCreatorBps.toString()) stats.feeAgree++
      else diffs.push(`fees#${i}: sdk ${sdkFees.lpFeeBps}/${sdkFees.protocolFeeBps}/${sdkFees.creatorFeeBps} mine ${mine.lpBps}/${mine.protocolBps}/${mine.scheduleCreatorBps}`)
      const feeBps = { lpBps: mine.lpBps, protocolBps: mine.protocolBps, creatorBps: mine.creatorBps }
      const s = { baseReserve, quoteReserve, virtualQuoteReserves }
      // buy quote-exact
      const quote = randBig(r, 1_000n, 10_000_000_000n)
      const sq = sdkBuyQuoteInput({ ...common, quote: bn(quote), slippage: 0 }); const mq = buyQuoteInput(s, feeBps, quote)
      if (mq.ok && sq.base.toString() === mq.baseOut.toString() && sq.internalQuoteWithoutFees.toString() === mq.effectiveQuote.toString()) stats.buyQuote++
      else diffs.push(`buyQuote#${i} q=${quote}: sdk base=${sq.base} eff=${sq.internalQuoteWithoutFees} mine ${JSON.stringify(mq, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
      // sell base-exact (SDK throws on the BOOST cap; we reject)
      const baseIn = randBig(r, 1n, baseReserve / 2n + 1n)
      let sdkSell: { uiQuote: BN; internalQuoteAmountOut: BN } | string
      try { sdkSell = sdkSellBaseInput({ ...common, base: bn(baseIn), slippage: 0 }) } catch (e) { sdkSell = (e as Error).message }
      const ms = sellBaseInput(s, feeBps, baseIn)
      if (typeof sdkSell === 'string') { if (!ms.ok && ((ms.reject === 'BOOST_REAL_RESERVE_CAP' && /Insufficient real quote/.test(sdkSell)) || (ms.reject === 'ZERO_OUT' && /negative/.test(sdkSell)))) stats.sellRejectBoth++; else diffs.push(`sell#${i}: sdk threw "${sdkSell}" mine ${JSON.stringify(ms, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`) }
      else if (ms.ok && sdkSell.uiQuote.toString() === ms.userQuoteOut.toString() && sdkSell.internalQuoteAmountOut.toString() === ms.quoteAmountOut.toString()) stats.sell++
      else if (!ms.ok && ms.reject === 'ZERO_OUT' && sdkSell.uiQuote.isZero()) stats.sellRejectBoth++ // SDK returns 0 output; we reject instead of quoting 0
      else diffs.push(`sell#${i} base=${baseIn}: sdk ui=${sdkSell.uiQuote} raw=${sdkSell.internalQuoteAmountOut} mine ${JSON.stringify(ms, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
      // buy base-exact
      const baseOut = randBig(r, 1n, baseReserve - 1n)
      const sb = sdkBuyBaseInput({ ...common, base: bn(baseOut), slippage: 0 }); const mb = buyBaseInput(s, feeBps, baseOut)
      if (mb.ok && sb.uiQuote.toString() === mb.userQuoteIn.toString() && sb.internalQuoteAmount.toString() === mb.quoteAmountIn.toString()) stats.buyBase++
      else diffs.push(`buyBase#${i} base=${baseOut}: sdk ui=${sb.uiQuote} raw=${sb.internalQuoteAmount} mine ${JSON.stringify(mb, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
    }
    console.log(JSON.stringify(stats))
    expect(diffs, diffs.slice(0, 5).join('\n')).toEqual([])
    expect(stats.feeAgree).toBe(200); expect(stats.buyQuote).toBe(200); expect(stats.buyBase).toBe(200); expect(stats.sell + stats.sellRejectBoth).toBe(200)
    expect(stats.canonical).toBeGreaterThan(100); expect(stats.boosted).toBeGreaterThan(50); expect(stats.override).toBeGreaterThan(5); expect(stats.mayhem).toBeGreaterThan(5)
  })
})
