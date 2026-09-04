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
    else if(topic === "sys/control"){
      Log.add("sig", "operator received sys/control from " + src + " (policy is permissive)");
    }
  }
};
