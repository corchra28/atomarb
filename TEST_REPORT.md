# TEST_REPORT (generated 2026-09-18T08:09:24.332Z)

vitest exit code: 0; total=293 passed=291 failed=0 skipped=2

| category | files | pass | fail | skipped |
|---|---|---|---|---|
| local_real_program_integration | 4 | 46 | 0 | 0 |
| network | 1 | 0 | 0 | 1 |
| unit | 26 | 245 | 0 | 1 |

mainnet_simulation tests: none in the suite (mainnet simulations are produced by the simulate/shadow commands and recorded in reports/runs; they are not unit tests).

## Rust (programs/arb_executor, cargo test)

```
cargo test (host): 23 passed, 0 failed
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 4 tests
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 5 tests
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 9 tests
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 4 tests
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

## Failures

none

Legend: unit = pure logic with mocks/fixtures; fixture = byte-exact decoding of real on-chain accounts saved with provenance; local_real_program_integration = real program ELFs executed in LiteSVM with synthetic labelled balances; network = live RPC/API tests (skipped unless ATOMARB_NETWORK_TESTS=1). Zero probes in a category means NOT_TESTED, not PASS.
## Rust adapters and the cross-venue scan (2026-09-19)

Verified from a clean clone with **no RPC**: the fixtures are committed, so nothing here depends
on network access or on a particular machine.

| crate | tests | parity swaps | mutations |
|---|---:|---:|---:|
| `raydium_cpmm_amm` | 3 | 12 | 6 of 6 caught |
| `whirlpool_amm` | 7 (5 parity + 2 unit) | 17 | 10 of 10 caught |
| `meteora_dlmm_amm` | 5 (4 parity + 1 unit) | 13 | 10 of 10 caught |
| `gap_scan` | 2 regression | — | — |
| **total** | **17** | **42** | **26 of 26** |

Parity means the strongest check available without spending money: the harness snapshots a live
mainnet pool, runs the adapter's `quote()`, executes the program's own swap instruction in
LiteSVM against the real program binary, and requires the realized token delta to equal the quote
**exactly**. Not within a tolerance.

The mutation suites exist because a passing test proves nothing on its own. Each breaks one piece
of the math — a rounding direction, a byte offset, a tick or bin index, a token-program id — and
requires at least one test to fail. Three mutations were written and then **removed** rather than
left reporting a false gap, each after checking that it could not change behaviour at all:

- reading `liquidity_net` as `u128` and casting to `i128` is a bit-for-bit reinterpretation in
  Rust, so it was a no-op;
- zeroing the DLMM mint decimals changes nothing, because they appear only in the engine's
  decoder and never in its quote, fee or math code;
- traversing a non-existent Whirlpool tick array is unobservable on every pool in that suite,
  because a swap that reaches one also fails for want of liquidity.

### The regression test worth knowing about

`gap_scan/tests/verify_suspicious.rs` pins a finding rather than a behaviour. The first
cross-venue scan reported a **371% return**. Each leg was run against the real program and every
one failed with SPL Token error 17, `Account is frozen`. The guard that rejects pools holding a
frozen token account removed 24 circuits and took the net-positive count from 7 to 0. The three
pools' snapshots are vendored so the test runs standalone.

### TypeScript engine

Unchanged: **291 passed, 2 skipped**, across 29 files, plus 9 of 9 fault injections caught.
