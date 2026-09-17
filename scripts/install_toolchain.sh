#!/usr/bin/env bash
# Idempotent toolchain installer for programs/arb_executor (owned by agent rust_executor).
# Installs (user-level, standard locations, NO shell rc edits):
#   1. rustup + stable Rust (minimal profile)        -> ~/.cargo, ~/.rustup
#   2. Agave (Solana) CLI via the official installer -> ~/.local/share/solana/install/active_release
#      (provides cargo-build-sbf, solana, solana-test-validator, platform-tools on first build-sbf)
# Never configures a keypair, never deploys, never starts a validator.
# Usage: bash scripts/install_toolchain.sh            (prints versions at the end)
#        AGAVE_CHANNEL=stable bash scripts/install_toolchain.sh   (default: stable)
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
AGAVE_CHANNEL="${AGAVE_CHANNEL:-stable}"
T0=$(date +%s)
log() { printf '[install_toolchain %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

retry3() { # retry3 <description> <cmd...>
  local desc="$1"; shift
  local n=1
  while true; do
    if "$@"; then return 0; fi
    if [ "$n" -ge 3 ]; then log "FAILED after 3 attempts: $desc"; return 1; fi
    log "attempt $n failed: $desc -- retrying in $((n*5))s"; sleep $((n*5)); n=$((n+1))
  done
}

# ---- 1. rustup / cargo -------------------------------------------------------
if command -v cargo >/dev/null 2>&1 && command -v rustup >/dev/null 2>&1; then
  log "cargo present: $(cargo --version)"
else
  log "installing rustup (minimal profile, stable) from https://sh.rustup.rs"
  install_rustup() { curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$HOME/.rustup-init.sh" && sh "$HOME/.rustup-init.sh" -y --profile minimal --default-toolchain stable --no-modify-path; }
  retry3 "rustup install" install_rustup || { log "rustup install failed"; RUSTUP_FAILED=1; }
  rm -f "$HOME/.rustup-init.sh"
fi

# ---- 2. Agave CLI (cargo-build-sbf, solana, solana-test-validator) ----------
if command -v cargo-build-sbf >/dev/null 2>&1; then
  log "cargo-build-sbf present: $(cargo-build-sbf --version 2>&1 | head -1)"
else
  log "installing Agave CLI channel=$AGAVE_CHANNEL from https://release.anza.xyz/$AGAVE_CHANNEL/install"
  install_agave() { curl -sSfL "https://release.anza.xyz/$AGAVE_CHANNEL/install" -o "$HOME/.agave-install.sh" && sh "$HOME/.agave-install.sh"; }
  retry3 "agave install" install_agave || { log "agave install failed"; AGAVE_FAILED=1; }
  rm -f "$HOME/.agave-install.sh"
fi

# ---- 3. versions --------------------------------------------------------------
log "---- versions ----"
command -v rustup >/dev/null 2>&1 && rustup --version 2>&1 | head -1 || log "rustup: MISSING"
command -v rustc  >/dev/null 2>&1 && rustc --version || log "rustc: MISSING"
command -v cargo  >/dev/null 2>&1 && cargo --version || log "cargo: MISSING"
command -v solana >/dev/null 2>&1 && solana --version || log "solana: MISSING"
command -v cargo-build-sbf >/dev/null 2>&1 && cargo-build-sbf --version 2>&1 | head -2 || log "cargo-build-sbf: MISSING"
command -v solana-test-validator >/dev/null 2>&1 && solana-test-validator --version || log "solana-test-validator: MISSING"
log "disk: cargo=$(du -sh "$HOME/.cargo" 2>/dev/null | cut -f1) rustup=$(du -sh "$HOME/.rustup" 2>/dev/null | cut -f1) solana=$(du -sh "$HOME/.local/share/solana" 2>/dev/null | cut -f1) platform-tools-cache=$(du -sh "$HOME/.cache/solana" 2>/dev/null | cut -f1)"
log "elapsed: $(( $(date +%s) - T0 ))s"
if [ "${RUSTUP_FAILED:-0}" = 1 ] || [ "${AGAVE_FAILED:-0}" = 1 ]; then log "one or more installs FAILED (see above)"; exit 1; fi
log "OK"
