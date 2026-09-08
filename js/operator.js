/* ============================================================================
   operator.js — the privileged consumer / UI-facing pseudo-service

   Subscribes (via the kernel, wired in app.js boot) to the app's output topics
   and drives the instruments. It publishes control messages but does not import
   the kernel — the operator is a data sink here, so no cycle with kernel.js.
============================================================================ */

import { Spark, UI, Log } from "./instruments.js";

export const Operator = {
  receive:function(src, topic, data){
    if(topic === "clock/tick"){ /* liveness only */ }
    else if(topic === "telemetry/reading"){ Spark.push(data.temp); }
    else if(topic === "compute/result"){
      UI.computeResult(data);
      Log.add("pulse", "compute("+data.ver+"): " + data.count.toLocaleString() + " primes ≤ " + data.n.toLocaleString() + " in " + data.ms + "ms");
    }
    else if(topic === "wasm/ready"){ Log.add("sig", "wasmcompute: miner.wasm instantiated"); }
    else if(topic === "wasm/error"){ Log.add("bad", "wasmcompute: wasm unavailable — " + data.msg); UI.wasmError(data.msg); }
    else if(topic === "wasm/progress"){ UI.wasmProgress(data); }
    else if(topic === "wasm/result"){
      UI.wasmResult(data);
      if(data.exhausted) Log.add("bad", "wasmcompute: search space exhausted at difficulty " + data.bits);
      else Log.add("pulse", "wasm mine: nonce " + data.nonce.toLocaleString() + " → " + data.hashHex.slice(0,16) + "… (" + data.bits + " bits, " + (data.rate/1e6).toFixed(2) + " MH/s)");
    }
    else if(topic === "sys/control"){
      Log.add("sig", "operator received sys/control from " + src + " (policy is permissive)");
    }
  }
};
