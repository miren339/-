const SHELL_CACHE = "meishi-shell-v1";
const RUNTIME_CACHE = "meishi-runtime-v1";

const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // App shell: cache-first, so the app itself always opens offline
  if (SHELL_FILES.some((f) => url.endsWith(f.replace("./", "")))) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  // Everything else (OCR engine script, wasm core, language data, fonts, etc.)
  // wherever it's hosted: cache-first once downloaded, so after the first
  // successful scan, OCR keeps working with no network at all.
  if (event.request.method === "GET") {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const response = await fetch(event.request);
          if (response && response.status === 200 && response.type !== "opaque") {
            cache.put(event.request, response.clone());
          }
          return response;
        } catch (err) {
          if (cached) return cached;
          throw err;
        }
      })
    );
  }
});
