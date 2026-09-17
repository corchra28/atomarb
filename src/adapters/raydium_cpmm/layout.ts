/**
 * Raydium CPMM ("raydium-cp-swap") account layouts — byte offsets, discriminators, seeds.
 * Every constant here is taken from docs/sources/raydium_cpmm.md (primary: raydium-cp-swap@59fb845, cross-checked
 * against live mainnet accounts). Section references are given inline. Nothing is guessed.
 */
import { PublicKey } from '@solana/web3.js'
import { readU8, readU16LE, readU64LE, readPubkey, hexOf, writeU16LE } from '../../util/bytes.js'
import { unsupported, type Unsupported } from '../types.js'

/** §1: mainnet program id (`declare_id!` without the devnet feature). */
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')

/** §1 / §6: PDA seeds (lib.rs AUTH_SEED; states/pool.rs, oracle.rs, config.rs). */
export const AUTH_SEED = 'vault_and_lp_mint_auth_seed'
export const POOL_SEED = 'pool'
export const POOL_VAULT_SEED = 'pool_vault'
export const POOL_LP_MINT_SEED = 'pool_lp_mint'
export const OBSERVATION_SEED = 'observation'
export const AMM_CONFIG_SEED = 'amm_config'

/** §2: `PoolState::LEN = 637`, discriminator sha256("account:PoolState")[..8]. */
export const POOL_STATE_LEN = 637
export const POOL_STATE_DISCRIMINATOR_HEX = 'f7ede3f5d7c3de46'
/** §3: `AmmConfig::LEN = 236`, discriminator sha256("account:AmmConfig")[..8]. */
export const AMM_CONFIG_LEN = 236
export const AMM_CONFIG_DISCRIMINATOR_HEX = 'daf42168cbcb2b6f'
/** §6 (ObservationState paragraph): LEN 4075, discriminator sha256("account:ObservationState")[..8]. */
export const OBSERVATION_STATE_LEN = 4075
export const OBSERVATION_STATE_DISCRIMINATOR_HEX = '7aaec5358109a584'

/** §3 / §5.2: `FEE_RATE_DENOMINATOR_VALUE: u64 = 1_000_000`. */
export const FEE_RATE_DENOMINATOR = 1_000_000n

/** §2 table: PoolState offsets (repr(C, packed), little-endian). */
export const POOL_OFF = {
  DISCRIMINATOR: 0,
  AMM_CONFIG: 8,
  POOL_CREATOR: 40,
  TOKEN_0_VAULT: 72,
  TOKEN_1_VAULT: 104,
  LP_MINT: 136,
  TOKEN_0_MINT: 168,
  TOKEN_1_MINT: 200,
  TOKEN_0_PROGRAM: 232,
  TOKEN_1_PROGRAM: 264,
  OBSERVATION_KEY: 296,
  AUTH_BUMP: 328,
  STATUS: 329,
  LP_MINT_DECIMALS: 330,
  MINT_0_DECIMALS: 331,
  MINT_1_DECIMALS: 332,
  LP_SUPPLY: 333,
  PROTOCOL_FEES_TOKEN_0: 341,
  PROTOCOL_FEES_TOKEN_1: 349,
  FUND_FEES_TOKEN_0: 357,
  FUND_FEES_TOKEN_1: 365,
  OPEN_TIME: 373,
  RECENT_EPOCH: 381,
  CREATOR_FEE_ON: 389,
  ENABLE_CREATOR_FEE: 390,
  PADDING1: 391,
  CREATOR_FEES_TOKEN_0: 397,
  CREATOR_FEES_TOKEN_1: 405,
  PADDING: 413,
  END: 637,
} as const

/** §3 table: AmmConfig offsets (Borsh, `#[account]`). */
export const CONFIG_OFF = {
  DISCRIMINATOR: 0,
  BUMP: 8,
  DISABLE_CREATE_POOL: 9,
  INDEX: 10,
  TRADE_FEE_RATE: 12,
  PROTOCOL_FEE_RATE: 20,
  FUND_FEE_RATE: 28,
  CREATE_POOL_FEE: 36,
  PROTOCOL_OWNER: 44,
  FUND_OWNER: 76,
  CREATOR_FEE_RATE: 108,
  PADDING: 116,
  END: 236,
} as const

/** §6: ObservationState offsets (only the header is needed: we never read observations for quoting). */
export const OBSERVATION_OFF = { DISCRIMINATOR: 0, INITIALIZED: 8, OBSERVATION_INDEX: 9, POOL_ID: 11, OBSERVATIONS: 43, LAST_UPDATE_TIMESTAMP: 4043, PADDING: 4051, END: 4075 } as const

/** §4: status bit values (bit0 deposit=1, bit1 withdraw=2, bit2 swap=4; a set bit means DISABLED). */
export const STATUS_BIT = { DEPOSIT_DISABLED: 1, WITHDRAW_DISABLED: 2, SWAP_DISABLED: 4 } as const

/** §2 / §5.3 step 4: creator_fee_on enum (0 BothToken, 1 OnlyToken0, 2 OnlyToken1; anything else → InvalidFeeModel). */
export const CREATOR_FEE_ON = { BOTH_TOKEN: 0, ONLY_TOKEN_0: 1, ONLY_TOKEN_1: 2 } as const

export interface PoolState {
  ammConfig: PublicKey
  poolCreator: PublicKey
  token0Vault: PublicKey
  token1Vault: PublicKey
  lpMint: PublicKey
  token0Mint: PublicKey
  token1Mint: PublicKey
  token0Program: PublicKey
  token1Program: PublicKey
  observationKey: PublicKey
  authBump: number
  status: number
  lpMintDecimals: number
  mint0Decimals: number
  mint1Decimals: number
  lpSupply: bigint
  protocolFeesToken0: bigint
  protocolFeesToken1: bigint
  fundFeesToken0: bigint
  fundFeesToken1: bigint
  openTime: bigint
  recentEpoch: bigint
  creatorFeeOn: number
  enableCreatorFee: boolean
  creatorFeesToken0: bigint
  creatorFeesToken1: bigint
  /** raw padding bytes 391..397 and 413..637 — must be zero on the documented layout (informational; not enforced). */
  paddingNonZero: boolean
}

export interface AmmConfig {
  bump: number
  disableCreatePool: boolean
  index: number
  tradeFeeRate: bigint
  protocolFeeRate: bigint
  fundFeeRate: bigint
  createPoolFee: bigint
  protocolOwner: PublicKey
  fundOwner: PublicKey
  creatorFeeRate: bigint
  /** bytes 116..124 — SDK 0.2.70 calls this creatorFeeShareRate (unmerged branch, §10); on mainnet it is padding and reads 0. */
  padding0: bigint
}

export interface ObservationHeader { initialized: boolean; observationIndex: number; poolId: PublicKey; lastUpdateTimestamp: bigint }

/** §2: decodes a PoolState account. Length-based versioning is NOT documented for this program, so the full documented length is required. */
export function decodePoolState(data: Uint8Array): PoolState | Unsupported {
  if (data.length !== POOL_STATE_LEN) return unsupported('UNKNOWN_LAYOUT', `PoolState length ${data.length} != ${POOL_STATE_LEN} (raydium_cpmm.md §2)`)
  const disc = hexOf(data.subarray(0, 8))
  if (disc !== POOL_STATE_DISCRIMINATOR_HEX) return unsupported('UNKNOWN_LAYOUT', `PoolState discriminator ${disc} != ${POOL_STATE_DISCRIMINATOR_HEX}`)
  let paddingNonZero = false
  for (let i = POOL_OFF.PADDING1; i < POOL_OFF.CREATOR_FEES_TOKEN_0; i++) if (data[i] !== 0) paddingNonZero = true
  for (let i = POOL_OFF.PADDING; i < POOL_OFF.END; i++) if (data[i] !== 0) paddingNonZero = true
  return {
    ammConfig: readPubkey(data, POOL_OFF.AMM_CONFIG),
    poolCreator: readPubkey(data, POOL_OFF.POOL_CREATOR),
    token0Vault: readPubkey(data, POOL_OFF.TOKEN_0_VAULT),
    token1Vault: readPubkey(data, POOL_OFF.TOKEN_1_VAULT),
    lpMint: readPubkey(data, POOL_OFF.LP_MINT),
    token0Mint: readPubkey(data, POOL_OFF.TOKEN_0_MINT),
    token1Mint: readPubkey(data, POOL_OFF.TOKEN_1_MINT),
    token0Program: readPubkey(data, POOL_OFF.TOKEN_0_PROGRAM),
    token1Program: readPubkey(data, POOL_OFF.TOKEN_1_PROGRAM),
    observationKey: readPubkey(data, POOL_OFF.OBSERVATION_KEY),
    authBump: readU8(data, POOL_OFF.AUTH_BUMP),
    status: readU8(data, POOL_OFF.STATUS),
    lpMintDecimals: readU8(data, POOL_OFF.LP_MINT_DECIMALS),
    mint0Decimals: readU8(data, POOL_OFF.MINT_0_DECIMALS),
    mint1Decimals: readU8(data, POOL_OFF.MINT_1_DECIMALS),
    lpSupply: readU64LE(data, POOL_OFF.LP_SUPPLY),
    protocolFeesToken0: readU64LE(data, POOL_OFF.PROTOCOL_FEES_TOKEN_0),
    protocolFeesToken1: readU64LE(data, POOL_OFF.PROTOCOL_FEES_TOKEN_1),
    fundFeesToken0: readU64LE(data, POOL_OFF.FUND_FEES_TOKEN_0),
    fundFeesToken1: readU64LE(data, POOL_OFF.FUND_FEES_TOKEN_1),
    openTime: readU64LE(data, POOL_OFF.OPEN_TIME),
    recentEpoch: readU64LE(data, POOL_OFF.RECENT_EPOCH),
    creatorFeeOn: readU8(data, POOL_OFF.CREATOR_FEE_ON),
    enableCreatorFee: readU8(data, POOL_OFF.ENABLE_CREATOR_FEE) !== 0,
    creatorFeesToken0: readU64LE(data, POOL_OFF.CREATOR_FEES_TOKEN_0),
    creatorFeesToken1: readU64LE(data, POOL_OFF.CREATOR_FEES_TOKEN_1),
    paddingNonZero,
  }
}

/** §3: decodes an AmmConfig account (exact documented length required). */
export function decodeAmmConfig(data: Uint8Array): AmmConfig | Unsupported {
  if (data.length !== AMM_CONFIG_LEN) return unsupported('UNKNOWN_LAYOUT', `AmmConfig length ${data.length} != ${AMM_CONFIG_LEN} (raydium_cpmm.md §3)`)
  const disc = hexOf(data.subarray(0, 8))
  if (disc !== AMM_CONFIG_DISCRIMINATOR_HEX) return unsupported('UNKNOWN_LAYOUT', `AmmConfig discriminator ${disc} != ${AMM_CONFIG_DISCRIMINATOR_HEX}`)
  return {
    bump: readU8(data, CONFIG_OFF.BUMP),
    disableCreatePool: readU8(data, CONFIG_OFF.DISABLE_CREATE_POOL) !== 0,
    index: readU16LE(data, CONFIG_OFF.INDEX),
    tradeFeeRate: readU64LE(data, CONFIG_OFF.TRADE_FEE_RATE),
    protocolFeeRate: readU64LE(data, CONFIG_OFF.PROTOCOL_FEE_RATE),
    fundFeeRate: readU64LE(data, CONFIG_OFF.FUND_FEE_RATE),
    createPoolFee: readU64LE(data, CONFIG_OFF.CREATE_POOL_FEE),
    protocolOwner: readPubkey(data, CONFIG_OFF.PROTOCOL_OWNER),
    fundOwner: readPubkey(data, CONFIG_OFF.FUND_OWNER),
    creatorFeeRate: readU64LE(data, CONFIG_OFF.CREATOR_FEE_RATE),
    padding0: readU64LE(data, CONFIG_OFF.PADDING),
  }
}

/** §6: ObservationState header check (used only to sanity-check the fixture / the account passed to the ix; never for quoting). */
export function decodeObservationHeader(data: Uint8Array): ObservationHeader | Unsupported {
  if (data.length !== OBSERVATION_STATE_LEN) return unsupported('UNKNOWN_LAYOUT', `ObservationState length ${data.length} != ${OBSERVATION_STATE_LEN}`)
  const disc = hexOf(data.subarray(0, 8))
  if (disc !== OBSERVATION_STATE_DISCRIMINATOR_HEX) return unsupported('UNKNOWN_LAYOUT', `ObservationState discriminator ${disc} != ${OBSERVATION_STATE_DISCRIMINATOR_HEX}`)
  return { initialized: readU8(data, OBSERVATION_OFF.INITIALIZED) !== 0, observationIndex: readU16LE(data, OBSERVATION_OFF.OBSERVATION_INDEX), poolId: readPubkey(data, OBSERVATION_OFF.POOL_ID), lastUpdateTimestamp: readU64LE(data, OBSERVATION_OFF.LAST_UPDATE_TIMESTAMP) }
}

/** §1: authority PDA `[b"vault_and_lp_mint_auth_seed"]` — mainnet GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL, bump 253. */
export function authorityPda(programId: PublicKey = RAYDIUM_CPMM_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(AUTH_SEED)], programId)
}
/** §2 / §6: `[b"pool_vault", pool, mint]`. */
export function poolVaultPda(pool: PublicKey, mint: PublicKey, programId: PublicKey = RAYDIUM_CPMM_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(POOL_VAULT_SEED), pool.toBuffer(), mint.toBuffer()], programId)
}
/** §6: `[b"observation", pool]`. */
export function observationPda(pool: PublicKey, programId: PublicKey = RAYDIUM_CPMM_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(OBSERVATION_SEED), pool.toBuffer()], programId)
}
/** §6: `[b"pool_lp_mint", pool]`. */
export function lpMintPda(pool: PublicKey, programId: PublicKey = RAYDIUM_CPMM_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(POOL_LP_MINT_SEED), pool.toBuffer()], programId)
}
/** §2: `[b"pool", amm_config, mint0, mint1]` — informational only: `initialize` also accepts a non-PDA pool account signed by the creator. */
export function poolPda(ammConfig: PublicKey, mint0: PublicKey, mint1: PublicKey, programId: PublicKey = RAYDIUM_CPMM_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(POOL_SEED), ammConfig.toBuffer(), mint0.toBuffer(), mint1.toBuffer()], programId)
}
/** §3: `[b"amm_config", index u16 BIG-endian]`. */
export function ammConfigPda(index: number, programId: PublicKey = RAYDIUM_CPMM_PROGRAM_ID): [PublicKey, number] {
  const le = writeU16LE(index); const be = new Uint8Array([le[1]!, le[0]!])
  return PublicKey.findProgramAddressSync([Buffer.from(AMM_CONFIG_SEED), be], programId)
}
/** §4: swap allowed iff bit2 clear. */
export function isSwapEnabled(status: number): boolean { return (status & STATUS_BIT.SWAP_DISABLED) === 0 }
