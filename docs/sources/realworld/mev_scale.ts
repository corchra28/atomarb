/**
 * How big is the rest of it?
 *
 * The atomic-arbitrage census measured one slice and found ~$21k/day network
 * wide. This measures the whole pie two ways:
 *
 *  1. Total lamports flowing into Jito tip accounts. Every MEV bundle pays a
 *     tip, so total tips is a hard lower bound on what MEV is worth to the
 *     people doing it, across every category.
 *  2. Lending-protocol liquidations, which are the one legitimate category
 *     that is not obviously a pure latency race, sized separately.
 *
 * Read-only. getBlock only. Nothing signed, submitted or funded.
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const RPC = process.env.SOLANA_RPC_URL
if (!RPC) throw new Error('SOLANA_RPC_URL not set')

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

const LENDING: Record<string, string> = {
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: 'Kamino Lend',
  MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA: 'MarginFi v2',
  So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo: 'Solend',
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: 'Drift v2',
  LoanhLV6JFNhxpS5hHVvfxpCA1HEQrK8ZFA5wa7nUuX: 'Loopscale',
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

const SLOTS = Number(process.argv[2] ?? 60)
const STRIDE = Number(process.argv[3] ?? 9)
const head = (await rpc('getSlot', [{ commitment: 'confirmed' }])) as number

let blocksRead = 0
let txSuccess = 0
let tipTotal = 0
let tipTxCount = 0
const tipSizes: number[] = []
const tipRows: { sig: string; tip: number; slot: number }[] = []

type Liq = { slot: number; sig: string; protocol: string; signerNet: number; tip: number }
const liqs: Liq[] = []
let lendingTx = 0
let liqTx = 0
const liqByProtocol: Record<string, number> = {}

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
        logMessages?: string[]
        loadedAddresses?: { writable: string[]; readonly: string[] }
      }
    }[]
  } | null
  if (!block?.transactions) continue
  blocksRead++

  for (const t of block.transactions) {
    if (t.meta.err) continue
    txSuccess++

    const keys = [
      ...t.transaction.message.accountKeys,
      ...(t.meta.loadedAddresses?.writable ?? []),
      ...(t.meta.loadedAddresses?.readonly ?? []),
    ]

    // --- tips: any lamport increase to a Jito tip account
    let tip = 0
    for (let k = 0; k < keys.length && k < t.meta.postBalances.length; k++) {
      if (TIPS.has(keys[k])) tip += t.meta.postBalances[k] - t.meta.preBalances[k]
    }
    if (tip > 0) {
      tipTotal += tip
      tipTxCount++
      tipSizes.push(tip)
      tipRows.push({ sig: t.transaction.signatures[0], tip, slot })
    }

    // --- liquidations
    const proto = keys.map((k) => LENDING[k]).find(Boolean)
    if (!proto) continue
    lendingTx++
    const logs = t.meta.logMessages ?? []
    const isLiq = logs.some((l) => /liquidat/i.test(l))
    if (!isLiq) continue
    liqTx++
    liqByProtocol[proto] = (liqByProtocol[proto] ?? 0) + 1
    liqs.push({
      slot,
      sig: t.transaction.signatures[0],
      protocol: proto,
      signerNet: t.meta.postBalances[0] - t.meta.preBalances[0],
      tip,
    })
  }
  process.stderr.write(`\rslot ${slot} blocks ${blocksRead} tipTx ${tipTxCount} liq ${liqTx}   `)
}

const SOL_USD = 105.75
const perDay = (lamports: number) => (lamports / 1e9) * SOL_USD * ((3.767 * 86400) / blocksRead)
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

const out = {
  blocksRead,
  txSuccess,
  tips: {
    txPayingTip: tipTxCount,
    shareOfSuccessfulTx: +((tipTxCount / Math.max(1, txSuccess)) * 100).toFixed(2),
    totalLamports: tipTotal,
    perBlockUsd: +((tipTotal / 1e9) * SOL_USD * (1 / blocksRead)).toFixed(3),
    perDayUsd: Math.round(perDay(tipTotal)),
    sizeLamports: {
      p50: pct(tipSizes, 0.5),
      p90: pct(tipSizes, 0.9),
      p99: pct(tipSizes, 0.99),
      max: tipSizes.length ? Math.max(...tipSizes) : 0,
    },
  },
  liquidations: {
    lendingTx,
    liquidationTx: liqTx,
    perBlock: +(liqTx / Math.max(1, blocksRead)).toFixed(2),
    perDay: Math.round((liqTx / blocksRead) * 3.767 * 86400),
    byProtocol: liqByProtocol,
    signerNetLamports: {
      p50: pct(
        liqs.map((l) => l.signerNet),
        0.5,
      ),
      max: liqs.length ? Math.max(...liqs.map((l) => l.signerNet)) : 0,
    },
    tipPaid: liqs.filter((l) => l.tip > 0).length,
  },
}

mkdirSync('.scratch/realworld', { recursive: true })
writeFileSync(process.env.OUT ?? '.scratch/realworld/mev_scale.json', JSON.stringify({ out, liqs, tipRows }, null, 1))
process.stderr.write('\n')
console.log(JSON.stringify(out, null, 1))
