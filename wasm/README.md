# wasm/ — the SHA-256 miner modules

Two modules, both fetched at runtime by the `wasmcompute` service, both mining
SHA-256 proof-of-work (find a nonce whose hash has N leading zero bits):

- **`miner.wasm`** — scalar, one nonce at a time.
- **`miner.simd.wasm`** — 4-way SIMD: hashes four nonces at once, one per
  `i32x4` lane (~3–4× faster). The service prefers this and falls back to the
  scalar module when the browser lacks SIMD (`WebAssembly.validate` on the bytes).

## Source of truth

- **`src/lib.rs`** — canonical Rust for the scalar module (`#![no_std]`, no imports).
- **`src/simd.rs`** — Rust port for the SIMD module (build with the `simd128`
  target feature).
- **`Cargo.toml`** — crate manifest for the scalar module.
- **`miner.c` / `miner_simd.c`** — byte-for-byte-equivalent C twins. They exist
  **only** to prebuild the shipped `.wasm` files where the Rust wasm target is
  unavailable; the Rust sources are authoritative.

The shipped `.wasm` files were compiled from the C twins with clang (the build
sandbox couldn't install the Rust wasm target) and verified against Node's
`crypto` SHA-256. Rebuilding from Rust produces drop-in modules with the
identical ABI.

## Build

```
./build.sh
```

Builds both modules. Prefers Rust (`rustc --target wasm32-unknown-unknown`, after
a one-time `rustup target add wasm32-unknown-unknown`; the SIMD module adds
`-C target-feature=+simd128`) and falls back to the clang twins.

## ABI (both modules)

| Export | Signature | Purpose |
|---|---|---|
| `mine` | `(bits: i32, nonce_start: u32, max_iters: u32) -> i64` | search a slice; returns winning nonce or `-1` |
| `set_salt` | `(salt: u32)` | vary the input so each run is a fresh "block" |
| `digest_ptr` | `() -> i32` | pointer to the 32-byte digest of the last hit |
| `memory` | — | linear memory (read the digest here) |

(The scalar module also exports `hash_nonce(u32)`; the SIMD one omits it — the
service never calls it.) Message hashed = `salt(4 LE) || nonce(4 LE)`, single
SHA-256. The SIMD `mine` processes nonces in groups of four internally but the
contract is identical, so at the same salt + difficulty it returns the same
winning nonce as the scalar module. Real Bitcoin uses double SHA-256 over an
80-byte header; this is the same idea, minimised for a teaching module.
