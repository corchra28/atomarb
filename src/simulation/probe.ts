import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterId, DecodedPool, PoolAdapter, Quote, RawAccount } from '../adapters/types.js'
import { isUnsupported } from '../adapters/types.js'
import type { CircuitEval, Circuit } from '../routing/circuit.js'
import type { RpcClient, SimulateResult } from '../state/rpc.js'
import { buildV0, computeBudgetIxs, type BuiltTx } from './tx_build.js'
import { LocalSvm, dumpProgram, type ProgramDump } from './local_svm.js'
import { associatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, WSOL_MINT, ACCOUNT_SIZE } from '../state/token.js'
import { sha256Hex } from '../util/hash.js'
import { nowUtcIso, monoMs } from '../util/time.js'
import type { EvidenceLevel, CostItem } from '../accounting/types.js'
import { externalCosts, transactionPnl, tradingPnl } from '../accounting/pnl.js'

export interface CostConfig { baseFeeLamportsPerSignature: number; computeUnitLimit: number; computeUnitPriceMicroLamports: number; jitoTipLamports: number; ataRentLamports: number }
export interface UserAccounts { user: PublicKey; baseAta: PublicKey; interAta: PublicKey; baseTokenProgram: PublicKey; interTokenProgram: PublicKey }
export function userAccountsFor(user: PublicKey, circuit: Circuit): UserAccounts {
  const interMint = circuit.token
  const interProg = poolTokenProgram(circuit.poolA, interMint)
  return { user, baseAta: associatedTokenAddress(user, WSOL_MINT, TOKEN_PROGRAM_ID), interAta: associatedTokenAddress(user, interMint, interProg), baseTokenProgram: TOKEN_PROGRAM_ID, interTokenProgram: interProg }
}
export function poolTokenProgram(p: DecodedPool, mint: PublicKey): PublicKey {
  const m = p.mintA.mint.equals(mint) ? p.mintA : p.mintB
  return m.program === 'token_2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
}
/** create-idempotent ATA instruction (ATA program ix index 1). */
export function createAtaIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM_ID, keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: tokenProgram, isSigner: false, isWritable: false }], data: Buffer.from([1]) })
}
export interface DirectTx { built: BuiltTx; ixA: TransactionInstruction; ixB: TransactionInstruction; accountsWritten: PublicKey[]; minOutA: bigint; minOutB: bigint; limitation: string }
/**
 * DIRECT circuit: [cu limit, cu price, create inter ATA (idempotent), swap A(amountIn, minOut=quoteA.out), swap B(amountIn=quoteA.out, minOut=quoteB.out)].
 * Limitation (documented): leg B's amount is the QUOTED output of A, not the realised one — surplus stays as intermediate inventory, deficit makes B fail. The Rust executor removes this limitation.
 */
export function buildDirectCircuitTx(adapters: Record<AdapterId, PoolAdapter>, c: Circuit, ev: CircuitEval, ua: UserAccounts, blockhash: string, cost: CostConfig, opts: { createInterAta?: boolean } = {}): DirectTx {
  const A = adapters[c.poolA.adapter], B = adapters[c.poolB.adapter]
  const a = A.buildSwapInstruction(c.poolA, { user: ua.user, userInputAccount: ua.baseAta, userOutputAccount: ua.interAta, amountIn: ev.quoteA.amountIn, minimumAmountOut: ev.quoteA.amountOutToUser })
  if (isUnsupported(a)) throw new Error(`LEG_A_BUILD_${a.code}: ${a.reason}`)
  const b = B.buildSwapInstruction(c.poolB, { user: ua.user, userInputAccount: ua.interAta, userOutputAccount: ua.baseAta, amountIn: ev.quoteA.amountOutToUser, minimumAmountOut: ev.quoteB.amountOutToUser })
  if (isUnsupported(b)) throw new Error(`LEG_B_BUILD_${b.code}: ${b.reason}`)
  const ixs = [...computeBudgetIxs(cost.computeUnitLimit, cost.computeUnitPriceMicroLamports)]
  if (opts.createInterAta ?? true) ixs.push(createAtaIdempotentIx(ua.user, ua.interAta, ua.user, c.token, ua.interTokenProgram))
  ixs.push(a.instruction, b.instruction)
  const built = buildV0(ua.user, blockhash, ixs)
  return { built, ixA: a.instruction, ixB: b.instruction, accountsWritten: [...a.accountsWritten, ...b.accountsWritten], minOutA: ev.quoteA.amountOutToUser, minOutB: ev.quoteB.amountOutToUser, limitation: 'DIRECT_FIXED_AMOUNTS: leg B amount = quoted leg A output; no dynamic delta; no on-chain profit guard beyond leg B minimum_amount_out' }
}
export interface MainnetSimEvidence {
  level: EvidenceLevel; environment: 'MAINNET_RPC_SIMULATION'; contextSlot: number; err: unknown; errClass: string; logs: string[]; unitsConsumed: number | null; messageHash: string; requestConfig: Record<string, unknown>; durationMs: number; receivedAtUtc: string
  postBalances: { baseAta: bigint | null; interAta: bigint | null } | null
  feeForMessageLamports: bigint | null
}
export function classifySimError(err: unknown, logs: string[]): string {
  const s = JSON.stringify(err ?? null)
  if (err === null || err === undefined) return 'OK'
  if (/AccountNotFound/.test(s)) return 'ACCOUNT_NOT_FOUND (payer/identity unfunded or missing)'
  if (/InsufficientFundsForFee/.test(s)) return 'IDENTITY_UNFUNDED (fee)'
  if (/BlockhashNotFound/.test(s)) return 'BLOCKHASH_EXPIRED'
  if (/insufficient lamports|insufficient funds/i.test(logs.join('\n'))) return 'INSUFFICIENT_FUNDS (identity has no balance)'
  if (/ExceededSlippage|slippage|6024|6001/i.test(logs.join('\n'))) return 'SLIPPAGE_OR_MIN_OUT'
  if (/InstructionError/.test(s)) return 'INSTRUCTION_ERROR'
  return 'OTHER'
}
export async function mainnetSimulate(rpc: RpcClient, tx: DirectTx | { built: BuiltTx }, ua: UserAccounts, opts: { minContextSlot?: number } = {}): Promise<MainnetSimEvidence> {
  const r: SimulateResult = await rpc.simulateTransaction(tx.built.tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: [ua.baseAta, ua.interAta], innerInstructions: true, ...(opts.minContextSlot !== undefined ? { minContextSlot: opts.minContextSlot } : {}) })
  const logs = r.value.logs ?? []
  let post: MainnetSimEvidence['postBalances'] = null
  if (r.value.accounts) {
    const amt = (a: { data: [string, string] } | null) => { if (!a) return null; const d = Buffer.from(a.data[0], 'base64'); if (d.length < 72) return null; return d.readBigUInt64LE(64) }
    post = { baseAta: amt(r.value.accounts[0] ?? null), interAta: amt(r.value.accounts[1] ?? null) }
  }
  let fee: bigint | null = null
  try { const f = await rpc.getFeeForMessage(Buffer.from(tx.built.messageBytes).toString('base64')); fee = f.value === null ? null : BigInt(f.value) } catch { fee = null }
  return { level: 'MAINNET_RPC_SIMULATION', environment: 'MAINNET_RPC_SIMULATION', contextSlot: r.context.slot, err: r.value.err, errClass: classifySimError(r.value.err, logs), logs, unitsConsumed: r.value.unitsConsumed ?? null, messageHash: tx.built.messageHash, requestConfig: r.requestConfig, durationMs: r.durationMs, receivedAtUtc: r.receivedAtUtc, postBalances: post, feeForMessageLamports: fee }
}
/** Program ELF cache: tests/fixtures/programs/<id>.so (committed by fixture scripts) or data/programs/<id>.so (dumped on demand). */
export async function loadProgramCached(rpc: RpcClient | null, programId: PublicKey, dirs = ['tests/fixtures/programs', 'data/programs']): Promise<ProgramDump> {
  for (const d of dirs) {
    const so = join(d, `${programId.toBase58()}.so`), meta = join(d, `${programId.toBase58()}.json`)
    if (existsSync(so)) { const m = existsSync(meta) ? JSON.parse(readFileSync(meta, 'utf8')) as { slot?: number; programDataAddress?: string | null } : {}; return { programId, elf: new Uint8Array(readFileSync(so)), programDataAddress: m.programDataAddress ? new PublicKey(m.programDataAddress) : null, slot: m.slot ?? 0, loader: 'upgradeable' } }
  }
  if (!rpc) throw new Error(`PROGRAM_ELF_MISSING ${programId.toBase58()} (no cache and no rpc)`)
  const dump = await dumpProgram(rpc, programId)
  const d = dirs[dirs.length - 1]!; mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${programId.toBase58()}.so`), dump.elf)
  writeFileSync(join(d, `${programId.toBase58()}.json`), JSON.stringify({ programId: programId.toBase58(), programDataAddress: dump.programDataAddress?.toBase58() ?? null, slot: dump.slot, sha256: sha256Hex(dump.elf), bytes: dump.elf.length, fetched_at_utc: nowUtcIso() }, null, 1))
  return dump
}
export interface LocalProbeEvidence {
  level: EvidenceLevel; environment: 'LOCAL_REAL_PROGRAM_SIMULATION'
  ok: boolean; err: string | null; logs: string[]; unitsConsumed: bigint
  deltas: { baseAta: bigint; interAta: bigint; userLamports: bigint } | null
  quoted: { amountIn: bigint; amountOut: bigint; pnl: bigint }
  realised: { pnl: bigint; matchesQuote: boolean } | null
  synthetic: { pubkey: string; note: string }[]
  loadedPrograms: { programId: string; bytes: number; slot: number }[]
  accountsLoaded: number; accountsMissingOnChain: string[]
  snapshot: { minSlot: number; maxSlot: number; singleBatch: boolean }
  accounting: { status: 'COMPLETE' | 'ACCOUNTING_INCOMPLETE'; pnlAfterExternal: bigint; externalCosts: CostItem[]; locked: CostItem[]; notes: string[] }
  durationMs: number
}
const SYSVARS = new Set(['SysvarC1ock11111111111111111111111111111111', 'SysvarRent111111111111111111111111111111111', 'Sysvar1nstructions1111111111111111111111111'])
/**
 * LOCAL_REAL_PROGRAM_SIMULATION with EXACT accounting: real program ELFs + real accounts (one getMultipleAccounts for all instruction keys when they fit in 100),
 * synthetic user balances (labelled), execution in LiteSVM, token/lamport deltas measured before/after. NOT a mainnet result.
 */
export async function localProbe(rpc: RpcClient, adapters: Record<AdapterId, PoolAdapter>, c: Circuit, ev: CircuitEval, cost: CostConfig, opts: { fundLamports?: bigint; extraAccounts?: RawAccount[]; programIds?: PublicKey[] } = {}): Promise<LocalProbeEvidence> {
  const t0 = monoMs()
  const user = PublicKey.unique()
  const ua = userAccountsFor(user, c)
  const svm = new LocalSvm({ sigverify: false })
  const programs = new Set<string>([c.poolA.programId.toBase58(), c.poolB.programId.toBase58(), ...(opts.programIds ?? []).map(p => p.toBase58())])
  const direct = buildDirectCircuitTx(adapters, c, ev, ua, svm.svm.latestBlockhash(), cost)
  // collect every key referenced by both swap instructions (+ their program ids) except user-owned synthetic accounts, programs we load, sysvars, well-known programs
  const skip = new Set([user.toBase58(), ua.baseAta.toBase58(), ua.interAta.toBase58(), SYSTEM_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'ComputeBudget111111111111111111111111111111', ...SYSVARS])
  const keys: PublicKey[] = []
  for (const ix of [direct.ixA, direct.ixB]) { programs.add(ix.programId.toBase58()); for (const k of ix.keys) if (!skip.has(k.pubkey.toBase58()) && !programs.has(k.pubkey.toBase58()) && !keys.some(x => x.equals(k.pubkey))) keys.push(k.pubkey) }
  for (const p of programs) { const dump = await loadProgramCached(rpc, new PublicKey(p)); svm.addProgram(dump) }
  const fetched = keys.length <= 100 ? await rpc.getMultipleAccounts(keys) : await rpc.getAccountsBatched(keys)
  const missing = fetched.missing.map(m => m.toBase58())
  for (const a of fetched.bundle.accounts.values()) svm.setRaw(a)
  for (const a of opts.extraAccounts ?? []) svm.setRaw(a)
  // synthetic user: SOL for fees/rent + WSOL ATA holding amountIn + rent; empty intermediate ATA is created by the tx (idempotent ix) so rent is measured
  const fund = opts.fundLamports ?? 50_000_000n
  svm.fundSystemAccount(user, fund, 'synthetic user')
  svm.fundTokenAccount(ua.baseAta, WSOL_MINT, user, ev.amountIn, TOKEN_PROGRAM_ID, 'synthetic WSOL ATA', true)
  const before = { base: svm.tokenAmount(ua.baseAta) ?? 0n, inter: svm.tokenAmount(ua.interAta) ?? 0n, lamports: svm.getAccount(user)?.lamports ?? 0n }
  const r = svm.execute(direct.built.tx)
  const after = { base: svm.tokenAmount(ua.baseAta) ?? 0n, inter: svm.tokenAmount(ua.interAta) ?? 0n, lamports: svm.getAccount(user)?.lamports ?? 0n }
  const quoted = { amountIn: ev.amountIn, amountOut: ev.quoteB.amountOutToUser, pnl: ev.pnl.pnl }
  const deltas = r.ok ? { baseAta: after.base - before.base, interAta: after.inter - before.inter, userLamports: after.lamports - before.lamports } : null
  const realised = deltas ? { pnl: deltas.baseAta, matchesQuote: deltas.baseAta === quoted.pnl && deltas.interAta === 0n } : null
  const notes: string[] = []
  const interRentPaid = deltas ? (-(deltas.userLamports) - 5000n) : 0n // lamports spent beyond the base fee: ATA/volume-accumulator rents etc. (LOCAL measure)
  if (deltas && deltas.interAta !== 0n) notes.push(`INTERMEDIATE_INVENTORY_LEFT=${deltas.interAta} (direct tx codes leg B amount = quoted A output)`)
  const ext = externalCosts({ baseFeeLamports: BigInt(cost.baseFeeLamportsPerSignature), signatures: 1, computeUnitLimit: cost.computeUnitLimit, computeUnitPriceMicroLamports: cost.computeUnitPriceMicroLamports, jitoTipLamports: BigInt(cost.jitoTipLamports), nonRecoverableRentLamports: 0n, recoverableRentLamports: interRentPaid > 0n ? interRentPaid : 0n })
  if (deltas) ext.costs.push({ name: 'lamports_spent_in_local_execution_excl_base_fee', unit: 'lamports', amount: interRentPaid, status: 'OBSERVED', source: 'LiteSVM user lamport delta minus 5000 base fee (rent for created accounts; recoverable only if closed later)', note: 'LOCAL_REAL_PROGRAM_SIMULATION; priority fee is not charged by LiteSVM default fee structure' })
  const pnlTx = transactionPnl(tradingPnl(WSOL_MINT, ev.quoteA, ev.quoteB), ext, r.ok ? [] : ['EXECUTION_FAILED'])
  return { level: 'LOCAL_REAL_PROGRAM_SIMULATION', environment: 'LOCAL_REAL_PROGRAM_SIMULATION', ok: r.ok, err: r.err, logs: r.logs, unitsConsumed: r.unitsConsumed, deltas, quoted, realised, synthetic: svm.synthetic.map(s => ({ pubkey: s.pubkey.toBase58(), note: s.note })), loadedPrograms: svm.loadedPrograms, accountsLoaded: fetched.bundle.accounts.size, accountsMissingOnChain: missing, snapshot: { minSlot: fetched.bundle.minSlot, maxSlot: fetched.bundle.maxSlot, singleBatch: fetched.bundle.singleBatch }, accounting: { status: pnlTx.status, pnlAfterExternal: realised ? realised.pnl - ext.total : pnlTx.pnlAfterExternal, externalCosts: pnlTx.externalCosts, locked: pnlTx.lockedCapital, notes }, durationMs: monoMs() - t0 }
}
export function quoteSummary(q: Quote): Record<string, unknown> {
  return { adapter: q.adapter, pool: q.pool.toBase58(), in: q.amountIn, out: q.amountOutToUser, fees: q.fees.map(f => `${f.name}=${f.amount}`), impactBps: q.priceImpactBps, slot: q.contextSlot, rejects: q.rejectReasons }
}
export const ACCOUNT_SIZE_TOKEN = ACCOUNT_SIZE
