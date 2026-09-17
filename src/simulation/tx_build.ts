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
  const messageBytes = msg.serialize()
  const serialized = tx.serialize()
  return { tx, messageBytes, messageHash: sha256Hex(messageBytes), serializedBytes: serialized.length, inspection: inspect(msg, serialized.length) }
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
