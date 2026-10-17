/* Integration test: drives worker.js the way the platform does (fetch + scheduled), with a
   Map-backed stand-in for the KV namespace and a capturing fetch, then decrypts what the
   Worker actually sent with http_ece. Kept as the repeatable proof behind the crypto: it needs
   the test-only `http_ece` package that DEPLOY.md's install line adds, and node_modules is
   gitignored, so nothing extra ships with the page. */
import { createECDH, generateKeyPairSync } from "node:crypto";
import ece from "http_ece";
import worker from "./worker.js";

let fails = 0;
const ok = (label, cond, extra) => { if (!cond) fails++; console.log((cond ? "PASS  " : "FAIL  ") + label + (extra !== undefined ? "  -> " + extra : "")); };
const b64u = (b) => Buffer.from(new Uint8Array(b)).toString("base64url");

/* ---- an ephemeral VAPID key, exactly the shape `wrangler secret put VAPID_JWK` will hold ---- */
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });

/* ---- a "phone": receiver keypair + auth secret, and a subscription to hand the Worker ---- */
const ua = createECDH("prime256v1");
ua.generateKeys();
const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
const sub = { endpoint: "https://push.example.net/wpush/v2/abc", keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };

/* ---- a KV namespace, to the API the Worker uses ---- */
const kvData = new Map();
const env = {
  PUSH: {
    async get(key, type) { const v = kvData.get(key); if (v === undefined) return null; return type === "json" ? JSON.parse(v) : v; },
    async put(key, val) { kvData.set(key, val); },
    async delete(key) { kvData.delete(key); },
    async list({ prefix = "", cursor = null, limit = 500 } = {}) {
      const keys = [...kvData.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: null };
    }
  },
  VAPID_JWK: JSON.stringify(jwk),
  VAPID_SUBJECT: "mailto:test@example.com",
  ALLOWED_ORIGIN: "https://home-dashboard-5ma.pages.dev"
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (path, init) => worker.fetch(new Request("https://api.example.dev" + path, init), env, ctx);
const post = (path, body, origin) => call(path, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, origin === null ? {} : { Origin: origin || env.ALLOWED_ORIGIN }), body: JSON.stringify(body) });

/* ---- capture what the Worker sends to the push service ---- */
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), init }); return new Response("", { status: 201 }); };

/* 1. the key route: the page subscribes with this exact value */
const keyRes = await call("/api/push/key");
const keyJson = await keyRes.json();
ok("GET /api/push/key returns a 65-byte uncompressed public key", keyJson.key.length === 87 && Buffer.from(keyJson.key, "base64url")[0] === 4, keyJson.key.slice(0, 12) + "…");
ok("…and the k= value in the Authorization header is that same key", true, "(checked below, after a send)");

/* 2. registration */
const regRes = await post("/api/push/register", { sub, tz: "Asia/Beirut", at: "08:00", lang: "en", items: [
  { id: "t1", text: "site visit", due: "2026-10-17" }, { id: "t2", text: "invoice", due: "2026-10-17" },
  { id: "t3", text: "next week", due: "2026-10-24" }, { id: "t4", text: "no date", due: "" }
] });
ok("POST /api/push/register stores one record", regRes.status === 200 && kvData.size === 1, "items kept: " + (await regRes.json()).items);
const stored = JSON.parse([...kvData.values()][0]);
ok("only dated cards are stored, capped and trimmed", stored.items.length === 3 && stored.at === "08:00" && stored.tz === "Asia/Beirut", JSON.stringify(stored.items.map((i) => i.due)));

/* 3. the digest fires at the chosen local hour, not before */
const realNow = Date.now;
const at = (iso) => { globalThis.Date.now = () => Date.parse(iso); };
/* 2026-10-17T04:00Z = 07:00 in Asia/Beirut - one hour early */
at("2026-10-17T04:00:00Z");
let out = await worker.scheduled({ cron: "*/15 * * * *" }, env, ctx);
ok("an hour early: nothing is sent", sent.length === 0 && out.sent === 0, JSON.stringify(out));
/* 2026-10-17T05:05Z = 08:05 in Asia/Beirut - the first tick after 08:00 */
at("2026-10-17T05:05:00Z");
out = await worker.scheduled({ cron: "*/15 * * * *" }, env, ctx);
ok("at 08:05 local: one digest is sent", out.sent === 1 && sent.length === 1, JSON.stringify(out));

/* 4. what actually went over the wire */
const req = sent[0];
const h = req.init.headers;
ok("the push carries TTL, aes128gcm and a VAPID authorization", h.TTL === "86400" && h["Content-Encoding"] === "aes128gcm" && /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(h.Authorization), h.Authorization.slice(0, 26) + "…");
ok("the k= value is the key the page was given", h.Authorization.split("k=")[1] === keyJson.key, "matches /api/push/key");
const decrypted = ece.decrypt(Buffer.from(req.init.body), { version: "aes128gcm", privateKey: ua, authSecret: auth }).toString();
const payload = JSON.parse(decrypted);
ok("http_ece decrypts the digest to two cards due today", payload.title === "2 cards due today" && payload.body === "site visit · invoice", JSON.stringify(payload));
ok("the notification deep-links to the Planner", payload.url === "/?p=3" && payload.tag === "pd-due", payload.url);

/* 5. once per day, and the same day does not repeat */
out = await worker.scheduled({ cron: "*/15 * * * *" }, env, ctx);
ok("a later tick the same day stays quiet", sent.length === 1 && out.sent === 0, JSON.stringify(out));
/* next day: the card due today is now overdue, so it is still worth a reminder */
at("2026-10-18T05:05:00Z");
out = await worker.scheduled({ cron: "*/15 * * * *" }, env, ctx);
ok("the next day speaks again, counting the overdue card", out.sent === 1 && sent.length === 2, JSON.stringify(out));

/* 6. Arabic, and an expired subscription */
await post("/api/push/register", { sub, tz: "Asia/Beirut", at: "08:00", lang: "ar", items: [{ id: "t1", text: "زيارة موقع", due: "2026-10-19" }] });
const before = sent.length;
globalThis.fetch = async () => new Response("gone", { status: 410 });
at("2026-10-19T05:05:00Z");
out = await worker.scheduled({ cron: "*/15 * * * *" }, env, ctx);
ok("a 410 from the push service retires the device", out.pruned === 1 && kvData.size === 0, JSON.stringify(out));
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), init }); return new Response("", { status: 201 }); };
await post("/api/push/register", { sub, tz: "Asia/Beirut", at: "08:00", lang: "ar", items: [{ id: "t1", text: "زيارة موقع", due: "2026-10-20" }] });
at("2026-10-20T05:05:00Z");
await worker.scheduled({ cron: "*/15 * * * *" }, env, ctx);
const arPayload = JSON.parse(ece.decrypt(Buffer.from(sent[sent.length - 1].init.body), { version: "aes128gcm", privateKey: ua, authSecret: auth }).toString());
ok("Arabic devices get an Arabic digest", arPayload.title === "بطاقة مستحقة اليوم" && arPayload.body === "زيارة موقع", arPayload.title);

/* 7. refusals */
ok("a foreign origin cannot register", (await post("/api/push/register", { sub }, "https://evil.example")).status === 403, "403");
ok("a non-https endpoint is refused", (await post("/api/push/register", { sub: { endpoint: "http://x.example/y", keys: sub.keys } })).status === 400, "400");
ok("a malformed key is refused", (await post("/api/push/register", { sub: { endpoint: sub.endpoint, keys: { p256dh: "AAAA", auth: "AAAA" } } })).status === 400, "400");
ok("an oversized body is refused", (await post("/api/push/register", { sub, junk: "x".repeat(70000) })).status === 400, "400");
const health = await call("/api/health");
const healthJson = await health.json();
ok("the health route still reports the Worker version", healthJson.ok === true && healthJson.v === "1.13.0", healthJson.v);
ok("the route list advertises the push endpoints", (await (await call("/")).json()).routes.filter((r) => r.startsWith("/api/push")).length === 4, "4 push routes");

/* 8. the test button */
const testRes = await post("/api/push/test", { sub, lang: "en" });
ok("POST /api/push/test sends immediately", testRes.status === 200 && sent.length > 0, "status " + testRes.status);

globalThis.Date.now = realNow;
globalThis.fetch = realFetch;
console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASS");
process.exit(fails ? 1 : 0);
