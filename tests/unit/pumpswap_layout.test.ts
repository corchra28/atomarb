import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { loadFixture, fixtureToRaw } from '../helpers/fixtures.js'
import { isUnsupported } from '../../src/adapters/types.js'
import {
  decodePool, decodeGlobalConfig, decodeFeeConfig, POOL_OFF, POOL_KNOWN_LENGTHS, GLOBAL_CONFIG_OFF, FEE_CONFIG_OFF, GLOBAL_CONFIG_PDA, FEE_CONFIG_PDA, EVENT_AUTHORITY_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA,
  pumpPoolAuthorityPda, poolPda, userVolumeAccumulatorPda, coinCreatorVaultAuthorityPda, poolV2Pda, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, IX_DISC,
} from '../../src/adapters/pumpswap/layout.js'

const FX = 'tests/fixtures/pumpswap'
const globals = loadFixture(`${FX}/global.json`)
const byNote = (f: ReturnType<typeof loadFixture>, note: string) => { const a = f.accounts.find(x => x.note?.startsWith(note)); if (!a) throw new Error(`fixture ${note} missing`); return fixtureToRaw(a) }
const canonicalFile = loadFixture(`${FX}/pool_canonical.json`), boostedFile = loadFixture(`${FX}/pool_boosted.json`), nonCanonFile = loadFixture(`${FX}/pool_noncanonical.json`)
const SOL = 1_000_000_000n

describe('pumpswap PDAs (pumpswap.md §1, §7)', () => {
  it('global PDAs recompute to the documented addresses', () => {
    expect(GLOBAL_CONFIG_PDA.toBase58()).toBe('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw')
    expect(FEE_CONFIG_PDA.toBase58()).toBe('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx')
    expect(EVENT_AUTHORITY_PDA.toBase58()).toBe('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR')
    expect(GLOBAL_VOLUME_ACCUMULATOR_PDA.toBase58()).toBe('C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw')
    expect(PUMP_AMM_PROGRAM_ID.toBase58()).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'); expect(PUMP_FEE_PROGRAM_ID.toBase58()).toBe('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
  })
  it('pool-authority / pool PDA / pool-v2 / creator vault recompute for the docs example and the live boosted pool', () => {
    const base = new PublicKey('7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump')
    expect(pumpPoolAuthorityPda(base).toBase58()).toBe('9XDYTfQKwW8sHPqnFdUreMmtmffmkHVPGTNV2e3LKxNW')
    expect(poolPda(0, pumpPoolAuthorityPda(base), base, new PublicKey('So11111111111111111111111111111111111111112')).toBase58()).toBe('GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J')
    const boostedBase = new PublicKey('DRWUnUkFbvA5T6DchUmdtZTLxpj6sdFFUHJxHucxpump')
    expect(pumpPoolAuthorityPda(boostedBase).toBase58()).toBe('7767EycEjoaV4w2bFFYKbE9KJQaeKGcPmrgBTpzAKWNe')
    expect(poolV2Pda(boostedBase).toBase58()).toBe('HTNtT8XpnmZHf1ZYkRXWWB3PsY9Qfok4idiCzEJNekkC') // live tx account [23]
    expect(userVolumeAccumulatorPda(new PublicKey('BmNtMV4cJJSoVCaS8VQAtKDVrikeLiTZXurSHXQNw2zj'))).toBeInstanceOf(PublicKey)
    expect(coinCreatorVaultAuthorityPda(PublicKey.default)).toBeInstanceOf(PublicKey)
    expect(IX_DISC.buyExactQuoteIn).toBe('c62e1552b4d9e870'); expect(IX_DISC.sell).toBe('33e685a4017f83ad'); expect(IX_DISC.buy).toBe('66063d1201daebea')
  })
})

describe('Pool layout (pumpswap.md §2) — byte-exact vs fixtures', () => {
  it('decodes the docs example canonical pool GseMAnN… (300 bytes, extended)', () => {
    const raw = byNote(canonicalFile, 'canonical pool')
    const p = decodePool(raw.data); if (isUnsupported(p)) throw new Error(p.reason)
    expect(p.layoutLength).toBe(300); expect(p.poolBump).toBe(254); expect(p.index).toBe(0)
    expect(p.creator.toBase58()).toBe('9XDYTfQKwW8sHPqnFdUreMmtmffmkHVPGTNV2e3LKxNW')
    expect(p.baseMint.toBase58()).toBe('7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump')
    expect(p.quoteMint.toBase58()).toBe('So11111111111111111111111111111111111111112')
    expect(p.lpMint.toBase58()).toBe('6dpnPD6UWDw5hbJEuPQwnCCMba1JYwHANKuL6GQ6otAH')
    expect(p.poolBaseTokenAccount.toBase58()).toBe('5jMpkf4JF4noHftLgNKyPNh6roVfPSGSjuEk3U4eLKRa')
    expect(p.poolQuoteTokenAccount.toBase58()).toBe('43DVcZR4kQFjh4Xm2i3DcneRxNjZp7HMud8yDrJWrDr8')
    expect(p.coinCreator.toBase58()).toBe('5L5k7gtNLbeXdzpvNrFshg1E1id1ceUDfc6vPUTxp98q')
    expect(p.isMayhemMode).toBe(false); expect(p.isCashbackCoin).toBe(false); expect(p.virtualQuoteReserves).toBe(0n)
    expect(p.creatorFeeBps).toBe(0n); expect(p.canEditCreatorFee).toBe(false); expect(p.isHolderReward).toBe(false); expect(p.defaultedFields).toEqual([])
    expect(p.lpSupply > 0n).toBe(true)
  })
  it('decodes the boosted pool FruHjS1… (301 bytes, virtual_quote_reserves = 17,584,505,289 i128)', () => {
    const p = decodePool(byNote(boostedFile, 'boosted pool').data); if (isUnsupported(p)) throw new Error(p.reason)
    expect(p.layoutLength).toBe(301); expect(p.virtualQuoteReserves).toBe(17_584_505_289n)
    expect(p.coinCreator.toBase58()).toBe('EnqsfbZWwVpjJzzut4mvXTtT6CEnMkNZs7UhNQZVcVPa'); expect(p.creator.toBase58()).toBe('7767EycEjoaV4w2bFFYKbE9KJQaeKGcPmrgBTpzAKWNe')
    expect(p.isHolderReward).toBe(false)
  })
  it('decodes the non-canonical pool (creator != pool-authority, coin_creator = default)', () => {
    const p = decodePool(byNote(nonCanonFile, 'noncanonical pool').data); if (isUnsupported(p)) throw new Error(p.reason)
    expect(p.coinCreator.equals(PublicKey.default)).toBe(true)
    expect(pumpPoolAuthorityPda(p.baseMint).equals(p.creator)).toBe(false)
  })
  it('historical lengths 211/243/244/245/261/270/271 decode with trailing fields defaulted to 0/false', () => {
    const full = byNote(boostedFile, 'boosted pool').data
    const expectDefaults: Record<number, string[]> = {
      211: ['coin_creator', 'is_mayhem_mode', 'is_cashback_coin', 'virtual_quote_reserves', 'creator_fee_bps', 'can_edit_creator_fee', 'is_holder_reward'],
      243: ['is_mayhem_mode', 'is_cashback_coin', 'virtual_quote_reserves', 'creator_fee_bps', 'can_edit_creator_fee', 'is_holder_reward'],
      244: ['is_cashback_coin', 'virtual_quote_reserves', 'creator_fee_bps', 'can_edit_creator_fee', 'is_holder_reward'],
      245: ['virtual_quote_reserves', 'creator_fee_bps', 'can_edit_creator_fee', 'is_holder_reward'],
      261: ['creator_fee_bps', 'can_edit_creator_fee', 'is_holder_reward'], 270: ['is_holder_reward'], 271: [],
    }
    for (const len of POOL_KNOWN_LENGTHS) {
      const p = decodePool(full.subarray(0, len)); if (isUnsupported(p)) throw new Error(`${len}: ${p.reason}`)
      expect(p.layoutLength).toBe(len); expect(p.defaultedFields).toEqual(expectDefaults[len] ?? ['?'])
      expect(p.virtualQuoteReserves).toBe(len >= POOL_OFF.virtualQuoteReserves + 16 ? 17_584_505_289n : 0n)
      expect(p.coinCreator.equals(PublicKey.default)).toBe(len < 243)
      expect(p.baseMint.toBase58()).toBe('DRWUnUkFbvA5T6DchUmdtZTLxpj6sdFFUHJxHucxpump')
    }
  })
  it('undocumented lengths, bad discriminator and non-bool bytes => UNKNOWN_LAYOUT', () => {
    const full = byNote(boostedFile, 'boosted pool').data
    for (const len of [8, 100, 210, 212, 242, 250, 262, 269, 272, 280, 299]) { const r = decodePool(full.subarray(0, len)); expect(isUnsupported(r) && r.code, `len ${len}`).toBe('UNKNOWN_LAYOUT') }
    const bad = new Uint8Array(full); bad[0] = bad[0]! ^ 0xff; const r = decodePool(bad); expect(isUnsupported(r) && r.code).toBe('UNKNOWN_LAYOUT')
    const badBool = new Uint8Array(full); badBool[POOL_OFF.isMayhemMode] = 7; const r2 = decodePool(badBool); expect(isUnsupported(r2) && r2.code).toBe('UNKNOWN_LAYOUT')
    expect(isUnsupported(decodePool(new Uint8Array(0)))).toBe(true)
  })
})

describe('GlobalConfig layout (pumpswap.md §3)', () => {
  const raw = byNote(globals, 'GlobalConfig')
  it('decodes the live 949-byte account to the documented values', () => {
    const g = decodeGlobalConfig(raw.data); if (isUnsupported(g)) throw new Error(g.reason)
    expect(g.layoutLength).toBe(949); expect(g.defaultedFields).toEqual([])
    expect(g.admin.toBase58()).toBe('FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF')
    expect(g.lpFeeBasisPoints).toBe(20n); expect(g.protocolFeeBasisPoints).toBe(5n); expect(g.disableFlags).toBe(0)
    expect(g.protocolFeeRecipients.map(k => k.toBase58().slice(0, 6))).toEqual(['62qc2C', '7VtfL8', '7hTckg', '9rPYyA', 'AVmoTt', 'FWsW1x', 'G5UZAV', 'JCRGum'])
    expect(g.coinCreatorFeeBasisPoints).toBe(5n)
    expect(g.adminSetCoinCreatorAuthority.toBase58()).toBe('UqN2p5bAzBqYdHXcgB6WLtuVrdvmy9JSAtgqZb3CMKw')
    expect(g.whitelistPda.toBase58()).toBe('BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s')
    expect(g.reservedFeeRecipient.toBase58()).toBe('GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS')
    expect(g.mayhemModeEnabled).toBe(true); expect(g.reservedFeeRecipients).toHaveLength(7); expect(g.isCashbackEnabled).toBe(true)
    expect(g.buybackFeeRecipients.map(k => k.toBase58().slice(0, 6))).toEqual(['5YxQFd', '9M4giF', 'GXPFM2', '3BpXnf', '5cjcW9', 'EHAAiT', '5eHhjP', 'A7hAgC'])
    expect(g.buybackBasisPoints).toBe(5000n)
    expect(g.boostAuthority.toBase58()).toBe('HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r'); expect(g.boostEnabled).toBe(true)
    expect(g.creatorFeeConfigurable).toBe(true); expect(g.maxConfigurableCreatorFeeBps).toBe(300n)
  })
  it('907 / 940-byte versions default the trailing fields; other lengths => UNKNOWN_LAYOUT', () => {
    const g907 = decodeGlobalConfig(raw.data.subarray(0, 907)); if (isUnsupported(g907)) throw new Error(g907.reason)
    expect(g907.defaultedFields).toEqual(['boost_authority', 'boost_enabled', 'creator_fee_configurable', 'max_configurable_creator_fee_bps'])
    expect(g907.boostEnabled).toBe(false); expect(g907.creatorFeeConfigurable).toBe(false); expect(g907.maxConfigurableCreatorFeeBps).toBe(0n); expect(g907.buybackBasisPoints).toBe(5000n)
    const g940 = decodeGlobalConfig(raw.data.subarray(0, 940)); if (isUnsupported(g940)) throw new Error(g940.reason)
    expect(g940.defaultedFields).toEqual(['creator_fee_configurable', 'max_configurable_creator_fee_bps']); expect(g940.boostEnabled).toBe(true)
    const withLen = (n: number) => { const b = new Uint8Array(n); b.set(raw.data.subarray(0, Math.min(n, raw.data.length))); return b }
    for (const len of [900, 908, 939, 941, 948, 950, 1000]) { const r = decodeGlobalConfig(withLen(len)); expect(isUnsupported(r) && r.code, `len ${len}`).toBe('UNKNOWN_LAYOUT') }
    const bad = new Uint8Array(raw.data); bad[3] = bad[3]! ^ 1; expect(isUnsupported(decodeGlobalConfig(bad))).toBe(true)
    expect(GLOBAL_CONFIG_OFF.end).toBe(949)
  })
})

describe('FeeConfig layout (pumpswap.md §4)', () => {
  const raw = byNote(globals, 'FeeConfig')
  it('decodes the live 4097-byte (post-exotic) account: flat 25/5/0, 25 SOL tiers, 25 stable tiers, exotic 20/5/5', () => {
    const f = decodeFeeConfig(raw.data); if (isUnsupported(f)) throw new Error(f.reason)
    expect(f.layoutLength).toBe(4097)
    expect(f.flatFees).toEqual({ lpFeeBps: 25n, protocolFeeBps: 5n, creatorFeeBps: 0n })
    expect(f.feeTiers).toHaveLength(25); expect(f.stableFeeTiers).toHaveLength(25)
    expect(f.feeTiers[0]!).toEqual({ marketCapLamportsThreshold: 0n, fees: { lpFeeBps: 2n, protocolFeeBps: 93n, creatorFeeBps: 30n } })
    expect(f.feeTiers[1]!).toEqual({ marketCapLamportsThreshold: 420n * SOL, fees: { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n } })
    expect(f.feeTiers[6]!.marketCapLamportsThreshold).toBe(9_820n * SOL); expect(f.feeTiers[6]!.fees.creatorFeeBps).toBe(70n)
    expect(f.feeTiers[19]!.marketCapLamportsThreshold).toBe(73_681n * SOL)
    expect(f.feeTiers[24]!).toEqual({ marketCapLamportsThreshold: 98_240n * SOL, fees: { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 5n } })
    expect(f.stableFeeTiers[1]!.marketCapLamportsThreshold).toBe(59_000_000_000n)
    expect(f.exoticFlatFees).toEqual({ lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 5n })
    expect(f.decodedEnd).toBe(2097) // 65 + 4 + 25*40 + 4 + 25*40 + 24
    for (let i = 1; i < f.feeTiers.length; i++) expect(f.feeTiers[i]!.marketCapLamportsThreshold > f.feeTiers[i - 1]!.marketCapLamportsThreshold).toBe(true)
    expect(FEE_CONFIG_OFF.feeTiers).toBe(65)
  })
  it('4073 (post-stable) and 2512 (pre-stable) prefixes decode with missing trailing fields; other lengths => UNKNOWN_LAYOUT', () => {
    const f4073 = decodeFeeConfig(raw.data.subarray(0, 4073)); if (isUnsupported(f4073)) throw new Error(f4073.reason)
    expect(f4073.stableFeeTiers).toHaveLength(25); expect(f4073.exoticFlatFees).toEqual({ lpFeeBps: 0n, protocolFeeBps: 0n, creatorFeeBps: 0n })
    const f2512 = decodeFeeConfig(raw.data.subarray(0, 2512)); if (isUnsupported(f2512)) throw new Error(f2512.reason)
    expect(f2512.feeTiers).toHaveLength(25); expect(f2512.stableFeeTiers).toEqual([]); expect(f2512.exoticFlatFees.lpFeeBps).toBe(0n)
    const withLen = (n: number) => { const b = new Uint8Array(n); b.set(raw.data.subarray(0, Math.min(n, raw.data.length))); return b }
    for (const len of [2511, 2513, 4000, 4072, 4074, 4096, 4098, 5000]) { const r = decodeFeeConfig(withLen(len)); expect(isUnsupported(r) && r.code, `len ${len}`).toBe('UNKNOWN_LAYOUT') }
    const bad = new Uint8Array(raw.data); bad[7] = bad[7]! ^ 1; expect(isUnsupported(decodeFeeConfig(bad))).toBe(true)
    // a tier-vector length that overruns the account is rejected, never read as garbage
    const overrun = new Uint8Array(raw.data); overrun[65] = 0xff; overrun[66] = 0xff; const r = decodeFeeConfig(overrun); expect(isUnsupported(r) && r.code).toBe('UNKNOWN_LAYOUT')
  })
})
