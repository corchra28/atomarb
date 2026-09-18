# Meteora DLMM as a Jupiter Amm — progress log

**Why this one.** In the on-chain census (`docs/REAL_WORLD_MEV.md`), Meteora DLMM is the second
most frequent venue among the 104 winning atomic arbitrages — 51 routed hops against Orca
Whirlpool's 59. Whirlpool is done (`integrations/whirlpool_amm/`); this is the other half.

**Goal.** Same standard as the two adapters already in this repository: `quote()` proven equal to
the on-chain program by `jupiter-amm-test-kit`, plus a mutation suite in which every mutation is
caught.

**Success criterion.** `cargo test` green from a clean clone with no RPC, and
`./mutation_test.sh` catching every mutation.

---

## Reconnaissance (done)

Program `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`, 991,896 accounts, 13 account types.
Anchor discriminators computed as `sha256("account:<Name>")[..8]` and matched against the live
counts, which confirms the identification:

| Account | Discriminator | Count on chain |
|---|---|---:|
| `BinArray` | `5c8e5cdc059446b5` | 470,464 |
| `PositionV2` | `75b0d4c7f5b485b6` | 193,441 |
| `Oracle` | `8bc283b38cb3e5f4` | 159,244 |
| **`LbPair`** | `210b3162b565b10d` | **159,244** |
| `BinArrayBitmapExtension` | `506f7c7137ed1205` | 6,432 |
| `TokenBadge` | `74dbcce5f974ff96` | 1,325 |
| `PresetParameter2` | `abec9473a271deae` | 392 |

`LbPair` and `Oracle` have identical counts, as they should: one oracle per pool.

## Why this is harder than Whirlpool, and the decision it forces

Whirlpool had a clean answer: Orca publishes `orca_whirlpools_core`, 680k downloads, the same
crate their own SDK quotes with. **Meteora has no equivalent.**

- `MeteoraAg/dlmm-sdk` is official and active (310 stars, pushed 2026-09-03) and its `commons`
  crate exposes `quote_exact_in`. But it is built on **solana-sdk 2.1 and anchor-lang 0.31**,
  while `jupiter-amm-test-kit` and litesvm sit on the solana 3/4 generation. That is exactly the
  conflict that broke the build on Whirlpool, and worse here because anchor drags in a large
  tree. Jupiter's own reference example hits the same wall and says so: the `spl-token-swap`
  crate "is stuck on an old Solana generation and won't compile here", so they vendor the math
  inline.
- `lb_clmm` on crates.io is from 2024-05 with no repository declared. Not a basis for anything.
- `meteora-dlmm` (`nirkt/meteora-dlmm-rs`, MIT, v0.2.0, 404 downloads) is 1,958 lines with
  **zero dependencies** — so no conflict is possible. It exposes `decode_lb_pair`,
  `decode_bin_arrays`, `quote`, `quote_with_mints`, prices Token-2022 transfer fees and refuses
  transfer hooks rather than mis-quoting them.

**Decision: try `meteora-dlmm` first, and let the parity harness be the arbiter.** A small
third-party crate is a supply-chain consideration and is recorded as one — but the whole point of
this exercise is that nothing is trusted, it is proven against the real program. If parity holds
across pools with bin crossings, variable fees and Token-2022, that is the evidence. Where it
fails, the failure says exactly which part to port from Meteora's official `commons`.

Known risk to probe: `commons` has `support_limit_order` and `fee_on_input` paths that the
third-party crate does not advertise. Pools using them may quote wrong, and parity will say so.

## Plan

- [x] Identify the account types and confirm against on-chain counts
- [x] Establish that no vendor-official, dependency-compatible math crate exists
- [x] Crate skeleton, `Cargo.lock` seeded from `whirlpool_amm`
- [x] Decode `LbPair` — offsets resolved from the IDL, verified against live pools
- [x] Derive `BinArray` PDAs and the bitmap-extension account; `has_dynamic_accounts`
- [x] `quote()` via `meteora-dlmm`, including Token-2022
- [x] `get_swap_and_account_metas` for the native `swap` instruction
- [x] Dump the program ELF — 2,198,032 bytes computed from the header, not guessed
- [ ] Probe serviceable swap sizes per pool
- [x] Parity test: deep pool and a wide-bin pool, both green
- [ ] Parity test: sizes that cross bins, with the price impact measured to prove they do
- [ ] Parity test: a pool with a Token-2022 mint carrying a transfer fee
- [ ] Mutation suite, every mutation verified to actually change behaviour
- [ ] Verify from a clean clone with no RPC

## Log

- Reconnaissance done. Account types confirmed by discriminator against live counts.
- Surveyed the crate landscape and chose the zero-dependency third-party engine over porting
  3,110 lines of stateful fixed-point math, with parity as the check.
- `LbPair` layout resolved by walking the official IDL with a recursive size resolver: LEN 904,
  `active_id` 76, `bin_step` 80, `status` 82, mints 88/120, reserves 152/184, oracle 552.
  `collect_fee_mode` is at 36, inside `StaticParameters`, which the IDL does not name at top level.
- Program ELF dumped with the real size taken from the ELF header (2,198,032 of 2,229,776 raw
  bytes). The Whirlpool mistake was not repeated.
- **`swap2` does not work and `swap` does.** The deployed program rejected every `swap2` encoding
  with `InstructionDidNotDeserialize` (error 102), including the one built from the SDK's own IDL
  for `Option<RemainingAccountsInfo>`. The IDL in `MeteoraAg/dlmm-sdk` is ahead of, or otherwise
  disagrees with, the deployed program on that argument. Worth recording: `AccountsType` in that
  struct has only transfer-hook variants, so bin arrays are plain trailing accounts either way,
  and the simpler 15-account `swap` (disc `f8c69e91e17587c8`) carries no such argument.
- First two parity tests green on the deep and wide-bin pools.
