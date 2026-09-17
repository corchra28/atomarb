import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { PublicKey, Keypair } from '@solana/web3.js'
import BN from 'bn.js'
import { makeSwapCpmmBaseInInstruction } from '@raydium-io/raydium-sdk-v2'
import { loadFixture, fixtureToRaw, bundleFromFixture, type FixtureFile, type AccountFixture } from '../helpers/fixtures.js'
import { isUnsupported, type AccountBundle, type DecodedPool, type PoolRef, type RawAccount, type Quote } from '../../src/adapters/types.js'
import { RaydiumCpmmAdapter, epochForSlot, SWAP_BASE_INPUT_DISCRIMINATOR, type RaydiumCpmmParams, type RaydiumSwapIxParams } from '../../src/adapters/raydium_cpmm/adapter.js'
import * as L from '../../src/adapters/raydium_cpmm/layout.js'
import * as M from '../../src/adapters/raydium_cpmm/math.js'
import { WSOL_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, EXT, associatedTokenAddress } from '../../src/state/token.js'
import { writeU64LE, writeU16LE, concatBytes, hexOf } from '../../src/util/bytes.js'
import { sha256Hex } from '../../src/util/hash.js'
import { jsonReplacer } from '../../src/util/bigint.js'

const DIR = new URL('../fixtures/raydium_cpmm/', import.meta.url).pathname
const POOL_FILES = readdirSync(DIR).filter(f => /^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(f))
const SOL_USDC = '47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4', WSOL_BERN = '9vQSDkK4HUSX7gJRVEqPu4wXmU6N7KtKx58EysDwCPCA'
const adapter = new RaydiumCpmmAdapter()
const ref = (id: string): PoolRef => ({ adapter: 'raydium_cpmm', address: new PublicKey(id), source: { kind: 'fixture', ref: `${id}.json`, observedAtUtc: '2026-09-17T13:09:45Z' } })
function load(id: string): { file: FixtureFile; bundle: AccountBundle; byRole: Record<string, AccountFixture> } {
  const file = loadFixture(`${DIR}${id}.json`)
  return { file, bundle: bundleFromFixture(file), byRole: Object.fromEntries(file.accounts.map(a => [a.note!, a])) }
}
/** rebuilds a bundle after mutating one or more fixture accounts (data/owner/pubkey) */
function bundleWith(file: FixtureFile, patch: (a: AccountFixture) => AccountFixture): AccountBundle { return bundleFromFixture({ ...file, accounts: file.accounts.map(a => patch({ ...a })) }) }
const patchData = (a: AccountFixture, f: (d: Uint8Array) => Uint8Array): AccountFixture => ({ ...a, data_base64: Buffer.from(f(new Uint8Array(Buffer.from(a.data_base64, 'base64')))).toString('base64') })
function decodeOk(id: string, bundle?: AccountBundle): DecodedPool {
  const d = adapter.decodeSnapshot(ref(id), bundle ?? load(id).bundle); if (isUnsupported(d)) throw new Error(`${d.code}: ${d.reason}`); return d
}
const feeSum = (q: Quote, mint: PublicKey) => q.fees.filter(f => f.mint.equals(mint)).reduce((s, f) => s + f.amount, 0n)

describe.each(POOL_FILES.map(f => f.replace('.json', '')))('raydium_cpmm adapter on fixture %s', id => {
  const { bundle, byRole } = load(id)
  it('requiredAccounts lists the 6 quoting dependencies and needs the pool bytes', () => {
    expect(adapter.requiredAccounts(ref(id))).toMatchObject({ status: 'UNSUPPORTED', code: 'POOL_ACCOUNT_REQUIRED' })
    const req = adapter.requiredAccounts(ref(id), fixtureToRaw(byRole['pool_state']!)); if (isUnsupported(req)) throw new Error(req.reason)
    expect(req.map(k => k.toBase58())).toEqual(['pool_state', 'amm_config', 'token_0_vault', 'token_1_vault', 'token_0_mint', 'token_1_mint'].map(r => byRole[r]!.pubkey))
    const foreign: RawAccount = { ...fixtureToRaw(byRole['pool_state']!), owner: Keypair.generate().publicKey }
    expect(adapter.requiredAccounts(ref(id), foreign)).toMatchObject({ status: 'UNSUPPORTED', code: 'WRONG_OWNER' })
  })
  it('decodeSnapshot: reserves = vault − (protocol+fund+creator) fees, epoch from slot, single-batch snapshot, validatePool ok', () => {
    const d = decodeOk(id, bundle); const p = d.params as RaydiumCpmmParams
    expect(d.reserveA).toBe(d.vaultA.amount - p.pool.protocolFeesToken0 - p.pool.fundFeesToken0 - p.pool.creatorFeesToken0)
    expect(d.reserveB).toBe(d.vaultB.amount - p.pool.protocolFeesToken1 - p.pool.fundFeesToken1 - p.pool.creatorFeesToken1)
    expect(p.epoch).toBe(epochForSlot(d.snapshot.maxSlot)); expect(p.epoch).toBe(BigInt(Math.floor(d.snapshot.maxSlot / 432_000)))
    expect(d.snapshot.singleBatch).toBe(true); expect(d.dependsOn).toHaveLength(6); expect(d.stateHash).toMatch(/^[0-9a-f]{64}$/)
    const v = adapter.validatePool(d); expect(v.rejects).toEqual([]); expect(v.ok).toBe(true)
  })
  it('quoteExactIn both directions: fee identities hold exactly (no double counting), vault deltas consistent', () => {
    const d = decodeOk(id, bundle)
    for (const [inMint, outMint] of [[d.mintA.mint, d.mintB.mint], [d.mintB.mint, d.mintA.mint]] as const) {
      const rIn = inMint.equals(d.mintA.mint) ? d.reserveA : d.reserveB
      for (const amountIn of [1_000n, 123_457n, rIn / 100n, rIn / 7n]) {
        if (amountIn === 0n) continue
        const q = adapter.quoteExactIn(d, inMint, amountIn); if (isUnsupported(q)) throw new Error(q.reason)
        if (q.rejectReasons.length && amountIn < rIn / 1_000_000n) { expect(q.rejectReasons[0]).toMatch(/REQUIRE_GT_VIOLATED/); continue } // dust in a lopsided pool → 0 out → the program rejects
        expect(q.rejectReasons, JSON.stringify(q.math)).toEqual([])
        expect(q.amountIn).toBe(amountIn); expect(q.outputMint.equals(outMint)).toBe(true)
        const lessFees = BigInt(q.math['inputAmountLessFees']!), swapped = BigInt(q.math['outputAmountSwapped']!.split(' ')[0]!)
        // input side: amountIn = transfer_fee_in + lp + protocol + fund + creator(if input) + amount that reached the curve
        expect(feeSum(q, inMint) + lessFees).toBe(amountIn)
        // output side: curve output = creator(if output) + transfer_fee_out + user credit
        expect(feeSum(q, outMint) + q.amountOutToUser).toBe(swapped)
        expect(q.vaultInDelta).toBe(amountIn - BigInt(q.math['transferFeeIn']!))
        expect(q.vaultOutDelta).toBe(swapped - (q.fees.find(f => f.name === 'creator_fee' && f.mint.equals(outMint))?.amount ?? 0n))
        expect(q.amountOutToUser).toBe(q.vaultOutDelta - BigInt(q.math['transferFeeOut']!))
        for (const f of q.fees) expect(f.alreadyIncluded).toBe(true)
        expect(q.priceImpactBps).toBeGreaterThanOrEqual(0); expect(new Set(q.accountsNeeded.map(k => k.toBase58())).size).toBe(q.accountsNeeded.length)   // distinct: both sides may share one token program
        // the trade fee (incl. LP share) is exactly ceil(lessFeesInput·rate) with rate = trade (creator off) — §5.2
        const p = d.params as RaydiumCpmmParams
        const tradeFee = q.fees.filter(f => ['lp_fee', 'protocol_fee', 'fund_fee'].includes(f.name)).reduce((s, f) => s + f.amount, 0n)
        expect(tradeFee).toBe(M.tradingFee(BigInt(q.math['actualAmountIn']!), p.config.tradeFeeRate))
      }
    }
  })
  it('applySwap advances vault amounts and fee counters so the NEXT quote uses the right reserves (pure, no mutation)', () => {
    const d = decodeOk(id, bundle); const snapshotBefore = JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    const amountIn = d.reserveA / 50n
    const q = adapter.quoteExactIn(d, d.mintA.mint, amountIn); if (isUnsupported(q)) throw new Error(q.reason)
    const n = adapter.applySwap(d, q); if (isUnsupported(n)) throw new Error(n.reason)
    expect(JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(snapshotBefore) // not mutated
    const p0 = d.params as RaydiumCpmmParams, p1 = n.params as RaydiumCpmmParams
    expect(n.vaultA.amount).toBe(d.vaultA.amount + q.vaultInDelta); expect(n.vaultB.amount).toBe(d.vaultB.amount - q.vaultOutDelta)
    expect(p1.pool.protocolFeesToken0).toBe(p0.pool.protocolFeesToken0 + q.fees.find(f => f.name === 'protocol_fee')!.amount)
    expect(p1.pool.fundFeesToken0).toBe(p0.pool.fundFeesToken0 + q.fees.find(f => f.name === 'fund_fee')!.amount)
    expect(p1.pool.protocolFeesToken1).toBe(p0.pool.protocolFeesToken1); expect(p1.pool.creatorFeesToken0).toBe(0n)
    // reserves: LP share of the trade fee stays in the vault and becomes part of the reserve (§5.3 step 8)
    const lp = q.fees.find(f => f.name === 'lp_fee')!.amount
    expect(n.reserveA).toBe(d.reserveA + BigInt(q.math['inputAmountLessFees']!) + lp)
    expect(n.reserveB).toBe(d.reserveB - BigInt(q.math['outputAmountSwapped']!.split(' ')[0]!))
    expect(n.stateHash).not.toBe(d.stateHash)
    // a quote for another state cannot be applied
    expect(adapter.applySwap(n, q)).toMatchObject({ status: 'UNSUPPORTED', code: 'STATE_HASH_MISMATCH' })
    // second quote on the new state prices off the new reserves
    const q2 = adapter.quoteExactIn(n, d.mintA.mint, amountIn); if (isUnsupported(q2)) throw new Error(q2.reason)
    expect(q2.amountOutToUser < q.amountOutToUser).toBe(true)
  })
  it('same-pool roundtrip never profits over 50 sizes (both starting sides)', () => {
    const d = decodeOk(id, bundle)
    for (const [a, b] of [[d.mintA.mint, d.mintB.mint], [d.mintB.mint, d.mintA.mint]] as const) {
      const rIn = a.equals(d.mintA.mint) ? d.reserveA : d.reserveB
      for (let i = 1; i <= 50; i++) {
        const amountIn = (rIn * BigInt(i)) / 100n + BigInt(i)
        const q1 = adapter.quoteExactIn(d, a, amountIn); if (isUnsupported(q1)) throw new Error(q1.reason)
        if (q1.rejectReasons.length) continue
        const n = adapter.applySwap(d, q1); if (isUnsupported(n)) throw new Error(n.reason)
        const q2 = adapter.quoteExactIn(n, b, q1.amountOutToUser); if (isUnsupported(q2)) throw new Error(q2.reason)
        if (q2.rejectReasons.length) continue
        expect(q2.amountOutToUser <= amountIn, `size ${i}: ${amountIn} → ${q1.amountOutToUser} → ${q2.amountOutToUser}`).toBe(true)
      }
    }
  })
  it('buildSwapInstruction: 13 accounts in §6 order with the documented flags; data = disc‖u64‖u64; equals the SDK encoder byte-for-byte', () => {
    const d = decodeOk(id, bundle); const p = d.params as RaydiumCpmmParams
    const user = Keypair.generate().publicKey
    const inMint = WSOL_MINT, outMint = d.mintA.mint.equals(WSOL_MINT) ? d.mintB.mint : d.mintA.mint
    const outProg = (d.mintA.mint.equals(outMint) ? d.mintA : d.mintB).program === 'spl_token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
    const userIn = associatedTokenAddress(user, inMint, TOKEN_PROGRAM_ID), userOut = associatedTokenAddress(user, outMint, outProg)
    const built = adapter.buildSwapInstruction(d, { user, userInputAccount: userIn, userOutputAccount: userOut, amountIn: 500_000_000n, minimumAmountOut: 123n })
    if (isUnsupported(built)) throw new Error(built.reason)
    const ix = built.instruction
    expect(ix.programId.equals(L.RAYDIUM_CPMM_PROGRAM_ID)).toBe(true); expect(ix.keys).toHaveLength(13)
    const z = d.mintA.mint.equals(inMint)
    const expected: [PublicKey, boolean, boolean][] = [
      [user, true, false], [p.authority, false, false], [p.configAddress, false, false], [d.address, false, true], [userIn, false, true], [userOut, false, true],
      [z ? d.vaultA.address : d.vaultB.address, false, true], [z ? d.vaultB.address : d.vaultA.address, false, true],
      [TOKEN_PROGRAM_ID, false, false], [outProg, false, false], [inMint, false, false], [outMint, false, false], [p.pool.observationKey, false, true],
    ]
    expected.forEach(([k, s, w], i) => { expect(ix.keys[i]!.pubkey.equals(k), `account ${i}`).toBe(true); expect(ix.keys[i]!.isSigner).toBe(s); expect(ix.keys[i]!.isWritable).toBe(w) })
    expect(hexOf(ix.data.subarray(0, 8))).toBe(hexOf(SWAP_BASE_INPUT_DISCRIMINATOR)); expect(sha256Hex('global:swap_base_input').slice(0, 16)).toBe(hexOf(SWAP_BASE_INPUT_DISCRIMINATOR))
    expect(ix.data).toEqual(Buffer.from(concatBytes(SWAP_BASE_INPUT_DISCRIMINATOR, writeU64LE(500_000_000n), writeU64LE(123n))))
    expect(built.accountsWritten.map(k => k.toBase58()).sort()).toEqual([d.address, userIn, userOut, d.vaultA.address, d.vaultB.address, p.pool.observationKey].map(k => k.toBase58()).sort())
    // SDK cross-check (raydium-sdk-v2 makeSwapCpmmBaseInInstruction, note §6)
    const sdk = makeSwapCpmmBaseInInstruction(L.RAYDIUM_CPMM_PROGRAM_ID, user, p.authority, p.configAddress, d.address, userIn, userOut, z ? d.vaultA.address : d.vaultB.address, z ? d.vaultB.address : d.vaultA.address, TOKEN_PROGRAM_ID, outProg, inMint, outMint, p.pool.observationKey, new BN('500000000'), new BN(123))
    expect(Buffer.from(ix.data).equals(Buffer.from(sdk.data))).toBe(true)
    expect(ix.keys.map(k => `${k.pubkey.toBase58()}:${k.isSigner}:${k.isWritable}`)).toEqual(sdk.keys.map(k => `${k.pubkey.toBase58()}:${k.isSigner}:${k.isWritable}`))
    // direction inference needs an ATA; explicit inputMint overrides
    const rnd = Keypair.generate().publicKey
    expect(adapter.buildSwapInstruction(d, { user, userInputAccount: rnd, userOutputAccount: userOut, amountIn: 1n, minimumAmountOut: 0n })).toMatchObject({ status: 'UNSUPPORTED', code: 'DIRECTION_UNKNOWN' })
    const explicit: RaydiumSwapIxParams = { user, userInputAccount: rnd, userOutputAccount: userOut, amountIn: 1n, minimumAmountOut: 0n, inputMint: outMint }
    const b2 = adapter.buildSwapInstruction(d, explicit); if (isUnsupported(b2)) throw new Error(b2.reason)
    expect(b2.instruction.keys[10]!.pubkey.equals(outMint)).toBe(true)
    expect(adapter.buildSwapInstruction(d, { ...explicit, amountIn: 1n << 64n })).toMatchObject({ status: 'UNSUPPORTED', code: 'U64_OVERFLOW' })
  })
})

describe('raydium_cpmm validation rejects (mutated fixtures)', () => {
  const { file, bundle } = load(SOL_USDC)
  const d0 = decodeOk(SOL_USDC, bundle)
  it('wrong pool owner → POOL_OWNER', () => {
    const d = decodeOk(SOL_USDC, bundleWith(file, a => (a.note === 'pool_state' ? { ...a, owner: Keypair.generate().publicKey.toBase58() } : a)))
    expect(adapter.validatePool(d).rejects.map(r => r.code)).toContain('POOL_OWNER')
  })
  it('vault that is not PDA["pool_vault", pool, mint] → VAULT_PDA_MISMATCH (even though it is a valid token account with the right mint/owner)', () => {
    const fake = Keypair.generate().publicKey
    const b = bundleWith(file, a => {
      if (a.note === 'token_0_vault') return { ...a, pubkey: fake.toBase58() }
      if (a.note === 'pool_state') return patchData(a, d => { d.set(fake.toBytes(), L.POOL_OFF.TOKEN_0_VAULT); return d })
      return a
    })
    const d = decodeOk(SOL_USDC, b); const v = adapter.validatePool(d)
    expect(v.ok).toBe(false); expect(v.rejects.map(r => r.code)).toContain('VAULT_PDA_MISMATCH')
  })
  it('vault owned by someone other than the authority PDA → VAULT_OWNER; frozen vault → VAULT_FROZEN', () => {
    const b = bundleWith(file, a => (a.note === 'token_1_vault' ? patchData(a, d => { d.set(Keypair.generate().publicKey.toBytes(), 32); return d }) : a))
    expect(adapter.validatePool(decodeOk(SOL_USDC, b)).rejects.map(r => r.code)).toContain('VAULT_OWNER')
    const f = bundleWith(file, a => (a.note === 'token_1_vault' ? patchData(a, d => { d[108] = 2; return d }) : a))
    expect(adapter.validatePool(decodeOk(SOL_USDC, f)).rejects.map(r => r.code)).toContain('VAULT_FROZEN')
  })
  it('status bit2 set (swap disabled) → SWAP_DISABLED; bits 0/1 only warn', () => {
    const b = bundleWith(file, a => (a.note === 'pool_state' ? patchData(a, d => { d[L.POOL_OFF.STATUS] = 4; return d }) : a))
    expect(adapter.validatePool(decodeOk(SOL_USDC, b)).rejects.map(r => r.code)).toContain('SWAP_DISABLED')
    const c = bundleWith(file, a => (a.note === 'pool_state' ? patchData(a, d => { d[L.POOL_OFF.STATUS] = 3; return d }) : a))
    const v = adapter.validatePool(decodeOk(SOL_USDC, c)); expect(v.ok).toBe(true); expect(v.warnings.map(w => w.code)).toContain('LP_OPS_DISABLED')
  })
  it('open_time in the future (relative to the snapshot wall clock, never slot-derived) → NOT_OPEN; params.nowUnix override respected', () => {
    const now = Math.floor(Date.parse(d0.snapshot.receivedAtUtc) / 1000)
    const b = bundleWith(file, a => (a.note === 'pool_state' ? patchData(a, d => { d.set(writeU64LE(BigInt(now + 3600)), L.POOL_OFF.OPEN_TIME); return d }) : a))
    const d = decodeOk(SOL_USDC, b)
    expect(adapter.validatePool(d).rejects.map(r => r.code)).toContain('NOT_OPEN')
    const later: DecodedPool = { ...d, params: { ...d.params, nowUnix: now + 3600 } }
    expect(adapter.validatePool(later).rejects.map(r => r.code)).not.toContain('NOT_OPEN')
    const eq: DecodedPool = { ...d, params: { ...d.params, nowUnix: now + 3599 } }
    expect(adapter.validatePool(eq).rejects.map(r => r.code)).toContain('NOT_OPEN')
  })
  it('token program field mismatch → TOKEN_PROGRAM_MISMATCH; creator_fee_on out of range → INVALID_FEE_MODEL; auth_bump wrong → AUTH_BUMP', () => {
    const b = bundleWith(file, a => (a.note === 'pool_state' ? patchData(a, d => { d.set(TOKEN_2022_PROGRAM_ID.toBytes(), L.POOL_OFF.TOKEN_1_PROGRAM); return d }) : a))
    expect(adapter.validatePool(decodeOk(SOL_USDC, b)).rejects.map(r => r.code)).toContain('TOKEN_PROGRAM_MISMATCH')
    const c = bundleWith(file, a => (a.note === 'pool_state' ? patchData(a, d => { d[L.POOL_OFF.CREATOR_FEE_ON] = 3; return d }) : a))
    expect(adapter.validatePool(decodeOk(SOL_USDC, c)).rejects.map(r => r.code)).toContain('INVALID_FEE_MODEL')
    const e = bundleWith(file, a => (a.note === 'pool_state' ? patchData(a, d => { d[L.POOL_OFF.AUTH_BUMP] = 252; return d }) : a))
    expect(adapter.validatePool(decodeOk(SOL_USDC, e)).rejects.map(r => r.code)).toContain('AUTH_BUMP')
  })
  it('non-WSOL pool → QUOTE_NOT_WSOL', () => {
    // swap the WSOL mint account for a fabricated SPL mint at a different address and point the pool at it (vault PDA re-derived so only the WSOL rule fails)
    const fakeMint = Keypair.generate().publicKey
    const [fakeVault] = L.poolVaultPda(new PublicKey(SOL_USDC), fakeMint)
    const b = bundleWith(file, a => {
      if (a.note === 'token_0_mint') return { ...a, pubkey: fakeMint.toBase58() }
      if (a.note === 'token_0_vault') return { ...patchData(a, d => { d.set(fakeMint.toBytes(), 0); return d }), pubkey: fakeVault.toBase58() }
      if (a.note === 'pool_state') return patchData(a, d => { d.set(fakeMint.toBytes(), L.POOL_OFF.TOKEN_0_MINT); d.set(fakeVault.toBytes(), L.POOL_OFF.TOKEN_0_VAULT); return d })
      return a
    })
    const v = adapter.validatePool(decodeOk(SOL_USDC, b))
    expect(v.rejects.map(r => r.code)).toEqual(['QUOTE_NOT_WSOL'])
  })
  it('unknown pool layout → UNSUPPORTED UNKNOWN_LAYOUT from decodeSnapshot; missing dependents → ACCOUNTS_MISSING', () => {
    const b = bundleWith(file, a => (a.note === 'pool_state' ? patchData(a, d => d.subarray(0, 600)) : a))
    expect(adapter.decodeSnapshot(ref(SOL_USDC), b)).toMatchObject({ status: 'UNSUPPORTED', code: 'UNKNOWN_LAYOUT' })
    const partial = bundleFromFixture({ ...file, accounts: file.accounts.filter(a => a.note !== 'token_1_mint') })
    expect(adapter.decodeSnapshot(ref(SOL_USDC), partial)).toMatchObject({ status: 'UNSUPPORTED', code: 'ACCOUNTS_MISSING' })
  })
})

describe('raydium_cpmm Token-2022 handling (WSOL/BERN fixture)', () => {
  const { file, bundle } = load(WSOL_BERN)
  it('BERN mint carries only TransferFeeConfig → allowed; quote nets the output transfer fee at the snapshot epoch', () => {
    const d = decodeOk(WSOL_BERN, bundle); const p = d.params as RaydiumCpmmParams
    expect(d.mintB.program).toBe('token_2022'); expect(d.mintB.extensions).toEqual([EXT.TransferFeeConfig])
    const v = adapter.validatePool(d); expect(v.ok, JSON.stringify(v.rejects)).toBe(true); expect(v.warnings.map(w => w.code)).toContain('TRANSFER_FEE')
    expect(p.transferFee1).toEqual({ older: { epoch: 624n, maxFee: 3_906_250_000_000_000_000n, bps: 420 }, newer: { epoch: 698n, maxFee: 3_906_250_000_000_000_000n, bps: 269 } })
    const q = adapter.quoteExactIn(d, WSOL_MINT, 1_000_000n); if (isUnsupported(q)) throw new Error(q.reason)
    const tfOut = q.fees.find(f => f.name === 'token2022_transfer_fee_out')!
    expect(tfOut.bps).toBe(269); expect(tfOut.amount).toBe(M.transferFeeCalculateFee(p.transferFee1!.newer, q.vaultOutDelta))
    expect(q.amountOutToUser).toBe(q.vaultOutDelta - tfOut.amount)
    // reverse direction: fee on input reduces what reaches the curve
    const q2 = adapter.quoteExactIn(d, d.mintB.mint, 10_000_000n); if (isUnsupported(q2)) throw new Error(q2.reason)
    const tfIn = q2.fees.find(f => f.name === 'token2022_transfer_fee_in')!
    expect(tfIn.amount).toBe(M.transferFeeCalculateFee(p.transferFee1!.newer, 10_000_000n)); expect(q2.vaultInDelta).toBe(10_000_000n - tfIn.amount)
    // an older epoch selects the older tier (420 bps)
    const dOld: DecodedPool = { ...d, params: { ...d.params, epoch: 697n } }
    const q3 = adapter.quoteExactIn(dOld, d.mintB.mint, 10_000_000n); if (isUnsupported(q3)) throw new Error(q3.reason)
    expect(q3.fees.find(f => f.name === 'token2022_transfer_fee_in')!.amount).toBe(M.transferFeeCalculateFee(p.transferFee1!.older, 10_000_000n))
  })
  it('a disallowed Token-2022 extension (PermanentDelegate) on a pool mint → TOKEN2022_EXTENSION', () => {
    const b = bundleWith(file, a => (a.note === 'token_1_mint' ? patchData(a, d => concatBytes(d, writeU16LE(EXT.PermanentDelegate), writeU16LE(32), new Uint8Array(32))) : a))
    const d = decodeOk(WSOL_BERN, b); expect(d.mintB.extensions).toEqual([EXT.TransferFeeConfig, EXT.PermanentDelegate])
    expect(adapter.validatePool(d).rejects.map(r => r.code)).toContain('TOKEN2022_EXTENSION')
    const hook = bundleWith(file, a => (a.note === 'token_1_mint' ? patchData(a, d => concatBytes(d, writeU16LE(EXT.TransferHook), writeU16LE(64), new Uint8Array(64))) : a))
    expect(adapter.validatePool(decodeOk(WSOL_BERN, hook)).rejects.map(r => r.code)).toContain('TOKEN2022_EXTENSION')
  })
  it('exact-out cross-check: quoteExactOut(inverse) then quoteExactIn covers the requested amount', () => {
    const d = decodeOk(WSOL_BERN, bundle)
    // NOTE: this pool's fee-adjusted reserves are tiny (811 lamports / 9,640 BERN units at the snapshot) — sizes are relative to reserveB
    for (const want of [1n, d.reserveB / 100n, d.reserveB / 10n]) {
      const eo = adapter.quoteExactOut(d, WSOL_MINT, want); if (isUnsupported(eo)) throw new Error(eo.reason)
      expect(eo.ok, JSON.stringify(eo, jsonReplacer)).toBe(true); if (!eo.ok) continue
      const ei = adapter.quoteExactIn(d, WSOL_MINT, eo.inputTransferAmount); if (isUnsupported(ei)) throw new Error(ei.reason)
      expect(ei.amountOutToUser >= want).toBe(true)
    }
    // asking for more than the vault holds → the program would panic in swap_base_output_without_fees (checked_sub unwrap) → reported, not thrown
    expect(adapter.quoteExactOut(d, WSOL_MINT, d.reserveB * 2n)).toMatchObject({ ok: false, code: 'OVERFLOW' })
    // SOL/USDC exact-out (no transfer fees): the inverse is tight to within the ceil rounding of base-output
    const big = decodeOk(SOL_USDC)
    for (const want of [1_000n, 1_000_000n, big.reserveB / 50n]) {
      const eo = adapter.quoteExactOut(big, WSOL_MINT, want); if (isUnsupported(eo)) throw new Error(eo.reason)
      expect(eo.ok).toBe(true); if (!eo.ok) continue
      const ei = adapter.quoteExactIn(big, WSOL_MINT, eo.inputTransferAmount); if (isUnsupported(ei)) throw new Error(ei.reason)
      expect(ei.amountOutToUser >= want).toBe(true)
      const less = adapter.quoteExactIn(big, WSOL_MINT, eo.inputTransferAmount - 1n); if (isUnsupported(less)) throw new Error(less.reason)
      expect(less.amountOutToUser <= want).toBe(true)
    }
  })
})

describe('raydium_cpmm Token-2022 handling (WSOL/LOOP 3% fee and WSOL/SolARBa fee-switched-off fixtures)', () => {
  const LOOP = 'A3URwhZE2YyVNKL9CmSvU9VG1oJoZS78kX4AdK5faDud', SOLARBA = '3ceKnrpPPUuz9FVsDJuYfTqbK5ia6KND7SQwcnRJ38KC'
  it.skipIf(!POOL_FILES.includes(`${LOOP}.json`))('LOOP: MetadataPointer+TokenMetadata are allowed; 300 bps fee applied on output (WSOL in) and on input (LOOP in)', () => {
    const d = decodeOk(LOOP); const p = d.params as RaydiumCpmmParams
    expect(d.mintB.extensions).toEqual([EXT.TransferFeeConfig, EXT.MetadataPointer, EXT.TokenMetadata])
    const v = adapter.validatePool(d); expect(v.ok, JSON.stringify(v.rejects)).toBe(true)
    const q = adapter.quoteExactIn(d, WSOL_MINT, 500_000_000n); if (isUnsupported(q)) throw new Error(q.reason)
    const tf = q.fees.find(f => f.name === 'token2022_transfer_fee_out')!; expect(tf.bps).toBe(300)
    expect(tf.amount).toBe((q.vaultOutDelta * 300n + 9_999n) / 10_000n); expect(q.amountOutToUser).toBe(q.vaultOutDelta - tf.amount)
    const q2 = adapter.quoteExactIn(d, d.mintB.mint, 1_000_000_000_000n); if (isUnsupported(q2)) throw new Error(q2.reason)
    const tfIn = q2.fees.find(f => f.name === 'token2022_transfer_fee_in')!; expect(tfIn.amount).toBe(30_000_000_000n); expect(q2.vaultInDelta).toBe(970_000_000_000n)
    expect(BigInt(q2.math['actualAmountIn']!)).toBe(970_000_000_000n); expect(p.transferFee1!.newer.bps).toBe(300)
  })
  it.skipIf(!POOL_FILES.includes(`${SOLARBA}.json`))('SolARBa: newer tier (0 bps since epoch 671) applies at epoch 1036; the older 200 bps tier applies before epoch 671', () => {
    const d = decodeOk(SOLARBA); const p = d.params as RaydiumCpmmParams
    expect(p.transferFee1).toEqual({ older: { epoch: 647n, maxFee: 1_000_000_000_000n, bps: 200 }, newer: { epoch: 671n, maxFee: 1_000_000_000_000n, bps: 0 } })
    expect(adapter.validatePool(d).ok).toBe(true)
    const q = adapter.quoteExactIn(d, WSOL_MINT, 100_000_000n); if (isUnsupported(q)) throw new Error(q.reason)
    expect(q.fees.find(f => f.name === 'token2022_transfer_fee_out')!.amount).toBe(0n); expect(q.amountOutToUser).toBe(q.vaultOutDelta)
    const old: DecodedPool = { ...d, params: { ...d.params, epoch: 670n } }
    const qo = adapter.quoteExactIn(old, WSOL_MINT, 100_000_000n); if (isUnsupported(qo)) throw new Error(qo.reason)
    expect(qo.fees.find(f => f.name === 'token2022_transfer_fee_out')!.amount).toBe((qo.vaultOutDelta * 200n + 9_999n) / 10_000n)
    expect(qo.amountOutToUser < q.amountOutToUser).toBe(true)
  })
})

describe('raydium_cpmm creator fee (unit-only: no fixture pool has enable_creator_fee=true; see note §12.1)', () => {
  const { file } = load(SOL_USDC)
  const withCreator = (on: number) => bundleWith(file, a => (a.note === 'pool_state' ? patchData(a, d => { d[L.POOL_OFF.ENABLE_CREATOR_FEE] = 1; d[L.POOL_OFF.CREATOR_FEE_ON] = on; return d }) : a))
  it('BothToken: creator fee on input uses ceil(total) then floor split; counters accrue on the input token', () => {
    const d = decodeOk(SOL_USDC, withCreator(0)); const p = d.params as RaydiumCpmmParams
    expect(adapter.validatePool(d).ok).toBe(true)
    const amountIn = 1_000_000_007n
    const q = adapter.quoteExactIn(d, WSOL_MINT, amountIn); if (isUnsupported(q)) throw new Error(q.reason)
    const total = M.tradingFee(amountIn, p.config.tradeFeeRate + p.config.creatorFeeRate)!
    const creator = M.splitCreatorFee(total, p.config.tradeFeeRate, p.config.creatorFeeRate)!
    expect(q.fees.find(f => f.name === 'creator_fee')!.amount).toBe(creator); expect(q.fees.find(f => f.name === 'creator_fee')!.mint.equals(WSOL_MINT)).toBe(true)
    expect(feeSum(q, WSOL_MINT) + BigInt(q.math['inputAmountLessFees']!)).toBe(amountIn)
    expect(BigInt(q.math['inputAmountLessFees']!)).toBe(amountIn - total)
    const n = adapter.applySwap(d, q); if (isUnsupported(n)) throw new Error(n.reason)
    expect((n.params as RaydiumCpmmParams).pool.creatorFeesToken0).toBe(creator); expect(n.reserveA).toBe(n.vaultA.amount - (n.params as RaydiumCpmmParams).pool.protocolFeesToken0 - (n.params as RaydiumCpmmParams).pool.fundFeesToken0 - creator)
  })
  it('OnlyToken1 with WSOL(token0) input: creator fee is taken on the OUTPUT (ceil) and accrues on token1', () => {
    const d = decodeOk(SOL_USDC, withCreator(2)); const p = d.params as RaydiumCpmmParams
    const q = adapter.quoteExactIn(d, WSOL_MINT, 1_000_000_000n); if (isUnsupported(q)) throw new Error(q.reason)
    const cf = q.fees.find(f => f.name === 'creator_fee')!
    expect(cf.mint.equals(d.mintB.mint)).toBe(true)
    const swapped = BigInt(q.math['outputAmountSwapped']!.split(' ')[0]!)
    expect(cf.amount).toBe(M.creatorFeeOf(swapped, p.config.creatorFeeRate)); expect(q.vaultOutDelta).toBe(swapped - cf.amount)
    const n = adapter.applySwap(d, q); if (isUnsupported(n)) throw new Error(n.reason)
    expect((n.params as RaydiumCpmmParams).pool.creatorFeesToken1).toBe(cf.amount); expect((n.params as RaydiumCpmmParams).pool.creatorFeesToken0).toBe(0n)
    // reverse direction (token1 input) → on input for OnlyToken1
    const q2 = adapter.quoteExactIn(d, d.mintB.mint, 1_000_000n); if (isUnsupported(q2)) throw new Error(q2.reason)
    expect(q2.fees.find(f => f.name === 'creator_fee')!.mint.equals(d.mintB.mint)).toBe(true)
  })
})

describe('raydium_cpmm overflow detection at the adapter boundary', () => {
  const { bundle } = load(SOL_USDC)
  it('amountIn beyond u64 or beyond what the vault can hold is rejected, never a fake quote', () => {
    const d = decodeOk(SOL_USDC, bundle)
    const a = adapter.quoteExactIn(d, WSOL_MINT, 1n << 64n); if (isUnsupported(a)) throw new Error(a.reason)
    expect(a.rejectReasons[0]).toMatch(/U64_OVERFLOW/); expect(a.amountOutToUser).toBe(0n); expect(a.fees).toEqual([])
    const b = adapter.quoteExactIn(d, WSOL_MINT, (1n << 64n) - 1n); if (isUnsupported(b)) throw new Error(b.reason)
    expect(b.rejectReasons[0]).toMatch(/U64_OVERFLOW_VAULT/)
    expect(adapter.applySwap(d, b)).toMatchObject({ status: 'UNSUPPORTED', code: 'QUOTE_REJECTED' })
    expect(adapter.quoteExactIn(d, Keypair.generate().publicKey, 1n)).toMatchObject({ status: 'UNSUPPORTED', code: 'MINT_NOT_IN_POOL' })
    const tiny = adapter.quoteExactIn(d, WSOL_MINT, 1n); if (isUnsupported(tiny)) throw new Error(tiny.reason)
    expect(tiny.rejectReasons.length).toBeGreaterThan(0) // 1 lamport: ceil trade fee eats it → nothing reaches the curve
  })
})
