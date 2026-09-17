import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount, MessageV0 } from '@solana/web3.js'
import { sha256Hex } from '../util/hash.js'
export const MAX_TX_BYTES = 1232
export interface BuiltTx {
  tx: VersionedTransaction
  messageBytes: Uint8Array
  messageHash: string
  serializedBytes: number
  /** inspection of the compiled message */
  inspection: TxInspection
}
export interface TxInspection {
  version: 'v0' | 'legacy'
  numSignatures: number
  staticAccounts: string[]
  lookupTables: { key: string; writable: number; readonly: number }[]
  instructions: { programId: string; discriminatorHex: string; dataLen: number; accounts: { key: string; signer: boolean; writable: boolean }[] }[]
  serializedBytes: number
  withinSizeLimit: boolean
  note?: string
  computeUnitLimit: number | null
  computeUnitPriceMicroLamports: bigint | null
}
export function computeBudgetIxs(cuLimit: number, cuPriceMicro: number): TransactionInstruction[] {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicro })]
}
/** Builds ONE versioned (v0) transaction. Never signs. */
export function buildV0(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[], alts: AddressLookupTableAccount[] = []): BuiltTx {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(alts)
  const tx = new VersionedTransaction(msg)
  // web3.js serialises into a fixed 1232-byte packet buffer and THROWS on an oversized message; an oversized circuit must be reported, not crash.
  let messageBytes: Uint8Array; let serializedBytes: number; let oversize = false
  try { messageBytes = msg.serialize(); serializedBytes = tx.serialize().length } catch (e) {
    if (!/overrun|too large|out of range/i.test((e as Error).message)) throw e
    oversize = true; messageBytes = identityBytes(msg); serializedBytes = estimateV0Size(msg)
  }
  const insp = inspect(msg, serializedBytes)
  if (oversize) insp.note = `message exceeds ${MAX_TX_BYTES} bytes: size is an exact field-by-field estimate (${serializedBytes}); web3.js cannot serialise it`
  return { tx, messageBytes, messageHash: sha256Hex(messageBytes), serializedBytes, inspection: insp }
}
const shortVec = (n: number): number => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3)
/** Exact wire size of a v0 transaction, computed field by field (used when the message is too large for web3.js to serialise). */
export function estimateV0Size(msg: MessageV0): number {
  const sigs = msg.header.numRequiredSignatures
  let n = shortVec(sigs) + 64 * sigs                                   // signatures
  n += 1 + 3 + shortVec(msg.staticAccountKeys.length) + 32 * msg.staticAccountKeys.length + 32   // version byte, header, static keys, blockhash
  n += shortVec(msg.compiledInstructions.length)
  for (const ix of msg.compiledInstructions) n += 1 + shortVec(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + shortVec(ix.data.length) + ix.data.length
  n += shortVec(msg.addressTableLookups.length)
  for (const l of msg.addressTableLookups) n += 32 + shortVec(l.writableIndexes.length) + l.writableIndexes.length + shortVec(l.readonlyIndexes.length) + l.readonlyIndexes.length
  return n
}
/** Deterministic identity bytes for hashing an oversized message (not the wire format; used only so the message still has a stable hash). */
function identityBytes(msg: MessageV0): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([msg.header.numRequiredSignatures, msg.header.numReadonlySignedAccounts, msg.header.numReadonlyUnsignedAccounts])]
  for (const k of msg.staticAccountKeys) parts.push(k.toBytes())
  for (const l of msg.addressTableLookups) { parts.push(l.accountKey.toBytes()); parts.push(Uint8Array.from(l.writableIndexes)); parts.push(Uint8Array.from(l.readonlyIndexes)) }
  for (const ix of msg.compiledInstructions) { parts.push(new Uint8Array([ix.programIdIndex])); parts.push(Uint8Array.from(ix.accountKeyIndexes)); parts.push(ix.data) }
  const total = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(total); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
export function inspect(msg: MessageV0, serializedBytes: number): TxInspection {
  const keys = msg.staticAccountKeys.map(k => k.toBase58())
  const hdr = msg.header
  const isSigner = (i: number) => i < hdr.numRequiredSignatures
  const isWritable = (i: number) => (i < hdr.numRequiredSignatures ? i < hdr.numRequiredSignatures - hdr.numReadonlySignedAccounts : i < keys.length - hdr.numReadonlyUnsignedAccounts)
  const lut = msg.addressTableLookups.map(l => ({ key: l.accountKey.toBase58(), writable: l.writableIndexes.length, readonly: l.readonlyIndexes.length }))
  let cuLimit: number | null = null; let cuPrice: bigint | null = null
  const instructions = msg.compiledInstructions.map(ci => {
    const programId = keys[ci.programIdIndex] ?? `lut:${ci.programIdIndex}`
    const data = ci.data
    if (programId === ComputeBudgetProgram.programId.toBase58()) {
      if (data[0] === 2) cuLimit = new DataView(data.buffer, data.byteOffset).getUint32(1, true)
      if (data[0] === 3) cuPrice = new DataView(data.buffer, data.byteOffset).getBigUint64(1, true)
    }
    return { programId, discriminatorHex: Buffer.from(data.subarray(0, Math.min(8, data.length))).toString('hex'), dataLen: data.length, accounts: ci.accountKeyIndexes.map(i => ({ key: keys[i] ?? `lut:${i}`, signer: i < keys.length && isSigner(i), writable: i < keys.length ? isWritable(i) : true })) }
  })
  return { version: 'v0', numSignatures: hdr.numRequiredSignatures, staticAccounts: keys, lookupTables: lut, instructions, serializedBytes, withinSizeLimit: serializedBytes <= MAX_TX_BYTES, computeUnitLimit: cuLimit, computeUnitPriceMicroLamports: cuPrice }
}
