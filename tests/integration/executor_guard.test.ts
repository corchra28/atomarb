/**
 * arb_executor rejection paths, executed by the REAL compiled program (tests/fixtures/programs/arb_executor.so) inside LiteSVM.
 * No DEX program is loaded: every path below is rejected by the executor's own validation BEFORE any CPI, except the two
 * "reaches the CPI" cases which prove that fully consistent segments pass validation and fail only at `invoke` (no callee loaded).
 * All accounts are fabricated locally (LOCAL ONLY; see LocalSvm.synthetic). No network. Deterministic.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { Keypair, PublicKey, AddressLookupTableAccount, type AccountMeta } from '@solana/web3.js'
import { writeU32LE, writeU64LE } from '../../src/util/bytes.js'
import { LocalSvm } from '../../src/simulation/local_svm.js'
import { buildV0 } from '../../src/simulation/tx_build.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WSOL_MINT, SYSTEM_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '../../src/state/token.js'
import type { RawAccount } from '../../src/adapters/types.js'
import {
  ARB_EXECUTOR_LOCAL_PROGRAM_ID, ARB_EXECUTOR_SO_PATH, LEG_KIND, EXECUTOR_ERROR_CODE, EXECUTOR_ERRORS, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_CPMM_AUTHORITY,
  PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_GLOBAL_CONFIG, buildExecuteCircuitIx, encodeExecuteCircuitData, decodeExecuteCircuitData, parseCustomErrorCode, executorErrorName,
  type ExecutorLeg, type ExecutorUserAccounts, type ExecuteCircuitParams, type BuildExecuteCircuitOpts,
} from '../../src/simulation/executor_ix.js'

const SO = ARB_EXECUTOR_SO_PATH
const haveSo = existsSync(SO)
if (!haveSo) console.warn(`[executor_guard] ${SO} missing — run scripts/build_executor.sh; suite skipped`)

// ---- constants from the source notes (pumpswap.md §1/§2, raydium_cpmm.md §2) -----------------------------------------------
const PUMP_EVENT_AUTHORITY = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR')
const PUMP_FEE_CONFIG = new PublicKey('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx')
const RAYDIUM_POOL_DISC = Buffer.from('f7ede3f5d7c3de46', 'hex')
const PUMP_POOL_DISC = Buffer.from('f19a6d0411b16dbc', 'hex')

const kp = () => Keypair.generate().publicKey
function raw(pubkey: PublicKey, owner: PublicKey, data: Uint8Array, lamports = 10_000_000n): RawAccount {
  return { pubkey, owner, data, lamports, executable: false, contextSlot: 0, receivedAtUtc: '1970-01-01T00:00:00.000Z', receivedMonoMs: 0, batchId: 'fabricated', provider: 'litesvm' }
}
function mintBytes(): Uint8Array { const b = new Uint8Array(82); b[44] = 9; b[45] = 1; return b }
function raydiumPoolBytes(f: { ammConfig: PublicKey; vault0: PublicKey; vault1: PublicKey; mint0: PublicKey; mint1: PublicKey; prog0: PublicKey; prog1: PublicKey; observation: PublicKey }): Uint8Array {
  const d = new Uint8Array(637); d.set(RAYDIUM_POOL_DISC, 0)
  d.set(f.ammConfig.toBytes(), 8); d.set(f.vault0.toBytes(), 72); d.set(f.vault1.toBytes(), 104); d.set(f.mint0.toBytes(), 168); d.set(f.mint1.toBytes(), 200)
  d.set(f.prog0.toBytes(), 232); d.set(f.prog1.toBytes(), 264); d.set(f.observation.toBytes(), 296)
  return d
}
function pumpPoolBytes(f: { baseMint: PublicKey; quoteMint: PublicKey; poolBaseTa: PublicKey; poolQuoteTa: PublicKey }, len = 300): Uint8Array {
  const d = new Uint8Array(len); d.set(PUMP_POOL_DISC, 0)
  d.set(f.baseMint.toBytes(), 43); d.set(f.quoteMint.toBytes(), 75); d.set(f.poolBaseTa.toBytes(), 139); d.set(f.poolQuoteTa.toBytes(), 171)
  return d
}
const m = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner })

/** ALT program id — docs/sources/solana_rpc_tx_fees.md §5 "ALT rules". */
const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = new PublicKey('AddressLookupTab1e1111111111111111111111111')
/**
 * Fabricates an ACTIVE address lookup table holding `addresses` (LOCAL ONLY). Byte layout per solana_rpc_tx_fees.md §5
 * "ALT account byte layout": u32 tag=1 (ProgramState::LookupTable) | deactivation_slot u64 = u64::MAX (Activated) | last_extended_slot u64 = 0
 * (< current slot, so every address is active) | last_extended_slot_start_index u8 | authority Option tag 0 (None) | _padding u16 | zero to 56 | addresses × 32.
 * A mainnet Raydium+PumpSwap circuit does not fit in 1232 bytes without an ALT, so the tests exercise the same path.
 */
function fabricateAlt(svm: LocalSvm, addresses: PublicKey[]): AddressLookupTableAccount {
  if (addresses.length === 0 || addresses.length > 256) throw new Error(`ALT needs 1..256 addresses, got ${addresses.length}`)
  const key = kp()
  const data = new Uint8Array(56 + 32 * addresses.length)
  data.set(writeU32LE(1), 0); data.set(writeU64LE(2n ** 64n - 1n), 4); data.set(writeU64LE(0n), 12); data[20] = 0; data[21] = 0
  addresses.forEach((a, i) => data.set(a.toBytes(), 56 + 32 * i))
  svm.setRaw(raw(key, ADDRESS_LOOKUP_TABLE_PROGRAM_ID, data))
  svm.synthetic.push({ pubkey: key, note: `fabricated ALT with ${addresses.length} addresses` })
  return new AddressLookupTableAccount({ key, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses } })
}

interface World {
  svm: LocalSvm; user: PublicKey; interMint: PublicKey; ua: ExecutorUserAccounts
  raydium: { pool: PublicKey; ammConfig: PublicKey; vault0: PublicKey; vault1: PublicKey; observation: PublicKey }
  pump: { pool: PublicKey; poolBaseTa: PublicKey; poolQuoteTa: PublicKey }
}
/** Fresh SVM with the executor loaded, a funded user, WSOL + Token-2022 intermediate ATAs, and one fabricated pool per DEX. */
function world(opts: { baseAmount?: bigint; interAmount?: bigint; raydiumPoolOwner?: PublicKey } = {}): World {
  const svm = new LocalSvm()
  svm.addProgram({ programId: ARB_EXECUTOR_LOCAL_PROGRAM_ID, elf: new Uint8Array(readFileSync(SO)), programDataAddress: null, slot: 0, loader: 'upgradeable' })
  const user = kp(); svm.fundSystemAccount(user, 1_000_000_000n, 'test user')
  const interMint = kp()
  svm.setRaw(raw(WSOL_MINT, TOKEN_PROGRAM_ID, mintBytes()))
  svm.setRaw(raw(interMint, TOKEN_2022_PROGRAM_ID, mintBytes()))
  const baseTa = kp(), interTa = kp()
  svm.fundTokenAccount(baseTa, WSOL_MINT, user, opts.baseAmount ?? 5_000_000_000n, TOKEN_PROGRAM_ID, 'user WSOL', true)
  svm.fundTokenAccount(interTa, interMint, user, opts.interAmount ?? 0n, TOKEN_2022_PROGRAM_ID, 'user intermediate')
  const ua: ExecutorUserAccounts = { user, userBaseTokenAccount: baseTa, userIntermediateTokenAccount: interTa, baseMint: WSOL_MINT, intermediateMint: interMint, baseTokenProgram: TOKEN_PROGRAM_ID, intermediateTokenProgram: TOKEN_2022_PROGRAM_ID }
  // Raydium pool: token_0 = WSOL (Token), token_1 = intermediate (Token-2022)
  const raydium = { pool: kp(), ammConfig: kp(), vault0: kp(), vault1: kp(), observation: kp() }
  svm.setRaw(raw(raydium.pool, opts.raydiumPoolOwner ?? RAYDIUM_CPMM_PROGRAM_ID, raydiumPoolBytes({ ...raydium, mint0: WSOL_MINT, mint1: interMint, prog0: TOKEN_PROGRAM_ID, prog1: TOKEN_2022_PROGRAM_ID })))
  // PumpSwap pool: base = intermediate, quote = WSOL
  const pump = { pool: kp(), poolBaseTa: kp(), poolQuoteTa: kp() }
  svm.setRaw(raw(pump.pool, PUMP_AMM_PROGRAM_ID, pumpPoolBytes({ baseMint: interMint, quoteMint: WSOL_MINT, ...pump })))
  return { svm, user, interMint, ua, raydium, pump }
}
/** Raydium `Swap` accounts (raydium_cpmm.md §6) for leg A (base->inter) or B (inter->base). */
function raydiumLeg(w: World, role: 'A' | 'B'): ExecutorLeg {
  const { ua, raydium: r } = w
  const [inTa, outTa, inV, outV, inP, outP, inM, outM] = role === 'A'
    ? [ua.userBaseTokenAccount, ua.userIntermediateTokenAccount, r.vault0, r.vault1, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WSOL_MINT, w.interMint]
    : [ua.userIntermediateTokenAccount, ua.userBaseTokenAccount, r.vault1, r.vault0, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, w.interMint, WSOL_MINT]
  return { kind: LEG_KIND.RAYDIUM_CPMM_SWAP_BASE_INPUT, programId: RAYDIUM_CPMM_PROGRAM_ID, accounts: [
    m(ua.user, false, true), m(RAYDIUM_CPMM_AUTHORITY), m(r.ammConfig), m(r.pool, true), m(inTa, true), m(outTa, true), m(inV, true), m(outV, true), m(inP), m(outP), m(inM), m(outM), m(r.observation, true)] }
}
/** PumpSwap buy_exact_quote_in (23 named) / sell (21 named) accounts (pumpswap.md §6) + `extra` remaining accounts. */
function pumpLeg(w: World, kind: typeof LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN | typeof LEG_KIND.PUMPSWAP_SELL, extra = 3): ExecutorLeg {
  const { ua, pump: p } = w
  const accounts: AccountMeta[] = [
    m(p.pool, true), m(ua.user, true, true), m(PUMP_GLOBAL_CONFIG), m(w.interMint), m(WSOL_MINT), m(ua.userIntermediateTokenAccount, true), m(ua.userBaseTokenAccount, true),
    m(p.poolBaseTa, true), m(p.poolQuoteTa, true), m(kp()), m(kp(), true), m(TOKEN_2022_PROGRAM_ID), m(TOKEN_PROGRAM_ID), m(SYSTEM_PROGRAM_ID), m(ASSOCIATED_TOKEN_PROGRAM_ID),
    m(PUMP_EVENT_AUTHORITY), m(PUMP_AMM_PROGRAM_ID), m(kp(), true), m(kp())]
  if (kind === LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN) accounts.push(m(kp()), m(kp(), true))
  accounts.push(m(PUMP_FEE_CONFIG), m(PUMP_FEE_PROGRAM_ID))
  for (let i = 0; i < extra; i++) accounts.push(m(kp()))
  return { kind, programId: PUMP_AMM_PROGRAM_ID, accounts }
}
const params = (over: Partial<ExecuteCircuitParams> = {}): ExecuteCircuitParams => ({ amountIn: 1_000_000_000n, minProfit: 1n, legAMinOut: 1n, legBMinOut: 1n, ...over })

interface Run { ok: boolean; code: number | null; name: string; err: string | null; logs: string[] }
function run(w: World, o: Omit<BuildExecuteCircuitOpts, 'user'> & { user?: ExecutorUserAccounts; payer?: PublicKey; noAlt?: boolean; mutate?: (ix: ReturnType<typeof buildExecuteCircuitIx>) => void }): Run {
  const ix = buildExecuteCircuitIx({ skipChecks: true, ...o, user: o.user ?? w.ua })
  o.mutate?.(ix)
  const signers = new Set(ix.keys.filter(k => k.isSigner).map(k => k.pubkey.toBase58()))
  const lookup = [...new Map(ix.keys.filter(k => !signers.has(k.pubkey.toBase58())).map(k => [k.pubkey.toBase58(), k.pubkey])).values()]
  const alts = o.noAlt || lookup.length === 0 ? [] : [fabricateAlt(w.svm, lookup)]
  const built = buildV0(o.payer ?? w.user, w.svm.svm.latestBlockhash(), [ix], alts)
  const r = w.svm.execute(built.tx)
  const code = parseCustomErrorCode(`${r.err ?? ''}\n${r.logs.join('\n')}`)
  return { ok: r.ok, code, name: code === null ? 'none' : executorErrorName(code), err: r.err, logs: r.logs }
}
function expectCode(r: Run, name: keyof typeof EXECUTOR_ERROR_CODE): void {
  expect(r.ok, `expected failure ${name}; logs:\n${r.logs.join('\n')}`).toBe(false)
  expect(`${r.code}:${r.name}`, `err=${r.err}\nlogs:\n${r.logs.join('\n')}`).toBe(`${EXECUTOR_ERROR_CODE[name]}:${name}`)
}

describe.skipIf(!haveSo)('arb_executor guard (real ELF in LiteSVM, no DEX loaded)', () => {
  it('error table is contiguous 1..37 and the data codec round-trips (ABI v2, 45 bytes)', () => {
    expect(EXECUTOR_ERRORS.map(e => e.code)).toEqual(Array.from({ length: 37 }, (_, i) => i + 1))
    const d = encodeExecuteCircuitData(params({ amountIn: 0x0102030405060708n, minProfit: 2n ** 64n - 1n, maxLamportsSpend: 1_844_400n }), 1, 24, 2, 22)
    expect(d.length).toBe(45); expect(Buffer.from(d.subarray(1, 9)).toString('hex')).toBe('0807060504030201')
    expect(decodeExecuteCircuitData(d)).toEqual({ amountIn: 0x0102030405060708n, minProfit: 2n ** 64n - 1n, legAMinOut: 1n, legBMinOut: 1n, legAKind: 1, legAAccountCount: 24, legBKind: 2, legBAccountCount: 22, maxLamportsSpend: 1_844_400n })
  })
  it('(a) wrong data length -> InvalidDataLength; wrong tag -> InvalidTag', () => {
    const w = world(); const legA = raydiumLeg(w, 'A'), legB = raydiumLeg(w, 'B')
    const good = encodeExecuteCircuitData(params(), 0, 14, 0, 14)
    expectCode(run(w, { params: params(), legA, legB, dataOverride: good.subarray(0, 36) }), 'InvalidDataLength')
    expectCode(run(w, { params: params(), legA, legB, dataOverride: new Uint8Array([...good, 0]) }), 'InvalidDataLength')
    expectCode(run(w, { params: params(), legA, legB, dataOverride: new Uint8Array([0]) }), 'InvalidDataLength')
    expectCode(run(w, { params: params(), legA, legB, dataOverride: new Uint8Array(0) }), 'InvalidDataLength')
    const badTag = new Uint8Array(good); badTag[0] = 1
    expectCode(run(w, { params: params(), legA, legB, dataOverride: badTag }), 'InvalidTag')
  })
  it('(b) leg with a disallowed program id -> LegProgramNotAllowlisted', () => {
    const w = world(); const legB = raydiumLeg(w, 'B')
    expectCode(run(w, { params: params(), legA: { ...raydiumLeg(w, 'A'), programId: kp() }, legB }), 'LegProgramNotAllowlisted')
    // right program for the wrong kind (PumpSwap program declared as kind 0) is also not allowlisted
    expectCode(run(w, { params: params(), legA: { ...raydiumLeg(w, 'A'), programId: PUMP_AMM_PROGRAM_ID }, legB }), 'LegProgramNotAllowlisted')
    expectCode(run(w, { params: params(), legA: raydiumLeg(w, 'A'), legB: { ...pumpLeg(w, LEG_KIND.PUMPSWAP_SELL), programId: RAYDIUM_CPMM_PROGRAM_ID } }), 'LegProgramNotAllowlisted')
  })
  it('(c) pool account owned by the wrong program -> PoolOwnerMismatch', () => {
    const w = world({ raydiumPoolOwner: PUMP_AMM_PROGRAM_ID })
    expectCode(run(w, { params: params(), legA: raydiumLeg(w, 'A'), legB: raydiumLeg(w, 'B') }), 'PoolOwnerMismatch')
    const w2 = world(); w2.svm.setRaw(raw(w2.pump.pool, kp(), pumpPoolBytes({ baseMint: w2.interMint, quoteMint: WSOL_MINT, ...w2.pump })))
    expectCode(run(w2, { params: params(), legA: pumpLeg(w2, LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN), legB: raydiumLeg(w2, 'B') }), 'PoolOwnerMismatch')
  })
  it('(d) aliasing: a user token account anywhere but its user position -> Aliasing', () => {
    const w = world(); const legB = raydiumLeg(w, 'B')
    const asVault = raydiumLeg(w, 'A'); asVault.accounts[6] = m(w.ua.userBaseTokenAccount, true)
    expectCode(run(w, { params: params(), legA: asVault, legB }), 'Aliasing')
    const asObs = raydiumLeg(w, 'A'); asObs.accounts[12] = m(w.ua.userIntermediateTokenAccount, true)
    expectCode(run(w, { params: params(), legA: asObs, legB }), 'Aliasing')
    const swapped = raydiumLeg(w, 'A'); const t = swapped.accounts[4]!; swapped.accounts[4] = swapped.accounts[5]!; swapped.accounts[5] = t
    expectCode(run(w, { params: params(), legA: swapped, legB }), 'Aliasing')
    const pumpRem = pumpLeg(w, LEG_KIND.PUMPSWAP_SELL); pumpRem.accounts[23] = m(w.ua.userBaseTokenAccount, true)
    expectCode(run(w, { params: params(), legA: raydiumLeg(w, 'A'), legB: pumpRem }), 'Aliasing')
    const pumpFee = pumpLeg(w, LEG_KIND.PUMPSWAP_SELL); pumpFee.accounts[10] = m(w.ua.userIntermediateTokenAccount, true)
    expectCode(run(w, { params: params(), legA: raydiumLeg(w, 'A'), legB: pumpFee }), 'Aliasing')
    // accounts[1] == accounts[2] is now checked BEFORE the per-account validation, so the branch is reachable (review finding: it used to be dead code)
    expectCode(run(w, { params: params(), legA: raydiumLeg(w, 'A'), legB, user: { ...w.ua, userIntermediateTokenAccount: w.ua.userBaseTokenAccount, intermediateMint: WSOL_MINT, intermediateTokenProgram: TOKEN_PROGRAM_ID } }), 'Aliasing')
    expectCode(run(w, { params: params(), legA: raydiumLeg(w, 'A'), legB, user: { ...w.ua, userIntermediateTokenAccount: w.ua.userBaseTokenAccount, intermediateMint: kp(), intermediateTokenProgram: TOKEN_PROGRAM_ID } }), 'Aliasing')
  })
  it('(new in ABI v2) base mint must be WSOL, a PumpSwap buy needs min_out >= 1, and a non-token-account is refused', () => {
    const w = world(); const legA = raydiumLeg(w, 'A'), legB = raydiumLeg(w, 'B')
    // 35: the guard certifies profit in accounts[3]; anything but WSOL would certify the wrong token
    const otherBase = kp(); w.svm.setRaw(raw(otherBase, TOKEN_PROGRAM_ID, mintBytes()))
    const otherBaseTa = kp(); w.svm.fundTokenAccount(otherBaseTa, otherBase, w.user, 5_000_000_000n, TOKEN_PROGRAM_ID, 'user other-base ATA')
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, baseMint: otherBase, userBaseTokenAccount: otherBaseTa } }), 'BaseMintNotWsol')
    // 36: pump_amm rejects min_base_amount_out == 0 with 6001; we refuse before burning the CPI
    expectCode(run(w, { params: params({ legAMinOut: 0n }), legA: pumpLeg(w, LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN), legB }), 'ZeroMinOutForPumpBuy')
    // 37: a Token-program-owned blob that merely looks like a token account (e.g. the 355-byte multisig size) must not be read as a balance
    const fake = kp()
    const blob = new Uint8Array(355); blob.set(WSOL_MINT.toBytes(), 0); blob.set(w.user.toBytes(), 32); blob.set(writeU64LE(1_000_000_000_000n), 64); blob[108] = 1
    w.svm.setRaw(raw(fake, TOKEN_PROGRAM_ID, blob))
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, userBaseTokenAccount: fake } }), 'TokenAccountTypeInvalid')
  })
  it('fixed-account checks: signer, counts, token programs, owners, mints, balances', () => {
    const w = world(); const legA = raydiumLeg(w, 'A'), legB = raydiumLeg(w, 'B')
    // user not a signer (a different fee payer signs)
    const payer = kp(); w.svm.fundSystemAccount(payer, 1_000_000_000n, 'other payer')
    expectCode(run(w, { params: params(), legA, legB, payer, mutate: ix => ix.keys.forEach(k => { if (k.pubkey.equals(w.user)) k.isSigner = false }) }), 'UserNotSigner')
    expectCode(run(w, { params: params(), legA, legB, countOverride: { legA: 15 } }), 'AccountCountMismatch')
    expectCode(run(w, { params: params(), legA, legB, countOverride: { legB: 13 } }), 'AccountCountMismatch')
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, baseTokenProgram: SYSTEM_PROGRAM_ID } }), 'TokenProgramNotAllowed')
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, baseTokenProgram: TOKEN_2022_PROGRAM_ID } }), 'TokenAccountProgramMismatch')
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, baseMint: w.interMint } }), 'SameMint')   // base == intermediate is caught first
    const splMintForT22Ata = kp(); w.svm.setRaw(raw(splMintForT22Ata, TOKEN_PROGRAM_ID, mintBytes()))   // mint owned by SPL Token while the ATA is Token-2022
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, intermediateMint: splMintForT22Ata } }), 'MintProgramMismatch')
    const otherWsol = kp(); w.svm.fundTokenAccount(otherWsol, WSOL_MINT, kp(), 1n, TOKEN_PROGRAM_ID, 'someone else WSOL', true)
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, userBaseTokenAccount: otherWsol } }), 'TokenAccountOwnerMismatch')
    // keep base mint = WSOL (else BaseMintNotWsol fires first) and give the user an ATA of a DIFFERENT mint
    const otherMint = kp(); w.svm.setRaw(raw(otherMint, TOKEN_PROGRAM_ID, mintBytes()))
    const ataOfOtherMint = kp(); w.svm.fundTokenAccount(ataOfOtherMint, otherMint, w.user, 1_000n, TOKEN_PROGRAM_ID, 'user ATA of another mint')
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, userBaseTokenAccount: ataOfOtherMint } }), 'TokenAccountMintMismatch')
    const frozen = kp(); w.svm.fundTokenAccount(frozen, WSOL_MINT, w.user, 1n, TOKEN_PROGRAM_ID, 'frozen', true); const acc = w.svm.getAccount(frozen)!; acc.data[108] = 2; w.svm.setRaw(raw(frozen, TOKEN_PROGRAM_ID, acc.data, acc.lamports))
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, userBaseTokenAccount: frozen } }), 'TokenAccountNotInitialized')
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, userBaseTokenAccount: w.user } }), 'TokenAccountProgramMismatch')
    const sameMintTa = kp(); w.svm.fundTokenAccount(sameMintTa, WSOL_MINT, w.user, 0n, TOKEN_PROGRAM_ID, 'second WSOL', true)
    expectCode(run(w, { params: params(), legA, legB, user: { ...w.ua, userIntermediateTokenAccount: sameMintTa, intermediateMint: WSOL_MINT, intermediateTokenProgram: TOKEN_PROGRAM_ID } }), 'SameMint')
    expectCode(run(w, { params: params({ amountIn: 5_000_000_001n }), legA, legB }), 'InsufficientBaseBalance')
  })
  it('leg-kind and leg-count checks', () => {
    const w = world(); const legA = raydiumLeg(w, 'A'), legB = raydiumLeg(w, 'B')
    expectCode(run(w, { params: params(), legA: { ...legA, kind: 3 as 0 }, legB }), 'LegKindUnknown')
    expectCode(run(w, { params: params(), legA: pumpLeg(w, LEG_KIND.PUMPSWAP_SELL), legB }), 'LegKindInvalidForPosition')
    expectCode(run(w, { params: params(), legA, legB: pumpLeg(w, LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN) }), 'LegKindInvalidForPosition')
    expectCode(run(w, { params: params(), legA: { ...legA, accounts: legA.accounts.slice(0, 12) }, legB }), 'LegAccountCountInvalid')
    expectCode(run(w, { params: params(), legA: { ...legA, accounts: [...legA.accounts, m(kp())] }, legB }), 'LegAccountCountInvalid')
    expectCode(run(w, { params: params(), legA: pumpLeg(w, LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN, 4), legB }), 'LegAccountCountInvalid')
    expectCode(run(w, { params: params(), legA, legB: pumpLeg(w, LEG_KIND.PUMPSWAP_SELL, 4) }), 'LegAccountCountInvalid')
    expectCode(run(w, { params: params(), legA: { ...legA, accounts: [] }, legB }), 'LegAccountCountInvalid')
  })
  it('pool-field checks: layout, vaults, mints, token programs, fixed accounts, global_config, fee_program', () => {
    const w = world(); const legA = raydiumLeg(w, 'A'), legB = raydiumLeg(w, 'B')
    const badDisc = raydiumPoolBytes({ ...w.raydium, mint0: WSOL_MINT, mint1: w.interMint, prog0: TOKEN_PROGRAM_ID, prog1: TOKEN_2022_PROGRAM_ID }); badDisc[0] = (badDisc[0] ?? 0) ^ 1
    const w2 = world(); w2.svm.setRaw(raw(w2.raydium.pool, RAYDIUM_CPMM_PROGRAM_ID, badDisc))
    expectCode(run(w2, { params: params(), legA: raydiumLeg(w2, 'A'), legB: raydiumLeg(w2, 'B') }), 'PoolDataInvalid')
    const w3 = world(); w3.svm.setRaw(raw(w3.raydium.pool, RAYDIUM_CPMM_PROGRAM_ID, raydiumPoolBytes({ ...w3.raydium, mint0: WSOL_MINT, mint1: w3.interMint, prog0: TOKEN_PROGRAM_ID, prog1: TOKEN_2022_PROGRAM_ID }).subarray(0, 636)))
    expectCode(run(w3, { params: params(), legA: raydiumLeg(w3, 'A'), legB: raydiumLeg(w3, 'B') }), 'PoolDataInvalid')
    const mut = (i: number, pk: PublicKey, wr = true): ExecutorLeg => { const l = raydiumLeg(w, 'A'); l.accounts[i] = m(pk, wr); return l }
    expectCode(run(w, { params: params(), legA: mut(6, kp()), legB }), 'LegVaultMismatch')
    expectCode(run(w, { params: params(), legA: mut(7, w.raydium.vault0), legB }), 'LegVaultMismatch')
    expectCode(run(w, { params: params(), legA: mut(10, kp(), false), legB }), 'LegMintMismatch')
    expectCode(run(w, { params: params(), legA: mut(8, TOKEN_2022_PROGRAM_ID, false), legB }), 'LegTokenProgramMismatch')
    expectCode(run(w, { params: params(), legA: mut(1, kp(), false), legB }), 'LegFixedAccountMismatch')
    expectCode(run(w, { params: params(), legA: mut(2, kp(), false), legB }), 'LegFixedAccountMismatch')
    expectCode(run(w, { params: params(), legA: mut(12, kp()), legB }), 'LegFixedAccountMismatch')
    expectCode(run(w, { params: params(), legA: mut(0, kp(), false), legB }), 'LegUserMismatch')
    expectCode(run(w, { params: params(), legA: mut(4, kp()), legB }), 'LegUserTokenAccountMismatch')
    // a pool for two other mints: our fixed mints are not in it
    const foreign = kp(); w.svm.setRaw(raw(foreign, RAYDIUM_CPMM_PROGRAM_ID, raydiumPoolBytes({ ...w.raydium, mint0: kp(), mint1: kp(), prog0: TOKEN_PROGRAM_ID, prog1: TOKEN_PROGRAM_ID })))
    expectCode(run(w, { params: params(), legA: mut(3, foreign), legB }), 'LegMintMismatch')
    // PumpSwap
    const pm = (i: number, pk: PublicKey): ExecutorLeg => { const l = pumpLeg(w, LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN); l.accounts[i] = m(pk, l.accounts[i]?.isWritable ?? false); return l }
    expectCode(run(w, { params: params(), legA: pm(2, kp()), legB }), 'GlobalConfigMismatch')
    expectCode(run(w, { params: params(), legA: pm(22, kp()), legB }), 'FeeProgramMismatch')
    expectCode(run(w, { params: params(), legA: pm(21, kp()), legB }), 'LegFixedAccountMismatch')
    expectCode(run(w, { params: params(), legA: pm(7, kp()), legB }), 'LegVaultMismatch')
    expectCode(run(w, { params: params(), legA: pm(3, kp()), legB }), 'LegMintMismatch')
    expectCode(run(w, { params: params(), legA: pm(11, TOKEN_PROGRAM_ID), legB }), 'LegTokenProgramMismatch')
    expectCode(run(w, { params: params(), legA: pm(1, kp()), legB }), 'LegUserMismatch')
    const sm = (i: number, pk: PublicKey): ExecutorLeg => { const l = pumpLeg(w, LEG_KIND.PUMPSWAP_SELL); l.accounts[i] = m(pk, l.accounts[i]?.isWritable ?? false); return l }
    expectCode(run(w, { params: params(), legA, legB: sm(20, kp()) }), 'FeeProgramMismatch')
    expectCode(run(w, { params: params(), legA, legB: sm(19, kp()) }), 'LegFixedAccountMismatch')
    // both legs are validated BEFORE leg A is invoked: a bad leg B is reported without any CPI
    const r = run(w, { params: params(), legA, legB: sm(20, kp()) })
    expect(r.logs.some(l => l.includes('arb_executor leg A'))).toBe(false)
  })
  it('fully consistent segments pass validation and fail only at the CPI (no DEX loaded here)', () => {
    const w = world()
    const cases: [string, ExecutorLeg, ExecutorLeg][] = [
      ['raydium->raydium', raydiumLeg(w, 'A'), raydiumLeg(w, 'B')],
      ['pump buy->raydium', pumpLeg(w, LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN, 3), raydiumLeg(w, 'B')],
      ['raydium->pump sell', raydiumLeg(w, 'A'), pumpLeg(w, LEG_KIND.PUMPSWAP_SELL, 3)],
      ['pump buy->pump sell (0 remaining)', pumpLeg(w, LEG_KIND.PUMPSWAP_BUY_EXACT_QUOTE_IN, 0), pumpLeg(w, LEG_KIND.PUMPSWAP_SELL, 0)],
    ]
    for (const [label, legA, legB] of cases) {
      const r = run(w, { params: params(), legA, legB, skipChecks: false })
      expect(r.ok, label).toBe(false)
      expect(r.code, `${label}: expected a runtime error, got executor code ${r.code} (${r.name})\n${r.err}\n${r.logs.join('\n')}`).toBeNull()
      expect(r.logs.some(l => l.includes(`arb_executor leg A kind=${legA.kind} amount_in=1000000000 min_out=1`)), `${label}:\n${r.logs.join('\n')}`).toBe(true)
      expect(r.logs.some(l => l.includes('arb_executor leg B')), `${label}: leg B must not run when leg A failed`).toBe(false)
      expect(r.err, label).toMatch(/UnsupportedProgramId/)
      // byte-exact CPI data recorded by the SVM as an inner instruction (Debug rendering): disc ‖ amount_in=1e9 LE ‖ min_out=1 LE (‖ 0x01 for buy)
      const expectData = legA.kind === LEG_KIND.RAYDIUM_CPMM_SWAP_BASE_INPUT
        ? 'data: [143, 190, 90, 218, 196, 30, 51, 222, 0, 202, 154, 59, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]'
        : 'data: [198, 46, 21, 82, 180, 217, 232, 112, 0, 202, 154, 59, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]'
      expect(r.err, `${label}: inner instruction data`).toContain(expectData)
      const nAccounts = /accounts: \[([0-9, ]+)\], data: \[143, 190|accounts: \[([0-9, ]+)\], data: \[198, 46/.exec(r.err ?? '')
      expect((nAccounts?.[1] ?? nAccounts?.[2] ?? '').split(',').length, `${label}: CPI account count`).toBe(legA.accounts.length)
    }
    // a Raydium->Raydium circuit also fits in one v0 transaction WITHOUT an ALT
    const r = run(w, { params: params(), legA: raydiumLeg(w, 'A'), legB: raydiumLeg(w, 'B'), skipChecks: false, noAlt: true })
    expect(r.code).toBeNull(); expect(r.logs.some(l => l.includes('arb_executor leg A kind=0'))).toBe(true)
  })
})
