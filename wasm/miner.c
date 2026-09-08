/* SHA-256 proof-of-work miner — freestanding wasm (no libc, no imports).
   Message hashed = salt(4 LE) || nonce(4 LE), 8 bytes → single SHA-256 block.
   ABI (all export_name'd): set_salt(u32), mine(bits,nonce_start,max_iters)->i64,
   hash_nonce(u32), digest_ptr()->i32 ; linear memory is exported as "memory".
   NOTE: reference C twin of miner.rs, used only to prebuild miner.wasm in a
   sandbox without the Rust wasm target. miner.rs is canonical.               */
#include <stdint.h>
static const uint32_t K[64]={
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROTR(x,n) (((x)>>(n))|((x)<<(32-(n))))
#define CH(x,y,z) (((x)&(y))^(~(x)&(z)))
#define MAJ(x,y,z) (((x)&(y))^((x)&(z))^((y)&(z)))
#define B0(x) (ROTR(x,2)^ROTR(x,13)^ROTR(x,22))
#define B1(x) (ROTR(x,6)^ROTR(x,11)^ROTR(x,25))
#define S0(x) (ROTR(x,7)^ROTR(x,18)^((x)>>3))
#define S1(x) (ROTR(x,17)^ROTR(x,19)^((x)>>10))
static void sha256_8(const uint8_t* m, uint8_t out[32]){
  uint8_t bl[64]; for(int i=0;i<64;i++) bl[i]=0;
  for(int i=0;i<8;i++) bl[i]=m[i];
  bl[8]=0x80; uint64_t bits=64; /* 8 bytes * 8 */
  bl[62]=(uint8_t)(bits>>8); bl[63]=(uint8_t)bits;
  uint32_t w[64];
  for(int i=0;i<16;i++) w[i]=((uint32_t)bl[i*4]<<24)|((uint32_t)bl[i*4+1]<<16)|((uint32_t)bl[i*4+2]<<8)|bl[i*4+3];
  for(int i=16;i<64;i++) w[i]=S1(w[i-2])+w[i-7]+S0(w[i-15])+w[i-16];
  uint32_t a=0x6a09e667,b=0xbb67ae85,c=0x3c6ef372,d=0xa54ff53a,e=0x510e527f,f=0x9b05688c,g=0x1f83d9ab,h=0x5be0cd19;
  for(int i=0;i<64;i++){ uint32_t t1=h+B1(e)+CH(e,f,g)+K[i]+w[i], t2=B0(a)+MAJ(a,b,c); h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2; }
  uint32_t H[8]={0x6a09e667+a,0xbb67ae85+b,0x3c6ef372+c,0xa54ff53a+d,0x510e527f+e,0x9b05688c+f,0x1f83d9ab+g,0x5be0cd19+h};
  for(int i=0;i<8;i++){ out[i*4]=(uint8_t)(H[i]>>24); out[i*4+1]=(uint8_t)(H[i]>>16); out[i*4+2]=(uint8_t)(H[i]>>8); out[i*4+3]=(uint8_t)H[i]; }
}
static uint8_t g_digest[32];
static uint32_t g_salt=0;
static int lz(const uint8_t* d){ int n=0; for(int i=0;i<32;i++){ uint8_t b=d[i]; if(!b){n+=8;continue;} for(int msk=0x80;msk;msk>>=1){ if(b&msk) return n; n++; } } return n; }
__attribute__((export_name("set_salt"))) void set_salt(uint32_t s){ g_salt=s; }
__attribute__((export_name("digest_ptr"))) uint8_t* digest_ptr(void){ return g_digest; }
__attribute__((export_name("hash_nonce"))) void hash_nonce(uint32_t nonce){
  uint8_t m[8]={(uint8_t)g_salt,(uint8_t)(g_salt>>8),(uint8_t)(g_salt>>16),(uint8_t)(g_salt>>24),
                (uint8_t)nonce,(uint8_t)(nonce>>8),(uint8_t)(nonce>>16),(uint8_t)(nonce>>24)};
  sha256_8(m,g_digest);
}
__attribute__((export_name("mine"))) int64_t mine(int32_t bits, uint32_t nonce_start, uint32_t max_iters){
  uint8_t m[8]={(uint8_t)g_salt,(uint8_t)(g_salt>>8),(uint8_t)(g_salt>>16),(uint8_t)(g_salt>>24),0,0,0,0};
  uint8_t out[32];
  for(uint32_t i=0;i<max_iters;i++){
    uint32_t nonce=nonce_start+i;
    m[4]=(uint8_t)nonce; m[5]=(uint8_t)(nonce>>8); m[6]=(uint8_t)(nonce>>16); m[7]=(uint8_t)(nonce>>24);
    sha256_8(m,out);
    if(lz(out)>=bits){ for(int j=0;j<32;j++) g_digest[j]=out[j]; return (int64_t)nonce; }
  }
  return -1;
}
