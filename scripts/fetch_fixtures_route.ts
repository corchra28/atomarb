/**
 * Captures every account a two-pool circuit needs (pools, configs, vaults, mints, fee accounts, recipients) in ONE getMultipleAccounts per step,
 * and saves them as a route fixture with provenance for the OFFLINE real-program integration test. Usage:
 *   npx tsx scripts/fetch_fixtures_route.ts <name> <adapter>:<pool> <adapter>:<pool> [amountLamports]
 * <= 4 RPC requests per route. Never signs or sends anything.
 */
import { loadConfig, resolveEndpoints } from '../src/config/load.js'
import { RpcClient } from '../src/state/rpc.js'
import { loadAdapters, requireAdapters } from '../src/adapters/registry.js'
import { snapshotPools } from '../src/state/snapshot.js'
import { enumerateCircuits, evaluateCircuit } from '../src/routing/circuit.js'
import { circuitAccountKeys } from '../src/simulation/probe.js'
import { parsePoolsFlag } from '../src/cli/common.js'
import { rawToFixture, saveFixture, type FixtureFile } from '../tests/helpers/fixtures.js'
import { JsonlLogger } from '../src/telemetry/log.js'
const [name, p1, p2, amountStr] = process.argv.slice(2)
if (!name || !p1 || !p2) throw new Error('usage: fetch_fixtures_route.ts <name> <adapter>:<pool> <adapter>:<pool> [amountLamports]')
const amount = BigInt(amountStr ?? '10000000')
const { config } = loadConfig('config/config.example.json')
const rpc = new RpcClient(resolveEndpoints(config).httpUrl, { ...config.rpc, maxRequestsPerSecond: 4, maxTotalHttpRequests: 12 }, 'confirmed', new JsonlLogger({ stderr: false }))
const adapters = requireAdapters((await loadAdapters()).adapters)
const refs = parsePoolsFlag(`${p1},${p2}`)
const snap = await snapshotPools(rpc, adapters, refs, { requireSingleBatch: true })
const decoded = snap.outcomes.filter(o => o.status === 'OK' && o.decoded).map(o => o.decoded!)
if (decoded.length !== 2) throw new Error(`pools not OK: ${JSON.stringify(snap.outcomes.map(o => [o.pool.address.toBase58(), o.status, o.reasons]))}`)
const circuits = enumerateCircuits(decoded)
const keys = new Map<string, import('@solana/web3.js').PublicKey>()
for (const c of circuits) { const ev = evaluateCircuit(adapters, c, amount); if (!ev.ok) { console.error(`circuit ${c.id} rejected: ${ev.reason}`); continue }; for (const k of circuitAccountKeys(adapters, c, ev.value)) keys.set(k.toBase58(), k) }
for (const [, a] of snap.bundle!.accounts) keys.set(a.pubkey.toBase58(), a.pubkey)
for (const p of refs) keys.set(p.address.toBase58(), p.address)
const all = await rpc.getAccountsBatched([...keys.values()])
const source = `${resolveEndpoints(config).httpUrl} getMultipleAccounts (route fixture ${name})`
const file: FixtureFile = { description: `route fixture ${name}: ${p1} + ${p2}; pools/configs/vaults/mints/fee accounts for both circuit directions at amount ${amount}; missing on-chain: ${all.missing.map(m => m.toBase58()).join(',') || 'none'}`, accounts: [...all.bundle.accounts.values()].map(a => rawToFixture(a, source)) }
const path = `tests/fixtures/routes/${name}.json`
saveFixture(path, file)
console.log(JSON.stringify({ path, accounts: file.accounts.length, missing: all.missing.map(m => m.toBase58()), slots: [all.bundle.minSlot, all.bundle.maxSlot], rpcRequests: rpc.usage.total }))
