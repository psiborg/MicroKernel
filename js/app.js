/* ============================================================================
   app.js — composition root (entry point)

   This is the ONLY file that knows about all the parts and the DOM. It imports
   the modules, wires them together in boot(), binds the controls, and registers
   the service worker. Reading it top-to-bottom tells you how the system is
   assembled; every module it imports stays ignorant of the others except through
   the explicit interfaces used here.

   Module graph:
     config.js      pure data (CONFIG)
     ports.js       worker/local hosts + the workers.ok flag
     services.js    the drivers (stringified into workers — no scope capture!)
     kernel.js      routing + policy        \  call-time-only cycles among
     supervisor.js  reincarnation           |  kernel / supervisor /
     instruments.js Tape/Spark/Log/UI       /  instruments / runtime
                                                (see kernel.js note)
     operator.js    privileged consumer
     runtime.js     Stop/Play + uptime
============================================================================ */

import { CONFIG as CFG } from "./config.js";
import { workers } from "./ports.js";
import { clockService, telemetryService, computeServiceV1, computeServiceV2, wasmComputeService, jsMinerService } from "./services.js";
import { Kernel } from "./kernel.js";
import { Supervisor } from "./supervisor.js";
import { Log, UI } from "./instruments.js";
import { Runtime, startUptime } from "./runtime.js";

function setModeBadge(){
  var b = document.getElementById("mode-badge");
  if(workers.ok){ b.textContent="isolation: web workers"; b.classList.remove("sim"); }
  else { b.textContent="isolation: simulated (main thread)"; b.classList.add("sim"); }
}

function boot(){
  // seed compute input from config
  var nIn = document.getElementById("n-input");
  nIn.min = CFG.compute.nMin; nIn.max = CFG.compute.nMax; nIn.value = CFG.compute.nDefault;

  // seed wasm difficulty input + resolve the .wasm URL to absolute (workers have
  // no base URL, so this must be resolved against the document before injection)
  var bIn = document.getElementById("bits-input");
  bIn.min = CFG.mine.minBits; bIn.max = CFG.mine.maxBits; bIn.value = CFG.mine.defaultBits;
  CFG.wasm.url     = new URL(CFG.wasm.file,     document.baseURI).href;
  CFG.wasm.simdUrl = new URL(CFG.wasm.simdFile, document.baseURI).href;

  // wiring: operator subscriptions + service definitions (composition happens here)
  Kernel.subscribe("operator", ["clock/tick","telemetry/reading","compute/result",
                                 "wasm/ready","wasm/error","wasm/progress","wasm/result",
                                 "js/progress","js/result","sys/control"]);
  Supervisor.define("clock",       {fn:clockService,       backend:"worker", subs:[], version:"v1"});
  Supervisor.define("telemetry",   {fn:telemetryService,   backend:"worker", subs:[], version:"v1"});
  Supervisor.define("compute",     {fn:computeServiceV1,   backend:"worker", subs:["compute/run"], version:"v1"});
  Supervisor.define("wasmcompute", {fn:wasmComputeService, backend:"worker", subs:["wasm/run","wasm/stop"], version:"v1"});
  Supervisor.define("jsminer",     {fn:jsMinerService,     backend:"worker", subs:["js/run","js/stop"], version:"v1"});

  setModeBadge();
  ["clock","telemetry","compute","wasmcompute","jsminer"].forEach(function(n){ Supervisor.spawn(n); });
  UI.renderCards();

  Log.add("sig", workers.ok
    ? "kernel online — 3 services spawned as isolated Web Workers"
    : "kernel online — Web Workers blocked by sandbox, running services on the main thread");
  Log.add("ok", "watching heartbeats; try hanging or crashing a service");

  setInterval(Supervisor.tick, CFG.supervisor.tickMs);

  startUptime();

  // watchdog: if Workers construct but never actually run, fall back to main thread
  if(workers.ok){
    setTimeout(function(){
      if(Kernel.routed === 0){
        workers.ok = false; setModeBadge();
        Log.add("sup", "no signal from workers — falling back to simulated main-thread services");
        ["clock","telemetry","compute","wasmcompute","jsminer"].forEach(function(n){
          var old = Kernel.services[n]; if(old&&old.port) old.port.terminate();
          Supervisor.specs[n].backend = "local"; Supervisor.spawn(n);
        });
        UI.renderCards();
      }
    }, CFG.supervisor.watchdogMs);
  }

  wireControls();
}

/* ---------- controls ---------- */

function readBits(){
  var raw = parseInt(document.getElementById("bits-input").value,10) || CFG.mine.defaultBits;
  return Math.max(CFG.mine.minBits, Math.min(CFG.mine.maxBits, raw));
}

function wireControls(){
  document.getElementById("btn-power").addEventListener("click", function(){ Runtime.toggle(); });

  document.getElementById("svc-grid").addEventListener("click", function(e){
    var btn = e.target.closest("button"); if(!btn) return;
    var act = btn.getAttribute("data-act"), svc = btn.getAttribute("data-svc");
    if(act === "hang"){
      Kernel.deliver(svc, "sys/stopbeat", {}); Supervisor.markCrash(svc, "soft");
      Log.add("sup", svc + " hung (stopped responding) — supervisor will notice");
    } else if(act === "crash"){
      Kernel.deliver(svc, "sys/crash", {}); Supervisor.markCrash(svc, "hard");
      Log.add("bad", svc + " crashed hard — the rest of the system is untouched");
    } else if(act === "move"){
      var cur = Kernel.services[svc].host, dest = cur==="worker" ? "local" : "worker";
      Supervisor.specs[svc].backend = dest;
      Supervisor.replace(svc);
      Log.add("sig", "relocated " + svc + " → " + ((dest==="worker"&&workers.ok)?"worker":"main thread") + " — callers unchanged");
      UI.renderCards();
    }
  });

  document.getElementById("btn-run").addEventListener("click", function(){
    var raw = parseInt(document.getElementById("n-input").value,10) || CFG.compute.nDefault;
    var n = Math.max(CFG.compute.nMin, Math.min(CFG.compute.nMax, raw));
    document.getElementById("compute-result").textContent = "computing… (watch the clock keep ticking)";
    Kernel.publish("operator", "compute/run", {n:n});
  });

  document.getElementById("btn-mine").addEventListener("click", function(){
    var bits = readBits();
    UI.soloArm("wasm");
    Kernel.publish("operator", "wasm/run", {bits:bits});
  });

  document.getElementById("btn-mine-js").addEventListener("click", function(){
    var bits = readBits();
    UI.soloArm("js");
    Kernel.publish("operator", "js/run", {bits:bits});
  });

  document.getElementById("btn-race").addEventListener("click", function(){
    var bits = readBits();
    var salt = (Math.random()*0xFFFFFFFF) >>> 0;   // ONE salt → both search the same space
    UI.raceArm(bits);
    Kernel.publish("operator", "wasm/run", {bits:bits, salt:salt});
    Kernel.publish("operator", "js/run",   {bits:bits, salt:salt});
  });

  document.getElementById("btn-supervisor").addEventListener("click", function(){
    Supervisor.enabled = !Supervisor.enabled;
    this.textContent = "Reincarnation: " + (Supervisor.enabled?"ON":"OFF");
    this.classList.toggle("on", Supervisor.enabled);
    Log.add(Supervisor.enabled?"sig":"bad", "supervisor " + (Supervisor.enabled?"enabled — crashed services will revive":"disabled — crashed services will stay dead"));
  });

  document.getElementById("btn-policy").addEventListener("click", function(){
    Kernel.policyMode = Kernel.policyMode==="strict" ? "permissive" : "strict";
    this.textContent = "Policy: " + Kernel.policyMode.toUpperCase();
    this.classList.toggle("on", Kernel.policyMode==="strict");
    Log.add("sig", "policy swapped → " + Kernel.policyMode + " (kernel routing mechanism unchanged)");
  });

  document.getElementById("btn-violate").addEventListener("click", function(){
    Kernel.deliver("telemetry", "sys/misbehave", {});
    Log.add("ok", "asked telemetry to publish sys/control — the kernel decides its fate");
  });

  document.getElementById("btn-upgrade").addEventListener("click", function(){
    var spec = Supervisor.specs.compute;
    if(spec.version === "v1"){ spec.fn = computeServiceV2; spec.version="v2"; this.textContent="Rollback compute → v1"; }
    else { spec.fn = computeServiceV1; spec.version="v1"; this.textContent="Upgrade compute → v2"; }
    Supervisor.replace("compute");
    Log.add("sig", "hot-swapped compute → " + spec.version + " with no page reload; in-flight nothing lost");
    UI.renderCards();
  });
}

/* ---------- service worker registration (PWA) ---------- */

if("serviceWorker" in navigator){
  window.addEventListener("load", function(){
    // Resolve against the document (root), not this module's URL in /js/, so the
    // worker registers at root scope and controls the whole app.
    navigator.serviceWorker.register(new URL("sw.js", document.baseURI)).catch(function(err){
      console.warn("service worker registration failed:", err);
    });
  });
}

/* ---------- go ---------- */

if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
