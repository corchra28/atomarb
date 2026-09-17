/**
 * Fault injection: deliberately breaks one invariant at a time in a TRACKED source file, runs the tests that must catch it, then restores the file
 * with `git checkout --`. A mutation that leaves the suite green is a reported HOLE (the tests prove nothing about that invariant).
 * Nothing is committed and no mutation survives the run (verified with `git status --porcelain` at the end).
 * Usage: npx tsx scripts/fault_injection.ts [--only <id>]
 */
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
interface Mutation { id: string; file: string; find: string; replace: string; tests: string[]; invariant: string }
const M: Mutation[] = [
  { id: 'pumpswap_drop_creator_fee', file: 'src/adapters/pumpswap/math.ts', find: 'const lpFee = feeCeil(effectiveQuote, fees.lpBps), protocolFee = feeCeil(effectiveQuote, fees.protocolBps), creatorFee = feeCeil(effectiveQuote, fees.creatorBps)', replace: 'const lpFee = feeCeil(effectiveQuote, fees.lpBps), protocolFee = feeCeil(effectiveQuote, fees.protocolBps), creatorFee = 0n', tests: ['tests/unit/pumpswap_math.test.ts', 'tests/unit/pumpswap_sdk_crosscheck.test.ts', 'tests/integration/pumpswap_local_program.test.ts'], invariant: 'creator fee is charged on PumpSwap buys' },
  { id: 'raydium_raw_vault_reserves', file: 'src/adapters/raydium_cpmm/math.ts', find: '  return { ok: true, reserve0: vault0Amount - fees0, reserve1: vault1Amount - fees1, fees0, fees1 }', replace: '  return { ok: true, reserve0: vault0Amount, reserve1: vault1Amount, fees0, fees1 }', tests: ['tests/unit/raydium_adapter.test.ts', 'tests/integration/raydium_local_program.test.ts'], invariant: 'pricing reserves exclude protocol/fund/creator fees held in the vault' },
  { id: 'accounting_double_count_dex_fees', file: 'src/accounting/pnl.ts', find: 'return { ...t, externalCosts: ext.costs, lockedCapital: ext.locked, pnlAfterExternal: t.pnl - ext.total,', replace: 'return { ...t, externalCosts: ext.costs, lockedCapital: ext.locked, pnlAfterExternal: t.pnl - ext.total - t.feesInsideQuotes.reduce((s, f) => s + f.amount, 0n),', tests: ['tests/unit/accounting.test.ts'], invariant: 'fees already inside the quotes are never subtracted a second time' },
  { id: 'routing_sell_preexisting_inventory', file: 'src/routing/circuit.ts', find: 'const qb = B.quoteExactIn(c.poolB, c.token, qa.amountOutToUser)', replace: 'const qb = B.quoteExactIn(c.poolB, c.token, qa.amountOutToUser + 1n)', tests: ['tests/unit/routing.test.ts', 'tests/integration/circuit_local_program.test.ts'], invariant: 'leg B consumes exactly leg A output (no pre-existing inventory)' },
  { id: 'probe_ignore_realised_delta', file: 'src/simulation/probe.ts', find: 'const realised = deltas ? { pnl: deltas.baseAta, matchesQuote: deltas.baseAta === quoted.pnl && deltas.interAta === 0n } : null', replace: 'const realised = deltas ? { pnl: quoted.pnl, matchesQuote: true } : null', tests: ['tests/integration/circuit_local_program.test.ts'], invariant: 'realised PnL is measured from on-chain balance deltas, never copied from the quote' },
  { id: 'rpc_allow_send', file: 'src/state/rpc.ts', find: "private static readonly FORBIDDEN = new Set(['sendTransaction', 'sendRawTransaction', 'sendBundle', 'requestAirdrop'])", replace: 'private static readonly FORBIDDEN = new Set<string>([])', tests: ['tests/unit/rpc_client.test.ts'], invariant: 'submit RPC methods are refused (read-only)' },
  { id: 'snapshot_claim_single_batch', file: 'src/state/rpc.ts', find: 'return { bundle: { accounts, singleBatch: batchIds.length === 1, minSlot: keys.length ? minSlot : 0, maxSlot, batchIds }, missing }', replace: 'return { bundle: { accounts, singleBatch: true, minSlot: keys.length ? minSlot : 0, maxSlot, batchIds }, missing }', tests: ['tests/unit/rpc_client.test.ts'], invariant: 'a multi-call fetch is never reported as one atomic snapshot' },
]
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
const results: { id: string; invariant: string; file: string; applied: boolean; caughtBy: string[]; missedBy: string[]; hole: boolean }[] = []
for (const m of M) {
  if (only && m.id !== only) continue
  if (!existsSync(m.file)) { results.push({ id: m.id, invariant: m.invariant, file: m.file, applied: false, caughtBy: [], missedBy: [], hole: true }); continue }
  const orig = readFileSync(m.file, 'utf8')
  if (!orig.includes(m.find)) { console.error(`SKIP ${m.id}: anchor not found in ${m.file}`); results.push({ id: m.id, invariant: m.invariant, file: m.file, applied: false, caughtBy: [], missedBy: [], hole: true }); continue }
  writeFileSync(m.file, orig.replace(m.find, m.replace))
  const caughtBy: string[] = []; const missedBy: string[] = []
  try {
    for (const t of m.tests) {
      if (!existsSync(t)) { missedBy.push(`${t} (missing)`); continue }
      try { execFileSync('npx', ['vitest', 'run', t], { stdio: 'pipe', timeout: 600_000 }); missedBy.push(t) } catch { caughtBy.push(t) }
    }
  } finally { execSync(`git checkout -- ${m.file}`); }
  const after = readFileSync(m.file, 'utf8')
  if (after !== orig) throw new Error(`RESTORE_FAILED ${m.file}`)
  results.push({ id: m.id, invariant: m.invariant, file: m.file, applied: true, caughtBy, missedBy, hole: caughtBy.length === 0 })
  console.error(`${caughtBy.length ? 'CAUGHT ' : 'HOLE   '} ${m.id} by ${caughtBy.join(', ') || '(nothing)'}`)
}
const dirty = execSync('git status --porcelain').toString().trim()
const out = { generatedUtc: new Date().toISOString(), mutations: results.length, caught: results.filter(r => !r.hole).length, holes: results.filter(r => r.hole).map(r => r.id), workingTreeCleanAfterRun: dirty === '', dirty, results }
writeFileSync('reports/fault_injection.json', JSON.stringify(out, null, 1))
console.log(JSON.stringify({ mutations: out.mutations, caught: out.caught, holes: out.holes, clean: out.workingTreeCleanAfterRun }))
