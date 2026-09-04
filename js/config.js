/* ============================================================================
   config.js — µkernel runtime configuration

   Single source of truth for every tunable value. Loaded before app.js.

   NOTE ON WORKERS: the values under `service` are injected into each Web Worker
   (serialized as JSON into the worker's bootstrap and exposed as `api.cfg`), so
   service functions must read timings from `api.cfg`, never from this object by
   closure — a stringified service function cannot capture outer scope.
============================================================================ */

export const CONFIG = {
  appName: "µkernel",

  /* service-internal timings — injected into workers via api.cfg */
  service: {
    heartbeatMs: 600,     // how often a service proves it is alive
    clockTickMs: 1000,    // clock service tick cadence
    telemetryMs: 800      // telemetry service emission cadence
  },

  /* supervisor / liveness — main thread only */
  supervisor: {
    deathMs: 1900,        // silence before a service is declared dead (~3 missed beats)
    tickMs: 450,          // how often liveness is evaluated
    watchdogMs: 2600      // if workers never signal, fall back to simulated mode after this
  },

  /* compute job bounds */
  compute: {
    nMin: 1000,
    nMax: 400000,
    nDefault: 150000
  },

  /* capability policy — topic prefixes each source may publish.
     This is POLICY (data); the routing MECHANISM in app.js never changes. */
  capabilities: {
    clock:     ["clock/", "sys/heartbeat"],
    telemetry: ["telemetry/", "sys/heartbeat"],
    compute:   ["compute/", "sys/heartbeat"],
    operator:  [""]        // the operator/UI is privileged
  },
  defaultPolicy: "strict", // "strict" | "permissive"

  /* instruments */
  tape:  { pxPerMs: 0.055 },
  spark: { points: 80, min: 24, max: 78 },
  log:   { maxLines: 220 }
};
