import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RunControl } from '../../src/telemetry/control.js'
import { loadConfig } from '../../src/config/load.js'
describe('RunControl', () => {
  it('stops on STOP file, deadline, HTTP budget and disk budget', () => {
    const d = mkdtempSync(join(tmpdir(), 'atomarb-'))
    const c = new RunControl({ maxDurationMs: 10_000, maxHttpRequests: 5, maxDiskBytes: 100, stopFile: join(d, 'STOP'), dataDir: d })
    expect(c.check(0)).toBeNull()
    expect(c.check(5)).toBe('HTTP_BUDGET')
    writeFileSync(join(d, 'big.bin'), Buffer.alloc(200)); expect(c.check(0)).toBe('DISK_BUDGET'); rmSync(join(d, 'big.bin'))
    writeFileSync(join(d, 'STOP'), 'x'); expect(c.check(0)).toBe('STOP_FILE'); rmSync(join(d, 'STOP'))
    const c2 = new RunControl({ maxDurationMs: 0, maxHttpRequests: 5, maxDiskBytes: 1e9, stopFile: join(d, 'STOP'), dataDir: d }); expect(c2.check(0)).toBe('DEADLINE')
    rmSync(d, { recursive: true })
  })
})
describe('config', () => {
  it('loads the example, hashes it, and refuses live=true', () => {
    const l = loadConfig('config/config.example.json'); expect(l.config.execution.live).toBe(false); expect(l.configHash).toHaveLength(64)
    const d = mkdtempSync(join(tmpdir(), 'atomarb-')); const p = join(d, 'c.json')
    const raw = JSON.parse(JSON.stringify(l.config)) as { execution: { live: boolean } }; raw.execution.live = true; writeFileSync(p, JSON.stringify(raw))
    expect(() => loadConfig(p)).toThrow(/CONFIG_INVALID|LIVE_NOT_AUTHORIZED/)
    writeFileSync(p, JSON.stringify({ version: 1 })); expect(() => loadConfig(p)).toThrow(/CONFIG_INVALID/)
    rmSync(d, { recursive: true })
  })
})
