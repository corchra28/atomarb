/**
 * OFFLINE end-to-end circuit tests with the REAL Raydium CPMM, PumpSwap AMM and pump_fees ELFs and real route fixtures (tests/fixtures/routes/*.json),
 * executed in LiteSVM with synthetic labelled balances. Evidence level: LOCAL_REAL_PROGRAM_SIMULATION. No network.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { loadFixture, bundleFromFixture } from '../helpers/fixtures.js'
import { loadAdapters, requireAdapters } from '../../src/adapters/registry.js'
import type { AdapterId, PoolRef, AccountBundle, RawAccount } from '../../src/adapters/types.js'
import { isUnsupported } from '../../src/adapters/types.js'
import { enumerateCircuits, evaluateCircuit, sizeCircuit } from '../../src/routing/circuit.js'
import { localProbe, localProbeExecutor } from '../../src/simulation/probe.js'
import { writeU64LE } from '../../src/util/bytes.js'
import { WSOL_MINT } from '../../src/state/token.js'
const COST = { baseFeeLamportsPerSignature: 5000, computeUnitLimit: 400_000, computeUnitPriceMicroLamports: 10_000, jitoTipLamports: 0, ataRentLamports: 2_039_280 }
const ROUTES: { name: string; pools: [AdapterId, string][]; amount: bigint }[] = [
  { name: 'cross_bonk_raydium_pumpswap', pools: [['raydium_cpmm', 'Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp'], ['pumpswap', '7K7U6AUvgJH52ShbNrBcZae1zoGbZz7yay1P89Es5woX']], amount: 100_000_000n },
  { name: 'same_pumpswap_22a4', pools: [['pumpswap', '2UUBCydpzMvioRc3dnSefbuKycjGSkyTtDYbrxGnWzd5'], ['pumpswap', '8JUXPRDDfRbDTN9fsQg1fLKw3u7DM9Cesodu1pcp6WA5']], amount: 10_000_000n },
]
const adaptersP = loadAdapters().then(r => requireAdapters(r.adapters))
function decodeRoute(adapters: Record<AdapterId, import('../../src/adapters/types.js').PoolAdapter>, bundle: AccountBundle, pools: [AdapterId, string][]) {
  return pools.map(([adapter, address]) => {
    const ref: PoolRef = { adapter, address: new PublicKey(address), source: { kind: 'fixture', ref: 'route', observedAtUtc: 'x' } }
    const acc = bundle.accounts.get(address)!
    const req = adapters[adapter].requiredAccounts(ref, acc); if (isUnsupported(req)) throw new Error(req.reason)
    const d = adapters[adapter].decodeSnapshot(ref, bundle); if (isUnsupported(d)) throw new Error(d.reason)
    const v = adapters[adapter].validatePool(d); if (!v.ok) throw new Error(JSON.stringify(v.rejects))
    return d
  })
}
for (const R of ROUTES) {
  const path = `tests/fixtures/routes/${R.name}.json`
  describe.skipIf(!existsSync(path))(`route ${R.name} (real programs, offline)`, () => {
    it('direct two-swap circuit: realised WSOL delta == quoted pnl exactly, no intermediate inventory, and the circuit loses (no artificial profit)', async () => {
      const adapters = await adaptersP; const bundle = bundleFromFixture(loadFixture(path))
      const decoded = decodeRoute(adapters, bundle, R.pools)
      const circuits = enumerateCircuits(decoded); expect(circuits).toHaveLength(2)
      for (const c of circuits) {
        const ev = evaluateCircuit(adapters, c, R.amount); expect(ev.ok, ev.ok ? '' : ev.reason).toBe(true); if (!ev.ok) continue
        const l = await localProbe(null, adapters, c, ev.value, COST, { bundle })
        expect(l.ok, l.err ?? '').toBe(true)
        expect(l.realised!.matchesQuote).toBe(true)
        expect(l.deltas!.baseAta).toBe(ev.value.pnl.pnl)
        expect(l.deltas!.interAta).toBe(0n)
        expect(l.accounting.status).toBe('COMPLETE')
        expect(ev.value.pnl.pnl).toBeLessThan(0n)
        expect(l.loadedPrograms.length).toBeGreaterThanOrEqual(2)
      }
      const s = sizeCircuit(adapters, circuits[0]!, [1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n], 1_000_000_000n, 6)
      expect(s.zeroTradeChosen).toBe(true)
    }, 120_000)
    it('realised PnL is measured, not copied: a tampered quote is reported as NOT matching while the measured delta stays the same', async () => {
      const adapters = await adaptersP; const bundle = bundleFromFixture(loadFixture(path))
      const [c] = enumerateCircuits(decodeRoute(adapters, bundle, R.pools))
      const ev = evaluateCircuit(adapters, c!, R.amount); expect(ev.ok).toBe(true); if (!ev.ok) return
      const honest = await localProbe(null, adapters, c!, ev.value, COST, { bundle })
      expect(honest.realised!.matchesQuote).toBe(true)
      expect(honest.realised!.pnl).toBe(honest.deltas!.baseAta)
      const tampered = { ...ev.value, pnl: { ...ev.value.pnl, pnl: ev.value.pnl.pnl + 1n } }
      const lying = await localProbe(null, adapters, c!, tampered, COST, { bundle })
      expect(lying.ok).toBe(true)
      expect(lying.deltas!.baseAta).toBe(honest.deltas!.baseAta)          // the chain does the same thing
      expect(lying.realised!.pnl).toBe(honest.deltas!.baseAta)            // realised is the measured delta
      expect(lying.realised!.matchesQuote).toBe(false)                    // ... and it does not match the tampered quote
    }, 120_000)
    it('leg A succeeds, leg B fails: the whole transaction reverts, token balances are untouched and only the fee is lost', async () => {
      const adapters = await adaptersP; const bundle = bundleFromFixture(loadFixture(path))
      const [c] = enumerateCircuits(decodeRoute(adapters, bundle, R.pools))
      const ev = evaluateCircuit(adapters, c!, R.amount); expect(ev.ok).toBe(true); if (!ev.ok) return
      // ask leg B for one lamport more than it can produce: leg A lands, leg B trips its slippage guard
      const impossible = { ...ev.value, quoteB: { ...ev.value.quoteB, amountOutToUser: ev.value.quoteB.amountOutToUser + 1n } }
      const l = await localProbe(null, adapters, c!, impossible, COST, { bundle })
      expect(l.ok).toBe(false)
      expect(l.deltas).toBeNull()
      expect(l.balances.after.baseAta).toBe(l.balances.before.baseAta)      // WSOL untouched
      expect(l.balances.after.interAta).toBe(l.balances.before.interAta)    // no intermediate inventory left behind
      expect(l.balances.before.interAta).toBe(0n)
      const lamportsLost = l.balances.before.userLamports - l.balances.after.userLamports
      expect(lamportsLost).toBeGreaterThan(0n)                              // the attempt still costs the network fee
      expect(lamportsLost).toBeLessThanOrEqual(5000n + 4000n)               // base fee + prioritisation only, no rent for accounts that were never created
      expect(l.accounting.status).toBe('ACCOUNTING_INCOMPLETE')
      expect(l.accounting.notes.join(' ') + (l.err ?? '')).toMatch(/.+/)
    }, 120_000)
    it('executor: guard reverts the losing circuit with ProfitBelowMin after both real CPIs (leg A min-out == quote is accepted)', async () => {
      const adapters = await adaptersP; const bundle = bundleFromFixture(loadFixture(path))
      const [c] = enumerateCircuits(decodeRoute(adapters, bundle, R.pools))
      const ev = evaluateCircuit(adapters, c!, R.amount); expect(ev.ok).toBe(true); if (!ev.ok) return
      const x = await localProbeExecutor(null, adapters, c!, ev.value, COST, { bundle, minProfits: [0n] })
      expect(x.runs[0]!.ok).toBe(false)
      expect(x.runs[0]!.executorError).toBe('ProfitBelowMin')
      expect(x.runs[0]!.logsTail.join('\n')).toMatch(/arb_executor leg B/)
      expect(x.verdict).toMatch(/GUARD_REVERTED_LOSING_CIRCUIT/)
    }, 120_000)
    it('executor: SYNTHETIC positive route (pool B WSOL vault inflated locally) passes the guard at min_profit == quoted pnl with exact deltas', async () => {
      const adapters = await adaptersP; const bundle = bundleFromFixture(loadFixture(path))
      // choose the direction whose pool B is the pool we inflate: make pool B pay much more WSOL by raising its WSOL vault balance (LOCAL, LABELLED SYNTHETIC STATE)
      const decoded0 = decodeRoute(adapters, bundle, R.pools)
      const poolB = decoded0[1]!
      const vault = poolB.vaultA.mint.equals(WSOL_MINT) ? poolB.vaultA : poolB.vaultB
      const raw = bundle.accounts.get(vault.address.toBase58())!
      const inflated: RawAccount = { ...raw, data: new Uint8Array(raw.data) }
      inflated.data.set(writeU64LE(vault.amount * 1000n + 1_000_000_000_000n), 64)
      // WSOL vault is a native token account: lamports must cover the new amount + rent (LiteSVM enforces balance == amount + rent on native accounts only via the token program; keep them consistent)
      inflated.lamports = raw.lamports + (vault.amount * 999n + 1_000_000_000_000n)
      const b2: AccountBundle = { ...bundle, accounts: new Map(bundle.accounts) }; b2.accounts.set(vault.address.toBase58(), inflated)
      const decoded = decodeRoute(adapters, b2, R.pools)
      const c = enumerateCircuits(decoded).find(x => x.poolB.address.equals(poolB.address))!
      const ev = evaluateCircuit(adapters, c, R.amount); expect(ev.ok, ev.ok ? '' : ev.reason).toBe(true); if (!ev.ok) return
      expect(ev.value.pnl.pnl, 'synthetic state must make the circuit profitable').toBeGreaterThan(0n)
      const x = await localProbeExecutor(null, adapters, c, ev.value, COST, { bundle: b2, minProfits: [ev.value.pnl.pnl, ev.value.pnl.pnl + 1n] })
      expect(x.runs[0]!.ok, x.runs[0]!.err ?? '').toBe(true)
      expect(x.runs[0]!.deltas!.baseAta).toBe(ev.value.pnl.pnl)
      expect(x.runs[0]!.deltas!.interAta).toBe(0n)
      expect(x.runs[1]!.ok).toBe(false); expect(x.runs[1]!.executorError).toBe('ProfitBelowMin')   // one lamport above the realised profit fails
      const d = await localProbe(null, adapters, c, ev.value, COST, { bundle: b2 })
      expect(d.ok).toBe(true); expect(d.realised!.matchesQuote).toBe(true)
    }, 180_000)
  })
}
