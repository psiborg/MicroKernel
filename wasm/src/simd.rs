//! 4-way SIMD SHA-256 proof-of-work miner — reference source for miner.simd.wasm.
//!
//! Hashes FOUR nonces at once, one per i32x4 lane. Same message layout and ABI as
//! the scalar miner (src/lib.rs), so at a given salt + difficulty it finds the
//! identical winning nonce. A single SHA-256 is a serial dependency chain, so
//! SIMD does not speed one hash up — the win is hashing four independent nonces
//! in parallel across the vector lanes, which is exactly the mining workload.
//!
//! Build (needs the simd128 target feature):
//!   RUSTFLAGS="-C target-feature=+simd128" \
//!     cargo build --release --target wasm32-unknown-unknown
//! or via ../build.sh. NOTE: the shipped miner.simd.wasm was built and verified
//! from the C twin miner_simd.c (clang -msimd128); this Rust port is the intended
//! canonical source and compiles to the same ABI.
#![no_std]
#![no_main]
use core::panic::PanicInfo;
use core::arch::wasm32::*;
#[panic_handler] fn panic(_: &PanicInfo) -> ! { loop {} }

const K: [u32; 64] = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];

#[inline(always)] fn rotr(x: v128, n: u32) -> v128 { v128_or(u32x4_shr(x, n), u32x4_shl(x, 32 - n)) }
#[inline(always)] fn bsig0(x: v128) -> v128 { v128_xor(v128_xor(rotr(x,2), rotr(x,13)), rotr(x,22)) }
#[inline(always)] fn bsig1(x: v128) -> v128 { v128_xor(v128_xor(rotr(x,6), rotr(x,11)), rotr(x,25)) }
#[inline(always)] fn ssig0(x: v128) -> v128 { v128_xor(v128_xor(rotr(x,7), rotr(x,18)), u32x4_shr(x,3)) }
#[inline(always)] fn ssig1(x: v128) -> v128 { v128_xor(v128_xor(rotr(x,17), rotr(x,19)), u32x4_shr(x,10)) }
#[inline(always)] fn ch(e: v128, f: v128, g: v128) -> v128 { v128_xor(v128_and(e,f), v128_and(v128_not(e), g)) }
#[inline(always)] fn maj(a: v128, b: v128, c: v128) -> v128 { v128_xor(v128_xor(v128_and(a,b), v128_and(a,c)), v128_and(b,c)) }

static mut DIGEST: [u8; 32] = [0; 32];
static mut SALT: u32 = 0;

#[no_mangle] pub extern "C" fn set_salt(s: u32) { unsafe { SALT = s; } }
#[no_mangle] pub extern "C" fn digest_ptr() -> *const u8 { unsafe { DIGEST.as_ptr() } }

#[no_mangle]
pub extern "C" fn mine(bits: i32, nonce_start: u32, max_iters: u32) -> i64 {
    let shift = 32u32 - bits as u32;
    let saltv = u32x4_splat(unsafe { SALT }.swap_bytes());
    let mut w = [u32x4_splat(0); 64];   // w[3..=14] stay zero for every group
    let mut i = 0u32;
    while i < max_iters {
        let base = nonce_start.wrapping_add(i);
        w[0] = saltv;
        w[1] = u32x4(base.swap_bytes(),
                     base.wrapping_add(1).swap_bytes(),
                     base.wrapping_add(2).swap_bytes(),
                     base.wrapping_add(3).swap_bytes());
        w[2]  = u32x4_splat(0x8000_0000);
        w[15] = u32x4_splat(64);
        let mut t = 16;
        while t < 64 {
            w[t] = u32x4_add(u32x4_add(ssig1(w[t-2]), w[t-7]), u32x4_add(ssig0(w[t-15]), w[t-16]));
            t += 1;
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h) = (
            u32x4_splat(0x6a09_e667), u32x4_splat(0xbb67_ae85), u32x4_splat(0x3c6e_f372), u32x4_splat(0xa54f_f53a),
            u32x4_splat(0x510e_527f), u32x4_splat(0x9b05_688c), u32x4_splat(0x1f83_d9ab), u32x4_splat(0x5be0_cd19));
        let mut r = 0;
        while r < 64 {
            let t1 = u32x4_add(u32x4_add(h, bsig1(e)), u32x4_add(ch(e,f,g), u32x4_add(u32x4_splat(K[r]), w[r])));
            let t2 = u32x4_add(bsig0(a), maj(a,b,c));
            h = g; g = f; f = e; e = u32x4_add(d, t1); d = c; c = b; b = a; a = u32x4_add(t1, t2);
            r += 1;
        }
        let h0 = u32x4_add(u32x4_splat(0x6a09_e667), a);
        let l0 = u32x4_extract_lane::<0>(h0);
        let l1 = u32x4_extract_lane::<1>(h0);
        let l2 = u32x4_extract_lane::<2>(h0);
        let l3 = u32x4_extract_lane::<3>(h0);
        let lane: i32 = if l0 >> shift == 0 { 0 } else if l1 >> shift == 0 { 1 }
                        else if l2 >> shift == 0 { 2 } else if l3 >> shift == 0 { 3 } else { -1 };
        if lane >= 0 {
            let hs = [
                u32x4_add(u32x4_splat(0x6a09_e667), a), u32x4_add(u32x4_splat(0xbb67_ae85), b),
                u32x4_add(u32x4_splat(0x3c6e_f372), c), u32x4_add(u32x4_splat(0xa54f_f53a), d),
                u32x4_add(u32x4_splat(0x510e_527f), e), u32x4_add(u32x4_splat(0x9b05_688c), f),
                u32x4_add(u32x4_splat(0x1f83_d9ab), g), u32x4_add(u32x4_splat(0x5be0_cd19), h)];
            let mut tmp = [0u32; 4];
            let mut k = 0;
            while k < 8 {
                unsafe { v128_store(tmp.as_mut_ptr() as *mut v128, hs[k]); }
                let word = tmp[lane as usize];
                unsafe {
                    DIGEST[k*4]   = (word >> 24) as u8;
                    DIGEST[k*4+1] = (word >> 16) as u8;
                    DIGEST[k*4+2] = (word >> 8) as u8;
                    DIGEST[k*4+3] = word as u8;
                }
                k += 1;
            }
            return (base + lane as u32) as i64;
        }
        i += 4;
    }
    -1
}
