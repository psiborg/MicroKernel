# µkernel — a microkernel-style web runtime

A small, dependency-free, installable PWA that ports the core ideas of a
microkernel operating system (in the QNX tradition) into the browser. It exists
to make those ideas **visible and pokeable**: you can stop and restart the whole
system, crash a service and watch a supervisor reincarnate it, hot-swap a running
component, relocate it across an isolation boundary, and see every message that
crosses the kernel drawn live on an oscilloscope-style tape.

It is a teaching model, not a framework. The value is in reading the commented
code and mapping each part to a concept you can trigger from the UI.

---

## The thesis

A monolithic system wires components together with direct function calls in one
shared address space: fast, but a fault anywhere can take down everything. A
**microkernel** keeps a tiny trusted core and pushes everything else — drivers,
services — into isolated processes that communicate only by passing messages
through the core. You trade a little speed (messages cost more than a call) for
fault isolation, least privilege, hot upgrades, and location transparency.

Every one of those trade-offs has a native browser analogue, and this app wires
them together into one working system:

| Microkernel idea | Browser mechanism used here |
|---|---|
| Message passing over shared state | `postMessage` across a worker boundary; a pub/sub kernel |
| Fault isolation ("let it crash") | Each service is a Web Worker; one can die alone |
| Supervision / self-healing | A heartbeat-driven supervisor that terminates and respawns |
| Least privilege | A capability policy the kernel enforces on every publish |
| Location transparency | Identical port interface for worker-hosted and main-thread services |
| Hot swap without reboot | Replace a running service's code in place, no page reload |
| Mechanism vs. policy | Fixed routing core; swappable permission rules |

---

## Project layout

```
index.html            markup + PWA head (loads js/app.js as a module)
manifest.json         PWA manifest (installability)         ← root (see PWA notes)
sw.js                 service worker: precache + SWR         ← root (scope reason)
css/
  app.css             all styles
icons/
  favicon.png · icon-192.png · icon-512.png · icon-maskable-512.png
js/
  config.js           every tunable value (export const CONFIG)
  ports.js            worker/local hosts + the workers.ok flag + pause gate
  services.js         the drivers (stringified into workers — no scope capture!)
  kernel.js           routing + capability policy
  supervisor.js       reincarnation server
  operator.js         privileged consumer / UI-facing pseudo-service
  instruments.js      Tape, Spark, Log, UI
  runtime.js          Stop/Play + the pausable uptime clock
  app.js              composition root: imports, boot, controls, SW registration
wasm/
  miner.wasm          prebuilt scalar SHA-256 miner (fetched at runtime, precached)
  miner.simd.wasm     prebuilt 4-way SIMD miner (preferred; scalar is the fallback)
  src/lib.rs          canonical Rust source, scalar · Cargo.toml · build.sh
  src/simd.rs         canonical Rust source, SIMD (build with +simd128)
  miner.c             scalar C twin · miner_simd.c  SIMD C twin · README.md (ABI)
```

There is no build step and nothing to install as a dependency — it's vanilla
ES modules, HTML, and CSS. `index.html` loads a single
`<script type="module" src="./js/app.js">`; `app.js` imports the rest.
`sw.js` and `manifest.json` stay at the **root** on purpose (see *PWA notes*).

---

## Quick start

Serve the folder over `http`/`localhost` (a service worker and web app manifest
will not activate from `file://`):

```
python3 -m http.server        # then open http://localhost:8000/
# or: npx serve
```

Opening `index.html` directly via `file://` still runs the app — the service
worker registration is feature-detected and skipped, so you just don't get
install/offline. Everything else works.

Once served, the app is installable (Add to Home Screen / install icon) and works
offline after the first load.

### Isolation modes

The badge in the top-right tells you the truth about how services are hosted:

- **`isolation: web workers`** — services run in real Web Workers, i.e. separate
  threads with their own memory. This is the honest version of fault isolation.
- **`isolation: simulated (main thread)`** — some sandboxes (including certain
  embedded iframes) block `Blob`-URL workers. When that happens the runtime
  transparently hosts the same service code on the main thread behind an
  identical port interface, so the demo still runs. There is also a watchdog
  (`CONFIG.supervisor.watchdogMs`, 2.6 s): if workers construct but never emit a
  message, the runtime falls back automatically.

That fallback isn't a workaround bolted on the side — it *is* the
location-transparency lesson. The kernel and supervisor never learn which host a
service uses.

---

## Walkthrough: what to do and what to watch

The controls are grouped in the **Control room** and on each service card. In
rough order:

1. **Stop / Play** (top of the control room). Freezes the *entire* runtime —
   every service, the supervisor, the tape, and the uptime counter — then resumes
   it exactly where it left off. Think of it as pausing an oscilloscope. While
   stopped, the button turns amber, the tape dims, and a `· PAUSED` marker shows
   on the tape label.
2. **Hang** or **Crash** a service (card buttons). *Hang* stops its heartbeats
   (a wedged driver); *Crash* terminates it outright. Either way the LED goes
   amber/red, heartbeats stop, and within ~2 s the supervisor terminates and
   respawns it — an amber spike appears on the bus tape and the reincarnation
   counter increments. The other two services never flinch.
3. **Reincarnation: OFF**, then crash something. It stays dead. Turn supervision
   back on to feel exactly what it buys you.
4. **Run** with N up to 400,000. The prime count runs inside the compute worker
   while the clock keeps ticking — the main thread never blocks. In simulated
   mode you'll feel the clock stutter, which is *why* real isolation matters.
5. **Race** at a difficulty (leading zero bits). The head-to-head panel pits
   `wasmcompute` (Rust→wasm, **SIMD ×4**) against `jsminer` (pure JS): both hash
   the **same** SHA-256 PoW from the **same** salt, converge on the **same
   nonce**, and show a **live hashrate** on each side. Each runs in its own Worker
   (a genuine parallel race on separate cores); the verdict names the winner and
   the margin (from a photo finish up to a runaway) with the speed ratio. SIMD
   typically wins ~3–4× — but `wasm solo` / `JS solo` and the scalar fallback show
   why that gap is all about SIMD; see
   [The WebAssembly service](#the-webassembly-service).
6. **Upgrade compute → v2**. The service's code is swapped in place (trial
   division → sieve), the version badge flips, and no page reload happens. Run a
   job before and after to compare timings.
7. **Move → worker/local** on any card. Callers address the service by topic, so
   nothing else changes. That's location transparency.
8. **Provoke violation**. Telemetry tries to publish a `sys/control` message.
   Under **Strict** policy the kernel denies it (red tick on the tape, a
   `DENIED` log line). Flip to **Permissive** and the identical message flows.
   Same mechanism, different policy.

---

## Architecture

Four parts, mirroring a microkernel OS. All of them except the services live on
the main thread.

```
                       ┌─────────────────────────────────────────┐
   operator / UI ────► │                 KERNEL                  │
   (privileged)        │   pub/sub routing  +  capability policy │
        ▲              │   (mechanism)          (policy)         │
        │              └───┬──────────────┬──────────────┬───────┘
        │ renders          │ postMessage  │              │
        │                  ▼              ▼              ▼
        │            ┌──────────┐   ┌──────────┐   ┌──────────┐
        │            │  clock   │   │telemetry │   │ compute  │   ← services
        │            │ (Worker) │   │ (Worker) │   │ (Worker) │     (isolated)
        │            └────┬─────┘   └────┬─────┘   └────┬─────┘
        │   heartbeats    │              │              │
        │                 ▼              ▼              ▼
        │              ┌─────────────────────────────────────────┐
        └───────────── │              SUPERVISOR                 │
                       │  heartbeat watch → terminate → respawn  │
                       └─────────────────────────────────────────┘
```

### Kernel

The kernel is deliberately dumb. It knows how to route messages and how to ask
the policy whether a publish is allowed. It knows nothing about what any service
actually does. Its whole surface:

- `subscribe(name, topics)` — register interest in topics (pub/sub table).
- `register(name, record)` — record a service's live port.
- `allow(src, topic)` — the capability check. This is the **policy** (reads
  `CONFIG.capabilities`); everything else is **mechanism**.
- `ingress(src, msg)` — a service published something. The kernel intercepts
  `sys/heartbeat` (hands it to the supervisor), runs the policy check, then fans
  the message out to every subscriber. `src` is the port's *registered* name, not
  a value the service supplied, so a service cannot spoof another's identity —
  the kernel is the trust boundary.
- `deliver(name, topic, data)` — a privileged direct channel used by the
  operator/supervisor to send control messages to one service.
- `publish(src, topic, data)` — thin wrapper over `ingress` for the operator.

### Services

Five isolated "drivers":

- **clock** — emits `clock/tick` once a second. Pure liveness.
- **telemetry** — emits `telemetry/reading` (~800 ms) that feeds the sparkline.
- **compute** — on `compute/run {n}` counts primes ≤ n and replies with
  `compute/result`. Ships in two versions for the hot-swap demo.
- **wasmcompute** — on `wasm/run {bits}` mines SHA-256 proof-of-work in a real
  `.wasm` module (fetched at runtime), replying with `wasm/progress` (live
  hashrate) and `wasm/result` (winning nonce + hash). Prefers a **4-way SIMD**
  module and falls back to scalar when the browser lacks SIMD.
- **jsminer** — the *identical* SHA-256 PoW in pure JavaScript, on `js/run`. It
  exists to race `wasmcompute` on the same tape; see
  [The WebAssembly service](#the-webassembly-service).

Every service also emits `sys/heartbeat` (interval from `CONFIG.service`). Stop
the heartbeats and the supervisor concludes the service is gone.

### Supervisor (the reincarnation server)

A main-thread loop (`Supervisor.tick`, `CONFIG.supervisor.tickMs`) that tracks
the last heartbeat per service. If a service hasn't beaten in
`CONFIG.supervisor.deathMs` (~3 missed beats) and supervision is enabled, it
terminates the old port and spawns a fresh one. With supervision disabled, a dead
service simply stays dead — the contrast is the point.

`Supervisor.replace(name)` is the graceful path used by hot-swap and relocate: it
spawns the *new* port first, registers it, then terminates the old one, so there
is no window with no service registered.

### Operator / UI

A privileged pseudo-service (`src: "operator"`) that subscribes to the app
topics, renders the instruments (tape, sparkline, log, cards, counters), and
issues control messages. It stands in for "the part of the system that's allowed
to do anything," analogous to a privileged process in an OS.

### Runtime (master Stop/Play)

`Runtime.pause()` / `Runtime.resume()` freeze and thaw the whole system. Pause is
enforced at the **port layer**, not inside the services: a `sys/pause` control
message flips a flag in each port that gates `api.post`, so a frozen service emits
nothing (not even heartbeats). Because that would otherwise look like death, the
supervisor's tick is guarded by `Runtime.running`, and on resume every service's
`lastBeat` is reset so nothing is falsely reincarnated. The tape freezes on its
last frame and shifts its buffered event timestamps forward by the paused
duration so ticks don't jump; the uptime counter offsets its base likewise.
Services need no pause code of their own — freezing is a runtime concern.

---

## Module architecture

The four conceptual parts above are split across ES modules, plus two that don't
fold cleanly into the four (the **ports**, i.e. the worker/local duality, and the
**instruments**, i.e. Tape/Spark/Log/UI). The split is deliberate: the file
dependency graph is a second, honest diagram of the architecture — one that
can't drift from the code.

```
config.js   (pure data, no imports)
   ▲
   ├── ports.js        (no domain imports; constructed from name/fn/cfg)
   ├── services.js     (no imports; stringified into workers)
   │
   kernel.js ⇄ supervisor.js ⇄ instruments.js ⇄ runtime.js
        └────────── operator.js (imports instruments only)
   ▲
app.js  (composition root — imports everything, wires it in boot())
```

Three things are worth internalising before editing:

- **`app.js` is the composition root.** It is the only module that knows about
  all the parts and the DOM. All *wiring* happens in its `boot()` —
  `Kernel.subscribe("operator", …)` and the three `Supervisor.define(…)` calls
  live there, not at module top-level. Reading `app.js` top-to-bottom tells you
  how the system is assembled; every other module stays ignorant of the rest
  except through the interfaces used here. Notably, `kernel.js` does **not**
  import `services.js` — the kernel is service-agnostic, and you can see that in
  its import list.

- **The cycles are intentional and call-time-only.** `kernel ⇄ supervisor`,
  `kernel ⇄ instruments`, and `supervisor ⇄ runtime` are genuine import cycles.
  ES modules permit this as long as no module *uses* a circular import at
  module-evaluation time — and here every cross-module reference lives inside a
  method body that runs later, never at the top level. Don't "fix" a cycle by
  inlining; it's fine.

- **`workers.ok` is a mutable field, not an exported variable.** An imported
  binding is read-only for importers, but the watchdog needs to flip worker
  availability at runtime — so `ports.js` exports a small holder object
  (`workers.ok`) rather than a bare `let`.

All tunables live in `CONFIG`, an ES-module export (`export const CONFIG` in
`js/config.js`), grouped by concern: `service` (per-service timings), `supervisor`
(liveness), `compute` (job bounds), `capabilities` + `defaultPolicy` (the policy),
and instrument settings (`tape`, `spark`, `log`). Modules that need it
`import { CONFIG } from "./config.js"`.

One subtlety drives the shape of this file. The values under `CONFIG.service`
are needed *inside* the workers, but a service function is serialized with
`Function.prototype.toString()` and cannot capture outer scope. So the runtime
injects the config into each worker as JSON and exposes it as `api.cfg`; service
functions read timings from `api.cfg.service.*`, never from `CONFIG` directly.
Everything else in `CONFIG` is read on the main thread. This is why both
`config.js` and `services.js` carry comments warning against closing over config
from a service.

### Tuning constants

| Key | Default | Meaning |
|---|---|---|
| `service.heartbeatMs` | 600 ms | how often a service proves it's alive |
| `service.clockTickMs` | 1000 ms | clock tick cadence |
| `service.telemetryMs` | 800 ms | telemetry emission cadence |
| `supervisor.deathMs` | 1900 ms | silence before the supervisor declares death |
| `supervisor.tickMs` | 450 ms | how often liveness is evaluated |
| `supervisor.watchdogMs` | 2600 ms | fall back to simulated mode if workers never signal |
| `compute.nMin / nMax / nDefault` | 1000 / 400000 / 150000 | prime-count bounds and default |
| `wasm.file / simdFile` | `./wasm/miner.wasm` / `.simd.wasm` | scalar / SIMD module paths (resolved to absolute in boot) |
| `mine.defaultBits / minBits / maxBits` | 20 / 8 / 26 | shared mining difficulty (leading zero bits) |
| `mine.wasmChunk / jsChunk` | 400000 / 120000 | hashes per cooperative slice (wasm / JS) |
| `capabilities` | (per service) | topic prefixes each source may publish |
| `defaultPolicy` | `"strict"` | starting policy mode |
| `tape.pxPerMs` | 0.055 | bus-tape scroll speed |
| `spark.points / min / max` | 80 / 24 / 78 | sparkline window and scale |
| `log.maxLines` | 220 | event-log ring size |

**Design tension worth understanding:** a service computing synchronously can't
emit heartbeats while it's busy. Push N high enough and a *legitimately working*
compute service can look "hung" to the supervisor and get reincarnated
mid-job — a real-world microkernel problem (a busy driver vs. a wedged one). The
N clamp keeps the default demo under `deathMs`. Real systems solve this with
separate watchdog channels, cooperative yielding, or work-in-progress pings;
adding one is a good exercise.

---

## Message flow and topics

Everything is a published message on a topic. There are no direct calls between
components.

| Topic | Published by | Subscribed by | Purpose |
|---|---|---|---|
| `clock/tick` | clock | operator | liveness heartbeat for the UI |
| `telemetry/reading` | telemetry | operator | `{temp, load}` for the sparkline |
| `compute/run` | operator | compute | `{n}` request to count primes |
| `compute/result` | compute | operator | `{n, count, ms, ver}` reply |
| `wasm/run` | operator | wasmcompute | `{bits, salt?}` request to mine at a difficulty |
| `wasm/progress` | wasmcompute | operator | `{hashes, rate, bits}` live hashrate |
| `wasm/result` | wasmcompute | operator | `{nonce, hashHex, bits, salt, hashes, ms, rate}` |
| `wasm/ready` | wasmcompute | operator | module instantiated |
| `wasm/error` | wasmcompute | operator | `{msg}` module fetch/instantiate failed |
| `js/run` | operator | jsminer | `{bits, salt?}` mine the identical PoW in JS |
| `js/progress` | jsminer | operator | `{hashes, rate, bits}` live hashrate |
| `js/result` | jsminer | operator | `{nonce, hashHex, bits, salt, hashes, ms, rate}` |
| `sys/heartbeat` | all services | *(kernel → supervisor)* | liveness; never fanned out |
| `sys/stopbeat` | operator → service | service | soft crash (hang) |
| `sys/crash` | operator → service | service | hard crash (`die()`) |
| `sys/pause` | operator → service | *(port layer)* | freeze output (Stop) |
| `sys/resume` | operator → service | *(port layer)* | unfreeze output (Play) |
| `sys/misbehave` | operator → telemetry | telemetry | ask it to attempt a denied publish |
| `sys/control` | telemetry (attempt) | operator | the message the policy judges |

`sys/pause` and `sys/resume` are intercepted by the port, not delivered to the
service function — freezing is transparent to the "driver."

---

## The WebAssembly service

`wasmcompute` is the one service whose "driver" is native code. It demonstrates
how a Wasm module drops into the exact same actor model as the JS services — it
is still just an `api` consumer that subscribes to a topic and posts results.

**A real module, fetched at runtime.** On spawn the service `fetch`es the SIMD
module and calls `WebAssembly.validate(bytes)` on it — an exact feature test. If
it validates, that module is used (`mode: "simd"`); otherwise the service fetches
the scalar module instead (`mode: "scalar"`). Either way it then calls
`WebAssembly.instantiate(bytes, {})`. The import object is empty because the
module is *freestanding* — `#![no_std]`, no allocator, no WASI, no JS callbacks.
That is what lets the identical bytes run in a Web Worker *and* in the main-thread
fallback with no glue. Because a Worker has no base URL, `boot()` resolves both
paths to absolute URLs (`new URL(CONFIG.wasm.file, document.baseURI).href`)
*before* they are injected via `api.cfg` — a relative `fetch` inside the Worker
would otherwise fail. Both files are in the service-worker precache, so mining
works offline after first load.

**What it computes.** SHA-256 proof-of-work: find a nonce whose
`SHA-256(salt ‖ nonce)` has at least *N* leading zero bits. `N` is the difficulty
knob. This is Hashcash/Bitcoin-style PoW in miniature (Bitcoin hashes an 80-byte
header with double SHA-256; here it's an 8-byte message, single hash, to keep the
module tiny). The winning hash is verifiable: the reported `hashHex` is exactly
`SHA-256(salt ‖ nonce)`.

**Cooperative execution — the heartbeat tension.** A tight native loop that runs
to completion would block the Worker for seconds, and a Worker that can't post
`sys/heartbeat` looks *dead* to the supervisor, which would then reincarnate a
service that was working perfectly. So the miner runs in **chunks**: it hashes
`CONFIG.mine.wasmChunk` nonces, posts progress, then yields with `setTimeout(0)`.
Between chunks the heartbeat interval fires and the Worker stays visibly alive.
This is the same "busy vs. wedged" problem the whole app is about, made concrete
— keep each chunk well under `supervisor.deathMs`.

**Language and build.** The module is written in **Rust** (`wasm/src/lib.rs`,
canonical). Build it with your own toolchain:

```
rustup target add wasm32-unknown-unknown   # one time
cd wasm && ./build.sh                       # → wasm/miner.wasm
```

The shipped `wasm/miner.wasm` was prebuilt from a byte-for-byte-equivalent **C
twin** (`wasm/miner.c`) with clang, because the build sandbox couldn't install
the Rust wasm target. Both emit the identical ABI (`mine`, `set_salt`,
`hash_nonce`, `digest_ptr`, exported `memory`), so a Rust rebuild is a drop-in
replacement. `build.sh` prefers Rust and falls back to the clang twin. See
`wasm/README.md` for the ABI table.

### Head-to-head: JS vs WASM

`jsminer` implements the **same** SHA-256 PoW in plain JavaScript so you can race
it against the wasm module. The race is deliberately apples-to-apples: both hash
the identical message (`salt ‖ nonce`) against the identical leading-zero-bits
target, so at the same difficulty **and the same salt** they search the same
space and land on the **same winning nonce**. **Race** picks one random salt and
starts both; each service runs in its own Worker, so it's a genuine parallel race
on separate cores. The panel shows a live hashrate on each side (JS in amber,
WASM in teal), sizes the bars relative to the faster miner, and names the winner
and the margin (photo finish → clear margin → comfortably → runaway) with the
speed ratio once both land the nonce. (`wasm solo` / `JS solo` run one side at a
time.)

**Two lessons, one tape.** Flip the wasm module between its scalar and SIMD builds
(the service prefers SIMD; the scalar fallback is what you'd get on a browser
without it) and the verdict changes completely:

- **Scalar wasm ≈ JS.** They land within ~10% of each other, and JS sometimes
  wins. A modern JIT compiles a hot, monomorphic integer loop like SHA-256 to
  essentially native code, so a straightforward scalar wasm build has little
  headroom. "Rewrite it in wasm" is *not* automatically a win.
- **SIMD wasm wins ~3–4×.** `miner.simd.wasm` hashes **four nonces at once**, one
  per `i32x4` lane (a single SHA-256 is a serial dependency chain, so the win is
  data-parallelism *across* nonces, not a faster single hash). JS has no portable
  SIMD, so this is a gap it structurally can't close.

That's the honest takeaway: WebAssembly's decisive advantages are **SIMD**,
**threads** (`SharedArrayBuffer` + multiple mining workers), **predictable
performance** (no warmup, no GC pauses, no deopts), and shipping **non-JS
languages** — not simply "it's compiled." The tape lets you see it rather than
take it on faith.

---

## Developer guide

### The service contract

A service is a **self-contained function** of a single `api` object. It must not
reference anything in the enclosing scope, because its source is serialized with
`Function.prototype.toString()` and injected into a Worker. The same function is
*also* called directly on the main thread in simulated mode, so it has to work
both ways with no changes.

The `api` object the runtime provides:

```js
api.name                 // this service's registered name (string)
api.cfg                  // the injected CONFIG; read timings from api.cfg.service.*
api.post(topic, data)    // publish a message to the kernel (gated while paused)
api.on(callback)         // register a handler; callback(msg) where msg = {topic, data}
api.now()                // Date.now(), abstracted so both hosts match
api.interval(fn, ms)     // like setInterval, but tracked so terminate()/die() can clear it
api.die()                // self-destruct (worker: self.close(); local: mark dead + clear timers)
```

You do **not** handle `sys/pause` / `sys/resume` — the port intercepts them and
gates `api.post` for you. A minimal, correct service looks like this:

```js
// in js/services.js
export function echoService(api){
  var C = api.cfg.service;
  var beating = true;
  api.on(function(m){
    if (m.topic === "sys/stopbeat") beating = false;   // support hang
    if (m.topic === "sys/crash")    api.die();          // support hard crash
    if (m.topic === "echo/say")     api.post("echo/said", { text: m.data.text });
  });
  // heartbeat — REQUIRED, or the supervisor will reincarnate you every ~2s
  api.interval(function(){ if (beating) api.post("sys/heartbeat", { t: api.now() }); }, C.heartbeatMs);
}
```

### Adding a service

1. **Write and export the service function** in `js/services.js`, following the
   contract above and the no-scope-capture rule the file's header comment spells
   out. Handle `sys/stopbeat` and `sys/crash`, and emit `sys/heartbeat` on the
   `api.cfg.service.heartbeatMs` interval.
2. **Grant it capabilities** in `js/config.js`. Add an entry to
   `CONFIG.capabilities` keyed by the service name, listing the topic prefixes it
   may publish, e.g. `echo: ["echo/", "sys/heartbeat"]`. Omit this and every
   publish it makes is denied under strict policy.
3. **Define and spawn it** in `boot()` (in `js/app.js`), alongside the built-ins —
   first import it at the top of `app.js`:
   ```js
   import { echoService } from "./services.js";
   // …inside boot():
   Supervisor.define("echo", { fn: echoService, backend: "worker", subs: ["echo/say"], version: "v1" });
   Supervisor.spawn("echo");
   ```
   `subs` are the topics the service should receive; `backend` is `"worker"` or
   `"local"` (falls back to local automatically if workers are unavailable).
4. **Wire any UI** by subscribing the operator to its output topic (in `boot()`)
   and handling it in `Operator.receive` (`js/operator.js`), plus adding the
   service name to the array in `UI.renderCards` (`js/instruments.js`) if you want
   a card for it.

### Mechanism vs. policy — where to extend

The routing core (`ingress`, the pub/sub table, `deliver`) is the **mechanism**
and should rarely change. Access rules live in `Kernel.allow` reading
`CONFIG.capabilities`, the **policy**. You can make policy arbitrarily rich —
per-topic ACLs, rate limits, signed capabilities — without touching a line of
routing code. That separation is the same discipline a microkernel uses to keep
the trusted core small.

### The port abstraction (why two hosts, one interface)

`makeWorkerPort` and `makeLocalPort` both return an object with the same shape:

```js
{ name, host, onmessage, postMessage(msg), terminate() }
```

The kernel and supervisor only ever touch that interface, so they are agnostic to
where a service runs. `makeWorkerPort` stringifies the service function into a
`Blob` and constructs a `Worker`; `makeLocalPort` runs the same function on the
main thread and simulates the async `postMessage` boundary with `setTimeout(…, 0)`
so ordering semantics match. Both also implement the pause gate: `sys/pause` /
`sys/resume` toggle a flag that suppresses outbound `post`s. This is location
transparency (plus freeze) implemented in a few dozen lines, and it's what makes
the **Move** button, the **Stop/Play** toggle, and the sandbox fallback possible.

### Code map

The entry point is `js/app.js` (loaded as a module); it imports the rest. By
file:

1. **`config.js`** — `export const CONFIG`, pure data.
2. **`ports.js`** — `workers.ok` probe/holder, `makeWorkerPort`, `makeLocalPort`
   (both implement the pause gate).
3. **`services.js`** — `clockService`, `telemetryService`, `computeServiceV1/V2`,
   `wasmComputeService`, `jsMinerService` (read timings from `api.cfg`; **no scope capture**).
4. **`kernel.js`** — `Kernel`: routing + `allow` policy (reads
   `CONFIG.capabilities`).
5. **`supervisor.js`** — `Supervisor`: `define` / `spawn` / `replace` / `beat` /
   `tick`.
6. **`operator.js`** — `Operator.receive`, the privileged consumer.
7. **`instruments.js`** — `Tape` (canvas oscilloscope, with `pause`/`resume`),
   `Spark` (sparkline), `Log`, `UI`.
8. **`runtime.js`** — `Runtime.pause` / `resume` / `toggle`, plus the pausable
   uptime clock (`startUptime`).
9. **`app.js`** — composition root: imports, `boot()` (wiring, spawn, loops,
   watchdog), `wireControls()`, and the service-worker registration.

### Extending it: a Qnet-style cross-tab bus

In QNX, because components only exchange messages, a service can sit on another
machine (over Qnet) and callers can't tell. The browser equivalent: replace the
in-page fan-out in `Kernel.ingress` with a
[`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)
(or a WebSocket to a server, or a `SharedWorker`). Services could then live in
different tabs while the kernel routes across them, and no service code would
change — the same location-transparency property, one hop further out. The port
interface is already the seam to do this behind.

---

## PWA notes

The app is a minimal but real Progressive Web App.

- **`sw.js` and `manifest.json` live at the root — deliberately.** A service
  worker's default **scope** is the directory it is served from; at the root it
  controls the whole app. Move `sw.js` into `js/` and its scope shrinks to `/js/`,
  so it would no longer control the root navigation (offline shell + precache
  break). Widening scope from a subfolder needs a `Service-Worker-Allowed` header,
  i.e. server config — not worth it. `manifest.json` is more relaxed but
  conventionally sits at the root too.
- **Registration is anchored to the document.** Because `app.js` now lives in
  `js/`, it registers the worker with `new URL("sw.js", document.baseURI)` rather
  than a bare `"./sw.js"` — that resolves against the page (root) regardless of
  the calling module's location, so the worker lands at root scope. It stays
  relative to the document, so serving the app from a subpath still works.
- **`manifest.json`** — standalone display, dark theme colours matching the UI,
  and three icons (192, 512, and a 512 maskable with a safe zone).
- **Icons** live in `icons/`. If you rename or move them, update `manifest.json`,
  the `<link>` tags in `index.html`, and the precache list in `sw.js` together.
- **`sw.js` strategy** — on install it **precaches the app shell** (including
  every module under `js/` and `wasm/miner.wasm`), fetching each asset
  individually (not `cache.addAll`, which is atomic) so a single missing file
  can't abort the whole install; anything that fails is logged by name and
  skipped. At runtime it serves the shell **stale-while-revalidate**: the cached
  copy is returned immediately *and* a background fetch refreshes the cache for
  next time (kept alive with `event.waitUntil`). A change therefore appears on the
  **second** load after it ships — no cache-version bump required for routine
  edits. (Precaching the `.wasm` is what lets mining work offline.)
- **Cache versioning** — the `CACHE` constant (`ukernel-v8`) names the cache; the
  `activate` handler deletes any other cache. Bump it only when you need to force
  an immediate refresh of the precached shell, or when the precache list itself
  changes.
- **Offline** — after the first successful load the app runs fully offline;
  navigations fall back to the cached `index.html`.
- **Testing gotcha** — service workers keep controlling the page until the new one
  activates. After editing `sw.js`, either **Unregister** it (DevTools →
  Application → Service Workers) and hard-reload, or tick **Update on reload**.

---

## Limitations

This is a model for understanding, not a production runtime.

- No message delivery guarantees, ordering across hosts, backpressure, or
  queueing during a swap beyond "spawn new before retiring old."
- Heartbeat-based liveness is coarse and, as noted, conflates "busy" with
  "wedged" for synchronous work.
- The capability policy is prefix-matching only.
- State is in-memory; nothing persists across reload (deliberately — no browser
  storage is used).

None of these are hard to improve, and each is a reasonable place to keep
learning.

---

## Concept-to-code quick reference

| You want to see… | Trigger | Code to read |
|---|---|---|
| Message passing | anything | `Kernel.ingress`, the topics table |
| Fault isolation | Hang / Crash | service `sys/crash` handler, `api.die` |
| Supervision | crash + wait | `Supervisor.tick`, `CONFIG.supervisor.deathMs` |
| Least privilege | Provoke violation | `Kernel.allow`, `CONFIG.capabilities` |
| Mechanism vs. policy | Policy toggle | `Kernel.allow` vs. `Kernel.ingress` |
| Location transparency | Move | `makeWorkerPort` / `makeLocalPort` |
| Hot swap | Upgrade | `Supervisor.replace`, `computeServiceV2` |
| WebAssembly vs JS (SIMD) | Race / wasm solo / JS solo | `wasmComputeService` (SIMD), `jsMinerService` |
| Freeze / resume | Stop / Play | `Runtime.pause` / `resume`, port pause gate |

---

*A teaching artifact. Read the code — it's the point.*
