"use strict";

// Minimal app-shell worker. It only ever touches the static screen parts listed
// in SHELL. API responses, job lists, video files and every non-GET request are
// never intercepted and never cached.
const CACHE_PREFIX = "manual-video-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];
const SHELL_PATHS = new Set(SHELL);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL.map(async (path) => {
      const response = await fetch(new Request(new URL(path, self.location.origin), { cache: "reload" }));
      if (!response.ok) throw new Error("App shell update failed");
      await cache.put(path, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The query string is ignored only for the shell paths themselves (e.g. "/?mode=manual").
  if (!SHELL_PATHS.has(url.pathname)) return;

  // Network first, so an installed app never keeps showing old screen parts.
  // The cached copy is used only when the host cannot be reached.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(new Request(request, { cache: "no-store" }));
      if (response.ok) await cache.put(url.pathname, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      throw error;
    }
  })());
});
