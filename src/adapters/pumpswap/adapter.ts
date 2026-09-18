/**
 * PumpSwap AMM adapter (pools quoted in WSOL). Read-only research code: builds instructions but never signs or submits.
 * Facts cited as pumpswap.md §N / token2022.md §N come from docs/sources/*.md (verified against IDL / SDK / mainnet bytes).
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { AccountBundle, AdapterId, DecodedPool, FeeItem, PoolAdapter, PoolRef, Quote, RawAccount, SwapIxParams, Unsupported, ValidationResult } from '../types.js'
import { unsupported, isUnsupported } from '../types.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, associatedTokenAddress, parseMint, parseTokenAccount } from '../../state/token.js'
import { stateHashOf } from '../../state/snapshot.js'
import { sha256Hex } from '../../util/hash.js'
import { concatBytes, writeU64LE } from '../../util/bytes.js'
import {
  PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, GLOBAL_CONFIG_PDA, FEE_CONFIG_PDA, EVENT_AUTHORITY_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA, DISABLE_FLAG, IX_DISC,
  decodePool, decodeGlobalConfig, decodeFeeConfig, userVolumeAccumulatorPda, coinCreatorVaultAuthorityPda, poolV2Pda, poolPda,
  type PumpPool, type PumpGlobalConfig, type PumpFeeConfig,
} from './layout.js'
import { isPumpPool, selectFeeSchedule, type FeeSchedule } from './fees.js'
import { buyQuoteInput, sellBaseInput, token2022Gate, transferFeeAmount, transferFeeAmountWorstCase, type PoolMathState, type Token2022Gate } from './math.js'

export const PUMPSWAP_ADAPTER_ID: AdapterId = 'pumpswap'

/** Adapter-specific decoded state stored in DecodedPool.params (typed view). */
export interface PumpswapParams {
  pool: PumpPool
  globalConfig: PumpGlobalConfig
  feeConfig: PumpFeeConfig
  owners: { pool: string; globalConfig: string; feeConfig: string }
  virtualQuoteReserves: bigint
  effectiveQuoteReserve: bigint
  coinCreator: string
  creator: string
  index: number
  isMayhemMode: boolean
  isCashbackCoin: boolean
  isHolderReward: boolean
  creatorFeeBps: bigint
  canonical: boolean
  feeSchedule: FeeSchedule | null
  feeScheduleError: string | null
  disableFlags: number
  layoutLength: number
  globalConfigLength: number
  feeConfigLength: number
  baseTokenProgram: string
  quoteTokenProgram: string
  token2022: Token2022Gate
  /** number of applySwap transitions applied since the snapshot (0 = live snapshot) */
  swapsApplied: number
}
export function pumpswapParams(d: DecodedPool): PumpswapParams {
  if (d.adapter !== PUMPSWAP_ADAPTER_ID) throw new Error(`not a pumpswap pool: ${d.adapter}`)
  return d.params as unknown as PumpswapParams
}
const tokenProgramOf = (kind: 'spl_token' | 'token_2022'): PublicKey => (kind === 'token_2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)

/** Fee recipient policy: deterministic FIRST entry (see buildSwapInstruction doc). Mayhem pools use reserved_fee_recipient (pumpswap.md §6 account 9). */
export function protocolFeeRecipientFor(gc: PumpGlobalConfig, isMayhemMode: boolean): PublicKey {
  return isMayhemMode ? gc.reservedFeeRecipient : gc.protocolFeeRecipients[0]!
}
export function buybackFeeRecipientFor(gc: PumpGlobalConfig): PublicKey { return gc.buybackFeeRecipients[0]! }

export class PumpswapAdapter implements PoolAdapter {
  readonly id: AdapterId = PUMPSWAP_ADAPTER_ID
  readonly programId = PUMP_AMM_PROGRAM_ID

  /** Step 1 (no pool account yet): fetch the pool. Step 2: the 7 accounts a quote depends on (pumpswap.md §2/§3/§4). */
  requiredAccounts(pool: PoolRef, poolAccount?: RawAccount): PublicKey[] | Unsupported {
    if (!poolAccount) return [pool.address]
    if (!poolAccount.owner.equals(PUMP_AMM_PROGRAM_ID)) return unsupported('POOL_OWNER_MISMATCH', `pool ${pool.address.toBase58()} owner ${poolAccount.owner.toBase58()} != pump_amm`)
    const p = decodePool(poolAccount.data)
    if (isUnsupported(p)) return p
    return [pool.address, GLOBAL_CONFIG_PDA, FEE_CONFIG_PDA, p.baseMint, p.quoteMint, p.poolBaseTokenAccount, p.poolQuoteTokenAccount]
  }

  decodeSnapshot(pool: PoolRef, bundle: AccountBundle): DecodedPool | Unsupported {
    const get = (k: PublicKey): RawAccount | undefined => bundle.accounts.get(k.toBase58())
    const poolAcc = get(pool.address); if (!poolAcc) return unsupported('ACCOUNT_MISSING', `pool ${pool.address.toBase58()}`)
    if (!poolAcc.owner.equals(PUMP_AMM_PROGRAM_ID)) return unsupported('POOL_OWNER_MISMATCH', `owner ${poolAcc.owner.toBase58()}`)
    const p = decodePool(poolAcc.data); if (isUnsupported(p)) return p
    const keys = [pool.address, GLOBAL_CONFIG_PDA, FEE_CONFIG_PDA, p.baseMint, p.quoteMint, p.poolBaseTokenAccount, p.poolQuoteTokenAccount]
    const missing = keys.filter(k => !get(k)); if (missing.length) return unsupported('ACCOUNT_MISSING', missing.map(m => m.toBase58()).join(','))
    const gcAcc = get(GLOBAL_CONFIG_PDA)!, fcAcc = get(FEE_CONFIG_PDA)!, bmAcc = get(p.baseMint)!, qmAcc = get(p.quoteMint)!, bvAcc = get(p.poolBaseTokenAccount)!, qvAcc = get(p.poolQuoteTokenAccount)!
    const gc = decodeGlobalConfig(gcAcc.data); if (isUnsupported(gc)) return gc
    const fc = decodeFeeConfig(fcAcc.data); if (isUnsupported(fc)) return fc
    let mintA, mintB, vaultA, vaultB
    try { mintA = parseMint(bmAcc); mintB = parseMint(qmAcc) } catch (e) { return unsupported('MINT_PARSE', (e as Error).message) }
    try { vaultA = parseTokenAccount(bvAcc); vaultB = parseTokenAccount(qvAcc) } catch (e) { return unsupported('VAULT_PARSE', (e as Error).message) }
    const gate = token2022Gate(bmAcc, mintA)
    const effQ = vaultB.amount + p.virtualQuoteReserves
    const sched = selectFeeSchedule({ pool: p, globalConfig: gc, feeConfig: fc, baseMintSupply: mintA.supply, baseReserve: vaultA.amount, effectiveQuoteReserve: effQ })
    const params: PumpswapParams = {
      pool: p, globalConfig: gc, feeConfig: fc, owners: { pool: poolAcc.owner.toBase58(), globalConfig: gcAcc.owner.toBase58(), feeConfig: fcAcc.owner.toBase58() },
      virtualQuoteReserves: p.virtualQuoteReserves, effectiveQuoteReserve: effQ, coinCreator: p.coinCreator.toBase58(), creator: p.creator.toBase58(), index: p.index,
      isMayhemMode: p.isMayhemMode, isCashbackCoin: p.isCashbackCoin, isHolderReward: p.isHolderReward, creatorFeeBps: p.creatorFeeBps, canonical: isPumpPool(p.baseMint, p.creator),
      feeSchedule: isUnsupported(sched) ? null : sched, feeScheduleError: isUnsupported(sched) ? `${sched.code}: ${sched.reason}` : null, disableFlags: gc.disableFlags,
      layoutLength: p.layoutLength, globalConfigLength: gc.layoutLength, feeConfigLength: fc.layoutLength, baseTokenProgram: mintA.program, quoteTokenProgram: mintB.program, token2022: gate, swapsApplied: 0,
    }
    return {
      adapter: this.id, address: pool.address, programId: PUMP_AMM_PROGRAM_ID, mintA, mintB, vaultA, vaultB, reserveA: vaultA.amount, reserveB: vaultB.amount,
      params: params as unknown as Record<string, unknown>, dependsOn: keys, stateHash: stateHashOf(keys, bundle),
      snapshot: { minSlot: bundle.minSlot, maxSlot: bundle.maxSlot, singleBatch: bundle.singleBatch, batchIds: [...bundle.batchIds], receivedAtUtc: poolAcc.receivedAtUtc },
      layoutVersion: `pool:${p.layoutLength}|global_config:${gc.layoutLength}|fee_config:${fc.layoutLength}`,
    }
  }

  validatePool(d: DecodedPool): ValidationResult {
    const rejects: { code: string; detail: string }[] = []; const warnings: { code: string; detail: string }[] = []
    const P = pumpswapParams(d); const p = P.pool
    const R = (code: string, detail: string) => rejects.push({ code, detail }); const W = (code: string, detail: string) => warnings.push({ code, detail })
    if (P.owners.pool !== PUMP_AMM_PROGRAM_ID.toBase58()) R('POOL_OWNER_MISMATCH', P.owners.pool)
    if (P.owners.globalConfig !== PUMP_AMM_PROGRAM_ID.toBase58()) R('GLOBAL_CONFIG_OWNER_MISMATCH', P.owners.globalConfig)
    if (P.owners.feeConfig !== PUMP_FEE_PROGRAM_ID.toBase58()) R('FEE_CONFIG_OWNER_MISMATCH', P.owners.feeConfig)
    // pumpswap.md §7: pool PDA = ["pool", index, creator, base_mint, quote_mint]
    const expectedPda = poolPda(p.index, p.creator, p.baseMint, p.quoteMint)
    if (!expectedPda.equals(d.address)) R('POOL_PDA_MISMATCH', `expected ${expectedPda.toBase58()} for (index=${p.index}, creator, base, quote)`)
    // quote must be WSOL (this adapter only prices SOL-quoted pools)
    if (!p.quoteMint.equals(WSOL_MINT)) R('QUOTE_NOT_WSOL', p.quoteMint.toBase58())
    if (!d.mintA.mint.equals(p.baseMint)) R('BASE_MINT_MISMATCH', `${d.mintA.mint.toBase58()} != pool.base_mint`)
    if (!d.mintB.mint.equals(p.quoteMint)) R('QUOTE_MINT_MISMATCH', `${d.mintB.mint.toBase58()} != pool.quote_mint`)
    // token programs: mints must be owned by SPL Token or Token-2022 (parseMint guarantees one of the two)
    const baseTp = tokenProgramOf(d.mintA.program), quoteTp = tokenProgramOf(d.mintB.program)
    if (d.mintB.program !== 'spl_token') R('QUOTE_TOKEN_PROGRAM', `WSOL must be SPL Token, got ${d.mintB.program}`)
    // vaults: address == pool field == ATA(pool, mint, token program) (pumpswap.md §2); mint/owner/program/state
    const expBaseVault = associatedTokenAddress(d.address, p.baseMint, baseTp), expQuoteVault = associatedTokenAddress(d.address, p.quoteMint, quoteTp)
    if (!d.vaultA.address.equals(p.poolBaseTokenAccount)) R('BASE_VAULT_ADDRESS', `${d.vaultA.address.toBase58()} != pool.pool_base_token_account`)
    if (!d.vaultB.address.equals(p.poolQuoteTokenAccount)) R('QUOTE_VAULT_ADDRESS', `${d.vaultB.address.toBase58()} != pool.pool_quote_token_account`)
    if (!p.poolBaseTokenAccount.equals(expBaseVault)) R('BASE_VAULT_NOT_ATA', `pool.pool_base_token_account != ATA(pool, base_mint, ${d.mintA.program})`)
    if (!p.poolQuoteTokenAccount.equals(expQuoteVault)) R('QUOTE_VAULT_NOT_ATA', `pool.pool_quote_token_account != ATA(pool, quote_mint, ${d.mintB.program})`)
    if (!d.vaultA.mint.equals(p.baseMint)) R('BASE_VAULT_MINT', `${d.vaultA.mint.toBase58()} != base_mint`)
    if (!d.vaultB.mint.equals(p.quoteMint)) R('QUOTE_VAULT_MINT', `${d.vaultB.mint.toBase58()} != quote_mint`)
    if (!d.vaultA.owner.equals(d.address)) R('BASE_VAULT_OWNER', `${d.vaultA.owner.toBase58()} != pool`)
    if (!d.vaultB.owner.equals(d.address)) R('QUOTE_VAULT_OWNER', `${d.vaultB.owner.toBase58()} != pool`)
    if (d.vaultA.program !== d.mintA.program) R('BASE_VAULT_PROGRAM', `vault ${d.vaultA.program} != mint ${d.mintA.program}`)
    if (d.vaultB.program !== d.mintB.program) R('QUOTE_VAULT_PROGRAM', `vault ${d.vaultB.program} != mint ${d.mintB.program}`)
    if (d.vaultA.state === 2) R('BASE_VAULT_FROZEN', d.vaultA.address.toBase58())
    if (d.vaultB.state === 2) R('QUOTE_VAULT_FROZEN', d.vaultB.address.toBase58())
    if (d.reserveA !== d.vaultA.amount || d.reserveB !== d.vaultB.amount) R('RESERVE_MISMATCH', 'reserves must equal raw vault amounts')
    // pumpswap.md §3: disable_flags bit 3 = buy, bit 4 = sell
    if (P.disableFlags & DISABLE_FLAG.buy) R('BUY_DISABLED', `disable_flags=${P.disableFlags}`)
    if (P.disableFlags & DISABLE_FLAG.sell) R('SELL_DISABLED', `disable_flags=${P.disableFlags}`)
    if (P.virtualQuoteReserves < 0n) R('NEGATIVE_VIRTUAL_QUOTE_RESERVES', String(P.virtualQuoteReserves))
    if (d.reserveA === 0n || P.effectiveQuoteReserve <= 0n) R('EMPTY_POOL', `base=${d.reserveA} effectiveQuote=${P.effectiveQuoteReserve}`)
    if (P.feeSchedule === null) R('FEE_SCHEDULE', P.feeScheduleError ?? 'unknown')
    for (const r of P.token2022.rejects) rejects.push(r)
    for (const w of P.token2022.warnings) warnings.push(w)
    if (P.virtualQuoteReserves > 0n) W('BOOST_POOL', `virtual_quote_reserves=${P.virtualQuoteReserves}: sells are capped by the real vault (pumpswap.md §5c)`)
    if (!P.canonical && !p.coinCreator.equals(PublicKey.default)) W('NONCANONICAL_WITH_COIN_CREATOR', 'IDL error 6028 says only canonical pools may have a coin creator')
    if (p.isCashbackCoin) W('CASHBACK_COIN', 'creator fee routed as cashback; extra remaining accounts appended (pumpswap.md §6)')
    if (P.pool.defaultedFields.length) W('POOL_SHORT_LAYOUT', `length ${P.layoutLength}; defaulted: ${P.pool.defaultedFields.join(',')}`)
    if (!PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'), d.address.toBuffer()], PUMP_AMM_PROGRAM_ID)[0].equals(p.lpMint)) W('LP_MINT_PDA_MISMATCH', p.lpMint.toBase58())
    return { ok: rejects.length === 0, rejects, warnings }
  }

  private mathState(d: DecodedPool): PoolMathState {
    const P = pumpswapParams(d)
    return { baseReserve: d.reserveA, quoteReserve: d.reserveB, virtualQuoteReserves: P.virtualQuoteReserves }
  }
  private schedule(d: DecodedPool): FeeSchedule | Unsupported {
    const P = pumpswapParams(d)
    return selectFeeSchedule({ pool: P.pool, globalConfig: P.globalConfig, feeConfig: P.feeConfig, baseMintSupply: d.mintA.supply, baseReserve: d.reserveA, effectiveQuoteReserve: d.reserveB + P.virtualQuoteReserves })
  }
  /** pool-level accounts a swap touches (user-specific ones excluded); see buildSwapInstruction for the ordered list. */
  private poolAccounts(d: DecodedPool): PublicKey[] {
    const P = pumpswapParams(d); const p = P.pool
    const quoteTp = tokenProgramOf(d.mintB.program), baseTp = tokenProgramOf(d.mintA.program)
    const protocolFeeRecipient = protocolFeeRecipientFor(P.globalConfig, p.isMayhemMode)
    const buyback = buybackFeeRecipientFor(P.globalConfig)
    const ccva = coinCreatorVaultAuthorityPda(p.coinCreator)
    const out = [d.address, GLOBAL_CONFIG_PDA, p.baseMint, p.quoteMint, p.poolBaseTokenAccount, p.poolQuoteTokenAccount, protocolFeeRecipient, associatedTokenAddress(protocolFeeRecipient, p.quoteMint, quoteTp),
      baseTp, quoteTp, SYSTEM_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, EVENT_AUTHORITY_PDA, PUMP_AMM_PROGRAM_ID, associatedTokenAddress(ccva, p.quoteMint, quoteTp), ccva, GLOBAL_VOLUME_ACCUMULATOR_PDA, FEE_CONFIG_PDA, PUMP_FEE_PROGRAM_ID,
      buyback, associatedTokenAddress(buyback, p.quoteMint, quoteTp)]
    if (!p.coinCreator.equals(PublicKey.default)) out.push(poolV2Pda(p.baseMint))
    return out
  }

  quoteExactIn(d: DecodedPool, inputMint: PublicKey, amountIn: bigint): Quote | Unsupported {
    const P = pumpswapParams(d); const p = P.pool
    const isBuy = inputMint.equals(d.mintB.mint); const isSell = inputMint.equals(d.mintA.mint)
    if (!isBuy && !isSell) return unsupported('MINT_NOT_IN_POOL', inputMint.toBase58())
    if (isBuy && isSell) return unsupported('SAME_MINT_BOTH_SIDES', 'base == quote')
    const sched = this.schedule(d); if (isUnsupported(sched)) return sched
    const fees = { lpBps: sched.lpBps, protocolBps: sched.protocolBps, creatorBps: sched.creatorBps }
    const s = this.mathState(d)
    const rejectReasons: string[] = []
    if (P.disableFlags & DISABLE_FLAG.buy && isBuy) rejectReasons.push('BUY_DISABLED')
    if (P.disableFlags & DISABLE_FLAG.sell && isSell) rejectReasons.push('SELL_DISABLED')
    for (const r of P.token2022.rejects) rejectReasons.push(r.code)
    if (amountIn <= 0n) rejectReasons.push('ZERO_AMOUNT')
    const base: Omit<Quote, 'amountIn' | 'amountOutToUser' | 'vaultInDelta' | 'vaultOutDelta' | 'fees' | 'priceImpactBps' | 'math' | 'inputMint' | 'outputMint'> = {
      adapter: this.id, pool: d.address, accountsNeeded: this.poolAccounts(d), stateHash: d.stateHash, contextSlot: { min: d.snapshot.minSlot, max: d.snapshot.maxSlot }, rejectReasons,
    }
    const feeItem = (name: string, bps: bigint, amount: bigint, recipient: string): FeeItem => ({ name, bps: Number(bps), amount, mint: d.mintB.mint, alreadyIncluded: true, recipient, source: sched.source })
    const tf = P.token2022.transferFee
    const tfTiers = P.token2022.transferFeeTiers
    const spot = (n: bigint, dn: bigint): string => (dn === 0n ? 'inf' : (Number(n) / Number(dn)).toString())
    if (isBuy) {
      const r = buyQuoteInput(s, fees, amountIn)
      if (!r.ok) { rejectReasons.push(r.reject); return { ...base, inputMint, outputMint: d.mintA.mint, amountIn, amountOutToUser: 0n, vaultInDelta: 0n, vaultOutDelta: 0n, fees: [], priceImpactBps: 0, math: { reject: `${r.reject}: ${r.detail}` } } }
      const baseTransferFee = transferFeeAmountWorstCase(r.baseOut, tfTiers, tf)
      const amountOutToUser = r.baseOut - baseTransferFee
      const fs: FeeItem[] = [feeItem('lp_fee', sched.lpBps, r.lpFee, 'lp'), feeItem('protocol_fee', sched.protocolBps, r.protocolFee, 'protocol')]
      if (r.creatorFee > 0n) fs.push(feeItem('coin_creator_fee', sched.creatorBps, r.creatorFee, 'creator'))
      if (baseTransferFee > 0n) fs.push({ name: 'token2022_transfer_fee', bps: tf!.bps, amount: baseTransferFee, mint: d.mintA.mint, alreadyIncluded: true, recipient: 'token2022_transfer_fee', source: `TransferFeeConfig ${tf!.basis}` })
      // price impact: execution price (quote per base, using the total the user pays) vs spot effQ/B
      const spotP = Number(r.effQ) / Number(s.baseReserve); const execP = Number(r.totalWithFees) / Number(r.baseOut)
      // VERIFIED by tests/integration/pumpswap_local_program.test.ts against the real mainnet ELF (pumpswap.md §11): the user is debited exactly
      // effective_quote + lp + protocol + creator (<= spendable_quote_in; a 1-lamport gap stays in the user's WSOL ATA), the pool quote vault gains
      // effective_quote + lp_fee (LP fee stays in the pool; protocol/buyback/creator fees leave), base_out = floor(B*(effective_quote-1)/(effQ+effective_quote-1)).
      // Hence amountIn = the actual debit; the budget the instruction must carry is recorded in math.spendable_quote_in and re-derived by buildSwapInstruction.
      return {
        ...base, inputMint, outputMint: d.mintA.mint, amountIn: r.totalWithFees, amountOutToUser, vaultInDelta: r.effectiveQuote + r.lpFee, vaultOutDelta: r.baseOut, fees: fs,
        priceImpactBps: Number.isFinite(execP) && spotP > 0 ? Math.round((execP / spotP - 1) * 10_000) : 0,
        math: {
          ix: 'buy_exact_quote_in (pumpswap.md §5b, §11)', effectiveQuoteReserve: `${r.effQ} = raw ${s.quoteReserve} + virtual ${s.virtualQuoteReserves}`, spendable_quote_in: String(amountIn),
          requested_amount_in: String(amountIn), unspent_budget: String(amountIn - r.totalWithFees),
          effective_quote: `${r.effectiveQuote} = floor(quote*10000/(10000+${fees.lpBps + fees.protocolBps + fees.creatorBps}))${r.totalWithFees > amountIn ? ' (unexpected)' : ''}`,
          fees: `lp=${r.lpFee} protocol=${r.protocolFee} creator=${r.creatorFee} (ceil each on effective_quote)`, total_with_fees: `${r.totalWithFees} = user debit (amountIn)`,
          curve_input: `${r.curveInput} = effective_quote - 1 (on-chain behaviour, verified locally)`, base_out: `${r.baseOut} = floor(B*curve_input/(effQ+curve_input))`,
          base_transfer_fee: String(baseTransferFee), buyback_split: `buyback = floor(protocol_fee*${P.globalConfig.buybackBasisPoints}/10000) carved out of protocol fee (pumpswap.md §4)`,
          spot_price_quote_per_base: spot(r.effQ, s.baseReserve), fee_schedule: sched.source,
        },
      }
    }
    // sell: pump_amm prices the curve on the GROSS `base_amount_in` argument, while Token-2022 withholds the transfer fee on the user→vault transfer,
    // so the vault receives amountIn - fee. Verified against the real program with a real transfer-fee mint (review finding: pricing on the net amount
    // under-quoted the leg by the fee). The curve therefore uses the gross amount and vaultInDelta carries the net.
    const inTransferFee = transferFeeAmountWorstCase(amountIn, tfTiers, tf)
    const netIn = amountIn - inTransferFee
    const r = sellBaseInput(s, fees, amountIn)
    if (!r.ok) { rejectReasons.push(r.reject); return { ...base, inputMint, outputMint: d.mintB.mint, amountIn, amountOutToUser: 0n, vaultInDelta: 0n, vaultOutDelta: 0n, fees: [], priceImpactBps: 0, math: { reject: `${r.reject}: ${r.detail}` } } }
    const fs: FeeItem[] = [feeItem('lp_fee', sched.lpBps, r.lpFee, 'lp'), feeItem('protocol_fee', sched.protocolBps, r.protocolFee, 'protocol')]
    if (r.creatorFee > 0n) fs.push(feeItem('coin_creator_fee', sched.creatorBps, r.creatorFee, 'creator'))
    if (inTransferFee > 0n) fs.push({ name: 'token2022_transfer_fee', bps: tf!.bps, amount: inTransferFee, mint: d.mintA.mint, alreadyIncluded: true, recipient: 'token2022_transfer_fee', source: `TransferFeeConfig ${tf!.basis}; withheld on the user→vault transfer, the curve prices the gross base_amount_in` })
    const spotP = Number(r.effQ) / Number(s.baseReserve); const execP = Number(r.userQuoteOut) / Number(amountIn)
    return {
      ...base, inputMint, outputMint: d.mintB.mint, amountIn, amountOutToUser: r.userQuoteOut, vaultInDelta: netIn, vaultOutDelta: r.quoteAmountOut - r.lpFee, fees: fs,
      priceImpactBps: spotP > 0 ? Math.round((1 - execP / spotP) * 10_000) : 0,
      math: {
        ix: 'sell (pumpswap.md §5c)', effectiveQuoteReserve: `${r.effQ} = raw ${s.quoteReserve} + virtual ${s.virtualQuoteReserves}`, base_in: String(amountIn), base_in_net_of_transfer_fee: String(netIn),
        quote_amount_out: `${r.quoteAmountOut} = floor(effQ*base_in/(B+base_in))`, fees: `lp=${r.lpFee} protocol=${r.protocolFee} creator=${r.creatorFee} (ceil each on quote_amount_out)`,
        user_quote_out: String(r.userQuoteOut), boost_cap: `real vault ${s.quoteReserve} >= quote_out - lp_fee ${r.quoteAmountOut - r.lpFee}`, spot_price_quote_per_base: spot(r.effQ, s.baseReserve), fee_schedule: sched.source,
      },
    }
  }

  /** Pure transition: vault balances move by the quote's vault deltas (LP fee stays in the quote vault; protocol/creator fees leave). Never mutates `d`. */
  applySwap(d: DecodedPool, q: Quote): DecodedPool | Unsupported {
    if (!q.pool.equals(d.address)) return unsupported('QUOTE_POOL_MISMATCH', `${q.pool.toBase58()} != ${d.address.toBase58()}`)
    if (q.rejectReasons.length) return unsupported('QUOTE_REJECTED', q.rejectReasons.join(','))
    const P = pumpswapParams(d)
    const isBuy = q.inputMint.equals(d.mintB.mint)
    const newBase = isBuy ? d.reserveA - q.vaultOutDelta : d.reserveA + q.vaultInDelta
    const newQuote = isBuy ? d.reserveB + q.vaultInDelta : d.reserveB - q.vaultOutDelta
    if (newBase < 0n || newQuote < 0n) return unsupported('NEGATIVE_RESERVE', `base=${newBase} quote=${newQuote}`)
    const effQ = newQuote + P.virtualQuoteReserves
    const sched = selectFeeSchedule({ pool: P.pool, globalConfig: P.globalConfig, feeConfig: P.feeConfig, baseMintSupply: d.mintA.supply, baseReserve: newBase, effectiveQuoteReserve: effQ })
    const params: PumpswapParams = { ...P, effectiveQuoteReserve: effQ, feeSchedule: isUnsupported(sched) ? null : sched, feeScheduleError: isUnsupported(sched) ? `${sched.code}: ${sched.reason}` : null, swapsApplied: P.swapsApplied + 1 }
    return {
      ...d, vaultA: { ...d.vaultA, amount: newBase }, vaultB: { ...d.vaultB, amount: newQuote }, reserveA: newBase, reserveB: newQuote, params: params as unknown as Record<string, unknown>,
      dependsOn: [...d.dependsOn], stateHash: sha256Hex(`${d.stateHash}|swap|${q.inputMint.toBase58()}|${q.amountIn}|${q.vaultInDelta}|${q.vaultOutDelta}`),
    }
  }

  /**
   * The `spendable_quote_in` budget whose modelled debit (effective_quote + fees, pumpswap.md §11) is <= `amountIn`, choosing the LARGEST such budget in
   * {amountIn, amountIn + 1}. The program debits total_with_fees(budget) ∈ {budget − 1, budget}, so a quote with amountIn = total_with_fees(R) is reproduced
   * (or bettered by a larger effective_quote at the same debit) by this choice, and the debit never exceeds `amountIn`.
   */
  spendableBudgetFor(d: DecodedPool, amountIn: bigint): bigint | Unsupported {
    const sched = this.schedule(d); if (isUnsupported(sched)) return sched
    const fees = { lpBps: sched.lpBps, protocolBps: sched.protocolBps, creatorBps: sched.creatorBps }
    const s = this.mathState(d)
    for (const budget of [amountIn + 1n, amountIn]) { const r = buyQuoteInput(s, fees, budget); if (r.ok && r.totalWithFees <= amountIn) return budget }
    return unsupported('AMOUNT_TOO_SMALL', `no buy_exact_quote_in budget with debit <= ${amountIn}`)
  }

  /**
   * Builds `buy_exact_quote_in` (WSOL → base) or `sell` (base → WSOL) with the exact account lists of pumpswap.md §6.
   * Direction is inferred from params.userInputAccount, which must be the user's ATA of the input mint (associatedTokenAddress()).
   * Fee-recipient policy: the FIRST protocol_fee_recipients / buyback_fee_recipients entry, deterministically. The program accepts
   * any entry of the GlobalConfig arrays (pumpswap.md §6); the SDK randomises only to spread write locks across recipients. A fixed
   * choice keeps the account set — and therefore stateHash / ALT sizing / local-simulation fixtures — reproducible.
   */
  buildSwapInstruction(d: DecodedPool, params: SwapIxParams): { instruction: TransactionInstruction; accountsWritten: PublicKey[] } | Unsupported {
    if (params.amountIn <= 0n || params.amountIn + 1n > (1n << 64n) - 1n) return unsupported('AMOUNT_NOT_U64', `amountIn ${params.amountIn} outside [1, 2^64-2] (the buy path re-derives spendable = amountIn + 1)`)
    if (params.minimumAmountOut < 0n || params.minimumAmountOut > (1n << 64n) - 1n) return unsupported('AMOUNT_NOT_U64', `minimumAmountOut ${params.minimumAmountOut} outside u64`)
    const P = pumpswapParams(d); const p = P.pool
    const baseTp = tokenProgramOf(d.mintA.program), quoteTp = tokenProgramOf(d.mintB.program)
    const userBaseAta = associatedTokenAddress(params.user, p.baseMint, baseTp), userQuoteAta = associatedTokenAddress(params.user, p.quoteMint, quoteTp)
    let isBuy: boolean
    if (params.userInputAccount.equals(userQuoteAta) && params.userOutputAccount.equals(userBaseAta)) isBuy = true
    else if (params.userInputAccount.equals(userBaseAta) && params.userOutputAccount.equals(userQuoteAta)) isBuy = false
    else return unsupported('USER_ACCOUNTS_NOT_ATA', `userInputAccount/userOutputAccount must be the user's ATAs (${userQuoteAta.toBase58()} / ${userBaseAta.toBase58()})`)
    if (params.amountIn <= 0n) return unsupported('ZERO_AMOUNT', String(params.amountIn))
    if (P.disableFlags & (isBuy ? DISABLE_FLAG.buy : DISABLE_FLAG.sell)) return unsupported(isBuy ? 'BUY_DISABLED' : 'SELL_DISABLED', `disable_flags=${P.disableFlags}`)
    if (isBuy && params.minimumAmountOut === 0n) return unsupported('ZERO_MIN_OUT', 'pump_amm rejects min_base_amount_out == 0 with 6001 ZeroBaseAmount (verified on the real program); pass at least 1')
    const protocolFeeRecipient = protocolFeeRecipientFor(P.globalConfig, p.isMayhemMode)
    const protocolFeeRecipientAta = associatedTokenAddress(protocolFeeRecipient, p.quoteMint, quoteTp)
    const ccva = coinCreatorVaultAuthorityPda(p.coinCreator)
    const ccvAta = associatedTokenAddress(ccva, p.quoteMint, quoteTp)
    const buyback = buybackFeeRecipientFor(P.globalConfig)
    const buybackAta = associatedTokenAddress(buyback, p.quoteMint, quoteTp)
    const uva = userVolumeAccumulatorPda(params.user)
    const uvaQuoteAta = associatedTokenAddress(uva, p.quoteMint, quoteTp)
    const k = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isSigner, isWritable })
    // pumpswap.md §6 named accounts 0..18 (identical for buy / buy_exact_quote_in / sell)
    const keys = [
      k(d.address, true), k(params.user, true, true), k(GLOBAL_CONFIG_PDA, false), k(p.baseMint, false), k(p.quoteMint, false), k(userBaseAta, true), k(userQuoteAta, true),
      k(p.poolBaseTokenAccount, true), k(p.poolQuoteTokenAccount, true), k(protocolFeeRecipient, false), k(protocolFeeRecipientAta, true), k(baseTp, false), k(quoteTp, false),
      k(SYSTEM_PROGRAM_ID, false), k(ASSOCIATED_TOKEN_PROGRAM_ID, false), k(EVENT_AUTHORITY_PDA, false), k(PUMP_AMM_PROGRAM_ID, false), k(ccvAta, true), k(ccva, false),
    ]
    let data: Uint8Array
    if (isBuy) {
      // §6: [19] global_volume_accumulator, [20] user_volume_accumulator (w), [21] fee_config, [22] fee_program
      keys.push(k(GLOBAL_VOLUME_ACCUMULATOR_PDA, false), k(uva, true), k(FEE_CONFIG_PDA, false), k(PUMP_FEE_PROGRAM_ID, false))
      if (p.isCashbackCoin) keys.push(k(uvaQuoteAta, true))
      if (!p.coinCreator.equals(PublicKey.default)) keys.push(k(poolV2Pda(p.baseMint), false))
      keys.push(k(buyback, false), k(buybackAta, true))
      const spendable = this.spendableBudgetFor(d, params.amountIn); if (isUnsupported(spendable)) return spendable
      // args: spendable_quote_in u64, min_base_amount_out u64, track_volume OptionBool = one byte 0x01 (pumpswap.md §6)
      data = concatBytes(Buffer.from(IX_DISC.buyExactQuoteIn, 'hex'), writeU64LE(spendable), writeU64LE(params.minimumAmountOut), new Uint8Array([1]))
    } else {
      // §6 sell: [19] fee_config, [20] fee_program; remaining: [cashback: uva quote ATA (w), uva (w)] [pool-v2] buyback, buyback ATA (w)
      keys.push(k(FEE_CONFIG_PDA, false), k(PUMP_FEE_PROGRAM_ID, false))
      if (p.isCashbackCoin) keys.push(k(uvaQuoteAta, true), k(uva, true))
      if (!p.coinCreator.equals(PublicKey.default)) keys.push(k(poolV2Pda(p.baseMint), false))
      keys.push(k(buyback, false), k(buybackAta, true))
      data = concatBytes(Buffer.from(IX_DISC.sell, 'hex'), writeU64LE(params.amountIn), writeU64LE(params.minimumAmountOut))
    }
    const instruction = new TransactionInstruction({ programId: PUMP_AMM_PROGRAM_ID, keys, data: Buffer.from(data) })
    return { instruction, accountsWritten: keys.filter(x => x.isWritable).map(x => x.pubkey) }
  }
}

/**
 * `close_user_volume_accumulator` — reclaims the deposit that the first PumpSwap buy parks in the user_volume_accumulator PDA.
 * Accounts (pump_amm IDL, instruction `close_user_volume_accumulator`): user (signer, writable), user_volume_accumulator (writable),
 * event_authority, program. No arguments. The audit proved on the real program that the 1,844,400 lamports come back, so the deposit is
 * LOCKED CAPITAL, not a cost; this builder is what makes that recovery reachable from the engine instead of only from the vendor SDK.
 */
export function buildCloseUserVolumeAccumulatorIx(user: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userVolumeAccumulatorPda(user), isSigner: false, isWritable: true },
      { pubkey: EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
      { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_DISC.closeUserVolumeAccumulator, 'hex'),
  })
}
