# Connecting the concentrated-liquidity adapters: the decision, before the code

The census in `docs/REAL_WORLD_MEV.md` found that **98 of 104 real winning atomic arbitrages
include a concentrated-liquidity venue**, while the TypeScript engine in `src/` had none. Three
Rust adapters now exist and are proven exact against the chain:

| crate | parity tests | mutations caught |
|---|---|---|
| `integrations/raydium_cpmm_amm/` | 3 tests, 12 swaps | 6 of 6 |
| `integrations/whirlpool_amm/` | 5 tests, 17 swaps + 2 unit | 10 of 10 |
| `integrations/meteora_dlmm_amm/` | 4 tests, 13 swaps + 1 unit | 10 of 10 |

The question is how to get them in front of the gap analysis. Three options were on the table.

## (a) Port Whirlpool and DLMM to TypeScript adapters

The `PoolAdapter` contract in `src/adapters/types.ts` has seven methods, and `quoteExactIn` is
the one that matters. Implementing it means porting the swap math.

**Rejected, and for a reason already established twice.** The Rust adapters deliberately do *not*
reimplement that math: Whirlpool calls `orca_whirlpools_core`, the crate Orca's own SDK quotes
with, and DLMM calls a zero-dependency engine proven against the chain. Porting several hundred
lines of Q64.64 tick-crossing arithmetic and a thousand lines of stateful bin math into
TypeScript would recreate exactly the surface of subtle rounding bugs that using the vendor's
code avoids — and it would have to be proven correct all over again, in a language with no
`u128` and no LiteSVM harness to prove it against.

## (b) Expose the Rust crates to the TypeScript engine

Either compile to WebAssembly, or run a Rust binary as a subprocess with JSON in and out.

**Rejected as premature.** It is real plumbing work whose only output is that an existing
TypeScript loop can call a quote it could otherwise call directly. The engine's TypeScript-side
value — the capital ledger, the accounting reconciliation, shadow mode over WebSockets, the run
reports — matters when *running* a strategy. It does not matter for answering "is there a gap
across these venues", which is a batch measurement.

Worth building later if a live engine is ever justified. The census says it is not:
about $124,000 a day for the whole market, latency-gated, capital saturating near 100 SOL.

## (c) Do the measurement in Rust, against the adapters directly

**Chosen.** A binary that enumerates pools per venue, finds mints quoted on more than one, and
runs the circuit `WSOL -> TOKEN (venue A) -> WSOL (venue B)` through the three adapters.

- The quoting math is already proven exact against the on-chain programs. Nothing new to verify.
- It is the shortest path from "the adapters exist" to "here is the number".
- It measures the thing the census said was missing — concentrated liquidity on at least one leg
  — which is the whole reason the adapters were built.

## What this is expected to show, stated before running it

Setting the expectation in advance so the result cannot be read to taste.

The previous whole-chain radar found 122 pairs with a gap over 100 basis points and **zero net
positive** after fees, price impact and the network fee, across constant-product venues only. The
census then explained why the engine was looking in the wrong place: the winners use
concentrated liquidity.

So a fair prediction is that **candidates will appear that the old adapter set could not see** —
routes pairing a Whirlpool or a DLMM against a constant-product pool. Whether any is net
positive at a size worth taking is a separate question, and the census already constrains the
answer: the median winning trade takes home $0.0026, the largest capital deployed in a winning
trade anywhere in the sample was $1,538 (later remeasured at $34,126, with saturation at ~100 SOL — see CAPITAL_AND_TARGETS.md §3), and 101 of 104 winners paid for block position.

**A better adapter set does not make the market enterable.** If the measurement produces positive
gross candidates, that is a correction to the engine's coverage, not a reversal of
`NO_VERIFIED_EDGE` — which was, and remains, a statement about what this setup can capture, at a
four-second poll on a shared endpoint, against people running co-located nodes.

The honest outcome to look for is which of these three the data supports:

1. **No positive candidates even with concentrated liquidity.** The verdict stands unchanged and
   is now stronger, because the coverage objection is answered.
2. **Positive gross candidates appear, all below the fee and tip a real attempt would pay.**
   The verdict stands, and the reason becomes the auction rather than the coverage.
3. **Positive net candidates appear at a size worth taking.** Then the verdict needs revisiting,
   and the next question is latency, not arithmetic.
