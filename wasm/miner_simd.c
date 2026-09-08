/* 4-way SIMD SHA-256 proof-of-work miner — freestanding wasm (-msimd128).
   Hashes FOUR nonces at once, one per i32x4 lane. Same message layout and ABI as
   the scalar miner (salt(4 LE)||nonce(4 LE), single block), so it finds the same
   nonce for a given salt+difficulty. Exports: set_salt(u32),
   mine(bits,nonce_start,max_iters)->i64, digest_ptr()->i32, memory.
   Reference C twin of miner_simd.rs (canonical). */
#include <stdint.h>
#include <wasm_simd128.h>
/* minimal libc shims for -nostdlib (clang may emit memset/memcpy for aggregates) */
void* memset(void* p, int v, unsigned long n){ unsigned char* d=(unsigned char*)p; for(unsigned long i=0;i<n;i++) d[i]=(unsigned char)v; return p; }
void* memcpy(void* d, const void* s, unsigned long n){ unsigned char* a=(unsigned char*)d; const unsigned char* b=(const unsigned char*)s; for(unsigned long i=0;i<n;i++) a[i]=b[i]; return d; }

static const uint32_t K[64]={
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};

#define ROTR(x,n) wasm_v128_or(wasm_u32x4_shr((x),(n)), wasm_i32x4_shl((x),(32-(n))))
#define SHR(x,n)  wasm_u32x4_shr((x),(n))
#define XOR3(a,b,c) wasm_v128_xor(wasm_v128_xor((a),(b)),(c))
#define ADD(a,b)  wasm_i32x4_add((a),(b))

static inline v128_t BS0(v128_t x){ return XOR3(ROTR(x,2),ROTR(x,13),ROTR(x,22)); }
static inline v128_t BS1(v128_t x){ return XOR3(ROTR(x,6),ROTR(x,11),ROTR(x,25)); }
static inline v128_t SS0(v128_t x){ return XOR3(ROTR(x,7),ROTR(x,18),SHR(x,3)); }
static inline v128_t SS1(v128_t x){ return XOR3(ROTR(x,17),ROTR(x,19),SHR(x,10)); }
static inline v128_t CH(v128_t e,v128_t f,v128_t g){ return wasm_v128_xor(wasm_v128_and(e,f), wasm_v128_and(wasm_v128_not(e),g)); }
static inline v128_t MAJ(v128_t a,v128_t b,v128_t c){ return XOR3(wasm_v128_and(a,b),wasm_v128_and(a,c),wasm_v128_and(b,c)); }

static uint8_t  g_digest[32];
static uint32_t g_salt=0;
static inline uint32_t bswap(uint32_t x){ return (x<<24)|((x&0xff00)<<8)|((x>>8)&0xff00)|(x>>24); }

__attribute__((export_name("set_salt")))   void     set_salt(uint32_t s){ g_salt=s; }
__attribute__((export_name("digest_ptr"))) uint8_t* digest_ptr(void){ return g_digest; }

// full 4-lane compression for nonces base..base+3 → 8 state vectors in H[8]
static void compress4(uint32_t base, v128_t saltv, v128_t H[8]){
  v128_t W[64];
  W[0]=saltv;
  W[1]=wasm_i32x4_make(bswap(base),bswap(base+1),bswap(base+2),bswap(base+3));
  W[2]=wasm_i32x4_splat((int)0x80000000);
  for(int i=3;i<15;i++) W[i]=wasm_i32x4_splat(0);
  W[15]=wasm_i32x4_splat(64);
  for(int i=16;i<64;i++) W[i]=ADD(ADD(SS1(W[i-2]),W[i-7]), ADD(SS0(W[i-15]),W[i-16]));
  v128_t a=wasm_i32x4_splat((int)0x6a09e667),b=wasm_i32x4_splat((int)0xbb67ae85),
         c=wasm_i32x4_splat((int)0x3c6ef372),d=wasm_i32x4_splat((int)0xa54ff53a),
         e=wasm_i32x4_splat((int)0x510e527f),f=wasm_i32x4_splat((int)0x9b05688c),
         g=wasm_i32x4_splat((int)0x1f83d9ab),h=wasm_i32x4_splat((int)0x5be0cd19);
  for(int i=0;i<64;i++){
    v128_t t1=ADD(ADD(h,BS1(e)), ADD(CH(e,f,g), ADD(wasm_i32x4_splat((int)K[i]),W[i])));
    v128_t t2=ADD(BS0(a),MAJ(a,b,c));
    h=g;g=f;f=e;e=ADD(d,t1);d=c;c=b;b=a;a=ADD(t1,t2);
  }
  H[0]=ADD(wasm_i32x4_splat((int)0x6a09e667),a); H[1]=ADD(wasm_i32x4_splat((int)0xbb67ae85),b);
  H[2]=ADD(wasm_i32x4_splat((int)0x3c6ef372),c); H[3]=ADD(wasm_i32x4_splat((int)0xa54ff53a),d);
  H[4]=ADD(wasm_i32x4_splat((int)0x510e527f),e); H[5]=ADD(wasm_i32x4_splat((int)0x9b05688c),f);
  H[6]=ADD(wasm_i32x4_splat((int)0x1f83d9ab),g); H[7]=ADD(wasm_i32x4_splat((int)0x5be0cd19),h);
}

__attribute__((export_name("mine")))
int64_t mine(int32_t bits, uint32_t nonce_start, uint32_t max_iters){
  uint32_t shift=32-bits;
  v128_t saltv=wasm_i32x4_splat((int)bswap(g_salt));
  v128_t H[8];
  for(uint32_t i=0;i<max_iters;i+=4){
    uint32_t base=nonce_start+i;
    compress4(base, saltv, H);
    uint32_t l0=wasm_i32x4_extract_lane(H[0],0), l1=wasm_i32x4_extract_lane(H[0],1),
             l2=wasm_i32x4_extract_lane(H[0],2), l3=wasm_i32x4_extract_lane(H[0],3);
    int lane=-1;
    if((l0>>shift)==0) lane=0; else if((l1>>shift)==0) lane=1;
    else if((l2>>shift)==0) lane=2; else if((l3>>shift)==0) lane=3;
    if(lane>=0){
      uint32_t tmp[4];
      for(int k=0;k<8;k++){ wasm_v128_store(tmp,H[k]); uint32_t w=tmp[lane];
        g_digest[k*4]=(uint8_t)(w>>24); g_digest[k*4+1]=(uint8_t)(w>>16);
        g_digest[k*4+2]=(uint8_t)(w>>8); g_digest[k*4+3]=(uint8_t)w; }
      return (int64_t)(base+lane);
    }
  }
  return -1;
}
