#!/usr/bin/env bash
# Build both miners: miner.wasm (scalar) and miner.simd.wasm (4-way SIMD).
# Prefers Rust; falls back to the C twins via clang.
set -e
cd "$(dirname "$0")"
T=wasm32-unknown-unknown

if command -v rustc >/dev/null 2>&1 && rustc --print target-list 2>/dev/null | grep -q "$T"; then
  rustc --target "$T" -O --crate-type=cdylib src/lib.rs  -o miner.wasm
  echo "built miner.wasm (Rust)"
  RUSTFLAGS="-C target-feature=+simd128" \
    rustc --target "$T" -O --crate-type=cdylib -C target-feature=+simd128 src/simd.rs -o miner.simd.wasm
  echo "built miner.simd.wasm (Rust + simd128)"
  # (cargo alternative for the scalar crate: cargo build --release --target $T)
elif command -v clang >/dev/null 2>&1; then
  clang --target=wasm32 -O3 -nostdlib -Wl,--no-entry -Wl,--strip-all -Wl,--export-memory \
    -Wl,--export=mine -Wl,--export=set_salt -Wl,--export=digest_ptr -Wl,--export=hash_nonce \
    -o miner.wasm miner.c
  echo "built miner.wasm (clang twin)"
  clang --target=wasm32 -msimd128 -O3 -nostdlib -Wl,--no-entry -Wl,--strip-all -Wl,--export-memory \
    -Wl,--export=mine -Wl,--export=set_salt -Wl,--export=digest_ptr \
    -o miner.simd.wasm miner_simd.c
  echo "built miner.simd.wasm (clang twin, -msimd128)"
else
  echo "no toolchain: install Rust (+ 'rustup target add wasm32-unknown-unknown') or clang" >&2
  exit 1
fi
