/* Service worker: caches the app shell only. ThingSpeak requests are never intercepted or cached here
   (the page keeps its own last good copy of the feed, see lib.js createPoller). */
var CACHE = "helmet-shell-v2";
var SHELL = ["./", "index.html", "style.css", "app.js", "lib.js", "config.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// Same-origin GET: answer from the cache and refresh it in the background (stale-while-revalidate).
self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (resp) { if (resp && resp.ok) c.put(req, resp.clone()); return resp; });
      return hit || net.catch(function () { return c.match("index.html"); });
    });
  }));
});
