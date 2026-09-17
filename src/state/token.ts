import { PublicKey } from '@solana/web3.js'
import { readU8, readU16LE, readU32LE, readU64LE, readPubkey } from '../util/bytes.js'
import type { MintInfo, TokenAccountInfo, TokenProgramKind, RawAccount } from '../adapters/types.js'

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111')
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')

export const MINT_SIZE = 82
export const ACCOUNT_SIZE = 165
/** Token-2022 ExtensionType ids (verified against docs/sources/token2022.md). */
export const EXT = {
  Uninitialized: 0, TransferFeeConfig: 1, TransferFeeAmount: 2, MintCloseAuthority: 3, ConfidentialTransferMint: 4, ConfidentialTransferAccount: 5,
  DefaultAccountState: 6, ImmutableOwner: 7, MemoTransfer: 8, NonTransferable: 9, InterestBearingConfig: 10, CpiGuard: 11, PermanentDelegate: 12,
  NonTransferableAccount: 13, TransferHook: 14, TransferHookAccount: 15, ConfidentialTransferFeeConfig: 16, ConfidentialTransferFeeAmount: 17,
  MetadataPointer: 18, TokenMetadata: 19, GroupPointer: 20, TokenGroup: 21, GroupMemberPointer: 22, TokenGroupMember: 23, ConfidentialMintBurn: 24,
  ScaledUiAmount: 25, Pausable: 26, PausableAccount: 27,
} as const

export function tokenProgramKind(owner: PublicKey): TokenProgramKind | null {
  if (owner.equals(TOKEN_PROGRAM_ID)) return 'spl_token'
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) return 'token_2022'
  return null
}
export interface TlvEntry { type: number; data: Uint8Array }
/** Parses Token-2022 TLV entries following the base layout. `baseLen` is 82 (mint) or 165 (account); byte at offset 165 is the AccountType (1=mint,2=account). */
export function parseTlv(data: Uint8Array, baseLen: number): TlvEntry[] {
  const out: TlvEntry[] = []
  if (data.length <= ACCOUNT_SIZE) return out
  let off = ACCOUNT_SIZE + 1 // after the account-type byte (mints are padded to 165 then type byte)
  void baseLen
  while (off + 4 <= data.length) {
    const type = readU16LE(data, off); const len = readU16LE(data, off + 2); off += 4
    if (type === 0) break
    if (off + len > data.length) throw new RangeError(`TLV entry type=${type} len=${len} overruns account of ${data.length} bytes`)
    out.push({ type, data: data.subarray(off, off + len) }); off += len
  }
  return out
}
function readCOptionPubkey(data: Uint8Array, off: number): PublicKey | null {
  const tag = readU32LE(data, off)
  return tag === 1 ? readPubkey(data, off + 4) : null
}
export function parseMint(acc: RawAccount): MintInfo {
  const kind = tokenProgramKind(acc.owner)
  if (!kind) throw new Error(`MINT_OWNER_UNKNOWN ${acc.pubkey.toBase58()} owner=${acc.owner.toBase58()}`)
  const d = acc.data
  if (d.length < MINT_SIZE) throw new Error(`MINT_TOO_SHORT ${acc.pubkey.toBase58()} len=${d.length}`)
  if (kind === 'spl_token' && d.length !== MINT_SIZE) throw new Error(`MINT_UNEXPECTED_LEN spl_token ${d.length}`)
  if (readU8(d, 45) !== 1) throw new Error(`MINT_NOT_INITIALIZED ${acc.pubkey.toBase58()}`)
  const info: MintInfo = { mint: acc.pubkey, program: kind, decimals: readU8(d, 44), supply: readU64LE(d, 36), mintAuthority: readCOptionPubkey(d, 0), freezeAuthority: readCOptionPubkey(d, 46), extensions: [] }
  if (kind === 'token_2022' && d.length > MINT_SIZE) {
    if (d.length < ACCOUNT_SIZE + 1) throw new Error(`MINT_T22_BAD_LEN ${d.length}`)
    if (readU8(d, ACCOUNT_SIZE) !== 1) throw new Error(`MINT_T22_ACCOUNT_TYPE ${readU8(d, ACCOUNT_SIZE)} != 1`)
    const tlv = parseTlv(d, MINT_SIZE)
    info.extensions = tlv.map(t => t.type)
    const tf = tlv.find(t => t.type === EXT.TransferFeeConfig)
    if (tf) {
      // TransferFeeConfig: authority(32) withdraw_authority(32) withheld_amount(8) older{epoch u64, max_fee u64, bps u16} newer{epoch u64, max_fee u64, bps u16}
      const older = { epoch: readU64LE(tf.data, 72), maxFee: readU64LE(tf.data, 80), bps: readU16LE(tf.data, 88) }
      const newer = { epoch: readU64LE(tf.data, 90), maxFee: readU64LE(tf.data, 98), bps: readU16LE(tf.data, 106) }
      if (newer.bps > 10_000 || older.bps > 10_000) throw new Error(`MINT_TRANSFER_FEE_BPS_INVALID ${acc.pubkey.toBase58()} older=${older.bps} newer=${newer.bps} (> 10000)`)
      info.transferFee = { bps: newer.bps, maxFee: newer.maxFee, epoch: newer.epoch }
      info.transferFeeOlder = { bps: older.bps, maxFee: older.maxFee, epoch: older.epoch }
    }
  }
  return info
}
export function parseTokenAccount(acc: RawAccount): TokenAccountInfo {
  const kind = tokenProgramKind(acc.owner)
  if (!kind) throw new Error(`TOKEN_ACCOUNT_OWNER_UNKNOWN ${acc.pubkey.toBase58()}`)
  const d = acc.data
  if (d.length < ACCOUNT_SIZE) throw new Error(`TOKEN_ACCOUNT_TOO_SHORT ${d.length}`)
  if (kind === 'spl_token' && d.length !== ACCOUNT_SIZE) throw new Error(`TOKEN_ACCOUNT_UNEXPECTED_LEN spl_token ${d.length}`)
  const state = readU8(d, 108)
  if (state === 0) throw new Error(`TOKEN_ACCOUNT_UNINITIALIZED ${acc.pubkey.toBase58()}`)
  const info: TokenAccountInfo = { address: acc.pubkey, program: kind, mint: readPubkey(d, 0), owner: readPubkey(d, 32), amount: readU64LE(d, 64), state, extensions: [] }
  if (kind === 'token_2022' && d.length > ACCOUNT_SIZE) {
    if (readU8(d, ACCOUNT_SIZE) !== 2) throw new Error(`TOKEN_ACCOUNT_T22_ACCOUNT_TYPE ${readU8(d, ACCOUNT_SIZE)} != 2`)
    info.extensions = parseTlv(d, ACCOUNT_SIZE).map(t => t.type)
  }
  return info
}
/** Transfer fee as computed by Token-2022: ceil(amount * bps / 10000) capped at maxFee; zero when bps==0. */
export function transferFeeOn(amount: bigint, fee: { bps: number; maxFee: bigint } | undefined): bigint {
  if (!fee || fee.bps === 0 || amount === 0n) return 0n
  const raw = (amount * BigInt(fee.bps) + 9_999n) / 10_000n
  return raw > fee.maxFee ? fee.maxFee : raw
}
/** Inverse: the gross amount that yields `net` after the transfer fee (ceil), mirroring calculate_inverse_epoch_fee. */
export function transferFeeInverse(net: bigint, fee: { bps: number; maxFee: bigint } | undefined): bigint {
  if (!fee || fee.bps === 0 || net === 0n) return 0n
  const bps = BigInt(fee.bps)
  if (bps === 10_000n) return fee.maxFee
  const gross = (net * 10_000n + (10_000n - bps) - 1n) / (10_000n - bps)
  const f = gross - net
  return f > fee.maxFee ? fee.maxFee : f
}
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0]
}
