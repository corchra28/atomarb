# Orca Whirlpool as a Jupiter Amm — progress log

**Why this one.** The on-chain census in `docs/REAL_WORLD_MEV.md` found 98 of 104 winning
atomic arbitrages include a concentrated-liquidity venue, and Orca Whirlpool is the most
frequent at 59 routed hops. The engine in this repository has no concentrated-liquidity
adapter at all, which is the single measured reason it was fishing in the wrong pond.

**Goal.** `integrations/whirlpool_amm/` — a `jupiter-amm-interface` implementation whose
`quote()` is proven equal to the on-chain program by `jupiter-amm-test-kit`, plus a
mutation suite proving the tests actually assert the math, exactly as done for
`integrations/raydium_cpmm_amm/`.

**Success criterion.** `cargo test` green from a clean clone with no RPC, and
`./mutation_test.sh` catching every mutation.

---

## Reconnaissance (done)

- Program `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`, 159,100 accounts of 653 bytes.
- Account discriminator `3f95d10ce1806309`.
- Verified offsets against a live SOL/USDC pool (`Czfq3xZ…`):

| field | offset | value on the sample pool |
|---|---:|---|
| whirlpools_config | 8 | `2Lecshu…` |
| tick_spacing | 41 (u16) | 4 |
| fee_rate | 45 (u16) | 400 = 0.04% |
| protocol_fee_rate | 47 (u16) | 1300 |
| liquidity | 49 (u128) | 481,341,503,119,076 |
| sqrt_price | 65 (u128) | 6,225,267,961,551,908,990 |
| tick_current_index | 81 (i32) | −21,727 |
| token_mint_a | 101 | WSOL |
| token_vault_a | 133 | `EUuUbDc…` |
| token_mint_b | 181 | USDC |
| token_vault_b | 213 | `2WLWEuK…` |

- Reference source cloned: `orca-so/whirlpools`, `programs/whirlpool/src/`.

## Why this is much harder than the CPMM port

Constant product is one formula. A concentrated-liquidity swap is a loop:

1. Fee is taken off the input first (`fee_rate` on the amount in).
2. Within the current tick range, swap along the sqrt-price curve until either the input is
   exhausted or the price reaches the range boundary.
3. If the boundary is reached, **cross the tick**: apply `liquidity_net`, move to the next
   initialised tick, and continue with what is left.
4. Tick liquidity lives in separate `TickArray` accounts (88 ticks each), so the accounts
   needed depend on how far the price will move — `has_dynamic_accounts()` must be true and
   `get_accounts_to_update` has to derive the right tick arrays.

Rounding direction is load-bearing at every step and differs by swap direction.

## Plan

- [x] Decode `Whirlpool` (653 bytes), offsets verified against a live pool
- [x] Decode `TickArray` (9,988 bytes = 8 disc + 4 start_tick_index + 88 x 113 + 32 pool)
- [x] ~~Port the Q64.64 swap math~~ — **use `orca_whirlpools_core` instead** (see decision below)
- [x] Derive tick-array PDAs, `get_accounts_to_update`, `has_dynamic_accounts`
- [x] `get_swap_and_account_metas` for the native `swap_v2` instruction
- [x] Parity test on the deep SOL/USDC pool (4 swaps, both directions)
- [x] Parity test at sizes that force tick crossings (4 swaps, 20% measured price impact)
- [x] Decode the newer `DynamicTickArray` shape as well as the fixed one
- [x] Refuse to traverse tick arrays that do not exist on chain
- [x] Mutation suite — **10 of 10 caught**
- [x] Close escape 1: `liquidity_net` — the mutation itself was a no-op, not a test gap
- [x] Close escape 2: a Whirlpool with a Token-2022 mint carrying a 300 bps transfer fee
- [x] Verify from a clean clone with no RPC — 7 tests green, no network
- [ ] Adaptive-fee pools (currently refused rather than mis-quoted)

## Decision: do not port the math

Orca publishes `orca_whirlpools_core` (v2.1.1, 680k downloads), the same crate their own SDK
quotes with, exposing `swap_quote_by_input_token`. Hand-porting several hundred lines of Q64.64
tick-crossing arithmetic would add a large surface of subtle rounding bugs for no benefit.

This crate therefore owns the part an integrator actually gets wrong: decoding the accounts,
deriving and supplying the right tick arrays, and building the instruction. The mutation suite
targets exactly that, rather than pretending to test Orca's arithmetic.

## Log

- Reconnaissance complete, offsets verified against the source and a live pool, source cloned.
- Found and adopted `orca_whirlpools_core`; wrote the Amm, it compiles.
- Dumped the program ELF. **First attempt broke it**: I trimmed trailing zero padding from the
  programdata account and cut 8 bytes into real data, so LiteSVM refused it with
  `ProgramLoad("Offset or value is out of bounds")`. Fixed by computing the true size from the
  ELF header (`e_shoff + e_shnum * e_shentsize` = 1,488,104) instead of guessing.
- First parity run: deep pool passed, thin pool failed with `Invalid tick array sequence`.
  Cause was my test, not the code: 200 SOL of the original sizes needs more than the three tick
  arrays the native instruction can carry, so that swap cannot execute on chain either.
  Probed the real limits with `examples/probe.rs` and calibrated the sizes.
- Both parity tests green: 8 swaps, both pools, both directions.
- Mutation suite written. **First run reported 4 of 7 caught, and that was wrong**: my
  compile-failure detector matched `error: test failed`, so genuine test failures were being
  labelled "does not compile". Fixed the detector; also replaced a vacuous mutation (not
  refreshing `sqrt_price` changes nothing in a snapshot test, where the snapshot IS the state).
- Honest result then: **6 of 8 caught**.
- Chasing the two escapes found a **real bug**. Adding a Token-2022 pool, the parity test failed
  with `TickArraySequenceInvalidIndex` from the program: my quote treated a tick array that does
  not exist on chain as "empty but traversable", so it produced a number no transaction could
  honour. Fixed by only traversing arrays that actually exist, and never referencing a
  non-existent one in the instruction.
- That pool also uses the newer `DynamicTickArray` shape (disc `11d8f68ee1c7da38`, variable
  length, each tick 1 byte uninitialised and 113 initialised) which I had skipped. Implemented
  both shapes.
- The `liquidity_net` escape was **not a test gap at all**: the mutation read `u128` and cast to
  `i128`, which in Rust is a bit-for-bit reinterpretation, so it changed nothing. Replaced with
  dropping the sign, and it is caught.
- The dynamic-stride mutation stayed invisible through parity even on a pool with two initialised
  ticks, so it is now pinned by a **unit test on the decoder** against a synthetic array — the
  right tool for a decoding bug.
- Removed the `traverse_missing_arrays` mutation as genuinely unobservable with these pools: on
  all of them a swap reaching a missing array also fails for want of liquidity. Recorded in the
  README rather than left as a false gap.
- **Final: 5 parity tests over 17 swaps, 2 unit tests, 10 of 10 mutations caught.** (An earlier line in this log said 19 swaps; the count from the source is 17.)
