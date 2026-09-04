/* ============================================================================
   ports.js — two hosts, one interface

   A "port" wraps a running service and exposes exactly:
       { name, host, onmessage, postMessage(msg), terminate() }
   The kernel and supervisor only ever touch that interface, so they are
   agnostic to whether a service runs in a Web Worker (real isolation) or on the
   main thread (fallback). That agnosticism is location transparency.

   Pause is enforced here, not in services: a sys/pause / sys/resume control
   message toggles a flag that gates outbound post(). Services need no pause code.

   No imports on purpose — a port is constructed from (name, fn, cfg) and knows
   nothing about the kernel. The supervisor wires port.onmessage → Kernel.ingress.
============================================================================ */

// Worker availability is MUTABLE (the watchdog can flip it), and an imported
// binding can't be reassigned by importers — so it lives on an object.
export const workers = {
  ok: (function probe(){
    try{
      var b = new Blob(["self.postMessage(0)"], {type:"text/javascript"});
      var u = URL.createObjectURL(b);
      var w = new Worker(u);
      w.terminate(); URL.revokeObjectURL(u);
      return true;
    }catch(e){ return false; }
  })()
};

export function makeWorkerPort(name, fn, cfg){
  var src =
    'var NAME=' + JSON.stringify(name) + ';\n' +
    'var CFG=' + JSON.stringify(cfg) + ';\n' +
    'var PAUSED=false;\n' +
    'var api={\n' +
    '  post:function(topic,data){ if(PAUSED) return; self.postMessage({topic:topic,data:data}); },\n' +
    '  on:function(cb){ self.onmessage=function(e){ var m=e.data;\n' +
    '     if(m&&m.topic==="sys/pause"){ PAUSED=true; return; }\n' +
    '     if(m&&m.topic==="sys/resume"){ PAUSED=false; return; }\n' +
    '     cb(m); }; },\n' +
    '  now:function(){ return Date.now(); },\n' +
    '  interval:function(f,ms){ return setInterval(f,ms); },\n' +
    '  die:function(){ self.close(); },\n' +
    '  name:NAME, cfg:CFG\n' +
    '};\n' +
    '(' + fn.toString() + ')(api);\n';
  var url = URL.createObjectURL(new Blob([src], {type:"text/javascript"}));
  var w = new Worker(url);
  var port = {
    name:name, host:"worker", onmessage:null,
    postMessage:function(msg){ w.postMessage(msg); },
    terminate:function(){ try{ w.terminate(); }catch(e){} URL.revokeObjectURL(url); }
  };
  w.onmessage = function(e){ if(port.onmessage) port.onmessage(e.data); };
  return port;
}

export function makeLocalPort(name, fn, cfg){
  var serviceOnMessage = null, timers = [], dead = false, paused = false;
  var port = {
    name:name, host:"local", onmessage:null,
    postMessage:function(msg){                 // host -> service
      if(dead) return;
      if(msg && msg.topic === "sys/pause"){ paused = true; return; }
      if(msg && msg.topic === "sys/resume"){ paused = false; return; }
      setTimeout(function(){ if(!dead && serviceOnMessage) serviceOnMessage(msg); }, 0);
    },
    terminate:function(){ dead = true; timers.forEach(clearInterval); timers=[]; serviceOnMessage=null; }
  };
  var api = {
    name:name, cfg:cfg,
    post:function(topic,data){                 // service -> host
      if(dead || paused) return;
      var m = {topic:topic, data:data};
      setTimeout(function(){ if(!dead && port.onmessage) port.onmessage(m); }, 0);
    },
    on:function(cb){ serviceOnMessage = cb; },
    now:function(){ return Date.now(); },
    interval:function(f,ms){ var id=setInterval(function(){ if(!dead) f(); }, ms); timers.push(id); return id; },
    die:function(){ dead = true; timers.forEach(clearInterval); timers=[]; }
  };
  try{ fn(api); }catch(e){ dead = true; }   // a crash during init is just a dead service
  return port;
}
