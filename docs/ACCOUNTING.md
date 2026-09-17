# ACCOUNTING

Three PnL classes (src/accounting/pnl.ts), each with explicit cost provenance (`INCLUDED_IN_QUOTE` / `ESTIMATED` / `OBSERVED`):

1. **Trading PnL** = WSOL out of leg B (to the user, after all DEX fees, creator fees and Token-2022 transfer fees, each applied exactly once inside the quotes) minus WSOL into leg A. Leg B input is exactly leg A output; pre-existing token inventory is never sold.
2. **Transaction PnL** = trading PnL minus external costs not inside quotes: base fee (5000 lamports x signatures), prioritization fee = ceil(cu_limit x cu_price / 1e6) — or `getFeeForMessage` of the final message which already includes both (never both counted), Jito tip (0 by default), flash-loan premium (none), non-recoverable rent. ATA rent is **locked capital**, not a cost, unless the account is never closed; PumpSwap's `user_volume_accumulator` rent (~1.84M lamports on first buy per user) is measured in the local probe as observed lamports spent.
3. **Operating PnL** = transaction PnL minus infrastructure allocated to the period and the cost of failed attempts (count x base fee).

Slippage tolerance is an execution limit (minimum_amount_out), not a cost. Impact inside the quote (curve) is separated from later adverse movement (unknown before live) and from the conservative uncertainty budget (config `minNetProfitLamports`).

Status rules: zero probes => `NOT_TESTED`; missing data => `INCOMPLETE`, never a PnL of zero; local real-program probes report `ACCOUNTING_INCOMPLETE` unless execution succeeded and every delta was measured. `REALIZED_NET_PNL = NOT_OBSERVED` in this lot.
