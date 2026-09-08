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
    api.post("wasm/progress", { hashes: job.hashes, rate: (C.wasm.chunk/((dt||1)/1000))|0, bits: job.bits });
    if(job.cursor <= (job.start >>> 0) && job.hashes > 0x100000000){ // wrapped the 32-bit space
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
    if(job.cursor <= (job.start >>> 0) && job.hashes > 0x100000000){
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
