/* ============================================================================
   operator.js — the privileged consumer / UI-facing pseudo-service

   Subscribes (via the kernel, wired in app.js boot) to the app's output topics
   and drives the instruments. It publishes control messages but does not import
   the kernel — the operator is a data sink here, so no cycle with kernel.js.
============================================================================ */

import { Spark, UI, Log } from "./instruments.js";

/* race tracking: when a wasm result and a js result arrive for the SAME salt,
   they solved the identical problem — declare a winner and the speed ratio. */
var race = { wasm:null, js:null };
function noteRace(kind, d){
  if(d.exhausted) return;
  race[kind] = d;
  var w = race.wasm, j = race.js;
  if(w && j && w.salt === j.salt){
    var winner = (w.ms <= j.ms) ? "wasm" : "js";
    var ratio  = (winner === "wasm") ? (w.rate / (j.rate||1)) : (j.rate / (w.rate||1));
    UI.raceStatus({ winner:winner, ratio:ratio, nonce:w.nonce,
                    wasmRate:w.rate, jsRate:j.rate, wasmMs:w.ms, jsMs:j.ms });
    Log.add("sig", "race @ " + w.bits + " bits: " + winner + " wins — wasm " +
            (w.rate/1e6).toFixed(2) + " vs JS " + (j.rate/1e6).toFixed(2) + " MH/s (" + ratio.toFixed(2) + "×)");
    race.wasm = null; race.js = null;
  }
}

export const Operator = {
  receive:function(src, topic, data){
    if(topic === "clock/tick"){ /* liveness only */ }
    else if(topic === "telemetry/reading"){ Spark.push(data.temp); }
    else if(topic === "compute/result"){
      UI.computeResult(data);
      Log.add("pulse", "compute("+data.ver+"): " + data.count.toLocaleString() + " primes ≤ " + data.n.toLocaleString() + " in " + data.ms + "ms");
    }
    else if(topic === "wasm/ready"){ UI.wasmMode(data.mode); Log.add("sig", "wasmcompute: " + (data.mode === "simd" ? "SIMD ×4" : "scalar") + " miner instantiated"); }
    else if(topic === "wasm/error"){ Log.add("bad", "wasmcompute: wasm unavailable — " + data.msg); UI.wasmError(data.msg); }
    else if(topic === "wasm/progress"){ UI.wasmProgress(data); }
    else if(topic === "wasm/result"){
      UI.wasmResult(data);
      if(data.exhausted) Log.add("bad", "wasmcompute: search space exhausted at difficulty " + data.bits);
      else Log.add("pulse", "wasm mine: nonce " + data.nonce.toLocaleString() + " → " + data.hashHex.slice(0,16) + "… (" + data.bits + " bits, " + (data.rate/1e6).toFixed(2) + " MH/s)");
      noteRace("wasm", data);
    }
    else if(topic === "js/progress"){ UI.jsProgress(data); }
    else if(topic === "js/result"){
      UI.jsResult(data);
      if(data.exhausted) Log.add("bad", "jsminer: search space exhausted at difficulty " + data.bits);
      else Log.add("pulse", "js mine: nonce " + data.nonce.toLocaleString() + " → " + data.hashHex.slice(0,16) + "… (" + data.bits + " bits, " + (data.rate/1e6).toFixed(2) + " MH/s)");
      noteRace("js", data);
    }
    else if(topic === "sys/control"){
      Log.add("sig", "operator received sys/control from " + src + " (policy is permissive)");
    }
  }
};
