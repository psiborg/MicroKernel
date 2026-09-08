#!/usr/bin/env bash
# Build miner.wasm. Prefers Rust (canonical); falls back to the C twin via clang.
set -e
cd "$(dirname "$0")"

if command -v cargo >/dev/null 2>&1 && rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
  cargo build --release --target wasm32-unknown-unknown
  cp target/wasm32-unknown-unknown/release/miner.wasm ./miner.wasm
  echo "built miner.wasm from Rust (cargo)"
elif command -v rustc >/dev/null 2>&1 && \
     rustc --target wasm32-unknown-unknown -O --crate-type=cdylib src/lib.rs -o miner.wasm 2>/dev/null; then
  echo "built miner.wasm from Rust (rustc)"
elif command -v clang >/dev/null 2>&1; then
  clang --target=wasm32 -O3 -nostdlib -Wl,--no-entry -Wl,--strip-all -Wl,--export-memory \
    -Wl,--export=mine -Wl,--export=set_salt -Wl,--export=digest_ptr -Wl,--export=hash_nonce \
    -o miner.wasm miner.c
  echo "built miner.wasm from the C twin (clang) — Rust wasm target not found"
else
  echo "no toolchain: install Rust (+ 'rustup target add wasm32-unknown-unknown') or clang" >&2
  exit 1
fi
