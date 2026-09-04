/* ============================================================================
   supervisor.js — the reincarnation server

   Heartbeat-checks every service; a service that stops beating past deathMs is
   terminated and respawned. spawn() is also the seam that wires a fresh port's
   onmessage to Kernel.ingress. The kernel↔supervisor cycle is intentional and
   call-time-only (see kernel.js note). tick() is guarded by Runtime.running so a
   paused system isn't read as a dead one.
============================================================================ */

import { CONFIG as CFG } from "./config.js";
import { Kernel } from "./kernel.js";
import { workers, makeWorkerPort, makeLocalPort } from "./ports.js";
import { Tape, Log, UI } from "./instruments.js";
import { Runtime } from "./runtime.js";

export const Supervisor = {
  enabled:true, specs:{}, state:{}, restarts:0,

  define:function(name, spec){
    Supervisor.specs[name] = spec;
    Supervisor.state[name] = {status:"restarting", lastBeat:Date.now(), restarts:0};
    if(spec.subs) Kernel.subscribe(name, spec.subs);
  },
  spawn:function(name){
    var spec = Supervisor.specs[name];
    var useWorker = (spec.backend === "worker") && workers.ok;
    var port = useWorker ? makeWorkerPort(name, spec.fn, CFG) : makeLocalPort(name, spec.fn, CFG);
    port.onmessage = function(m){ Kernel.ingress(name, m); };
    Kernel.register(name, {port:port, host:useWorker?"worker":"local"});
    Supervisor.state[name].lastBeat = Date.now();
    Supervisor.state[name].status = "alive";
    UI.renderCards();
  },
  replace:function(name){                       // graceful in-place swap (hot swap / relocate)
    var old = Kernel.services[name];
    Supervisor.spawn(name);                      // register the new port first...
    if(old && old.port) old.port.terminate();    // ...then retire the old one
  },
  beat:function(name){
    var s = Supervisor.state[name]; if(!s) return;
    s.lastBeat = Date.now();
    if(s.status === "restarting" || s.status === "hung" || s.status === "crashed"){ s.status="alive"; UI.renderCards(); }
  },
  markCrash:function(name, kind){
    var s = Supervisor.state[name]; if(!s) return;
    s.status = (kind === "hard") ? "crashed" : "hung"; UI.renderCards();
  },
  tick:function(){
    if(!Runtime.running) return;               // frozen: don't mistake paused for dead
    var now = Date.now();
    Object.keys(Supervisor.specs).forEach(function(name){
      var s = Supervisor.state[name];
      if(now - s.lastBeat > CFG.supervisor.deathMs){
        if(!Supervisor.enabled){
          if(s.status !== "dead"){ s.status="dead"; Log.add("bad", name + " is unresponsive — no supervisor to revive it"); UI.renderCards(); }
          return;
        }
        s.status = "restarting"; s.restarts++; Supervisor.restarts++;
        UI.metric("m-restarts", Supervisor.restarts);
        Tape.tick("sup");
        Log.add("sup", "supervisor: " + name + " missed its heartbeat → reincarnating");
        var old = Kernel.services[name];
        if(old && old.port) old.port.terminate();
        Supervisor.spawn(name);
      }
    });
  }
};
