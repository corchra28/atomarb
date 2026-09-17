import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { address as kitAddress, lamports as kitLamports, type Address, type EncodedAccount, type Transaction, type TransactionMessageBytes, type SignatureBytes, type SignaturesMap } from '@solana/kit'
import { LiteSVM, FailedTransactionMetadata } from 'litesvm'
import type { RawAccount } from '../adapters/types.js'
import type { RpcClient } from '../state/rpc.js'
import { readPubkey, readU32LE, writeU64LE } from '../util/bytes.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ACCOUNT_SIZE, SYSTEM_PROGRAM_ID } from '../state/token.js'

export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
export const BPF_LOADER_2 = new PublicKey('BPFLoader2111111111111111111111111111111111')
const A = (pk: PublicKey): Address => kitAddress(pk.toBase58())
/** A program ELF dumped from mainnet with provenance (slot at which the programdata account was read). */
export interface ProgramDump { programId: PublicKey; elf: Uint8Array; programDataAddress: PublicKey | null; slot: number; loader: 'upgradeable' | 'v2' }
/**
 * Dumps a program from mainnet via RPC (read-only). Upgradeable loader: program account = [u32 tag=2][programdata pubkey]; programdata account =
 * [u32 tag=3][u64 slot][Option<Pubkey> upgrade authority (1+32)] = 45 bytes header, followed by the ELF (verified against agave sources in docs/sources).
 */
export async function dumpProgram(rpc: RpcClient, programId: PublicKey): Promise<ProgramDump> {
  const r = await rpc.getMultipleAccounts([programId]); const acc = r.bundle.accounts.get(programId.toBase58())
  if (!acc) throw new Error(`PROGRAM_NOT_FOUND ${programId.toBase58()}`)
  if (acc.owner.equals(BPF_LOADER_UPGRADEABLE)) {
    if (readU32LE(acc.data, 0) !== 2) throw new Error(`PROGRAM_ACCOUNT_TAG ${readU32LE(acc.data, 0)} != 2`)
    const pd = readPubkey(acc.data, 4)
    const r2 = await rpc.getMultipleAccounts([pd]); const pda = r2.bundle.accounts.get(pd.toBase58())
    if (!pda) throw new Error(`PROGRAMDATA_NOT_FOUND ${pd.toBase58()}`)
    if (readU32LE(pda.data, 0) !== 3) throw new Error(`PROGRAMDATA_TAG ${readU32LE(pda.data, 0)} != 3`)
    return { programId, elf: pda.data.subarray(45), programDataAddress: pd, slot: r2.context.slot, loader: 'upgradeable' }
  }
  if (acc.owner.equals(BPF_LOADER_2)) return { programId, elf: acc.data, programDataAddress: null, slot: r.context.slot, loader: 'v2' }
  throw new Error(`UNSUPPORTED_LOADER ${acc.owner.toBase58()}`)
}
/** Converts a web3.js 1.x VersionedTransaction into the kit Transaction shape litesvm expects. Unsigned: zero signatures (only valid with sigverify disabled). */
export function toKitTransaction(tx: VersionedTransaction): Transaction {
  const msg = tx.message
  const n = msg.header.numRequiredSignatures
  const signatures: Record<string, SignatureBytes | null> = {}
  for (let i = 0; i < n; i++) {
    const signer = msg.staticAccountKeys[i]!
    const sig = tx.signatures[i]
    signatures[signer.toBase58()] = (sig && sig.some(b => b !== 0) ? sig : new Uint8Array(64)) as SignatureBytes
  }
  return { messageBytes: msg.serialize() as unknown as TransactionMessageBytes, signatures: signatures as SignaturesMap }
}
/** Human-readable error: litesvm returns typed error classes or a fieldless enum number. */
export function formatSvmError(r: FailedTransactionMetadata): string {
  const e = r.err() as unknown
  if (typeof e === 'number') return `TransactionError(${TX_ERR_FIELDLESS[e] ?? e})`
  if (e && typeof e === 'object') {
    const o = e as { index?: number; accountIndex?: number; err?: () => unknown; toString?: () => string }
    const inner = typeof o.err === 'function' ? o.err() : undefined
    const innerStr = inner === undefined ? '' : (typeof inner === 'number' ? ` ${IX_ERR_FIELDLESS[inner] ?? inner}` : ` ${JSON.stringify(inner, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
    return `${e.constructor?.name ?? 'Error'}${o.index !== undefined ? `[ix ${o.index}]` : ''}${o.accountIndex !== undefined ? `[account ${o.accountIndex}]` : ''}${innerStr} :: ${r.toString()}`
  }
  return String(r.toString())
}
const TX_ERR_FIELDLESS: Record<number, string> = { 0: 'AccountInUse', 1: 'AccountLoadedTwice', 2: 'AccountNotFound', 3: 'ProgramAccountNotFound', 4: 'InsufficientFundsForFee', 5: 'InvalidAccountForFee', 6: 'AlreadyProcessed', 7: 'BlockhashNotFound', 8: 'CallChainTooDeep', 9: 'MissingSignatureForFee', 10: 'InvalidAccountIndex', 11: 'SignatureFailure', 12: 'InvalidProgramForExecution', 13: 'SanitizeFailure', 14: 'ClusterMaintenance', 15: 'AccountBorrowOutstanding', 16: 'WouldExceedMaxBlockCostLimit', 17: 'UnsupportedVersion', 18: 'InvalidWritableAccount', 19: 'WouldExceedMaxAccountCostLimit', 20: 'WouldExceedAccountDataBlockLimit', 21: 'TooManyAccountLocks', 22: 'AddressLookupTableNotFound', 23: 'InvalidAddressLookupTableOwner', 24: 'InvalidAddressLookupTableData', 25: 'InvalidAddressLookupTableIndex', 26: 'InvalidRentPayingAccount', 27: 'WouldExceedMaxVoteCostLimit', 28: 'WouldExceedAccountDataTotalLimit', 29: 'MaxLoadedAccountsDataSizeExceeded', 30: 'InvalidLoadedAccountsDataSizeLimit', 31: 'ResanitizationNeeded', 32: 'UnbalancedTransaction', 33: 'ProgramCacheHitMaxLimit', 34: 'CommitCancelled' }
const IX_ERR_FIELDLESS: Record<number, string> = { 0: 'GenericError', 1: 'InvalidArgument', 2: 'InvalidInstructionData', 3: 'InvalidAccountData', 4: 'AccountDataTooSmall', 5: 'InsufficientFunds', 6: 'IncorrectProgramId', 7: 'MissingRequiredSignature', 8: 'AccountAlreadyInitialized', 9: 'UninitializedAccount', 10: 'UnbalancedInstruction', 11: 'ModifiedProgramId', 12: 'ExternalAccountLamportSpend', 13: 'ExternalAccountDataModified', 14: 'ReadonlyLamportChange', 15: 'ReadonlyDataModified', 16: 'DuplicateAccountIndex', 17: 'ExecutableModified', 18: 'RentEpochModified', 19: 'NotEnoughAccountKeys', 20: 'AccountDataSizeChanged', 21: 'AccountNotExecutable', 22: 'AccountBorrowFailed', 23: 'AccountBorrowOutstanding', 24: 'DuplicateAccountOutOfSync', 25: 'InvalidError', 26: 'ExecutableDataModified', 27: 'ExecutableLamportChange', 28: 'ExecutableAccountNotRentExempt', 29: 'UnsupportedProgramId', 30: 'CallDepth', 31: 'MissingAccount', 32: 'ReentrancyNotAllowed', 33: 'MaxSeedLengthExceeded', 34: 'InvalidSeeds', 35: 'InvalidRealloc', 36: 'ComputationalBudgetExceeded', 37: 'PrivilegeEscalation', 38: 'ProgramEnvironmentSetupFailure', 39: 'ProgramFailedToComplete', 40: 'ProgramFailedToCompile', 41: 'Immutable', 42: 'IncorrectAuthority', 43: 'AccountNotRentExempt', 44: 'InvalidAccountOwner', 45: 'ArithmeticOverflow', 46: 'UnsupportedSysvar', 47: 'IllegalOwner', 48: 'MaxAccountsDataAllocationsExceeded', 49: 'MaxAccountsExceeded', 50: 'MaxInstructionTraceLengthExceeded', 51: 'BuiltinProgramsMustConsumeComputeUnits' }
export interface SyntheticAccount { pubkey: PublicKey; note: string }
/** Local SVM harness. Loads REAL program ELFs and REAL account snapshots; any balance it fabricates is recorded in `synthetic` and must be labelled in reports. */
export class LocalSvm {
  readonly svm: LiteSVM
  readonly synthetic: SyntheticAccount[] = []
  readonly loadedPrograms: { programId: string; bytes: number; slot: number }[] = []
  readonly loadedAccounts: { pubkey: string; slot: number; owner: string }[] = []
  constructor(opts: { sigverify?: boolean } = {}) {
    this.svm = new LiteSVM().withDefaultPrograms().withSysvars().withBuiltins().withSigverify(opts.sigverify ?? false).withBlockhashCheck(false)
  }
  addProgram(p: ProgramDump): void { this.svm.addProgram(A(p.programId), p.elf); this.loadedPrograms.push({ programId: p.programId.toBase58(), bytes: p.elf.length, slot: p.slot }) }
  private set(pk: PublicKey, lamports: bigint, data: Uint8Array, owner: PublicKey, executable = false): void {
    const acc: EncodedAccount = { address: A(pk), lamports: kitLamports(lamports), data, executable, programAddress: A(owner), space: BigInt(data.length) }
    this.svm.setAccount(acc)
  }
  setRaw(a: RawAccount): void { this.set(a.pubkey, a.lamports, a.data, a.owner, a.executable); this.loadedAccounts.push({ pubkey: a.pubkey.toBase58(), slot: a.contextSlot, owner: a.owner.toBase58() }) }
  /** Fabricates a system account with lamports (LOCAL ONLY). */
  fundSystemAccount(pk: PublicKey, lamports: bigint, note: string): void { this.set(pk, lamports, new Uint8Array(0), SYSTEM_PROGRAM_ID); this.synthetic.push({ pubkey: pk, note: `${note}: system account ${lamports} lamports` }) }
  /** Fabricates an SPL token account (165 bytes, initialized) for `mint`/`owner` with `amount` (LOCAL ONLY). For WSOL, is_native is set so lamports = rent + amount. */
  fundTokenAccount(addr: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint, tokenProgram: PublicKey, note: string, isNativeWsol = false): void {
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('unsupported token program for synthetic account')
    const data = new Uint8Array(ACCOUNT_SIZE)
    data.set(mint.toBytes(), 0); data.set(owner.toBytes(), 32); data.set(writeU64LE(amount), 64); data[108] = 1
    const rent = this.svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE))
    let lamports = rent
    if (isNativeWsol) { data.set(new Uint8Array([1, 0, 0, 0]), 109); data.set(writeU64LE(rent), 113); lamports = rent + amount }
    this.set(addr, lamports, data, tokenProgram)
    this.synthetic.push({ pubkey: addr, note: `${note}: token account mint=${mint.toBase58()} amount=${amount}` })
  }
  rentExempt(dataLen: number): bigint { return this.svm.minimumBalanceForRentExemption(BigInt(dataLen)) }
  getAccount(pk: PublicKey): { lamports: bigint; data: Uint8Array; owner: PublicKey } | null {
    const a = this.svm.getAccount(A(pk)); if (!a.exists) return null
    return { lamports: BigInt(a.lamports), data: new Uint8Array(a.data), owner: new PublicKey(a.programAddress) }
  }
  tokenAmount(pk: PublicKey): bigint | null { const a = this.getAccount(pk); if (!a || a.data.length < 72) return null; let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(a.data[64 + i]!); return v }
  simulate(tx: VersionedTransaction): { ok: boolean; err: string | null; logs: string[]; unitsConsumed: bigint } {
    const r = this.svm.simulateTransaction(toKitTransaction(tx))
    if (r instanceof FailedTransactionMetadata) return { ok: false, err: formatSvmError(r), logs: r.meta().logs(), unitsConsumed: r.meta().computeUnitsConsumed() }
    const meta = r.meta(); return { ok: true, err: null, logs: meta.logs(), unitsConsumed: meta.computeUnitsConsumed() }
  }
  /** Executes locally (state changes persist in this SVM instance). Use a fresh instance per probe. */
  execute(tx: VersionedTransaction): { ok: boolean; err: string | null; logs: string[]; unitsConsumed: bigint } {
    const r = this.svm.sendTransaction(toKitTransaction(tx))
    if (r instanceof FailedTransactionMetadata) return { ok: false, err: formatSvmError(r), logs: r.meta().logs(), unitsConsumed: r.meta().computeUnitsConsumed() }
    return { ok: true, err: null, logs: r.logs(), unitsConsumed: r.computeUnitsConsumed() }
  }
}
