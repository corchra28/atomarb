#!/usr/bin/env bash
# Does the parity suite actually assert anything?
#
# Breaks one piece of the swap math at a time and checks the suite notices. A parity test that
# passes under a mutation is not testing that behaviour, whatever its name says.
#
#   ./mutation_test.sh
#
# Requires the fixtures to exist already (run `RPC=<url> cargo test` once first).
set -uo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"

BACKUP=$(mktemp)
cp src/lib.rs "$BACKUP"
restore() { cp "$BACKUP" src/lib.rs; }
trap restore EXIT

mutate() {
  python3 - "$1" <<'PY'
import sys
m = sys.argv[1]
p = 'src/lib.rs'
s = open(p).read()
before = s
if m == 'raw_vault_balance':
    s = s.replace("""        let r0 = self
            .vault_0_amount
            .checked_sub(self.accrued_fees_0)
            .ok_or_else(|| AmmError::from("vault 0 cannot cover its accrued fees"))?;
        let r1 = self
            .vault_1_amount
            .checked_sub(self.accrued_fees_1)
            .ok_or_else(|| AmmError::from("vault 1 cannot cover its accrued fees"))?;""",
"""        let r0 = self.vault_0_amount;
        let r1 = self.vault_1_amount;""")
elif m == 'floor_trade_fee':
    s = s.replace("        let total_fee = fee_ceil_div(input_amount, r.trade + r.creator, FEE_RATE_DENOMINATOR)?;",
                  "        let total_fee = fee_floor_div(input_amount, r.trade + r.creator, FEE_RATE_DENOMINATOR)?;")
    s = s.replace("        trade_fee = fee_ceil_div(input_amount, r.trade, FEE_RATE_DENOMINATOR)?;",
                  "        trade_fee = fee_floor_div(input_amount, r.trade, FEE_RATE_DENOMINATOR)?;")
elif m == 'creator_fee_wrong_side':
    s = s.replace("            1 => Ok(zero_for_one),   // OnlyToken0",
                  "            1 => Ok(!zero_for_one),  // MUTATED")
elif m == 'ignore_enable_creator_fee':
    s = s.replace("""        let creator_fee_rate = if self.enable_creator_fee {
            self.config_creator_fee_rate as u128
        } else {
            0
        };""", "        let creator_fee_rate = self.config_creator_fee_rate as u128;")
elif m == 'floor_creator_fee_on_output':
    s = s.replace("        creator_fee = fee_ceil_div(output_swapped, r.creator, FEE_RATE_DENOMINATOR)?;",
                  "        creator_fee = fee_floor_div(output_swapped, r.creator, FEE_RATE_DENOMINATOR)?;")
elif m == 'skip_output_transfer_fee':
    s = s.replace("        let transfer_fee_out = mint_out.transfer_fee(epoch, amount_out)?;",
                  "        let transfer_fee_out = 0u64;")
if s == before:
    sys.exit(3)
open(p, 'w').write(s)
PY
}

MUTATIONS=(
  "raw_vault_balance|reserves read the raw vault balance instead of vault_amount_without_fee"
  "floor_trade_fee|the trading fee rounds down instead of up"
  "creator_fee_wrong_side|OnlyToken0 charges the creator fee on the wrong side"
  "ignore_enable_creator_fee|the pool's enable_creator_fee flag is ignored"
  "floor_creator_fee_on_output|the output-side creator fee rounds down instead of up"
  "skip_output_transfer_fee|the Token-2022 output transfer fee is not deducted"
)

echo "Mutation test: each mutation must make at least one parity test fail."
echo

caught=0
total=0
for entry in "${MUTATIONS[@]}"; do
  name="${entry%%|*}"
  desc="${entry#*|}"
  restore
  if ! mutate "$name"; then
    echo "  SKIP  $name — pattern not found (the source moved; update this script)"
    continue
  fi
  total=$((total + 1))
  failures=$(cargo test 2>&1 | grep -cE '^test .* \.\.\. FAILED')
  if [ "$failures" -gt 0 ]; then
    echo "  CAUGHT   $failures test(s) fail — $desc"
    caught=$((caught + 1))
  else
    echo "  ESCAPED  no test fails — $desc"
  fi
done

restore
echo
echo "caught $caught of $total"
echo -n "suite green after restore: "
cargo test 2>&1 | grep -E 'test result: ok\. [1-9]' | head -1

[ "$caught" -eq "$total" ] || exit 1
