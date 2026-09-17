import type { PublicKey, TransactionInstruction } from '@solana/web3.js'

/** Adapter identifiers. Adding an id here does NOT make a program supported: an adapter must implement every method or return UNSUPPORTED. */
export type AdapterId = 'raydium_cpmm' | 'pumpswap'

export interface Unsupported {
  status: 'UNSUPPORTED'
  reason: string
  /** machine-readable code, e.g. UNKNOWN_LAYOUT, TOKEN2022_EXTENSION, NOT_IMPLEMENTED */
  code: string
}
export const unsupported = (code: string, reason: string): Unsupported => ({ status: 'UNSUPPORTED', code, reason })
export function isUnsupported<T>(x: T | Unsupported): x is Unsupported {
  return typeof x === 'object' && x !== null && (x as Unsupported).status === 'UNSUPPORTED'
}

/** A pool address as discovered by an index API / local inventory. Unverified until decodeSnapshot + validatePool succeed. */
export interface PoolRef {
  adapter: AdapterId
  address: PublicKey
  /** discovery provenance: which source produced this address (api name / file), when (UTC ISO) */
  source: { kind: string; ref: string; observedAtUtc: string }
  /** hints from discovery (unverified): mints, liquidity in USD etc. Never used for quoting. */
  hints?: Record<string, string | number | boolean | null>
}

/** Raw account as returned by RPC, with the response context it came from. */
export interface RawAccount {
  pubkey: PublicKey
  data: Uint8Array
  owner: PublicKey
  lamports: bigint
  executable: boolean
  /** slot from the RPC response `context.slot` of the batch that returned this account */
  contextSlot: number
  /** UTC receive time (wall clock) and monotonic ms of the batch */
  receivedAtUtc: string
  receivedMonoMs: number
  /** identifies the batch (getMultipleAccounts call) so that callers can tell whether two accounts came from the same response */
  batchId: string
  /** 'rpc_gma' | 'wss_account' | 'local_fixture' | 'litesvm' */
  provider: string
}

export interface AccountBundle {
  /** keyed by base58 pubkey */
  accounts: Map<string, RawAccount>
  /** true iff every account came from ONE getMultipleAccounts response (same batchId) */
  singleBatch: boolean
  /** min and max contextSlot across accounts */
  minSlot: number
  maxSlot: number
  batchIds: string[]
}

export type TokenProgramKind = 'spl_token' | 'token_2022'

export interface MintInfo {
  mint: PublicKey
  program: TokenProgramKind
  decimals: number
  supply: bigint
  freezeAuthority: PublicKey | null
  mintAuthority: PublicKey | null
  /** Token-2022 extension type ids present on the mint (empty for SPL Token) */
  extensions: number[]
  /** parsed TransferFeeConfig if present: the NEWER tier, plus the OLDER tier it replaces (Token-2022 applies `older` until `newer.epoch`) */
  transferFee?: { bps: number; maxFee: bigint; epoch: bigint } | undefined
  transferFeeOlder?: { bps: number; maxFee: bigint; epoch: bigint } | undefined
}

export interface TokenAccountInfo {
  address: PublicKey
  program: TokenProgramKind
  mint: PublicKey
  owner: PublicKey
  amount: bigint
  /** 1 = initialized, 2 = frozen */
  state: number
  extensions: number[]
}

export interface FeeItem {
  name: string
  /** basis points of the *input* amount unless `on` says otherwise */
  bps?: number | undefined
  amount: bigint
  mint: PublicKey
  /** whether this fee is already deducted in `amountOutToUser` / added to `amountInGross` (always true for DEX-internal fees) */
  alreadyIncluded: true
  /** who receives it: 'lp' | 'protocol' | 'fund' | 'creator' | 'token2022_transfer_fee' */
  recipient: string
  /** where the rate came from */
  source: string
}

/** Fully decoded and validated pool state — the ONLY input to quoting. */
export interface DecodedPool {
  adapter: AdapterId
  address: PublicKey
  programId: PublicKey
  mintA: MintInfo
  mintB: MintInfo
  vaultA: TokenAccountInfo
  vaultB: TokenAccountInfo
  /** reserves usable for pricing (vault balance minus fees owed to protocol/fund/creator as the program defines) */
  reserveA: bigint
  reserveB: bigint
  /** adapter-specific decoded fields (fee rates, status, config addresses...) */
  params: Record<string, unknown>
  /** every account the quote depended on (pool, config, vaults, mints, fee accounts) */
  dependsOn: PublicKey[]
  /** sha256 over the raw bytes of dependsOn accounts in order, plus their slots */
  stateHash: string
  snapshot: { minSlot: number; maxSlot: number; singleBatch: boolean; batchIds: string[]; receivedAtUtc: string }
  /** layout version recognised by the adapter (for cache invalidation) */
  layoutVersion: string
}

export interface ValidationResult {
  ok: boolean
  /** machine-readable reasons; empty when ok */
  rejects: { code: string; detail: string }[]
  /** warnings that do not block quoting but must be carried into reports */
  warnings: { code: string; detail: string }[]
}

export interface Quote {
  adapter: AdapterId
  pool: PublicKey
  inputMint: PublicKey
  outputMint: PublicKey
  /** amount the user must provide (raw units of inputMint), inclusive of any DEX fee taken on input */
  amountIn: bigint
  /** amount credited to the user's output token account after ALL DEX-internal fees and Token-2022 transfer fees */
  amountOutToUser: bigint
  /** the amount the pool vault receives / releases (for state transition) */
  vaultInDelta: bigint
  vaultOutDelta: bigint
  fees: FeeItem[]
  /** spot price impact estimate in bps (informational only) */
  priceImpactBps: number
  /** accounts the swap instruction will need (for atomic snapshot / ALT sizing) */
  accountsNeeded: PublicKey[]
  stateHash: string
  contextSlot: { min: number; max: number }
  rejectReasons: string[]
  /** rounding notes for audit */
  math: Record<string, string>
}

export interface SwapIxParams {
  user: PublicKey
  userInputAccount: PublicKey
  userOutputAccount: PublicKey
  amountIn: bigint
  minimumAmountOut: bigint
}

export interface PoolAdapter {
  readonly id: AdapterId
  readonly programId: PublicKey
  /** Optional: adapter-specific discovery. The primary discovery entry point is src/discovery (index APIs + local inventories); never used for pricing. */
  discoverPools?(opts: { mints?: PublicKey[]; limit?: number; sources?: string[] }): Promise<{ pools: PoolRef[]; sourcesUsed: string[]; notes: string[] } | Unsupported>
  /** Accounts that must be fetched (ideally in ONE getMultipleAccounts) to decode + quote this pool. May require a 2-step fetch: pool first, then dependents. */
  requiredAccounts(pool: PoolRef, poolAccount?: RawAccount): PublicKey[] | Unsupported
  decodeSnapshot(pool: PoolRef, bundle: AccountBundle): DecodedPool | Unsupported
  validatePool(decoded: DecodedPool): ValidationResult
  quoteExactIn(decoded: DecodedPool, inputMint: PublicKey, amountIn: bigint): Quote | Unsupported
  /** Pure state transition: the pool after `quote` executes. Must NOT mutate `decoded`. */
  applySwap(decoded: DecodedPool, quote: Quote): DecodedPool | Unsupported
  buildSwapInstruction(decoded: DecodedPool, params: SwapIxParams): { instruction: TransactionInstruction; accountsWritten: PublicKey[] } | Unsupported
}
