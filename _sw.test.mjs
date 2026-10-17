/* Drives the real deploy/sw.js inside a fake ServiceWorkerGlobalScope.
 *
 * A regex can tell you the file mentions `navigate`; it cannot tell you that a cross-origin API
 * call is left alone, that a navigation is answered from cache with the network untouched, or
 * that a changed page reaches the open tab as an update. Those are the behaviours that matter,
 * so they are run here rather than matched.
 *
 * No dependencies, no browser: `caches` is a Map, `fetch` is a recorder, and the events are
 * dispatched by hand. Node 18+ (Request/Response/Headers come from Node itself).
 */
import fs from "node:fs";
import vm from "node:vm";

const ORIGIN = "https://app.test";
const SRC = fs.readFileSync("deploy/sw.js", "utf8");
const V = (SRC.match(/const VERSION\s*=\s*"([^"]+)"/) || [])[1];
const CACHE = "home-dashboard-" + V;

/* ── the world the worker runs in ─────────────────────────────────────────────── */
function makeWorld(bodies) {
  const world = { calls: [], skipWaiting: 0, claimed: 0, notifications: [], clients: [] };
  world.bodies = Object.assign(
    {
      "/": "<!doctype html><p>v1</p>",
      "/index.html": "<!doctype html><p>v1</p>",
      "/manifest.webmanifest": "{}",
      "/icons/favicon-32.png": "png",
      "/icons/apple-touch-icon-180.png": "png",
      "/icons/icon-192.png": "png",
      "/icons/icon-512.png": "png",
      "/icons/app-qr.png": "png"
    },
    bodies || {}
  );
  world.fetch = async (req) => {
    const url = typeof req === "string" ? new URL(req, ORIGIN) : new URL(req.url);
    const key = url.pathname;
    world.calls.push({ path: key, cache: typeof req === "string" ? null : req.cache || "default" });
    if (!(key in world.bodies)) throw new TypeError("no network: " + key);
    const body = world.bodies[key];
    if (body === null) return new Response("boom", { status: 500 });
    return new Response(body, { status: 200, headers: { "content-type": key.endsWith(".png") ? "image/png" : "text/plain" } });
  };

  const map = new Map();
  const openCache = (name) => {
    if (!map.has(name)) map.set(name, new Map());
    const m = map.get(name);
    const abs = (k) => (typeof k === "string" ? new URL(k, ORIGIN + "/").href : k.url);
    return {
      async put(k, res) { m.set(abs(k), res.clone()); },
      async match(k) {
        const v = m.get(abs(k));
        return v ? v.clone() : undefined;
      },
      async add(req) {
        const res = await world.fetch(typeof req === "string" ? new URL(req, ORIGIN).href : req);
        if (!res.ok) throw new Error("add " + res.status);
        m.set(abs(typeof req === "string" ? req : req.url), res.clone());
        return undefined;
      }
    };
  };
  world.caches = {
    async open(name) { return openCache(name); },
    async keys() { return [...map.keys()]; },
    async delete(name) { return map.delete(name); }
  };
  world.cacheOf = (name) => map.get(name) || new Map();

  const listeners = new Map();
  world.self = {
    location: new URL(ORIGIN + "/sw.js"),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    skipWaiting() { world.skipWaiting++; return Promise.resolve(); },
    clients: {
      async claim() { world.claimed++; },
      async matchAll() { return world.clients; },
      async openWindow(url) { world.opened = url; }
    },
    registration: {
      async showNotification(title, opts) { world.notifications.push({ title, opts }); }
    }
  };

  const ctx = vm.createContext({
    self: world.self,
    caches: world.caches,
    /* delegated, not captured: a test can swap the network out mid-run */
    fetch: (req) => world.fetch(req),
    Request, Response, Headers, URL,
    console, setTimeout, clearTimeout, Promise
  });
  vm.runInContext(SRC, ctx, { filename: "sw.js" });

  world.fire = async (type, props) => {
    let responded = null;
    const waits = [];
    const ev = Object.assign({ type, waitUntil: (p) => waits.push(p), respondWith: (p) => { responded = p; } }, props || {});
    for (const fn of listeners.get(type) || []) fn(ev);
    await Promise.all(waits);
    return { responded: responded ? await responded : null };
  };
  return world;
}

let fails = 0, n = 0;
const ok = (name, cond, detail) => {
  n++;
  if (!cond) fails++;
  console.log((cond ? "PASS  " : "FAIL  ") + name + (detail !== undefined ? "  [" + detail + "]" : ""));
};
const textOf = async (res) => (res ? await res.text() : "");
/* undici refuses {mode:"navigate"} (it is a browser-only request mode), so a navigation is a
   duck-typed request - which is all the worker actually reads. */
const nav = (path) => ({ url: ORIGIN + path, method: "GET", mode: "navigate", headers: new Headers() });

/* ── install: the shell is copied in, with the HTTP cache bypassed ─────────────── */
{
  const w = makeWorld();
  await w.fire("install");
  const cache = w.cacheOf(CACHE);
  ok("install: precaches the shell under both ./index.html and ./",
    cache.has(ORIGIN + "/index.html") && cache.has(ORIGIN + "/"),
    cache.size + " entries: " + [...cache.keys()].map((u) => new URL(u).pathname).join(" "));
  ok("install: the shell request bypasses the HTTP cache, so a release never precaches old bytes",
    w.calls.some((c) => c.path === "/index.html" && c.cache === "reload"),
    JSON.stringify(w.calls.filter((c) => c.path === "/index.html")));
  ok("install: the icons come along", cache.has(ORIGIN + "/icons/icon-192.png") && cache.has(ORIGIN + "/icons/icon-512.png"));
  ok("install: does NOT skipWaiting - the new worker waits for the page", w.skipWaiting === 0, "skipWaiting calls: " + w.skipWaiting);
}

/* ── install: a missing icon must not take offline down with it ────────────────── */
{
  const w = makeWorld();
  const realFetch = w.fetch;
  w.fetch = async (req) => {
    const u = new URL(typeof req === "string" ? req : req.url, ORIGIN);
    if (u.pathname === "/icons/icon-512.png") throw new TypeError("missing icon");
    return realFetch(req);
  };
  let threw = null;
  try { await w.fire("install"); } catch (e) { threw = e; }
  ok("install: an icon that fails is survivable, the shell is still cached",
    !threw && w.cacheOf(CACHE).has(ORIGIN + "/index.html"),
    threw ? threw.message : "installed anyway");
}

/* ── install: a shell that cannot be fetched is a real failure ─────────────────── */
{
  const w = makeWorld();
  w.fetch = async () => new Response("nope", { status: 404 });
  let threw = null;
  try { await w.fire("install"); } catch (e) { threw = e; }
  ok("install: a 404 on the shell fails the install instead of claiming a cache it does not have",
    !!threw, threw ? threw.message : "silently installed");
}

/* ── activate: old versioned caches go, someone else's cache stays ─────────────── */
{
  const w = makeWorld();
  await w.caches.open("home-dashboard-0.0.1-old");
  await w.caches.open(CACHE);
  await w.caches.open("another-app-cache");
  await w.fire("activate");
  const left = await w.caches.keys();
  ok("activate: deletes a previous version's cache, keeps this one and other apps' caches",
    left.length === 2 && left.includes(CACHE) && left.includes("another-app-cache"),
    left.join(", "));
  ok("activate: takes over the open page", w.claimed === 1, "claim calls: " + w.claimed);
}

/* ── fetch: the API is never cached ───────────────────────────────────────────── */
{
  const w = makeWorld();
  await w.fire("install");
  const before = w.calls.length;
  const cross = await w.fire("fetch", { request: new Request("https://home-dashboard-api.drifter-87.workers.dev/api/metals") });
  ok("fetch: a cross-origin API request is left to the network - not answered, not stored",
    cross.responded === null && w.calls.length === before,
    cross.responded === null ? "passed through" : "answered by the worker");
  const sameOriginPost = await w.fire("fetch", { request: new Request(ORIGIN + "/api/thing", { method: "POST" }) });
  ok("fetch: a POST is left alone too", sameOriginPost.responded === null);
}

/* ── fetch: navigation comes from the cache, with no network at all ────────────── */
{
  const w = makeWorld();
  await w.fire("install");
  const before = w.calls.length;
  const first = await w.fire("fetch", { request: nav("/?p=3") });
  const firstBody = await textOf(first.responded);
  ok("offline: a navigation is answered from the cached shell", firstBody.indexOf("v1") >= 0, firstBody.slice(0, 30));
  ok("offline: …without touching the network", w.calls.length === before, (w.calls.length - before) + " network calls");
  const deep = await w.fire("fetch", { request: nav("/anything-else") });
  ok("offline: an unknown path still gets the app, since it is a single page", (await textOf(deep.responded)).indexOf("v1") >= 0);
}

/* ── fetch: first visit, nothing cached yet ───────────────────────────────────── */
{
  const w = makeWorld();
  const first = await w.fire("fetch", { request: nav("/") });
  ok("first visit: a navigation with an empty cache comes from the network", (await textOf(first.responded)).indexOf("v1") >= 0);
  ok("first visit: …and is kept for next time", w.cacheOf(CACHE).has(ORIGIN + "/index.html"));
}

/* ── fetch: icons, and what happens when there is no network ──────────────────── */
{
  const w = makeWorld();
  await w.fire("install");
  const icon = await w.fire("fetch", { request: new Request(ORIGIN + "/icons/icon-192.png") });
  ok("assets: an icon is served from cache", icon.responded && icon.responded.status === 200);

  w.fetch = async () => { throw new TypeError("offline"); };
  const miss = await w.fire("fetch", { request: new Request(ORIGIN + "/icons/never-seen.png") });
  ok("offline: an asset with no cached copy answers 504 rather than throwing",
    miss.responded && miss.responded.status === 504, miss.responded ? "status " + miss.responded.status : "no response");
}

/* ── message: the update check ───────────────────────────────────────────────── */
{
  const w = makeWorld();
  await w.fire("install");
  const msgs = [];
  w.clients.push({ postMessage: (m) => msgs.push(m) });
  await w.fire("message", { data: { type: "CHECK" } });
  ok("check: an unchanged page raises no update", msgs.length === 0, msgs.length + " messages");

  w.bodies["/index.html"] = "<!doctype html><p>v2</p>";
  await w.fire("message", { data: { type: "CHECK" } });
  ok("check: a changed page tells the open tab an update is ready", msgs.length === 1 && msgs[0].type === "PD_UPDATE",
    JSON.stringify(msgs[0] || null));
  const cached = await w.cacheOf(CACHE).get(ORIGIN + "/index.html").clone().text();
  ok("check: …and stores the new page, so the Reload the banner offers really loads it", cached.indexOf("v2") >= 0);
  await w.fire("message", { data: { type: "CHECK" } });
  ok("check: a second check over the same bytes stays quiet", msgs.length === 1, msgs.length + " messages");

  /* the promise the banner makes: Reload shows the copy it just cached */
  const afterReload = await w.fire("fetch", { request: nav("/?p=3") });
  const bodyAfter = await textOf(afterReload.responded);
  ok("check: a navigation after the update serves the new page, so Reload is not a lie",
    bodyAfter.indexOf("v2") >= 0, bodyAfter.slice(0, 30));
}

/* ── message: an offline check is not an update ──────────────────────────────── */
{
  const w = makeWorld();
  await w.fire("install");
  const msgs = [];
  w.clients.push({ postMessage: (m) => msgs.push(m) });
  w.fetch = async () => { throw new TypeError("offline"); };
  let threw = null;
  try { await w.fire("message", { data: { type: "CHECK" } }); } catch (e) { threw = e; }
  ok("check: offline raises no update and no unhandled failure", !threw && msgs.length === 0, threw ? threw.message : "quiet");
}

/* ── message: only an explicit Reload swaps the worker ───────────────────────── */
{
  const w = makeWorld();
  await w.fire("install");
  await w.fire("message", { data: { type: "SKIP_WAITING" } });
  ok("update: SKIP_WAITING is the only thing that lets the waiting worker take over", w.skipWaiting === 1, "calls: " + w.skipWaiting);
  await w.fire("message", { data: {} });
  ok("update: an empty message does nothing", w.skipWaiting === 1);
}

/* ── the reminder path must survive the rewrite ──────────────────────────────── */
{
  const w = makeWorld();
  const payload = { title: "2 cards due today", body: "Insurance · VAT", url: "/?p=3", tag: "pd-due" };
  await w.fire("push", { data: { json: () => payload } });
  const note = w.notifications[0];
  ok("push: a reminder still shows, with its title, body, tag and icon",
    !!note && note.title === "2 cards due today" && note.opts.body === "Insurance · VAT" && note.opts.tag === "pd-due" && /icon-192/.test(note.opts.icon),
    note ? note.title : "no notification");
  const w3 = makeWorld();
  await w3.fire("push", { data: { json: () => { throw new Error("not json"); }, text: () => "plain" } });
  ok("push: a non-JSON payload becomes a string body", w3.notifications[0] && w3.notifications[0].opts.body === "plain",
    w3.notifications[0] ? w3.notifications[0].opts.body : "none");
}

/* ── the notification tap still lands on the Planner ────────────────────────── */
{
  const w = makeWorld();
  let closed = 0;
  const client = { focus: () => "focused", navigate: () => {} };
  w.clients.push(client);
  await w.fire("notificationclick", { notification: { close: () => closed++, data: { url: "/?p=3" } } });
  ok("notificationclick: focuses the open tab instead of opening another", closed === 1 && w.opened === undefined, "closed " + closed);
}

/* ── the version is the page's version ──────────────────────────────────────── */
{
  const page = fs.readFileSync("index.html", "utf8");
  const pageVer = (page.match(/VERSION:\s*"([0-9.]+)"/) || [])[1];
  const swVer = (SRC.match(/const VERSION\s*=\s*"([0-9.]+)"/) || [])[1];
  ok("version: the worker's cache version is the page's version", !!pageVer && pageVer === swVer, "page " + pageVer + " / worker " + swVer);
}

console.log("\n" + (n - fails) + "/" + n + " checks passed");
process.exit(fails ? 1 : 0);
