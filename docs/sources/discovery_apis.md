# Discovery APIs — Raydium API v3 + local PumpSwap inventory (primary-source verification note)

Consulted (UTC): 2026-09-17T13:05Z … 2026-09-17T13:30Z (live calls from this host; all HTTPS to `api-v3.raydium.io`; **no Solana RPC** was used by the discovery path).
Scope: population discovery only (pool addresses + unverified hints). Nothing here is used for quoting; every address is unverified until `src/state/snapshot.ts` decodes/validates it.

Confidence legend: **VERIFIED_LIVE** = observed in a live HTTP response saved under `data/discovery/` (gitignored) / `tests/fixtures/discovery/`; **VERIFIED_IN_SOURCE** = read in SDK code; **DOCS_ONLY** = prose docs; **UNKNOWN** = could not establish.

## 0. Sources

| # | Source | Ref | What it established |
|---|--------|-----|---------------------|
| D1 | https://api-v3.raydium.io (live) | `/main/version` → `{"latest": "V3.0.1", "least": "V3.0.1"}` at 2026-09-17T13:13:15.712Z | endpoint shapes, pagination behaviour, page-size caps, poolType casing, `/pools/key/ids` shape (responses persisted in `data/discovery/*.json`) |
| D2 | https://github.com/raydium-io/raydium-sdk-V2 `src/api/url.ts`, `src/api/api.ts`, `src/api/type.ts` | HEAD `c2897835f71873471f4160fa57bd1865b7903d55` (clone in `.scratch/raydium-sdk-V2`, consulted 2026-09-17) | `getPoolList` → `/pools/info/list-v2?size=&hasReward=&poolType=&sortField=&sortType=&nextPageId=`; `fetchPoolByMints` → same endpoint with `mint1/mint2` (mints sorted by string compare, SOL→WSOL); `fetchPoolKeysById` → `/pools/key/ids?ids=a,b`; `enum PoolFetchType { All="all", Standard="Standard", Concentrated="Concentrated" }`; `sort ∈ liquidity, volume24h, volume7d, volume30d, fee24h, fee7d, fee30d, apr24h, apr7d, apr30d` — VERIFIED_IN_SOURCE |
| D3 | `docs/sources/raydium_cpmm.md` §8 (verified 2026-09-17) | — | per-endpoint `poolType` casing, item keys, `type:"Standard"` covers AMM v4 AND CPMM → filter by `programId` |
| D4 | `data/inventory/pumpswap_pools.provenance.json` + `pumpswap_pools.jsonl.gz` | source sha256 `6daeaaf47b0cfdd1041bad3fffb4fb7fd659f2b06f908d2ae08eeff2bab8eb54`, source mtime `2026-09-04T14:12:34.613Z`, exported 2026-09-17T11:52:51.787677+00:00; gz sha256 `3865384cd95c9a8050b903bec4cd2fb4e823233899caaf153c4bb2f038577416` | PumpSwap WSOL-quote pool addresses (25,061 of 32,491 records), fields `pool,index,base_mint,quote_mint,canonical`; addresses only, unverified |

## 1. Exact URLs used by the real discovery run — VERIFIED_LIVE

Client: `src/discovery/raydium_api.ts` (`User-Agent: atomarb-research`, serialized, ≤2 req/s, 20 s timeout, ≤4 retries on 429/5xx/network only; `{success:false,msg}` bodies are never retried). All responses HTTP 200, no 429 seen.

- `GET https://api-v3.raydium.io/main/version` → `{"success":true,"data":{"latest": "V3.0.1", "least": "V3.0.1"}}`
- `/pools/info/list-v2` (primary listing, 5 pages, size=1000, liquidity desc, `mint1=WSOL`, `poolType=Standard`):
  1. `https://api-v3.raydium.io/pools/info/list-v2?size=1000&mint1=So11111111111111111111111111111111111111112&poolType=Standard&sortField=liquidity&sortType=desc` → HTTP 200, 1000 items, 1028 ms, fetched 2026-09-17T13:13:15.712Z, nextPageId=present, hasNextPage=True
  2. `https://api-v3.raydium.io/pools/info/list-v2?size=1000&mint1=So11111111111111111111111111111111111111112&poolType=Standard&sortField=liquidity&sortType=desc&nextPageId=94c0a77c-6624-4d27-a0d3-9949df5ab72c` → HTTP 200, 1000 items, 1425 ms, fetched 2026-09-17T13:13:16.769Z, nextPageId=present, hasNextPage=True
  3. `https://api-v3.raydium.io/pools/info/list-v2?size=1000&mint1=So11111111111111111111111111111111111111112&poolType=Standard&sortField=liquidity&sortType=desc&nextPageId=716876a6-7d10-4e83-bb5e-61e78c96632f` → HTTP 200, 1000 items, 669 ms, fetched 2026-09-17T13:13:18.220Z, nextPageId=present, hasNextPage=True
  4. `https://api-v3.raydium.io/pools/info/list-v2?size=1000&mint1=So11111111111111111111111111111111111111112&poolType=Standard&sortField=liquidity&sortType=desc&nextPageId=2e9f23a7-fbf5-464c-ad50-ae67ad9a095f` → HTTP 200, 1000 items, 981 ms, fetched 2026-09-17T13:13:18.915Z, nextPageId=present, hasNextPage=True
  5. `https://api-v3.raydium.io/pools/info/list-v2?size=1000&mint1=So11111111111111111111111111111111111111112&poolType=Standard&sortField=liquidity&sortType=desc&nextPageId=35ef3d3d-063c-4c9a-b3e3-33c99b71002d` → HTTP 200, 1000 items, 530 ms, fetched 2026-09-17T13:13:19.915Z, nextPageId=present, hasNextPage=True
  Stopped: `CAP_REACHED cap=5000` (capped=True); 5000 distinct ids, 0 duplicate ids across pages. Window 2026-09-17T13:13:15.712Z … 2026-09-17T13:13:20.474Z.
- `/pools/info/mint` (cross-check listing, 5 pages, pageSize=1000, `poolType=standard`, `poolSortField=liquidity`):
  1. `https://api-v3.raydium.io/pools/info/mint?mint1=So11111111111111111111111111111111111111112&poolType=standard&poolSortField=liquidity&sortType=desc&pageSize=1000&page=1` → HTTP 200, 1000 items, 422 ms, fetched 2026-09-17T13:13:20.647Z, nextPageId=absent, hasNextPage=True
  2. `https://api-v3.raydium.io/pools/info/mint?mint1=So11111111111111111111111111111111111111112&poolType=standard&poolSortField=liquidity&sortType=desc&pageSize=1000&page=2` → HTTP 200, 1000 items, 871 ms, fetched 2026-09-17T13:13:21.148Z, nextPageId=absent, hasNextPage=True
  3. `https://api-v3.raydium.io/pools/info/mint?mint1=So11111111111111111111111111111111111111112&poolType=standard&poolSortField=liquidity&sortType=desc&pageSize=1000&page=3` → HTTP 200, 1000 items, 854 ms, fetched 2026-09-17T13:13:22.047Z, nextPageId=absent, hasNextPage=True
  4. `https://api-v3.raydium.io/pools/info/mint?mint1=So11111111111111111111111111111111111111112&poolType=standard&poolSortField=liquidity&sortType=desc&pageSize=1000&page=4` → HTTP 200, 1000 items, 495 ms, fetched 2026-09-17T13:13:22.920Z, nextPageId=absent, hasNextPage=True
  5. `https://api-v3.raydium.io/pools/info/mint?mint1=So11111111111111111111111111111111111111112&poolType=standard&poolSortField=liquidity&sortType=desc&pageSize=1000&page=5` → HTTP 200, 1000 items, 469 ms, fetched 2026-09-17T13:13:23.437Z, nextPageId=absent, hasNextPage=True
  Stopped: `CAP_REACHED cap=5000` (capped=True); 5000 distinct ids.
- `GET https://api-v3.raydium.io/pools/key/ids?ids=Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp%2CEyktEFod1gAgsuM1hXmEpqkitFFk9XczkqLPx2vKiceg%2CG8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh%2C8ujpQXxnnWvRohU2oCe3eaSzoL7paU2uj3fEn4Zp72US%2C2higKRf25Q9WMcYfgyK96AAuFVv5zucfDAFHHDuVETcq%2C6CQSpRdGtNWEbLhKpx7DAw7FDAm3g7wvjtsvaTKWBwxo%2C7qAVrzrbULwg1B13YseqA95Uapf8EVp9jQE5uipqFMoP%2C4Bn7ow3iYnaPGdhWhs8zLVw8YtUUTboQdn95rFEusR9D%2C2KUEBor9P8e2YVGCUnD9ipmhGM9nL4pG11zeEoQVQZWg%2CCB7CeSUwCHFptDg18MeN8NQiP3KRV5HN6L45BPCpv2cp%2CAs5e4ZDPgnXAJbt88TRy6amGWipepBSAjgopDCcQMDCE%2CHa4SGpJP9mBNcmvYDFCJD7bGbmHTx6mpzcC9XuqsikHJ%2CHMcsLqREEer8Q7VuRTxrxaNnyDgJRYc77XJ9K3gcARWv%2C8MkcaTC81opkPc3VWNqqn9b15sy6N9zh33j4QefwEwgv%2C5hz7B3Cw9pqAaqLfoik6WTUk4gVfBvJuCJ2ogUXcYatK%2C3F65qWbEvuEpXy45PyWsHHfzhZRPsoYTFbzq1E4DKRxZ%2CA4wvpiogBMgFdmrKbH1gwNbQDDzavMaUbLVdGXZpk84v`
  → 17 keys for 17 requested ids (URL length 839 chars), 0 missing, fetched 2026-09-17T13:19:13.129Z.
- Pre-probes (3 requests, curl `-A atomarb-research`, 2026-09-17 ~13:05Z): `/main/version`; `/pools/info/mint?mint1=WSOL&poolType=standard&poolSortField=liquidity&sortType=desc&pageSize=3&page=1` (→ `count:3, hasNextPage:true`); `/pools/info/list-v2?size=3&mint1=WSOL&poolType=Standard&sortField=liquidity&sortType=desc` (→ 3 items + `nextPageId`).

HTTP requests for this agent's whole task: 3 probes + 12 (run with `--cross-check`) + 1 (pool-keys re-fetch via `--reuse-list`) + 3 (network test) = **19**. Solana RPC requests: **0**.

## 2. Pagination — VERIFIED_LIVE (both endpoints paginate fully and return identical id sets)

| Property | `/pools/info/list-v2` | `/pools/info/mint` |
|---|---|---|
| cursor | `data.nextPageId` (uuid string), present on every page that has a successor (incl. page 5 here); absent on the last page (fixture chain) | `page=N` (1-based) + `data.hasNextPage` (bool) |
| page size param | `size` — docs cap 1000 (D3, DOCS_ONLY); **1000 honored** (5×1000 items) | `pageSize` — docs cap 1000; **1000 honored** |
| `count` field | none | `data.count` = number of items **in this page** (3 for pageSize=3, 1000 for 1000) — NOT a total; neither endpoint exposes a total |
| `poolType` value | `Standard` (capitalized, D2 enum) | `standard` (lowercase; `Standard` → HTTP 500 `query poolType type error`, D3) |
| sort params | `sortField=liquidity&sortType=desc` | `poolSortField=liquidity&sortType=desc` |
| mint filter | `mint1=<WSOL>` returns pools with WSOL on **either** side | same |
| id overlap (first 5000) | **5000 common, 0 only-list-v2, 0 only-info-mint**; same page-1 order (`58oQChx4…`, `AgFnRLUS…`, `5EgCcjku…`) | |

Decision: `list-v2` is the primary listing (what SDK 0.2.70 `getPoolList`/`fetchPoolByMints` call); `info-mint` stays available for cross-checks (`--cross-check`). Both would continue beyond 5000 (`nextPageId` / `hasNextPage` still set on page 5) — the **5,000 cap is ours** (brief), logged as `RAYDIUM_LIST_CAPPED`.

## 3. Coverage of the 5,000 cap — VERIFIED_LIVE (this run)

- Liquidity desc: pool #1 tvl ≈ $33,217,492, pool #5000 tvl ≈ $10,314. **CPMM WSOL pools with tvl below ≈ $10,319 are NOT listed** by this run; the total number of Standard WSOL pools is UNKNOWN (> 5000).
- Among the 5,000: **822 CPMM** (`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`); the rest AMM v4 (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`). `type` was `Standard` for all 5000; `programId` is the only CPMM discriminator in the item (D3).
- Each CPMM item carried `config.{id,index,tradeFeeRate,protocolFeeRate,fundFeeRate,creatorFeeRate}`, `feeRate`, `openTime`, `tvl`, `mintAmountA/B` — carried as **hints only** (`PoolRef.hints`).

## 4. Rate limits — UNKNOWN (undocumented). Observed: 13 sequential requests at ≤2 req/s, all HTTP 200; 1000-item pages are ≈2.8 MB JSON and took 0.5–1.5 s each.

## 5. `/pools/key/ids` — VERIFIED_LIVE

`GET /pools/key/ids?ids=<comma-separated>`; `data` is an array that may contain `null` for unknown ids (SDK filters with `Boolean`, D2) — the client matches entries by `id`. CPMM entries: `{programId,id,mintA,mintB,lookupTableAccount,openTime,vault:{A,B},authority,mintLp,config:{…},observationId}`. D3 §8 states these equal on-chain PoolState fields for the pool it checked; **this note does not re-verify them** — they are attached as `keys_*` hints and the adapter must derive/validate on-chain. 17 ids in one GET (839-char URL) worked.

## 6. Population result of the real run (2026-09-17T13:26:09.373Z, `reports/population_20260917T132609Z.json`)

| item | value |
|---|---|
| Raydium Standard WSOL pools listed | 5000 (capped) |
| Raydium **CPMM** WSOL pools | 822 (822 mints; 0 mints with ≥2 CPMM pools) |
| PumpSwap WSOL pools (inventory) | 25061 (24617 mints; 25061 lines, 0 skipped, 0 duplicate addresses) |
| (a) PumpSwap mints with ≥2 pools | 123 (pre-count 123 confirmed; 653 ranked pairs after the 32-per-mint cap, 4501 truncated) |
| (b) mints with a CPMM pool AND a PumpSwap pool | 17 (50 pool pairs) |
| (c) mints with ≥2 CPMM pools | 0 |
| dedup | 0 duplicate addresses; 123 (adapter,mintA,mintB) groups with >1 pool (all PumpSwap = the 123 multi-pool mints); 0 non-WSOL pairs |
| shortlist | 50 pools / 28 routes / 22 mints (maxPools 50, ≤6 pools per mint, cross-adapter routes ranked by Raydium tvl first) |

Interpretation: the cross-adapter intersection is **small (17 mints)** — a coverage result, not a failure. The CPMM side only covers pools with tvl ≳ $10.3k, and the PumpSwap inventory is 13 days old (pools migrated after 2026-09-04 are missing). Widening either side (more pages, or per-mint `mint1=WSOL&mint2=<mint>` queries for the 123 multi-pool mints at ~1 request each) is a budget decision, not a code change.

## 7. Open questions

- Raydium API rate limits and the total number of Standard WSOL pools — UNKNOWN (no total-count field).
- Whether `nextPageId` cursors stay valid over time (consumed immediately; never reused from cache).
- `tvl` semantics (USD? price source?) — unstated; used only as a ranking hint.
