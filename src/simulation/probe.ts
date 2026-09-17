import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterId, DecodedPool, PoolAdapter, Quote, RawAccount, AccountBundle } from '../adapters/types.js'
import { isUnsupported } from '../adapters/types.js'
import type { CircuitEval, Circuit } from '../routing/circuit.js'
import type { RpcClient, SimulateResult } from '../state/rpc.js'
import { buildV0, computeBudgetIxs, MAX_TX_BYTES, type BuiltTx } from './tx_build.js'
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
  level: EvidenceLevel; environment: 'MAINNET_RPC_SIMULATION'; contextSlot: number; err: unknown; errDetail: SimErrorDetail; errClass: string; logs: string[]; unitsConsumed: number | null; messageHash: string; requestConfig: Record<string, unknown>; durationMs: number; receivedAtUtc: string
  postBalances: { baseAta: bigint | null; interAta: bigint | null } | null
  feeForMessageLamports: bigint | null
}
/** Structured error identity: which instruction of THE TESTED message failed and with which code (never the index of a reference transaction). */
export interface SimErrorDetail { instructionIndex: number | null; kind: string | null; customCode: number | null; programLogError: string | null }
export function parseSimError(err: unknown, logs: string[]): SimErrorDetail {
  const out: SimErrorDetail = { instructionIndex: null, kind: null, customCode: null, programLogError: null }
  const e = err as { InstructionError?: [number, unknown] } | string | null | undefined
  if (e && typeof e === 'object' && Array.isArray(e.InstructionError)) {
    out.instructionIndex = e.InstructionError[0]
    const inner = e.InstructionError[1]
    if (typeof inner === 'string') out.kind = inner
    else if (inner && typeof inner === 'object' && 'Custom' in (inner as Record<string, unknown>)) { out.kind = 'Custom'; out.customCode = Number((inner as { Custom: number }).Custom) }
    else out.kind = JSON.stringify(inner)
  } else if (typeof e === 'string') out.kind = e
  const l = logs.find(x => /Program log: (Error|AnchorError)/.test(x)); if (l) out.programLogError = l.slice(0, 300)
  return out
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
export async function mainnetSimulate(rpc: RpcClient, tx: DirectTx | { built: BuiltTx }, ua: UserAccounts, opts: { minContextSlot?: number | undefined } = {}): Promise<MainnetSimEvidence> {
  if (!tx.built.inspection.withinSizeLimit) {
    // A mainnet address lookup table would be needed (creating/extending one is a write, not available in this read-only lot). Local probes fabricate an ALT instead.
    return { level: 'QUOTE_ONLY', environment: 'MAINNET_RPC_SIMULATION', contextSlot: 0, err: { TxTooLarge: tx.built.serializedBytes }, errDetail: { instructionIndex: null, kind: 'TxTooLarge', customCode: null, programLogError: null }, errClass: `TX_TOO_LARGE_NEEDS_ALT (${tx.built.serializedBytes} > ${MAX_TX_BYTES} bytes; no lookup table in read-only mode)`, logs: [], unitsConsumed: null, messageHash: tx.built.messageHash, requestConfig: {}, durationMs: 0, receivedAtUtc: nowUtcIso(), postBalances: null, feeForMessageLamports: null }
  }
  const r: SimulateResult = await rpc.simulateTransaction(tx.built.tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: [ua.baseAta, ua.interAta], innerInstructions: true, ...(opts.minContextSlot !== undefined ? { minContextSlot: opts.minContextSlot } : {}) })
  const logs = r.value.logs ?? []
  let post: MainnetSimEvidence['postBalances'] = null
  if (r.value.accounts) {
    const amt = (a: { data: [string, string] } | null) => { if (!a) return null; const d = Buffer.from(a.data[0], 'base64'); if (d.length < 72) return null; return d.readBigUInt64LE(64) }
    post = { baseAta: amt(r.value.accounts[0] ?? null), interAta: amt(r.value.accounts[1] ?? null) }
  }
  let fee: bigint | null = null
  try { const f = await rpc.getFeeForMessage(Buffer.from(tx.built.messageBytes).toString('base64')); fee = f.value === null ? null : BigInt(f.value) } catch { fee = null }
  return { level: 'MAINNET_RPC_SIMULATION', environment: 'MAINNET_RPC_SIMULATION', contextSlot: r.context.slot, err: r.value.err, errDetail: parseSimError(r.value.err, logs), errClass: classifySimError(r.value.err, logs), logs, unitsConsumed: r.value.unitsConsumed ?? null, messageHash: tx.built.messageHash, requestConfig: r.requestConfig, durationMs: r.durationMs, receivedAtUtc: r.receivedAtUtc, postBalances: post, feeForMessageLamports: fee }
}
/** Program ELF cache: tests/fixtures/programs/<id>.so (committed by fixture scripts) or data/programs/<id>.so (dumped on demand). */
export async function loadProgramCached(rpc: RpcClient | null, programId: PublicKey, dirs: string[] = ['tests/fixtures/programs', 'data/programs']): Promise<ProgramDump> {
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
  /** measured balances around the attempt, also on failure (a reverted circuit must leave the token balances untouched and cost only the fee) */
  balances: { before: { baseAta: bigint; interAta: bigint; userLamports: bigint }; after: { baseAta: bigint; interAta: bigint; userLamports: bigint } }
  quoted: { amountIn: bigint; amountOut: bigint; pnl: bigint }
  realised: { pnl: bigint; matchesQuote: boolean } | null
  synthetic: { pubkey: string; note: string }[]
  loadedPrograms: { programId: string; bytes: number; slot: number }[]
  accountsLoaded: number; accountsMissingOnChain: string[]
  snapshot: { minSlot: number; maxSlot: number; singleBatch: boolean }
  accounting: { status: 'COMPLETE' | 'ACCOUNTING_INCOMPLETE'; pnlAfterExternal: bigint; externalCosts: CostItem[]; locked: CostItem[]; notes: string[] }
  durationMs: number
}
/** Programs that a DEX program invokes by CPI and that must therefore be loaded alongside it (docs/sources/pumpswap.md §1: pump_amm -> pump_fees GetFeesWithQuoteMint). */
export const PROGRAM_DEPENDENCIES: Record<string, string[]> = { pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: ['pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'] }
export function withDependencies(programs: Set<string>): Set<string> { const out = new Set(programs); for (const p of programs) for (const d of PROGRAM_DEPENDENCIES[p] ?? []) out.add(d); return out }
/** Either one getMultipleAccounts (or batched) for `keys`, or a pre-fetched bundle (fixtures; offline). */
export async function fetchOrBundle(rpc: RpcClient | null, keys: PublicKey[], bundle?: AccountBundle): Promise<{ bundle: AccountBundle; missing: PublicKey[] }> {
  if (bundle) return { bundle, missing: keys.filter(k => !bundle.accounts.has(k.toBase58())) }
  if (!rpc) throw new Error('NO_RPC_AND_NO_BUNDLE')
  return keys.length <= 100 ? await rpc.getMultipleAccounts(keys) : await rpc.getAccountsBatched(keys)
}
/** Keys a probe needs for a circuit (both swap instructions' non-user, non-program, non-sysvar keys) — used by fixture capture. */
export function circuitAccountKeys(adapters: Record<AdapterId, PoolAdapter>, c: Circuit, ev: CircuitEval): PublicKey[] {
  const user = PublicKey.unique(); const ua = userAccountsFor(user, c)
  const A = adapters[c.poolA.adapter], B = adapters[c.poolB.adapter]
  const a = A.buildSwapInstruction(c.poolA, { user, userInputAccount: ua.baseAta, userOutputAccount: ua.interAta, amountIn: ev.quoteA.amountIn, minimumAmountOut: 1n })
  const b = B.buildSwapInstruction(c.poolB, { user, userInputAccount: ua.interAta, userOutputAccount: ua.baseAta, amountIn: ev.quoteA.amountOutToUser, minimumAmountOut: 1n })
  if (isUnsupported(a) || isUnsupported(b)) throw new Error('BUILD_FAILED')
  const programs = withDependencies(new Set([c.poolA.programId.toBase58(), c.poolB.programId.toBase58()]))
  const skip = new Set([user.toBase58(), ua.baseAta.toBase58(), ua.interAta.toBase58(), SYSTEM_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'ComputeBudget111111111111111111111111111111', ...SYSVARS])
  const keys: PublicKey[] = []
  for (const ix of [a.instruction, b.instruction]) for (const k of ix.keys) if (!skip.has(k.pubkey.toBase58()) && !programs.has(k.pubkey.toBase58()) && !keys.some(x => x.equals(k.pubkey))) keys.push(k.pubkey)
  return keys
}
const SYSVARS = new Set(['SysvarC1ock11111111111111111111111111111111', 'SysvarRent111111111111111111111111111111111', 'Sysvar1nstructions1111111111111111111111111'])
/**
 * LOCAL_REAL_PROGRAM_SIMULATION with EXACT accounting: real program ELFs + real accounts (one getMultipleAccounts for all instruction keys when they fit in 100),
 * synthetic user balances (labelled), execution in LiteSVM, token/lamport deltas measured before/after. NOT a mainnet result.
 */
export async function localProbe(rpc: RpcClient | null, adapters: Record<AdapterId, PoolAdapter>, c: Circuit, ev: CircuitEval, cost: CostConfig, opts: { fundLamports?: bigint; extraAccounts?: RawAccount[]; programIds?: PublicKey[]; bundle?: AccountBundle; programDirs?: string[] } = {}): Promise<LocalProbeEvidence> {
  const t0 = monoMs()
  const user = PublicKey.unique()
  const ua = userAccountsFor(user, c)
  const svm = new LocalSvm({ sigverify: false })
  const programs = withDependencies(new Set<string>([c.poolA.programId.toBase58(), c.poolB.programId.toBase58(), ...(opts.programIds ?? []).map(p => p.toBase58())]))
  const direct = buildDirectCircuitTx(adapters, c, ev, ua, svm.svm.latestBlockhash(), cost)
  // collect every key referenced by both swap instructions (+ their program ids) except user-owned synthetic accounts, programs we load, sysvars, well-known programs
  const skip = new Set([user.toBase58(), ua.baseAta.toBase58(), ua.interAta.toBase58(), SYSTEM_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'ComputeBudget111111111111111111111111111111', ...SYSVARS])
  const keys: PublicKey[] = []
  for (const ix of [direct.ixA, direct.ixB]) { programs.add(ix.programId.toBase58()); for (const k of ix.keys) if (!skip.has(k.pubkey.toBase58()) && !programs.has(k.pubkey.toBase58()) && !keys.some(x => x.equals(k.pubkey))) keys.push(k.pubkey) }
  for (const p of programs) { const dump = await loadProgramCached(rpc, new PublicKey(p), opts.programDirs); svm.addProgram(dump) }
  const fetched = await fetchOrBundle(rpc, keys, opts.bundle)
  const missing = fetched.missing.map(m => m.toBase58())
  for (const a of fetched.bundle.accounts.values()) svm.setRaw(a)
  for (const a of opts.extraAccounts ?? []) svm.setRaw(a)
  svm.setClock(fetched.bundle.maxSlot, Math.floor(Date.now() / 1000))   // time-gated programs (Raydium open_time, Token-2022 fee epochs) see the snapshot's time
  // synthetic user: SOL for fees/rent + WSOL ATA holding amountIn + rent; empty intermediate ATA is created by the tx (idempotent ix) so rent is measured
  const fund = opts.fundLamports ?? 50_000_000n
  svm.fundSystemAccount(user, fund, 'synthetic user')
  svm.fundTokenAccount(ua.baseAta, WSOL_MINT, user, ev.amountIn, TOKEN_PROGRAM_ID, 'synthetic WSOL ATA', true)
  let tx = direct.built.tx; let usedAlt = false
  if (!direct.built.inspection.withinSizeLimit) {
    // LOCAL ONLY: fabricate an address lookup table so the oversized message fits (a mainnet ALT would have to be created by a transaction)
    const lookup = [...new Map([direct.ixA, direct.ixB].flatMap(ix => ix.keys).filter(k => !k.isSigner).map(k => [k.pubkey.toBase58(), k.pubkey])).values()]
    const alt = svm.fabricateAlt(lookup)
    const ixs = [...computeBudgetIxs(cost.computeUnitLimit, cost.computeUnitPriceMicroLamports), createAtaIdempotentIx(ua.user, ua.interAta, ua.user, c.token, ua.interTokenProgram), direct.ixA, direct.ixB]
    tx = buildV0(ua.user, svm.svm.latestBlockhash(), ixs, [alt]).tx; usedAlt = true
  }
  const before = { base: svm.tokenAmount(ua.baseAta) ?? 0n, inter: svm.tokenAmount(ua.interAta) ?? 0n, lamports: svm.getAccount(user)?.lamports ?? 0n }
  const r = svm.execute(tx)
  const after = { base: svm.tokenAmount(ua.baseAta) ?? 0n, inter: svm.tokenAmount(ua.interAta) ?? 0n, lamports: svm.getAccount(user)?.lamports ?? 0n }
  const quoted = { amountIn: ev.amountIn, amountOut: ev.quoteB.amountOutToUser, pnl: ev.pnl.pnl }
  const deltas = r.ok ? { baseAta: after.base - before.base, interAta: after.inter - before.inter, userLamports: after.lamports - before.lamports } : null
  const realised = deltas ? { pnl: deltas.baseAta, matchesQuote: deltas.baseAta === quoted.pnl && deltas.interAta === 0n } : null
  const notes: string[] = []
  // LiteSVM charges base fee (5000/signature) + prioritization fee (ceil(cu_limit*cu_price/1e6)); the remainder of the user's lamport delta is rent for accounts created in the tx
  const prio = (BigInt(cost.computeUnitLimit) * BigInt(cost.computeUnitPriceMicroLamports) + 999_999n) / 1_000_000n
  const spent = deltas ? -deltas.userLamports : 0n
  const rentPaid = deltas ? spent - 5000n - prio : 0n
  if (deltas && deltas.interAta !== 0n) notes.push(`INTERMEDIATE_INVENTORY_LEFT=${deltas.interAta} (direct tx codes leg B amount = quoted A output)`)
  if (usedAlt) notes.push('USED_FABRICATED_ALT (local only): direct tx exceeded 1232 bytes')
  const ext = externalCosts({ baseFeeLamports: BigInt(cost.baseFeeLamportsPerSignature), signatures: 1, computeUnitLimit: cost.computeUnitLimit, computeUnitPriceMicroLamports: cost.computeUnitPriceMicroLamports, jitoTipLamports: BigInt(cost.jitoTipLamports), nonRecoverableRentLamports: 0n, recoverableRentLamports: rentPaid > 0n ? rentPaid : 0n })
  if (deltas) { for (const c0 of ext.costs) c0.status = 'OBSERVED'; ext.costs.push({ name: 'rent_for_accounts_created_in_tx', unit: 'lamports', amount: rentPaid, status: 'OBSERVED', source: `LiteSVM user lamport delta ${spent} minus base fee 5000 minus prioritization fee ${prio}`, note: 'locked capital, recoverable only after CloseAccount; PumpSwap user_volume_accumulator rent (1,844,400) is NOT recoverable' }); notes.push(`OBSERVED_LAMPORTS_SPENT=${spent} (base 5000 + priority ${prio} + rent ${rentPaid})`) }
  const pnlTx = transactionPnl(tradingPnl(WSOL_MINT, ev.quoteA, ev.quoteB), ext, r.ok ? [] : ['EXECUTION_FAILED'])
  return { level: 'LOCAL_REAL_PROGRAM_SIMULATION', environment: 'LOCAL_REAL_PROGRAM_SIMULATION', ok: r.ok, err: r.err, logs: r.logs, unitsConsumed: r.unitsConsumed, deltas, balances: { before: { baseAta: before.base, interAta: before.inter, userLamports: before.lamports }, after: { baseAta: after.base, interAta: after.inter, userLamports: after.lamports } }, quoted, realised, synthetic: svm.synthetic.map(s => ({ pubkey: s.pubkey.toBase58(), note: s.note })), loadedPrograms: svm.loadedPrograms, accountsLoaded: fetched.bundle.accounts.size, accountsMissingOnChain: missing, snapshot: { minSlot: fetched.bundle.minSlot, maxSlot: fetched.bundle.maxSlot, singleBatch: fetched.bundle.singleBatch }, accounting: { status: pnlTx.status, pnlAfterExternal: realised ? realised.pnl - ext.total : pnlTx.pnlAfterExternal, externalCosts: pnlTx.externalCosts, locked: pnlTx.lockedCapital, notes }, durationMs: monoMs() - t0 }
}
export function quoteSummary(q: Quote): Record<string, unknown> {
  return { adapter: q.adapter, pool: q.pool.toBase58(), in: q.amountIn, out: q.amountOutToUser, fees: q.fees.map(f => `${f.name}=${f.amount}`), impactBps: q.priceImpactBps, slot: q.contextSlot, rejects: q.rejectReasons }
}
export const ACCOUNT_SIZE_TOKEN = ACCOUNT_SIZE

import { buildExecuteCircuitIx, legFromInstruction, LEG_KIND, ARB_EXECUTOR_LOCAL_PROGRAM_ID, ARB_EXECUTOR_SO_PATH, parseCustomErrorCode, executorErrorName, type ExecutorLeg } from './executor_ix.js'
import { readFileSync as readFileSyncFs, existsSync as existsSyncFs } from 'node:fs'
export interface ExecutorProbeEvidence {
  level: EvidenceLevel; environment: 'LOCAL_REAL_PROGRAM_SIMULATION'; guard: 'ARB_EXECUTOR_LOCAL'
  executorSha256: string; executorBytes: number
  runs: { minProfit: bigint; ok: boolean; err: string | null; executorError: string | null; unitsConsumed: bigint; deltas: { baseAta: bigint; interAta: bigint; userLamports: bigint } | null; logsTail: string[] }[]
  quoted: { amountIn: bigint; pnl: bigint }
  txBytes: number; usedAlt: boolean; synthetic: number; accountsLoaded: number; accountsMissingOnChain: string[]; snapshot: { minSlot: number; maxSlot: number; singleBatch: boolean }
  verdict: string; durationMs: number
}
/**
 * LOCAL_REAL_PROGRAM_SIMULATION through the Rust executor (arb_executor.so built locally, NEVER deployed): real DEX ELFs + real accounts + synthetic user.
 * Leg B is sized on-chain from the realised leg-A delta; the guard requires base_after >= base_before + min_profit and no leftover intermediate inventory.
 * Two runs: min_profit = 0 (does the circuit even break even after DEX fees?) and min_profit = quoted trading pnl (is the quote reproduced exactly?).
 */
export async function localProbeExecutor(rpc: RpcClient | null, adapters: Record<AdapterId, PoolAdapter>, c: Circuit, ev: CircuitEval, cost: CostConfig, opts: { minProfits?: bigint[]; bundle?: AccountBundle; programDirs?: string[] } = {}): Promise<ExecutorProbeEvidence> {
  const t0 = monoMs()
  if (!existsSyncFs(ARB_EXECUTOR_SO_PATH)) throw new Error(`EXECUTOR_NOT_BUILT: ${ARB_EXECUTOR_SO_PATH} missing (run scripts/build_executor.sh)`)
  const elf = new Uint8Array(readFileSyncFs(ARB_EXECUTOR_SO_PATH))
  const user = PublicKey.unique(); const ua = userAccountsFor(user, c)
  const A = adapters[c.poolA.adapter], B = adapters[c.poolB.adapter]
  const a = A.buildSwapInstruction(c.poolA, { user, userInputAccount: ua.baseAta, userOutputAccount: ua.interAta, amountIn: ev.quoteA.amountIn, minimumAmountOut: 0n })
  if (isUnsupported(a)) throw new Error(`LEG_A_BUILD_${a.code}: ${a.reason}`)
  const b = B.buildSwapInstruction(c.poolB, { user, userInputAccount: ua.interAta, userOutputAccount: ua.baseAta, amountIn: ev.quoteA.amountOutToUser, minimumAmountOut: 0n })
  if (isUnsupported(b)) throw new Error(`LEG_B_BUILD_${b.code}: ${b.reason}`)
  const legA: ExecutorLeg = legFromInstruction(c.poolA.adapter === 'raydium_cpmm' ? LEG_KIND.RAYDIUM_CPMM_SWAP_BASE_INPUT : LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN, a.instruction)
  const legB: ExecutorLeg = legFromInstruction(c.poolB.adapter === 'raydium_cpmm' ? LEG_KIND.RAYDIUM_CPMM_SWAP_BASE_INPUT : LEG_KIND.PUMPSWAP_SELL, b.instruction)
  // accounts to load: every key of both DEX instructions (minus user/synthetic/programs/sysvars)
  const programs = withDependencies(new Set<string>([c.poolA.programId.toBase58(), c.poolB.programId.toBase58(), a.instruction.programId.toBase58(), b.instruction.programId.toBase58()]))
  const skip = new Set([user.toBase58(), ua.baseAta.toBase58(), ua.interAta.toBase58(), SYSTEM_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'ComputeBudget111111111111111111111111111111', ...SYSVARS])
  const keys: PublicKey[] = []
  for (const ix of [a.instruction, b.instruction]) for (const k of ix.keys) if (!skip.has(k.pubkey.toBase58()) && !programs.has(k.pubkey.toBase58()) && !keys.some(x => x.equals(k.pubkey))) keys.push(k.pubkey)
  const fetched = await fetchOrBundle(rpc, keys, opts.bundle)
  const minProfits = opts.minProfits ?? [0n, ...(ev.pnl.pnl > 0n ? [ev.pnl.pnl] : [])]
  const runs: ExecutorProbeEvidence['runs'] = []
  let txBytes = 0; let usedAlt = false; let syntheticCount = 0
  for (const minProfit of minProfits) {
    const svm = new LocalSvm({ sigverify: false })
    for (const p of programs) svm.addProgram(await loadProgramCached(rpc, new PublicKey(p), opts.programDirs))
    svm.addProgram({ programId: ARB_EXECUTOR_LOCAL_PROGRAM_ID, elf, programDataAddress: null, slot: 0, loader: 'upgradeable' })
    for (const acc of fetched.bundle.accounts.values()) svm.setRaw(acc)
    svm.setClock(fetched.bundle.maxSlot, Math.floor(Date.now() / 1000))
    svm.fundSystemAccount(user, 50_000_000n, 'synthetic user')
    svm.fundTokenAccount(ua.baseAta, WSOL_MINT, user, ev.amountIn, TOKEN_PROGRAM_ID, 'synthetic WSOL ATA', true)
    // Leg minimums in this probe: leg A = the quoted output (tight, because the SVM replays the exact snapshot state), leg B = 1 lamport so the ONLY
    // economic gate is the executor's own guard (base_after >= base_before + min_profit). A live deployment would add a margin to leg A's minimum,
    // because between the snapshot and landing the pool can move; that margin is a policy choice, not part of the measurement.
    const exIx = buildExecuteCircuitIx({ user: { user, userBaseTokenAccount: ua.baseAta, userIntermediateTokenAccount: ua.interAta, baseMint: WSOL_MINT, intermediateMint: c.token, baseTokenProgram: ua.baseTokenProgram, intermediateTokenProgram: ua.interTokenProgram }, params: { amountIn: ev.amountIn, minProfit, legAMinOut: ev.quoteA.amountOutToUser, legBMinOut: 1n, maxLamportsSpend: 10_000_000n }, legA, legB })   // allowance covers rent for accounts the DEXes create (PumpSwap user_volume_accumulator ~1,844,400)
    const ixs = [...computeBudgetIxs(cost.computeUnitLimit, cost.computeUnitPriceMicroLamports), createAtaIdempotentIx(user, ua.interAta, user, c.token, ua.interTokenProgram), exIx]
    const lookup = [...new Map(exIx.keys.filter(k => !k.isSigner).map(k => [k.pubkey.toBase58(), k.pubkey])).values()]
    let built = buildV0(user, svm.svm.latestBlockhash(), ixs)
    if (!built.inspection.withinSizeLimit) { const alt = svm.fabricateAlt(lookup); built = buildV0(user, svm.svm.latestBlockhash(), ixs, [alt]); usedAlt = true }
    txBytes = built.serializedBytes
    const before = { base: svm.tokenAmount(ua.baseAta) ?? 0n, inter: svm.tokenAmount(ua.interAta) ?? 0n, lamports: svm.getAccount(user)?.lamports ?? 0n }
    const r = svm.execute(built.tx)
    const after = { base: svm.tokenAmount(ua.baseAta) ?? 0n, inter: svm.tokenAmount(ua.interAta) ?? 0n, lamports: svm.getAccount(user)?.lamports ?? 0n }
    const code = r.ok ? null : parseCustomErrorCode(r.err + ' ' + r.logs.join(' '))
    runs.push({ minProfit, ok: r.ok, err: r.err, executorError: code !== null && code < 6000 ? executorErrorName(code) : (code !== null ? `DEX_CUSTOM(${code})` : null), unitsConsumed: r.unitsConsumed, deltas: r.ok ? { baseAta: after.base - before.base, interAta: after.inter - before.inter, userLamports: after.lamports - before.lamports } : null, logsTail: r.logs.filter(l => /arb_executor|Error|error|failed/.test(l)).slice(-8) })
    syntheticCount = svm.synthetic.length
  }
  const first = runs[0]!
  const verdict = first.ok ? (runs.length > 1 && runs[1]!.ok ? 'GUARD_PASSED_AT_QUOTED_PROFIT (quote reproduced on-chain locally)' : 'BREAK_EVEN_OR_BETTER_AT_MIN_PROFIT_0') : (first.executorError === 'ProfitBelowMin' ? 'GUARD_REVERTED_LOSING_CIRCUIT (executor guard works; circuit loses after DEX fees)' : `FAILED: ${first.executorError ?? first.err}`)
  return { level: 'LOCAL_REAL_PROGRAM_SIMULATION', environment: 'LOCAL_REAL_PROGRAM_SIMULATION', guard: 'ARB_EXECUTOR_LOCAL', executorSha256: sha256Hex(elf), executorBytes: elf.length, runs, quoted: { amountIn: ev.amountIn, pnl: ev.pnl.pnl }, txBytes, usedAlt, synthetic: syntheticCount, accountsLoaded: fetched.bundle.accounts.size, accountsMissingOnChain: fetched.missing.map(m => m.toBase58()), snapshot: { minSlot: fetched.bundle.minSlot, maxSlot: fetched.bundle.maxSlot, singleBatch: fetched.bundle.singleBatch }, verdict, durationMs: monoMs() - t0 }
}
