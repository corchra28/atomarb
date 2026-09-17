import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { loadFixture, fixtureToRaw, type AccountFixture } from '../helpers/fixtures.js'
import { isUnsupported } from '../../src/adapters/types.js'
import * as L from '../../src/adapters/raydium_cpmm/layout.js'
import { parseMint, parseTokenAccount } from '../../src/state/token.js'
import { sha256Hex } from '../../src/util/hash.js'
import { readU64LE, readPubkey } from '../../src/util/bytes.js'

const DIR = new URL('../fixtures/raydium_cpmm/', import.meta.url).pathname
const poolFiles = readdirSync(DIR).filter(f => /^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(f))
const byRole = (accs: AccountFixture[]) => Object.fromEntries(accs.map(a => [a.note!, fixtureToRaw(a)]))

describe('raydium_cpmm layout: constants match the Anchor discriminator convention (note §0, §2, §3, §6)', () => {
  it('account discriminators = sha256("account:<Name>")[..8]', () => {
    expect(sha256Hex('account:PoolState').slice(0, 16)).toBe(L.POOL_STATE_DISCRIMINATOR_HEX)
    expect(sha256Hex('account:AmmConfig').slice(0, 16)).toBe(L.AMM_CONFIG_DISCRIMINATOR_HEX)
    expect(sha256Hex('account:ObservationState').slice(0, 16)).toBe(L.OBSERVATION_STATE_DISCRIMINATOR_HEX)
  })
  it('PoolState::LEN and AmmConfig::LEN formulas from the source', () => {
    expect(8 + 10 * 32 + 1 * 5 + 8 * 7 + 1 * 2 + 6 * 1 + 2 * 8 + 8 * 28).toBe(L.POOL_STATE_LEN)
    expect(8 + 1 + 1 + 2 + 4 * 8 + 32 * 2 + 8 + 8 * 15).toBe(L.AMM_CONFIG_LEN)
    expect(8 + 1 + 2 + 32 + 40 * 100 + 8 * 4).toBe(L.OBSERVATION_STATE_LEN)
    expect(L.POOL_OFF.END).toBe(L.POOL_STATE_LEN); expect(L.CONFIG_OFF.END).toBe(L.AMM_CONFIG_LEN)
  })
  it('authority PDA and config-0 PDA match the note (§1, §3)', () => {
    const [auth, bump] = L.authorityPda()
    expect(auth.toBase58()).toBe('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL'); expect(bump).toBe(253)
    expect(L.ammConfigPda(0)[0].toBase58()).toBe('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2')
    expect(L.ammConfigPda(5)[0].toBase58()).toBe('BgxH5ifebqHDuiADWKhLjXGP5hWZeZLoCdmeWJLkRqLP')
  })
})

describe.each(poolFiles)('raydium_cpmm layout: byte-exact decode of fixture %s', file => {
  const fx = loadFixture(DIR + file); const r = byRole(fx.accounts)
  const poolKey = new PublicKey(file.replace('.json', ''))
  it('PoolState decodes and every pubkey field equals the raw bytes at the documented offset', () => {
    const st = L.decodePoolState(r['pool_state']!.data); expect(isUnsupported(st)).toBe(false); if (isUnsupported(st)) return
    const d = r['pool_state']!.data
    expect(st.ammConfig.equals(readPubkey(d, 8))).toBe(true)
    expect(st.token0Vault.equals(readPubkey(d, 72))).toBe(true); expect(st.token1Vault.equals(readPubkey(d, 104))).toBe(true)
    expect(st.token0Mint.equals(readPubkey(d, 168))).toBe(true); expect(st.token1Mint.equals(readPubkey(d, 200))).toBe(true)
    expect(st.observationKey.equals(readPubkey(d, 296))).toBe(true)
    expect(st.openTime).toBe(readU64LE(d, 373)); expect(st.protocolFeesToken0).toBe(readU64LE(d, 341)); expect(st.creatorFeesToken1).toBe(readU64LE(d, 405))
    expect(st.lpMintDecimals).toBe(9); expect(st.authBump).toBe(253); expect(st.paddingNonZero).toBe(false)
    expect(Buffer.from(st.token0Mint.toBytes()).compare(Buffer.from(st.token1Mint.toBytes()))).toBeLessThan(0) // token_0_mint < token_1_mint
  })
  it('all PDAs re-derive from the pool key (vaults, lp mint, observation, pool itself for these fixtures, config by index)', () => {
    const st = L.decodePoolState(r['pool_state']!.data); if (isUnsupported(st)) throw new Error(st.reason)
    const cfg = L.decodeAmmConfig(r['amm_config']!.data); if (isUnsupported(cfg)) throw new Error(cfg.reason)
    expect(L.poolVaultPda(poolKey, st.token0Mint)[0].equals(st.token0Vault)).toBe(true)
    expect(L.poolVaultPda(poolKey, st.token1Mint)[0].equals(st.token1Vault)).toBe(true)
    expect(L.lpMintPda(poolKey)[0].equals(st.lpMint)).toBe(true)
    expect(L.observationPda(poolKey)[0].equals(st.observationKey)).toBe(true)
    expect(L.poolPda(st.ammConfig, st.token0Mint, st.token1Mint)[0].equals(poolKey)).toBe(true)
    expect(L.ammConfigPda(cfg.index)[0].equals(st.ammConfig)).toBe(true)
    expect(r['amm_config']!.pubkey.equals(st.ammConfig)).toBe(true)
  })
  it('AmmConfig decodes with creator_fee_rate at 108 and padding 116..124 == 0', () => {
    const cfg = L.decodeAmmConfig(r['amm_config']!.data); if (isUnsupported(cfg)) throw new Error(cfg.reason)
    expect(cfg.creatorFeeRate).toBe(readU64LE(r['amm_config']!.data, 108))
    expect(cfg.tradeFeeRate).toBe(readU64LE(r['amm_config']!.data, 12))
    expect(cfg.protocolFeeRate).toBe(120000n); expect(cfg.fundFeeRate).toBe(40000n); expect(cfg.creatorFeeRate).toBe(500n)
    expect(cfg.padding0).toBe(0n); expect(cfg.tradeFeeRate + cfg.creatorFeeRate < 1_000_000n).toBe(true)
  })
  it('vault/mint accounts parse and the vault owner is the authority PDA; observation header points at the pool', () => {
    const st = L.decodePoolState(r['pool_state']!.data); if (isUnsupported(st)) throw new Error(st.reason)
    const v0 = parseTokenAccount(r['token_0_vault']!), v1 = parseTokenAccount(r['token_1_vault']!)
    expect(v0.owner.equals(L.authorityPda()[0])).toBe(true); expect(v1.owner.equals(L.authorityPda()[0])).toBe(true)
    expect(v0.mint.equals(st.token0Mint)).toBe(true); expect(v1.mint.equals(st.token1Mint)).toBe(true)
    const m0 = parseMint(r['token_0_mint']!), m1 = parseMint(r['token_1_mint']!)
    expect(m0.decimals).toBe(st.mint0Decimals); expect(m1.decimals).toBe(st.mint1Decimals)
    const obs = L.decodeObservationHeader(r['observation_state']!.data); if (isUnsupported(obs)) throw new Error(obs.reason)
    expect(obs.poolId.equals(poolKey)).toBe(true); expect(obs.initialized).toBe(true)
  })
})

describe('raydium_cpmm layout: unknown layouts are UNSUPPORTED, never a fake decode', () => {
  const fx = loadFixture(DIR + poolFiles[0]!); const r = byRole(fx.accounts)
  it('rejects a truncated / extended PoolState (no length-based versioning documented)', () => {
    const d = r['pool_state']!.data
    for (const bad of [d.subarray(0, 636), new Uint8Array([...d, 0]), new Uint8Array(0), d.subarray(0, 8)]) {
      const x = L.decodePoolState(bad); expect(isUnsupported(x)).toBe(true); if (isUnsupported(x)) expect(x.code).toBe('UNKNOWN_LAYOUT')
    }
  })
  it('rejects a wrong discriminator with the right length', () => {
    const d = new Uint8Array(r['pool_state']!.data); d[0] = d[0]! ^ 0xff
    const x = L.decodePoolState(d); expect(isUnsupported(x) && x.code === 'UNKNOWN_LAYOUT').toBe(true)
    const c = new Uint8Array(r['amm_config']!.data); c[7] = c[7]! ^ 1
    const y = L.decodeAmmConfig(c); expect(isUnsupported(y) && y.code === 'UNKNOWN_LAYOUT').toBe(true)
  })
  it('rejects an AmmConfig of the wrong length', () => {
    const c = r['amm_config']!.data
    expect(isUnsupported(L.decodeAmmConfig(c.subarray(0, 235)))).toBe(true)
    expect(isUnsupported(L.decodeAmmConfig(new Uint8Array([...c, 0, 0, 0, 0, 0, 0, 0, 0])))).toBe(true)
  })
})
