/**
 * Builder for the arb_executor `ExecuteCircuit` instruction (programs/arb_executor, ABI: docs/EXECUTOR_ABI.md).
 * Encodes the 37-byte data layout exactly and lays out the accounts as [7 fixed][leg A segment][leg B segment], where a
 * segment is [leg program id, ...the CPI accounts in the target program's order]. Never signs, never sends.
 */
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js'
import { concatBytes, writeU64LE } from '../util/bytes.js'
import { sha256Hex } from '../util/hash.js'

export const EXECUTE_CIRCUIT_TAG = 0
export const EXECUTE_CIRCUIT_DATA_LEN = 37
export const FIXED_ACCOUNT_COUNT = 7

export const LEG_KIND = { RAYDIUM_CPMM_SWAP_BASE_INPUT: 0, PUMPSWAP_BUY_EXACT_QUOTE_IN: 1, PUMPSWAP_SELL: 2 } as const
export type LegKind = (typeof LEG_KIND)[keyof typeof LEG_KIND]

/** Program ids the executor allowlists per kind (docs/sources/raydium_cpmm.md §1, pumpswap.md §1). */
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
export const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
export const PUMP_GLOBAL_CONFIG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw')
export const RAYDIUM_CPMM_AUTHORITY = new PublicKey('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL')

/** LOCAL-ONLY address under which tests load the executor ELF into LiteSVM (sha256 of a fixed label; off-curve, never deployed). */
export const ARB_EXECUTOR_LOCAL_PROGRAM_ID = new PublicKey(Buffer.from(sha256Hex('atomarb:arb_executor:local'), 'hex'))
export const ARB_EXECUTOR_SO_PATH = 'tests/fixtures/programs/arb_executor.so'

/** CPI account counts per kind, EXCLUDING the leg program id (raydium_cpmm.md §6: 13 fixed; pumpswap.md §6: 23/21 named + 0..3 remaining). */
export const CPI_ACCOUNT_COUNT: Record<LegKind, { min: number; max: number }> = { 0: { min: 13, max: 13 }, 1: { min: 23, max: 26 }, 2: { min: 21, max: 24 } }
export function expectedLegProgram(kind: LegKind): PublicKey { return kind === LEG_KIND.RAYDIUM_CPMM_SWAP_BASE_INPUT ? RAYDIUM_CPMM_PROGRAM_ID : PUMP_AMM_PROGRAM_ID }

export interface ExecutorLeg {
  kind: LegKind
  /** the leg's target program id (becomes segment[0]) */
  programId: PublicKey
  /** the CPI accounts in EXACTLY the target program's order (adapter output), excluding the program id */
  accounts: AccountMeta[]
}
export interface ExecutorUserAccounts {
  user: PublicKey
  userBaseTokenAccount: PublicKey
  userIntermediateTokenAccount: PublicKey
  baseMint: PublicKey
  intermediateMint: PublicKey
  baseTokenProgram: PublicKey
  intermediateTokenProgram: PublicKey
}
export interface ExecuteCircuitParams { amountIn: bigint; minProfit: bigint; legAMinOut: bigint; legBMinOut: bigint }

function u8(v: number, what: string): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError(`${what}=${v} not a u8`)
  return new Uint8Array([v])
}
/** [0]=tag | [1..9] amount_in | [9..17] min_profit | [17..25] leg_a_min_out | [25..33] leg_b_min_out | [33] a_kind | [34] a_count | [35] b_kind | [36] b_count */
export function encodeExecuteCircuitData(p: ExecuteCircuitParams, legAKind: number, legAAccountCount: number, legBKind: number, legBAccountCount: number): Uint8Array {
  const d = concatBytes(u8(EXECUTE_CIRCUIT_TAG, 'tag'), writeU64LE(p.amountIn), writeU64LE(p.minProfit), writeU64LE(p.legAMinOut), writeU64LE(p.legBMinOut),
    u8(legAKind, 'leg_a_kind'), u8(legAAccountCount, 'leg_a_account_count'), u8(legBKind, 'leg_b_kind'), u8(legBAccountCount, 'leg_b_account_count'))
  if (d.length !== EXECUTE_CIRCUIT_DATA_LEN) throw new Error(`internal: encoded ${d.length} bytes`)
  return d
}
export function decodeExecuteCircuitData(d: Uint8Array): ExecuteCircuitParams & { legAKind: number; legAAccountCount: number; legBKind: number; legBAccountCount: number } {
  if (d.length !== EXECUTE_CIRCUIT_DATA_LEN || d[0] !== EXECUTE_CIRCUIT_TAG) throw new Error(`not an ExecuteCircuit payload (len=${d.length}, tag=${d[0]})`)
  const u64 = (o: number) => Buffer.from(d.subarray(o, o + 8)).readBigUInt64LE(0)
  return { amountIn: u64(1), minProfit: u64(9), legAMinOut: u64(17), legBMinOut: u64(25), legAKind: d[33]!, legAAccountCount: d[34]!, legBKind: d[35]!, legBAccountCount: d[36]! }
}

/** Wraps an adapter-built swap instruction as a leg (keys/order/flags are taken verbatim). Throws on program/count mismatch unless `skipChecks`. */
export function legFromInstruction(kind: LegKind, ix: TransactionInstruction, skipChecks = false): ExecutorLeg {
  const leg: ExecutorLeg = { kind, programId: ix.programId, accounts: ix.keys.map(k => ({ pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable })) }
  if (!skipChecks) checkLeg(leg, 'leg')
  return leg
}
export function checkLeg(leg: ExecutorLeg, label: string): void {
  if (!(leg.kind in CPI_ACCOUNT_COUNT)) throw new Error(`${label}: unknown kind ${leg.kind}`)
  const exp = expectedLegProgram(leg.kind)
  if (!leg.programId.equals(exp)) throw new Error(`${label}: program ${leg.programId.toBase58()} is not the allowlisted ${exp.toBase58()} for kind ${leg.kind}`)
  const { min, max } = CPI_ACCOUNT_COUNT[leg.kind]
  if (leg.accounts.length < min || leg.accounts.length > max) throw new Error(`${label}: ${leg.accounts.length} CPI accounts, expected ${min}..${max} for kind ${leg.kind}`)
}

export interface BuildExecuteCircuitOpts {
  /** executor program id (LiteSVM: ARB_EXECUTOR_LOCAL_PROGRAM_ID) */
  programId?: PublicKey
  user: ExecutorUserAccounts
  params: ExecuteCircuitParams
  legA: ExecutorLeg
  legB: ExecutorLeg
  /** tests only: build intentionally invalid instructions (wrong counts / programs / kinds) to exercise on-chain rejections */
  skipChecks?: boolean
  /** tests only: override the count bytes written into the data (default = 1 + accounts.length per leg) */
  countOverride?: { legA?: number; legB?: number }
  /** tests only: override the raw data entirely (e.g. wrong length) */
  dataOverride?: Uint8Array
}
/**
 * Builds the ExecuteCircuit instruction. Accounts: [0] user (signer, writable) | [1] user base token account (w) | [2] user intermediate token account (w)
 * | [3] base mint | [4] intermediate mint | [5] base token program | [6] intermediate token program | leg A segment | leg B segment.
 * The count bytes in the data include the leg program id (count = 1 + CPI accounts).
 */
export function buildExecuteCircuitIx(o: BuildExecuteCircuitOpts): TransactionInstruction {
  if (!o.skipChecks) {
    checkLeg(o.legA, 'legA'); checkLeg(o.legB, 'legB')
    if (o.legA.kind === LEG_KIND.PUMPSWAP_SELL) throw new Error('legA: PUMPSWAP_SELL is only valid as leg B')
    if (o.legB.kind === LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN) throw new Error('legB: PUMPSWAP_BUY_EXACT_QUOTE_IN is only valid as leg A')
  }
  const u = o.user
  const fixed: AccountMeta[] = [
    { pubkey: u.user, isSigner: true, isWritable: true },
    { pubkey: u.userBaseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: u.userIntermediateTokenAccount, isSigner: false, isWritable: true },
    { pubkey: u.baseMint, isSigner: false, isWritable: false },
    { pubkey: u.intermediateMint, isSigner: false, isWritable: false },
    { pubkey: u.baseTokenProgram, isSigner: false, isWritable: false },
    { pubkey: u.intermediateTokenProgram, isSigner: false, isWritable: false },
  ]
  const seg = (l: ExecutorLeg): AccountMeta[] => [{ pubkey: l.programId, isSigner: false, isWritable: false }, ...l.accounts]
  const aCount = o.countOverride?.legA ?? 1 + o.legA.accounts.length
  const bCount = o.countOverride?.legB ?? 1 + o.legB.accounts.length
  const data = o.dataOverride ?? encodeExecuteCircuitData(o.params, o.legA.kind, aCount, o.legB.kind, bCount)
  return new TransactionInstruction({ programId: o.programId ?? ARB_EXECUTOR_LOCAL_PROGRAM_ID, keys: [...fixed, ...seg(o.legA), ...seg(o.legB)], data: Buffer.from(data) })
}

/** Error code table — MUST match programs/arb_executor/src/error.rs and docs/EXECUTOR_ABI.md. */
export const EXECUTOR_ERRORS = [
  { code: 1, name: 'InvalidDataLength', description: 'instruction data length != 37 for tag 0 (or empty data)' },
  { code: 2, name: 'InvalidTag', description: 'data[0] is not a known instruction tag' },
  { code: 3, name: 'UserNotSigner', description: 'accounts[0] (user) did not sign' },
  { code: 4, name: 'NotEnoughAccounts', description: 'fewer than 7 fixed accounts supplied' },
  { code: 5, name: 'AccountCountMismatch', description: 'accounts.len() != 7 + leg_a_account_count + leg_b_account_count' },
  { code: 6, name: 'TokenProgramNotAllowed', description: 'accounts[5]/[6] is neither SPL Token nor Token-2022' },
  { code: 7, name: 'TokenAccountProgramMismatch', description: 'owner program of accounts[1]/[2] != accounts[5]/[6]' },
  { code: 8, name: 'TokenAccountDataInvalid', description: 'accounts[1]/[2] shorter than 165 bytes (or not borrowable)' },
  { code: 9, name: 'TokenAccountNotInitialized', description: 'token account state byte (offset 108) != 1' },
  { code: 10, name: 'TokenAccountOwnerMismatch', description: 'token account owner field != user' },
  { code: 11, name: 'TokenAccountMintMismatch', description: 'token account mint field != accounts[3]/[4]' },
  { code: 12, name: 'MintProgramMismatch', description: 'owner program of mint accounts[3]/[4] != accounts[5]/[6]' },
  { code: 13, name: 'SameMint', description: 'base_mint == intermediate_mint' },
  { code: 14, name: 'Aliasing', description: 'a user token account appears at a leg position other than its expected user-account position, or accounts[1] == accounts[2]' },
  { code: 15, name: 'LegKindUnknown', description: 'leg kind byte is not 0, 1 or 2' },
  { code: 16, name: 'LegKindInvalidForPosition', description: 'kind 1 only in leg A, kind 2 only in leg B' },
  { code: 17, name: 'LegProgramNotAllowlisted', description: 'leg program id is not the mainnet program for that kind' },
  { code: 18, name: 'LegAccountCountInvalid', description: 'leg account count outside the range expected for the kind' },
  { code: 19, name: 'PoolOwnerMismatch', description: 'pool account owner != leg program' },
  { code: 20, name: 'PoolDataInvalid', description: 'pool data too short or discriminator mismatch' },
  { code: 21, name: 'LegUserMismatch', description: "the CPI's user/payer position != accounts[0]" },
  { code: 22, name: 'LegUserTokenAccountMismatch', description: "the CPI's user token account positions != accounts[1]/[2] in the required roles" },
  { code: 23, name: 'LegVaultMismatch', description: 'vault position(s) != vault fields read from the pool' },
  { code: 24, name: 'LegMintMismatch', description: 'mint position(s) != pool mint fields / accounts[3],[4]' },
  { code: 25, name: 'LegTokenProgramMismatch', description: "token program position(s) != pool's token program fields / accounts[5],[6]" },
  { code: 26, name: 'LegFixedAccountMismatch', description: 'amm_config/authority/observation (Raydium) or system/ATA/event_authority/program/fee_config (PumpSwap) mismatch' },
  { code: 27, name: 'GlobalConfigMismatch', description: 'PumpSwap global_config != PDA["global_config"]' },
  { code: 28, name: 'FeeProgramMismatch', description: 'PumpSwap fee_program != pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ' },
  { code: 29, name: 'InsufficientBaseBalance', description: 'amount_in > balance of accounts[1] before leg A' },
  { code: 30, name: 'LegANoOutput', description: 'intermediate balance did not increase after leg A' },
  { code: 31, name: 'LeftoverIntermediate', description: 'intermediate balance after leg B != before leg A' },
  { code: 32, name: 'ProfitBelowMin', description: 'base balance after leg B < before + min_profit' },
  { code: 33, name: 'ArithmeticOverflow', description: 'checked arithmetic overflowed (base0 + min_profit)' },
] as const
export type ExecutorErrorName = (typeof EXECUTOR_ERRORS)[number]['name']
export const EXECUTOR_ERROR_BY_CODE: ReadonlyMap<number, (typeof EXECUTOR_ERRORS)[number]> = new Map(EXECUTOR_ERRORS.map(e => [e.code, e]))
export const EXECUTOR_ERROR_CODE: Readonly<Record<ExecutorErrorName, number>> = Object.fromEntries(EXECUTOR_ERRORS.map(e => [e.name, e.code])) as Record<ExecutorErrorName, number>
export function executorErrorName(code: number): string { return EXECUTOR_ERROR_BY_CODE.get(code)?.name ?? `Unknown(${code})` }

/**
 * Extracts a `Custom(n)` code from an error rendering: LocalSvm.formatSvmError output (`{"Custom":5}` / `Custom(5)` / `custom program error: 0x5`)
 * or an RPC simulate `err` object serialised as JSON. Returns null when no custom code is present.
 */
export function parseCustomErrorCode(err: unknown): number | null {
  const s = typeof err === 'string' ? err : JSON.stringify(err ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  if (!s) return null
  const m = /Custom["']?\s*[:(]\s*["']?(\d+)/.exec(s) ?? /custom program error:\s*0x([0-9a-fA-F]+)/.exec(s)
  if (!m) return null
  return m[0].includes('0x') ? parseInt(m[1]!, 16) : Number(m[1])
}
/** True iff `err` carries the executor's custom code for `name`. NOTE: a DEX (Anchor) error in the 6000+ range is NOT ours. */
export function isExecutorError(err: unknown, name: ExecutorErrorName): boolean { return parseCustomErrorCode(err) === EXECUTOR_ERROR_CODE[name] }
