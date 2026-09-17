import { describe, it, expect } from 'vitest'
import { readPumpswapInventory, groupByBaseMint, inventoryAgeDays, provenancePathFor, PUMPSWAP_INVENTORY_SOURCE_KIND } from '../../src/discovery/local_inventory.js'
import { WSOL_B58 } from '../../src/discovery/raydium_api.js'
const SAMPLE = 'tests/fixtures/discovery/pumpswap_inventory_sample.jsonl.gz'
describe('PumpSwap local inventory reader', () => {
  it('reads real-shaped records, skips malformed/non-WSOL lines with reasons, dedups addresses', () => {
    const r = readPumpswapInventory(SAMPLE)
    expect(r.lines).toBe(12); expect(r.records).toBe(7); expect(r.pools.length).toBe(7)
    const reasons = r.skipped.map(s => s.reason).sort()
    expect(reasons).toEqual(['BAD_INDEX', 'BAD_JSON', 'BAD_PUBKEY', 'QUOTE_NOT_REQUIRED_MINT'])
    expect(r.duplicateAddresses.length).toBe(1)
    expect(r.provenancePath).toBe(provenancePathFor(SAMPLE)); expect(r.provenance?.source_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.sourceRef).toBe(r.provenance?.source_sha256); expect(r.observedAtUtc).toBe('2026-09-04T14:12:34.613Z'); expect(r.inventorySha256).toMatch(/^[0-9a-f]{64}$/)
    for (const p of r.pools) {
      expect(p.adapter).toBe('pumpswap'); expect(p.source).toEqual({ kind: PUMPSWAP_INVENTORY_SOURCE_KIND, ref: r.sourceRef, observedAtUtc: r.observedAtUtc })
      expect(p.hints?.['quote_mint']).toBe(WSOL_B58); expect(typeof p.hints?.['base_mint']).toBe('string'); expect(typeof p.hints?.['index']).toBe('number'); expect(typeof p.hints?.['canonical']).toBe('boolean'); expect(p.hints?.['tvl']).toBeNull(); expect(p.hints?.['liquidityHint']).toBe('unknown')
    }
  })
  it('groups by base mint deterministically', () => {
    const r = readPumpswapInventory(SAMPLE); const g = groupByBaseMint(r.pools)
    const sizes = [...g.values()].map(v => v.length).sort((a, b) => b - a)
    expect(sizes).toEqual([3, 2, 1, 1]); expect(g.size).toBe(4)
    expect([...g.keys()]).toEqual([...groupByBaseMint(readPumpswapInventory(SAMPLE).pools).keys()])
  })
  it('missing file is an error, not an empty success', () => { expect(() => readPumpswapInventory('tests/fixtures/discovery/does_not_exist.jsonl.gz')).toThrow(/INVENTORY_MISSING/) })
  it('age in days', () => { expect(inventoryAgeDays('2026-09-04T14:12:34.613Z', '2026-09-17T13:13:15.712Z')).toBe(13); expect(inventoryAgeDays('2026-09-17T00:00:00Z', '2026-09-17T12:00:00Z')).toBe(0.5) })
})
