/**
 * Who is actually capturing atomic arbitrage on Solana right now?
 *
 * Reads recent confirmed blocks and finds transactions that CLOSE A CIRCUIT:
 * the fee payer's non-SOL token balances all return to where they started, and
 * the only thing that changes is SOL (native + wrapped), upward. That is the
 * defining shape of an atomic arbitrage and it is what separates a searcher
 * from an ordinary user selling a token into SOL through an aggregator.
 *
 * Reported profit is take-home: net of the transaction fee and net of any tip
 * paid for block position.
 *
 * Read-only. getBlock only. Nothing is signed, submitted or funded.
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const RPC = process.env.SOLANA_RPC_URL
if (!RPC) throw new Error('SOLANA_RPC_URL not set')

const WSOL = 'So11111111111111111111111111111111111111112'

/** AMM / DEX venues. Aggregators are tracked separately: a router is not a venue. */
const DEX: Record<string, string> = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap AMM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun bonding',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'Meteora Dynamic AMM',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2',
  '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c': 'Lifinity v2',
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: 'Phoenix',
  opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb: 'OpenBook v2',
  SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe: 'SolFi',
  ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY: 'ZeroFi',
  obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y: 'Obric v2',
  swapNyd8XiQwJ6ianp9snpu4brUqFxadzvHebnAXjJZ: 'Stabble',
  DEXYosS6oEGvk8uCDayvwEZz4qEyDJRf9nFgYCaqPMTm: 'Byreal',
  AMM55ShdkoGRB5jVYPjWziwk8m5MpwyDgsMWHaMSQWH6: 'Aldrin',
  SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ: 'Saros',
  DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1: 'Orca v1',
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca v2',
  GoonERTdGsjnkZqWuVjs73BZ3Pb9qoCUdBUL17BnS5j: 'GoonFi',
  HUMidiFiDHkaGZvSuJuMjYdGXS1G5QbxbzEJwHgLRPTd: 'HumidiFi',
  TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH: 'Tessera V',
  BSonFiP8SrPZs4DGvYBMzNnV6eqFmZbsVqpvHLcHNbNY: 'BisonFi',
}

const AGGREGATOR: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter v6',
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: 'Jupiter v4',
}

/** Jito tip accounts — a lamport increase here is a bid for block position. */
const TIPS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
])

type TokenBalance = {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount: { amount: string; decimals: number }
}

const rpc = async (method: string, params: unknown[]) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!r.ok) {
        await new Promise((s) => setTimeout(s, 400 * (attempt + 1)))
        continue
      }
      const j = (await r.json()) as { result?: unknown; error?: { message: string } }
      if (j.error) return null
      return j.result
    } catch {
      await new Promise((s) => setTimeout(s, 400 * (attempt + 1)))
    }
  }
  return null
}

type Arb = {
  slot: number
  signature: string
  signer: string
  netLamports: number // take-home: SOL + WSOL gain, minus fee, minus tip
  feeLamports: number
  tipLamports: number
  grossLamports: number
  venues: string[]
  venueCount: number
  viaAggregator: string | null
  computeUnits: number
  mintsTouched: number
  insideEngine: boolean // routed entirely through raydium_cpmm + pumpswap
}

const SLOTS = Number(process.argv[2] ?? 20)

const head = (await rpc('getSlot', [{ commitment: 'confirmed' }])) as number
const arbs: Arb[] = []
const venueHits: Record<string, number> = {}
const venuePairs: Record<string, number> = {}
const signerProfit: Record<string, { n: number; lamports: number }> = {}

let blocksRead = 0
let txTotal = 0
let txSuccess = 0
let multiDex = 0 // touches 2+ venues
let circuitClosed = 0 // 2+ venues AND token balances return to start
let circuitPositive = 0 // ...and SOL went up

for (let i = 0; i < SLOTS; i++) {
  const STRIDE = Number(process.argv[3] ?? 1)
  const slot = head - 40 - i * STRIDE
  const block = (await rpc('getBlock', [
    slot,
    {
      encoding: 'json',
      transactionDetails: 'full',
      rewards: false,
      maxSupportedTransactionVersion: 1,
      commitment: 'confirmed',
    },
  ])) as {
    transactions?: {
      transaction: { signatures: string[]; message: { accountKeys: string[] } }
      meta: {
        err: unknown
        fee: number
        preBalances: number[]
        postBalances: number[]
        preTokenBalances?: TokenBalance[]
        postTokenBalances?: TokenBalance[]
        computeUnitsConsumed?: number
        loadedAddresses?: { writable: string[]; readonly: string[] }
      }
    }[]
  } | null

  if (!block?.transactions) continue
  blocksRead++

  for (const t of block.transactions) {
    txTotal++
    if (t.meta.err) continue
    txSuccess++

    const keys = [
      ...t.transaction.message.accountKeys,
      ...(t.meta.loadedAddresses?.writable ?? []),
      ...(t.meta.loadedAddresses?.readonly ?? []),
    ]

    const venues = [...new Set(keys.map((k) => DEX[k]).filter(Boolean))]
    if (venues.length < 2) continue
    multiDex++

    const signer = t.transaction.message.accountKeys[0]

    // Token deltas for the fee payer, per mint.
    const delta: Record<string, bigint> = {}
    for (const b of t.meta.preTokenBalances ?? []) {
      if (b.owner !== signer) continue
      delta[b.mint] = (delta[b.mint] ?? 0n) - BigInt(b.uiTokenAmount.amount)
    }
    for (const b of t.meta.postTokenBalances ?? []) {
      if (b.owner !== signer) continue
      delta[b.mint] = (delta[b.mint] ?? 0n) + BigInt(b.uiTokenAmount.amount)
    }

    // A closed circuit: every non-SOL token ends where it started.
    const closed = Object.entries(delta).every(([mint, d]) => mint === WSOL || d === 0n)
    if (!closed) continue
    circuitClosed++

    const wsolDelta = Number(delta[WSOL] ?? 0n)
    const nativeDelta = t.meta.postBalances[0] - t.meta.preBalances[0]
    const net = nativeDelta + wsolDelta
    if (net <= 0) continue
    circuitPositive++

    let tip = 0
    for (let k = 0; k < keys.length && k < t.meta.postBalances.length; k++) {
      if (TIPS.has(keys[k])) tip += t.meta.postBalances[k] - t.meta.preBalances[k]
    }

    const agg = keys.map((k) => AGGREGATOR[k]).find(Boolean) ?? null

    for (const v of venues) venueHits[v] = (venueHits[v] ?? 0) + 1
    if (venues.length === 2) {
      const pair = [...venues].sort().join(' + ')
      venuePairs[pair] = (venuePairs[pair] ?? 0) + 1
    }
    const s = (signerProfit[signer] ??= { n: 0, lamports: 0 })
    s.n++
    s.lamports += net

    arbs.push({
      slot,
      signature: t.transaction.signatures[0],
      signer,
      netLamports: net,
      feeLamports: t.meta.fee,
      tipLamports: tip,
      grossLamports: net + t.meta.fee + tip,
      venues,
      venueCount: venues.length,
      viaAggregator: agg,
      computeUnits: t.meta.computeUnitsConsumed ?? 0,
      mintsTouched: Object.keys(delta).length,
      insideEngine: venues.every((v) => v === 'Raydium CPMM' || v === 'PumpSwap AMM'),
    })
  }
  process.stderr.write(
    `\rslot ${slot}  blocks ${blocksRead}  multiDex ${multiDex}  closed ${circuitClosed}  arbs ${arbs.length}   `,
  )
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

const nets = arbs.map((a) => a.netLamports)
const tips = arbs.map((a) => a.tipLamports)
const withTip = arbs.filter((a) => a.tipLamports > 0)
const SOL_USD = 105.75

const summary = {
  headSlot: head,
  blocksRead,
  txTotal,
  txSuccess,
  funnel: {
    touches2PlusVenues: multiDex,
    ofWhichCircuitClosed: circuitClosed,
    ofWhichProfitable: circuitPositive,
  },
  arbsPerBlock: +(arbs.length / Math.max(1, blocksRead)).toFixed(1),
  shareOfSuccessfulTx: +((arbs.length / Math.max(1, txSuccess)) * 100).toFixed(4),
  netLamports: {
    p10: pct(nets, 0.1),
    p25: pct(nets, 0.25),
    p50: pct(nets, 0.5),
    p75: pct(nets, 0.75),
    p90: pct(nets, 0.9),
    p99: pct(nets, 0.99),
    max: nets.length ? Math.max(...nets) : 0,
    sum: nets.reduce((a, b) => a + b, 0),
  },
  netUsd: {
    p50: +((pct(nets, 0.5) / 1e9) * SOL_USD).toFixed(4),
    p90: +((pct(nets, 0.9) / 1e9) * SOL_USD).toFixed(4),
    max: +(((nets.length ? Math.max(...nets) : 0) / 1e9) * SOL_USD).toFixed(2),
    totalPerBlock: +(
      (nets.reduce((a, b) => a + b, 0) / Math.max(1, blocksRead) / 1e9) *
      SOL_USD
    ).toFixed(3),
  },
  tipLamports: {
    p50: pct(tips, 0.5),
    p90: pct(tips, 0.9),
    max: tips.length ? Math.max(...tips) : 0,
  },
  tippingShare: +((withTip.length / Math.max(1, arbs.length)) * 100).toFixed(1),
  tipAsShareOfGross: withTip.length
    ? +(
        (withTip.reduce((a, b) => a + b.tipLamports, 0) /
          withTip.reduce((a, b) => a + b.grossLamports, 0)) *
        100
      ).toFixed(1)
    : 0,
  belowRepoFeeAssumption9000: arbs.filter((a) => a.netLamports < 9000).length,
  vacuousNoTokenAccounts: arbs.filter((a) => a.mintsTouched === 0).length,
  strictCircuits: arbs.filter((a) => a.mintsTouched >= 2).length,
  venueHits: Object.fromEntries(Object.entries(venueHits).sort((a, b) => b[1] - a[1])),
  topTwoVenuePairs: Object.fromEntries(
    Object.entries(venuePairs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15),
  ),
  insideEngineCount: arbs.filter((a) => a.insideEngine).length,
  viaAggregator: arbs.filter((a) => a.viaAggregator).length,
  distinctSigners: Object.keys(signerProfit).length,
  topSigners: Object.entries(signerProfit)
    .sort((a, b) => b[1].lamports - a[1].lamports)
    .slice(0, 12)
    .map(([k, v]) => ({
      signer: k,
      trades: v.n,
      lamports: v.lamports,
      usd: +((v.lamports / 1e9) * SOL_USD).toFixed(2),
    })),
  venueCountHistogram: arbs.reduce<Record<number, number>>((h, a) => {
    h[a.venueCount] = (h[a.venueCount] ?? 0) + 1
    return h
  }, {}),
  computeUnits: {
    p50: pct(
      arbs.map((a) => a.computeUnits),
      0.5,
    ),
    p90: pct(
      arbs.map((a) => a.computeUnits),
      0.9,
    ),
  },
}

mkdirSync('.scratch/realworld', { recursive: true })
writeFileSync(process.env.OUT ?? '.scratch/realworld/arb_census.json', JSON.stringify({ summary, arbs }, null, 1))
process.stderr.write('\n')
console.log(JSON.stringify(summary, null, 1))
