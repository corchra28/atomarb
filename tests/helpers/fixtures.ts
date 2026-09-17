import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { PublicKey } from '@solana/web3.js'
import type { RawAccount, AccountBundle } from '../../src/adapters/types.js'
/** On-chain account fixture with provenance. Files live in tests/fixtures/<adapter>/<name>.json. Never contains credentials. */
export interface AccountFixture { pubkey: string; owner: string; lamports: string; executable: boolean; data_base64: string; slot: number; fetched_at_utc: string; source: string; note?: string }
export interface FixtureFile { description: string; accounts: AccountFixture[] }
export function loadFixture(path: string): FixtureFile { return JSON.parse(readFileSync(path, 'utf8')) as FixtureFile }
export function fixtureToRaw(f: AccountFixture, batchId = 'fixture'): RawAccount {
  return { pubkey: new PublicKey(f.pubkey), owner: new PublicKey(f.owner), lamports: BigInt(f.lamports), executable: f.executable, data: new Uint8Array(Buffer.from(f.data_base64, 'base64')), contextSlot: f.slot, receivedAtUtc: f.fetched_at_utc, receivedMonoMs: 0, batchId, provider: 'local_fixture' }
}
export function bundleFromFixture(file: FixtureFile): AccountBundle {
  const accounts = new Map<string, RawAccount>()
  const slots = new Set<number>()
  for (const f of file.accounts) { accounts.set(f.pubkey, fixtureToRaw(f)); slots.add(f.slot) }
  const s = [...slots]
  return { accounts, singleBatch: s.length <= 1, minSlot: Math.min(...s), maxSlot: Math.max(...s), batchIds: ['fixture'] }
}
export function rawToFixture(a: RawAccount, source: string, note?: string): AccountFixture {
  return { pubkey: a.pubkey.toBase58(), owner: a.owner.toBase58(), lamports: a.lamports.toString(), executable: a.executable, data_base64: Buffer.from(a.data).toString('base64'), slot: a.contextSlot, fetched_at_utc: a.receivedAtUtc, source, ...(note ? { note } : {}) }
}
export function saveFixture(path: string, file: FixtureFile): void { if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(file, null, 1)) }
