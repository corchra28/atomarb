import { z } from 'zod'
export const ConfigSchema = z.object({
  version: z.literal(1),
  rpc: z.object({
    httpUrlEnv: z.string().default('SOLANA_RPC_URL'),
    wssUrlEnv: z.string().default('SOLANA_WSS_URL'),
    commitment: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
    requestTimeoutMs: z.number().int().positive().default(15_000),
    maxRequestsPerSecond: z.number().positive().max(50).default(5),
    maxConcurrentRequests: z.number().int().positive().max(8).default(2),
    maxTotalHttpRequests: z.number().int().positive().default(10_000),
    backoff: z.object({ baseMs: z.number().int().positive().default(500), maxMs: z.number().int().positive().default(20_000), jitter: z.number().min(0).max(1).default(0.3) }).prefault({}),
  }),
  discovery: z.object({
    sources: z.array(z.enum(['raydium_api_v3', 'local_pumpswap_inventory', 'dexscreener'])).default(['raydium_api_v3', 'local_pumpswap_inventory']),
    localPumpswapInventoryPath: z.string().optional(),
    maxMints: z.number().int().positive().default(2_000),
    maxPools: z.number().int().positive().default(50),
    minQuoteReserveLamports: z.string().regex(/^\d+$/).default('1000000000'),
  }),
  pools: z.array(z.object({ adapter: z.enum(['raydium_cpmm', 'pumpswap']), address: z.string().min(32) })).default([]),
  sizing: z.object({
    /** grid in lamports of WSOL, as decimal strings */
    grid: z.array(z.string().regex(/^\d+$/)).default(['1000000', '5000000', '10000000', '50000000', '100000000', '500000000', '1000000000']),
    refineSteps: z.number().int().min(0).max(30).default(8),
    maxCapitalLamports: z.string().regex(/^\d+$/).default('1000000000'),
  }),
  costs: z.object({
    baseFeeLamportsPerSignature: z.number().int().default(5000),
    computeUnitLimit: z.number().int().positive().max(1_400_000).default(400_000),
    computeUnitPriceMicroLamports: z.number().int().min(0).default(10_000),
    jitoTipLamports: z.number().int().min(0).default(0),
    minNetProfitLamports: z.string().regex(/^\d+$/).default('100000'),
    ataRentLamports: z.number().int().default(2_039_280),
    failedAttemptCostLamports: z.number().int().default(5000),
  }),
  execution: z.object({
    live: z.literal(false).default(false),
    landingSlots: z.number().int().min(0).default(3),
    stalenessMaxMs: z.number().int().positive().default(3_000),
  }).prefault({}),
  smoke: z.object({
    maxDurationMinutes: z.number().int().positive().max(2880).default(60),
    maxPools: z.number().int().positive().max(50).default(50),
    maxDiskBytes: z.number().int().positive().default(2 * 1024 ** 3),
  }).prefault({}),
  paths: z.object({ dataDir: z.string().default('data'), reportsDir: z.string().default('reports/runs') }).prefault({}),
})
export type Config = z.infer<typeof ConfigSchema>
export type ConfigInput = z.input<typeof ConfigSchema>
