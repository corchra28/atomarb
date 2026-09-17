import { describe, it, expect } from 'vitest'
import { buyBaseInput, buyQuoteInput, sellBaseInput, feeCeil, transferFeeAmount } from '../../src/adapters/pumpswap/math.js'

/** Live events from docs/sources/pumpswap.md §5 (S3, slot 447788562 / 447788793). */
describe('pumpswap math vs live events (pumpswap.md §5)', () => {
  it('5a buy base-exact reproduces BuyEvent 5ZD6eMu… (boosted pool, 20/5/5 bps)', () => {
    const r = buyBaseInput({ baseReserve: 3_184_958_896_915n, quoteReserve: 5_517_775_266_487n, virtualQuoteReserves: 17_584_505_289n }, { lpBps: 20n, protocolBps: 5n, creatorBps: 5n }, 828_079n)
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.quoteAmountIn).toBe(1_439_176n)
    expect(r.lpFee).toBe(2_879n) // ceil (floor would give 2,878)
    expect(r.protocolFee).toBe(720n)
    expect(r.creatorFee).toBe(720n)
    expect(r.userQuoteIn).toBe(1_443_495n)
  })
  it('5a buy base-exact reproduces BuyEvents uxqpyrf… and 2JyPPRp… (virtual reserve 17,584,505,288)', () => {
    const a = buyBaseInput({ baseReserve: 1_952_776_957_977n, quoteReserve: 9_020_611_126_912n, virtualQuoteReserves: 17_584_505_288n }, { lpBps: 20n, protocolBps: 5n, creatorBps: 5n }, 919_970n)
    expect(a.ok && a.quoteAmountIn).toBe(4_257_974n); expect(a.ok && a.lpFee).toBe(8_516n); expect(a.ok && a.protocolFee).toBe(2_129n); expect(a.ok && a.userQuoteIn).toBe(4_270_748n)
    const b = buyBaseInput({ baseReserve: 2_081_298_557_573n, quoteReserve: 8_461_039_579_568n, virtualQuoteReserves: 17_584_505_288n }, { lpBps: 20n, protocolBps: 5n, creatorBps: 5n }, 112_277n)
    expect(b.ok && b.quoteAmountIn).toBe(457_385n); expect(b.ok && b.lpFee).toBe(915n); expect(b.ok && b.protocolFee).toBe(229n); expect(b.ok && b.userQuoteIn).toBe(458_758n)
  })
  it('5a without the virtual reserve does NOT reproduce the event (pricing must use effective quote reserve)', () => {
    const r = buyBaseInput({ baseReserve: 3_184_958_896_915n, quoteReserve: 5_517_775_266_487n, virtualQuoteReserves: 0n }, { lpBps: 20n, protocolBps: 5n, creatorBps: 5n }, 828_079n)
    expect(r.ok && r.quoteAmountIn).not.toBe(1_439_176n)
  })
  it('5c sell reproduces SellEvent DLeuEpi… (non-canonical: flat 25/5, creator 0)', () => {
    const r = sellBaseInput({ baseReserve: 160_711_916_412n, quoteReserve: 188_656_064_728_009n, virtualQuoteReserves: 0n }, { lpBps: 25n, protocolBps: 5n, creatorBps: 0n }, 10_000n)
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.quoteAmountOut).toBe(11_738_771n) // floor (ceil would give 11,738,772)
    expect(r.lpFee).toBe(29_347n)
    expect(r.protocolFee).toBe(5_870n)
    expect(r.creatorFee).toBe(0n)
    expect(r.userQuoteOut).toBe(11_703_554n)
  })
  it('5c sell reproduces SellEvent 3WcdQTn…', () => {
    const r = sellBaseInput({ baseReserve: 116_224_220_003n, quoteReserve: 189_321_784_089_410n, virtualQuoteReserves: 0n }, { lpBps: 25n, protocolBps: 5n, creatorBps: 0n }, 190_218n)
    expect(r.ok && r.quoteAmountOut).toBe(309_852_388n); expect(r.ok && r.lpFee).toBe(774_631n); expect(r.ok && r.protocolFee).toBe(154_927n); expect(r.ok && r.userQuoteOut).toBe(308_922_830n)
  })
  it('BOOST cap: sell rejected when the real quote vault cannot cover quote_out - lp_fee', () => {
    // real vault 1 SOL, virtual 17.58 SOL: selling enough base to pull > 1 SOL of effective quote must be rejected
    const s = { baseReserve: 1_000_000_000_000n, quoteReserve: 1_000_000_000n, virtualQuoteReserves: 17_584_505_289n }
    const r = sellBaseInput(s, { lpBps: 20n, protocolBps: 5n, creatorBps: 5n }, 100_000_000_000n)
    expect(r.ok).toBe(false); if (r.ok) return
    expect(r.reject).toBe('BOOST_REAL_RESERVE_CAP')
    const small = sellBaseInput(s, { lpBps: 20n, protocolBps: 5n, creatorBps: 5n }, 1_000_000_000n)
    expect(small.ok).toBe(true)
  })
  it('buyQuoteInput: fees never exceed the budget and base_out is monotone in the budget', () => {
    const s = { baseReserve: 3_184_958_896_915n, quoteReserve: 5_517_775_266_487n, virtualQuoteReserves: 17_584_505_289n }
    let prev = 0n
    for (const q of [1_000n, 10_000n, 123_457n, 1_000_000n, 10_000_000n, 123_456_789n, 1_000_000_000n]) {
      const r = buyQuoteInput(s, { lpBps: 20n, protocolBps: 5n, creatorBps: 5n }, q)
      expect(r.ok, `q=${q}`).toBe(true); if (!r.ok) continue
      expect(r.totalWithFees <= q).toBe(true)
      expect(r.baseOut >= prev).toBe(true); prev = r.baseOut
      // the base-exact inverse never charges MORE than the budget for the quoted base_out
      const inv = buyBaseInput(s, { lpBps: 20n, protocolBps: 5n, creatorBps: 5n }, r.baseOut)
      expect(inv.ok && inv.userQuoteIn <= q, `inverse charges ${inv.ok && inv.userQuoteIn} > ${q}`).toBe(true)
    }
  })
  it('rejects: zero amounts, buy >= reserves, negative virtual reserves, empty pool', () => {
    const s = { baseReserve: 1_000n, quoteReserve: 1_000n, virtualQuoteReserves: 0n }
    const f = { lpBps: 20n, protocolBps: 5n, creatorBps: 0n }
    expect(buyBaseInput(s, f, 0n).ok).toBe(false); expect((buyBaseInput(s, f, 1_000n) as { reject: string }).reject).toBe('BUY_EXCEEDS_RESERVES')
    expect((sellBaseInput({ ...s, virtualQuoteReserves: -1n }, f, 10n) as { reject: string }).reject).toBe('NEGATIVE_VIRTUAL_QUOTE_RESERVES')
    expect((buyQuoteInput({ ...s, baseReserve: 0n }, f, 10n) as { reject: string }).reject).toBe('EMPTY_POOL')
    expect(buyQuoteInput(s, f, 0n).ok).toBe(false)
  })
  it('helpers: feeCeil and Token-2022 transfer fee (token2022.md §4)', () => {
    expect(feeCeil(1_439_176n, 20n)).toBe(2_879n)
    expect(feeCeil(0n, 20n)).toBe(0n); expect(feeCeil(100n, 0n)).toBe(0n)
    expect(transferFeeAmount(10_000n, { bps: 100, maxFee: 50n })).toBe(50n)
    expect(transferFeeAmount(10_001n, { bps: 100, maxFee: 1_000n })).toBe(101n) // ceil
    expect(transferFeeAmount(10_000n, null)).toBe(0n)
  })
})
