/**
 * Raydium CPMM PoolAdapter (program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C). Read-only: it decodes, validates, quotes,
 * applies state transitions and BUILDS (never signs/sends) swap_base_input instructions. Every fact is cited to
 * docs/sources/raydium_cpmm.md (§n) or docs/sources/token2022.md (T22 §n).
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { PoolAdapter, PoolRef, RawAccount, AccountBundle, DecodedPool, ValidationResult, Quote, SwapIxParams, Unsupported, FeeItem, MintInfo, TokenAccountInfo, TokenProgramKind } from '../types.js'
import { unsupported, isUnsupported } from '../types.js'
import { parseMint, parseTokenAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WSOL_MINT, EXT, associatedTokenAddress } from '../../state/token.js'
import { stateHashOf } from '../../state/snapshot.js'
import { hashJson } from '../../util/hash.js'
import { concatBytes, writeU64LE } from '../../util/bytes.js'
import { OverflowError, U64_MAX } from '../../util/bigint.js'
import * as L from './layout.js'
import * as M from './math.js'

/** §6: sha256("global:swap_base_input")[..8] == SDK anchorDataBuf.swapBaseInput. */
export const SWAP_BASE_INPUT_DISCRIMINATOR = Uint8Array.from([0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde])
/** §5.4: sha256("global:swap_base_output")[..8]. */
export const SWAP_BASE_OUTPUT_DISCRIMINATOR = Uint8Array.from([0x37, 0xd9, 0x62, 0x56, 0xa3, 0x4a, 0xb4, 0xad])
/** T22 §7.1 `is_supported_mint`: Token-2022 extensions allowed on pool mints without a SupportMintAssociated whitelist. */
export const ALLOWED_TOKEN_2022_EXTENSIONS: ReadonlySet<number> = new Set([EXT.TransferFeeConfig, EXT.MetadataPointer, EXT.TokenMetadata, EXT.InterestBearingConfig, EXT.ScaledUiAmount])
export const LAYOUT_VERSION = 'raydium_cpmm:PoolState@637:AmmConfig@236:cp-swap@59fb845'

/** §12.2: mainnet epoch schedule read live via getEpochSchedule (tests/fixtures/raydium_cpmm/epoch.json). */
export interface EpochSchedule { slotsPerEpoch: number; firstNormalEpoch: number; firstNormalSlot: number; warmup: boolean }
export const MAINNET_EPOCH_SCHEDULE: EpochSchedule = { slotsPerEpoch: 432_000, firstNormalEpoch: 0, firstNormalSlot: 0, warmup: false }
/** epoch = firstNormalEpoch + (slot − firstNormalSlot) / slotsPerEpoch for slots past warm-up (mainnet has no warm-up). */
export function epochForSlot(slot: number, s: EpochSchedule = MAINNET_EPOCH_SCHEDULE): bigint {
  if (slot < s.firstNormalSlot) throw new Error(`EPOCH_WARMUP_UNSUPPORTED slot ${slot} < firstNormalSlot ${s.firstNormalSlot}`)
  return BigInt(s.firstNormalEpoch) + BigInt(Math.floor((slot - s.firstNormalSlot) / s.slotsPerEpoch))
}

/** Adapter-specific decoded fields stored in DecodedPool.params. */
export interface RaydiumCpmmParams {
  pool: L.PoolState
  config: L.AmmConfig
  poolOwner: PublicKey
  configOwner: PublicKey
  configAddress: PublicKey
  authority: PublicKey
  authorityBump: number
  /** Clock.epoch assumed for Token-2022 transfer fees (derived from the snapshot slot; §12.2) */
  epoch: bigint
  /** optional override for `now` (unix seconds) used by the open_time check; default = snapshot.receivedAtUtc */
  nowUnix?: number | undefined
  transferFee0?: M.TransferFeeConfigView | undefined
  transferFee1?: M.TransferFeeConfigView | undefined
  [k: string]: unknown
}
/** Swap-ix params may carry the input mint explicitly; otherwise the direction is inferred from `userInputAccount` (must be the user's ATA). */
export interface RaydiumSwapIxParams extends SwapIxParams { inputMint?: PublicKey | undefined }
export interface RaydiumCpmmAdapterOptions { epochSchedule?: EpochSchedule; programId?: PublicKey }

function transferFeeView(m: MintInfo): M.TransferFeeConfigView | undefined {
  if (m.program !== 'token_2022' || !m.transferFee) return undefined
  const older = (m as MintInfo & { transferFeeOlder?: { epoch: bigint; maxFee: bigint; bps: number } }).transferFeeOlder
  return { newer: { epoch: m.transferFee.epoch, maxFee: m.transferFee.maxFee, bps: m.transferFee.bps }, older: older ?? { epoch: m.transferFee.epoch, maxFee: m.transferFee.maxFee, bps: m.transferFee.bps } }
}
const mintFeeView = (m: MintInfo, tf: M.TransferFeeConfigView | undefined): M.MintFeeView => ({ program: m.program, transferFee: tf })
const programIdOf = (k: TokenProgramKind): PublicKey => (k === 'spl_token' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID)
const bpsOfRate = (rate: bigint): number => Number(rate) / 100 // 1e-6 units → bps

export class RaydiumCpmmAdapter implements PoolAdapter {
  readonly id = 'raydium_cpmm' as const
  readonly programId: PublicKey
  private readonly epochSchedule: EpochSchedule
  constructor(opts: RaydiumCpmmAdapterOptions = {}) {
    this.programId = opts.programId ?? L.RAYDIUM_CPMM_PROGRAM_ID
    this.epochSchedule = opts.epochSchedule ?? MAINNET_EPOCH_SCHEDULE
  }

  /** §2: dependents are read from the pool account itself (amm_config, vaults, mints). The observation account is only needed for the ix, not for quoting. */
  requiredAccounts(pool: PoolRef, poolAccount?: RawAccount): PublicKey[] | Unsupported {
    if (!poolAccount) return unsupported('POOL_ACCOUNT_REQUIRED', 'raydium_cpmm needs the pool account bytes to enumerate dependents (2-step fetch)')
    if (!poolAccount.owner.equals(this.programId)) return unsupported('WRONG_OWNER', `pool ${pool.address.toBase58()} owned by ${poolAccount.owner.toBase58()}, expected ${this.programId.toBase58()}`)
    const st = L.decodePoolState(poolAccount.data)
    if (isUnsupported(st)) return st
    return [pool.address, st.ammConfig, st.token0Vault, st.token1Vault, st.token0Mint, st.token1Mint]
  }

  decodeSnapshot(pool: PoolRef, bundle: AccountBundle): DecodedPool | Unsupported {
    const get = (k: PublicKey): RawAccount | undefined => bundle.accounts.get(k.toBase58())
    const poolRaw = get(pool.address)
    if (!poolRaw) return unsupported('ACCOUNTS_MISSING', `pool ${pool.address.toBase58()} not in bundle`)
    const st = L.decodePoolState(poolRaw.data)
    if (isUnsupported(st)) return st
    const keys = [pool.address, st.ammConfig, st.token0Vault, st.token1Vault, st.token0Mint, st.token1Mint]
    const raws = keys.map(get)
    const missing = keys.filter((_, i) => !raws[i])
    if (missing.length) return unsupported('ACCOUNTS_MISSING', missing.map(m => m.toBase58()).join(','))
    const [, cfgRaw, v0Raw, v1Raw, m0Raw, m1Raw] = raws as RawAccount[]
    const cfg = L.decodeAmmConfig(cfgRaw!.data)
    if (isUnsupported(cfg)) return cfg
    let vault0: TokenAccountInfo, vault1: TokenAccountInfo, mint0: MintInfo, mint1: MintInfo
    try { vault0 = parseTokenAccount(v0Raw!); vault1 = parseTokenAccount(v1Raw!) } catch (e) { return unsupported('VAULT_PARSE', (e as Error).message) }
    try { mint0 = parseMint(m0Raw!); mint1 = parseMint(m1Raw!) } catch (e) { return unsupported('MINT_PARSE', (e as Error).message) }
    const reserves = M.vaultAmountWithoutFee(st, vault0.amount, vault1.amount)
    if (!reserves.ok) return unsupported(reserves.code, reserves.detail) // the program would reject every swap on this state (§5.1)
    const all = raws as RawAccount[]
    const minSlot = Math.min(...all.map(a => a.contextSlot)), maxSlot = Math.max(...all.map(a => a.contextSlot))
    const batchIds = [...new Set(all.map(a => a.batchId))]
    const receivedAtUtc = all.map(a => a.receivedAtUtc).sort().at(-1)!
    const [authority, authorityBump] = L.authorityPda(this.programId)
    let epoch: bigint
    try { epoch = epochForSlot(maxSlot, this.epochSchedule) } catch (e) { return unsupported('EPOCH_UNKNOWN', (e as Error).message) }
    const params: RaydiumCpmmParams = { pool: st, config: cfg, poolOwner: poolRaw.owner, configOwner: cfgRaw!.owner, configAddress: cfgRaw!.pubkey, authority, authorityBump, epoch, transferFee0: transferFeeView(mint0), transferFee1: transferFeeView(mint1) }
    return {
      adapter: 'raydium_cpmm', address: pool.address, programId: this.programId,
      mintA: mint0, mintB: mint1, vaultA: vault0, vaultB: vault1,
      reserveA: reserves.reserve0, reserveB: reserves.reserve1,
      params, dependsOn: keys, stateHash: stateHashOf(keys, bundle),
      snapshot: { minSlot, maxSlot, singleBatch: batchIds.length === 1, batchIds, receivedAtUtc },
      layoutVersion: LAYOUT_VERSION,
    }
  }

  validatePool(d: DecodedPool): ValidationResult {
    const rejects: { code: string; detail: string }[] = []
    const warnings: { code: string; detail: string }[] = []
    const p = d.params as RaydiumCpmmParams
    const st = p.pool, cfg = p.config
    const rej = (code: string, detail: string) => rejects.push({ code, detail })
    const warn = (code: string, detail: string) => warnings.push({ code, detail })
    if (!p.poolOwner.equals(this.programId)) rej('POOL_OWNER', `pool owner ${p.poolOwner.toBase58()} != ${this.programId.toBase58()}`)
    if (!p.configOwner.equals(this.programId)) rej('CONFIG_OWNER', `amm_config owner ${p.configOwner.toBase58()} != program`)
    if (!p.configAddress.equals(st.ammConfig)) rej('CONFIG_ADDRESS', `amm_config ${p.configAddress.toBase58()} != pool.amm_config ${st.ammConfig.toBase58()}`)
    // §2 / §6: vault_i == PDA[b"pool_vault", pool, mint_i] AND == the pool fields (pool id itself may be a non-PDA account)
    const [pda0] = L.poolVaultPda(d.address, st.token0Mint, this.programId), [pda1] = L.poolVaultPda(d.address, st.token1Mint, this.programId)
    if (!d.vaultA.address.equals(st.token0Vault) || !d.vaultA.address.equals(pda0)) rej('VAULT_PDA_MISMATCH', `token_0_vault field=${st.token0Vault.toBase58()} pda=${pda0.toBase58()} decoded=${d.vaultA.address.toBase58()}`)
    if (!d.vaultB.address.equals(st.token1Vault) || !d.vaultB.address.equals(pda1)) rej('VAULT_PDA_MISMATCH', `token_1_vault field=${st.token1Vault.toBase58()} pda=${pda1.toBase58()} decoded=${d.vaultB.address.toBase58()}`)
    if (!d.vaultA.owner.equals(p.authority)) rej('VAULT_OWNER', `token_0_vault owner ${d.vaultA.owner.toBase58()} != authority ${p.authority.toBase58()}`)
    if (!d.vaultB.owner.equals(p.authority)) rej('VAULT_OWNER', `token_1_vault owner ${d.vaultB.owner.toBase58()} != authority ${p.authority.toBase58()}`)
    if (st.authBump !== p.authorityBump) rej('AUTH_BUMP', `pool.auth_bump ${st.authBump} != derived ${p.authorityBump}`)
    if (!d.vaultA.mint.equals(st.token0Mint)) rej('VAULT_MINT', `token_0_vault mint ${d.vaultA.mint.toBase58()} != token_0_mint`)
    if (!d.vaultB.mint.equals(st.token1Mint)) rej('VAULT_MINT', `token_1_vault mint ${d.vaultB.mint.toBase58()} != token_1_mint`)
    if (!d.mintA.mint.equals(st.token0Mint) || !d.mintB.mint.equals(st.token1Mint)) rej('MINT_ADDRESS', 'decoded mints do not match pool fields')
    // §2: token_i_program == owner program of mint i; vault must live under the same program
    if (!programIdOf(d.mintA.program).equals(st.token0Program)) rej('TOKEN_PROGRAM_MISMATCH', `mint0 program ${d.mintA.program} != pool.token_0_program ${st.token0Program.toBase58()}`)
    if (!programIdOf(d.mintB.program).equals(st.token1Program)) rej('TOKEN_PROGRAM_MISMATCH', `mint1 program ${d.mintB.program} != pool.token_1_program ${st.token1Program.toBase58()}`)
    if (d.vaultA.program !== d.mintA.program) rej('TOKEN_PROGRAM_MISMATCH', 'token_0_vault program != mint0 program')
    if (d.vaultB.program !== d.mintB.program) rej('TOKEN_PROGRAM_MISMATCH', 'token_1_vault program != mint1 program')
    if (d.vaultA.state === 2 || d.vaultB.state === 2) rej('VAULT_FROZEN', 'a vault is frozen (Token AccountFrozen on transfer)')
    // §4 gate: status bit2 and open_time
    if (!L.isSwapEnabled(st.status)) rej('SWAP_DISABLED', `status=${st.status} has bit2 set (ErrorCode::NotApproved)`)
    const now = p.nowUnix ?? Math.floor(Date.parse(d.snapshot.receivedAtUtc) / 1000)
    if (!Number.isFinite(now)) rej('NOW_UNKNOWN', `cannot derive now from receivedAtUtc=${d.snapshot.receivedAtUtc}`)
    else if (BigInt(now) < st.openTime) rej('NOT_OPEN', `open_time ${st.openTime} > now ${now} (ErrorCode::NotApproved)`)
    if (st.creatorFeeOn !== L.CREATOR_FEE_ON.BOTH_TOKEN && st.creatorFeeOn !== L.CREATOR_FEE_ON.ONLY_TOKEN_0 && st.creatorFeeOn !== L.CREATOR_FEE_ON.ONLY_TOKEN_1) rej('INVALID_FEE_MODEL', `creator_fee_on=${st.creatorFeeOn}`)
    if (!d.mintA.mint.equals(WSOL_MINT) && !d.mintB.mint.equals(WSOL_MINT)) rej('QUOTE_NOT_WSOL', 'neither side is WSOL')
    for (const [m, side] of [[d.mintA, 'mint0'], [d.mintB, 'mint1']] as const) {
      if (m.program === 'token_2022') {
        const bad = m.extensions.filter(e => !ALLOWED_TOKEN_2022_EXTENSIONS.has(e))
        if (bad.length) rej('TOKEN2022_EXTENSION', `${side} ${m.mint.toBase58()} has disallowed Token-2022 extensions [${bad.join(',')}] (T22 §7.1; SupportMintAssociated whitelist not modelled)`)
        if (m.transferFee && m.transferFee.bps > 0) warn('TRANSFER_FEE', `${side} transfer fee ${m.transferFee.bps} bps (max ${m.transferFee.maxFee}) from epoch ${m.transferFee.epoch}; quoting uses epoch ${p.epoch}`)
      }
      if (m.freezeAuthority && !m.mint.equals(WSOL_MINT)) warn('FREEZE_AUTHORITY', `${side} ${m.mint.toBase58()} has a freeze authority`)
    }
    if (d.reserveA === 0n || d.reserveB === 0n) rej('ZERO_RESERVE', `reserves ${d.reserveA}/${d.reserveB} (fee-adjusted) — constant product undefined`)
    if (d.mintA.decimals !== st.mint0Decimals || d.mintB.decimals !== st.mint1Decimals) warn('DECIMALS_MISMATCH', 'mint decimals differ from pool snapshot (transfer_checked uses the live mint)')
    if (cfg.tradeFeeRate + cfg.creatorFeeRate >= L.FEE_RATE_DENOMINATOR) rej('FEE_RATE_INVALID', `trade+creator rate ${cfg.tradeFeeRate + cfg.creatorFeeRate} >= 1e6`)
    if (st.enableCreatorFee) warn('CREATOR_FEE_ENABLED', `creator_fee_rate ${cfg.creatorFeeRate} (1e-6) on=${st.creatorFeeOn}`)
    if (st.paddingNonZero) warn('PADDING_NONZERO', 'PoolState padding bytes are non-zero (layout may have grown)')
    if (cfg.padding0 !== 0n) warn('CONFIG_PADDING_NONZERO', `amm_config bytes 116..124 = ${cfg.padding0} (SDK calls this creatorFeeShareRate; not on mainnet per §10)`)
    if ((st.status & (L.STATUS_BIT.DEPOSIT_DISABLED | L.STATUS_BIT.WITHDRAW_DISABLED)) !== 0) warn('LP_OPS_DISABLED', `status=${st.status}`)
    return { ok: rejects.length === 0, rejects, warnings }
  }

  private swapContext(d: DecodedPool, inputMint: PublicKey): { ctx: M.SwapContext; direction: M.TradeDirection; inMint: MintInfo; outMint: MintInfo; inVault: TokenAccountInfo; outVault: TokenAccountInfo } | Unsupported {
    const p = d.params as RaydiumCpmmParams
    let direction: M.TradeDirection
    if (inputMint.equals(d.mintA.mint)) direction = 'ZeroForOne'
    else if (inputMint.equals(d.mintB.mint)) direction = 'OneForZero'
    else return unsupported('MINT_NOT_IN_POOL', `${inputMint.toBase58()} is neither token_0_mint nor token_1_mint`)
    const z = direction === 'ZeroForOne'
    const inMint = z ? d.mintA : d.mintB, outMint = z ? d.mintB : d.mintA, inVault = z ? d.vaultA : d.vaultB, outVault = z ? d.vaultB : d.vaultA
    const ctx: M.SwapContext = { pool: p.pool, config: p.config, direction, inputVaultAmount: inVault.amount, outputVaultAmount: outVault.amount, inputMint: mintFeeView(inMint, z ? p.transferFee0 : p.transferFee1), outputMint: mintFeeView(outMint, z ? p.transferFee1 : p.transferFee0), epoch: p.epoch }
    return { ctx, direction, inMint, outMint, inVault, outVault }
  }

  private accountsNeeded(d: DecodedPool): PublicKey[] {
    const p = d.params as RaydiumCpmmParams
    return [p.authority, p.configAddress, d.address, d.vaultA.address, d.vaultB.address, programIdOf(d.mintA.program), programIdOf(d.mintB.program), d.mintA.mint, d.mintB.mint, p.pool.observationKey]
  }

  quoteExactIn(d: DecodedPool, inputMint: PublicKey, amountIn: bigint): Quote | Unsupported {
    const s = this.swapContext(d, inputMint); if (isUnsupported(s)) return s
    const { ctx, inMint, outMint } = s
    const p = d.params as RaydiumCpmmParams
    const base = { adapter: 'raydium_cpmm' as const, pool: d.address, inputMint, outputMint: outMint.mint, amountIn, accountsNeeded: this.accountsNeeded(d), stateHash: d.stateHash, contextSlot: { min: d.snapshot.minSlot, max: d.snapshot.maxSlot } }
    let r: M.SwapBaseInputOutcome
    try { r = M.simulateSwapBaseInput(ctx, amountIn) } catch (e) {
      if (e instanceof OverflowError) return { ...base, amountOutToUser: 0n, vaultInDelta: 0n, vaultOutDelta: 0n, fees: [], priceImpactBps: 0, rejectReasons: [`OVERFLOW: ${e.message}`], math: { error: e.message } }
      throw e
    }
    if (!r.ok) return { ...base, amountOutToUser: 0n, vaultInDelta: 0n, vaultOutDelta: 0n, fees: [], priceImpactBps: 0, rejectReasons: [`${r.code}: ${r.detail}`], math: { error: r.detail } }
    const c = r.curve
    const src = `amm_config ${p.configAddress.toBase58()} idx ${p.config.index} (raydium_cpmm.md §5.3)`
    const fees: FeeItem[] = [
      // trade_fee = lp share + protocol + fund (§5.3 step 5/8): listed as three disjoint items so that Σ items is exact
      { name: 'lp_fee', bps: bpsOfRate(p.config.tradeFeeRate), amount: c.tradeFee - c.protocolFee - c.fundFee, mint: inMint.mint, alreadyIncluded: true, recipient: 'lp', source: `${src} trade_fee_rate=${p.config.tradeFeeRate} ceil, minus protocol/fund shares; stays in vault` },
      { name: 'protocol_fee', amount: c.protocolFee, mint: inMint.mint, alreadyIncluded: true, recipient: 'protocol', source: `${src} protocol_fee_rate=${p.config.protocolFeeRate} of trade_fee, floor` },
      { name: 'fund_fee', amount: c.fundFee, mint: inMint.mint, alreadyIncluded: true, recipient: 'fund', source: `${src} fund_fee_rate=${p.config.fundFeeRate} of trade_fee, floor` },
    ]
    if (r.creatorFeeRate > 0n) fees.push({ name: 'creator_fee', bps: bpsOfRate(r.creatorFeeRate), amount: c.creatorFee, mint: r.isCreatorFeeOnInput ? inMint.mint : outMint.mint, alreadyIncluded: true, recipient: 'creator', source: `${src} creator_fee_rate=${r.creatorFeeRate} on ${r.isCreatorFeeOnInput ? 'input (ceil total, floor split)' : 'output (ceil)'}` })
    if (ctx.inputMint.transferFee) fees.push({ name: 'token2022_transfer_fee_in', bps: M.epochFeeTier(ctx.inputMint.transferFee, ctx.epoch).bps, amount: r.transferFeeIn, mint: inMint.mint, alreadyIncluded: true, recipient: 'token2022_transfer_fee', source: `TransferFeeConfig of ${inMint.mint.toBase58()} at epoch ${ctx.epoch} (token2022.md §4)` })
    if (ctx.outputMint.transferFee) fees.push({ name: 'token2022_transfer_fee_out', bps: M.epochFeeTier(ctx.outputMint.transferFee, ctx.epoch).bps, amount: r.transferFeeOut, mint: outMint.mint, alreadyIncluded: true, recipient: 'token2022_transfer_fee', source: `TransferFeeConfig of ${outMint.mint.toBase58()} at epoch ${ctx.epoch} (token2022.md §4)` })
    // informational: 1 − (out/inLessFees) / (R_out/R_in), in bps, floor
    const priceImpactBps = c.inputAmountLessFees > 0n && r.reserveOut > 0n ? Number(10_000n - (c.outputAmountSwapped * r.reserveIn * 10_000n) / (c.inputAmountLessFees * r.reserveOut)) : 0
    const math: Record<string, string> = {
      direction: ctx.direction, epoch: ctx.epoch.toString(),
      transferFeeIn: r.transferFeeIn.toString(), actualAmountIn: r.actualAmountIn.toString(),
      reserveIn: r.reserveIn.toString(), reserveOut: r.reserveOut.toString(),
      tradeFee: `${c.tradeFee} (ceil)`, protocolFee: `${c.protocolFee} (floor of trade_fee)`, fundFee: `${c.fundFee} (floor of trade_fee)`,
      creatorFee: `${c.creatorFee} (${r.isCreatorFeeOnInput ? 'input: floor split of ceil total' : 'output: ceil'})`, creatorFeeRate: r.creatorFeeRate.toString(),
      inputAmountLessFees: c.inputAmountLessFees.toString(), outputAmountSwapped: `${c.outputAmountSwapped} (floor Δx·y/(x+Δx))`,
      amountOut: r.amountOut.toString(), transferFeeOut: r.transferFeeOut.toString(), amountReceived: r.amountReceived.toString(),
      constantBefore: r.constantBefore.toString(), constantAfter: r.constantAfter.toString(),
      identityInput: 'amountIn = transferFeeIn + lp_fee + protocol_fee + fund_fee + creator_fee(if on input) + inputAmountLessFees',
      identityOutput: 'outputAmountSwapped = creator_fee(if on output) + transferFeeOut + amountOutToUser',
    }
    return { ...base, amountOutToUser: r.amountReceived, vaultInDelta: r.actualAmountIn, vaultOutDelta: r.amountOut, fees, priceImpactBps, rejectReasons: [], math }
  }

  /** §5.3 steps 8-9: vault_in.amount += amount_in − transfer_fee_in; vault_out.amount −= amount_out; fee counters accrue. Pure. */
  applySwap(d: DecodedPool, q: Quote): DecodedPool | Unsupported {
    if (q.stateHash !== d.stateHash) return unsupported('STATE_HASH_MISMATCH', `quote computed on ${q.stateHash.slice(0, 12)}… but pool state is ${d.stateHash.slice(0, 12)}…`)
    if (q.rejectReasons.length) return unsupported('QUOTE_REJECTED', q.rejectReasons.join('; '))
    const s = this.swapContext(d, q.inputMint); if (isUnsupported(s)) return s
    let r: M.SwapBaseInputOutcome
    try { r = M.simulateSwapBaseInput(s.ctx, q.amountIn) } catch (e) { return unsupported('OVERFLOW', (e as Error).message) }
    if (!r.ok) return unsupported(r.code, r.detail)
    if (r.amountReceived !== q.amountOutToUser || r.actualAmountIn !== q.vaultInDelta || r.amountOut !== q.vaultOutDelta) return unsupported('QUOTE_STATE_MISMATCH', 'recomputed swap differs from the quote')
    const p = d.params as RaydiumCpmmParams
    const pool = M.applyFeeUpdate(p.pool, s.direction, r.isCreatorFeeOnInput, r.curve.protocolFee, r.curve.fundFee, r.curve.creatorFee)
    const z = s.direction === 'ZeroForOne'
    const vaultA: TokenAccountInfo = { ...d.vaultA, amount: z ? r.vaultInAfter : r.vaultOutAfter }
    const vaultB: TokenAccountInfo = { ...d.vaultB, amount: z ? r.vaultOutAfter : r.vaultInAfter }
    const reserves = M.vaultAmountWithoutFee(pool, vaultA.amount, vaultB.amount)
    if (!reserves.ok) return unsupported(reserves.code, reserves.detail)
    const params: RaydiumCpmmParams = { ...p, pool }
    const stateHash = hashJson({ applied: true, prev: d.stateHash, inputMint: q.inputMint.toBase58(), amountIn: q.amountIn, vaultA: vaultA.amount, vaultB: vaultB.amount, fees: [pool.protocolFeesToken0, pool.protocolFeesToken1, pool.fundFeesToken0, pool.fundFeesToken1, pool.creatorFeesToken0, pool.creatorFeesToken1] })
    return { ...d, vaultA, vaultB, reserveA: reserves.reserve0, reserveB: reserves.reserve1, params, stateHash }
  }

  /** §6: swap_base_input with the 13 accounts in program order. Never signs. */
  buildSwapInstruction(d: DecodedPool, params: SwapIxParams): { instruction: TransactionInstruction; accountsWritten: PublicKey[] } | Unsupported {
    const p = d.params as RaydiumCpmmParams
    const px = params as RaydiumSwapIxParams
    let inputMint = px.inputMint
    if (!inputMint) {
      // infer direction from the user's input account, which must be the ATA of one of the two mints
      const ataA = associatedTokenAddress(params.user, d.mintA.mint, programIdOf(d.mintA.program)), ataB = associatedTokenAddress(params.user, d.mintB.mint, programIdOf(d.mintB.program))
      if (params.userInputAccount.equals(ataA)) inputMint = d.mintA.mint
      else if (params.userInputAccount.equals(ataB)) inputMint = d.mintB.mint
      else return unsupported('DIRECTION_UNKNOWN', 'userInputAccount is not the ATA of either pool mint; pass inputMint explicitly (RaydiumSwapIxParams)')
    }
    const s = this.swapContext(d, inputMint); if (isUnsupported(s)) return s
    if (params.amountIn <= 0n || params.amountIn > U64_MAX) return unsupported('U64_OVERFLOW', `amountIn ${params.amountIn}`)
    if (params.minimumAmountOut < 0n || params.minimumAmountOut > U64_MAX) return unsupported('U64_OVERFLOW', `minimumAmountOut ${params.minimumAmountOut}`)
    const keys = [
      { pubkey: params.user, isSigner: true, isWritable: false },                 // 0 payer (Signer, not mut)
      { pubkey: p.authority, isSigner: false, isWritable: false },                // 1 authority PDA
      { pubkey: p.configAddress, isSigner: false, isWritable: false },            // 2 amm_config
      { pubkey: d.address, isSigner: false, isWritable: true },                   // 3 pool_state
      { pubkey: params.userInputAccount, isSigner: false, isWritable: true },     // 4 input_token_account
      { pubkey: params.userOutputAccount, isSigner: false, isWritable: true },    // 5 output_token_account
      { pubkey: s.inVault.address, isSigner: false, isWritable: true },           // 6 input_vault
      { pubkey: s.outVault.address, isSigner: false, isWritable: true },          // 7 output_vault
      { pubkey: programIdOf(s.inMint.program), isSigner: false, isWritable: false },  // 8 input_token_program
      { pubkey: programIdOf(s.outMint.program), isSigner: false, isWritable: false }, // 9 output_token_program
      { pubkey: s.inMint.mint, isSigner: false, isWritable: false },              // 10 input_token_mint
      { pubkey: s.outMint.mint, isSigner: false, isWritable: false },             // 11 output_token_mint
      { pubkey: p.pool.observationKey, isSigner: false, isWritable: true },       // 12 observation_state
    ]
    const data = Buffer.from(concatBytes(SWAP_BASE_INPUT_DISCRIMINATOR, writeU64LE(params.amountIn), writeU64LE(params.minimumAmountOut)))
    return { instruction: new TransactionInstruction({ programId: this.programId, keys, data }), accountsWritten: [d.address, params.userInputAccount, params.userOutputAccount, s.inVault.address, s.outVault.address, p.pool.observationKey] }
  }

  /** Extra (not on the PoolAdapter interface): exact-out cross-check mirroring swap_base_output (§5.4). */
  quoteExactOut(d: DecodedPool, inputMint: PublicKey, amountOutReceived: bigint): M.SwapBaseOutputOutcome | Unsupported {
    const s = this.swapContext(d, inputMint); if (isUnsupported(s)) return s
    try { return M.simulateSwapBaseOutput(s.ctx, amountOutReceived) } catch (e) {
      if (e instanceof OverflowError) return { ok: false, code: 'OVERFLOW', detail: e.message } // the program would panic (unwrap) → tx fails
      throw e
    }
  }
}
