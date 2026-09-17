import { createHash } from 'node:crypto'
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
/** Prints sha256 + bytes for every reported artifact (docs, reports, fixtures, program binaries, lockfiles). Usage: npx tsx scripts/hash_artifacts.ts [paths...] */
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['README.md', 'docs', 'sources.lock.json', 'package.json', 'package-lock.json', 'config/config.example.json', 'reports', 'tests/fixtures', 'TEST_REPORT.md', 'DECISION.md', 'BLOCKERS.md', 'CHANGELOG.md', 'RUN_REPORT.md']
function walk(p: string): string[] { if (!existsSync(p)) return []; const s = statSync(p); if (s.isFile()) return [p]; return readdirSync(p).flatMap(n => walk(join(p, n))) }
const rows = targets.flatMap(walk).filter(f => !f.endsWith('.so') || true).sort().map(f => { const b = readFileSync(f); return `${createHash('sha256').update(b).digest('hex')}  ${b.length.toString().padStart(10)}  ${f}` })
console.log(rows.join('\n'))
