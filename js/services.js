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
