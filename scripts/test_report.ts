import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
/**
 * Runs the full vitest suite with the JSON reporter and writes TEST_REPORT.md with counts per category
 * (unit / fixture / local-real-program integration / network-skipped) plus the Rust unit-test log if present. Never hides SKIPPED.
 */
mkdirSync('data', { recursive: true })
let vitestExit = 0
try { execSync('npx vitest run --reporter=json --outputFile=data/test-results.json', { stdio: 'inherit', env: { ...process.env } }) } catch (e) { vitestExit = (e as { status?: number }).status ?? 1 }
const j = JSON.parse(readFileSync('data/test-results.json', 'utf8')) as { numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number; testResults: { name: string; status: string; assertionResults: { status: string; fullName: string; failureMessages: string[] }[] }[] }
const cat = (f: string) => f.includes('/integration/') ? (f.includes('network') ? 'network' : 'local_real_program_integration') : (f.includes('fixture') ? 'fixture' : 'unit')
const rows: Record<string, { pass: number; fail: number; skip: number; files: number }> = {}
const failures: string[] = []
for (const t of j.testResults) {
  const c = cat(t.name); const r = (rows[c] ??= { pass: 0, fail: 0, skip: 0, files: 0 }); r.files++
  for (const a of t.assertionResults) { if (a.status === 'passed') r.pass++; else if (a.status === 'failed') { r.fail++; failures.push(`${t.name.replace(process.cwd() + '/', '')} :: ${a.fullName} :: ${a.failureMessages.join(' | ').slice(0, 300)}`) } else r.skip++ }
}
const rust = existsSync('data/cargo-test.log') ? readFileSync('data/cargo-test.log', 'utf8').split('\n').filter(l => /^test result:/.test(l)).join('\n') : 'NOT_RUN (no data/cargo-test.log)'
const lines = [`# TEST_REPORT (generated ${new Date().toISOString()})`, '', `vitest exit code: ${vitestExit}; total=${j.numTotalTests} passed=${j.numPassedTests} failed=${j.numFailedTests} skipped=${j.numPendingTests}`, '', '| category | files | pass | fail | skipped |', '|---|---|---|---|---|', ...Object.entries(rows).map(([k, v]) => `| ${k} | ${v.files} | ${v.pass} | ${v.fail} | ${v.skip} |`), '', `mainnet_simulation tests: none in the suite (mainnet simulations are produced by the simulate/shadow commands and recorded in reports/runs; they are not unit tests).`, '', '## Rust (programs/arb_executor, cargo test)', '', '```', rust, '```', '', '## Failures', '', ...(failures.length ? failures.map(f => `- ${f}`) : ['none']), '', 'Legend: unit = pure logic with mocks/fixtures; fixture = byte-exact decoding of real on-chain accounts saved with provenance; local_real_program_integration = real program ELFs executed in LiteSVM with synthetic labelled balances; network = live RPC/API tests (skipped unless ATOMARB_NETWORK_TESTS=1). Zero probes in a category means NOT_TESTED, not PASS.']
writeFileSync('TEST_REPORT.md', lines.join('\n'))
console.log(lines.join('\n'))
process.exit(vitestExit)
