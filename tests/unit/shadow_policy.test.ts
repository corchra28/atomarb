/**
 * Regression tests for the shadow scanner's decision policy, reproducing the independent auditor's counter-examples at commit 2c78a61.
 * Everything here is pure: no RPC, no network, no clock — the monotonic instants are injected, so the assertions are deterministic.
 *   F2 — the staleness gate measured the age ONCE right after the snapshot and reused that number as the gate after quoting, sizing and a blockhash round trip.
 *   F7 — sizing searched up to config.sizing.maxCapitalLamports while the ledger grants at most 20% of capital INCLUDING the fee, so the chosen size was
 *        refused with EPISODE_CAP and the scanner gave up, even though a smaller size was positive on the same quote; deposits were not reserved at all.
 *   F6 — `Number(argv[argv.indexOf('--max-requests') + 1] || 120)` parsed the node binary path when the flag was absent and produced NaN, disabling the budget.
 */
import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { MockAdapter, mockPool } from '../helpers/mock_adapter.js'
import { enumerateCircuits, sizeCircuit, type Circuit, type CircuitEval } from '../../src/routing/circuit.js'
import { CapitalLedger } from '../../src/accounting/capital.js'
import { externalCosts } from '../../src/accounting/pnl.js'
import { stalenessGate, newDecisionClock, markStage, clockStages, effectiveSizingCap, reserveBestSize, CAPITAL_CAP_CODES } from '../../src/cli/shadow.js'
import { flagValue, positiveIntFlag, FlagError } from '../../src/util/flags.js'

const SOL = 1_000_000_000n
const adapters = { raydium_cpmm: new MockAdapter('raydium_cpmm'), pumpswap: new MockAdapter('pumpswap') }

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// F2 — state age at the moments that matter
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('F2 staleness gate', () => {
  const MAX = 3_000

  it('reproduces the audit: fresh 3 ms after the snapshot, STALE at the simulation gate on the very same snapshot', () => {
    const received = 1_000_000                                   // monotonic ms of the oldest account in the bundle
    const clock = newDecisionClock(received)
    // what the old code measured — once, immediately after snapshotPools returned — and then reused as the gate much later
    const measuredOnce = stalenessGate(received, received + 3, MAX)
    expect(measuredOnce.fresh).toBe(true)
    expect(measuredOnce.ageMs).toBe(3)                           // this is the "state age at decision p50 = 3 ms" of the run report
    // the real path: quoting + sizing, then the decision, then the capital reservation and a getLatestBlockhash round trip
    expect(markStage(clock, 'quoteDone', received + 140)).toBe(140)
    const atDecision = stalenessGate(received, received + 900, MAX)
    expect(markStage(clock, 'decision', received + 900)).toBe(900)
    expect(atDecision.fresh).toBe(true)                          // still fresh when the decision is recorded
    expect(markStage(clock, 'buildDone', received + 2_950)).toBe(2_950)
    const atSimulation = stalenessGate(received, received + 3_400, MAX)
    expect(markStage(clock, 'simIssued', received + 3_400)).toBe(3_400)
    // the gate that matters is the LAST one: the decision the old code let through was made on 3.4 s old state
    expect(atSimulation.fresh).toBe(false)
    if (!atSimulation.fresh) { expect(atSimulation.code).toBe('STALE_STATE'); expect(atSimulation.ageMs).toBe(3_400); expect(atSimulation.maxMs).toBe(MAX) }
    expect(atSimulation.ageMs).toBeGreaterThan(measuredOnce.ageMs * 1_000)   // the one number the report showed was off by three orders of magnitude
    // and every stage is recorded separately instead of collapsing into one number
    expect(clockStages(clock)).toEqual({ quoteDone: 140, decision: 900, buildDone: 2_950, simIssued: 3_400 })
  })

  it('gates on the LATEST measurement: an injected delay after a fresh decision makes the simulation stale', () => {
    const received = 5_000
    // same snapshot, three different instants — only the last one decides whether the simulation may be issued
    expect(stalenessGate(received, received + 0, MAX).fresh).toBe(true)
    expect(stalenessGate(received, received + MAX, MAX).fresh).toBe(true)          // the boundary is inclusive, as before
    expect(stalenessGate(received, received + MAX + 1, MAX).fresh).toBe(false)
    const delayed = stalenessGate(received, received + MAX + 1, MAX)
    if (!delayed.fresh) expect(delayed.code).toBe('STALE_STATE')
  })

  it('a clock only ever measures against the snapshot receive time, never against the previous stage', () => {
    const clock = newDecisionClock(10_000)
    markStage(clock, 'quoteDone', 10_100)
    markStage(clock, 'decision', 10_200)
    expect(clockStages(clock).decision).toBe(200)                 // 200 ms of state age, not the 100 ms since the previous stage
    expect(clockStages(clock).buildDone).toBeNull()               // stages that never happened stay null instead of reporting 0
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// F7 — size inside the budget the ledger will actually grant
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
/** A circuit whose pnl is positive at every size in the grid and grows with size, so the unconstrained sizer always picks the largest allowed amount. */
function profitableCircuit(): Circuit {
  const token = Keypair.generate().publicKey
  const cheap = mockPool('raydium_cpmm', token, 1_000n * SOL, 2_000_000_000n * 1_000_000n, 25)   // 2 token units per lamport
  const dear = mockPool('pumpswap', token, 1_000n * SOL, 1_000_000_000n * 1_000_000n, 25)       // 1 token unit per lamport
  const c = enumerateCircuits([cheap, dear]).find(x => x.poolA.address.equals(cheap.address))
  if (!c) throw new Error('fixture: no circuit')
  return c
}
const GRID = [1_000_000n, 10_000_000n, 100_000_000n]
const REFINE = 6
/** The costs of one probe under the default config: definitive fee budget (base + priority) and the recoverable ATA deposit. */
const ext = externalCosts({ baseFeeLamports: 5_000n, signatures: 1, computeUnitLimit: 400_000, computeUnitPriceMicroLamports: 10_000, jitoTipLamports: 0n, nonRecoverableRentLamports: 0n, recoverableRentLamports: 2_039_280n })
const FEE = ext.total                       // 5000 base + 4000 priority = 9000 definitive lamports
const DEPOSIT = ext.locked.reduce((s, c) => s + c.amount, 0n)   // 2_039_280 recoverable lamports parked in the created ATA
const auditorLedger = () => new CapitalLedger({ capitalLamports: SOL / 10n, maxEpisodeFrac: 0.2, maxAggregateOpenFrac: 0.4, reserveFrac: 0.3, maxConcurrent: 3, hypothetical: true })

describe('F7 sizing against the capital the ledger actually grants', () => {
  it('fee budget and deposit are the ones the accounting reports as definitive vs recoverable', () => {
    expect(FEE).toBe(9_000n)
    expect(DEPOSIT).toBe(2_039_280n)
    expect(ext.costs.map(c => c.name)).toEqual(['base_fee', 'priority_fee'])   // the deposit is NOT in `total`
  })

  it("reproduces the audit: sizing at config.sizing.maxCapitalLamports picks 0.1 SOL and the ledger refuses it with EPISODE_CAP", () => {
    const c = profitableCircuit()
    const ledger = auditorLedger()                                    // capital 0.1 SOL
    const unconstrained = sizeCircuit(adapters, c, GRID, SOL / 10n, REFINE).best   // the OLD cap: config.sizing.maxCapitalLamports
    expect(unconstrained).not.toBeNull()
    expect(unconstrained!.amountIn).toBe(SOL / 10n)                   // the whole capital, fee not even counted
    expect(unconstrained!.pnl.pnl).toBeGreaterThan(0n)
    const refused = ledger.reserve({ id: 'old', amountIn: unconstrained!.amountIn, feeBudget: FEE, depositLamports: DEPOSIT, pools: ['pa', 'pb'], mint: 'm', utc: 'u' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('EPISODE_CAP')         // this is where the old scanner gave up
  })

  it('selects a smaller, still-positive size inside the ledger budget and reserves it', () => {
    const c = profitableCircuit()
    const ledger = auditorLedger()
    const cap = effectiveSizingCap(ledger, SOL / 10n, FEE, DEPOSIT)
    expect(cap).toBe(20_000_000n - FEE - DEPOSIT)                     // 20 % of 0.1 SOL, minus the fee budget, minus the deposit
    const best = sizeCircuit(adapters, c, GRID, cap, REFINE).best
    expect(best).not.toBeNull()
    expect(best!.amountIn).toBeGreaterThanOrEqual(10_000_000n)        // at least the 0.01 SOL the auditor showed to be positive
    expect(best!.amountIn).toBeLessThanOrEqual(cap)
    expect(best!.pnl.pnl).toBeGreaterThan(0n)
    const hold = ledger.reserve({ id: 'new', amountIn: best!.amountIn, feeBudget: FEE, depositLamports: DEPOSIT, pools: ['pa', 'pb'], mint: 'm', utc: 'u' })
    expect(hold.ok).toBe(true)
    expect(ledger.locked()).toBe(best!.amountIn + FEE + DEPOSIT)      // amountIn + definitive fee + recoverable deposit
  })

  it('reserveBestSize falls back to the largest size the ledger accepts and records why the first choice was refused', () => {
    const c = profitableCircuit()
    const ledger = auditorLedger()
    const oversized = sizeCircuit(adapters, c, GRID, SOL / 10n, REFINE).best as CircuitEval   // what the unconstrained sizer would hand over
    const att = reserveBestSize({ adapters, circuit: c, best: oversized, grid: GRID, refineSteps: REFINE, maxCapitalLamports: SOL / 10n, ledger, feeBudget: FEE, depositLamports: DEPOSIT, id: 'cand', pools: ['pa', 'pb'], mint: 'm', utc: 'u' })
    expect(att.hold.ok).toBe(true)                                    // the old behaviour stopped at the refusal; now a smaller size is reserved
    expect(att.retried).toBe(true)
    expect(att.refusedFirst).not.toBeNull()
    expect(att.refusedFirst!.code).toBe('EPISODE_CAP')                // the refusal is recorded, not swallowed
    expect(att.refusedFirst!.amountIn).toBe(oversized.amountIn)
    expect(att.chosen.amountIn).toBeLessThan(oversized.amountIn)
    expect(att.chosen.amountIn).toBeLessThanOrEqual(att.capLamports)
    expect(att.chosen.pnl.pnl).toBeGreaterThan(0n)                    // the fallback is a real opportunity, not a token size
    if (att.hold.ok) expect(att.hold.position.amountIn).toBe(att.chosen.amountIn)
    expect(ledger.locked()).toBe(att.chosen.amountIn + FEE + DEPOSIT)
  })

  it('keeps every capital protection: the fallback never exceeds budget(), and an exhausted ledger is still refused', () => {
    const c = profitableCircuit()
    const ledger = auditorLedger()
    const budgetBefore = ledger.budget()
    const oversized = sizeCircuit(adapters, c, GRID, SOL / 10n, REFINE).best as CircuitEval
    const att = reserveBestSize({ adapters, circuit: c, best: oversized, grid: GRID, refineSteps: REFINE, maxCapitalLamports: SOL / 10n, ledger, feeBudget: FEE, depositLamports: DEPOSIT, id: 'cand', pools: ['pa', 'pb'], mint: 'm', utc: 'u' })
    expect(att.chosen.amountIn + FEE + DEPOSIT).toBeLessThanOrEqual(budgetBefore)   // nothing above what the ledger would have granted anyway
    // a second, conflicting probe on the same pools must still be refused — and a conflict is NOT a cap refusal, so it is never retried
    const clash = reserveBestSize({ adapters, circuit: c, best: oversized, grid: GRID, refineSteps: REFINE, maxCapitalLamports: SOL / 10n, ledger, feeBudget: FEE, depositLamports: DEPOSIT, id: 'other', pools: ['pa'], mint: 'm2', utc: 'u' })
    expect(clash.hold.ok).toBe(false)
    if (!clash.hold.ok) { expect(clash.hold.code).toBe('POOL_CONFLICT'); expect(CAPITAL_CAP_CODES.has(clash.hold.code)).toBe(false) }
    expect(clash.retried).toBe(false)
    // and when the fee budget alone eats the whole allowance there is no size to search: the cap is zero, never negative
    expect(effectiveSizingCap(ledger, SOL / 10n, 100n * SOL, DEPOSIT)).toBe(0n)
  })

  it('a ledger with room for the whole chosen size reserves it unchanged (no pointless resizing)', () => {
    const c = profitableCircuit()
    const rich = new CapitalLedger({ capitalLamports: 100n * SOL, maxEpisodeFrac: 0.2, maxAggregateOpenFrac: 0.4, reserveFrac: 0.3, maxConcurrent: 3, hypothetical: true })
    const cap = effectiveSizingCap(rich, SOL / 10n, FEE, DEPOSIT)
    expect(cap).toBe(SOL / 10n)                                       // config max is the binding constraint here, not the ledger
    const best = sizeCircuit(adapters, c, GRID, cap, REFINE).best as CircuitEval
    const att = reserveBestSize({ adapters, circuit: c, best, grid: GRID, refineSteps: REFINE, maxCapitalLamports: SOL / 10n, ledger: rich, feeBudget: FEE, depositLamports: DEPOSIT, id: 'cand', pools: ['pa', 'pb'], mint: 'm', utc: 'u' })
    expect(att.hold.ok).toBe(true); expect(att.retried).toBe(false); expect(att.refusedFirst).toBeNull()
    expect(att.chosen.amountIn).toBe(best.amountIn)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// F6 — numeric flags in the one-off scripts
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe('F6 numeric flag parsing', () => {
  it('reproduces the audit: the old expression turns a missing flag into NaN, which disables the budget', () => {
    const argv = ['/usr/bin/node', '/home/u/atomarb/scripts/route_gaps.ts']          // no --max-requests
    const old = Number(argv[argv.indexOf('--max-requests') + 1] || 120)              // indexOf -> -1, so argv[0] is parsed
    expect(Number.isNaN(old)).toBe(true)
    expect(7 >= old).toBe(false)                                                     // every `usage >= budget` check is false forever
    expect(positiveIntFlag(argv.slice(2), '--max-requests', 120)).toBe(120)          // fixed: the documented default
  })

  it('takes the documented default when the flag is absent and the value when it is present', () => {
    expect(positiveIntFlag([], '--max-requests', 120)).toBe(120)
    expect(positiveIntFlag(['--max-requests', '7'], '--max-requests', 120)).toBe(7)
    expect(positiveIntFlag(['--max-requests=7'], '--max-requests', 120)).toBe(7)
    expect(positiveIntFlag(['--other', 'x', '--max-requests', '42'], '--max-requests', 120)).toBe(42)
    expect(positiveIntFlag(['--max-rps', '3'], '--max-requests', 120)).toBe(120)     // a different flag is not a match
    expect(flagValue([], '--max-requests')).toBeNull()
    expect(flagValue(['--max-requests', '9'], '--max-requests')).toBe('9')
  })

  it('refuses every value that cannot be a budget, with an explicit code', () => {
    const bad: [string[], string][] = [
      [['--max-requests'], 'FLAG_VALUE_MISSING'],                 // flag last, no value
      [['--max-requests', '--max-rps', '3'], 'FLAG_VALUE_MISSING'],// next token is another flag
      [['--max-requests='], 'FLAG_VALUE_MISSING'],
      [['--max-requests', 'abc'], 'FLAG_NOT_AN_INTEGER'],
      [['--max-requests', ''], 'FLAG_NOT_AN_INTEGER'],
      [['--max-requests', '12.5'], 'FLAG_NOT_AN_INTEGER'],
      [['--max-requests', '1e3'], 'FLAG_NOT_AN_INTEGER'],         // no silent exponent parsing
      [['--max-requests', 'NaN'], 'FLAG_NOT_AN_INTEGER'],
      [['--max-requests', 'Infinity'], 'FLAG_NOT_AN_INTEGER'],
      [['--max-requests', '99999999999999999999'], 'FLAG_NOT_AN_INTEGER'],
      [['--max-requests', '-5'], 'FLAG_NOT_AN_INTEGER'],
      [['--max-requests', '0'], 'FLAG_NOT_POSITIVE'],
      [['--max-requests', '5', '--max-requests', '6'], 'FLAG_REPEATED'],
    ]
    for (const [argv, code] of bad) {
      let thrown: unknown = null
      try { positiveIntFlag(argv, '--max-requests', 120) } catch (e) { thrown = e }
      expect(thrown, `argv ${JSON.stringify(argv)} must be refused`).toBeInstanceOf(FlagError)
      expect((thrown as FlagError).code).toBe(code)
      expect((thrown as FlagError).message).toContain('--max-requests')   // the message names the flag the user typed
    }
  })

  it('rejects a malformed flag name and a non-positive default instead of guessing', () => {
    expect(() => flagValue(['x'], 'max-requests')).toThrow(FlagError)
    expect(() => positiveIntFlag([], '--max-requests', 0)).toThrow(/FLAG_NOT_POSITIVE/)
    expect(() => positiveIntFlag([], '--max-requests', Number.NaN)).toThrow(/FLAG_NOT_POSITIVE/)
  })
})
