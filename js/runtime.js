/* ============================================================================
   runtime.js — master Stop/Play + the pausable uptime clock

   pause() freezes the whole system: it sends sys/pause to every service (gated
   at the port), freezes the tape and uptime, and the supervisor's tick() (in
   supervisor.js) bails while running is false. resume() reverses it and resets
   every lastBeat so nothing is falsely reincarnated across the gap.
============================================================================ */

import { Kernel } from "./kernel.js";
import { Supervisor } from "./supervisor.js";
import { Tape, Log, UI } from "./instruments.js";

var uptimeBase = 0, uptimeTimer = null;
function renderUptime(){
  var s = Math.floor((Date.now()-uptimeBase)/1000);
  document.getElementById("m-uptime").textContent = s<60 ? s+"s" : Math.floor(s/60)+"m "+(s%60)+"s";
}
export function startUptime(){
  uptimeBase = Date.now();
  if(uptimeTimer) clearInterval(uptimeTimer);
  uptimeTimer = setInterval(renderUptime, 1000);
  renderUptime();
}

export const Runtime = {
  running:true, pauseStart:0,

  pause:function(){
    if(!this.running) return;
    this.running = false;
    // freeze every service by gating its output at the port (no code change in services)
    Object.keys(Kernel.services).forEach(function(n){
      var r = Kernel.services[n]; if(r && r.port) r.port.postMessage({src:"operator", topic:"sys/pause", data:{}});
    });
    clearInterval(uptimeTimer); this.pauseStart = Date.now();   // freeze uptime
    Tape.pause();
    UI.setPaused(true);
    Log.add("sup", "runtime stopped — services, supervisor, tape, and uptime are frozen");
  },

  resume:function(){
    if(this.running) return;
    var now = Date.now();
    // reset heartbeat clocks so the supervisor doesn't read the freeze as death
    Object.keys(Supervisor.state).forEach(function(n){ Supervisor.state[n].lastBeat = now; });
    Object.keys(Kernel.services).forEach(function(n){
      var r = Kernel.services[n]; if(r && r.port) r.port.postMessage({src:"operator", topic:"sys/resume", data:{}});
    });
    uptimeBase += (Date.now() - this.pauseStart);               // resume uptime where it stopped
    uptimeTimer = setInterval(renderUptime, 1000);
    Tape.resume();
    this.running = true;
    UI.setPaused(false);
    Log.add("sig", "runtime playing — services resumed where they left off");
  },

  toggle:function(){ this.running ? this.pause() : this.resume(); }
};
