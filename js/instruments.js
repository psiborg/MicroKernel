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

/* FC — the JS-vs-WASM fight card. Tracks each corner's live hashrate, sizes the
   two bars relative to the faster one, and renders the KO/decision verdict. */
const FC = (function(){
  var s = { js:{rate:0}, wasm:{rate:0} };
  function el(id){ return document.getElementById(id); }
  function bars(){
    var mx = Math.max(s.js.rate, s.wasm.rate, 1);
    el("fc-js-bar").style.width   = (100*s.js.rate/mx).toFixed(1) + "%";
    el("fc-wasm-bar").style.width = (100*s.wasm.rate/mx).toFixed(1) + "%";
    el("fc-js-rate").textContent   = (s.js.rate/1e6).toFixed(2);
    el("fc-wasm-rate").textContent = (s.wasm.rate/1e6).toFixed(2);
  }
  function clearWin(){ el("fc-corner-js").classList.remove("winner"); el("fc-corner-wasm").classList.remove("winner"); }
  function arm(bits){
    s.js.rate = 0; s.wasm.rate = 0; clearWin();
    el("fc-belt").textContent = bits + " bits on the line";
    el("fc-verdict").textContent = "round in progress";
    el("fc-mid").classList.add("live");
    el("fc-js-sub").textContent = "hashing…"; el("fc-wasm-sub").textContent = "hashing…";
    bars();
  }
  function solo(kind){
    clearWin(); el("fc-mid").classList.remove("live");
    el("fc-verdict").textContent = kind + " solo run";
    el("fc-" + kind + "-sub").textContent = "hashing…";
    s[kind].rate = 0; bars();
  }
  function update(kind, rate, hashes, sub){ s[kind].rate = rate; el("fc-" + kind + "-sub").textContent = sub; bars(); }
  function done(kind, rate, sub){ s[kind].rate = rate; el("fc-" + kind + "-sub").textContent = sub; bars(); }
  function verdict(r){
    el("fc-mid").classList.remove("live");
    clearWin();
    el("fc-corner-" + r.winner).classList.add("winner");
    var how = r.ratio >= 3 ? "by KO" : r.ratio >= 1.8 ? "by TKO"
            : r.ratio >= 1.25 ? "unanimous decision" : "split decision";
    el("fc-verdict").innerHTML = "<b>" + (r.winner === "wasm" ? "WASM" : "JS") + " wins</b> " + how +
      " · " + r.ratio.toFixed(2) + "×";
    el("fc-belt").textContent = "nonce " + r.nonce.toLocaleString();
  }
  return { arm:arm, solo:solo, update:update, done:done, verdict:verdict };
})();

export const UI = {
  metric:function(id,val){ document.getElementById(id).textContent = (typeof val==="number"?val.toLocaleString():val); },
  computeResult:function(d){
    document.getElementById("compute-result").innerHTML =
      "π(" + d.n.toLocaleString() + ") = <b>" + d.count.toLocaleString() + "</b> primes · " +
      d.ms + "ms · <b>" + d.ver + "</b>";
  },
  // ---- fight card ----
  wasmMode:function(mode){
    document.getElementById("fc-wasm-tech").textContent =
      (mode === "simd") ? "Rust → wasm · SIMD ×4" : "Rust → wasm · scalar";
  },
  wasmProgress:function(d){ FC.update("wasm", d.rate, d.hashes, d.bits + " bits · " + d.hashes.toLocaleString() + " H"); },
  jsProgress:function(d){   FC.update("js",   d.rate, d.hashes, d.bits + " bits · " + d.hashes.toLocaleString() + " H"); },
  wasmResult:function(d){
    if(d.exhausted){ FC.done("wasm", 0, "no nonce ≤ 2³²"); return; }
    FC.done("wasm", d.rate, "nonce " + d.nonce.toLocaleString() + " · " + d.ms + "ms · " + d.hashHex.slice(0,12) + "…");
  },
  jsResult:function(d){
    if(d.exhausted){ FC.done("js", 0, "no nonce ≤ 2³²"); return; }
    FC.done("js", d.rate, "nonce " + d.nonce.toLocaleString() + " · " + d.ms + "ms · " + d.hashHex.slice(0,12) + "…");
  },
  wasmError:function(msg){ FC.done("wasm", 0, "unavailable — " + msg); },
  raceArm:function(bits){ FC.arm(bits); },
  soloArm:function(kind){ FC.solo(kind); },
  raceStatus:function(r){ FC.verdict(r); },
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
