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

  /* wasm miner module locations (Rust → wasm; fetched at runtime).
     The service prefers the SIMD module and falls back to scalar when the
     browser lacks SIMD (validated via WebAssembly.validate on the bytes). */
  wasm: {
    file:     "./wasm/miner.wasm",       // scalar
    simdFile: "./wasm/miner.simd.wasm",  // 4-way SIMD
    url: "", simdUrl: ""                 // filled at boot (resolved to absolute)
  },

  /* shared SHA-256 mining parameters — used by BOTH miners so a race at the same
     difficulty+salt searches the identical space and converges on the same nonce */
  mine: {
    minBits: 8,
    maxBits: 32,              // ceiling: the target checks the top `bits` of the
                              // first hash word (needs bits<=32), and the nonce is
                              // a u32 so 2^32 is the whole search space. Past ~28
                              // the JS side takes minutes; near 32 a given salt may
                              // have no solution at all (miners report "exhausted").
    defaultBits: 20,          // ~1M expected hashes → sub-second at a few MH/s
    wasmChunk: 400000,        // hashes per cooperative slice (wasm) before yielding
    jsChunk: 120000           // smaller slice for the slower pure-JS miner
  },

  /* analyzer — a telemetry watchdog (a service that consumes another service).
     Keeps a rolling window of readings and flags anomalies + input loss. */
  analyzer: {
    window: 16,               // readings kept for the rolling mean/σ baseline
    sigma: 2.2,               // |z| above this on a new reading → "spike" alert
    staleMs: 3500             // no telemetry for this long → "input lost" alert.
                              // Deliberately > supervisor.deathMs (1900) so that
                              // with reincarnation ON telemetry heals before the
                              // analyzer trips; with it OFF, the analyzer notices.
  },

  /* capability policy — topic prefixes each source may publish.
     This is POLICY (data); the routing MECHANISM in app.js never changes. */
  capabilities: {
    clock:       ["clock/", "sys/heartbeat"],
    telemetry:   ["telemetry/", "sys/heartbeat"],
    compute:     ["compute/", "sys/heartbeat"],
    wasmcompute: ["wasm/", "sys/heartbeat"],
    jsminer:     ["js/", "sys/heartbeat"],
    analyzer:    ["analyzer/", "sys/heartbeat"],
    operator:    [""]        // the operator/UI is privileged
  },
  defaultPolicy: "strict", // "strict" | "permissive"

  /* instruments */
  tape:  { pxPerMs: 0.055 },
  spark: { points: 80, min: 24, max: 78 },
  log:   { maxLines: 220 }
};
