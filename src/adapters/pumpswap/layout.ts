/**
 * PumpSwap AMM (pump_amm) account layouts — byte-exact decoders.
 *
 * Every offset/discriminator/seed here is taken from docs/sources/pumpswap.md (sections cited inline), which was
 * verified against the pump_amm / pump_fees IDLs (S1), the @pump-fun/pump-swap-sdk 1.20.0 sources (S2) and live
 * mainnet bytes (S3). Nothing is guessed: any length or discriminator not documented there decodes to
 * unsupported('UNKNOWN_LAYOUT').
 */
import { PublicKey } from '@solana/web3.js'
import { readU8, readU16LE, readU32LE, readU64LE, readU128LE, readPubkey, hexOf } from '../../util/bytes.js'
import { unsupported, type Unsupported } from '../types.js'

// ---------------------------------------------------------------------------------------------------------------------
// §1 Program ids and global PDAs
// ---------------------------------------------------------------------------------------------------------------------
/** pumpswap.md §1: pump_amm program id (IDL "address"; owner of every pool/config account). */
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
/** pumpswap.md §1: pump fee program id (owner of FeeConfig; fixed `fee_program` account in buy/sell). */
export const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
/** pumpswap.md §1: pump bonding-curve program — only used for the `pool-authority` PDA (canonical pool creator). */
export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')

/** pumpswap.md §1: seeds ["global_config"] under pump_amm → ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw. */
export const GLOBAL_CONFIG_PDA = PublicKey.findProgramAddressSync([Buffer.from('global_config')], PUMP_AMM_PROGRAM_ID)[0]
/** pumpswap.md §1: seeds ["fee_config", pump_amm_program_id] under the FEE program → 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx. */
export const FEE_CONFIG_PDA = PublicKey.findProgramAddressSync([Buffer.from('fee_config'), PUMP_AMM_PROGRAM_ID.toBuffer()], PUMP_FEE_PROGRAM_ID)[0]
/** pumpswap.md §1: seeds ["__event_authority"] under pump_amm → GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR. */
export const EVENT_AUTHORITY_PDA = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0]
/** pumpswap.md §1: seeds ["global_volume_accumulator"] under pump_amm → C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw. */
export const GLOBAL_VOLUME_ACCUMULATOR_PDA = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_AMM_PROGRAM_ID)[0]
/** pumpswap.md §1: seeds ["user_volume_accumulator", user] under pump_amm (init_if_needed on buy; 137 bytes live). */
export function userVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_AMM_PROGRAM_ID)[0]
}
/** pumpswap.md §1: seeds ["creator_vault", pool.coin_creator] under pump_amm. */
export function coinCreatorVaultAuthorityPda(coinCreator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), coinCreator.toBuffer()], PUMP_AMM_PROGRAM_ID)[0]
}
/** pumpswap.md §1/§7: seeds ["pool-authority", base_mint] under the PUMP program = `creator` of every canonical pool. */
export function pumpPoolAuthorityPda(baseMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), baseMint.toBuffer()], PUMP_PROGRAM_ID)[0]
}
/** pumpswap.md §1/§6: seeds ["pool-v2", base_mint] under pump_amm — remaining account when coin_creator != default (NULL on mainnet). */
export function poolV2Pda(baseMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('pool-v2'), baseMint.toBuffer()], PUMP_AMM_PROGRAM_ID)[0]
}
/** pumpswap.md §7: pool PDA seeds ["pool", index u16 LE, creator, base_mint, quote_mint] under pump_amm. */
export function poolPda(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  const idx = new Uint8Array(2); idx[0] = index & 0xff; idx[1] = (index >> 8) & 0xff
  return PublicKey.findProgramAddressSync([Buffer.from('pool'), Buffer.from(idx), creator.toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()], PUMP_AMM_PROGRAM_ID)[0]
}

// ---------------------------------------------------------------------------------------------------------------------
// §2 Pool
// ---------------------------------------------------------------------------------------------------------------------
/** pumpswap.md §2: Anchor account discriminator [241,154,109,4,17,177,109,188]. */
export const POOL_DISCRIMINATOR_HEX = 'f19a6d0411b16dbc'
/** pumpswap.md §2 offsets. */
export const POOL_OFF = {
  discriminator: 0, poolBump: 8, index: 9, creator: 11, baseMint: 43, quoteMint: 75, lpMint: 107, poolBaseTokenAccount: 139, poolQuoteTokenAccount: 171,
  lpSupply: 203, coinCreator: 211, isMayhemMode: 243, isCashbackCoin: 244, virtualQuoteReserves: 245, creatorFeeBps: 261, canEditCreatorFee: 269, isHolderReward: 270, end: 271,
} as const
/**
 * pumpswap.md §2: historical lengths (SDK comment "a pool is 211 / 243 / 244 / 245 / 261 bytes", plus 270 = SDK POOL_SIZE without
 * is_holder_reward and 271 = current IDL). Missing trailing fields read as 0/false (S1 README + S2 padTrailing).
 */
export const POOL_KNOWN_LENGTHS: readonly number[] = [211, 243, 244, 245, 261, 270, 271]
/** pumpswap.md §2: `extend_account` grows pools to POOL_ACCOUNT_NEW_SIZE = 300 (or more); such accounts carry the full layout. */
export const POOL_EXTENDED_MIN_LENGTH = 300

export interface PumpPool {
  poolBump: number
  index: number
  creator: PublicKey
  baseMint: PublicKey
  quoteMint: PublicKey
  lpMint: PublicKey
  poolBaseTokenAccount: PublicKey
  poolQuoteTokenAccount: PublicKey
  lpSupply: bigint
  coinCreator: PublicKey
  isMayhemMode: boolean
  isCashbackCoin: boolean
  /** i128, signed. */
  virtualQuoteReserves: bigint
  creatorFeeBps: bigint
  canEditCreatorFee: boolean
  isHolderReward: boolean
  /** raw account length that selected the version */
  layoutLength: number
  /** which trailing fields were physically present vs defaulted */
  defaultedFields: string[]
}

function readI128LE(buf: Uint8Array, off: number): bigint {
  const u = readU128LE(buf, off)
  return u >= (1n << 127n) ? u - (1n << 128n) : u
}
function readBool(buf: Uint8Array, off: number, what: string): boolean | Unsupported {
  const v = readU8(buf, off)
  if (v !== 0 && v !== 1) return unsupported('UNKNOWN_LAYOUT', `${what} byte=${v} is not a Borsh bool`)
  return v === 1
}

export function decodePool(data: Uint8Array): PumpPool | Unsupported {
  if (data.length < 8) return unsupported('UNKNOWN_LAYOUT', `pool account too short: ${data.length} bytes`)
  const disc = hexOf(data.subarray(0, 8))
  if (disc !== POOL_DISCRIMINATOR_HEX) return unsupported('UNKNOWN_LAYOUT', `pool discriminator ${disc} != ${POOL_DISCRIMINATOR_HEX}`)
  const len = data.length
  const known = POOL_KNOWN_LENGTHS.includes(len) || len >= POOL_EXTENDED_MIN_LENGTH
  if (!known) return unsupported('UNKNOWN_LAYOUT', `pool account length ${len} is not one of ${POOL_KNOWN_LENGTHS.join('/')} or >= ${POOL_EXTENDED_MIN_LENGTH}`)
  // fields present up to `len` (extended accounts >= 300 carry the full 271-byte layout)
  const has = (endOff: number) => len >= endOff
  const defaulted: string[] = []
  const coinCreator = has(POOL_OFF.coinCreator + 32) ? readPubkey(data, POOL_OFF.coinCreator) : (defaulted.push('coin_creator'), PublicKey.default)
  let isMayhemMode = false, isCashbackCoin = false, canEditCreatorFee = false, isHolderReward = false
  if (has(POOL_OFF.isMayhemMode + 1)) { const b = readBool(data, POOL_OFF.isMayhemMode, 'is_mayhem_mode'); if (typeof b !== 'boolean') return b; isMayhemMode = b } else defaulted.push('is_mayhem_mode')
  if (has(POOL_OFF.isCashbackCoin + 1)) { const b = readBool(data, POOL_OFF.isCashbackCoin, 'is_cashback_coin'); if (typeof b !== 'boolean') return b; isCashbackCoin = b } else defaulted.push('is_cashback_coin')
  const virtualQuoteReserves = has(POOL_OFF.virtualQuoteReserves + 16) ? readI128LE(data, POOL_OFF.virtualQuoteReserves) : (defaulted.push('virtual_quote_reserves'), 0n)
  const creatorFeeBps = has(POOL_OFF.creatorFeeBps + 8) ? readU64LE(data, POOL_OFF.creatorFeeBps) : (defaulted.push('creator_fee_bps'), 0n)
  if (has(POOL_OFF.canEditCreatorFee + 1)) { const b = readBool(data, POOL_OFF.canEditCreatorFee, 'can_edit_creator_fee'); if (typeof b !== 'boolean') return b; canEditCreatorFee = b } else defaulted.push('can_edit_creator_fee')
  if (has(POOL_OFF.isHolderReward + 1)) { const b = readBool(data, POOL_OFF.isHolderReward, 'is_holder_reward'); if (typeof b !== 'boolean') return b; isHolderReward = b } else defaulted.push('is_holder_reward')
  return {
    poolBump: readU8(data, POOL_OFF.poolBump), index: readU16LE(data, POOL_OFF.index), creator: readPubkey(data, POOL_OFF.creator), baseMint: readPubkey(data, POOL_OFF.baseMint),
    quoteMint: readPubkey(data, POOL_OFF.quoteMint), lpMint: readPubkey(data, POOL_OFF.lpMint), poolBaseTokenAccount: readPubkey(data, POOL_OFF.poolBaseTokenAccount),
    poolQuoteTokenAccount: readPubkey(data, POOL_OFF.poolQuoteTokenAccount), lpSupply: readU64LE(data, POOL_OFF.lpSupply), coinCreator, isMayhemMode, isCashbackCoin,
    virtualQuoteReserves, creatorFeeBps, canEditCreatorFee, isHolderReward, layoutLength: len, defaultedFields: defaulted,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// §3 GlobalConfig
// ---------------------------------------------------------------------------------------------------------------------
/** pumpswap.md §3: discriminator [149,8,156,202,160,252,176,217]. */
export const GLOBAL_CONFIG_DISCRIMINATOR_HEX = '95089ccaa0fcb0d9'
/** pumpswap.md §3 offsets. */
export const GLOBAL_CONFIG_OFF = {
  admin: 8, lpFeeBasisPoints: 40, protocolFeeBasisPoints: 48, disableFlags: 56, protocolFeeRecipients: 57, coinCreatorFeeBasisPoints: 313, adminSetCoinCreatorAuthority: 321,
  whitelistPda: 353, reservedFeeRecipient: 385, mayhemModeEnabled: 417, reservedFeeRecipients: 418, isCashbackEnabled: 642, buybackFeeRecipients: 643, buybackBasisPoints: 899,
  boostAuthority: 907, boostEnabled: 939, creatorFeeConfigurable: 940, maxConfigurableCreatorFeeBps: 941, end: 949,
} as const
/** pumpswap.md §2 SDK excerpt: "a GlobalConfig 907 / 940" are the historical lengths; 949 is the full current layout (live). */
export const GLOBAL_CONFIG_KNOWN_LENGTHS: readonly number[] = [907, 940, 949]
/** pumpswap.md §3: disable_flags bit meanings (IDL field docs). */
export const DISABLE_FLAG = { createPool: 1 << 0, deposit: 1 << 1, withdraw: 1 << 2, buy: 1 << 3, sell: 1 << 4 } as const

export interface PumpGlobalConfig {
  admin: PublicKey
  lpFeeBasisPoints: bigint
  protocolFeeBasisPoints: bigint
  disableFlags: number
  protocolFeeRecipients: PublicKey[]
  coinCreatorFeeBasisPoints: bigint
  adminSetCoinCreatorAuthority: PublicKey
  whitelistPda: PublicKey
  reservedFeeRecipient: PublicKey
  mayhemModeEnabled: boolean
  reservedFeeRecipients: PublicKey[]
  isCashbackEnabled: boolean
  buybackFeeRecipients: PublicKey[]
  buybackBasisPoints: bigint
  boostAuthority: PublicKey
  boostEnabled: boolean
  creatorFeeConfigurable: boolean
  maxConfigurableCreatorFeeBps: bigint
  layoutLength: number
  defaultedFields: string[]
}

function readPubkeyArray(data: Uint8Array, off: number, n: number): PublicKey[] {
  const out: PublicKey[] = []
  for (let i = 0; i < n; i++) out.push(readPubkey(data, off + 32 * i))
  return out
}

export function decodeGlobalConfig(data: Uint8Array): PumpGlobalConfig | Unsupported {
  if (data.length < 8) return unsupported('UNKNOWN_LAYOUT', `global_config too short: ${data.length}`)
  const disc = hexOf(data.subarray(0, 8))
  if (disc !== GLOBAL_CONFIG_DISCRIMINATOR_HEX) return unsupported('UNKNOWN_LAYOUT', `global_config discriminator ${disc} != ${GLOBAL_CONFIG_DISCRIMINATOR_HEX}`)
  const len = data.length
  if (!GLOBAL_CONFIG_KNOWN_LENGTHS.includes(len)) return unsupported('UNKNOWN_LAYOUT', `global_config length ${len} is not one of ${GLOBAL_CONFIG_KNOWN_LENGTHS.join('/')}`)
  const O = GLOBAL_CONFIG_OFF
  const defaulted: string[] = []
  const mayhem = readBool(data, O.mayhemModeEnabled, 'mayhem_mode_enabled'); if (typeof mayhem !== 'boolean') return mayhem
  const cashback = readBool(data, O.isCashbackEnabled, 'is_cashback_enabled'); if (typeof cashback !== 'boolean') return cashback
  let boostAuthority = PublicKey.default, boostEnabled = false, creatorFeeConfigurable = false, maxConfigurableCreatorFeeBps = 0n
  if (len >= O.boostAuthority + 32) boostAuthority = readPubkey(data, O.boostAuthority); else defaulted.push('boost_authority')
  if (len >= O.boostEnabled + 1) { const b = readBool(data, O.boostEnabled, 'boost_enabled'); if (typeof b !== 'boolean') return b; boostEnabled = b } else defaulted.push('boost_enabled')
  if (len >= O.creatorFeeConfigurable + 1) { const b = readBool(data, O.creatorFeeConfigurable, 'creator_fee_configurable'); if (typeof b !== 'boolean') return b; creatorFeeConfigurable = b } else defaulted.push('creator_fee_configurable')
  if (len >= O.maxConfigurableCreatorFeeBps + 8) maxConfigurableCreatorFeeBps = readU64LE(data, O.maxConfigurableCreatorFeeBps); else defaulted.push('max_configurable_creator_fee_bps')
  return {
    admin: readPubkey(data, O.admin), lpFeeBasisPoints: readU64LE(data, O.lpFeeBasisPoints), protocolFeeBasisPoints: readU64LE(data, O.protocolFeeBasisPoints),
    disableFlags: readU8(data, O.disableFlags), protocolFeeRecipients: readPubkeyArray(data, O.protocolFeeRecipients, 8), coinCreatorFeeBasisPoints: readU64LE(data, O.coinCreatorFeeBasisPoints),
    adminSetCoinCreatorAuthority: readPubkey(data, O.adminSetCoinCreatorAuthority), whitelistPda: readPubkey(data, O.whitelistPda), reservedFeeRecipient: readPubkey(data, O.reservedFeeRecipient),
    mayhemModeEnabled: mayhem, reservedFeeRecipients: readPubkeyArray(data, O.reservedFeeRecipients, 7), isCashbackEnabled: cashback, buybackFeeRecipients: readPubkeyArray(data, O.buybackFeeRecipients, 8),
    buybackBasisPoints: readU64LE(data, O.buybackBasisPoints), boostAuthority, boostEnabled, creatorFeeConfigurable, maxConfigurableCreatorFeeBps, layoutLength: len, defaultedFields: defaulted,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// §4 FeeConfig (fee program)
// ---------------------------------------------------------------------------------------------------------------------
/** pumpswap.md §4: discriminator [143,52,146,187,219,123,76,155]. */
export const FEE_CONFIG_DISCRIMINATOR_HEX = '8f3492bbdb7b4c9b'
/** pumpswap.md §4 fixed prefix offsets: bump @8, admin @9, flat_fees @41 (24 bytes), fee_tiers Vec @65. */
export const FEE_CONFIG_OFF = { bump: 8, admin: 9, flatFees: 41, feeTiers: 65 } as const
export const FEES_SIZE = 24
export const FEE_TIER_SIZE = 16 + FEES_SIZE
/** pumpswap.md §4: version-by-length (S2 versionedFeeConfigData): 2512 pre-stable, 4073 post-stable, 4097 post-exotic (live). */
export const FEE_CONFIG_SIZE_PRE_STABLE = 2512
export const FEE_CONFIG_SIZE_POST_STABLE = 4073
export const FEE_CONFIG_SIZE_POST_EXOTIC = 4097
export const FEE_CONFIG_KNOWN_LENGTHS: readonly number[] = [FEE_CONFIG_SIZE_PRE_STABLE, FEE_CONFIG_SIZE_POST_STABLE, FEE_CONFIG_SIZE_POST_EXOTIC]

export interface Fees { lpFeeBps: bigint; protocolFeeBps: bigint; creatorFeeBps: bigint }
export interface FeeTier { marketCapLamportsThreshold: bigint; fees: Fees }
export interface PumpFeeConfig {
  bump: number
  admin: PublicKey
  flatFees: Fees
  feeTiers: FeeTier[]
  /** [] on the 2512-byte version */
  stableFeeTiers: FeeTier[]
  /** all-zero on versions < 4097 bytes */
  exoticFlatFees: Fees
  layoutLength: number
  /** offset where the last decoded field ended (bytes after it are padding the program never reads) */
  decodedEnd: number
}

function readFees(data: Uint8Array, off: number): Fees {
  return { lpFeeBps: readU64LE(data, off), protocolFeeBps: readU64LE(data, off + 8), creatorFeeBps: readU64LE(data, off + 16) }
}
function readFeeTierVec(data: Uint8Array, off: number, what: string): { tiers: FeeTier[]; end: number } | Unsupported {
  if (off + 4 > data.length) return unsupported('UNKNOWN_LAYOUT', `${what} vec length prefix @${off} beyond ${data.length}`)
  const n = readU32LE(data, off)
  const end = off + 4 + n * FEE_TIER_SIZE
  if (end > data.length) return unsupported('UNKNOWN_LAYOUT', `${what} vec of ${n} tiers @${off} runs past ${data.length} bytes`)
  const tiers: FeeTier[] = []
  for (let i = 0; i < n; i++) {
    const o = off + 4 + i * FEE_TIER_SIZE
    tiers.push({ marketCapLamportsThreshold: readU128LE(data, o), fees: readFees(data, o + 16) })
  }
  return { tiers, end }
}

export function decodeFeeConfig(data: Uint8Array): PumpFeeConfig | Unsupported {
  if (data.length < 8) return unsupported('UNKNOWN_LAYOUT', `fee_config too short: ${data.length}`)
  const disc = hexOf(data.subarray(0, 8))
  if (disc !== FEE_CONFIG_DISCRIMINATOR_HEX) return unsupported('UNKNOWN_LAYOUT', `fee_config discriminator ${disc} != ${FEE_CONFIG_DISCRIMINATOR_HEX}`)
  const len = data.length
  if (!FEE_CONFIG_KNOWN_LENGTHS.includes(len)) return unsupported('UNKNOWN_LAYOUT', `fee_config length ${len} is not one of ${FEE_CONFIG_KNOWN_LENGTHS.join('/')}`)
  const ft = readFeeTierVec(data, FEE_CONFIG_OFF.feeTiers, 'fee_tiers'); if ('status' in ft) return ft
  if (ft.tiers.length === 0) return unsupported('UNKNOWN_LAYOUT', 'fee_tiers is empty (program invariant: tiers non-empty)')
  let end = ft.end
  let stableFeeTiers: FeeTier[] = []
  if (len >= FEE_CONFIG_SIZE_POST_STABLE) { const st = readFeeTierVec(data, end, 'stable_fee_tiers'); if ('status' in st) return st; stableFeeTiers = st.tiers; end = st.end }
  let exoticFlatFees: Fees = { lpFeeBps: 0n, protocolFeeBps: 0n, creatorFeeBps: 0n }
  if (len >= FEE_CONFIG_SIZE_POST_EXOTIC) {
    if (end + FEES_SIZE > len) return unsupported('UNKNOWN_LAYOUT', `exotic_flat_fees @${end} runs past ${len}`)
    exoticFlatFees = readFees(data, end); end += FEES_SIZE
  }
  return { bump: readU8(data, FEE_CONFIG_OFF.bump), admin: readPubkey(data, FEE_CONFIG_OFF.admin), flatFees: readFees(data, FEE_CONFIG_OFF.flatFees), feeTiers: ft.tiers, stableFeeTiers, exoticFlatFees, layoutLength: len, decodedEnd: end }
}

// ---------------------------------------------------------------------------------------------------------------------
// §6 instruction discriminators
// ---------------------------------------------------------------------------------------------------------------------
/** pumpswap.md §6: `buy` = 66063d1201daebea, `buy_exact_quote_in` = c62e1552b4d9e870, `sell` = 33e685a4017f83ad. */
export const IX_DISC = { buy: 'c62e1552b4d9e870'.length === 16 ? '66063d1201daebea' : '', buyExactQuoteIn: 'c62e1552b4d9e870', sell: '33e685a4017f83ad' } as const
