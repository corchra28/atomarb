# whirlpool-amm

Orca Whirlpool implemented as a Jupiter [`Amm`](https://github.com/jup-ag/jupiter-amm-interface), with its quote proven equal to the on-chain program.

```
cargo test                 # 5 parity tests + 2 unit tests (fixtures are committed)
./mutation_test.sh         # proves the suite actually asserts the behaviour
```

To refresh fixtures from mainnet: `REFRESH=1 RPC=<url> cargo test`.

## Why this venue

The on-chain census in `docs/REAL_WORLD_MEV.md` counted 104 winning atomic arbitrages and found **98 of them include a concentrated-liquidity venue**, Whirlpool most often at 59 routed hops — while the engine in this repository had no concentrated-liquidity adapter at all. That was the measured reason it was looking in the wrong place.

## What this crate does and does not do

**It does not reimplement the swap math.** Orca publishes `orca_whirlpools_core`, the same crate their own SDK quotes with, and this calls `swap_quote_by_input_token` from it. Hand-porting several hundred lines of Q64.64 tick-crossing arithmetic would add a large surface of subtle rounding bugs for no benefit.

What it owns is the part an integrator actually gets wrong: decoding the accounts, deriving and supplying the right tick arrays, and building the native `swap_v2` instruction. The mutation suite targets exactly that, rather than pretending to test Orca's arithmetic.

## Coverage

Five parity tests, 19 swaps, against the real mainnet program in LiteSVM:

| Test | Pool | What it covers |
|---|---|---|
| `whirlpool_deep_pool_parity` | `Czfq3xZ…` | SOL/USDC, spacing 4, very deep — curve arithmetic with no tick crossing |
| `whirlpool_thin_pool_crosses_ticks` | `HJPjoWU…` | SOL/USDC, spacing 64, ~3000x less liquidity. 0.1 SOL fills at 113.3 USDC/SOL, 200 SOL at 90.1 — a 20% move no single tick range can produce, so these **demonstrably cross tick boundaries** |
| `whirlpool_token2022_transfer_fee_parity` | `3qjhHaR…` | A Token-2022 mint with a **300 bps transfer fee**, a **positive** current tick, and the pool sitting **exactly on an array boundary** |
| `whirlpool_dynamic_tick_array_parity` | `949myKp…` | The newer `DynamicTickArray` shape, with more than one initialised tick so the variable-width walk is actually exercised |
| `whirlpool_refuses_swaps_beyond_the_existing_tick_arrays` | `3qjhHaR…` | A swap the pool cannot serve must be **refused, not quoted** |

Plus two unit tests: floor-division of the array start tick for negative ticks, and the dynamic tick walk against a synthetic array with known values.

## Two on-chain tick array shapes, both live

| | discriminator | length |
|---|---|---|
| `FixedTickArray` | `4561bdbe6e0742bb` | 9,988 bytes |
| `DynamicTickArray` | `11d8f68ee1c7da38` | 148 to 10,004 bytes |

The dynamic one encodes each tick as an enum: **1 byte when uninitialised, 113 when not**. A decoder that assumes a fixed stride reads the first initialised tick correctly and then desynchronises, which is why the unit test uses three of them.

## Does the suite actually test anything?

```
CAUGHT   1 test(s) fail — array_start_tick truncates toward zero instead of flooring
CAUGHT   2 test(s) fail — tick arrays are treated as empty, so liquidity never changes at a boundary
CAUGHT   1 test(s) fail — tick arrays are walked the wrong way for the trade direction
CAUGHT   1 test(s) fail — tick decoding forgets the 4-byte start_tick_index before the ticks
CAUGHT   1 test(s) fail — dynamic ticks walked with a fixed stride instead of a variable one
CAUGHT   3 test(s) fail — the newer DynamicTickArray shape is not decoded at all
CAUGHT   1 test(s) fail — liquidity_net sign dropped, so every crossing adds liquidity
CAUGHT   1 test(s) fail — Token-2022 transfer fees are ignored
CAUGHT   4 test(s) fail — fee_rate read from offset 43 (the fee tier seed) instead of 45
CAUGHT   1 test(s) fail — only one tick array supplied instead of the three the instruction carries

caught 10 of 10
```

Getting there took four corrections, all recorded in `PROGRESS.md`. Two are worth repeating here because they are the kind of thing that quietly inflates a score:

- A mutation reading `liquidity_net` as `u128` and casting back was a **no-op** — in Rust `u128 as i128` is a bit-for-bit reinterpretation. It looked like a gap in the tests when it was a gap in the mutation.
- The script's compile-failure detector matched `error: test failed`, so genuine catches were being reported as "does not compile".

## One guard the mutation suite cannot reach

`quote()` refuses to traverse a tick array that does not exist on chain, and `get_swap_and_account_metas` will not reference one. That guard exists because of an **observed** failure: before it, the Token-2022 pool quoted a size the program then rejected with `TickArraySequenceInvalidIndex`, and the parity test caught it.

No pool in this suite makes reintroducing it observable, because on all of them a swap that reaches a missing array also fails for want of liquidity. Rather than keep a mutation that reports a false gap, it is removed and recorded here. The `whirlpool_refuses_swaps_beyond_the_existing_tick_arrays` test pins the refusal behaviour directly.

## Scope

`quote()` implements ExactIn, which is what the test-kit asserts; `supports_exact_out()` stays false. Adaptive-fee pools (`fee_tier_index != tick_spacing`) are **refused** rather than quoted with the static fee, because they price through an Oracle account this crate does not read yet.

## Lockfile

`Cargo.lock` is committed, seeded from the upstream `jupiter-amm-interface` lockfile. Resolving fresh picks up incompatible `solana-clock` and `wincode` generations and litesvm fails to build.
