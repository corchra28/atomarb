/**
 * Fetches PumpSwap fixtures from mainnet (READ-ONLY, public RPC, <= 40 HTTP requests) and saves them with provenance:
 *   tests/fixtures/pumpswap/global.json            GlobalConfig, FeeConfig, global_volume_accumulator
 *   tests/fixtures/pumpswap/pool_canonical.json    canonical pool with coin_creator set (+ all quote/swap dependents)
 *   tests/fixtures/pumpswap/pool_boosted.json      boosted pool (virtual_quote_reserves > 0)
 *   tests/fixtures/pumpswap/pool_noncanonical.json pool whose creator != pump pool-authority PDA (verified on-chain)
 *   tests/fixtures/pumpswap/manifest.json          roles, slots, missing accounts (pool-v2 is NULL on mainnet), request count
 *   tests/fixtures/programs/<programId>.so + .json  pump_amm and pump_fees ELFs (skipped when present; --refresh-programs re-dumps)
 * Re-runnable: `npx tsx scripts/fetch_fixtures_pumpswap.ts [--refresh-programs]`.
 */
import { createGunzip } from 'node:zlib'
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { PublicKey } from '@solana/web3.js'
import { RpcClient } from '../src/state/rpc.js'
import { dumpProgram } from '../src/simulation/local_svm.js'
import { WSOL_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, associatedTokenAddress } from '../src/state/token.js'
import { sha256Hex } from '../src/util/hash.js'
import { nowUtcIso } from '../src/util/time.js'
import { isUnsupported, type RawAccount } from '../src/adapters/types.js'
import { GLOBAL_CONFIG_PDA, FEE_CONFIG_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, decodePool, decodeGlobalConfig, coinCreatorVaultAuthorityPda, poolV2Pda, type PumpPool } from '../src/adapters/pumpswap/layout.js'
import { isPumpPool } from '../src/adapters/pumpswap/fees.js'
import { rawToFixture, saveFixture, type AccountFixture } from '../tests/helpers/fixtures.js'

const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com'
const OUT = 'tests/fixtures/pumpswap'
const PROG_OUT = 'tests/fixtures/programs'
const SOURCE = `rpc_gma ${RPC_URL}`
const INVENTORY = 'data/inventory/pumpswap_pools.jsonl.gz'
/** pumpswap.md §2: docs example canonical pool (300 bytes, coin_creator set, virtual_quote_reserves = 0). */
const CANONICAL_PRIMARY = new PublicKey('GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J')
/** pumpswap.md §2/§5: boosted pool (301 bytes, virtual_quote_reserves = 17,584,505,289). */
const BOOSTED = new PublicKey('FruHjS1iY2rR1vdcx7fRXKQmQh7BAGMqNhtqJCtQZLiz')

async function inventoryCandidates(canonical: boolean, limit: number, skip: Set<string>): Promise<PublicKey[]> {
  if (!existsSync(INVENTORY)) return []
  const out: PublicKey[] = []
  const rl = createInterface({ input: createReadStream(INVENTORY).pipe(createGunzip()) })
  for await (const line of rl) {
    if (!line.trim()) continue
    const rec = JSON.parse(line) as { pool: string; canonical: boolean; quote_mint: string }
    if (rec.canonical !== canonical || rec.quote_mint !== WSOL_MINT.toBase58() || skip.has(rec.pool)) continue
    out.push(new PublicKey(rec.pool)); if (out.length >= limit) break
  }
  rl.close()
  return out
}

async function main(): Promise<void> {
  const refreshPrograms = process.argv.includes('--refresh-programs')
  const rpc = new RpcClient(RPC_URL, { maxRequestsPerSecond: 4, maxConcurrentRequests: 1, maxTotalHttpRequests: 40, requestTimeoutMs: 20_000, backoff: { baseMs: 1000, maxMs: 15_000, jitter: 0.3 } }, 'confirmed')
  mkdirSync(OUT, { recursive: true }); mkdirSync(PROG_OUT, { recursive: true })
  const skip = new Set([CANONICAL_PRIMARY.toBase58(), BOOSTED.toBase58()])
  const nonCanonCandidates = await inventoryCandidates(false, 12, skip)
  const canonFallbacks = await inventoryCandidates(true, 6, skip)
  // --- request 1: globals + pools + candidates -----------------------------------------------------------------------
  const poolKeys = [CANONICAL_PRIMARY, BOOSTED, ...nonCanonCandidates, ...canonFallbacks]
  const r1 = await rpc.getMultipleAccounts([GLOBAL_CONFIG_PDA, FEE_CONFIG_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA, ...poolKeys])
  const acc = (k: PublicKey): RawAccount | undefined => r1.bundle.accounts.get(k.toBase58())
  const gcAcc = acc(GLOBAL_CONFIG_PDA), fcAcc = acc(FEE_CONFIG_PDA), gvaAcc = acc(GLOBAL_VOLUME_ACCUMULATOR_PDA)
  if (!gcAcc || !fcAcc || !gvaAcc) throw new Error('global accounts missing')
  const gc = decodeGlobalConfig(gcAcc.data); if (isUnsupported(gc)) throw new Error(`global_config: ${gc.reason}`)
  const decoded = new Map<string, PumpPool>()
  for (const k of poolKeys) {
    const a = acc(k); if (!a) { console.log(`pool ${k.toBase58()} missing on-chain`); continue }
    if (!a.owner.equals(PUMP_AMM_PROGRAM_ID)) { console.log(`pool ${k.toBase58()} owner ${a.owner.toBase58()} != pump_amm`); continue }
    const p = decodePool(a.data); if (isUnsupported(p)) { console.log(`pool ${k.toBase58()} ${p.code}: ${p.reason}`); continue }
    decoded.set(k.toBase58(), p)
  }
  const canonicalOf = (k: PublicKey) => { const p = decoded.get(k.toBase58()); return p ? isPumpPool(p.baseMint, p.creator) : null }
  console.log(`canonical primary ${CANONICAL_PRIMARY.toBase58()}: canonical=${canonicalOf(CANONICAL_PRIMARY)} coin_creator=${decoded.get(CANONICAL_PRIMARY.toBase58())?.coinCreator.toBase58()} vqr=${decoded.get(CANONICAL_PRIMARY.toBase58())?.virtualQuoteReserves}`)
  console.log(`boosted ${BOOSTED.toBase58()}: canonical=${canonicalOf(BOOSTED)} vqr=${decoded.get(BOOSTED.toBase58())?.virtualQuoteReserves}`)
  const nonCanonVerified = nonCanonCandidates.filter(k => canonicalOf(k) === false && decoded.get(k.toBase58())!.quoteMint.equals(WSOL_MINT))
  const canonVerified = [CANONICAL_PRIMARY, ...canonFallbacks].filter(k => canonicalOf(k) === true && decoded.get(k.toBase58())!.quoteMint.equals(WSOL_MINT) && !decoded.get(k.toBase58())!.coinCreator.equals(PublicKey.default) && decoded.get(k.toBase58())!.virtualQuoteReserves === 0n)
  console.log(`non-canonical verified on-chain: ${nonCanonVerified.length}/${nonCanonCandidates.length}; canonical(with coin_creator, vqr=0): ${canonVerified.length}`)
  // --- request 2: dependents of up to 8 pools ---------------------------------------------------------------------------
  const depPools = [...canonVerified.slice(0, 3), BOOSTED, ...nonCanonVerified.slice(0, 3)]
  const depKeys: PublicKey[] = [WSOL_MINT]
  const add = (k: PublicKey) => { if (!depKeys.some(x => x.equals(k))) depKeys.push(k) }
  const quoteTp = TOKEN_PROGRAM_ID
  const protocolRecipient = gc.protocolFeeRecipients[0]!, buybackRecipient = gc.buybackFeeRecipients[0]!
  add(associatedTokenAddress(protocolRecipient, WSOL_MINT, quoteTp)); add(associatedTokenAddress(buybackRecipient, WSOL_MINT, quoteTp)); add(associatedTokenAddress(gc.reservedFeeRecipient, WSOL_MINT, quoteTp))
  for (const k of depPools) {
    const p = decoded.get(k.toBase58())!
    add(p.baseMint); add(p.poolBaseTokenAccount); add(p.poolQuoteTokenAccount)
    // coin_creator_vault_ata is a swap account even when coin_creator == default (the program init_if_needed-creates it otherwise — observed in LiteSVM)
    add(associatedTokenAddress(coinCreatorVaultAuthorityPda(p.coinCreator), WSOL_MINT, quoteTp))
    if (!p.coinCreator.equals(PublicKey.default)) add(poolV2Pda(p.baseMint))
  }
  const r2 = await rpc.getMultipleAccounts(depKeys)
  const dep = (k: PublicKey): RawAccount | undefined => r2.bundle.accounts.get(k.toBase58())
  const missing = r2.missing.map(m => m.toBase58())
  console.log(`dependents: ${depKeys.length} requested, ${missing.length} missing: ${missing.join(',')}`)
  const quoteReserveOf = (k: PublicKey): bigint => { const p = decoded.get(k.toBase58())!; const v = dep(p.poolQuoteTokenAccount); if (!v || v.data.length < 72) return -1n; let x = 0n; for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(v.data[64 + i]!); return x }
  const pick = (cands: PublicKey[]): PublicKey | null => { const ok = cands.filter(k => dep(decoded.get(k.toBase58())!.poolBaseTokenAccount) && quoteReserveOf(k) > 0n); ok.sort((a, b) => (quoteReserveOf(b) > quoteReserveOf(a) ? 1 : -1)); return ok[0] ?? null }
  const canonicalPick = canonVerified.includes(CANONICAL_PRIMARY) && quoteReserveOf(CANONICAL_PRIMARY) > 0n ? CANONICAL_PRIMARY : pick(canonVerified.slice(0, 3))
  const nonCanonPick = pick(nonCanonVerified.slice(0, 3))
  if (!canonicalPick || !nonCanonPick || !decoded.has(BOOSTED.toBase58())) throw new Error(`selection failed canonical=${canonicalPick?.toBase58()} noncanonical=${nonCanonPick?.toBase58()}`)
  // --- save fixtures ------------------------------------------------------------------------------------------------------
  const globalsFx: AccountFixture[] = [rawToFixture(gcAcc, SOURCE, 'GlobalConfig PDA ["global_config"]'), rawToFixture(fcAcc, SOURCE, 'FeeConfig PDA ["fee_config", pump_amm] under pump_fees'), rawToFixture(gvaAcc, SOURCE, 'global_volume_accumulator PDA')]
  saveFixture(`${OUT}/global.json`, { description: 'PumpSwap global accounts (mainnet, read-only fetch)', accounts: globalsFx })
  const manifest: Record<string, unknown> = { fetched_at_utc: nowUtcIso(), rpc: RPC_URL, slot_request1: r1.context.slot, slot_request2: r2.context.slot, pools: {}, missing_dependents: missing, protocol_fee_recipient_first: protocolRecipient.toBase58(), buyback_fee_recipient_first: buybackRecipient.toBase58() }
  const savePool = async (role: string, k: PublicKey) => {
    const p = decoded.get(k.toBase58())!; const poolAcc = acc(k)!
    const fx: AccountFixture[] = [rawToFixture(poolAcc, SOURCE, `${role} pool`), ...globalsFx]
    const push = (key: PublicKey, note: string) => { const a = dep(key); if (a) fx.push(rawToFixture(a, SOURCE, note)); else (manifest['missing_dependents'] as string[]).push(`${key.toBase58()} (${note})`) }
    push(p.baseMint, 'base_mint'); push(WSOL_MINT, 'quote_mint (WSOL)'); push(p.poolBaseTokenAccount, 'pool_base_token_account'); push(p.poolQuoteTokenAccount, 'pool_quote_token_account')
    push(associatedTokenAddress(protocolRecipient, WSOL_MINT, quoteTp), 'protocol_fee_recipient[0] WSOL ATA'); push(associatedTokenAddress(buybackRecipient, WSOL_MINT, quoteTp), 'buyback_fee_recipient[0] WSOL ATA')
    if (p.isMayhemMode) push(associatedTokenAddress(gc.reservedFeeRecipient, WSOL_MINT, quoteTp), 'reserved_fee_recipient WSOL ATA (mayhem)')
    push(associatedTokenAddress(coinCreatorVaultAuthorityPda(p.coinCreator), WSOL_MINT, quoteTp), p.coinCreator.equals(PublicKey.default) ? 'coin_creator_vault_ata (coin_creator=default)' : 'coin_creator_vault_ata')
    if (!p.coinCreator.equals(PublicKey.default)) push(poolV2Pda(p.baseMint), 'pool-v2 PDA (expected NULL on mainnet)')
    const bm = dep(p.baseMint)
    saveFixture(`${OUT}/pool_${role}.json`, { description: `PumpSwap ${role} pool ${k.toBase58()} + dependents (mainnet slot ${r2.context.slot})`, accounts: fx })
    ;(manifest['pools'] as Record<string, unknown>)[role] = { address: k.toBase58(), base_mint: p.baseMint.toBase58(), base_token_program: bm?.owner.equals(TOKEN_2022_PROGRAM_ID) ? 'token_2022' : 'spl_token', creator: p.creator.toBase58(), coin_creator: p.coinCreator.toBase58(), canonical: isPumpPool(p.baseMint, p.creator), virtual_quote_reserves: p.virtualQuoteReserves.toString(), layout_length: p.layoutLength, quote_reserve: quoteReserveOf(k).toString(), is_cashback_coin: p.isCashbackCoin, is_mayhem_mode: p.isMayhemMode }
    console.log(`saved ${role}: ${k.toBase58()} base=${p.baseMint.toBase58()} len=${p.layoutLength} vqr=${p.virtualQuoteReserves} quoteReserve=${quoteReserveOf(k)} coin_creator=${p.coinCreator.toBase58()}`)
  }
  await savePool('canonical', canonicalPick); await savePool('boosted', BOOSTED); await savePool('noncanonical', nonCanonPick)
  // --- program dumps ---------------------------------------------------------------------------------------------------------
  for (const pid of [PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID]) {
    const so = `${PROG_OUT}/${pid.toBase58()}.so`, side = `${PROG_OUT}/${pid.toBase58()}.json`
    if (existsSync(so) && existsSync(side) && !refreshPrograms) { console.log(`program ${pid.toBase58()} present (${JSON.parse(readFileSync(side, 'utf8')).bytes} bytes), skipping`); continue }
    const d = await dumpProgram(rpc, pid)
    writeFileSync(so, d.elf)
    writeFileSync(side, JSON.stringify({ programId: pid.toBase58(), programDataAddress: d.programDataAddress?.toBase58() ?? null, slot: d.slot, sha256: sha256Hex(d.elf), fetched_at_utc: nowUtcIso(), bytes: d.elf.length, loader: d.loader, source: SOURCE }, null, 1))
    console.log(`dumped ${pid.toBase58()}: ${d.elf.length} bytes slot ${d.slot}`)
  }
  manifest['rpc_requests_used'] = rpc.usage.total
  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1))
  console.log(`RPC requests used: ${rpc.usage.total}`)
}
main().catch(e => { console.error(e); process.exit(1) })
