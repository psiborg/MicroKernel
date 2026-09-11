/* ============================================================================
   services.js — the "drivers": clock, telemetry, compute (v1 + v2)

   ⚠️  CRITICAL CONSTRAINT — READ BEFORE EDITING ⚠️
   Each service function is serialized with Function.prototype.toString() and
   injected into a Web Worker (see ports.js). It therefore CAPTURES NO SCOPE.
   These exports are data that happens to be executable.

   A service function may ONLY touch its `api` argument. It must NOT:
     • reference module-level variables, imports, or helpers defined here
     • call a shared function factored out "for DRY-ness"
   Doing so works in the main-thread fallback and SILENTLY BREAKS in a Worker
   (the helper isn't in the worker's scope) — a nasty host-dependent bug.
   Timings come from api.cfg.service.*; that config is injected as JSON.
   If you need shared logic, inline it into each service, or pass it via cfg.
============================================================================ */

export function clockService(api){
  var C = api.cfg.service;
  var seq = 0, beating = true;
  api.on(function(m){
    if(m.topic === "sys/stopbeat") beating = false;     // soft crash: hang
    if(m.topic === "sys/crash")    api.die();            // hard crash: terminate
  });
  api.interval(function(){ seq++; api.post("clock/tick", {seq:seq}); }, C.clockTickMs);
  api.interval(function(){ if(beating) api.post("sys/heartbeat", {t:api.now()}); }, C.heartbeatMs);
}

export function telemetryService(api){
  var C = api.cfg.service;
  var beating = true, base = 46;
  api.on(function(m){
    if(m.topic === "sys/stopbeat")  beating = false;
    if(m.topic === "sys/crash")     api.die();
    if(m.topic === "sys/misbehave") api.post("sys/control", {evil:true}); // policy will judge this
  });
  api.interval(function(){
    base += (Math.random()-0.5)*5;
    if(base<24) base=24; if(base>78) base=78;
    api.post("telemetry/reading", {temp: Math.round(base*10)/10, load: Math.random()});
  }, C.telemetryMs);
  api.interval(function(){ if(beating) api.post("sys/heartbeat", {t:api.now()}); }, C.heartbeatMs);
}

/* two versions to demonstrate hot swap. v1 = trial division, v2 = sieve. */
export function computeServiceV1(api){
  var C = api.cfg.service, beating = true;
  api.on(function(m){
    if(m.topic === "sys/stopbeat") beating = false;
    if(m.topic === "sys/crash")    api.die();
    if(m.topic === "compute/run"){
      var n = m.data.n, t0 = api.now(), count = 0;
      for(var i=2;i<=n;i++){ var p=true; for(var j=2;j*j<=i;j++){ if(i%j===0){p=false;break;} } if(p) count++; }
      api.post("compute/result", {n:n, count:count, ms:api.now()-t0, ver:"v1"});
    }
  });
  api.interval(function(){ if(beating) api.post("sys/heartbeat", {t:api.now()}); }, C.heartbeatMs);
}
export function computeServiceV2(api){
  var C = api.cfg.service, beating = true;
  api.on(function(m){
    if(m.topic === "sys/stopbeat") beating = false;
    if(m.topic === "sys/crash")    api.die();
    if(m.topic === "compute/run"){
      var n = m.data.n, t0 = api.now(), sieve = new Uint8Array(n+1), count = 0;
      for(var i=2;i<=n;i++){ if(!sieve[i]){ count++; for(var j=i*i;j<=n;j+=i) sieve[j]=1; } }
      api.post("compute/result", {n:n, count:count, ms:api.now()-t0, ver:"v2"});
    }
  });
  api.interval(function(){ if(beating) api.post("sys/heartbeat", {t:api.now()}); }, C.heartbeatMs);
}

/* ----------------------------------------------------------------------------
   wasmcompute — SHA-256 proof-of-work miner backed by a Rust→wasm module.

   Fetches api.cfg.wasm.url (absolute, resolved in boot), instantiates it with an
   EMPTY import object (the module is freestanding — no JS imports), then on
   wasm/run mines in cooperative chunks of api.cfg.wasm.chunk hashes, yielding
   between chunks with setTimeout(0) so heartbeats keep flowing (a busy Worker
   can't heartbeat mid-chunk — hence the yield). Reports wasm/progress (live
   hashrate) and wasm/result (winning nonce + hash). Still just an `api` consumer.
---------------------------------------------------------------------------- */
export function wasmComputeService(api){
  var C = api.cfg;
  var beating = true;
  var ex = null;        // wasm exports once instantiated
  var loadErr = null;
  var job = null;       // active mining job, or null

  // Prefer the SIMD module; fall back to scalar when the browser lacks SIMD.
  // WebAssembly.validate on the actual bytes is an exact feature test.
  fetch(C.wasm.simdUrl)
    .then(function(r){ if(!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
    .then(function(buf){
      if(WebAssembly.validate(buf)) return { buf: buf, mode: "simd" };
      return fetch(C.wasm.url).then(function(r){ return r.arrayBuffer(); })
                              .then(function(b){ return { buf: b, mode: "scalar" }; });
    })
    .then(function(x){ return WebAssembly.instantiate(x.buf, {}).then(function(res){
      ex = res.instance.exports; api.post("wasm/ready", { mode: x.mode });
    }); })
    .catch(function(e){ loadErr = String(e && e.message || e); api.post("wasm/error", {msg: loadErr}); });

  function digestHex(){
    var p = ex.digest_ptr();
    var b = new Uint8Array(ex.memory.buffer, p, 32), s = "";
    for(var i=0;i<32;i++){ var h = b[i].toString(16); s += (h.length<2?"0":"") + h; }
    return s;
  }

  function step(){
    if(!job) return;
    if(!ex){ setTimeout(step, 60); return; }        // wasm still loading — wait
    var chunkStart = job.cursor >>> 0;
    var t0 = api.now();
    var found = ex.mine(job.bits, chunkStart, C.mine.wasmChunk); // i64 → BigInt in workers
    var dt = api.now() - t0;
    var f = (typeof found === "bigint") ? Number(found) : found;
    if(f >= 0){
      job.hashes += (f - chunkStart + 1);           // actual hashes done this chunk
      var totalMs = api.now() - job.started;
      api.post("wasm/result", {
        nonce: f, hashHex: digestHex(), bits: job.bits, salt: job.salt,
        hashes: job.hashes, ms: totalMs, rate: (job.hashes/((totalMs||1)/1000))|0
      });
      job = null;
      return;
    }
    job.hashes += C.mine.wasmChunk;
    job.cursor = (chunkStart + C.mine.wasmChunk) >>> 0;
    api.post("wasm/progress", { hashes: job.hashes, rate: (C.mine.wasmChunk/((dt||1)/1000))|0, bits: job.bits });
    if(job.hashes >= 0x100000000){                    // searched the whole 2^32 nonce space
      api.post("wasm/result", { nonce: -1, exhausted: true, bits: job.bits, hashes: job.hashes, ms: api.now()-job.started });
      job = null;
      return;
    }
    setTimeout(step, 0);                             // yield: lets heartbeats fire
  }

  api.on(function(m){
    if(m.topic === "sys/stopbeat") beating = false;
    else if(m.topic === "sys/crash") api.die();
    else if(m.topic === "wasm/run"){
      if(loadErr){ api.post("wasm/error", {msg: loadErr}); return; }
      var salt = (m.data && typeof m.data.salt === "number") ? (m.data.salt >>> 0)
                                                             : ((Math.random()*0xFFFFFFFF) >>> 0);
      if(ex) ex.set_salt(salt);
      var start = (m.data && m.data.start >>> 0) || 0;
      job = { bits: (m.data.bits|0), cursor: start, start: start, salt: salt, hashes: 0, started: api.now() };
      step();
    }
    else if(m.topic === "wasm/stop"){ job = null; }
  });

  api.interval(function(){ if(beating) api.post("sys/heartbeat", {t:api.now()}); }, C.service.heartbeatMs);
}

/* ----------------------------------------------------------------------------
   jsminer — the SAME SHA-256 proof-of-work as wasmcompute, in pure JavaScript.

   Exists so you can race it against wasmcompute on the same bus tape. It hashes
   the identical message (salt(4 LE) || nonce(4 LE), single SHA-256 block) and
   uses the identical leading-zero-bits target, so at the same difficulty + salt
   both miners search the same space and converge on the SAME winning nonce — a
   true apples-to-apples race. Mines in cooperative chunks (setTimeout(0) between
   slices) exactly like the wasm one, so heartbeats keep flowing.

   The SHA-256 is written for the fixed 8-byte message: the block schedule words
   W[2..15] are constant, so only W[0]/W[1] (salt/nonce, byte-swapped) change.
   Kept self-contained — no imports, no scope capture (stringified into a Worker).
---------------------------------------------------------------------------- */
export function jsMinerService(api){
  var C = api.cfg;
  var beating = true;
  var job = null;

  var K = new Int32Array([
    0x428a2f98|0,0x71374491|0,0xb5c0fbcf|0,0xe9b5dba5|0,0x3956c25b|0,0x59f111f1|0,0x923f82a4|0,0xab1c5ed5|0,
    0xd807aa98|0,0x12835b01|0,0x243185be|0,0x550c7dc3|0,0x72be5d74|0,0x80deb1fe|0,0x9bdc06a7|0,0xc19bf174|0,
    0xe49b69c1|0,0xefbe4786|0,0x0fc19dc6|0,0x240ca1cc|0,0x2de92c6f|0,0x4a7484aa|0,0x5cb0a9dc|0,0x76f988da|0,
    0x983e5152|0,0xa831c66d|0,0xb00327c8|0,0xbf597fc7|0,0xc6e00bf3|0,0xd5a79147|0,0x06ca6351|0,0x14292967|0,
    0x27b70a85|0,0x2e1b2138|0,0x4d2c6dfc|0,0x53380d13|0,0x650a7354|0,0x766a0abb|0,0x81c2c92e|0,0x92722c85|0,
    0xa2bfe8a1|0,0xa81a664b|0,0xc24b8b70|0,0xc76c51a3|0,0xd192e819|0,0xd6990624|0,0xf40e3585|0,0x106aa070|0,
    0x19a4c116|0,0x1e376c08|0,0x2748774c|0,0x34b0bcb5|0,0x391c0cb3|0,0x4ed8aa4a|0,0x5b9cca4f|0,0x682e6ff3|0,
    0x748f82ee|0,0x78a5636f|0,0x84c87814|0,0x8cc70208|0,0x90befffa|0,0xa4506ceb|0,0xbef9a3f7|0,0xc67178f2|0]);
  var W = new Int32Array(64);
  var H = new Int32Array(8);
  function bswap(x){ return ((x&0xff)<<24)|((x&0xff00)<<8)|((x>>>8)&0xff00)|(x>>>24); }

  function compress(salt, nonce){
    W[0]=bswap(salt|0); W[1]=bswap(nonce|0); W[2]=0x80000000|0;
    W[3]=0;W[4]=0;W[5]=0;W[6]=0;W[7]=0;W[8]=0;W[9]=0;W[10]=0;W[11]=0;W[12]=0;W[13]=0;W[14]=0; W[15]=64;
    for(var i=16;i<64;i++){
      var x2=W[i-2], x15=W[i-15];
      var s1=((x2>>>17)|(x2<<15))^((x2>>>19)|(x2<<13))^(x2>>>10);
      var s0=((x15>>>7)|(x15<<25))^((x15>>>18)|(x15<<14))^(x15>>>3);
      W[i]=(W[i-16]+s0+W[i-7]+s1)|0;
    }
    var a=0x6a09e667|0,b=0xbb67ae85|0,c=0x3c6ef372|0,d=0xa54ff53a|0,
        e=0x510e527f|0,f=0x9b05688c|0,g=0x1f83d9ab|0,h=0x5be0cd19|0;
    for(var i=0;i<64;i++){
      var S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
      var ch=(e&f)^(~e&g);
      var t1=(h+S1+ch+K[i]+W[i])|0;
      var S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
      var maj=(a&b)^(a&c)^(b&c);
      var t2=(S0+maj)|0;
      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    H[0]=(a+0x6a09e667)|0;H[1]=(b+0xbb67ae85)|0;H[2]=(c+0x3c6ef372)|0;H[3]=(d+0xa54ff53a)|0;
    H[4]=(e+0x510e527f)|0;H[5]=(f+0x9b05688c)|0;H[6]=(g+0x1f83d9ab)|0;H[7]=(h+0x5be0cd19)|0;
  }
  function digestHex(){ var s=""; for(var i=0;i<8;i++){ var t=(H[i]>>>0).toString(16); s+="00000000".slice(t.length)+t; } return s; }

  function step(){
    if(!job) return;
    var shift = 32 - job.bits, chunk = C.mine.jsChunk, start = job.cursor >>> 0;
    var t0 = api.now(), found = -1;
    for(var i=0;i<chunk;i++){
      var nonce = (start + i) >>> 0;
      compress(job.salt, nonce);
      if(((H[0]>>>0) >>> shift) === 0){ found = nonce; break; }  // top `bits` bits are zero
    }
    var dt = api.now() - t0;
    if(found >= 0){
      job.hashes += (found - start + 1);
      var totalMs = api.now() - job.started;
      api.post("js/result", {
        nonce: found, hashHex: digestHex(), bits: job.bits, salt: job.salt,
        hashes: job.hashes, ms: totalMs, rate: (job.hashes/((totalMs||1)/1000))|0
      });
      job = null;
      return;
    }
    job.hashes += chunk;
    job.cursor = (start + chunk) >>> 0;
    api.post("js/progress", { hashes: job.hashes, rate: (chunk/((dt||1)/1000))|0, bits: job.bits });
    if(job.hashes >= 0x100000000){                    // searched the whole 2^32 nonce space
      api.post("js/result", { nonce: -1, exhausted: true, bits: job.bits, hashes: job.hashes, ms: api.now()-job.started });
      job = null;
      return;
    }
    setTimeout(step, 0);
  }

  api.on(function(m){
    if(m.topic === "sys/stopbeat") beating = false;
    else if(m.topic === "sys/crash") api.die();
    else if(m.topic === "js/run"){
      var salt = (m.data && typeof m.data.salt === "number") ? (m.data.salt >>> 0)
                                                             : ((Math.random()*0xFFFFFFFF) >>> 0);
      var start = (m.data && m.data.start >>> 0) || 0;
      job = { bits: (m.data.bits|0), cursor: start, start: start, salt: salt, hashes: 0, started: api.now() };
      step();
    }
    else if(m.topic === "js/stop"){ job = null; }
  });

  api.interval(function(){ if(beating) api.post("sys/heartbeat", {t:api.now()}); }, C.service.heartbeatMs);
}

/* ----------------------------------------------------------------------------
   analyzer — a telemetry watchdog, and the first service that depends on ANOTHER
   service. It subscribes to telemetry/reading, keeps a rolling window, and flags:
     • spike   — a new reading lands |z| ≥ sigma from the window mean.
     • stale   — no reading for staleMs → its input dependency is gone.
     • recover — telemetry resumes after a stale spell.
   Teaches two ideas the other services don't:
     • composition — services wiring into services over the same bus.
     • dependency health — crash telemetry with reincarnation OFF and the analyzer
       raises "input lost"; with reincarnation ON the supervisor heals telemetry
       before the analyzer even trips. Reincarnating the analyzer clears its
       window: restart ≠ restored state.
   Self-contained (no scope capture) like every service here.
---------------------------------------------------------------------------- */
export function analyzerService(api){
  var C = api.cfg.service;      // heartbeatMs
  var A = api.cfg.analyzer;     // window, sigma, staleMs
  var beating = true;
  var win = [];                 // recent temps — this service's own state
  var last = api.now();         // time of the last telemetry reading seen
  var stale = false;

  api.on(function(m){
    if(m.topic === "sys/stopbeat"){ beating = false; return; }
    if(m.topic === "sys/crash"){ api.die(); return; }
    if(m.topic === "telemetry/reading"){
      var t = m.data.temp, i;
      last = api.now();
      if(stale){ stale = false; api.post("analyzer/alert", {level:"recover", t:last}); }

      // rolling stats over the window established BEFORE this reading
      var n = win.length, mean = 0, sd = 0, z = 0;
      if(n >= 3){
        var sum = 0; for(i=0;i<n;i++) sum += win[i]; mean = sum/n;
        var v = 0; for(i=0;i<n;i++){ var d = win[i]-mean; v += d*d; } sd = Math.sqrt(v/n);
        z = sd > 0 ? (t-mean)/sd : 0;
      }
      win.push(t); if(win.length > A.window) win.shift();

      api.post("analyzer/stat", {
        temp: t, mean: Math.round(mean*10)/10, sd: Math.round(sd*100)/100,
        z: Math.round(z*100)/100, n: win.length, cap: A.window
      });
      if(n >= A.window && Math.abs(z) >= A.sigma){
        api.post("analyzer/alert", {level:"spike", temp:t, mean:Math.round(mean*10)/10, z:Math.round(z*100)/100, t:last});
      }
    }
  });

  // heartbeat + a watchdog on its own input dependency
  api.interval(function(){
    if(!beating) return;
    api.post("sys/heartbeat", {t:api.now()});
    if(!stale && (api.now() - last) > A.staleMs){
      stale = true;
      api.post("analyzer/alert", {level:"stale", since:(api.now()-last)|0, t:api.now()});
    }
  }, C.heartbeatMs);
}

/* ----------------------------------------------------------------------------
   pi — hex digits of π via the Bailey–Borwein–Plouffe (BBP) spigot.

   BBP extracts the n-th HEX digit of π on its own, without the digits before it,
   using modular exponentiation in fixed precision. Every digit position is an
   INDEPENDENT computation — embarrassingly parallel — so this is one of the few
   number-crunching tasks that actually suits a GPU. The service runs a WebGPU
   compute shader (one invocation per digit position) when the browser exposes
   `navigator.gpu`, and falls back to the SAME integer algorithm on the CPU
   otherwise. It self-checks the GPU output against the CPU reference and falls
   back if they disagree, so the result is always correct.

   Everything is u32 integer + 32-bit fixed-point (WGSL has no f64), which stays
   exact up to ~4000 digits (denominators < 2^15, so products fit u32). BBP gives
   BASE-16 digits; decimal spigots exist but are sequential — not GPU-friendly,
   which is itself the lesson. Self-contained: no scope capture.
---------------------------------------------------------------------------- */
export function piService(api){
  var C = api.cfg;
  var beating = true;
  var busy = false;
  var dev = null;                 // cached GPUDevice once acquired
  var HEX = "0123456789ABCDEF";

  /* ---- integer BBP (identical math to the WGSL shader below) ---- */
  function fixeddiv(r, denom){     // floor(r * 2^32 / denom), r < denom
    var hi = Math.floor((r*65536)/denom), rem = (r*65536)%denom, lo = Math.floor((rem*65536)/denom);
    return ((hi*65536) + lo) >>> 0;
  }
  function modpow16(e, m){         // 16^e mod m
    var result = 1%m, base = 16%m, ee = e>>>0;
    while(ee > 0){ if(ee & 1) result = (result*base)%m; ee = ee>>>1; base = (base*base)%m; }
    return result >>> 0;
  }
  function series(j, d){           // fractional part * 2^32 (u32; wrap = mod 1)
    var sum = 0, k;
    for(k = 0; k <= d; k++){ var dn = 8*k + j; sum = (sum + fixeddiv(modpow16(d-k, dn), dn)) >>> 0; }
    var p = 0x10000000; k = d + 1;                          // tail: 2^28·16^(d-k)
    while(p > 0){ sum = (sum + Math.floor(p/(8*k + j))) >>> 0; p = Math.floor(p/16); k++; }
    return sum >>> 0;
  }
  function digit(index){           // index>=1 → hex digit at that position after '.'
    var d = index - 1;
    var v = ((4*series(1,d)) - (2*series(4,d)) - series(5,d) - series(6,d)) >>> 0;
    return v >>> 28;
  }

  function computeCPU(digits){     // chunked so heartbeats keep flowing
    return new Promise(function(resolve){
      var hex = "", i = 1, chunk = C.pi.cpuChunk;
      function slice(){
        var end = Math.min(i + chunk - 1, digits);
        for(; i <= end; i++) hex += HEX.charAt(digit(i));
        api.post("pi/progress", {done: hex.length, total: digits, mode: "cpu"});
        if(i > digits){ resolve(hex); return; }
        setTimeout(slice, 0);
      }
      slice();
    });
  }

  /* ---- WebGPU path: one shader invocation per digit position ----
     NOTE: this mirrors the CPU integer BBP verified above. It could not be
     executed in the build sandbox (no browser/GPU), so it is guarded by a
     self-check + CPU fallback: if WebGPU is missing, errors, or returns digits
     that disagree with the CPU reference, the CPU result is used instead. */
  var WGSL = `
fn modpow16(e0:u32, m:u32) -> u32 {
  var result:u32 = 1u % m; var base:u32 = 16u % m; var e:u32 = e0;
  loop { if (e == 0u) { break; }
    if ((e & 1u) == 1u) { result = (result * base) % m; }
    e = e >> 1u; base = (base * base) % m; }
  return result;
}
fn fixeddiv(r:u32, denom:u32) -> u32 {
  let hi = (r << 16u) / denom; let rem = (r << 16u) % denom; let lo = (rem << 16u) / denom;
  return (hi << 16u) | (lo & 0xffffu);
}
fn series(j:u32, d:u32) -> u32 {
  var sum:u32 = 0u; var k:u32 = 0u;
  loop { if (k > d) { break; }
    let dn = 8u*k + j; sum = sum + fixeddiv(modpow16(d - k, dn), dn); k = k + 1u; }
  var p:u32 = 0x10000000u; k = d + 1u;
  loop { if (p == 0u) { break; } sum = sum + (p / (8u*k + j)); p = p / 16u; k = k + 1u; }
  return sum;
}
@group(0) @binding(0) var<storage, read> params : array<u32>;
@group(0) @binding(1) var<storage, read_write> outp : array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x; let n = arrayLength(&outp); if (i >= n) { return; }
  let d = params[0] + i;
  let v = (4u*series(1u,d)) - (2u*series(4u,d)) - series(5u,d) - series(6u,d);
  outp[i] = v >> 28u;
}`;

  async function getDevice(){
    if(dev) return dev;
    if(typeof navigator === "undefined" || !navigator.gpu) throw new Error("no WebGPU");
    var adapter = await navigator.gpu.requestAdapter();
    if(!adapter) throw new Error("no GPU adapter");
    dev = await adapter.requestDevice();
    return dev;
  }

  async function computeGPU(digits){
    var device = await getDevice();
    var N = digits, bytes = N*4;
    var outBuf   = device.createBuffer({size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
    var paramBuf = device.createBuffer({size: 16,    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(paramBuf, 0, new Uint32Array([0,0,0,0]));     // base position = 0
    var mod  = device.createShaderModule({code: WGSL});
    var pipe = device.createComputePipeline({layout: "auto", compute: {module: mod, entryPoint: "main"}});
    var bind = device.createBindGroup({layout: pipe.getBindGroupLayout(0), entries: [
      {binding: 0, resource: {buffer: paramBuf}}, {binding: 1, resource: {buffer: outBuf}}]});
    var enc = device.createCommandEncoder();
    var pass = enc.beginComputePass();
    pass.setPipeline(pipe); pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(N/64));
    pass.end();
    var readBuf = device.createBuffer({size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, bytes);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    var arr = new Uint32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap(); outBuf.destroy(); paramBuf.destroy(); readBuf.destroy();
    var hex = ""; for(var i = 0; i < N; i++) hex += HEX.charAt(arr[i] & 0xf);
    return hex;
  }

  function selfCheck(hex, digits){   // probe a few positions against the CPU reference
    var probes = [1, 2, Math.min(digits,9), Math.max(1, digits>>1), digits], t;
    for(t = 0; t < probes.length; t++){ var i = probes[t]; if(hex.charAt(i-1) !== HEX.charAt(digit(i))) return false; }
    return true;
  }

  function hexToDecimal(hex, nHex, D){   // fractional hex → D decimal digits (one BigInt divide)
    var F = BigInt("0x" + hex);          // frac(π) · 16^nHex, truncated
    var scaled = (F * (10n ** BigInt(D))) / (16n ** BigInt(nHex));
    var s = scaled.toString();
    if(s.length < D) s = "0".repeat(D - s.length) + s;
    return s.slice(0, D);
  }

  async function run(D){                  // D = requested DECIMAL digits
    busy = true;
    var started = api.now();
    // hex digits needed for D decimals: D / log10(16) + guard
    var nHex = Math.min(4000, Math.ceil(D / 1.2041199826559248) + C.pi.guardHex);
    var hex = null, mode = "cpu";
    if(typeof navigator !== "undefined" && navigator.gpu){
      try { var g = await computeGPU(nHex); if(selfCheck(g, nHex)){ hex = g; mode = "gpu"; } }
      catch(e){ hex = null; }
    }
    if(hex === null){ mode = "cpu"; hex = await computeCPU(nHex); }
    var dec = hexToDecimal(hex, nHex, D);
    api.post("pi/result", {digits: D, dec: dec, ms: (api.now() - started), mode: mode});
    busy = false;
  }

  api.on(function(m){
    if(m.topic === "sys/stopbeat"){ beating = false; return; }
    if(m.topic === "sys/crash"){ api.die(); return; }
    if(m.topic === "pi/run"){
      if(busy) return;
      var d = (m.data && m.data.digits) ? (m.data.digits|0) : C.pi.defaultDigits;
      run(Math.max(1, Math.min(C.pi.maxDigits, d)));
    }
  });

  api.interval(function(){ if(beating) api.post("sys/heartbeat", {t:api.now()}); }, C.service.heartbeatMs);
  api.post("pi/ready", {gpu: (typeof navigator !== "undefined" && !!navigator.gpu)});
}
