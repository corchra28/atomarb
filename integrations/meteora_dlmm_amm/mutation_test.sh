#!/usr/bin/env bash
# Does the parity suite actually assert anything?
#
# The bin math comes from `meteora-dlmm`, so these mutations target what this crate owns:
# decoding the LbPair, deriving the bin arrays, ordering them for the direction of travel, and
# refusing to quote past what it carries.
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
if m == 'truncating_array_index':
    # Integer division truncates toward zero, so every negative bin lands in the wrong array.
    # Every SOL/USDC DLMM pool measured sits at a negative active id.
    s = s.replace("""    if bin_id >= 0 {
        bin_id / BINS_PER_ARRAY
    } else {
        -((-bin_id + BINS_PER_ARRAY - 1) / BINS_PER_ARRAY)
    }""", "    bin_id / BINS_PER_ARRAY")
elif m == 'bin_array_seed_big_endian':
    # The PDA seeds the array index as a little-endian i64.
    s = s.replace("&[b\"bin_array\", lb_pair.as_ref(), &index.to_le_bytes()],",
                  "&[b\"bin_array\", lb_pair.as_ref(), &index.to_be_bytes()],")
elif m == 'quote_not_strict':
    # Quote a partial fill instead of refusing: the returned amount is then one no transaction
    # can reproduce, because the swap runs out of bin arrays on chain too.
    s = s.replace("""            // strict: refuse to quote past the bin arrays actually carried, rather than return a
            // partial fill the transaction cannot reproduce.
            true,""", "            false,")
    s = s.replace("""        if !quote.complete {
            return Err(AmmError::from("dlmm quote incomplete"));
        }""", "")
elif m == 'direction_inverted':
    s = s.replace("        let swap_for_y = quote_params.input_mint == self.token_x_mint;",
                  "        let swap_for_y = quote_params.input_mint != self.token_x_mint;")
elif m == 'instruction_arrays_wrong_direction':
    s = s.replace("        let step: i64 = if swap_for_y { -1 } else { 1 };",
                  "        let step: i64 = if swap_for_y { 1 } else { -1 };")
elif m == 'ignore_transfer_fees':
    # Drop the Token-2022 transfer fee by pretending both mints are plain SPL.
    s = s.replace("                    (\n                        parse_mint(account.data(), &owner.to_bytes()).ok(),\n                        is_2022,\n                    )",
                  "                    (\n                        parse_mint(account.data(), &TOKEN_PROGRAM.to_bytes()).ok(),\n                        is_2022,\n                    )")
elif m == 'token_program_always_legacy':
    # Pin both token programs to legacy SPL Token. A Token-2022 pool then gets an instruction
    # the program rejects with InvalidProgramId -- which is exactly why `swap` cannot be used
    # in place of `swap2`.
    s = s.replace("""        let x_program = if self.x_is_token_2022 {
            TOKEN_2022_PROGRAM
        } else {
            TOKEN_PROGRAM
        };""", "        let x_program = TOKEN_PROGRAM;")

elif m == 'active_id_offset_off_by_four':
    # active_id sits at 76; 80 is bin_step.
    s = s.replace("const OFF_ACTIVE_ID: usize = 76;", "const OFF_ACTIVE_ID: usize = 80;")
elif m == 'reserve_offsets_swapped':
    s = s.replace("const OFF_RESERVE_X: usize = 152;\nconst OFF_RESERVE_Y: usize = 184;",
                  "const OFF_RESERVE_X: usize = 184;\nconst OFF_RESERVE_Y: usize = 152;")
elif m == 'bins_per_array_wrong':
    s = s.replace("const BINS_PER_ARRAY: i64 = 70;", "const BINS_PER_ARRAY: i64 = 64;")
if s == before:
    sys.exit(3)
open(p, 'w').write(s)
PY
}

MUTATIONS=(
  "truncating_array_index|array_index_of truncates toward zero instead of flooring (breaks every negative bin)"
  "bin_array_seed_big_endian|the bin-array PDA seeds the index big-endian instead of little-endian"
  "quote_not_strict|quotes a partial fill instead of refusing when the bin arrays run out"
  "direction_inverted|swap direction inverted"
  "instruction_arrays_wrong_direction|the instruction's bin arrays walk the wrong way"
  "ignore_transfer_fees|Token-2022 transfer fees are ignored"
  "token_program_always_legacy|both token programs pinned to legacy SPL Token"
  "active_id_offset_off_by_four|active_id read from offset 80 (bin_step) instead of 76"
  "reserve_offsets_swapped|reserve_x and reserve_y offsets swapped"
  "bins_per_array_wrong|64 bins per array instead of 70"
)

echo "Mutation test: each mutation must make at least one test fail."
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
  # Only a real compilation failure, never 'error: test failed'.
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
