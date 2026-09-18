#!/usr/bin/env bash
# Does the parity suite actually assert anything?
#
# The swap math itself comes from orca_whirlpools_core, so the mutations here target what this
# crate actually owns: decoding the accounts, deriving the tick arrays, and ordering them for the
# direction of travel. Those are exactly the places an integration goes wrong.
#
#   ./mutation_test.sh
#
# Requires the fixtures to exist (run `RPC=<url> cargo test` once first).
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
if m == 'truncating_array_start':
    # The classic: integer division truncates toward zero, so every negative tick lands in the
    # wrong array. Every SOL/USDC pool sits at a negative tick.
    s = s.replace("""    let mut start = tick_index / ticks_in_array;
    if tick_index < 0 && tick_index % ticks_in_array != 0 {
        start -= 1;
    }
    start * ticks_in_array""",
"""    (tick_index / ticks_in_array) * ticks_in_array""")
elif m == 'no_tick_liquidity':
    # Pretend every tick array is empty: liquidity never changes at a boundary.
    s = s.replace("                Some(account) => decode_tick_array(account.data(), *start),",
                  "                Some(_account) => empty_tick_array(*start),")
elif m == 'arrays_wrong_direction':
    # Walk the arrays the wrong way for the trade direction.
    s = s.replace("        let step = if a_to_b { -ticks_in_array } else { ticks_in_array };\n        let pick",
                  "        let step = if a_to_b { ticks_in_array } else { -ticks_in_array };\n        let pick")
elif m == 'tick_offset_off_by_four':
    # Forget that start_tick_index sits between the discriminator and the ticks.
    s = s.replace("        let o = 12 + i * TICK_LEN;", "        let o = 8 + i * TICK_LEN;")
elif m == 'liquidity_net_unsigned':
    # liquidity_net is signed: crossing a tick downward removes liquidity. Reading it as
    # unsigned makes every crossing add.
    s = s.replace("        tick.liquidity_net = read_i128(data, o + 1);",
                  "        tick.liquidity_net = read_u128(data, o + 1) as i128;")
elif m == 'ignore_transfer_fee':
    s = s.replace("        self.transfer_fee_a = fee_of(&self.token_mint_a);\n        self.transfer_fee_b = fee_of(&self.token_mint_b);",
                  "        self.transfer_fee_a = None;\n        self.transfer_fee_b = None;")
elif m == 'fee_rate_wrong_offset':
    # fee_rate sits at 45, right after the 2-byte fee_tier_index_seed. Reading 43 picks up the
    # seed instead and quotes with the wrong fee.
    s = s.replace("            fee_rate: read_u16(d, 45),", "            fee_rate: read_u16(d, 43),")
elif m == 'one_tick_array_only':
    # Supply a single array instead of the three the instruction carries: any swap that reaches
    # a boundary then quotes short.
    s = s.replace("        let arrays = TickArrays::Three(pick(0), pick(1), pick(2));",
                  "        let arrays = TickArrays::One(pick(0));")
if s == before:
    sys.exit(3)
open(p, 'w').write(s)
PY
}

MUTATIONS=(
  "truncating_array_start|array_start_tick truncates toward zero instead of flooring (breaks every negative tick)"
  "no_tick_liquidity|tick arrays are treated as empty, so liquidity never changes at a boundary"
  "arrays_wrong_direction|tick arrays are walked the wrong way for the trade direction"
  "tick_offset_off_by_four|tick decoding forgets the 4-byte start_tick_index before the ticks"
  "liquidity_net_unsigned|liquidity_net read as unsigned, so crossings always add liquidity"
  "ignore_transfer_fee|Token-2022 transfer fees are ignored"
  "fee_rate_wrong_offset|fee_rate read from offset 43 (the fee tier seed) instead of 45"
  "one_tick_array_only|only one tick array supplied instead of the three the instruction carries"
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
    echo "  SKIP     $name — pattern not found (the source moved; update this script)"
    continue
  fi
  total=$((total + 1))
  out=$(cargo test --test whirlpool 2>&1)
  if echo "$out" | grep -qE 'error\[E[0-9]+\]|could not compile'; then
    echo "  CAUGHT   does not compile — $desc"
    caught=$((caught + 1))
    continue
  fi
  failures=$(echo "$out" | grep -cE '^test .* \.\.\. FAILED')
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
cargo test --test whirlpool 2>&1 | grep -E 'test result: ok\. [1-9]' | head -1

[ "$caught" -eq "$total" ] || exit 1
