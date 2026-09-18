/**
 * Where is the other 95% of the MEV?
 *
 * Atomic arbitrage is ~$21k/day. Total Jito tips are far larger. This looks for
 * the category that is generally believed to dominate Solana MEV: sandwiching,
 * where a searcher brackets a user's swap with a buy before and a sell after,
 * so the user fills at a worse price and the difference is the searcher's.
 *
 * Detection, structural and conservative:
 *   - two successful transactions in the SAME block by the SAME signer,
 *   - both touching the same AMM program AND sharing a non-program account
 *     (the pool),
 *   - with at least one transaction by a DIFFERENT signer between them that
 *     touches that same shared account (the victim),
 *   - and the bracketing signer ends up with more SOL + wrapped SOL.
 *
 * This measures. It does not build one. Read-only, getBlock only.
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const RPC = process.env.SOLANA_RPC_URL
if (!RPC) throw new Error('SOLANA_RPC_URL not set')

const WSOL = 'So11111111111111111111111111111111111111112'

const DEX = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  '2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c',
  'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe',
  'TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH',
  'HUMidiFiDHkaGZvSuJuMjYdGXS1G5QbxbzEJwHgLRPTd',
])

/** Accounts that appear in nearly every transaction and mean nothing. */
const COMMON = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'SysvarRent111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
  WSOL,
])

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
  mint: string
  owner?: string
  uiTokenAmount: { amount: string }
}

const rpc = async (method: string, params: unknown[]) => {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!r.ok) {
        await new Promise((s) => setTimeout(s, 400 * (a + 1)))
        continue
      }
      const j = (await r.json()) as { result?: unknown; error?: unknown }
      if (j.error) return null
      return j.result
    } catch {
      await new Promise((s) => setTimeout(s, 400 * (a + 1)))
    }
  }
  return null
}

const SLOTS = Number(process.argv[2] ?? 80)
const STRIDE = Number(process.argv[3] ?? 7)
const head = (await rpc('getSlot', [{ commitment: 'confirmed' }])) as number

type Sandwich = {
  slot: number
  attacker: string
  front: string
  back: string
  victims: number
  gapPositions: number
  netLamports: number
  tipLamports: number
  pool: string
}

const sandwiches: Sandwich[] = []
let blocksRead = 0
let txSuccess = 0
let dexTx = 0

for (let i = 0; i < SLOTS; i++) {
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
        loadedAddresses?: { writable: string[]; readonly: string[] }
      }
    }[]
  } | null
  if (!block?.transactions) continue
  blocksRead++

  // Index the block's DEX transactions in order.
  const rows: {
    idx: number
    sig: string
    signer: string
    accts: Set<string>
    net: number
    tip: number
  }[] = []

  block.transactions.forEach((t, idx) => {
    if (t.meta.err) return
    txSuccess++
    const keys = [
      ...t.transaction.message.accountKeys,
      ...(t.meta.loadedAddresses?.writable ?? []),
      ...(t.meta.loadedAddresses?.readonly ?? []),
    ]
    if (!keys.some((k) => DEX.has(k))) return
    dexTx++

    const signer = t.transaction.message.accountKeys[0]
    let wsol = 0n
    for (const b of t.meta.preTokenBalances ?? [])
      if (b.owner === signer && b.mint === WSOL) wsol -= BigInt(b.uiTokenAmount.amount)
    for (const b of t.meta.postTokenBalances ?? [])
      if (b.owner === signer && b.mint === WSOL) wsol += BigInt(b.uiTokenAmount.amount)

    let tip = 0
    for (let k = 0; k < keys.length && k < t.meta.postBalances.length; k++)
      if (TIPS.has(keys[k])) tip += t.meta.postBalances[k] - t.meta.preBalances[k]

    rows.push({
      idx,
      sig: t.transaction.signatures[0],
      signer,
      accts: new Set(keys.filter((k) => !COMMON.has(k) && !DEX.has(k) && !TIPS.has(k))),
      net: t.meta.postBalances[0] - t.meta.preBalances[0] + Number(wsol),
      tip,
    })
  })

  // Find same-signer brackets with a different signer in between on the same pool.
  for (let a = 0; a < rows.length; a++) {
    for (let b = a + 1; b < rows.length; b++) {
      if (rows[b].idx - rows[a].idx > 6) break
      if (rows[a].signer !== rows[b].signer) continue

      const shared = [...rows[a].accts].filter((x) => rows[b].accts.has(x))
      if (!shared.length) continue

      const victims = rows.filter(
        (r) =>
          r.idx > rows[a].idx &&
          r.idx < rows[b].idx &&
          r.signer !== rows[a].signer &&
          shared.some((s) => r.accts.has(s)),
      )
      if (!victims.length) continue

      const net = rows[a].net + rows[b].net
      if (net <= 0) continue

      sandwiches.push({
        slot,
        attacker: rows[a].signer,
        front: rows[a].sig,
        back: rows[b].sig,
        victims: victims.length,
        gapPositions: rows[b].idx - rows[a].idx,
        netLamports: net,
        tipLamports: rows[a].tip + rows[b].tip,
        pool: shared[0],
      })
      break
    }
  }
  process.stderr.write(`\rslot ${slot} blocks ${blocksRead} dexTx ${dexTx} sandwiches ${sandwiches.length}   `)
}

const SOL_USD = 105.75
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}
const nets = sandwiches.map((s) => s.netLamports)
const total = nets.reduce((a, b) => a + b, 0)
const byAttacker: Record<string, { n: number; lamports: number }> = {}
for (const s of sandwiches) {
  const e = (byAttacker[s.attacker] ??= { n: 0, lamports: 0 })
  e.n++
  e.lamports += s.netLamports
}

const out = {
  blocksRead,
  txSuccess,
  dexTx,
  sandwiches: sandwiches.length,
  perBlock: +(sandwiches.length / Math.max(1, blocksRead)).toFixed(2),
  netLamports: {
    p50: pct(nets, 0.5),
    p90: pct(nets, 0.9),
    max: nets.length ? Math.max(...nets) : 0,
    total,
  },
  netUsd: {
    p50: +((pct(nets, 0.5) / 1e9) * SOL_USD).toFixed(4),
    max: +(((nets.length ? Math.max(...nets) : 0) / 1e9) * SOL_USD).toFixed(2),
    perBlock: +((total / 1e9) * SOL_USD * (1 / Math.max(1, blocksRead))).toFixed(3),
    perDay: Math.round((total / 1e9) * SOL_USD * ((3.767 * 86400) / Math.max(1, blocksRead))),
  },
  distinctAttackers: Object.keys(byAttacker).length,
  topAttackers: Object.entries(byAttacker)
    .sort((a, b) => b[1].lamports - a[1].lamports)
    .slice(0, 10)
    .map(([k, v]) => ({
      attacker: k,
      n: v.n,
      usd: +((v.lamports / 1e9) * SOL_USD).toFixed(3),
    })),
  tippingShare: +(
    (sandwiches.filter((s) => s.tipLamports > 0).length / Math.max(1, sandwiches.length)) *
    100
  ).toFixed(1),
  victimsTotal: sandwiches.reduce((a, s) => a + s.victims, 0),
}

mkdirSync('.scratch/realworld', { recursive: true })
writeFileSync(
  process.env.OUT ?? '.scratch/realworld/sandwich_scan.json',
  JSON.stringify({ out, sandwiches }, null, 1),
)
process.stderr.write('\n')
console.log(JSON.stringify(out, null, 1))
