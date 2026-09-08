# wasm/ — the SHA-256 miner module

`miner.wasm` is fetched at runtime by the `wasmcompute` service and mines
SHA-256 proof-of-work (find a nonce whose hash has N leading zero bits).

## Source of truth

- **`src/lib.rs`** — the canonical Rust implementation (`#![no_std]`, no imports).
- **`Cargo.toml`** — crate manifest (`crate-type = ["cdylib"]`).
- **`miner.c`** — a byte-for-byte-equivalent C twin. It exists **only** to
  prebuild `miner.wasm` in environments without the Rust wasm target; the Rust
  source is authoritative.

The shipped `miner.wasm` in this repo was compiled from `miner.c` with clang
(the build sandbox couldn't install the Rust wasm target). Rebuilding from Rust
produces a drop-in module with the identical ABI.

## Build

```
./build.sh
```

Prefers Rust (`cargo build --release --target wasm32-unknown-unknown`, after a
one-time `rustup target add wasm32-unknown-unknown`) and falls back to the clang
twin. Output is `miner.wasm` in this folder.

## ABI

| Export | Signature | Purpose |
|---|---|---|
| `mine` | `(bits: i32, nonce_start: u32, max_iters: u32) -> i64` | search a slice; returns winning nonce or `-1` |
| `set_salt` | `(salt: u32)` | vary the input so each run is a fresh "block" |
| `hash_nonce` | `(nonce: u32)` | hash one nonce into the digest buffer |
| `digest_ptr` | `() -> i32` | pointer to the 32-byte digest of the last hit |
| `memory` | — | linear memory (read the digest here) |

Message hashed = `salt(4 LE) || nonce(4 LE)`, single SHA-256. Real Bitcoin uses
double SHA-256 over an 80-byte header; this is the same idea, minimised for a
teaching module.
