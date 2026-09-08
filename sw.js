/* ============================================================================
   sw.js — µkernel service worker

   App-shell precache + cache-first serving so the app works offline once
   installed. Bump CACHE when any shell asset changes to invalidate the old one.

   Note: the app also spins up Blob-URL Web Workers at runtime; those are not
   network requests, so this service worker neither caches nor interferes with
   them. It only handles same-origin GETs for the static shell.
============================================================================ */

const CACHE = "ukernel-v7";

const SHELL = [
  "./index.html",
  "./css/app.css",
  "./js/config.js",
  "./js/ports.js",
  "./js/services.js",
  "./js/kernel.js",
  "./js/supervisor.js",
  "./js/operator.js",
  "./js/instruments.js",
  "./js/runtime.js",
  "./js/app.js",
  "./wasm/miner.wasm",
  "./manifest.json",
  "./icons/favicon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

// Precache each asset on its own so one 404 can't abort the whole install
// (unlike cache.addAll, which is atomic). Anything that fails is logged by
// name and skipped — the app still installs and runs.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const results = await Promise.allSettled(SHELL.map(async (url) => {
      let res = await fetch(url, { cache: "reload" });
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      if (res.redirected) {                 // Cache.put rejects redirected responses
        res = new Response(await res.blob(), { status: 200, headers: res.headers });
      }
      await cache.put(url, res);
    }));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.warn("[sw] could not precache:", SHELL[i], "—", r.reason && r.reason.message);
      }
    });
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: serve the cached copy immediately (fast, offline-
// capable) and, in parallel, fetch a fresh copy to update the cache for next
// time. A change therefore appears on the *second* load after it ships, with no
// cache-version bump required. The revalidation runs via event.waitUntil so it
// finishes even after the cached response has been returned.
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // only handle same-origin GETs; let everything else hit the network
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);

    const network = fetch(req)
      .then((res) => {
        // only cache complete, cacheable responses
        if (res && res.ok && res.type === "basic" && !res.redirected) {
          cache.put(req, res.clone());
        }
        return res;
      })
      .catch(() => null); // network failed (offline) — resolve to null

    // return cache now if we have it; otherwise wait for the network
    if (cached) {
      event.waitUntil(network);            // keep revalidation alive past the response
      return cached;
    }

    const res = await network;
    if (res) return res;

    // nothing cached and network unavailable
    if (req.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    return new Response("", { status: 504, statusText: "offline" });
  })());
});
