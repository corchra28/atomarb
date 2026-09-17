import { describe, it, expect } from 'vitest'
import { Keypair, SystemProgram } from '@solana/web3.js'
import { LocalSvm } from '../../src/simulation/local_svm.js'
import { buildV0 } from '../../src/simulation/tx_build.js'
describe('LocalSvm bridge (web3.js 1.x -> litesvm/kit)', () => {
  it('executes an unsigned system transfer with sigverify disabled and reports synthetic funding', () => {
    const svm = new LocalSvm()
    const from = Keypair.generate().publicKey, to = Keypair.generate().publicKey
    svm.fundSystemAccount(from, 10_000_000n, 'test payer')
    const built = buildV0(from, svm.svm.latestBlockhash(), [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1_000_000 })])
    const sim = svm.simulate(built.tx); expect(sim.ok, sim.err ?? '').toBe(true)
    const ex = svm.execute(built.tx); expect(ex.ok, ex.err ?? '').toBe(true)
    expect(svm.getAccount(to)?.lamports).toBe(1_000_000n)
    expect(svm.getAccount(from)!.lamports).toBe(10_000_000n - 1_000_000n - 5_000n)
    expect(svm.synthetic).toHaveLength(1)
    expect(built.inspection.withinSizeLimit).toBe(true)
    expect(built.inspection.numSignatures).toBe(1)
  })
  it('fails when the payer is unfunded (no automatic funding)', () => {
    const svm = new LocalSvm(); const from = Keypair.generate().publicKey
    const built = buildV0(from, svm.svm.latestBlockhash(), [SystemProgram.transfer({ fromPubkey: from, toPubkey: Keypair.generate().publicKey, lamports: 1 })])
    const r = svm.execute(built.tx); expect(r.ok).toBe(false); expect(r.err).toMatch(/AccountNotFound|InsufficientFunds/)
  })
})
