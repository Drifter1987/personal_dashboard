/* Dashboard service worker.
 *
 * Two jobs, deliberately kept apart:
 *
 *   1. reminders - show a push notification when the app is closed (unchanged);
 *   2. offline   - keep a copy of the app shell, so an installed dashboard opens with no
 *                  network at all instead of the browser's dinosaur.
 *
 * VERSION must equal CONFIG.VERSION in index.html, and the release gate (node _deploy.mjs)
 * fails the build when the two drift. That pairing is what makes the update prompt work:
 * every release installs a *new* worker, the new worker waits instead of taking over, and
 * the page asks you to reload when you want it.
 *
 * What is cached is the shell only - the HTML, the manifest and the icons. A market price,
 * a headline or a prayer time fetched from the Worker is a live reading; serving a stale one
 * from a cache would be a lie, so cross-origin and API requests are never stored, not even
 * for a second.
 *
 * The cache name carries the version, and activating a worker deletes every other
 * home-dashboard cache, so an old shell can never be served after an update.
 */
const VERSION = "2.23.0";
const CACHE = "home-dashboard-" + VERSION;
/* absolute, so a cache key never depends on a worker's base-URL rules */
const at = (p) => new URL(p, self.location.href).href;
const SHELL = at("./index.html");
const ROOT = at("./");
const ASSETS = [
  at("./manifest.webmanifest"),
  at("./icons/favicon-32.png"),
  at("./icons/apple-touch-icon-180.png"),
  at("./icons/icon-192.png"),
  at("./icons/icon-512.png"),
  at("./icons/app-qr.png")
];

/* A shell the browser cannot serve. The host answers /index.html with a 308 to /, so a worker
   that cached that path stored a response flagged `redirected` - and a navigation runs with
   redirect mode "manual", which refuses such a response: the app opens to an error page while
   the site itself is perfectly healthy. This worker no longer stores one, but a browser can
   still be holding what an older worker left behind, so install looks for it. */
async function stuckShell() {
  try {
    const names = await caches.keys();
    for (const n of names) {
      if (n.indexOf("home-dashboard-") !== 0 || n === CACHE) continue;
      const hit = await (await caches.open(n)).match(SHELL);
      if (hit && hit.redirected) return true;
    }
  } catch (e) { /* cannot tell: assume nothing is wrong */ }
  return false;
}

/* Install: copy the shell in, bypassing the HTTP cache so a new version never precaches the old
   bytes. The HTML is required - if it cannot be fetched there is no offline worth claiming - while
   an icon that fails to arrive must not take the whole install down. The shell is fetched from /
   rather than /index.html: the same bytes, but no redirect to be flagged on the response. No
   skipWaiting in the ordinary case - the swap happens when the user presses Reload, never
   underneath them mid-sentence. The one exception is a page nobody can open at all. */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const res = await fetch(new Request(ROOT, { cache: "reload" }));
      if (!res || !res.ok) throw new Error("shell " + (res ? res.status : "unreachable"));
      await cache.put(SHELL, res.clone());
      /* the same bytes answer "/" as well, so a bare navigation works offline too */
      await cache.put(ROOT, res.clone());
      await Promise.all(ASSETS.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => null)));
    })()
  );
  /* A worker that inherited a shell no browser will load cannot offer a Reload button, because
     no page can open to show one. Waiting politely would leave the app dead until someone
     cleared site data by hand, so that is the one case where taking over immediately is kind. */
  event.waitUntil(stuckShell().then((stuck) => { if (stuck) return self.skipWaiting(); }));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.indexOf("home-dashboard-") === 0 && n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

/* The page asks for a check when it loads, when it comes back into view, and every so often while
   it stays open - that is how a long-lived installed app learns about a new release. */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  if (data.type === "CHECK") event.waitUntil(checkForUpdate());
});

async function checkForUpdate() {
  try {
    const res = await fetch(new Request(ROOT, { cache: "no-store" }));
    if (!res || !res.ok) return;
    const fresh = await res.clone().text();
    const cache = await caches.open(CACHE);
    const known = await cache.match(SHELL);
    const have = known ? await known.text() : "";
    if (fresh === have) return;
    await cache.put(SHELL, res.clone());
    await cache.put(ROOT, res.clone());
    await tell({ type: "PD_UPDATE", reason: "page" });
  } catch (e) {
    /* offline is not an update */
  }
}

async function tell(msg) {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of list) {
    try { c.postMessage(msg); } catch (e) {}
  }
}

/* Navigation: the shell from cache, so an installed app opens instantly and with no signal.
   A page that is not cached yet (first visit) comes from the network and is kept.

   Two guards, both learned the hard way: a cache that cannot be opened must not become a dead
   page, and a redirected response must never be handed to a navigation - the browser refuses it
   and the user sees an error page instead of the app. */
async function shellFor(request) {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(SHELL);
    if (hit && !hit.redirected) return hit;
  } catch (e) { /* fall through to the network */ }
  const res = await fetch(request);
  if (res && res.ok) {
    try {
      const cache = await caches.open(CACHE);
      await cache.put(SHELL, res.clone());
      await cache.put(ROOT, res.clone());
    } catch (e) { /* a page that loads beats a cache that would not */ }
  }
  return res;
}

/* Everything else on this origin (icons, the manifest): cache first, then the network, and the
   answer is kept for next time. */
async function assetFor(request) {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
  } catch (e) { /* the network is the next answer */ }
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === "basic") await cache.put(request, res.clone());
    return res;
  } catch (e) {
    return new Response("", { status: 504, statusText: "offline" });
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw.js") return;
  /* last resort: whatever went wrong in here, the page still gets a chance from the network */
  event.respondWith((req.mode === "navigate" ? shellFor(req) : assetFor(req)).catch(() => fetch(req)));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Dashboard";
  const body = data.body || "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      tag: data.tag || "pd-due",
      badge: "/icons/icon-192.png",
      icon: "/icons/icon-192.png",
      data: { url: data.url || "/?p=3" }
    })
  );
});

/* Tapping the reminder should land on the Planner in a tab that already exists, rather than
   stacking a new one every morning. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/?p=3";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          try { client.navigate(target); } catch (e) {}
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
