/* ============================================================================
   instruments.js — the visible surface: Tape, Spark, Log, UI

   Tape / Spark / Log are pure widgets (they draw what they're told; they read
   only CONFIG + the DOM). UI is the "view": it reads live domain state to render
   the service cards, so it imports Kernel / Supervisor / workers. Those form
   call-time-only cycles with kernel.js and supervisor.js (see kernel.js note).
   getVar / escapeHtml are module-private helpers.
============================================================================ */

import { CONFIG as CFG } from "./config.js";
import { Kernel } from "./kernel.js";
import { Supervisor } from "./supervisor.js";
import { workers } from "./ports.js";

var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function getVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function escapeHtml(s){ return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c];}); }

export const Tape = (function(){
  var cvs = document.getElementById("tape"), ctx, W, H, dpr = window.devicePixelRatio||1;
  var events = [], pxPerMs = CFG.tape.pxPerMs;
  function color(kind){
    if(kind==="beat") return getVar("--signal");
    if(kind==="app")  return getVar("--pulse");
    if(kind==="sys")  return "#6fb2c9";
    if(kind==="sup")  return getVar("--warn");
    if(kind==="deny") return getVar("--dead");
    return getVar("--ink-dim");
  }
  function height(kind){
    if(kind==="beat") return 0.28;
    if(kind==="app")  return 0.62;
    if(kind==="sys")  return 0.42;
    if(kind==="sup")  return 0.95;
    if(kind==="deny") return 0.9;
    return 0.4;
  }
  function resize(){
    W = cvs.clientWidth; H = cvs.clientHeight;
    cvs.width = W*dpr; cvs.height = H*dpr; ctx = cvs.getContext("2d"); ctx.scale(dpr,dpr);
  }
  function tick(kind){ events.push({t:Date.now(), color:color(kind), h:height(kind)}); if(reduceMotion && !paused) draw(); }
  function draw(){
    if(!ctx) return;
    ctx.clearRect(0,0,W,H);
    ctx.strokeStyle = "rgba(120,140,160,0.10)"; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,H*0.5); ctx.lineTo(W,H*0.5); ctx.stroke();
    var now = Date.now(), keep = [];
    for(var i=0;i<events.length;i++){
      var e = events[i];
      var x = W - (now - e.t)*pxPerMs;
      if(x < -2) continue;
      keep.push(e);
      var half = (H*0.42)*e.h;
      ctx.strokeStyle = e.color; ctx.globalAlpha = Math.max(0.15, Math.min(1, x/W + 0.15));
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, H*0.5-half); ctx.lineTo(x, H*0.5+half); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    events = keep;
  }
  var rafId = null, paused = false, frozenAt = 0;
  function loop(){ draw(); rafId = requestAnimationFrame(loop); }
  function pause(){
    paused = true; frozenAt = Date.now();
    if(rafId){ cancelAnimationFrame(rafId); rafId = null; }
    draw();                                    // paint one last frozen frame
  }
  function resume(){
    if(!paused) return;
    var delta = Date.now() - frozenAt;         // shift events so they don't jump left
    for(var i=0;i<events.length;i++) events[i].t += delta;
    paused = false;
    if(!reduceMotion && !rafId) rafId = requestAnimationFrame(loop);
    else draw();
  }
  window.addEventListener("resize", resize);
  resize();
  if(reduceMotion){ setInterval(function(){ if(!paused) draw(); }, 400); }
  else { rafId = requestAnimationFrame(loop); }
  return {tick:tick, pause:pause, resume:resume};
})();

export const Spark = (function(){
  var cvs = document.getElementById("spark"), ctx, W, H, dpr = window.devicePixelRatio||1;
  var buf = [], MAXPTS = CFG.spark.points, MIN = CFG.spark.min, MAX = CFG.spark.max;
  function resize(){ W=cvs.clientWidth; H=cvs.clientHeight; cvs.width=W*dpr; cvs.height=H*dpr; ctx=cvs.getContext("2d"); ctx.scale(dpr,dpr); draw(); }
  function push(v){
    buf.push(v); if(buf.length>MAXPTS) buf.shift();
    document.getElementById("sv-temp").textContent = v.toFixed(1);
    draw();
  }
  function draw(){
    if(!ctx) return;
    ctx.clearRect(0,0,W,H); if(buf.length<2) return;
    var n=buf.length;
    ctx.beginPath();
    for(var i=0;i<n;i++){
      var x = (i/(n-1))*W;
      var y = H - ((buf[i]-MIN)/(MAX-MIN))*(H-6) - 3;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.strokeStyle = getVar("--signal"); ctx.lineWidth=1.5; ctx.stroke();
    var ly=H-((buf[n-1]-MIN)/(MAX-MIN))*(H-6)-3;
    ctx.fillStyle=getVar("--signal"); ctx.beginPath(); ctx.arc(W-1,ly,2,0,7); ctx.fill();
  }
  window.addEventListener("resize", resize); resize();
  return {push:push};
})();

export const Log = (function(){
  var el = document.getElementById("log"), n=0, MAX = CFG.log.maxLines;
  function pad(x){ return (x<10?"0":"")+x; }
  function add(kind, msg){
    var d = new Date(), ts = pad(d.getHours())+":"+pad(d.getMinutes())+":"+pad(d.getSeconds());
    var line = document.createElement("div");
    line.className = "l " + kind;
    line.innerHTML = '<span class="t">'+ts+'</span>  <span class="m">'+escapeHtml(msg)+'</span>';
    el.appendChild(line);
    n++; if(n>MAX){ el.removeChild(el.firstChild); n--; }
    el.scrollTop = el.scrollHeight;
  }
  return {add:add};
})();

export const UI = {
  metric:function(id,val){ document.getElementById(id).textContent = (typeof val==="number"?val.toLocaleString():val); },
  computeResult:function(d){
    document.getElementById("compute-result").innerHTML =
      "π(" + d.n.toLocaleString() + ") = <b>" + d.count.toLocaleString() + "</b> primes · " +
      d.ms + "ms · <b>" + d.ver + "</b>";
  },
  wasmProgress:function(d){
    document.getElementById("wasm-result").innerHTML =
      "wasm: mining " + d.bits + " bits… <b>" + d.hashes.toLocaleString() + "</b> hashes · <b>" +
      (d.rate/1e6).toFixed(2) + "</b> MH/s";
  },
  wasmResult:function(d){
    if(d.exhausted){
      document.getElementById("wasm-result").innerHTML = "wasm: no nonce found in 2³² space at <b>" + d.bits + "</b> bits";
      return;
    }
    document.getElementById("wasm-result").innerHTML =
      "wasm: nonce <b>" + d.nonce.toLocaleString() + "</b> · " + d.hashHex.slice(0,20) + "… · " +
      d.hashes.toLocaleString() + " hashes · " + d.ms + "ms · <b>" + (d.rate/1e6).toFixed(2) + "</b> MH/s";
  },
  wasmError:function(msg){
    document.getElementById("wasm-result").textContent = "wasm: unavailable — " + msg;
  },
  jsProgress:function(d){
    document.getElementById("js-result").innerHTML =
      "js: mining " + d.bits + " bits… <b>" + d.hashes.toLocaleString() + "</b> hashes · <b>" +
      (d.rate/1e6).toFixed(2) + "</b> MH/s";
  },
  jsResult:function(d){
    if(d.exhausted){
      document.getElementById("js-result").innerHTML = "js: no nonce found in 2³² space at <b>" + d.bits + "</b> bits";
      return;
    }
    document.getElementById("js-result").innerHTML =
      "js: nonce <b>" + d.nonce.toLocaleString() + "</b> · " + d.hashHex.slice(0,20) + "… · " +
      d.hashes.toLocaleString() + " hashes · " + d.ms + "ms · <b>" + (d.rate/1e6).toFixed(2) + "</b> MH/s";
  },
  raceStatus:function(r){
    var el = document.getElementById("race-status");
    el.classList.remove("win-wasm","win-js");
    el.classList.add(r.winner === "wasm" ? "win-wasm" : "win-js");
    el.innerHTML =
      "▸ <b>" + (r.winner === "wasm" ? "wasm" : "JS") + " wins</b> at nonce " + r.nonce.toLocaleString() +
      " — wasm <b>" + (r.wasmRate/1e6).toFixed(2) + "</b> MH/s (" + r.wasmMs + "ms) vs " +
      "JS <b>" + (r.jsRate/1e6).toFixed(2) + "</b> MH/s (" + r.jsMs + "ms) · <b>" + r.ratio.toFixed(2) + "×</b>";
  },
  renderCards:function(){
    var grid = document.getElementById("svc-grid");
    grid.innerHTML = "";
    ["clock","telemetry","compute","wasmcompute","jsminer"].forEach(function(name){
      var s = Supervisor.state[name], spec = Supervisor.specs[name], rec = Kernel.services[name];
      var host = rec ? rec.host : (spec.backend==="worker"&&workers.ok?"worker":"local");
      var el = document.createElement("div"); el.className="svc";
      var canWorker = workers.ok;
      var otherHost = host==="worker" ? "local" : "worker";
      el.innerHTML =
        '<div class="row1">'+
          '<span class="led '+s.status+'"></span>'+
          '<span class="name">'+name+'</span>'+
          '<span class="badge '+host+'" style="margin-left:auto">'+host+'</span>'+
        '</div>'+
        '<div class="status-word '+s.status+'">'+s.status+'</div>'+
        '<div class="stat-line">restarts <b>'+s.restarts+'</b>'+(name==="compute"?('  ·  ver <b>'+spec.version+'</b>'):'')+'</div>'+
        '<div class="acts">'+
          '<button class="mini warn" data-act="hang" data-svc="'+name+'">Hang</button>'+
          '<button class="mini danger" data-act="crash" data-svc="'+name+'">Crash</button>'+
          '<button class="mini" data-act="move" data-svc="'+name+'" '+((!canWorker&&otherHost==="worker")?"disabled title=\"Workers blocked in this sandbox\"":"")+'>Move → '+otherHost+'</button>'+
        '</div>';
      grid.appendChild(el);
    });
  },
  setPaused:function(p){
    var btn = document.getElementById("btn-power");
    if(btn){ btn.textContent = p ? "Play" : "Stop"; btn.classList.toggle("on", !p); btn.classList.toggle("paused", p); }
    var flag = document.getElementById("paused-flag"); if(flag) flag.style.display = p ? "inline" : "none";
    document.body.classList.toggle("paused", p);
  }
};
