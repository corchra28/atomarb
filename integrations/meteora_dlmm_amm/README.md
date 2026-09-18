# meteora-dlmm-amm

Meteora DLMM implemented as a Jupiter [`Amm`](https://github.com/jup-ag/jupiter-amm-interface), with its quote proven equal to the on-chain program.

```
cargo test                 # 4 parity tests (13 swaps) + 1 unit test (fixtures are committed)
./mutation_test.sh         # proves the suite actually asserts the behaviour
```

To refresh fixtures from mainnet: `REFRESH=1 RPC=<url> cargo test`.

## Why this venue

In the on-chain census (`docs/REAL_WORLD_MEV.md`), Meteora DLMM is the second most frequent venue among the 104 winning atomic arbitrages — 51 routed hops against Orca Whirlpool's 59. With `integrations/whirlpool_amm/`, this covers the two venues that between them appear in most real winners.

## The dependency decision, and why it differs from Whirlpool

Orca publishes `orca_whirlpools_core`, dependency-light and the same crate their own SDK quotes with. **Meteora publishes no equivalent.**

- `MeteoraAg/dlmm-sdk` is official and active, and its `commons` crate has `quote_exact_in` — but it is built on solana-sdk 2.1 and anchor-lang 0.31, which cannot coexist with the solana 3/4 generation litesvm needs. Jupiter's own reference example hits the same wall with `spl-token-swap` and vendors the math instead.
- `lb_clmm` on crates.io is from May 2024 with no repository declared.
- `meteora-dlmm` (MIT, 1,958 lines, **zero dependencies**) is what this uses.

A small third-party crate is a supply-chain consideration and is named as one. The answer is not to trust it: it is proven against the real program on four pools including bin crossings and Token-2022, and the mutation suite targets what this crate owns on top of it — decoding the `LbPair`, deriving the bin arrays, ordering them for the direction of travel, and refusing to quote past what it carries.

## Coverage

| Test | Pool | What it covers |
|---|---|---|
| `dlmm_deep_pool_parity` | `BGm1tav…` | Bin step 10, ~7,600 WSOL. Fills at 113.504 per unit at 1e6 and 113.486 at 2e11 — two hundredths of a percent across five orders of magnitude, so this is the arithmetic with almost no walking |
| `dlmm_wide_bin_pool_crosses_bins` | `5BoHD7D…` | Bin step 50. X to Y moves 6% between 1e6 and 1e9; **Y to X moves 48%**, from 8.789 per unit to 4.598. No single bin does that |
| `dlmm_token2022_transfer_fee_parity` | `GzaMLXL…` | Token X is Token-2022 with a **300 bps transfer fee**; active id −841 |
| `dlmm_refuses_swaps_beyond_the_carried_bin_arrays` | `5BoHD7D…` | A swap that outruns the bin arrays must be **refused, not quoted** — the engine reports 128 bins crossed before it runs out |

Plus a unit test on floor-division of the bin-array index, which matters because every SOL pool measured sits at a **negative** active id.

## Two things the IDL does not tell you

**`swap` cannot be used in place of `swap2`.** The older 15-account instruction pins both token programs to the legacy SPL Token id and rejects a Token-2022 pool with `InvalidProgramId` (3008). The parity suite caught this the moment a Token-2022 pool was added.

**`swap2`'s `remaining_accounts_info` is not an `Option`.** The SDK's IDL declares `Option<RemainingAccountsInfo>`, and every encoding built from that failed with `InstructionDidNotDeserialize` (102). Reading the bytes of real `swap2` instructions on chain settles it — the tail is:

```
03000000 0000 0100 0400
```

a bare `Vec` of three empty slices: `TransferHookX`, `TransferHookY`, `TransferHookReferral`, each length zero. No Option tag. That is what live clients send and what this encodes.

## Does the suite actually test anything?

```
CAUGHT   1 test(s) fail — array_index_of truncates toward zero instead of flooring
CAUGHT   4 test(s) fail — the bin-array PDA seeds the index big-endian instead of little-endian
CAUGHT   1 test(s) fail — quotes a partial fill instead of refusing when the bin arrays run out
CAUGHT   4 test(s) fail — swap direction inverted
CAUGHT   1 test(s) fail — the instruction's bin arrays walk the wrong way
CAUGHT   1 test(s) fail — Token-2022 transfer fees are ignored
CAUGHT   1 test(s) fail — both token programs pinned to legacy SPL Token
CAUGHT   4 test(s) fail — active_id read from offset 80 (bin_step) instead of 76
CAUGHT   3 test(s) fail — reserve_x and reserve_y offsets swapped
CAUGHT   1 test(s) fail — 64 bins per array instead of 70

caught 10 of 10
```

One mutation was written and then removed rather than left reporting a false gap: feeding the engine zero mint decimals changes nothing, because `decimals_x`/`decimals_y` appear only in its decoder and never in its quote, fee or math code. The mutation was inert by construction, not a hole in the tests.

## Layout, resolved from the official IDL

`LbPair` is 904 bytes, discriminator `210b3162b565b10d` — confirmed by counting: 159,244 such accounts on chain, and exactly as many `Oracle` accounts, one per pool.

| field | offset |
|---|---:|
| `active_id` (i32) | 76 |
| `bin_step` (u16) | 80 |
| `status` (u8) | 82 |
| `token_x_mint` / `token_y_mint` | 88 / 120 |
| `reserve_x` / `reserve_y` | 152 / 184 |
| `oracle` | 552 |

`collect_fee_mode` sits at 36, inside `StaticParameters`, which the IDL does not name at top level.

## Scope

`quote()` implements ExactIn, which is what the test-kit asserts. Limit orders — a newer pool feature `commons` models with `support_limit_order` — are passed as false; a pool using them would disagree with the chain, and the parity suite is what would say so.

## Lockfile

`Cargo.lock` is committed, seeded from `integrations/whirlpool_amm/Cargo.lock`. Resolving fresh picks up incompatible `solana-clock` and `wincode` generations and litesvm fails to build.
