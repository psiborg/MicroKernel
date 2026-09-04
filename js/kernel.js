/* ============================================================================
   kernel.js — routing (mechanism) + capability policy

   The kernel is deliberately dumb: it routes published messages to subscribers
   and asks the policy whether a publish is allowed. It learns about services
   only through register()/subscribe() — it never imports services.js. That
   ignorance IS the microkernel property; you can see it in the import list.

   Intentional import cycles (all safe): every cross-module reference below lives
   inside a METHOD body and runs at call time, never at module-evaluation time,
   so kernel↔supervisor and kernel↔instruments cycles resolve fine.
============================================================================ */

import { CONFIG as CFG } from "./config.js";
import { Supervisor } from "./supervisor.js";
import { Operator } from "./operator.js";
import { Tape, Log, UI } from "./instruments.js";

export const Kernel = {
  subs:{}, services:{}, routed:0, rejected:0,
  policyMode: CFG.defaultPolicy,

  subscribe:function(name, topics){ topics.forEach(function(t){ (Kernel.subs[t]||(Kernel.subs[t]=[])).push(name); }); },
  register:function(name, rec){ Kernel.services[name] = rec; },

  // capability check — POLICY. Mechanism below never changes.
  allow:function(src, topic){
    if(Kernel.policyMode === "permissive") return true;
    var allowed = CFG.capabilities[src] || [];
    return allowed.some(function(p){ return topic.indexOf(p) === 0; });
  },

  ingress:function(src, msg){
    var topic = msg.topic, data = msg.data;
    if(topic === "sys/heartbeat"){ Supervisor.beat(src); Tape.tick("beat"); return; }

    if(!Kernel.allow(src, topic)){
      Kernel.rejected++; UI.metric("m-rejects", Kernel.rejected);
      Tape.tick("deny");
      Log.add("bad", src + " → " + topic + "  DENIED by policy");
      return;
    }
    Kernel.routed++; UI.metric("m-msgs", Kernel.routed);
    Tape.tick(topic.indexOf("sys/")===0 ? "sys" : "app");

    var targets = Kernel.subs[topic] || [];
    targets.forEach(function(name){
      if(name === "operator"){ Operator.receive(src, topic, data); return; }
      var rec = Kernel.services[name];
      if(rec && rec.port) rec.port.postMessage({src:src, topic:topic, data:data});
    });
  },

  deliver:function(name, topic, data){         // privileged direct control channel
    var rec = Kernel.services[name];
    if(rec && rec.port){ rec.port.postMessage({src:"operator", topic:topic, data:data}); Tape.tick("sys"); }
  },
  publish:function(src, topic, data){ Kernel.ingress(src, {topic:topic, data:data}); }
};
