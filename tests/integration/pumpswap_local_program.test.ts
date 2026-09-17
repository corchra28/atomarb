/**
 * LOCAL_REAL_PROGRAM_SIMULATION: executes the REAL mainnet pump_amm + pump_fees ELFs against REAL fixture accounts inside LiteSVM.
 * Only the user (system account), its WSOL ATA balance and its base ATA are fabricated (LOCAL ONLY, labelled in svm.synthetic).
 * Nothing touches the network; nothing is signed (sigverify disabled). Fixtures: tests/fixtures/pumpswap/*.json, tests/fixtures/programs/*.so.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { Clock } from 'litesvm'
import { LocalSvm } from '../../src/simulation/local_svm.js'
import { buildV0 } from '../../src/simulation/tx_build.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WSOL_MINT, associatedTokenAddress } from '../../src/state/token.js'
import { readU64LE, readI64LE, readU128LE, readU32LE, writeU64LE } from '../../src/util/bytes.js'
import { address as kitAddress, lamports as kitLamports } from '@solana/kit'
import { isUnsupported, type DecodedPool, type PoolRef, type Quote } from '../../src/adapters/types.js'
import { pumpswapAdapter, pumpswapParams, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, userVolumeAccumulatorPda, coinCreatorVaultAuthorityPda, protocolFeeRecipientFor, buybackFeeRecipientFor } from '../../src/adapters/pumpswap/index.js'
import { loadFixture, bundleFromFixture } from '../helpers/fixtures.js'

const FX = 'tests/fixtures/pumpswap'
const PROGRAMS = 'tests/fixtures/programs'
const haveFixtures = existsSync(`${PROGRAMS}/${PUMP_AMM_PROGRAM_ID.toBase58()}.so`) && existsSync(`${PROGRAMS}/${PUMP_FEE_PROGRAM_ID.toBase58()}.so`) && existsSync(`${FX}/pool_canonical.json`)

/** random on-curve public key with NO secret key (loop until on curve; ~50% per draw). */
function randomPubkey(): PublicKey { for (;;) { const b = randomBytes(32); if (PublicKey.isOnCurve(b)) return new PublicKey(b) } }
function loadProgram(id: PublicKey) {
  const side = JSON.parse(readFileSync(`${PROGRAMS}/${id.toBase58()}.json`, 'utf8')) as { slot: number; programDataAddress: string | null }
  return { programId: id, elf: new Uint8Array(readFileSync(`${PROGRAMS}/${id.toBase58()}.so`)), programDataAddress: side.programDataAddress ? new PublicKey(side.programDataAddress) : null, slot: side.slot, loader: 'upgradeable' as const }
}
interface Harness { svm: LocalSvm; decoded: DecodedPool; user: PublicKey; userQuoteAta: PublicKey; userBaseAta: PublicKey; baseTp: PublicKey; slot: number; ataRent: bigint }
const WSOL_FUND = 500_000_000n
function setup(role: 'canonical' | 'boosted' | 'noncanonical'): Harness {
  const file = loadFixture(`${FX}/pool_${role}.json`)
  const bundle = bundleFromFixture(file)
  const poolKey = new PublicKey(file.accounts[0]!.pubkey)
  const ref: PoolRef = { adapter: 'pumpswap', address: poolKey, source: { kind: 'fixture', ref: `${FX}/pool_${role}.json`, observedAtUtc: file.accounts[0]!.fetched_at_utc } }
  const decoded = pumpswapAdapter.decodeSnapshot(ref, bundle)
  if (isUnsupported(decoded)) throw new Error(`${decoded.code}: ${decoded.reason}`)
  const v = pumpswapAdapter.validatePool(decoded); if (!v.ok) throw new Error(`INVALID ${JSON.stringify(v.rejects)}`)
  const svm = new LocalSvm()
  svm.addProgram(loadProgram(PUMP_AMM_PROGRAM_ID)); svm.addProgram(loadProgram(PUMP_FEE_PROGRAM_ID))
  for (const a of bundle.accounts.values()) svm.setRaw(a)
  // Clock ≈ fixture slot: unix time extrapolated from the live BuyEvent timestamp 1789645983 @ slot 447788562 (pumpswap.md S3) at 0.4 s/slot; epoch = slot / 432000.
  const slot = bundle.maxSlot
  const unixTs = BigInt(1789645983 + Math.round((slot - 447788562) * 0.4))
  const epoch = BigInt(Math.floor(slot / 432_000))
  svm.svm.setClock(new Clock(BigInt(slot), unixTs - BigInt(Math.round((slot % 432_000) * 0.4)), epoch, epoch + 1n, unixTs))
  const user = randomPubkey()
  const baseTp = decoded.mintA.program === 'token_2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  const userQuoteAta = associatedTokenAddress(user, WSOL_MINT, TOKEN_PROGRAM_ID), userBaseAta = associatedTokenAddress(user, decoded.mintA.mint, baseTp)
  svm.fundSystemAccount(user, 1_000_000_000n, 'simulation user (LOCAL ONLY)')
  svm.fundTokenAccount(userQuoteAta, WSOL_MINT, user, WSOL_FUND, TOKEN_PROGRAM_ID, 'user WSOL ATA (LOCAL ONLY)', true)
  // the base ATA is created by the REAL associated-token program (Token-2022 mints may require account extensions; fabricating bytes would be guesswork)
  const before = svm.getAccount(user)!.lamports
  const mk = buildV0(user, svm.svm.latestBlockhash(), [createAssociatedTokenAccountIdempotentInstruction(user, userBaseAta, user, decoded.mintA.mint, baseTp)])
  const r = svm.execute(mk.tx); if (!r.ok) throw new Error(`create base ATA failed: ${r.err}\n${r.logs.join('\n')}`)
  const ataRent = before - svm.getAccount(user)!.lamports - 5_000n
  svm.synthetic.push({ pubkey: userBaseAta, note: 'user base ATA created locally via the ATA program (LOCAL ONLY)' })
  return { svm, decoded, user, userQuoteAta, userBaseAta, baseTp, slot, ataRent }
}
function amt(h: Harness, k: PublicKey): bigint { return h.svm.tokenAmount(k) ?? 0n }
/** BuyEvent / SellEvent prefix (pumpswap.md §9) from `Program data:` logs. */
function parseEvents(logs: string[]) {
  const out: Record<string, bigint | string>[] = []
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue
    const d = new Uint8Array(Buffer.from(l.slice('Program data: '.length), 'base64'))
    const disc = Buffer.from(d.subarray(0, 8)).toString('hex')
    if (disc === '67f4521f2cf57777') { // BuyEvent
      let o = 8; const u = () => { const v = readU64LE(d, o); o += 8; return v }
      const ev: Record<string, bigint | string> = { event: 'BuyEvent', timestamp: readI64LE(d, o) }; o += 8
      for (const f of ['base_amount_out', 'max_quote_amount_in', 'user_base_token_reserves', 'user_quote_token_reserves', 'pool_base_token_reserves', 'pool_quote_token_reserves', 'quote_amount_in', 'lp_fee_basis_points', 'lp_fee', 'protocol_fee_basis_points', 'protocol_fee', 'quote_amount_in_with_lp_fee', 'user_quote_amount_in']) ev[f] = u()
      o += 32 * 7; ev['coin_creator_fee_basis_points'] = u(); ev['coin_creator_fee'] = u(); ev['track_volume'] = BigInt(d[o]!); o += 1
      for (const f of ['total_unclaimed_tokens', 'total_claimed_tokens', 'current_sol_volume']) ev[f] = u()
      ev['last_update_timestamp'] = readI64LE(d, o); o += 8; ev['min_base_amount_out'] = u()
      const n = readU32LE(d, o); o += 4; ev['ix_name'] = Buffer.from(d.subarray(o, o + n)).toString('utf8'); o += n
      for (const f of ['cashback_fee_basis_points', 'cashback', 'buyback_fee_basis_points', 'buyback_fee']) ev[f] = u()
      ev['virtual_quote_reserves'] = readU128LE(d, o); o += 16; ev['can_boost'] = BigInt(d[o]!); o += 1; ev['base_supply'] = u(); ev['holder_rewards_bps'] = u(); ev['holder_rewards'] = u()
      out.push(ev)
    } else if (disc === '3e2f370aa503dc2a') { // SellEvent
      let o = 8; const u = () => { const v = readU64LE(d, o); o += 8; return v }
      const ev: Record<string, bigint | string> = { event: 'SellEvent', timestamp: readI64LE(d, o) }; o += 8
      for (const f of ['base_amount_in', 'min_quote_amount_out', 'user_base_token_reserves', 'user_quote_token_reserves', 'pool_base_token_reserves', 'pool_quote_token_reserves', 'quote_amount_out', 'lp_fee_basis_points', 'lp_fee', 'protocol_fee_basis_points', 'protocol_fee', 'quote_amount_out_without_lp_fee', 'user_quote_amount_out']) ev[f] = u()
      o += 32 * 7; ev['coin_creator_fee_basis_points'] = u(); ev['coin_creator_fee'] = u()
      for (const f of ['cashback_fee_basis_points', 'cashback', 'buyback_fee_basis_points', 'buyback_fee']) ev[f] = u()
      ev['virtual_quote_reserves'] = readU128LE(d, o); o += 16; ev['can_boost'] = BigInt(d[o]!); o += 1; ev['base_supply'] = u(); ev['holder_rewards_bps'] = u(); ev['holder_rewards'] = u()
      out.push(ev)
    }
  }
  return out
}
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

interface LegResult { quote: Quote; logs: string[]; err: string | null; deltas: Record<string, bigint>; events: Record<string, bigint | string>[]; cu: bigint }
function runLeg(h: Harness, decoded: DecodedPool, inputMint: PublicKey, amountIn: bigint, minOutOverride?: bigint): LegResult {
  const P = pumpswapParams(decoded); const p = P.pool
  const q = pumpswapAdapter.quoteExactIn(decoded, inputMint, amountIn)
  if (isUnsupported(q)) throw new Error(`${q.code}: ${q.reason}`)
  if (q.rejectReasons.length) throw new Error(`quote rejected: ${q.rejectReasons.join(',')} ${J(q.math)}`)
  const isBuy = inputMint.equals(WSOL_MINT)
  const built = pumpswapAdapter.buildSwapInstruction(decoded, { user: h.user, userInputAccount: isBuy ? h.userQuoteAta : h.userBaseAta, userOutputAccount: isBuy ? h.userBaseAta : h.userQuoteAta, amountIn, minimumAmountOut: minOutOverride ?? q.amountOutToUser })
  if (isUnsupported(built)) throw new Error(`${built.code}: ${built.reason}`)
  const watch: Record<string, PublicKey> = {
    userQuote: h.userQuoteAta, userBase: h.userBaseAta, poolQuote: p.poolQuoteTokenAccount, poolBase: p.poolBaseTokenAccount,
    protocolAta: associatedTokenAddress(protocolFeeRecipientFor(P.globalConfig, p.isMayhemMode), WSOL_MINT, TOKEN_PROGRAM_ID), buybackAta: associatedTokenAddress(buybackFeeRecipientFor(P.globalConfig), WSOL_MINT, TOKEN_PROGRAM_ID),
    creatorVaultAta: associatedTokenAddress(coinCreatorVaultAuthorityPda(p.coinCreator), WSOL_MINT, TOKEN_PROGRAM_ID),
  }
  const before: Record<string, bigint> = {}; for (const [k, v] of Object.entries(watch)) before[k] = amt(h, v)
  const solBefore = h.svm.getAccount(h.user)!.lamports
  const uvaBefore = h.svm.getAccount(userVolumeAccumulatorPda(h.user))?.lamports ?? 0n
  const tx = buildV0(h.user, h.svm.svm.latestBlockhash(), [built.instruction])
  const r = h.svm.execute(tx.tx)
  const deltas: Record<string, bigint> = {}; for (const [k, v] of Object.entries(watch)) deltas[k] = amt(h, v) - before[k]!
  deltas['userSol'] = h.svm.getAccount(h.user)!.lamports - solBefore
  deltas['uvaLamports'] = (h.svm.getAccount(userVolumeAccumulatorPda(h.user))?.lamports ?? 0n) - uvaBefore
  return { quote: q, logs: r.logs, err: r.err, deltas, events: parseEvents(r.logs), cu: r.unitsConsumed }
}

describe.skipIf(!haveFixtures)('LOCAL_REAL_PROGRAM_SIMULATION: pump_amm buy_exact_quote_in / sell on real fixture state', () => {
  const BUY = 10_000_000n
  for (const role of ['canonical', 'boosted', 'noncanonical'] as const) {
    it(`${role}: buy_exact_quote_in(${BUY}) then sell(all) — deltas equal the adapter quotes exactly; roundtrip never profits`, () => {
      const h = setup(role)
      const P0 = pumpswapParams(h.decoded)
      // ---- leg 1: buy -------------------------------------------------------------------------------------------------
      const buy = runLeg(h, h.decoded, WSOL_MINT, BUY)
      if (buy.err) console.log(buy.logs.join('\n'))
      expect(buy.err, `buy failed: ${buy.err}`).toBeNull()
      const ev = buy.events.find(e => e['event'] === 'BuyEvent')
      console.log(`[${role}] buy quote=${J({ amountIn: buy.quote.amountIn, out: buy.quote.amountOutToUser, vaultIn: buy.quote.vaultInDelta, vaultOut: buy.quote.vaultOutDelta, fees: buy.quote.fees.map(f => `${f.name}=${f.amount}`), math: buy.quote.math })}`)
      console.log(`[${role}] buy deltas=${J(buy.deltas)} cu=${buy.cu} event=${J(ev)}`)
      expect(buy.deltas['userBase'], 'base ATA delta must equal amountOutToUser').toBe(buy.quote.amountOutToUser)
      expect(-buy.deltas['userQuote']!, 'WSOL ATA delta must equal amountIn').toBe(buy.quote.amountIn)
      expect(buy.deltas['poolQuote'], 'pool quote vault delta must equal vaultInDelta (effective_quote + lp_fee)').toBe(buy.quote.vaultInDelta)
      expect(-buy.deltas['poolBase']!, 'pool base vault delta must equal vaultOutDelta').toBe(buy.quote.vaultOutDelta)
      const feeOf = (n: string) => buy.quote.fees.find(f => f.name === n)?.amount ?? 0n
      expect(buy.deltas['protocolAta']! + buy.deltas['buybackAta']!, 'protocol + buyback ATA deltas == protocol fee').toBe(feeOf('protocol_fee'))
      if (!P0.pool.coinCreator.equals(PublicKey.default)) expect(buy.deltas['creatorVaultAta'], 'creator vault delta == creator fee').toBe(feeOf('coin_creator_fee'))
      // user SOL: tx fee 5000 + rent of the init_if_needed user_volume_accumulator (pumpswap.md §1: 137 bytes ≈ 1,844,400 lamports)
      const uvaRent = buy.deltas['uvaLamports']!
      console.log(`[${role}] user SOL delta ${buy.deltas['userSol']} = -(5000 fee + ${uvaRent} user_volume_accumulator rent); base ATA rent paid earlier: ${h.ataRent}`)
      expect(buy.deltas['userSol']).toBe(-(5_000n + uvaRent))
      expect(uvaRent).toBe(h.svm.rentExempt(137))
      // ---- leg 2: sell everything received on the SAME pool (state after applySwap) --------------------------------------
      const after1 = pumpswapAdapter.applySwap(h.decoded, buy.quote); if (isUnsupported(after1)) throw new Error(after1.reason)
      expect(after1.reserveB).toBe(amt(h, P0.pool.poolQuoteTokenAccount)); expect(after1.reserveA).toBe(amt(h, P0.pool.poolBaseTokenAccount))
      const sell = runLeg(h, after1, h.decoded.mintA.mint, buy.quote.amountOutToUser)
      if (sell.err) console.log(sell.logs.join('\n'))
      expect(sell.err, `sell failed: ${sell.err}`).toBeNull()
      const sev = sell.events.find(e => e['event'] === 'SellEvent')
      console.log(`[${role}] sell quote=${J({ amountIn: sell.quote.amountIn, out: sell.quote.amountOutToUser, vaultIn: sell.quote.vaultInDelta, vaultOut: sell.quote.vaultOutDelta, fees: sell.quote.fees.map(f => `${f.name}=${f.amount}`) })} deltas=${J(sell.deltas)} event=${J(sev)}`)
      expect(sell.deltas['userQuote'], 'WSOL delta must equal sell amountOutToUser').toBe(sell.quote.amountOutToUser)
      expect(-sell.deltas['userBase']!, 'base ATA delta must equal sell amountIn').toBe(sell.quote.amountIn)
      expect(sell.deltas['poolBase'], 'pool base vault delta must equal vaultInDelta').toBe(sell.quote.vaultInDelta)
      expect(-sell.deltas['poolQuote']!, 'pool quote vault delta must equal vaultOutDelta (quote_out - lp_fee)').toBe(sell.quote.vaultOutDelta)
      const after2 = pumpswapAdapter.applySwap(after1, sell.quote); if (isUnsupported(after2)) throw new Error(after2.reason)
      expect(after2.reserveB).toBe(amt(h, P0.pool.poolQuoteTokenAccount)); expect(after2.reserveA).toBe(amt(h, P0.pool.poolBaseTokenAccount))
      // ---- roundtrip: no artificial profit ---------------------------------------------------------------------------------
      const finalWsol = amt(h, h.userQuoteAta)
      console.log(`[${role}] roundtrip WSOL ${WSOL_FUND} -> ${finalWsol} (${finalWsol - WSOL_FUND}); synthetic=${h.svm.synthetic.map(s => s.note).join('; ')}`)
      expect(finalWsol <= WSOL_FUND).toBe(true)
      expect(buy.quote.amountIn - sell.quote.amountOutToUser >= 0n).toBe(true)
    })
  }

  it('canonical: buy_exact_quote_in relation holds over >= 5 sizes (chain base_out == quote, chain debit == amountIn)', () => {
    const sizes = [1_000_000n, 3_333_333n, 10_000_000n, 50_000_000n, 123_456_789n, 400_000_000n]
    const rows: string[] = []
    for (const size of sizes) {
      const h = setup('canonical')
      const leg = runLeg(h, h.decoded, WSOL_MINT, size)
      const ev = leg.events.find(e => e['event'] === 'BuyEvent')
      rows.push(`size=${size} err=${leg.err} quote.out=${leg.quote.amountOutToUser} chain.out=${leg.deltas['userBase']} quote.in=${leg.quote.amountIn} chain.in=${-leg.deltas['userQuote']!} chain.quote_amount_in=${ev?.['quote_amount_in']} chain.user_quote_amount_in=${ev?.['user_quote_amount_in']} eff=${leg.quote.math['effective_quote']} vaultIn: q=${leg.quote.vaultInDelta} chain=${leg.deltas['poolQuote']}`)
      expect(leg.err, rows.at(-1)).toBeNull()
      expect(leg.deltas['userBase']).toBe(leg.quote.amountOutToUser)
      expect(-leg.deltas['userQuote']!).toBe(leg.quote.amountIn)
      expect(leg.deltas['poolQuote']).toBe(leg.quote.vaultInDelta)
    }
    console.log(rows.join('\n'))
  })

  it('canonical: min_base_amount_out one above the quote makes the real program fail (quote is tight, not padded)', () => {
    const h = setup('canonical')
    const q = pumpswapAdapter.quoteExactIn(h.decoded, WSOL_MINT, BUY); if (isUnsupported(q)) throw new Error(q.reason)
    const leg = runLeg(h, h.decoded, WSOL_MINT, BUY, q.amountOutToUser + 1n)
    expect(leg.err).not.toBeNull()
    console.log(`[tight] err=${leg.err}\n${leg.logs.filter(l => /Error|error|failed/.test(l)).join('\n')}`)
  })
  it('gap probe: budgets where effective_quote + fees == spendable - 1 (where does the last lamport go?)', () => {
    const cases: [('canonical' | 'boosted' | 'noncanonical'), bigint][] = [['canonical', 1_002_376n], ['canonical', 1_012_501n], ['boosted', 1_000_995n], ['boosted', 1_003_001n], ['noncanonical', 1_000_995n]]
    const rows: string[] = []
    for (const [role, size] of cases) {
      const h = setup(role)
      const leg = runLeg(h, h.decoded, WSOL_MINT, size)
      const ev = leg.events.find(e => e['event'] === 'BuyEvent')
      rows.push(`${role} size=${size} err=${leg.err} amountIn=${leg.quote.amountIn} quote.out=${leg.quote.amountOutToUser} chain.out=${leg.deltas['userBase']} chain.debit=${-leg.deltas['userQuote']!} vaultIn q=${leg.quote.vaultInDelta} chain=${leg.deltas['poolQuote']} protocol+buyback=${leg.deltas['protocolAta']! + leg.deltas['buybackAta']!} creator=${leg.deltas['creatorVaultAta']} ev.quote_amount_in=${ev?.['quote_amount_in']} ev.user_quote_amount_in=${ev?.['user_quote_amount_in']} ev.lp=${ev?.['lp_fee']} ev.protocol=${ev?.['protocol_fee']} ev.creator=${ev?.['coin_creator_fee']}`)
      expect(leg.err, rows.at(-1)).toBeNull()
      expect(leg.quote.amountIn).toBe(size - 1n) // the gap case: modelled debit is one lamport below the requested budget
      expect(-leg.deltas['userQuote']!, 'debit == amountIn').toBe(leg.quote.amountIn)
      expect(leg.deltas['userBase']).toBe(leg.quote.amountOutToUser); expect(leg.deltas['poolQuote']).toBe(leg.quote.vaultInDelta)
      expect(ev?.['quote_amount_in']).toBe(size); expect(String(ev?.['user_quote_amount_in'])).toBe(leg.quote.math['effective_quote']!.split(' ')[0])
    }
    console.log(rows.join('\n'))
  })

  it('canonical: the program only needs the WSOL balance to cover the debit, not the whole budget (gap case, exact balance)', () => {
    // quote for budget 1,002,376 → debit 1,002,375; fund the WSOL ATA with EXACTLY the debit and pass the full budget as spendable_quote_in
    const h = setup('canonical')
    const q = pumpswapAdapter.quoteExactIn(h.decoded, WSOL_MINT, 1_002_376n); if (isUnsupported(q)) throw new Error(q.reason)
    expect(q.amountIn).toBe(1_002_375n)
    const rent = h.svm.rentExempt(165)
    const acct = h.svm.getAccount(h.userQuoteAta)!; const data = new Uint8Array(acct.data); data.set(writeU64LE(q.amountIn), 64)
    h.svm.svm.setAccount({ address: kitAddress(h.userQuoteAta.toBase58()), lamports: kitLamports(rent + q.amountIn), data, executable: false, programAddress: kitAddress(TOKEN_PROGRAM_ID.toBase58()), space: BigInt(data.length) })
    expect(amt(h, h.userQuoteAta)).toBe(q.amountIn)
    const leg = runLeg(h, h.decoded, WSOL_MINT, q.amountIn) // amountIn = debit; buildSwapInstruction re-derives the 1,002,376 budget
    console.log(`[exact-balance] err=${leg.err} debit=${-leg.deltas['userQuote']!} out=${leg.deltas['userBase']} quote.out=${q.amountOutToUser}`)
    expect(leg.err).toBeNull(); expect(-leg.deltas['userQuote']!).toBe(q.amountIn); expect(leg.deltas['userBase']).toBe(q.amountOutToUser); expect(amt(h, h.userQuoteAta)).toBe(0n)
  })

  it('canonical: buildSwapInstruction re-derives the budget from the debit (spendable_quote_in == quote.math.spendable_quote_in) over many sizes', () => {
    const h = setup('canonical')
    for (const size of [1_000_000n, 1_002_376n, 1_012_501n, 7_777_777n, 10_000_000n, 99_999_999n, 250_000_000n]) {
      const q = pumpswapAdapter.quoteExactIn(h.decoded, WSOL_MINT, size); if (isUnsupported(q)) throw new Error(q.reason)
      const b = pumpswapAdapter.buildSwapInstruction(h.decoded, { user: h.user, userInputAccount: h.userQuoteAta, userOutputAccount: h.userBaseAta, amountIn: q.amountIn, minimumAmountOut: q.amountOutToUser }); if (isUnsupported(b)) throw new Error(b.reason)
      const spendable = readU64LE(new Uint8Array(b.instruction.data), 8)
      expect(spendable >= size && spendable <= size + 1n, `size=${size} spendable=${spendable}`).toBe(true)
      const again = pumpswapAdapter.quoteExactIn(h.decoded, WSOL_MINT, spendable); if (isUnsupported(again)) throw new Error(again.reason)
      expect(again.amountIn).toBe(q.amountIn); expect(again.amountOutToUser >= q.amountOutToUser).toBe(true)
    }
  })
})
