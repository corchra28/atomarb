# TEST_REPORT (generated 2026-09-17T18:25:45.003Z)

vitest exit code: 0; total=237 passed=235 failed=0 skipped=2

| category | files | pass | fail | skipped |
|---|---|---|---|---|
| local_real_program_integration | 4 | 36 | 0 | 0 |
| network | 1 | 0 | 0 | 1 |
| unit | 21 | 199 | 0 | 1 |

mainnet_simulation tests: none in the suite (mainnet simulations are produced by the simulate/shadow commands and recorded in reports/runs; they are not unit tests).

## Rust (programs/arb_executor, cargo test)

```
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 4 tests
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
running 4 tests
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
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