"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createManualJobServer } = require("../backend/manual-job-server");

const FRONTEND = path.resolve(__dirname, "../frontend/video-mode-entry");
const ORIGIN = "https://manual.test";
const AUTH = { "tailscale-user-login": "tester@example.com" };

// Runs sw.js against a fake ServiceWorker global and returns its handlers.
function loadWorker(network) {
  const listeners = {};
  const stores = new Map();
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return { put: async (key, response) => { store.set(String(key), response); }, match: async (key) => store.get(String(key)) };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const context = {
    self: { location: { origin: ORIGIN }, addEventListener: (type, handler) => { listeners[type] = handler; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches, URL, Request, Response, Set, Map, Promise, Error,
    fetch: async (request) => network(request),
  };
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, "sw.js"), "utf8"), context);
  return { listeners, stores };
}

async function dispatch(handler, event) {
  let waited = null; let responded;
  handler({ ...event, waitUntil: (promise) => { waited = promise; }, respondWith: (promise) => { responded = promise; } });
  if (waited) await waited;
  return responded === undefined ? undefined : responded;
}

(async () => {
  // Manifest: installable, standalone, same-origin scope.
  const manifest = JSON.parse(fs.readFileSync(path.join(FRONTEND, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.scope, "/");
  assert.equal(new URL(manifest.start_url, ORIGIN).pathname, "/");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes).sort(), ["192x192", "512x512"]);
  for (const icon of manifest.icons) {
    const bytes = fs.readFileSync(path.join(FRONTEND, icon.src));
    assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
  }
  const html = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(fs.readFileSync(path.join(FRONTEND, "app.js"), "utf8"), /serviceWorker\.register\("\/sw\.js"/);

  // Server: the PWA files are served like the other screen parts, behind the same auth.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-pwa-test-"));
  const server = createManualJobServer({ root, allowedUsers: ["tester@example.com"], publicOrigin: ORIGIN, logError: () => {} });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [pathname, type] of [
      ["/manifest.webmanifest", "application/manifest+json"],
      ["/sw.js", "text/javascript"],
      ["/icons/icon-192.png", "image/png"],
      ["/icons/icon-512.png", "image/png"],
    ]) {
      const response = await fetch(`${base}${pathname}`, { headers: AUTH });
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers.get("content-type").split(";")[0], type);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      await response.arrayBuffer();
      assert.equal((await fetch(`${base}${pathname}`)).status, 401, `${pathname} must keep the existing auth`);
    }
    assert.equal((await fetch(`${base}/icons/../app.js`, { headers: AUTH })).status, 200); // normalised to /app.js
    assert.equal((await fetch(`${base}/icons/other.png`, { headers: AUTH })).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Service worker: only the static shell is cached.
  let online = true; const fetched = [];
  const worker = loadWorker(async (request) => {
    fetched.push(new URL(request.url).pathname);
    if (!online) throw new TypeError("offline");
    return new Response(`body of ${new URL(request.url).pathname}`, { status: 200 });
  });
  await dispatch(worker.listeners.install, {});
  const [cacheName] = [...worker.stores.keys()];
  const cached = [...worker.stores.get(cacheName).keys()].sort();
  assert.deepEqual(cached, ["/", "/app.js", "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest", "/styles.css"]);
  assert.equal(cached.some((key) => key.startsWith("/api/") || key.startsWith("/video/")), false);

  const request = (pathname, method = "GET") => new Request(`${ORIGIN}${pathname}`, { method });
  // Never intercepted: API, job list, video files, health, uploads, other origins.
  for (const untouched of [
    request("/api/manual-video-jobs"), request("/api/manual-video-jobs?limit=20"),
    request("/api/manual-video-jobs/job_x/status"), request("/api/manual-image-library/asset_0001/thumbnail"),
    request("/api/portal-status"), request("/video/job/job_x/view"), request("/video/job/job_x/download"),
    request("/health"), request("/image-library-admin"), request("/api/manual-video-jobs", "POST"), request("/", "POST"),
    new Request("https://other.test/app.js"),
  ]) {
    assert.equal(await dispatch(worker.listeners.fetch, { request: untouched }), undefined, `${untouched.method} ${untouched.url}`);
  }
  const sizeBefore = worker.stores.get(cacheName).size;

  // Shell: network first while online, cached copy only when the host is unreachable.
  fetched.length = 0;
  let response = await dispatch(worker.listeners.fetch, { request: request("/?mode=manual") });
  assert.equal(await response.text(), "body of /");
  assert.deepEqual(fetched, ["/"]);
  online = false;
  response = await dispatch(worker.listeners.fetch, { request: request("/app.js") });
  assert.equal(await response.text(), "body of /app.js");
  assert.equal(worker.stores.get(cacheName).size, sizeBefore);

  // Activation removes only this app's old shell caches.
  await worker.stores.set("manual-video-shell-v0", new Map());
  await worker.stores.set("someone-elses-cache", new Map());
  await dispatch(worker.listeners.activate, {});
  assert.deepEqual([...worker.stores.keys()].sort(), [cacheName, "someone-elses-cache"].sort());

  process.stdout.write("pwa shell tests: ok\n");
})().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
