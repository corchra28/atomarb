import { describe, it, expect } from 'vitest'
import BN from 'bn.js'
import { CurveCalculator } from '@raydium-io/raydium-sdk-v2'
import * as M from '../../src/adapters/raydium_cpmm/math.js'
import { OverflowError, U64_MAX, U128_MAX } from '../../src/util/bigint.js'

/** deterministic PRNG (mulberry32) so the 300 states are reproducible */
function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const bn = (x: bigint) => new BN(x.toString())
const big = (x: BN) => BigInt(x.toString())
/** random bigint in [lo, hi] using the PRNG (up to ~2^53 granularity per draw, composed for larger ranges) */
function randBig(r: () => number, lo: bigint, hi: bigint): bigint { const span = hi - lo + 1n; const a = BigInt(Math.floor(r() * 2 ** 26)), b = BigInt(Math.floor(r() * 2 ** 26)), c = BigInt(Math.floor(r() * 2 ** 26)); return lo + ((a << 52n) | (b << 26n) | c) % span }
/** live mainnet fee tiers from /main/cpmm-config (note §3) + edge tiers */
const TRADE_TIERS = [2500n, 3000n, 5000n, 10000n, 15000n, 20000n, 25000n, 100n, 1n, 499_999n]

interface State { inputAmount: bigint; rIn: bigint; rOut: bigint; rates: M.FeeRates; onInput: boolean }
function randomState(r: () => number, i: number): State {
  const trade = TRADE_TIERS[i % TRADE_TIERS.length]!
  const creatorEnabled = i % 3 !== 0
  const creator = creatorEnabled ? (i % 2 === 0 ? 500n : randBig(r, 1n, 100_000n)) : 0n
  const protocol = i % 4 === 0 ? 120_000n : randBig(r, 0n, 500_000n), fund = i % 4 === 0 ? 40_000n : randBig(r, 0n, 1_000_000n - protocol)
  const rIn = randBig(r, 1_000n, 10n ** 15n), rOut = randBig(r, 1_000n, 10n ** 15n)
  const inputAmount = randBig(r, 1n, rIn / 2n + 1n)
  return { inputAmount, rIn, rOut, rates: { tradeFeeRate: trade, creatorFeeRate: creator, protocolFeeRate: protocol, fundFeeRate: fund }, onInput: i % 5 < 3 }
}
function sdkBaseIn(s: State) { return CurveCalculator.swapBaseInput(bn(s.inputAmount), bn(s.rIn), bn(s.rOut), bn(s.rates.tradeFeeRate), bn(s.rates.creatorFeeRate), bn(s.rates.protocolFeeRate), bn(s.rates.fundFeeRate), s.onInput) }

describe('raydium_cpmm math vs @raydium-io/raydium-sdk-v2 CurveCalculator (300 random states, 10 fee tiers)', () => {
  const r = rng(20260917)
  const states = Array.from({ length: 300 }, (_, i) => randomState(r, i))
  const exactCases = states.filter(s => !(s.onInput && s.rates.creatorFeeRate > 0n))
  const splitCases = states.filter(s => s.onInput && s.rates.creatorFeeRate > 0n)
  it(`swapBaseInput is byte-identical to the SDK whenever the creator fee is off or taken on the OUTPUT side (${exactCases.length} states)`, () => {
    expect(exactCases.length).toBeGreaterThan(100)
    for (const s of exactCases) {
      const ours = M.curveSwapBaseInput(s.inputAmount, s.rIn, s.rOut, s.rates, s.onInput); expect(ours).not.toBeNull(); if (!ours) continue
      const sdk = sdkBaseIn(s)
      expect(ours.outputAmount).toBe(big(sdk.outputAmount)); expect(ours.tradeFee).toBe(big(sdk.tradeFee)); expect(ours.protocolFee).toBe(big(sdk.protocolFee))
      expect(ours.fundFee).toBe(big(sdk.fundFee)); expect(ours.creatorFee).toBe(big(sdk.creatorFee))
      expect(ours.newInputVaultAmount).toBe(big(sdk.newInputVaultAmount)); expect(ours.newOutputVaultAmount).toBe(big(sdk.newOutputVaultAmount))
    }
  })
  it(`DOCUMENTED DEVIATION (note §5.6): creator fee on INPUT — SDK ceils trade and creator fees separately, the program ceils the SUM then floor-splits; totals differ by at most 1 base unit (${splitCases.length} states)`, () => {
    expect(splitCases.length).toBeGreaterThan(50)
    let differing = 0
    for (const s of splitCases) {
      const ours = M.curveSwapBaseInput(s.inputAmount, s.rIn, s.rOut, s.rates, s.onInput); expect(ours).not.toBeNull(); if (!ours) continue
      const sdk = sdkBaseIn(s)
      const ourTotal = ours.tradeFee + ours.creatorFee, sdkTotal = big(sdk.tradeFee) + big(sdk.creatorFee)
      // program: total = ceil(a·(t+c)); SDK: ceil(a·t) + ceil(a·c) ≥ ceil(a·(t+c)), and at most 1 more
      expect(sdkTotal - ourTotal === 0n || sdkTotal - ourTotal === 1n).toBe(true)
      // program's split is floor(total·c/(t+c)) — assert against the primary-source formula, not the SDK
      expect(ours.creatorFee).toBe(M.feeFloorDiv(ourTotal, s.rates.creatorFeeRate, s.rates.tradeFeeRate + s.rates.creatorFeeRate))
      expect(ours.tradeFee).toBe(M.feeCeilDiv(s.inputAmount, s.rates.tradeFeeRate + s.rates.creatorFeeRate, 1_000_000n)! - ours.creatorFee)
      // less input reaches the curve in the SDK when totals differ → SDK output ≤ ours; equal when totals agree
      expect(ours.outputAmount >= big(sdk.outputAmount)).toBe(true)
      if (sdkTotal === ourTotal) expect(ours.outputAmount).toBe(big(sdk.outputAmount)); else differing++
      // protocol/fund are carved from the (possibly different) trade fee with the same floor rule
      expect(ours.protocolFee).toBe(M.feeFloorDiv(ours.tradeFee, s.rates.protocolFeeRate, 1_000_000n))
      expect(ours.fundFee).toBe(M.feeFloorDiv(ours.tradeFee, s.rates.fundFeeRate, 1_000_000n))
    }
    // eslint-disable-next-line no-console
    console.log(`creator-on-input: ${differing}/${splitCases.length} states where the SDK's separate ceilings overcharge by 1 unit`)
  })
  it('swapBaseOutput matches the SDK exactly in all cases (SDK ports the same pre-fee/split formulas)', () => {
    for (const s of states) {
      const out = randBig(r, 1n, s.rOut / 2n + 1n)
      const ours = M.curveSwapBaseOutput(out, s.rIn, s.rOut, s.rates, s.onInput); expect(ours).not.toBeNull(); if (!ours) continue
      const sdk = CurveCalculator.swapBaseOutput(bn(out), bn(s.rIn), bn(s.rOut), bn(s.rates.tradeFeeRate), bn(s.rates.creatorFeeRate), bn(s.rates.protocolFeeRate), bn(s.rates.fundFeeRate), s.onInput)
      expect(ours.inputAmount).toBe(big(sdk.inputAmount)); expect(ours.tradeFee).toBe(big(sdk.tradeFee)); expect(ours.creatorFee).toBe(big(sdk.creatorFee))
      expect(ours.protocolFee).toBe(big(sdk.protocolFee)); expect(ours.fundFee).toBe(big(sdk.fundFee))
      expect(ours.newInputVaultAmount).toBe(big(sdk.newInputVaultAmount)); expect(ours.newOutputVaultAmount).toBe(big(sdk.newOutputVaultAmount))
    }
  })
  it('base-output is a right-inverse of base-input (feeding the exact-out input into exact-in yields ≥ the requested output)', () => {
    for (const s of states.slice(0, 100)) {
      const out = randBig(r, 1n, s.rOut / 3n + 1n)
      const bo = M.curveSwapBaseOutput(out, s.rIn, s.rOut, s.rates, s.onInput); if (!bo) continue
      const bi = M.curveSwapBaseInput(bo.inputAmount, s.rIn, s.rOut, s.rates, s.onInput); expect(bi).not.toBeNull(); if (!bi) continue
      expect(bi.outputAmount >= out).toBe(true)
    }
  })
})

describe('raydium_cpmm math: rounding directions and fee helpers (note §5.2)', () => {
  it('trading fee ceils, protocol/fund floor, creator (output) ceils, split floors, pre-fee ceils', () => {
    expect(M.tradingFee(1n, 2500n)).toBe(1n)                 // ceil(1·0.0025) = 1
    expect(M.tradingFee(400n, 2500n)).toBe(1n); expect(M.tradingFee(401n, 2500n)).toBe(2n)
    expect(M.protocolFeeOf(7n, 120000n)).toBe(0n); expect(M.protocolFeeOf(9n, 120000n)).toBe(1n)
    expect(M.fundFeeOf(24n, 40000n)).toBe(0n); expect(M.fundFeeOf(25n, 40000n)).toBe(1n)
    expect(M.creatorFeeOf(1n, 500n)).toBe(1n)
    expect(M.splitCreatorFee(7n, 2500n, 500n)).toBe(1n)      // floor(7·500/3000) = 1
    expect(M.calculatePreFeeAmount(997_500n, 2500n)).toBe(1_000_000n)
    expect(M.calculatePreFeeAmount(5n, 0n)).toBe(5n)
    expect(M.feeCeilDiv(1n, 1n, 0n)).toBeNull(); expect(M.feeFloorDiv(1n, 1n, 0n)).toBeNull()
  })
  it('constant product: floor on base-input, ceil on base-output, invariant never decreases (source test vectors)', () => {
    // vectors from constant_product.rs#constant_product_swap_rounding
    const vec: [bigint, bigint, bigint, bigint][] = [[10n, 4_000_000n, 70_000_000_000n, 174_999n], [20n, 30_000n - 20n, 10_000n, 6n], [19n, 30_000n - 20n, 10_000n, 6n], [18n, 30_000n - 20n, 10_000n, 6n], [10n, 20_000n, 30_000n, 14n], [10n, 20_000n - 9n, 30_000n, 14n], [10n, 20_000n - 10n, 30_000n, 15n], [100n, 60_000n, 30_000n, 49n], [99n, 60_000n, 30_000n, 49n], [98n, 60_000n, 30_000n, 48n]]
    for (const [a, x, y, exp] of vec) {
      const out = M.swapBaseInputWithoutFees(a, x, y); expect(out).toBe(exp)
      expect((x + a) * (y - out) >= x * y).toBe(true)
      const back = M.swapBaseOutputWithoutFees(out, x, y); expect(back <= a).toBe(true)
    }
  })
  it('Token-2022 transfer fee: ceil, cap, epoch selection, exact inverse per T22 mod.rs@18a8005', () => {
    const cfg: M.TransferFeeConfigView = { older: { epoch: 624n, maxFee: 3_906_250_000_000_000_000n, bps: 420 }, newer: { epoch: 698n, maxFee: 3_906_250_000_000_000_000n, bps: 269 } }
    expect(M.epochFeeTier(cfg, 697n).bps).toBe(420); expect(M.epochFeeTier(cfg, 698n).bps).toBe(269)
    expect(M.transferFeeCalculateFee(cfg.newer, 10_000n)).toBe(269n); expect(M.transferFeeCalculateFee(cfg.newer, 10_001n)).toBe(270n); expect(M.transferFeeCalculateFee(cfg.newer, 0n)).toBe(0n)
    const capped: M.TransferFeeTier = { epoch: 0n, maxFee: 100n, bps: 1000 }
    expect(M.transferFeeCalculateFee(capped, 10_000n)).toBe(100n)
    expect(M.transferFeeCalculatePreFeeAmount(capped, 9_000n)).toBe(9_100n)          // raw-post = 1000 >= max 100 → post+max
    expect(M.transferFeeCalculatePreFeeAmount(capped, 90n)).toBe(100n)               // ceil(90·10000/9000) = 100
    expect(M.transferFeeCalculatePreFeeAmount({ epoch: 0n, maxFee: 7n, bps: 10000 }, 5n)).toBe(12n)
    expect(M.transferFeeCalculatePreFeeAmount({ epoch: 0n, maxFee: 7n, bps: 0 }, 5n)).toBe(5n)
    // calculate_fee(x) >= calculate_inverse_fee(x - calculate_fee(x)) — the only relation the source guarantees
    for (const x of [1n, 37n, 999n, 10_000n, 123_456_789n]) { const f = M.transferFeeCalculateFee(cfg.newer, x)!; expect(f >= M.transferFeeCalculateInverseFee(cfg.newer, x - f)!).toBe(true) }
    const t22: M.MintFeeView = { program: 'token_2022', transferFee: cfg }
    expect(M.getTransferFee({ program: 'spl_token' }, 1036n, 10_000n)).toBe(0n)
    expect(M.getTransferFee({ program: 'token_2022' }, 1036n, 10_000n)).toBe(0n)
    expect(M.getTransferFee(t22, 1036n, 10_000n)).toBe(269n)
    expect(M.getTransferInverseFee(t22, 1036n, 0n)).toEqual({ ok: false, code: 'INVALID_INPUT', detail: expect.any(String) })
    const inv = M.getTransferInverseFee(t22, 1036n, 9_731n); expect(inv.ok).toBe(true); if (inv.ok) expect(M.transferFeeCalculateFee(cfg.newer, 9_731n + inv.fee)).toBe(inv.fee)
  })
  it('creator-fee-on rule is direction dependent (note §5.3 step 4) — the SDK gets this wrong (§5.6)', () => {
    expect(M.isCreatorFeeOnInput(0, 'ZeroForOne')).toBe(true); expect(M.isCreatorFeeOnInput(0, 'OneForZero')).toBe(true)
    expect(M.isCreatorFeeOnInput(1, 'ZeroForOne')).toBe(true); expect(M.isCreatorFeeOnInput(1, 'OneForZero')).toBe(false)
    expect(M.isCreatorFeeOnInput(2, 'ZeroForOne')).toBe(false); expect(M.isCreatorFeeOnInput(2, 'OneForZero')).toBe(true)
    expect(M.isCreatorFeeOnInput(3, 'ZeroForOne')).toBeNull()
  })
})

describe('raydium_cpmm math: overflow detection mirrors checked ops / unwrap panics', () => {
  it('curve helpers throw OverflowError where the program unwrap()s, return null where it returns None', () => {
    expect(() => M.swapBaseInputWithoutFees(1n << 100n, 1n, 1n << 100n)).toThrow(OverflowError)
    expect(() => M.swapBaseInputWithoutFees(0n, 0n, 5n)).toThrow(OverflowError) // division by zero
    expect(() => M.swapBaseOutputWithoutFees(10n, 5n, 10n)).toThrow(OverflowError) // y − Δy == 0
    expect(() => M.swapBaseOutputWithoutFees(11n, 5n, 10n)).toThrow(OverflowError) // checked_sub underflow
    expect(M.feeCeilDiv(U128_MAX, 2n, 3n)).toBeNull()
    expect(M.curveSwapBaseInput(U128_MAX, 1n, 1n, { tradeFeeRate: 2500n, creatorFeeRate: 0n, protocolFeeRate: 0n, fundFeeRate: 0n }, false)).toBeNull()
    expect(M.calculatePreFeeAmount(U128_MAX, 2500n)).toBeNull()
  })
  it('simulateSwapBaseInput rejects non-u64 inputs and vault overflow without throwing', () => {
    const pool = { protocolFeesToken0: 0n, fundFeesToken0: 0n, creatorFeesToken0: 0n, protocolFeesToken1: 0n, fundFeesToken1: 0n, creatorFeesToken1: 0n, enableCreatorFee: false, creatorFeeOn: 0 } as unknown as import('../../src/adapters/raydium_cpmm/layout.js').PoolState
    const config = { tradeFeeRate: 2500n, protocolFeeRate: 120000n, fundFeeRate: 40000n, creatorFeeRate: 500n } as unknown as import('../../src/adapters/raydium_cpmm/layout.js').AmmConfig
    const ctx: M.SwapContext = { pool, config, direction: 'ZeroForOne', inputVaultAmount: U64_MAX - 10n, outputVaultAmount: 10n ** 18n, inputMint: { program: 'spl_token' }, outputMint: { program: 'spl_token' }, epoch: 0n }
    expect(M.simulateSwapBaseInput(ctx, 1n << 64n)).toMatchObject({ ok: false, code: 'U64_OVERFLOW' })
    expect(M.simulateSwapBaseInput(ctx, 1_000_000n)).toMatchObject({ ok: false, code: 'U64_OVERFLOW_VAULT' })
    expect(M.simulateSwapBaseInput({ ...ctx, inputVaultAmount: 5n }, 0n)).toMatchObject({ ok: false, code: 'REQUIRE_GT_VIOLATED' })
    const tiny = M.simulateSwapBaseInput({ ...ctx, inputVaultAmount: 10n ** 12n, outputVaultAmount: 10n }, 1n)
    expect(tiny).toMatchObject({ ok: false }) // 1 unit in: trade fee ceil = 1 → 0 reaches the curve → 0 out → amount_received == 0
    const pool2 = { ...pool, protocolFeesToken0: 100n }
    expect(M.simulateSwapBaseInput({ ...ctx, pool: pool2, inputVaultAmount: 50n }, 10n)).toMatchObject({ ok: false, code: 'INSUFFICIENT_VAULT' })
  })
})
