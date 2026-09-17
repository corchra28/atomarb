import { PublicKey, Keypair, TransactionInstruction } from '@solana/web3.js'
import type { PoolAdapter, DecodedPool, Quote, AdapterId, MintInfo, TokenAccountInfo, SwapIxParams } from '../../src/adapters/types.js'
import { unsupported } from '../../src/adapters/types.js'
import { WSOL_MINT } from '../../src/state/token.js'
/** Constant-product mock with a fee in bps on the input, floor rounding. Used ONLY to test routing/sizing/accounting logic, never program compatibility. */
export function mockMint(mint: PublicKey, decimals = 6): MintInfo { return { mint, program: 'spl_token', decimals, supply: 0n, freezeAuthority: null, mintAuthority: null, extensions: [] } }
export function mockVault(mint: PublicKey, amount: bigint): TokenAccountInfo { return { address: Keypair.generate().publicKey, program: 'spl_token', mint, owner: Keypair.generate().publicKey, amount, state: 1, extensions: [] } }
export function mockPool(adapter: AdapterId, token: PublicKey, reserveWsol: bigint, reserveToken: bigint, feeBps: number, address = Keypair.generate().publicKey): DecodedPool {
  return { adapter, address, programId: Keypair.generate().publicKey, mintA: mockMint(WSOL_MINT, 9), mintB: mockMint(token), vaultA: mockVault(WSOL_MINT, reserveWsol), vaultB: mockVault(token, reserveToken), reserveA: reserveWsol, reserveB: reserveToken, params: { feeBps }, dependsOn: [address], stateHash: 'mock', snapshot: { minSlot: 1, maxSlot: 1, singleBatch: true, batchIds: ['m'], receivedAtUtc: 'x' }, layoutVersion: 'mock' }
}
export class MockAdapter implements PoolAdapter {
  readonly programId = Keypair.generate().publicKey
  constructor(readonly id: AdapterId) {}
  async discoverPools() { return unsupported('NOT_IMPLEMENTED', 'mock') }
  requiredAccounts() { return unsupported('NOT_IMPLEMENTED', 'mock') }
  decodeSnapshot() { return unsupported('NOT_IMPLEMENTED', 'mock') }
  validatePool() { return { ok: true, rejects: [], warnings: [] } }
  quoteExactIn(p: DecodedPool, inputMint: PublicKey, amountIn: bigint): Quote {
    const aIn = inputMint.equals(p.mintA.mint)
    const rIn = aIn ? p.reserveA : p.reserveB, rOut = aIn ? p.reserveB : p.reserveA
    const feeBps = BigInt(p.params['feeBps'] as number)
    const fee = (amountIn * feeBps + 9999n) / 10000n
    const net = amountIn - fee
    const out = (rOut * net) / (rIn + net)
    return { adapter: p.adapter, pool: p.address, inputMint, outputMint: aIn ? p.mintB.mint : p.mintA.mint, amountIn, amountOutToUser: out, vaultInDelta: amountIn, vaultOutDelta: out, fees: [{ name: 'lp_fee', bps: Number(feeBps), amount: fee, mint: inputMint, alreadyIncluded: true, recipient: 'lp', source: 'mock' }], priceImpactBps: 0, accountsNeeded: [p.address], stateHash: p.stateHash, contextSlot: { min: 1, max: 1 }, rejectReasons: out <= 0n ? ['ZERO_OUT'] : [], math: {} }
  }
  applySwap(p: DecodedPool, q: Quote): DecodedPool {
    const aIn = q.inputMint.equals(p.mintA.mint)
    return { ...p, reserveA: aIn ? p.reserveA + q.vaultInDelta : p.reserveA - q.vaultOutDelta, reserveB: aIn ? p.reserveB - q.vaultOutDelta : p.reserveB + q.vaultInDelta, stateHash: p.stateHash + '+' }
  }
  buildSwapInstruction(p: DecodedPool, params: SwapIxParams) { return { instruction: new TransactionInstruction({ programId: this.programId, keys: [{ pubkey: p.address, isSigner: false, isWritable: true }, { pubkey: params.user, isSigner: true, isWritable: true }], data: Buffer.from([1]) }), accountsWritten: [p.address] } }
}
