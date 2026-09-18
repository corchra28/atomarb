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
    s = s.replace("                if let Some(facade) = decode_tick_array(account.data(), *start) {\n                    self.tick_array_facades.push(facade);",
                  "                if decode_tick_array(account.data(), *start).is_some() {\n                    self.tick_array_facades.push(empty_tick_array(*start));")
elif m == 'arrays_wrong_direction':
    # Walk the arrays the wrong way for the trade direction.
    s = s.replace("        let step = if a_to_b { -ticks_in_array } else { ticks_in_array };\n        let mut usable",
                  "        let step = if a_to_b { ticks_in_array } else { -ticks_in_array };\n        let mut usable")
elif m == 'tick_offset_off_by_four':
    # Forget that start_tick_index sits between the discriminator and the ticks.
    s = s.replace("        let o = 12 + i * TICK_LEN;", "        let o = 8 + i * TICK_LEN;")
elif m == 'dynamic_tick_fixed_stride':
    # Treat the dynamic array's ticks as fixed-width: they are 1 byte when uninitialised and
    # 113 when not, so a fixed stride desynchronises after the first initialised tick.
    s = s.replace("        cursor += DYNAMIC_TICK_DATA_LEN;", "        cursor += DYNAMIC_TICK_DATA_LEN - 1;")
elif m == 'dynamic_array_ignored':
    # Only understand the fixed shape, so every pool on the newer dynamic arrays quotes blind.
    s = s.replace("    if data.len() >= DYNAMIC_TICK_ARRAY_MIN_LEN && data[..8] == DYNAMIC_TICK_ARRAY_DISCRIMINATOR {\n        return decode_dynamic_tick_array(data);\n    }", "")

elif m == 'liquidity_net_sign_dropped':
    # liquidity_net is signed: crossing a position's upper bound removes liquidity. Dropping the
    # sign makes every crossing add. (Note `u128 as i128` would NOT model this — in Rust that is
    # a bit-for-bit reinterpretation and changes nothing; the first version of this mutation was
    # a no-op and wrongly looked like a gap in the tests.)
    s = s.replace("        tick.liquidity_net = read_i128(data, o + 1);",
                  "        tick.liquidity_net = read_i128(data, o + 1).abs();")
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
    s = s.replace("        for i in 0..3 {\n            let start = current + i * step;", "        for i in 0..1 {\n            let start = current + i * step;")
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
  "dynamic_tick_fixed_stride|dynamic ticks walked with a fixed stride instead of a variable one"
  "dynamic_array_ignored|the newer DynamicTickArray shape is not decoded at all"
  "liquidity_net_sign_dropped|liquidity_net sign dropped, so every crossing adds liquidity"
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
  out=$(cargo test 2>&1)
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
echo "suite green after restore:"
cargo test 2>&1 | grep -E 'test result:' | sed 's/^/  /' 

[ "$caught" -eq "$total" ] || exit 1
