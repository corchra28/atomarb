# raydium-cpmm-amm

Raydium CPMM (`raydium-cp-swap`) implemented as a Jupiter [`Amm`](https://github.com/jup-ag/jupiter-amm-interface), with its quote proven equal to the on-chain program.

```
cargo test                 # the parity suite (fixtures are committed)
./mutation_test.sh         # proves the suite actually asserts the math
```

To refresh fixtures from mainnet: `REFRESH=1 RPC=<url> cargo test`.

## What this is

Jupiter's published integration path for a Solana DEX is: implement the `Amm` trait, then verify it with [`jupiter-amm-test-kit`](https://github.com/jup-ag/jupiter-amm-interface/tree/main/test-kit), which snapshots a live pool, runs your `quote()`, executes the program's native swap in LiteSVM, and asserts the realized on-chain token delta equals the quote **exactly**.

This crate is that, for Raydium CPMM. The math is a Rust port of this repository's TypeScript adapter (`src/adapters/raydium_cpmm/`), which was itself a line-by-line port of `raydium-cp-swap@59fb845`.

## Results

Three pools, twelve swaps, both directions, all exact:

| Test | Pool | What it covers |
|---|---|---|
| `raydium_cpmm_wsol_pair_parity` | `Q2sPHPd…` | A deep WSOL pair whose vaults carry **non-zero accrued protocol and fund fees**, so `vault_amount_without_fee` has to be applied |
| `raydium_cpmm_creator_fee_parity` | `BCqvsgJ…` | `enable_creator_fee = true`, `creator_fee_on = OnlyToken0` — the creator fee lands on the **input** in one direction and on the **output** in the other |
| `raydium_cpmm_token2022_transfer_fee_parity` | `9eNQLCp…` | A Token-2022 mint with an uncapped **500 bps transfer fee**, charged on the input leg one way and the output leg the other |

Swap amounts are deliberately not round. With a multiple of `1e6 / trade_fee_rate` the fee divides exactly, ceiling and floor agree, and the suite cannot distinguish a correct implementation from one that rounds the wrong way. That is not hypothetical: it is how the first version of this suite passed a mutation it should have caught.

## Does the suite actually test anything?

`./mutation_test.sh` breaks one piece of the math at a time and requires the suite to notice.

```
CAUGHT   3 test(s) fail — reserves read the raw vault balance instead of vault_amount_without_fee
CAUGHT   3 test(s) fail — the trading fee rounds down instead of up
CAUGHT   1 test(s) fail — OnlyToken0 charges the creator fee on the wrong side
CAUGHT   2 test(s) fail — the pool's enable_creator_fee flag is ignored
CAUGHT   1 test(s) fail — the output-side creator fee rounds down instead of up
CAUGHT   1 test(s) fail — the Token-2022 output transfer fee is not deducted

caught 6 of 6
```

The first run of this script caught 4 of 6. Both escapes were gaps in the **tests**, not the implementation: round swap amounts hid the fee rounding, and the only pool in the suite had creator fees disabled and plain SPL mints, so two whole code paths were unexercised. Adding the second and third pools closed them.

## The three things a naive implementation gets wrong

1. **Reserves are not vault balances.** `PoolState::vault_amount_without_fee` subtracts the accrued protocol, fund and creator fee counters. Reading `vault.amount` directly is off by the uncollected fees — on the first test pool that is a 90-unit error on a 0.1 SOL swap, and it grows with the pool's age.
2. **The trading fee rounds up; its carve-outs round down.** `trading_fee` is a ceiling division, while `protocol_fee` and `fund_fee` are floors taken *out of* that fee.
3. **The creator fee changes side with the direction.** `creator_fee_on` and the trade direction decide whether it is charged on the input or the output, and on the input it is split out of one combined ceiling fee rather than computed separately.

## Scope

`quote()` implements `swap_base_input` (ExactIn), which is what the test-kit asserts. `swap_base_output` is not implemented, so `supports_exact_out()` stays false.

`is_active()` gates on status bit 2 and on `open_time`, matching the program.

## Lockfile

`Cargo.lock` is committed and started as a copy of the upstream `jupiter-amm-interface` lockfile. Resolving fresh picks up incompatible `solana-clock` and `wincode` generations and litesvm fails to build; the upstream pins are the working set.
