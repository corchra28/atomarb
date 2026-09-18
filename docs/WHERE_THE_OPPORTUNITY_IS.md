# Where the opportunity actually is

Three audits in this repository established that atomic arbitrage is real, small, latency-gated and not enterable. The follow-up question was the right one: then where *is* the opportunity? This is the answer, researched rather than guessed, with sources.

**The short version.** Jupiter publishes the exact verification architecture this repository independently reinvented. Building that verification for a DEX is paid, recurring, capital-free work, and the population of venues needing it churns constantly. That is the opening. The bug-bounty path pays far less than its headlines. The freelance market pays real but geographically discounted rates. Capital strategies are arithmetically irrelevant at this scale.

---

## 1. The find: Jupiter's integration harness is what this repo already is

`github.com/jup-ag/jupiter-amm-interface` is public, actively pushed (2026-08-28), and its README states the DEX integration path in two steps:

> `interface/` — `jupiter-amm-interface` — the `Amm` trait a DEX implements to be routed by Jupiter.
> `test-kit/` — `jupiter-amm-test-kit` — a harness to verify an SDK's `Amm::quote()` matches the on-chain program (snapshot a pool, run the quote, execute the native swap in LiteSVM, assert parity) before handing the SDK to Jupiter.

The test-kit README then describes its method:

> 1. Load a `PoolSnapshot` (accounts dumped from a live pool).
> 2. Run the SDK's pure `Amm::quote`.
> 3. Execute the AMM program's swap instruction in LiteSVM.
> 4. Assert the realized on-chain token delta equals the quote exactly.

**That is precisely what `tests/integration/*_local_program.test.ts` in this repository does**, built from scratch, in TypeScript, without knowing this existed. The correspondence goes down to the details that are easy to get wrong:

| Jupiter's harness | What this repo built independently |
|---|---|
| "the AMM's program loads from `tests/fixtures/<label>.so`" | mainnet program ELFs dumped and loaded into LiteSVM |
| "anything it CPIs into comes from `Amm::program_dependencies()` as `(program_id, name)` pairs" | `PROGRAM_DEPENDENCIES` / `withDependencies`, added after the PumpSwap fee-program CPI failed to load |
| "an `encoder` closure that encodes the program's native swap instruction data (discriminator + args)" | discriminators reverse-engineered: `swap_base_input` `8fbe5adac41e33de`, `buy_exact_quote_in` `c62e1552b4d9e870`, `sell` `33e685a4017f83ad` |
| "assert the realized on-chain token delta equals the quote exactly" | exact-match assertions, three adapters, passing |

The skill this repository demonstrates is not "can write an arbitrage bot". It is **"can make a quote provably equal what the chain does, for an AMM nobody has documented"**. Jupiter has published that this specific capability is the gate for DEX integration.

### The demand is measurable, and this repo measured it

From the census in `docs/REAL_WORLD_MEV.md` and the routing data in `docs/sources/dexcex/dex_side.json`, Jupiter routed through **21 distinct venues** in one sample:

```
AlphaQ, BisonFi, Deriverse, GoonFi V2, HumidiFi, JupLend AMM, Manifest,
Meteora DAMM v2, Meteora DLMM, PancakeSwap, Pump.fun Amm, Quantum, Quay,
Raydium, Raydium CLMM, Riptide, Scorch, SolFi V2, TesseraV, Whirlpool, ZeroFi
```

Most of those are proprietary market-maker venues that did not exist long ago. Every one had to be integrated by somebody who could do exactly this work, and the list keeps growing. This is not a speculative market; it is the observed composition of live order flow.

### The barrier to the alternative just went up, which helps

`jup-ag/jupiter-swap-api` has been renamed to `jup-ag/metis-binary`. Self-hosting the router now requires a Binary Key gated on **10,000 JUP staked**, under a licence that forbids sublicensing, benchmarking and open-source terms. Jupiter routing is more centralised than it was, which makes being *inside* it more valuable.

**Caveat, stated honestly:** `solanatracker/raptor-binary` is a free, unkeyed, self-hosted alternative router covering 20+ venues including Raydium AMM/CLMM/CPMM, Meteora DLMM/DAMM v2, Orca Whirlpool, PumpSwap, HumidiFi, Tessera and SolFi. Its existence is why **selling a quote engine as a product is a bad idea** — the commodity version is free. Selling the *integration work* is a different business, and Raptor needs the same decoders.

---

## 2. What the freelance market actually pays

Lemon.io embeds a machine-readable rate table per skill page. Solana pool, USD per hour:

| Seniority | Solana | Rust | All-skills baseline |
|---|---:|---:|---:|
| Middle (3–4 yr) | $39 | $37 | $34 |
| Senior (5–7 yr) | $54 | $48 | $44 |
| Strong Senior (8+) | $67 | $52 | $54 |

**Solana pays 13% more than Rust and 23% more than the baseline, and the Solana bench is 182 developers against 592 for Rust.** Scarcity is priced, and it is priced in the right direction.

By country, Solana senior: Austria $68, Canada $66, Singapore $63, Australia $60, France $59, Germany $55, Portugal/Spain/Bulgaria $53, **Romania $50**, Poland $50, Brazil $49, Mexico $45, Ukraine $35.

Two things follow. Romania sits at the top of the cheaper tier, roughly 26% below Austria and 32% below the US on the comparable blockchain table. And on that platform's Solana page, **only four locations are currently enabled for sourcing: all-locations, Canada, Romania and the United States.** If that reflects real availability rather than stale data, Romania is a structurally advantaged supply location for Solana work.

**What to avoid.** The Fiverr Solana market is 57% memecoin launch, marketing and mint work, median gig floor $100. It is a separate market from protocol engineering and it is not a ladder into it.

**Full-time comparison:** senior Solana engineer averages $102,246 (10th percentile $30k, 90th $180k). Disclosed listings run $70k–$350k. Europe averages $71k against North America's $145k on the aggregate boards. Note that freelance at $50/hr fully utilised is roughly $100k, so the marketplaces pay **no risk premium for contract work** — utilisation is the whole difference.

---

## 3. The bounty path, and why its headlines lie

Immunefi advertises ceilings of $3M (Ethena), $5M (GMX), $10M (Sky/MakerDAO). Immunefi's own research post gives the figure that matters:

> "Immunefi bug bounty programs have paid out $107.3 million in awards for confirmed critical vulnerabilities alone. **The median payout for a critical is $20,000.**"

Mean critical is $114,355, skewed by a handful of outliers. That is a winner-take-most distribution, the same shape that made the arbitrage market unenterable.

Worse for an analytically-minded entrant, **the economic and design findings are largely zoned out of scope**:

- GMX excludes "cases involving price manipulation on exchanges" and "exploits due to delays or sizes of price feed updates" — nearly the entire class a quant would find.
- Sherlock: "Design decisions are not valid issues. Even if the design is suboptimal, but doesn't imply any loss of funds, these issues are considered informational."
- Code4rena is the friendliest, allowing findings that "leak value with a hypothetical attack path with stated assumptions" — but caps them at Medium.
- A runnable proof of concept is mandatory everywhere. A model is not a submission.

Documented economic-class payouts cluster at **$5,000 to $65,000**, not seven figures.

**Where that money actually is: risk-service contracts.** Gauntlet takes $2.3M a year from Compound for interest-rate-curve and liquidation-parameter work, with an insolvency clawback on 30% paid in COMP. Chaos Labs ran Aave at $3M a year, was offered $5M, held out for $8M and walked — leaving a vacancy at the top of that market. Arbitrum runs a standing elected Risk seat at 205,000–600,000 USDC. Compound has a grant domain literally named "Risk Parameter Update Research" with $300k behind an allocator.

The realistic entry rung is documented too: Chainrisk was funded **$25,000** via Questbook for an economic risk simulation engine for Compound v3, self-costed at 525 hours at **$40 per hour**.

**Solana-specific contests do exist.** Code4rena currently lists Solana Foundation Token22 at $203,500. Cantina has paid out $54.8M total; its top researcher has earned $932,505 lifetime.

---

## 4. The arithmetic that rules out the capital path

What a few hundred euros a month compounds into, against what an hour of this skill sells for:

| Capital after | at 30%/yr |
|---|---:|
| 1 year (€3,600) | €90/month |
| 3 years (€10,800) | €270/month |
| 5 years (€18,000) | €450/month |

And 30% a year is not available; this repository rejected three strategies that claimed it. For €300 a month of savings to throw off €1,000 a month, you need 111% a year on €10,800. One twenty-hour contract at €50 an hour is €1,000.

**Yield applies to capital. This profile is rich in skill and poor in capital.** Every strategy tested in this repository — funding carry, two-venue inventory, co-located arbitrage — is a way to convert capital into income. None of them is reachable, and none of them would matter at this scale even if it worked.

---

## 5. What I could not verify

- **Upwork returned nothing.** Every route was Cloudflare-blocked, including the RSS feed. No contractor rates, no posted budgets, no job mix. This was a priority target and it failed; it needs a residential-IP browser session.
- **No per-finding payout data** on any contest platform. Only pool totals and lifetime leaderboards, so "what one accepted Medium is worth" is unknown.
- **No published rate** for Cantina/Spearbit or Zenith researcher work; both are quote-only.
- **Arc.dev's Solana page redirects to Solidity** (336 mentions of Solidity, 2 of Solana). Its "$75–95/hour for Eastern Europe" figure is Ethereum marketing copy and should be ignored.
- Several agents were killed mid-research by an API session limit, so the audit-contest payout distribution is thinner than intended. Raw captures are preserved.

---

## 6. The ranked answer

1. **Jupiter/Raptor DEX integration work.** Highest match to demonstrated skill, no capital, recurring demand from a churning venue population, and this repository is already the portfolio piece. The entry move is to implement the `Amm` trait for one venue and pass the parity harness, which is a port of work already done here.
2. **Solana contract engineering at $50–67/hour**, where Romania is one of very few enabled sourcing locations and Solana carries a measured scarcity premium over Rust.
3. **Risk and economic analysis published openly**, aiming at the service-provider market where Gauntlet bills $2.3M and Aave has an unfilled seat. Slow, but the documented path is public analysis first, funded seat second, and the audits in this repository are already that kind of analysis.
4. **Audit contests**, as skill-building with occasional payment, not as income. Median critical $20,000, design findings mostly out of scope, distribution winner-take-most.
5. **Not capital strategies.** The arithmetic in §4 closes this permanently at this scale.
