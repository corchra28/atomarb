# Flash loans — economic feasibility (research only; nothing implemented)

Source of every fact below: `docs/sources/flash_loans_prior_art.md` (program source at pinned commits). No RPC was used, so every live value (the configured fee of a specific reserve, available WSOL liquidity) is **TODO (RPC)**.

## Mechanism on Solana
There is no callback flash loan. All three live designs are **instruction brackets** inside one transaction: a top-level borrow (or "start") instruction, the swaps in between, and a top-level repay (or "end") instruction. Each program reads the Instructions sysvar and refuses to run under CPI (`FlashBorrowCpi` / `NotAllowedInCPI`). Consequence for this project: our circuit would become `[compute budget] [flash_borrow] [executor ExecuteCircuit] [flash_repay]`, and the executor's own CPI legs stay untouched — but the borrow/repay instructions themselves may **not** be issued by our program.

| Provider | Program | Borrow / repay | Fee rule | Live fee for WSOL |
|---|---|---|---|---|
| Kamino Lend | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` | `flash_borrow_reserve_liquidity(amount)` / `flash_repay_reserve_liquidity(amount, borrow_ix_index)` | `fee = round(max(amount × flash_loan_fee_sf, 1))`, exclusive; `u64::MAX` disables | TODO (RPC) |
| Solend / Save | `So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo` | tags 19 / 20 (tag 13 deprecated) | `total = round(max(amount × flash_loan_fee_wad/1e18, min))`, split into host + origination | TODO (RPC); the 0.3 % in the source comment is an Aave example, not the configured value |
| marginfi v2 | `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` | `lending_account_start_flashloan(end_index)` / `lending_account_end_flashloan()` | No flash fee; the in-bracket borrow pays the bank's `protocol_origination_fee` | TODO (RPC) |

Additional costs and constraints for our circuit, all verified in source: the borrow and repay must both be top-level (two extra instructions, more accounts, more transaction bytes — our PumpSwap circuits already need an address lookup table at 1,262–1,684 bytes); Kamino and Solend require the repay to mirror the borrow account-for-account; marginfi additionally requires an existing `MarginfiAccount` in a group and wraps ordinary borrow/withdraw instructions that each need bank, vault and oracle accounts; Solend's flash instructions are SPL-Token only (no Token-2022).

## Verdict for this project
`FLASH_LOAN_REQUIRED` is the correct label for any size above own capital, and such sizes must **not** be counted as accessible opportunities until the whole bracket is built and simulated. That work is not justified yet: on the population measured here the circuits are negative at every size (`reports/route_gaps_*.md`), so borrowing more capital only multiplies a negative edge. The economics are simple and must hold before any implementation:

```
net = gross_edge(size) − dex_fees(size) − flash_premium(size) − network_fee − priority_fee − tip − rent
```
with `gross_edge − dex_fees` measured by this engine per size. A flash loan changes only the `flash_premium` term and the transaction-size budget; it never creates edge.

Next step if the edge ever turns positive at a size above own capital: read the WSOL reserve of one provider (Kamino is the least intrusive: no account to open) and record `flash_loan_fee_sf`, available liquidity and the Token-2022 whitelist state; then build the bracket and simulate it locally with the real klend ELF before anything else.
