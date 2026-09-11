/* ============================================================================
   guide.js — the welcome dialog (About / Tutorial / Reference tabs).

   Opens automatically on first visit (remembered in localStorage) and via the
   header "guide" button any time. Pure DOM glue — it has no dependency on the
   kernel or services, so it can init before or after boot without ordering care.
============================================================================ */

var SEEN_KEY = "ukernel.guide.seen";

function seen(){
  try { return localStorage.getItem(SEEN_KEY) === "1"; }
  catch(e){ return false; }                 // private mode / file:// — just show it
}
function markSeen(){
  try { localStorage.setItem(SEEN_KEY, "1"); }
  catch(e){ /* storage unavailable — dialog will simply open each visit */ }
}

function select(name){
  var tabs  = document.querySelectorAll(".modal-tab");
  var panes = document.querySelectorAll(".tab-pane");
  var i;
  for(i=0;i<tabs.length;i++)  tabs[i].classList.toggle("active",  tabs[i].getAttribute("data-tab")  === name);
  for(i=0;i<panes.length;i++) panes[i].classList.toggle("active", panes[i].getAttribute("data-pane") === name);
  var body = document.querySelector(".modal-body");
  if(body) body.scrollTop = 0;              // reset scroll when switching tabs
}

function show(tab){
  var overlay = document.getElementById("guide-overlay");
  if(!overlay) return;
  if(tab) select(tab);
  overlay.hidden = false;
}
function hide(){
  var overlay = document.getElementById("guide-overlay");
  if(overlay) overlay.hidden = true;
  markSeen();
}

export const Guide = {
  init:function(){
    var overlay = document.getElementById("guide-overlay");
    if(!overlay) return;

    var tabs = document.querySelectorAll(".modal-tab");
    for(var i=0;i<tabs.length;i++){
      (function(t){ t.addEventListener("click", function(){ select(t.getAttribute("data-tab")); }); })(tabs[i]);
    }

    var openBtn = document.getElementById("guide-open");
    if(openBtn) openBtn.addEventListener("click", function(){ show("about"); });

    var xBtn = document.getElementById("guide-close");
    if(xBtn) xBtn.addEventListener("click", hide);

    var goBtn = document.getElementById("guide-go");
    if(goBtn) goBtn.addEventListener("click", hide);

    // click the dimmed backdrop (but not the dialog itself) to dismiss
    overlay.addEventListener("click", function(e){ if(e.target === overlay) hide(); });
    // Esc closes when open
    document.addEventListener("keydown", function(e){ if(e.key === "Escape" && !overlay.hidden) hide(); });

    if(!seen()) show("about");               // first-visit welcome
  },
  open:function(tab){ show(tab || "about"); },
  close:function(){ hide(); }
};
