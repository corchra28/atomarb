/**
 * LOCAL_REAL_PROGRAM_SIMULATION: executes the REAL mainnet Raydium CPMM ELF (tests/fixtures/programs/CPMMoo8L….so, dumped from
 * programdata DMawCQzb… at slot 447803095) against REAL account snapshots in LiteSVM. Only the user's SOL/WSOL/output balances are
 * fabricated (LOCAL ONLY, recorded in svm.synthetic). Nothing is sent anywhere. No network access.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import { loadFixture, fixtureToRaw, bundleFromFixture, type FixtureFile } from '../helpers/fixtures.js'
import { LocalSvm } from '../../src/simulation/local_svm.js'
import { buildV0 } from '../../src/simulation/tx_build.js'
import { isUnsupported, type AccountBundle, type DecodedPool, type PoolRef, type RawAccount } from '../../src/adapters/types.js'
import { RaydiumCpmmAdapter, epochForSlot, type RaydiumCpmmParams, type RaydiumSwapIxParams } from '../../src/adapters/raydium_cpmm/adapter.js'
import * as L from '../../src/adapters/raydium_cpmm/layout.js'
import { WSOL_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ACCOUNT_SIZE, EXT, associatedTokenAddress } from '../../src/state/token.js'
import { writeU64LE, writeU16LE, concatBytes } from '../../src/util/bytes.js'
import { sha256Hex } from '../../src/util/hash.js'

const PROGRAM_ID = L.RAYDIUM_CPMM_PROGRAM_ID
const PROG_DIR = new URL('../fixtures/programs/', import.meta.url).pathname
const DIR = new URL('../fixtures/raydium_cpmm/', import.meta.url).pathname
const ELF_PATH = `${PROG_DIR}${PROGRAM_ID.toBase58()}.so`
const haveElf = existsSync(ELF_PATH)
const POOL_FILES = readdirSync(DIR).filter(f => /^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(f))
const adapter = new RaydiumCpmmAdapter()
const ref = (id: string): PoolRef => ({ adapter: 'raydium_cpmm', address: new PublicKey(id), source: { kind: 'fixture', ref: `${id}.json`, observedAtUtc: '2026-09-17T13:09:45Z' } })

function loadProgram(): { elf: Uint8Array; slot: number; sha256: string } {
  const elf = new Uint8Array(readFileSync(ELF_PATH))
  const side = JSON.parse(readFileSync(`${PROG_DIR}${PROGRAM_ID.toBase58()}.json`, 'utf8')) as { slot: number; sha256: string; bytes: number }
  if (sha256Hex(elf) !== side.sha256 || elf.length !== side.bytes) throw new Error('program fixture does not match its sidecar')
  return { elf, slot: side.slot, sha256: side.sha256 }
}
/** Loads the real program + the real accounts of one pool fixture; sets the Clock so the §4 gate passes (see note §12.3). */
function makeSvm(file: FixtureFile): { svm: LocalSvm; slot: number; unixTs: bigint; epoch: bigint } {
  const prog = loadProgram()
  const svm = new LocalSvm()
  svm.addProgram({ programId: PROGRAM_ID, elf: prog.elf, programDataAddress: new PublicKey('DMawCQzbgNTmbzaESc7o6pvL1KAeetY8zA7jNpzntHhU'), slot: prog.slot, loader: 'upgradeable' })
  for (const a of file.accounts) svm.setRaw(fixtureToRaw(a))
  const pool = file.accounts.find(a => a.note === 'pool_state')!
  const slot = pool.slot, unixTs = BigInt(Math.floor(Date.parse(pool.fetched_at_utc) / 1000)), epoch = epochForSlot(slot)
  // LiteSVM's default Clock has unix_timestamp = 0 → swap_base_input would fail `block_timestamp < open_time` (NotApproved). Use the fixture's wall clock + epoch.
  const clock = svm.svm.getClock(); clock.slot = BigInt(slot); clock.epoch = epoch; clock.unixTimestamp = unixTs; svm.svm.setClock(clock)
  return { svm, slot, unixTs, epoch }
}
/** Re-reads the 6 quoting dependencies from the SVM into an AccountBundle (provider 'litesvm'). */
function bundleFromSvm(svm: LocalSvm, keys: PublicKey[], slot: number, receivedAtUtc: string): AccountBundle {
  const accounts = new Map<string, RawAccount>()
  for (const k of keys) {
    const a = svm.getAccount(k); if (!a) throw new Error(`missing in svm: ${k.toBase58()}`)
    accounts.set(k.toBase58(), { pubkey: k, data: a.data, owner: a.owner, lamports: a.lamports, executable: false, contextSlot: slot, receivedAtUtc, receivedMonoMs: 0, batchId: 'litesvm', provider: 'litesvm' })
  }
  return { accounts, singleBatch: true, minSlot: slot, maxSlot: slot, batchIds: ['litesvm'] }
}
/** Fabricates an EMPTY Token-2022 ATA carrying ImmutableOwner + TransferFeeAmount (required when the mint has a transfer fee; T22 processor.rs lines 551-563). LOCAL ONLY. */
function fabricateT22Ata(svm: LocalSvm, addr: PublicKey, mint: PublicKey, owner: PublicKey): void {
  const base = new Uint8Array(ACCOUNT_SIZE); base.set(mint.toBytes(), 0); base.set(owner.toBytes(), 32); base[108] = 1
  const data = concatBytes(base, new Uint8Array([2]), writeU16LE(EXT.ImmutableOwner), writeU16LE(0), writeU16LE(EXT.TransferFeeAmount), writeU16LE(8), writeU64LE(0n))
  svm.setRaw({ pubkey: addr, data, owner: TOKEN_2022_PROGRAM_ID, lamports: svm.rentExempt(data.length), executable: false, contextSlot: 0, receivedAtUtc: 'synthetic', receivedMonoMs: 0, batchId: 'synthetic', provider: 'litesvm' })
  svm.synthetic.push({ pubkey: addr, note: `synthetic Token-2022 ATA mint=${mint.toBase58()} amount=0 (ImmutableOwner+TransferFeeAmount)` })
}
const withRandomSig = <T extends { signatures: Uint8Array[] }>(tx: T): T => { tx.signatures[0] = new Uint8Array(randomBytes(64)); return tx } // unique tx id; sigverify is off
const feesOf = (p: RaydiumCpmmParams) => [p.pool.protocolFeesToken0, p.pool.protocolFeesToken1, p.pool.fundFeesToken0, p.pool.fundFeesToken1, p.pool.creatorFeesToken0, p.pool.creatorFeesToken1]

describe.skipIf(!haveElf)('LOCAL_REAL_PROGRAM_SIMULATION raydium_cpmm swap_base_input against the real mainnet ELF', () => {
  it('program fixture provenance is intact', () => { const p = loadProgram(); expect(p.elf.length).toBe(793_824); expect(p.sha256).toBe('36537be95ba356056fa38b2847d928078c68bf6cd79b875c140e157e6452cc71') })

  // Review finding (MAJOR): no live pool has enable_creator_fee = true, so the creator-fee branch — the one the SDK gets wrong (§5.6) — was never
  // executed by the real program. Patch the flag and the position into a fixture pool (those bytes are plain state, the pool is not a PDA over them)
  // and prove the adapter's quote still equals what the real program does, in all three creator_fee_on positions and both directions.
  describe.each([0, 1, 2])('creator fee enabled, creator_fee_on=%i (patched fixture, real program)', on => {
    const id = 'Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp'
    it('quote equals the on-chain result exactly in both directions', () => {
      const file = loadFixture(`${DIR}${id}.json`)
      const patched: FixtureFile = { ...file, accounts: file.accounts.map(a => {
        if (a.note !== 'pool_state') return a
        const d = new Uint8Array(Buffer.from(a.data_base64, 'base64'))
        d[389] = on; d[390] = 1                                   // creator_fee_on, enable_creator_fee (layout §2)
        return { ...a, data_base64: Buffer.from(d).toString('base64') }
      }) }
      const { svm, slot } = makeSvm(patched)
      const d0 = adapter.decodeSnapshot(ref(id), bundleFromFixture(patched)); if (isUnsupported(d0)) throw new Error(d0.reason)
      const p0 = d0.params as RaydiumCpmmParams
      expect(p0.pool.enableCreatorFee).toBe(true); expect(p0.pool.creatorFeeOn).toBe(on); expect(p0.config.creatorFeeRate).toBeGreaterThan(0n)
      const v = adapter.validatePool(d0); expect(v.ok, JSON.stringify(v.rejects)).toBe(true)
      expect(v.warnings.some(w => w.code === 'CREATOR_FEE_ENABLED')).toBe(true)
      const wsolIsA = d0.mintA.mint.equals(WSOL_MINT)
      const tokenMint = wsolIsA ? d0.mintB : d0.mintA
      const tokenProgram = tokenMint.program === 'spl_token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
      const user = Keypair.generate().publicKey
      const wsolAta = associatedTokenAddress(user, WSOL_MINT, TOKEN_PROGRAM_ID), outAta = associatedTokenAddress(user, tokenMint.mint, tokenProgram)
      const WSOL_START = 500_000_000n
      svm.fundSystemAccount(user, 1_000_000_000n, 'test user')
      svm.fundTokenAccount(wsolAta, WSOL_MINT, user, WSOL_START, TOKEN_PROGRAM_ID, 'user WSOL ATA', true)
      svm.fundTokenAccount(outAta, tokenMint.mint, user, 0n, tokenProgram, 'user output ATA (empty)')
      const amountIn = 100_000_000n
      const q1 = adapter.quoteExactIn(d0, WSOL_MINT, amountIn); if (isUnsupported(q1)) throw new Error(q1.reason)
      expect(q1.rejectReasons).toEqual([])
      const creatorItem = q1.fees.find(f => f.name === 'creator_fee')
      const feeOnInput = on === 0 || (on === 1 && wsolIsA) || (on === 2 && !wsolIsA)
      expect(creatorItem, 'a creator fee item must be reported').toBeDefined()
      expect(creatorItem!.amount).toBeGreaterThan(0n)
      expect(creatorItem!.mint.equals(feeOnInput ? WSOL_MINT : tokenMint.mint)).toBe(true)   // §5.3 step 4: position depends on creator_fee_on AND direction
      const built = adapter.buildSwapInstruction(d0, { user, userInputAccount: wsolAta, userOutputAccount: outAta, amountIn, minimumAmountOut: q1.amountOutToUser, inputMint: WSOL_MINT } as RaydiumSwapIxParams)
      if (isUnsupported(built)) throw new Error(built.reason)
      const r1 = svm.execute(withRandomSig(buildV0(user, svm.svm.latestBlockhash(), [built.instruction]).tx))
      expect(r1.ok, r1.err ?? '').toBe(true)
      expect(svm.tokenAmount(outAta)).toBe(q1.amountOutToUser)          // the program agrees with the ceil(total)+floor-split rule
      expect(svm.tokenAmount(wsolAta)).toBe(WSOL_START - amountIn)
      // the creator fee lands in the fee counter of the correct token, exactly as applySwap predicted
      const predicted = adapter.applySwap(d0, q1); if (isUnsupported(predicted)) throw new Error(predicted.reason)
      const d1 = adapter.decodeSnapshot(ref(id), bundleFromSvm(svm, d0.dependsOn, slot, d0.snapshot.receivedAtUtc)); if (isUnsupported(d1)) throw new Error(d1.reason)
      expect(feesOf(d1.params as RaydiumCpmmParams)).toEqual(feesOf(predicted.params as RaydiumCpmmParams))
      const creatorCounters = wsolIsA ? [(d1.params as RaydiumCpmmParams).pool.creatorFeesToken0, (d1.params as RaydiumCpmmParams).pool.creatorFeesToken1] : [(d1.params as RaydiumCpmmParams).pool.creatorFeesToken1, (d1.params as RaydiumCpmmParams).pool.creatorFeesToken0]
      expect(feeOnInput ? creatorCounters[0] : creatorCounters[1]).toBe(creatorItem!.amount)
      // the tight bound still holds with the creator fee on
      const tight = adapter.buildSwapInstruction(d1, { user, userInputAccount: outAta, userOutputAccount: wsolAta, amountIn: q1.amountOutToUser, minimumAmountOut: 0n, inputMint: tokenMint.mint } as RaydiumSwapIxParams)
      if (isUnsupported(tight)) throw new Error(tight.reason)
      const q2 = adapter.quoteExactIn(d1, tokenMint.mint, q1.amountOutToUser); if (isUnsupported(q2)) throw new Error(q2.reason)
      const back = adapter.buildSwapInstruction(d1, { user, userInputAccount: outAta, userOutputAccount: wsolAta, amountIn: q1.amountOutToUser, minimumAmountOut: q2.amountOutToUser, inputMint: tokenMint.mint } as RaydiumSwapIxParams)
      if (isUnsupported(back)) throw new Error(back.reason)
      const r2 = svm.execute(withRandomSig(buildV0(user, svm.svm.latestBlockhash(), [back.instruction]).tx))
      expect(r2.ok, r2.err ?? '').toBe(true)
      expect(svm.tokenAmount(wsolAta)).toBe(WSOL_START - amountIn + q2.amountOutToUser)   // EXACT credit on the reverse direction too
      expect(q2.amountOutToUser).toBeLessThan(amountIn)                                    // still no roundtrip profit
    }, 120_000)
  })

  describe.each(POOL_FILES.map(f => f.replace('.json', '')))('pool %s', id => {
    const file = loadFixture(`${DIR}${id}.json`)
    it('WSOL → token executes with the quote as minimum_amount_out; balances change by EXACTLY the quote; then swap back with no profit', () => {
      const { svm, slot, epoch } = makeSvm(file)
      const d0 = adapter.decodeSnapshot(ref(id), bundleFromFixture(file)); if (isUnsupported(d0)) throw new Error(d0.reason)
      expect((d0.params as RaydiumCpmmParams).epoch).toBe(epoch)
      const v = adapter.validatePool(d0); expect(v.ok, JSON.stringify(v.rejects)).toBe(true)
      const wsolIsA = d0.mintA.mint.equals(WSOL_MINT)
      const tokenMint = wsolIsA ? d0.mintB : d0.mintA
      const tokenProgram = tokenMint.program === 'spl_token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
      const reserveWsol = wsolIsA ? d0.reserveA : d0.reserveB
      // user: random public key (no private key exists anywhere); 1 SOL for fees + 0.5 WSOL in an ATA + empty output ATA
      const user = Keypair.generate().publicKey
      const wsolAta = associatedTokenAddress(user, WSOL_MINT, TOKEN_PROGRAM_ID), outAta = associatedTokenAddress(user, tokenMint.mint, tokenProgram)
      const WSOL_START = 500_000_000n
      svm.fundSystemAccount(user, 1_000_000_000n, 'test user')
      svm.fundTokenAccount(wsolAta, WSOL_MINT, user, WSOL_START, TOKEN_PROGRAM_ID, 'user WSOL ATA', true)
      if (tokenMint.program === 'token_2022' && tokenMint.transferFee) fabricateT22Ata(svm, outAta, tokenMint.mint, user)
      else svm.fundTokenAccount(outAta, tokenMint.mint, user, 0n, tokenProgram, 'user output ATA (empty)')
      // size: 0.5 SOL, or a tenth of the WSOL reserve for tiny pools (the BERN pool holds ~0.014 SOL)
      const amountIn = reserveWsol / 10n < WSOL_START ? reserveWsol / 10n : WSOL_START
      const q1 = adapter.quoteExactIn(d0, WSOL_MINT, amountIn); if (isUnsupported(q1)) throw new Error(q1.reason)
      expect(q1.rejectReasons).toEqual([])
      const ixParams: RaydiumSwapIxParams = { user, userInputAccount: wsolAta, userOutputAccount: outAta, amountIn, minimumAmountOut: q1.amountOutToUser, inputMint: WSOL_MINT }
      // (a) the quote is TIGHT: asking for one more unit must fail with ExceededSlippage (custom error 6005 = 0x1775)
      const tightParams: RaydiumSwapIxParams = { ...ixParams, minimumAmountOut: q1.amountOutToUser + 1n }
      const tooMuch = adapter.buildSwapInstruction(d0, tightParams); if (isUnsupported(tooMuch)) throw new Error(tooMuch.reason)
      const simTight = svm.simulate(withRandomSig(buildV0(user, svm.svm.latestBlockhash(), [tooMuch.instruction]).tx))
      expect(simTight.ok).toBe(false); expect(`${simTight.err} ${simTight.logs.join('\n')}`).toMatch(/6005|0x1775|ExceededSlippage/)
      // (b) execute with minimum_amount_out == quote
      const built = adapter.buildSwapInstruction(d0, ixParams); if (isUnsupported(built)) throw new Error(built.reason)
      const tx1 = buildV0(user, svm.svm.latestBlockhash(), [built.instruction]); expect(tx1.inspection.withinSizeLimit).toBe(true)
      const r1 = svm.execute(withRandomSig(tx1.tx))
      if (!r1.ok) console.error('swap 1 failed:', r1.err, '\n' + r1.logs.join('\n'))
      expect(r1.ok, r1.err ?? '').toBe(true)
      expect(svm.tokenAmount(outAta)).toBe(q1.amountOutToUser)                 // EXACT output credit
      expect(svm.tokenAmount(wsolAta)).toBe(WSOL_START - amountIn)              // EXACT input debit
      const vaultWsol = wsolIsA ? d0.vaultA.address : d0.vaultB.address, vaultTok = wsolIsA ? d0.vaultB.address : d0.vaultA.address
      expect(svm.tokenAmount(vaultWsol)).toBe((wsolIsA ? d0.vaultA.amount : d0.vaultB.amount) + q1.vaultInDelta)
      expect(svm.tokenAmount(vaultTok)).toBe((wsolIsA ? d0.vaultB.amount : d0.vaultA.amount) - q1.vaultOutDelta)
      // (c) applySwap predicts the on-chain post-state exactly (vault amounts, fee counters, reserves)
      const predicted = adapter.applySwap(d0, q1); if (isUnsupported(predicted)) throw new Error(predicted.reason)
      const d1 = adapter.decodeSnapshot(ref(id), bundleFromSvm(svm, d0.dependsOn, slot, d0.snapshot.receivedAtUtc)); if (isUnsupported(d1)) throw new Error(d1.reason)
      expect(d1.vaultA.amount).toBe(predicted.vaultA.amount); expect(d1.vaultB.amount).toBe(predicted.vaultB.amount)
      expect(d1.reserveA).toBe(predicted.reserveA); expect(d1.reserveB).toBe(predicted.reserveB)
      expect(feesOf(d1.params as RaydiumCpmmParams)).toEqual(feesOf(predicted.params as RaydiumCpmmParams))
      expect(adapter.validatePool(d1).ok).toBe(true)
      // (d) swap back token → WSOL on the post-state; assert exact WSOL credit and no roundtrip profit
      const got = q1.amountOutToUser
      const q2 = adapter.quoteExactIn(d1, tokenMint.mint, got); if (isUnsupported(q2)) throw new Error(q2.reason)
      expect(q2.rejectReasons).toEqual([])
      const backParams: RaydiumSwapIxParams = { user, userInputAccount: outAta, userOutputAccount: wsolAta, amountIn: got, minimumAmountOut: q2.amountOutToUser, inputMint: tokenMint.mint }
      const back = adapter.buildSwapInstruction(d1, backParams)
      if (isUnsupported(back)) throw new Error(back.reason)
      const r2 = svm.execute(withRandomSig(buildV0(user, svm.svm.latestBlockhash(), [back.instruction]).tx))
      if (!r2.ok) console.error('swap 2 failed:', r2.err, '\n' + r2.logs.join('\n'))
      expect(r2.ok, r2.err ?? '').toBe(true)
      expect(svm.tokenAmount(outAta)).toBe(0n)
      expect(svm.tokenAmount(wsolAta)).toBe(WSOL_START - amountIn + q2.amountOutToUser)
      expect(q2.amountOutToUser < amountIn).toBe(true)                            // fees make the roundtrip strictly losing
      const predicted2 = adapter.applySwap(d1, q2); if (isUnsupported(predicted2)) throw new Error(predicted2.reason)
      const d2 = adapter.decodeSnapshot(ref(id), bundleFromSvm(svm, d0.dependsOn, slot, d0.snapshot.receivedAtUtc)); if (isUnsupported(d2)) throw new Error(d2.reason)
      expect([d2.vaultA.amount, d2.vaultB.amount, ...feesOf(d2.params as RaydiumCpmmParams)]).toEqual([predicted2.vaultA.amount, predicted2.vaultB.amount, ...feesOf(predicted2.params as RaydiumCpmmParams)])
      console.log(`[${id}] in ${amountIn} → out ${q1.amountOutToUser} → back ${q2.amountOutToUser} (CU ${r1.unitsConsumed}/${r2.unitsConsumed}); synthetic accounts: ${svm.synthetic.length}`)
    })
    it('the §4 gate is real: with the default clock (unix_timestamp 0 < open_time) the program rejects with NotApproved (6000)', () => {
      const prog = loadProgram(); const svm = new LocalSvm()
      svm.addProgram({ programId: PROGRAM_ID, elf: prog.elf, programDataAddress: null, slot: prog.slot, loader: 'upgradeable' })
      for (const a of file.accounts) svm.setRaw(fixtureToRaw(a))
      const d0 = adapter.decodeSnapshot(ref(id), bundleFromFixture(file)); if (isUnsupported(d0)) throw new Error(d0.reason)
      const user = Keypair.generate().publicKey
      const tokenMint = d0.mintA.mint.equals(WSOL_MINT) ? d0.mintB : d0.mintA
      const wsolAta = associatedTokenAddress(user, WSOL_MINT, TOKEN_PROGRAM_ID), outAta = associatedTokenAddress(user, tokenMint.mint, tokenMint.program === 'spl_token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID)
      svm.fundSystemAccount(user, 1_000_000_000n, 'test user'); svm.fundTokenAccount(wsolAta, WSOL_MINT, user, 10_000_000n, TOKEN_PROGRAM_ID, 'wsol', true)
      if (tokenMint.program === 'token_2022') fabricateT22Ata(svm, outAta, tokenMint.mint, user); else svm.fundTokenAccount(outAta, tokenMint.mint, user, 0n, TOKEN_PROGRAM_ID, 'out')
      const b = adapter.buildSwapInstruction(d0, { user, userInputAccount: wsolAta, userOutputAccount: outAta, amountIn: 1_000_000n, minimumAmountOut: 0n, inputMint: WSOL_MINT } as RaydiumSwapIxParams); if (isUnsupported(b)) throw new Error(b.reason)
      const r = svm.simulate(buildV0(user, svm.svm.latestBlockhash(), [b.instruction]).tx)
      expect(r.ok).toBe(false); expect(`${r.err} ${r.logs.join('\n')}`).toMatch(/6000|0x1770|NotApproved/)
    })
  })
})
