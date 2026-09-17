#!/usr/bin/env bash
# Builds programs/arb_executor with cargo-build-sbf and copies the ELF + provenance sidecar to tests/fixtures/programs/.
# Re-runnable. Never deploys. Owned by agent rust_executor.
# Usage: bash scripts/build_executor.sh            # default SBPF arch of the installed cargo-build-sbf
#        ARCH=v3 bash scripts/build_executor.sh    # pass --arch v3 (etc.)
#        SKIP_HOST_TESTS=1 ...                     # skip `cargo test` on the host
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/programs/arb_executor"
OUT_DIR="$ROOT/tests/fixtures/programs"
SO="$CRATE/target/deploy/arb_executor.so"
log() { printf '[build_executor %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

command -v cargo-build-sbf >/dev/null 2>&1 || { log "cargo-build-sbf not found; run scripts/install_toolchain.sh first"; exit 2; }
cd "$CRATE"
T0=$(date +%s)
if [ "${SKIP_HOST_TESTS:-0}" != 1 ]; then
  log "host unit tests (cargo test)"
  cargo test --quiet 2>&1 | grep -E "test result|error|FAILED|panicked" || true
fi
log "cargo build-sbf ${ARCH:+--arch $ARCH}"
# shellcheck disable=SC2086
cargo build-sbf ${ARCH:+--arch "$ARCH"} 2>&1 | grep -vE '^\s*(Compiling|Checking|Downloading|Downloaded)' || true
[ -f "$SO" ] || { log "build produced no $SO"; exit 1; }
mkdir -p "$OUT_DIR"
cp "$SO" "$OUT_DIR/arb_executor.so"
# provenance sidecar
SO_SHA=$(sha256sum "$OUT_DIR/arb_executor.so" | cut -d' ' -f1)
SRC_HASH=$(for f in $(ls "$CRATE"/src/*.rs | LC_ALL=C sort); do cat "$f"; done | sha256sum | cut -d' ' -f1)
SRC_FILES=$(ls "$CRATE"/src/*.rs | LC_ALL=C sort | xargs -n1 basename | paste -sd, -)
BYTES=$(stat -c %s "$OUT_DIR/arb_executor.so")
HOST_RUSTC=$(rustc --version)
CBS=$(cargo-build-sbf --version 2>&1 | tr '\n' ';' | sed 's/;$//')
PT_DIR=$(ls -d "$HOME"/.cache/solana/*/platform-tools 2>/dev/null | tail -1 || true)
PT_RUSTC=$([ -n "$PT_DIR" ] && "$PT_DIR/rust/bin/rustc" --version 2>/dev/null || echo unknown)
SOLANA_PROGRAM_VER=$(grep -A1 '^name = "solana-program"$' "$CRATE/Cargo.lock" | grep version | sed 's/.*"\(.*\)".*/\1/')
python3 - "$OUT_DIR/arb_executor.json" "$SO_SHA" "$BYTES" "$HOST_RUSTC" "$CBS" "$PT_RUSTC" "$SRC_HASH" "$SRC_FILES" "${ARCH:-default(v0)}" "$SOLANA_PROGRAM_VER" <<'PY'
import json, sys, datetime
out, sha, size, host_rustc, cbs, pt_rustc, src_hash, src_files, arch, spv = sys.argv[1:]
json.dump({
  "program": "arb_executor",
  "note": "LOCAL-ONLY research program; loaded into LiteSVM by tests/integration/executor_*.test.ts; never deployed.",
  "sha256": sha,
  "bytes": int(size),
  "built_at_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "rustc_host": host_rustc,
  "rustc_platform_tools": pt_rustc,
  "cargo_build_sbf": cbs,
  "sbpf_arch_flag": arch,
  "solana_program_crate": spv,
  "source_hash_sha256": src_hash,
  "source_hash_method": "sha256 of the concatenation of programs/arb_executor/src/*.rs sorted with LC_ALL=C (files: " + src_files + ")",
}, open(out, "w"), indent=1)
PY
log "wrote $OUT_DIR/arb_executor.so ($BYTES bytes, sha256 $SO_SHA) and arb_executor.json; elapsed $(( $(date +%s) - T0 ))s"
