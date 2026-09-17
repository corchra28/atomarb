import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { loadFixture, fixtureToRaw } from '../helpers/fixtures.js'
import { isUnsupported } from '../../src/adapters/types.js'
import { WSOL_MINT } from '../../src/state/token.js'
import { decodeGlobalConfig, decodeFeeConfig, decodePool, pumpPoolAuthorityPda, type PumpPool } from '../../src/adapters/pumpswap/layout.js'
import { calculateFeeTier, feesForQuoteMint, poolMarketCap, isPumpPool, isSolLikeQuoteMint, selectFeeSchedule, USDC_MINT, NATIVE_MINT_2022, PUMP_AMM_TOTAL_TOKEN_SUPPLY } from '../../src/adapters/pumpswap/fees.js'

const FX = 'tests/fixtures/pumpswap'
const globals = loadFixture(`${FX}/global.json`)
const raw = (note: string) => fixtureToRaw(globals.accounts.find(a => a.note?.startsWith(note))!)
const gc = decodeGlobalConfig(raw('GlobalConfig').data); if (isUnsupported(gc)) throw new Error(gc.reason)
const fc = decodeFeeConfig(raw('FeeConfig').data); if (isUnsupported(fc)) throw new Error(fc.reason)
const SOL = 1_000_000_000n
const poolOf = (file: string): PumpPool => { const p = decodePool(fixtureToRaw(loadFixture(`${FX}/${file}`).accounts[0]!).data); if (isUnsupported(p)) throw new Error(p.reason); return p }
const canonical = poolOf('pool_canonical.json'), nonCanonical = poolOf('pool_noncanonical.json')

describe('fee tier selection (pumpswap.md §4)', () => {
  it('tiers by market cap: boundaries are inclusive at the threshold', () => {
    const t = (mcap: bigint) => calculateFeeTier(fc.feeTiers, mcap)
    expect(t(0n)).toEqual({ fees: { lpFeeBps: 2n, protocolFeeBps: 93n, creatorFeeBps: 30n }, tierIndex: 0 })
    expect(t(420n * SOL - 1n).tierIndex).toBe(0)
    expect(t(420n * SOL)).toEqual({ fees: { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n }, tierIndex: 1 })
    expect(t(1_470n * SOL).tierIndex).toBe(2); expect(t(1_470n * SOL - 1n).tierIndex).toBe(1)
    expect(t(98_240n * SOL - 1n).fees.creatorFeeBps).toBe(8n)
    expect(t(98_240n * SOL)).toEqual({ fees: { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 5n }, tierIndex: 24 })
    expect(t(10n ** 30n).tierIndex).toBe(24)
  })
  it('quote-mint routing: SOL-like → tiers, USDC → stable tiers, exotic → exotic flat, non-canonical → flat', () => {
    const mcap = 5_000n * SOL
    expect(feesForQuoteMint({ feeConfig: fc, isPumpPool: true, marketCap: mcap, quoteMint: WSOL_MINT }).fees.creatorFeeBps).toBe(75n)
    expect(feesForQuoteMint({ feeConfig: fc, isPumpPool: true, marketCap: mcap, quoteMint: PublicKey.default }).fees.creatorFeeBps).toBe(75n)
    expect(feesForQuoteMint({ feeConfig: fc, isPumpPool: true, marketCap: mcap, quoteMint: NATIVE_MINT_2022 }).fees.creatorFeeBps).toBe(75n)
    expect(feesForQuoteMint({ feeConfig: fc, isPumpPool: true, marketCap: 100_000_000_000n, quoteMint: USDC_MINT }).source).toMatch(/stable_fee_tiers\[1\]/) // 100,000 USDC (6 decimals) >= 59,000 USDC threshold
    expect(feesForQuoteMint({ feeConfig: fc, isPumpPool: true, marketCap: 58_999_999_999n, quoteMint: USDC_MINT }).source).toMatch(/stable_fee_tiers\[0\]/)
    expect(feesForQuoteMint({ feeConfig: fc, isPumpPool: true, marketCap: mcap, quoteMint: PublicKey.unique() }).fees).toEqual(fc.exoticFlatFees)
    expect(feesForQuoteMint({ feeConfig: { ...fc, exoticFlatFees: { lpFeeBps: 0n, protocolFeeBps: 0n, creatorFeeBps: 0n } }, isPumpPool: true, marketCap: mcap, quoteMint: PublicKey.unique() }).fees).toEqual(fc.flatFees)
    expect(feesForQuoteMint({ feeConfig: fc, isPumpPool: false, marketCap: mcap, quoteMint: WSOL_MINT }).fees).toEqual({ lpFeeBps: 25n, protocolFeeBps: 5n, creatorFeeBps: 0n })
    expect(feesForQuoteMint({ feeConfig: { ...fc, stableFeeTiers: [] }, isPumpPool: true, marketCap: 0n, quoteMint: USDC_MINT }).source).toMatch(/fee_tiers\[0\]/)
    expect(isSolLikeQuoteMint(USDC_MINT)).toBe(false)
  })
  it('market cap = floor(effQ * circulating / baseReserve); mayhem uses 1e15 circulating', () => {
    expect(poolMarketCap({ effectiveQuoteReserve: 127_506_693_554n, baseReserve: 649_596_913_609_305n, baseMintSupply: 999_186_688_000_000n, isMayhemMode: false })).toBe((127_506_693_554n * 999_186_688_000_000n) / 649_596_913_609_305n)
    expect(poolMarketCap({ effectiveQuoteReserve: 10n, baseReserve: 3n, baseMintSupply: 10n, isMayhemMode: false })).toBe(33n)
    expect(poolMarketCap({ effectiveQuoteReserve: 10n * SOL, baseReserve: 10n ** 15n, baseMintSupply: 1n, isMayhemMode: true })).toBe(10n * SOL * PUMP_AMM_TOTAL_TOKEN_SUPPLY / 10n ** 15n)
    expect(poolMarketCap({ effectiveQuoteReserve: 1n, baseReserve: 0n, baseMintSupply: 1n, isMayhemMode: false })).toBeNull()
  })
  it('isPumpPool uses pool.creator (not coin_creator)', () => {
    expect(isPumpPool(canonical.baseMint, canonical.creator)).toBe(true)
    expect(isPumpPool(nonCanonical.baseMint, nonCanonical.creator)).toBe(false)
    expect(isPumpPool(canonical.baseMint, canonical.coinCreator)).toBe(false)
    expect(pumpPoolAuthorityPda(canonical.baseMint).equals(canonical.creator)).toBe(true)
  })
})

describe('selectFeeSchedule (pumpswap.md §4 computeFeesBps)', () => {
  const base = { globalConfig: gc, feeConfig: fc }
  it('canonical pool below 420 SOL market cap pays tier 0 (2/93/30) with creator fee applied', () => {
    const s = selectFeeSchedule({ ...base, pool: canonical, baseMintSupply: 999_000_000_000_000n, baseReserve: 649_596_913_609_305n, effectiveQuoteReserve: 127_506_693_554n })
    if (isUnsupported(s)) throw new Error(s.reason)
    expect(s.isPumpPool).toBe(true); expect(s.tierIndex).toBe(0); expect([s.lpBps, s.protocolBps, s.creatorBps]).toEqual([2n, 93n, 30n]); expect(s.creatorFeeApplies).toBe(true)
    expect(s.marketCapLamports < 420n * SOL).toBe(true)
  })
  it('non-canonical pool pays flat 25/5 and creator fee is ZERO because coin_creator == default', () => {
    const s = selectFeeSchedule({ ...base, pool: nonCanonical, baseMintSupply: 10n ** 15n, baseReserve: 10n ** 12n, effectiveQuoteReserve: 10n ** 12n })
    if (isUnsupported(s)) throw new Error(s.reason)
    expect(s.isPumpPool).toBe(false); expect([s.lpBps, s.protocolBps, s.creatorBps]).toEqual([25n, 5n, 0n]); expect(s.creatorFeeApplies).toBe(false); expect(s.tierIndex).toBeNull()
  })
  it('creator fee is zero when coin_creator == default even on a canonical pool; schedule rate is still reported', () => {
    const s = selectFeeSchedule({ ...base, pool: { ...canonical, coinCreator: PublicKey.default }, baseMintSupply: 10n ** 15n, baseReserve: 10n ** 12n, effectiveQuoteReserve: 100_000n * SOL })
    if (isUnsupported(s)) throw new Error(s.reason)
    expect(s.tierIndex).toBe(24); expect(s.creatorBps).toBe(0n); expect(s.scheduleCreatorBps).toBe(5n); expect(s.creatorFeeApplies).toBe(false)
  })
  it('per-pool creator_fee_bps overrides the schedule creator rate only while creator_fee_configurable is on', () => {
    const args = { baseMintSupply: 10n ** 15n, baseReserve: 10n ** 12n, effectiveQuoteReserve: 100_000n * SOL }
    const on = selectFeeSchedule({ ...base, pool: { ...canonical, creatorFeeBps: 123n }, ...args }); if (isUnsupported(on)) throw new Error(on.reason)
    expect([on.lpBps, on.protocolBps, on.creatorBps]).toEqual([20n, 5n, 123n]); expect(on.overrideApplied).toBe(true)
    const off = selectFeeSchedule({ globalConfig: { ...gc, creatorFeeConfigurable: false }, feeConfig: fc, pool: { ...canonical, creatorFeeBps: 123n }, ...args }); if (isUnsupported(off)) throw new Error(off.reason)
    expect(off.creatorBps).toBe(5n); expect(off.overrideApplied).toBe(false)
    const zero = selectFeeSchedule({ ...base, pool: { ...canonical, creatorFeeBps: 0n }, ...args }); if (isUnsupported(zero)) throw new Error(zero.reason)
    expect(zero.overrideApplied).toBe(false)
  })
  it('mayhem pools use the fixed 1e15 circulating supply for the market cap', () => {
    const args = { baseMintSupply: 1n, baseReserve: 10n ** 12n, effectiveQuoteReserve: 100n * SOL }
    const normal = selectFeeSchedule({ ...base, pool: canonical, ...args }); const mayhem = selectFeeSchedule({ ...base, pool: { ...canonical, isMayhemMode: true }, ...args })
    if (isUnsupported(normal) || isUnsupported(mayhem)) throw new Error('unsupported')
    expect(normal.tierIndex).toBe(0); expect(mayhem.marketCapLamports).toBe(100n * SOL * PUMP_AMM_TOTAL_TOKEN_SUPPLY / 10n ** 12n); expect(mayhem.tierIndex).toBe(24)
  })
  it('empty base reserve => EMPTY_POOL', () => {
    const s = selectFeeSchedule({ ...base, pool: canonical, baseMintSupply: 1n, baseReserve: 0n, effectiveQuoteReserve: 1n })
    expect(isUnsupported(s) && s.code).toBe('EMPTY_POOL')
  })
})
