# PumpSwap AMM (pump_amm) — primary-source verification

Consulted: 2026-09-17T11:47Z … 11:55Z (UTC). Paper/research only; nothing was broadcast.

## Sources (exact refs)

| # | Source | Ref | What it established |
|---|--------|-----|---------------------|
| S1 | https://github.com/pump-fun/pump-public-docs (shallow clone, `.scratch/pump-public-docs`) | HEAD `81091419e4457566469d4e2a27f64ed84d42419c` (2026-09-14T06:57:49Z); `idl/pump_amm.json` last changed in `e0687ae9b7e064a0f54efc7297c65eecfbba3a8f` (2026-09-12 "chore(idl): refresh pump, pump_amm and pump_fees IDLs") | IDL for pump_amm / pump_fees / pump: discriminators, account layouts, instruction account lists, PDA seeds, errors, events; prose docs on fees, virtual reserves, creator fee, cashback, holder rewards |
| S2 | npm `@pump-fun/pump-swap-sdk` (tarball unpacked at `.scratch/pump-swap-sdk/package`, ships `src/*.ts`) | version `1.20.0`, integrity `sha512-DuBZ5ge3OJPao6m0aZZj+GTZFzfZ/TU3ca1EgL9ejr+8QIYETlLQVMaiznS+U4uGzM9z58mpxoXn3HuVEYHCFw==`, published 2026-09-10T13:25:11Z | quote math (buy/sell, rounding), fee-tier selection, pool decoding / size constants, instruction builders incl. remaining accounts, PDAs |
| S3 | Solana mainnet public RPC `https://api.mainnet-beta.solana.com` (`getAccountInfo`, `getMultipleAccounts`, `getSignaturesForAddress`, `getTransaction`) | slots 447788121 – 447788999 (2026-09-17 ~11:50Z); raw JSON saved under `.scratch/onchain/` | live GlobalConfig / FeeConfig / Pool bytes and lengths; live BuyEvent/SellEvent logs; the actual account list + data of a mainnet `buy` instruction |

Confidence legend: **VERIFIED_IN_SOURCE** (IDL json / SDK TypeScript / on-chain bytes), **DOCS_ONLY** (prose markdown), **INFERRED**, **UNKNOWN**.

---

## 1. Program ids and global PDAs

| Item | Value | Confidence | Source |
|------|-------|-----------|--------|
| pump_amm program id | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | VERIFIED_IN_SOURCE | S1 `idl/pump_amm.json` `"address"`; S2 `src/sdk/pda.ts`; S3 owner of all pool/config accounts |
| pump fee program id | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` | VERIFIED_IN_SOURCE | S1 `idl/pump_fees.json` `"address"`; fixed `fee_program` account in buy/sell; S3 owner of FeeConfig |
| pump bonding-curve program | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (NOT the AMM; only used for the `pool-authority` PDA) | VERIFIED_IN_SOURCE | S1 `idl/pump.json`; pump_amm IDL const seeds |
| GlobalConfig PDA | seeds `["global_config"]` under pump_amm → `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw` (bump 255) | VERIFIED_IN_SOURCE (seed from IDL; address recomputed in pure Python and matches S3 account, owner pump_amm, 949 bytes) | S1 IDL `create_config`/`buy` accounts; S2 `pda.ts GLOBAL_CONFIG_PDA` |
| FeeConfig PDA (for the AMM) | seeds `["fee_config", pump_amm_program_id(32 bytes)]` under **fee program** → `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx` (bump 255) | VERIFIED_IN_SOURCE (IDL const seed bytes decode to `pAMMBay6…`; recomputed; S3 account exists, owner `pfee…`, 4097 bytes) | S1 IDL `buy.accounts[21]`; S2 `pda.ts PUMP_AMM_FEE_CONFIG_PDA` |
| event_authority | seeds `["__event_authority"]` under pump_amm → `GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR` | VERIFIED_IN_SOURCE (matches live tx account [15]) | S1 IDL; S3 tx |
| global_volume_accumulator | seeds `["global_volume_accumulator"]` under pump_amm → `C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw` (600-byte account, currently all-zero start/end) | VERIFIED_IN_SOURCE | S1 IDL; S3 |
| user_volume_accumulator | seeds `["user_volume_accumulator", user]` under pump_amm | VERIFIED_IN_SOURCE (recomputed = live tx account [20]; live account is 137 bytes, rent 1,844,400 lamports) | S1 IDL; S2 `pda.ts`; S3 |
| coin_creator_vault_authority | seeds `["creator_vault", pool.coin_creator]` under pump_amm | VERIFIED_IN_SOURCE (recomputed = live tx account [18]) | S1 IDL; S2; S3 |
| coin_creator_vault_ata | ATA(owner = coin_creator_vault_authority, mint = quote_mint, token program = quote_token_program) | VERIFIED_IN_SOURCE | S1 IDL; S3 |
| pool-authority (pump program) | seeds `["pool-authority", base_mint]` under `6EF8…` — this is the `creator` of every canonical (migrated) pool | VERIFIED_IN_SOURCE (docs example pool creator `9XDYTfQ…` and live pool creator `7767Eyc…` both recompute from this seed) | S1 `docs/PUMP_SWAP_CREATOR_FEE_README.md`, `idl/pump.json migrate`; S2 `pda.ts pumpPoolAuthorityPda`; S3 |
| pool-v2 (remaining account) | seeds `["pool-v2", base_mint]` under pump_amm | VERIFIED_IN_SOURCE as an address (SDK `poolV2Pda`, live tx account [23]); **account does not exist on mainnet (NULL)**; its purpose is UNKNOWN | S2 `pda.ts`; S3 |

---

## 2. `Pool` account layout

Discriminator (Anchor account): `[241,154,109,4,17,177,109,188]` = hex `f19a6d0411b16dbc` — VERIFIED_IN_SOURCE (IDL + first 8 bytes of live pools).

| offset | size | field | type | notes |
|-------:|-----:|-------|------|-------|
| 0 | 8 | discriminator | | |
| 8 | 1 | pool_bump | u8 | |
| 9 | 2 | index | u16 LE | canonical (migrated) pools use index 0 |
| 11 | 32 | creator | pubkey | canonical pools: pump `pool-authority` PDA |
| 43 | 32 | base_mint | pubkey | |
| 75 | 32 | quote_mint | pubkey | |
| 107 | 32 | lp_mint | pubkey | PDA `["pool_lp_mint", pool]`, Token-2022 mint |
| 139 | 32 | pool_base_token_account | pubkey | ATA(pool, base_mint, base_token_program) |
| 171 | 32 | pool_quote_token_account | pubkey | ATA(pool, quote_mint, quote_token_program) |
| 203 | 8 | lp_supply | u64 | "True circulating supply without burns and lock-ups" |
| 211 | 32 | coin_creator | pubkey | `Pubkey::default()` on pools predating creator fees / non-canonical pools |
| 243 | 1 | is_mayhem_mode | bool | |
| 244 | 1 | is_cashback_coin | bool | |
| 245 | 16 | virtual_quote_reserves | **i128 LE (signed)** | "For non-boost pools, value is 0" |
| 261 | 8 | creator_fee_bps | u64 | per-pool creator fee (custom-quote pairs); 0 = use schedule |
| 269 | 1 | can_edit_creator_fee | bool | |
| 270 | 1 | is_holder_reward | bool | **present in S1 IDL (2026-09-12) but NOT in the IDL bundled in SDK 1.20.0** |
| 271 | | end of current layout | | |

- Total current layout = 271 bytes (S1 IDL). SDK 1.20.0 says `POOL_SIZE = 270` (its IDL lacks `is_holder_reward`) — VERIFIED_IN_SOURCE that they differ.
- Older pools are shorter: SDK comment lists historical lengths `211 / 243 / 244 / 245 / 261`; missing trailing fields must be read as `0 / false` (docs + SDK `padTrailing`). Pools may also be *extended* to ≥300 bytes by `extend_account` (`POOL_ACCOUNT_NEW_SIZE = 300`; the SDK prepends `extend_account` if `data.length < 300`).
- Live observations (S3): docs example pool `GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J` = 300 bytes, `virtual_quote_reserves = 0`; boosted pool `FruHjS1iY2rR1vdcx7fRXKQmQh7BAGMqNhtqJCtQZLiz` = **301 bytes**, `virtual_quote_reserves = 17584505289`, `creator_fee_bps = 0`, `is_holder_reward = 0`.

Excerpt — S2 `src/sdk/offlinePumpAmm.ts` @1.20.0:
```ts
export const POOL_ACCOUNT_NEW_SIZE = 300;
/** … Older accounts are shorter (a pool is 211 / 243 / 244 / 245 / 261 bytes, a GlobalConfig 907 / 940)
 * and lack the trailing fields, which the program's versioned readers return as 0 / false; … */
export const POOL_SIZE = 270;
export const GLOBAL_CONFIG_SIZE = 949;
```

Excerpt — S1 `docs/PUMP_SWAP_README.md` @81091419:
```
- Pools written before an appended field existed are shorter than the current layout; read the missing trailing fields
  as `0` / `false`.
```

---

## 3. `GlobalConfig` account layout

Discriminator `[149,8,156,202,160,252,176,217]` = hex `95089ccaa0fcb0d9` — VERIFIED_IN_SOURCE (IDL + live bytes). Live account is exactly 949 bytes = full layout.

| offset | size | field | type | live value (S3, slot 447788121) |
|-------:|-----:|-------|------|------|
| 8 | 32 | admin | pubkey | `FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF` |
| 40 | 8 | lp_fee_basis_points | u64 | 20 |
| 48 | 8 | protocol_fee_basis_points | u64 | 5 |
| 56 | 1 | disable_flags | u8 | 0 |
| 57 | 256 | protocol_fee_recipients | [pubkey; 8] | `62qc2C…`, `7VtfL8…`, `7hTckg…`, `9rPYyA…`, `AVmoTt…`, `FWsW1x…`, `G5UZAV…`, `JCRGum…` |
| 313 | 8 | coin_creator_fee_basis_points | u64 | 5 |
| 321 | 32 | admin_set_coin_creator_authority | pubkey | `UqN2p5bAzBqYdHXcgB6WLtuVrdvmy9JSAtgqZb3CMKw` |
| 353 | 32 | whitelist_pda | pubkey | `BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s` |
| 385 | 32 | reserved_fee_recipient | pubkey | `GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS` |
| 417 | 1 | mayhem_mode_enabled | bool | 1 |
| 418 | 224 | reserved_fee_recipients | [pubkey; 7] | (mayhem recipients 1..7, see FEE_RECIPIENTS.md) |
| 642 | 1 | is_cashback_enabled | bool | 1 |
| 643 | 256 | buyback_fee_recipients | [pubkey; 8] | `5YxQFd…`, `9M4giF…`, `GXPFM2…`, `3BpXnf…`, `5cjcW9…`, `EHAAiT…`, `5eHhjP…`, `A7hAgC…` |
| 899 | 8 | buyback_basis_points | u64 | **5000** |
| 907 | 32 | boost_authority | pubkey | `HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r` |
| 939 | 1 | boost_enabled | bool | 1 |
| 940 | 1 | creator_fee_configurable | bool | 1 |
| 941 | 8 | max_configurable_creator_fee_bps | u64 | 300 |
| 949 | | end | | |

`disable_flags` bit meanings — VERIFIED_IN_SOURCE (IDL field docs): bit 0 = disable create_pool, bit 1 = disable deposit, bit 2 = disable withdraw, bit 3 = disable buy, bit 4 = disable sell (errors 6017–6021 `DisabledCreatePool…DisabledSell`).

Note: `lp_fee_basis_points / protocol_fee_basis_points / coin_creator_fee_basis_points` in GlobalConfig are only the *fallback* used when no FeeConfig is passed; the SDK comment says "the GlobalConfig fallback … is unreachable there: pump-fees is mandatory" (fee_config/fee_program are non-optional accounts in the IDL).

---

## 4. `FeeConfig` (fee program) and fee-tier selection

Discriminator `[143,52,146,187,219,123,76,155]` = hex `8f3492bbdb7b4c9b` — VERIFIED_IN_SOURCE.

Layout (variable — vectors):

| offset | size | field | type |
|-------:|-----:|-------|------|
| 8 | 1 | bump | u8 |
| 9 | 32 | admin | pubkey |
| 41 | 24 | flat_fees | `Fees` = {lp_fee_bps u64, protocol_fee_bps u64, creator_fee_bps u64} |
| 65 | 4+40·n | fee_tiers | `Vec<FeeTier>`, FeeTier = {market_cap_lamports_threshold u128 LE (16), fees Fees (24)} = 40 bytes |
| 69+40·n | 4+40·m | stable_fee_tiers | `Vec<FeeTier>` |
| after | 24 | exotic_flat_fees | `Fees` |

Version-by-length rule (S2 `versionedFeeConfigData`): `FEE_CONFIG_SIZE_PRE_STABLE = 2512`, `POST_STABLE = 4073`, `POST_EXOTIC = 4097`; a shorter account lacks trailing fields (read as `[]` / zero). **Live mainnet FeeConfig is 4097 bytes (post-exotic)** with n = m = 25, `exotic_flat_fees = (20, 5, 5)` at offset 2073, then 2000 zero bytes. (The SDK 1.20.0 fixture captured 2026-09-08 was still 4073 bytes with no exotic fees — the on-chain account has since been extended.)

Live values (S3, decoded from bytes, all VERIFIED):

- `flat_fees = (lp 25, protocol 5, creator 0)` — used by **non-canonical** pools.
- `fee_tiers` (SOL-like quote; threshold in lamports of market cap):

| i | threshold (SOL) | lp | protocol | creator |
|--:|--:|--:|--:|--:|
| 0 | 0 | 2 | 93 | 30 |
| 1 | 420 | 20 | 5 | 95 |
| 2 | 1,470 | 20 | 5 | 90 |
| 3 | 2,460 | 20 | 5 | 85 |
| 4 | 3,440 | 20 | 5 | 80 |
| 5 | 4,420 | 20 | 5 | 75 |
| 6 | 9,820 | 20 | 5 | 70 |
| 7 | 14,740 | 20 | 5 | 65 |
| 8 | 19,650 | 20 | 5 | 60 |
| 9 | 24,560 | 20 | 5 | 55 |
| 10 | 29,470 | 20 | 5 | 50 |
| 11 | 34,380 | 20 | 5 | 45 |
| 12 | 39,300 | 20 | 5 | 40 |
| 13 | 44,210 | 20 | 5 | 35 |
| 14 | 49,120 | 20 | 5 | 30 |
| 15 | 54,030 | 20 | 5 | 28 |
| 16 | 58,940 | 20 | 5 | 25 |
| 17 | 63,860 | 20 | 5 | 23 |
| 18 | 68,770 | 20 | 5 | 20 |
| 19 | 73,681 | 20 | 5 | 18 |
| 20 | 78,590 | 20 | 5 | 15 |
| 21 | 83,500 | 20 | 5 | 13 |
| 22 | 88,400 | 20 | 5 | 10 |
| 23 | 93,330 | 20 | 5 | 8 |
| 24 | 98,240 | 20 | 5 | 5 |

- `stable_fee_tiers` (USDC quote; thresholds in USDC base units): same fee rows, thresholds 0, 59,000, 300,000, 500,000, 700,000, 900,000, 2M, 3M, … 20M USDC (see `.scratch/onchain/5PHirr…json` / SDK fixture).
- `exotic_flat_fees = (20, 5, 5)`.

Selection rule — VERIFIED_IN_SOURCE (S2 `src/sdk/fees.ts`, mirrors "rust reference: pump-fees FeeConfig::fees_for_quote_mint()"):

```ts
export function feesForQuoteMint({ feeConfig, isPumpPool, marketCap, quoteMint }) {
  if (!isPumpPool) { return feeConfig.flatFees; }
  if (isSolLikeQuoteMint(quoteMint)) { return calculateFeeTier({ feeTiers: feeConfig.feeTiers, marketCap }); }
  if (isStableQuoteMint(quoteMint)) {
    return calculateFeeTier({ feeTiers: feeConfig.stableFeeTiers.length > 0 ? feeConfig.stableFeeTiers : feeConfig.feeTiers, marketCap });
  }
  return isZeroFees(feeConfig.exoticFlatFees) ? feeConfig.flatFees : feeConfig.exoticFlatFees;
}
/// rust reference: pump-fees-math::calculate_fee_tier()
export function calculateFeeTier({ feeTiers, marketCap }) {
  const firstTier = feeTiers[0];
  if (marketCap.lt(firstTier.marketCapLamportsThreshold)) { return firstTier.fees; }
  for (const tier of feeTiers.slice().reverse()) {
    if (marketCap.gte(tier.marketCapLamportsThreshold)) { return tier.fees; }
  }
  return firstTier.fees;
}
```

- `isPumpPool(baseMint, pool.creator) = pumpPoolAuthorityPda(baseMint).equals(pool.creator)` (S2 `util.ts`) — the canonical-pool test uses `pool.creator`, **not** `coin_creator`.
- SOL-like quote mints = `Pubkey::default`, `So111…112` (WSOL), Token-2022 native mint; stable = USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` only (S2 `fees.ts`).
- Market cap (S2 `util.ts`, "rust reference: pump-amm Pool::market_cap()"): `marketCap = quoteReserve * circulatingSupply / baseReserve` (floor), where `circulatingSupply = isMayhemMode ? 1_000_000_000_000_000 : base_mint.supply`, and the SDK passes `quoteReserve = vault_quote + virtual_quote_reserves` (effective). `tradeSize` is accepted but explicitly "Not used: pump-fees tiers by market cap only".
- Per-pool override (S2 `computeFeesBps`): if `globalConfig.creatorFeeConfigurable && pool.creatorFeeBps > 0` the schedule's `creatorFeeBps` is replaced by `pool.creator_fee_bps` (lp/protocol untouched). Live: `creator_fee_configurable = 1`, `max = 300`; docs say this only applies to custom (non-SOL/USDC) quote pairs (`CreatorFeeNotConfigurableForQuote` error 6077).
- Creator fee is zero when `pool.coin_creator == Pubkey::default()` (S2 buy.ts/sell.ts; confirmed by live SellEvents on non-canonical pools showing `coin_creator_fee_basis_points = 0`, lp 25 / protocol 5 = flat_fees).
- Fee-tier quantities are in **quote base units**, so tier 0 (0 ≤ mcap < 420 SOL → lp 2 / protocol 93 / creator 30 = 125 bps total) applies right after migration; ≥ 98,240 SOL mcap → 20/5/5 = 30 bps. Live BuyEvents on ~1.7M–4.6M SOL mcap pools show 20/5/5 (VERIFIED).
- Buyback split: `BuyEvent/SellEvent.buyback_fee_basis_points = 5000`, `buyback_fee = floor(protocol_fee * 5000 / 10000)` (observed 1064.5→1064, 114.5→114, 77463.5→77463). It is carved **out of** the protocol fee, not additional: `user_quote_amount_in = quote_in + lp + protocol + creator` exactly (VERIFIED on 3 live BuyEvents). The buyback recipient + its quote ATA are passed as trailing remaining accounts (see §6).

---

## 5. Quote math (SDK, verified against live events)

Reserves: `baseReserve = pool_base_token_account.amount` (raw vault), `quoteReserve = pool_quote_token_account.amount` (raw vault), and **`effectiveQuoteReserve = quoteReserve + pool.virtual_quote_reserves`** is used for pricing on both sides (S2 `onlinePumpAmm.ts swapSolanaState` + `buy.ts`/`sell.ts`). The base side has no virtual component. VERIFIED_IN_SOURCE and VERIFIED on-chain: three live BuyEvents only reproduce `quote_amount_in` when the virtual reserve (17,584,505,289 lamports ≈ 17.58 SOL, `can_boost = true`) is included; the event's `pool_*_token_reserves` are **pre-trade** values (post-trade hypothesis failed on event 1).

Helpers (S2 `util.ts`): `ceilDiv(a,b) = (a + b - 1) / b`; `fee(amount, bps) = ceilDiv(amount * bps, 10_000)`.

### 5a. buy, base-exact (`buyBaseInput`) — matches on-chain `buy(base_amount_out, max_quote_amount_in)`
```
quote_amount_in = ceil( effQ * base_out / (base_reserve - base_out) )      // ceilDiv
lp_fee          = ceil(quote_amount_in * lp_bps / 10000)
protocol_fee    = ceil(quote_amount_in * protocol_bps / 10000)
creator_fee     = coin_creator == default ? 0 : ceil(quote_amount_in * creator_bps / 10000)
user_quote_in   = quote_amount_in + lp_fee + protocol_fee + creator_fee   // what the user pays
maxQuote        = user_quote_in * floor((1+slippage%)*1e9) / 1e9
```
Live check (S3, sig `5ZD6eMu…`): base_out 828,079; B 3,184,958,896,915; Q 5,517,775,266,487; V 17,584,505,289 → quote_in 1,439,176 ✓, lp 2,879 ✓ (ceil; floor would be 2,878), protocol 720 ✓, creator 720 ✓, user_quote_in 1,443,495 ✓. Requires `base_out < base_reserve` (error 6016 `BuyMoreBaseAmountThanPoolReserves`).

### 5b. buy, quote-exact (`buyQuoteInput`) — SDK inverse of on-chain `buy_exact_quote_in`
```
totalFeeBps   = lp_bps + protocol_bps + (coin_creator == default ? 0 : creator_bps)
effectiveQuote = floor(quote * 10000 / (10000 + totalFeeBps))
fees on effectiveQuote (ceil each); if effectiveQuote + fees > quote: effectiveQuote -= (excess)
inputAmount   = effectiveQuote - 1
base_out      = floor( base_reserve * inputAmount / (effQ + inputAmount) )
```
The SDK's own localnet test asserts on-chain `buy_exact_quote_in(spendable_quote_in=quote, min_base_amount_out=base)` emits `base_amount_out == base` and `user_quote_amount_in == effectiveQuote` (comment: "SDK's buyQuoteInput is the inverse of buy_exact_quote_in"). DOCS/TEST-ONLY for the exact on-chain rounding of `buy_exact_quote_in`; the `-1` and the excess-correction are SDK-side conservatism.

### 5c. sell (`sellBaseInput`) — matches on-chain `sell(base_amount_in, min_quote_amount_out)`
```
quote_amount_out = floor( effQ * base_in / (base_reserve + base_in) )
lp_fee        = ceil(quote_amount_out * lp_bps / 10000)
protocol_fee  = ceil(quote_amount_out * protocol_bps / 10000)
creator_fee   = coin_creator == default ? 0 : ceil(quote_amount_out * creator_bps / 10000)
user_quote_out = quote_amount_out - lp_fee - protocol_fee - creator_fee
BOOST cap:  require real quoteReserve >= quote_amount_out - lp_fee   (SDK throws "Insufficient real quote reserves")
minQuote = user_quote_out * floor((1-slippage%)*1e9) / 1e9
```
Live check (S3, sig `DLeuEpi…`): base_in 10,000; B 160,711,916,412; Q 188,656,064,728,009; V 0 → quote_out 11,738,771 ✓ (floor; ceil would be 11,738,772), lp 29,347 ✓ (ceil), protocol 5,870 ✓ (ceil), user_out 11,703,554 ✓. Second event (`3WcdQTn…`) also ✓.

On-chain payout cap (IDL error 6063, VERIFIED_IN_SOURCE): "BOOST: sell output exceeds the real quote vault. effective = real + virtual is pricing-only; payout is capped at real_vault, so quote min(out, real_vault)".

### 5d. sell, quote-exact (`sellQuoteInput`)
`rawQuote = ceil(userQuoteOut * 10000 / (10000 - totalFeeBps))`; `base_in = ceil(base_reserve * rawQuote / (effQ - rawQuote))`; requires `quote <= real quoteReserve` and `rawQuote < effQ`.

Excerpt — S2 `src/sdk/buy.ts` @1.20.0:
```ts
  const effectiveQuoteReserve = quoteReserve.add(virtualQuoteReserves);
  const numerator = effectiveQuoteReserve.mul(base);
  const denominator = baseReserve.sub(base);
  …
  const quoteAmountIn = ceilDiv(numerator, denominator);
  …
  const lpFee = fee(quoteAmountIn, lpFeeBps);
  const protocolFee = fee(quoteAmountIn, protocolFeeBps);
  const coinCreatorFee = PublicKey.default.equals(coinCreator) ? new BN(0) : fee(quoteAmountIn, coinCreatorFeeBps);
  const totalQuote = quoteAmountIn.add(lpFee).add(protocolFee).add(coinCreatorFee);
```

Excerpt — S2 `src/sdk/sell.ts` @1.20.0:
```ts
  const quoteAmountOut = effectiveQuoteReserve.mul(base).div(baseReserve.add(base)); // floor by BN.div
  …
  if (quoteReserve.lt(quoteAmountOut.sub(lpFee))) {
    throw new Error("Insufficient real quote reserves to cover the sell output.");
  }
  const finalQuote = quoteAmountOut.sub(lpFee).sub(protocolFee).sub(coinCreatorFee);
```

Excerpt — S1 `docs/PUMP_SWAP_README.md` @81091419 (note: the "0 on all pools today" claim is **stale** — live pools carry ≈17.58 SOL virtual quote):
```
effective_quote_reserves = pool_quote_token_account.amount + Pool::virtual_quote_reserves
- Use `effective_quote_reserves` (not the raw `pool_quote_token_account.amount`) wherever you quote, price, or index a
  pool, for both `buy` and `sell`.
- `virtual_quote_reserves` is `0` on all pools today, …
- The base side is unchanged: base reserves are still the raw `pool_base_token_account.amount`.
```

---

## 6. `buy`, `buy_exact_quote_in`, `sell` instructions

All three: discriminator = first 8 bytes of instruction data; args Borsh LE. `track_volume: OptionBool` is a tuple struct `OptionBool(bool)` → **one trailing byte** (SDK encodes `{ 0: true }`; live `buy` data was 25 bytes = 8 + 8 + 8 + `01`). The pump docs describe such trailing `OptionBool` args as optional ("instruction data built before it existed still decodes") — DOCS_ONLY for the omitted case.

| ix | discriminator (hex) | args |
|----|---------------------|------|
| buy | `66063d1201daebea` | `base_amount_out: u64, max_quote_amount_in: u64, track_volume: OptionBool` |
| buy_exact_quote_in | `c62e1552b4d9e870` | `spendable_quote_in: u64, min_base_amount_out: u64, track_volume: OptionBool` (fees deducted from spendable_quote_in; must cover creation of protocol_fee_recipient_token_account / coin_creator_vault_ata / user_volume_accumulator if missing) |
| sell | `33e685a4017f83ad` | `base_amount_in: u64, min_quote_amount_out: u64` |
| extend_account | `ea66c2cb96483ee5` | none; accounts `[account (w), user (w,s), system_program, event_authority, program]` |
| create_pool | `e992d18ecf6840bc` | `index u16, base_amount_in u64, quote_amount_in u64, coin_creator pubkey, is_mayhem_mode bool, is_cashback_coin OptionBool, creator_fee_bps OptionU64, can_edit_creator_fee OptionBool, is_holder_reward OptionBool` |

### Named accounts — `buy` and `buy_exact_quote_in` (identical lists; VERIFIED_IN_SOURCE IDL, confirmed by live tx)

| # | name | flags | derivation |
|--:|------|-------|-----------|
| 0 | pool | writable | |
| 1 | user | writable, signer | |
| 2 | global_config | readonly | PDA `["global_config"]` |
| 3 | base_mint | readonly | |
| 4 | quote_mint | readonly | |
| 5 | user_base_token_account | writable | (SDK: ATA of user for base, base_token_program) |
| 6 | user_quote_token_account | writable | |
| 7 | pool_base_token_account | writable | ATA(pool, base_mint, base_token_program) |
| 8 | pool_quote_token_account | writable | ATA(pool, quote_mint, quote_token_program) |
| 9 | protocol_fee_recipient | readonly | one of GlobalConfig.protocol_fee_recipients (mayhem pools: reserved_fee_recipient / reserved_fee_recipients) |
| 10 | protocol_fee_recipient_token_account | writable | ATA(protocol_fee_recipient, quote_mint, quote_token_program) |
| 11 | base_token_program | readonly | SPL Token **or Token-2022** (live pool base was `TokenzQd…`) |
| 12 | quote_token_program | readonly | |
| 13 | system_program | readonly | `11111111111111111111111111111111` |
| 14 | associated_token_program | readonly | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| 15 | event_authority | readonly | PDA `["__event_authority"]` |
| 16 | program | readonly | `pAMMBay6…` |
| 17 | coin_creator_vault_ata | writable | ATA(coin_creator_vault_authority, quote_mint, quote_token_program) |
| 18 | coin_creator_vault_authority | readonly | PDA `["creator_vault", pool.coin_creator]` |
| 19 | global_volume_accumulator | readonly | PDA `["global_volume_accumulator"]` |
| 20 | user_volume_accumulator | writable | PDA `["user_volume_accumulator", user]` (init_if_needed, rent ≈ 1,844,400 lamports for 137 bytes — S3) |
| 21 | fee_config | readonly | PDA `["fee_config", pAMMBay6…]` under fee program |
| 22 | fee_program | readonly | `pfeeUxB6…` |

**Remaining accounts appended by the SDK (and observed on-chain), in order:**
- `[cashback only]` WSOL/quote ATA of `user_volume_accumulator` (writable) — IDL doc: "For cashback coins, optionally pass user_volume_accumulator_wsol_ata as remaining_accounts[0]".
- `[if pool.coin_creator != default]` `pool-v2` PDA `["pool-v2", base_mint]` (readonly). Error 6062 `InvalidPoolV2: "pool_v2 remaining account is missing or invalid"`. The address exists as a key only; on mainnet the account is NULL (S3).
- buyback_fee_recipient (readonly) — one of `GlobalConfig.buyback_fee_recipients`.
- buyback_fee_recipient quote ATA (writable).

Live `buy` (sig `5ZD6eMu3dLTjcuwXnPRZNtgPWtNpfVJP6KEGLrw4u8Tyq9aB7YmcbkWiz97HqBTjkKKpiPC9AQqTv5XmpKhKke5P`, slot 447788562) had exactly 26 accounts: [0..22] as above, [23] `HTNtT8Xp…` = pool-v2 PDA (recomputed ✓), [24] `3BpXnfJa…` = buyback recipient #3 ✓, [25] its WSOL ATA ✓. Matches `docs/BREAKING_FEE_RECIPIENT.md` ("Buy instructions should have 26 accounts for non cashback coins", "Sell … 24").

### Named accounts — `sell`

Indices 0–18 identical to `buy` (no volume accumulators), then:

| # | name | flags |
|--:|------|-------|
| 19 | fee_config | readonly |
| 20 | fee_program | readonly |

Remaining (SDK): `[cashback only]` UVA quote ATA (writable) **and** user_volume_accumulator (writable); `[if coin_creator != default]` pool-v2; buyback recipient; buyback recipient ATA. → 24 accounts non-cashback, 26 cashback (docs).

Excerpt — S2 `src/sdk/offlinePumpAmm.ts` @1.20.0 (`buyInstructionsNoPool`):
```ts
        const remainingAccounts = [];
        if (pool.isCashbackCoin) {
          remainingAccounts.push({ pubkey: getAssociatedTokenAddressSync(quoteMint, userVolumeAccumulatorPda(user), true, quoteTokenProgram), isWritable: true, isSigner: false });
        }
        if (!pool.coinCreator.equals(PublicKey.default)) {
          remainingAccounts.push({ pubkey: poolV2PdaKey, isWritable: false, isSigner: false });
        }
        remainingAccounts.push(
          { pubkey: buybackFeeRecipient, isWritable: false, isSigner: false },
          { pubkey: buybackFeeRecipientTokenAccount, isWritable: true, isSigner: false },
        );
        const instruction = await this.offlineProgram.methods
          .buy(baseOut, maxQuoteIn, { 0: true })
          .accounts(swapAccounts)
          .remainingAccounts([...remainingAccounts])
          .instruction();
```

Fee-recipient choice (S2 `fees.ts getFeeRecipient`): non-mayhem → random of `protocol_fee_recipients[8]`; mayhem → random of `[reserved_fee_recipient, ...reserved_fee_recipients[7]]`; buyback → random of `buyback_fee_recipients[8]`. Docs recommend randomising to spread write locks.

---

## 7. Canonical pool rule

- Pool PDA seeds: `["pool", index u16 LE, creator, base_mint, quote_mint]` under pump_amm — VERIFIED_IN_SOURCE (IDL `create_pool.accounts[0].pda`; S2 `poolPda` uses `new BN(index).toArrayLike(Buffer,"le",2)`; docs example pool recomputed: `GseMAnN…` bump 254 ✓; live pool `FruHjS1…` ✓).
- Canonical (migrated) pool: `index = 0` (`CANONICAL_POOL_INDEX = 0`), `creator = find_program_address(["pool-authority", base_mint], 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P)`, `quote_mint = WSOL` for SOL curves (`canonicalPoolQuoteMint`: bonding curve stores `Pubkey::default` for SOL, pool is keyed by `So111…112`), or the curve's quote mint (USDC) for `migrate_v2`. VERIFIED_IN_SOURCE via `idl/pump.json migrate`/`migrate_v2` account seeds (`pool` seeds `["pool", const 2 bytes, pool_authority, mint, wsol_mint]` program = pump_amm; `pool_authority` seeds `["pool-authority", mint]`).
- `pool.coin_creator` (fee beneficiary) is separate from `pool.creator`; set from `create_pool` arg for canonical pools, or via `set_coin_creator` (Metaplex metadata creator / BondingCurve.creator), `admin_cto_pool`, `migrate_pool_coin_creator` (→ fee-program `SharingConfig` PDA `["sharing-config", base_mint]`). Only canonical pools may have a coin creator (error 6028).
- LP mint PDA `["pool_lp_mint", pool]` (Token-2022; recomputed = docs example ✓).

Excerpt — S1 `docs/PUMP_SWAP_CREATOR_FEE_README.md` @81091419:
```rust
pub fn pump_pool_authority_pda(base_mint: &Pubkey) -> Pubkey {
    let (pump_pool_authority, _) = Pubkey::find_program_address(
        &[b"pool-authority", base_mint.as_ref()],
        &Pubkey::from_str("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P").unwrap(),
    );
    pump_pool_authority
}
```

---

## 8. Token programs / mints

- `base_token_program` and `quote_token_program` are separate, caller-supplied accounts; `create_pool` also takes a fixed `token_2022_program` for the LP mint. Live canonical pool base mint `DRWUnUkF…pump` uses **Token-2022** (`TokenzQd…`) while quote (WSOL) uses SPL Token — VERIFIED (S3 tx accounts [11]/[12]). `create_v2` coins are Token-2022 per docs (`docs/instructions/BUY.md`).
- Base does not have to be a pump token and quote does not have to be WSOL for the program in general (any `(base, quote)` via `create_pool`; errors 6006/6007 `UnsupportedBaseMint/UnsupportedQuoteMint` exist but their rules are UNKNOWN). Canonical pools are `(pump token, WSOL)` or `(pump token, USDC)`. Non-SOL/USDC canonical quotes pay `exotic_flat_fees`.
- Quote-side WSOL handling: the SDK wraps SOL (transfer + `syncNative`) into the user's WSOL ATA before the swap and closes it after; the program itself only moves SPL tokens.

---

## 9. Events (field order, from S1 IDL)

- `BuyEvent` disc `67f4521f2cf57777`: timestamp i64, base_amount_out u64, max_quote_amount_in u64, user_base_token_reserves u64, user_quote_token_reserves u64, pool_base_token_reserves u64 (**pre-trade**), pool_quote_token_reserves u64 (**pre-trade, raw vault**), quote_amount_in u64, lp_fee_basis_points u64, lp_fee u64, protocol_fee_basis_points u64, protocol_fee u64, quote_amount_in_with_lp_fee u64 (= quote_in + lp_fee), user_quote_amount_in u64, pool, user, user_base_token_account, user_quote_token_account, protocol_fee_recipient, protocol_fee_recipient_token_account, coin_creator (pubkeys), coin_creator_fee_basis_points u64, coin_creator_fee u64, track_volume bool, total_unclaimed_tokens u64, total_claimed_tokens u64, current_sol_volume u64, last_update_timestamp i64, min_base_amount_out u64, ix_name string, cashback_fee_basis_points u64, cashback u64, buyback_fee_basis_points u64, buyback_fee u64, virtual_quote_reserves i128, can_boost bool, base_supply u64, holder_rewards_bps u64, holder_rewards u64.
- `SellEvent` disc `3e2f370aa503dc2a`: timestamp, base_amount_in, min_quote_amount_out, user_base_token_reserves, user_quote_token_reserves, pool_base_token_reserves, pool_quote_token_reserves, quote_amount_out, lp_fee_basis_points, lp_fee, protocol_fee_basis_points, protocol_fee, quote_amount_out_without_lp_fee (= quote_out − lp_fee), user_quote_amount_out, pool, user, user_base_token_account, user_quote_token_account, protocol_fee_recipient, protocol_fee_recipient_token_account, coin_creator, coin_creator_fee_basis_points, coin_creator_fee, cashback_fee_basis_points, cashback, buyback_fee_basis_points, buyback_fee, virtual_quote_reserves i128, can_boost bool, base_supply u64, holder_rewards_bps, holder_rewards.
- `CreatePoolEvent` disc `b1310cd2a076a774`. Events are emitted as `Program data: <base64>` logs (Anchor `emit!` via event_authority CPI-less log); decoded live logs with this layout parse cleanly.

---

## 10. Other verified items

- Other account discriminators: `GlobalVolumeAccumulator` `ca2af62b8ebe1eff` (544-byte IDL layout; live account 600 bytes), `UserVolumeAccumulator` `56ff700e66359afa` (90-byte IDL layout incl. cashback fields; live 137 bytes), `BondingCurve` `17b7f83760d8ac60`, `SharingConfig` `d84a0900388c5d4b`.
- Deposit/withdraw are disabled on boost pools (error 6064) and `lp_supply` must not drop below circulating LP supply (6067). `init_boost` / `boost_buy_and_burn` / `toggle_boost` exist (`boost_vault` = ATA of PDA `["boost_vault", pool]`), but how `virtual_quote_reserves` is set/changes over time is UNKNOWN (no docs; only the field + errors).
- SDK/IDL drift: SDK 1.20.0 bundles an IDL with `admin_set_coin_creator`, `admin_set_coin_creator_fee_editable`, `set_coin_creator_fee_bps` and no `is_holder_reward`; S1 IDL (2026-09-12) replaces those with `admin_cto_pool` and adds `is_holder_reward`. Buy/sell instruction definitions are identical in both.
- CU: docs recommend a static CU limit (bonding-curve FAQ suggests 100k; PumpSwap README snippets use 400k for pump v2 ixs). No PumpSwap-specific CU figure in sources → UNKNOWN.

## Open questions

1. Purpose/contents of the `pool-v2` remaining account (`["pool-v2", base_mint]`): key is validated (err 6062) but the account is NULL on mainnet; whether omitting it fails when `coin_creator != default` is not verified.
2. Exact on-chain rounding of `buy_exact_quote_in` (fee back-out and the base_out floor); only the SDK inverse + its localnet test are available.
3. How/when `virtual_quote_reserves` is set or decays on boost pools (observed constant ≈17,584,505,289 lamports across three pools) and whether the sell payout cap (`quote_out − lp_fee ≤ real vault`) is exactly what the program enforces (SDK check + error text only).
4. Omitted `track_volume` byte (data length 24) — accepted per pump docs' description of trailing `OptionBool`, not tested on the AMM.
5. Rules behind `UnsupportedBaseMint` / `UnsupportedQuoteMint` (6006/6007), i.e. which mints `create_pool` rejects; and whether Token-2022 quote mints with transfer hooks/fees are allowed.
6. Market-cap basis for tiering on-chain: SDK uses effective quote reserves and the live base-mint supply (or 1e15 for mayhem); on-chain `Pool::market_cap()` source not available.
7. Whether `fee_config`/`fee_program` can be omitted (IDL marks them mandatory; SDK comment says pump-fees is mandatory) — treated as required.
