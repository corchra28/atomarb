/**
 * Fetches on-chain fixtures for the Raydium CPMM adapter (read-only, public RPC, <=40 HTTP requests) and dumps the program ELF.
 *   npx tsx scripts/fetch_fixtures_raydium.ts [--skip-program] [--discover]
 * Pools (chosen 2026-09-17 from https://api-v3.raydium.io/pools/info/list-v2?size=100&mint1=WSOL&poolType=Standard&sortField=liquidity&sortType=desc
 * filtered by programId == CPMMoo8L… and from /pools/info/mint?mint1=WSOL&mint2=<BERN>&poolType=standard; see docs/sources/raydium_cpmm.md §8):
 *   47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4  WSOL/USDC   (large, AmmConfig index 5, SPL Token both sides)
 *   Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp  WSOL/USELESS (LaunchLab-migrated pool: launchMigratePool=true → creator fee may be enabled)
 *   9vQSDkK4HUSX7gJRVEqPu4wXmU6N7KtKx58EysDwCPCA  WSOL/BERN   (BERN is a Token-2022 mint with TransferFeeConfig; tiny pool, ~$3 TVL, reserves almost all accrued fees)
 *   A3URwhZE2YyVNKL9CmSvU9VG1oJoZS78kX4AdK5faDud  WSOL/LOOP   (Token-2022 mint, ~$230k TVL; page 2 of the list-v2 query, nextPageId a9399336-…)
 *   3ceKnrpPPUuz9FVsDJuYfTqbK5ia6KND7SQwcnRJ38KC  WSOL/SolARBa (Token-2022 mint, ~$225k TVL; same page)
 * Flags: --skip-program (no ELF dump), --skip-epoch (no getEpochSchedule/getEpochInfo), --only <id>[,<id>] (subset of POOLS; index.json is merged).
 * Per pool, ONE getMultipleAccounts fetches [pool, amm_config, vault0, vault1, mint0, mint1, observation, authority] so every fixture file is a single-batch snapshot.
 * Every account is saved with provenance (slot, fetched_at_utc, source). The program ELF goes to tests/fixtures/programs/<programId>.so + .json sidecar.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { RpcClient } from '../src/state/rpc.js'
import { dumpProgram } from '../src/simulation/local_svm.js'
import { rawToFixture, saveFixture, type FixtureFile } from '../tests/helpers/fixtures.js'
import { decodePoolState, authorityPda, RAYDIUM_CPMM_PROGRAM_ID } from '../src/adapters/raydium_cpmm/layout.js'
import { isUnsupported } from '../src/adapters/types.js'
import { sha256Hex } from '../src/util/hash.js'
import { nowUtcIso } from '../src/util/time.js'

const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com'
const OUT_DIR = new URL('../tests/fixtures/raydium_cpmm/', import.meta.url).pathname
const PROG_DIR = new URL('../tests/fixtures/programs/', import.meta.url).pathname
const POOLS: { id: string; label: string }[] = [
  { id: '47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4', label: 'WSOL/USDC large (config 5)' },
  { id: 'Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp', label: 'WSOL/USELESS LaunchLab-migrated (config 0)' },
  { id: '9vQSDkK4HUSX7gJRVEqPu4wXmU6N7KtKx58EysDwCPCA', label: 'WSOL/BERN Token-2022 transfer-fee mint (config 2, tiny)' },
  { id: 'A3URwhZE2YyVNKL9CmSvU9VG1oJoZS78kX4AdK5faDud', label: 'WSOL/LOOP Token-2022 mint (config 0)' },
  { id: '3ceKnrpPPUuz9FVsDJuYfTqbK5ia6KND7SQwcnRJ38KC', label: 'WSOL/SolARBa Token-2022 mint (config 0)' },
]
const skipProgram = process.argv.includes('--skip-program')
const skipEpoch = process.argv.includes('--skip-epoch')
const discover = process.argv.includes('--discover')
const onlyArg = process.argv.indexOf('--only')
const ONLY = onlyArg >= 0 ? new Set((process.argv[onlyArg + 1] ?? '').split(',').filter(Boolean)) : null
const SELECTED = ONLY ? POOLS.filter(p => ONLY.has(p.id)) : POOLS

async function main(): Promise<void> {
  const rpc = new RpcClient(RPC_URL, { maxRequestsPerSecond: 4, maxConcurrentRequests: 2, maxTotalHttpRequests: 40, requestTimeoutMs: 30_000, backoff: { baseMs: 500, maxMs: 10_000, jitter: 0.3 } }, 'confirmed')
  let apiRequests = 0
  if (discover) {
    // Discovery is informational only; the pool set above is fixed so that fixtures stay reproducible.
    const url = 'https://api-v3.raydium.io/pools/info/list-v2?size=100&mint1=So11111111111111111111111111111111111111112&poolType=Standard&sortField=liquidity&sortType=desc'
    apiRequests++
    const r = await fetch(url); const j = (await r.json()) as { data: { data: { id: string; programId: string; tvl: number; mintA: { symbol: string; programId: string }; mintB: { symbol: string; programId: string; address: string }; config?: { index: number }; launchMigratePool?: boolean }[] } }
    for (const it of j.data.data) if (it.programId === RAYDIUM_CPMM_PROGRAM_ID.toBase58()) console.log(`candidate ${it.id} ${it.mintA.symbol}/${it.mintB.symbol} tvl=${Math.round(it.tvl)} cfg=${it.config?.index} mintB_program=${it.mintB.programId.slice(0, 6)} launchMigrate=${it.launchMigratePool}`)
  }
  if (SELECTED.length === 0) throw new Error('no pools selected')
  const poolKeys = SELECTED.map(p => new PublicKey(p.id))
  const first = await rpc.getMultipleAccounts(poolKeys)
  const source = `rpc:${RPC_URL} getMultipleAccounts commitment=confirmed`
  const summary: Record<string, unknown>[] = []
  for (const p of SELECTED) {
    const acc = first.bundle.accounts.get(p.id)
    if (!acc) { console.error(`POOL_MISSING ${p.id}`); continue }
    const st = decodePoolState(acc.data)
    if (isUnsupported(st)) { console.error(`POOL_UNDECODABLE ${p.id}: ${st.reason}`); continue }
    const [authority] = authorityPda()
    const keys = [acc.pubkey, st.ammConfig, st.token0Vault, st.token1Vault, st.token0Mint, st.token1Mint, st.observationKey, authority]
    const roles = ['pool_state', 'amm_config', 'token_0_vault', 'token_1_vault', 'token_0_mint', 'token_1_mint', 'observation_state', 'authority_pda']
    const snap = await rpc.getMultipleAccounts(keys)
    const file: FixtureFile = { description: `Raydium CPMM pool ${p.id} (${p.label}); single getMultipleAccounts batch at slot ${snap.context.slot}; roles in note field`, accounts: [] }
    keys.forEach((k, i) => {
      const a = snap.bundle.accounts.get(k.toBase58())
      if (!a) { console.log(`  ${roles[i]} ${k.toBase58()} does not exist on mainnet (not saved)`); return }
      file.accounts.push(rawToFixture(a, source, roles[i]))
    })
    saveFixture(`${OUT_DIR}${p.id}.json`, file)
    summary.push({ pool: p.id, label: p.label, slot: snap.context.slot, accounts: file.accounts.length, missing: snap.missing.map(m => m.toBase58()), status: st.status, openTime: st.openTime.toString(), enableCreatorFee: st.enableCreatorFee, creatorFeeOn: st.creatorFeeOn, token0Program: st.token0Program.toBase58(), token1Program: st.token1Program.toBase58() })
    console.log(`saved ${p.id}.json (${file.accounts.length} accounts, slot ${snap.context.slot})`)
  }
  // Epoch schedule (needed to map a context slot to the epoch used by Token-2022 calculate_epoch_fee) + current epoch for provenance.
  if (!skipEpoch) {
  const sched = await rpc.call<{ slotsPerEpoch: number; leaderScheduleSlotOffset: number; warmup: boolean; firstNormalEpoch: number; firstNormalSlot: number }>('getEpochSchedule', [])
  const info = await rpc.call<{ epoch: number; slotIndex: number; slotsInEpoch: number; absoluteSlot: number; blockHeight: number }>('getEpochInfo', [{ commitment: 'confirmed' }])
  writeFileSync(`${OUT_DIR}epoch.json`, JSON.stringify({ source: `rpc:${RPC_URL} getEpochSchedule + getEpochInfo`, fetched_at_utc: nowUtcIso(), epochSchedule: sched, epochInfo: info }, null, 1))
  console.log(`saved epoch.json: slotsPerEpoch=${sched.slotsPerEpoch} warmup=${sched.warmup} firstNormalEpoch=${sched.firstNormalEpoch} firstNormalSlot=${sched.firstNormalSlot} epoch=${info.epoch} absoluteSlot=${info.absoluteSlot}`)
  }
  if (!skipProgram) {
    const dump = await dumpProgram(rpc, RAYDIUM_CPMM_PROGRAM_ID)
    if (!existsSync(PROG_DIR)) mkdirSync(PROG_DIR, { recursive: true })
    const id = RAYDIUM_CPMM_PROGRAM_ID.toBase58()
    writeFileSync(`${PROG_DIR}${id}.so`, dump.elf)
    writeFileSync(`${PROG_DIR}${id}.json`, JSON.stringify({ programId: id, programDataAddress: dump.programDataAddress?.toBase58() ?? null, loader: dump.loader, slot: dump.slot, sha256: sha256Hex(dump.elf), fetched_at_utc: nowUtcIso(), bytes: dump.elf.length, source: `rpc:${RPC_URL} getMultipleAccounts(program, programdata) header 45 bytes stripped` }, null, 1))
    console.log(`saved program ${id}.so (${dump.elf.length} bytes, slot ${dump.slot}, sha256 ${sha256Hex(dump.elf).slice(0, 16)}…)`)
  }
  const indexPath = `${OUT_DIR}index.json`
  const prev = existsSync(indexPath) ? (JSON.parse(readFileSync(indexPath, 'utf8')) as { pools: Record<string, unknown>[] }).pools : []
  const merged = [...prev.filter(x => !summary.some(s => s['pool'] === x['pool'])), ...summary]
  writeFileSync(indexPath, JSON.stringify({ fetched_at_utc: nowUtcIso(), pools: merged }, null, 1))
  console.log(`RPC requests used: ${rpc.usage.total} (errors ${rpc.usage.errors}, retries ${rpc.usage.retries}); API requests: ${apiRequests}`)
}
main().catch(e => { console.error(e); process.exit(1) })
