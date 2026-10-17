#!/usr/bin/env node
/* The post-deploy smoke test. The gate (_deploy.mjs) decides whether publishing may start;
   this decides whether the publish actually worked, by asking the live site rather than
   trusting the CLI's exit code.

     node _smoke.mjs                    check production, byte-for-byte
     node _smoke.mjs --once             one fetch per URL, no edge-staleness retries
     node _smoke.mjs --timeout=20000    per-request timeout in ms (default 15000)
     node _smoke.mjs --page-only        the page only, skip the Worker and CORS (CI publish)
     node _smoke.mjs --help

   --page-only exists for the CI publish job, which deploys the page and nothing else: on a
   commit that also touches worker.js, the Worker checks would fail a job whose work - the page
   - landed correctly, and a red run nobody trusts is worse than a scoped one. The page checks
   are not reduced by it: every file is still fetched and compared byte-for-byte.

   It answers three questions, and exits 1 if any answer is wrong:

     1. PAGE   is what the edge serves the exact file the gate tested? Every file under
               deploy/ is fetched and its sha256 compared with the local copy, so a stale
               page, a stale icon or a stale manifest all fail - not just index.html.
               Cloudflare can serve an older copy for a few seconds after a deploy, so a
               mismatch is re-fetched before it is believed (see --once).
     2. WORKER is /api/health up, is the metals key resolving, and is the deployed Worker
               the version in worker.js?
     3. CORS   does the API allow the dashboard's own origin, and refuse a foreign one?

   URLs come from the constants below; override them to smoke a preview or a local server:

     SMOKE_PAGE=http://127.0.0.1:8788/ node _smoke.mjs
     SMOKE_API=https://some-preview.workers.dev node _smoke.mjs

   Nothing here is a secret: the health payload is reported as booleans and labels only,
   and no response body is ever printed.
*/
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAGE = "index.html";
const DEPLOY = "deploy";

/* Declared out here because both the full run and the closing message use it. The --page-only
   guard below is a block, and a const inside it is not visible to the verdict at the bottom -
   which is exactly how a successful run once crashed on its own success line. */
let allowedOrigin = null;

/* The published targets. PROD_PAGE is also the origin /api/health must be pinned to, so a
   wrong ALLOWED_ORIGIN in wrangler.toml (which would break the dashboard's own fetches) is
   caught here instead of in the browser console. */
const PROD_PAGE = "https://home-dashboard-5ma.pages.dev";
const PROD_API = "https://home-dashboard-api.drifter-87.workers.dev";

/* Pages meta files are configuration for Cloudflare, not assets it serves, so they have no
   live URL to compare against. */
const NOT_SERVED = new Set(["_headers", "_redirects"]);

const HELP = `Post-deploy smoke test: live page bytes, Worker health, CORS origin.

  node _smoke.mjs                    check production, byte-for-byte
  node _smoke.mjs --once             one fetch per URL, no edge-staleness retries
  node _smoke.mjs --timeout=20000    per-request timeout in ms (default 15000)
  node _smoke.mjs --page-only        the page only, skip the Worker and CORS (CI publish)

Exits 0 only when the live site matches the tested bundle and the API is healthy and
correctly pinned to the dashboard's origin; 1 otherwise. With --page-only, only the first
half of that sentence is claimed.

  SMOKE_PAGE=<url>   page to compare against deploy/ (default ${PROD_PAGE})
  SMOKE_API=<url>    Worker to check (default ${PROD_API}) - unused with --page-only`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const ONCE = argv.includes("--once");
const PAGE_ONLY = argv.includes("--page-only");
const timeoutArg = argv.find((a) => a.startsWith("--timeout="));
const unknown = argv.filter((a) => a !== "--once" && a !== "--page-only" && !a.startsWith("--timeout="));
const TIMEOUT = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) : 15000;
if (unknown.length || !Number.isFinite(TIMEOUT) || TIMEOUT <= 0) {
  console.error("_smoke.mjs: " + (unknown.length ? "unknown flag(s) " + unknown.join(" ") : "bad --timeout value")
    + "\n\n" + HELP);
  process.exit(2);
}

const PAGE_URL = (process.env.SMOKE_PAGE || PROD_PAGE + "/").replace(/\/?$/, "/");
const API_URL = (process.env.SMOKE_API || PROD_API).replace(/\/$/, "");

/* Cloudflare's edge may still hold the previous deployment for a few seconds. DEPLOY.md's
   rule is "re-fetch before concluding anything", so the page hash - the one check staleness
   actually affects - gets a bounded retry; assets are compared once, after it settles. */
const ATTEMPTS = ONCE ? 1 : 3;
const WAIT_MS = 4000;

const fails = [];
const check = (name, ok, detail) => {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "  -> " + detail));
  if (!ok) fails.push({ name, detail });
  return ok;
};
const brief = (h) => (h ? h.slice(0, 12) : "missing");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p) : null;
};

/* one request, never throwing: a dead site is a FAIL to report, not a crash to debug */
async function get(url, init) {
  try {
    const r = await fetch(url, Object.assign({
      redirect: "follow",
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
      signal: AbortSignal.timeout(TIMEOUT)
    }, init || {}));
    const body = Buffer.from(await r.arrayBuffer());
    return { ok: true, status: r.status, headers: r.headers, body };
  } catch (e) {
    /* undici buries the real reason (ECONNREFUSED, ENOTFOUND, a TLS abort) in cause, and on a
       dual-stack host cause is an AggregateError whose own errors[] hold it */
    const cause = e && e.cause;
    const code = (cause && cause.code) || (cause && cause.errors && cause.errors[0] && cause.errors[0].code)
      || (cause && cause.message) || (e && e.name === "TimeoutError" && "timed out after " + TIMEOUT + "ms")
      || (e && e.message);
    return { ok: false, error: String(code || "request failed") };
  }
}

/* every file that is actually published, so a stale icon or manifest cannot slip through */
function bundleFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) bundleFiles(full, out);
    else out.push(relative(join(ROOT, DEPLOY), full).split("\\").join("/"));
  }
  return out;
}

const liveVersion = (html) => {
  const t = html.match(/<title>\s*Home Dashboard v([0-9.]+)\s*<\/title>/i);
  const v = t ? t[1] : (html.match(/VERSION:\s*"([0-9.]+)"/) || [])[1];
  return v || "unknown";
};

console.log("── smoke: " + PAGE_URL + "  →  " + API_URL + " ──");

/* ── 1/3  the page: is the edge serving the file the gate tested? ─────────────── */
const pageLocal = read(PAGE);
const pageDeploy = read(join(DEPLOY, PAGE));
const localHash = pageLocal ? sha(pageLocal) : null;
const testedHash = pageDeploy ? sha(pageDeploy) : null;
const testedVersion = pageDeploy ? liveVersion(pageDeploy.toString("utf8")) : "unknown";
const files = existsSync(join(ROOT, DEPLOY))
  ? bundleFiles(join(ROOT, DEPLOY)).filter((f) => !NOT_SERVED.has(f))
  : [];

check("bundle: " + DEPLOY + "/" + PAGE + " is byte-identical to " + PAGE + " (the hash below is trustworthy)",
  !!localHash && localHash === testedHash,
  testedHash === null ? DEPLOY + "/" + PAGE + " is missing" : brief(localHash) + " / " + brief(testedHash)
    + (localHash === testedHash ? "" : " - run node _deploy.mjs --sync"));

let live = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  live = await get(PAGE_URL);
  const same = live.ok && live.status === 200 && testedHash && sha(live.body) === testedHash;
  if (same || attempt === ATTEMPTS) break;
  if (ATTEMPTS > 1) {
    console.log("      attempt " + attempt + "/" + ATTEMPTS + ": mismatch (edge may still be serving the "
      + "previous deploy), re-fetching in " + WAIT_MS / 1000 + "s");
    await sleep(WAIT_MS);
  }
}

if (!check("page: " + PAGE_URL + " answers 200 text/html",
  !!live && live.ok && live.status === 200 && /text\/html/i.test(live.headers.get("content-type") || ""),
  live && live.ok ? "HTTP " + live.status + " " + (live.headers.get("content-type") || "(no content-type)")
    : "request failed: " + (live && live.error))) {
  /* the remaining comparisons would only repeat the failure */
} else {
  const liveHash = sha(live.body);
  const liveVer = liveVersion(live.body.toString("utf8"));
  check("page: live bytes == tested bundle " + brief(testedHash),
    liveHash === testedHash,
    liveHash === testedHash ? brief(liveHash) + " (" + live.body.length + " bytes)"
      : "live " + brief(liveHash) + " is v" + liveVer + " / " + live.body.length + " bytes, tested is v"
        + testedVersion + " / " + (pageDeploy ? pageDeploy.length : 0) + " bytes");
  check("page: live reports v" + testedVersion,
    liveVer === testedVersion,
    liveVer === testedVersion ? "v" + liveVer : "live says v" + liveVer + " - the page did not publish, or the bundle is stale");

  /* the rest of the bundle: icons, manifest, headers - each compared on its own.

     A deploy lands file by file at the edge, so one asset can still be the previous copy while
     the page is already new: that is propagation, not a bad upload, and failing on the first
     look made a correct release red (sw.js lagged index.html by about a second). Each asset
     therefore gets the same bounded patience the page gets - and a difference that survives it
     is still a failure, so nothing is being waved through. */
  const bad = [];
  for (const name of files) {
    if (name === PAGE) continue;
    const local = read(join(DEPLOY, name));
    if (!local) { bad.push(name + " (missing locally)"); continue; }
    const want = sha(local);
    let why = "not fetched";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const res = await get(PAGE_URL + name);
      /* the reasons are kept apart: a 200 that differs in bytes is a stale asset, not a 404 */
      if (!res.ok) why = res.error;
      else if (res.status !== 200) why = "HTTP " + res.status;
      else if (sha(res.body) !== want) why = "bytes differ";
      else { why = ""; break }
      if (attempt < ATTEMPTS) {
        console.log("      " + name + " attempt " + attempt + "/" + ATTEMPTS + ": " + why
          + " (the edge may still be serving the previous copy), re-checking in " + WAIT_MS / 1000 + "s");
        await sleep(WAIT_MS);
      }
    }
    if (why) bad.push(name + " (" + why + ")");
  }
  check("page: all " + files.length + " published files match " + DEPLOY + "/ (" + PAGE + " + "
    + (files.length - 1) + " assets)", bad.length === 0,
    bad.length ? bad.slice(0, 6).join(", ") + (bad.length > 6 ? ", and " + (bad.length - 6) + " more" : "") : undefined);
}

/* ── 2/3  the Worker ──────────────────────────────────────────────────────────── */
if (!PAGE_ONLY) {
  const workerSrc = read("worker.js");
  const srcVersion = workerSrc ? (workerSrc.toString("utf8").match(/^const VERSION = "([^"]+)";/m) || [])[1] : null;

  const health = await get(API_URL + "/api/health", { headers: { Origin: PROD_PAGE } });
  let healthJson = null;
  if (health.ok && health.status === 200) {
    try { healthJson = JSON.parse(health.body.toString("utf8")); } catch { healthJson = null; }
  }
  const hOk = check("worker: /api/health answers 200 JSON",
    !!healthJson, healthJson ? undefined : health.ok ? "HTTP " + health.status + ": " + health.body.toString("utf8").slice(0, 120) : "request failed: " + health.error);

  if (hOk) {
    check("worker: reports ok: true", healthJson.ok === true, "ok = " + JSON.stringify(healthJson.ok));
    check("worker: metals key resolves", healthJson.keyResolved === true,
      "keyResolved = " + JSON.stringify(healthJson.keyResolved) + ", keyKind = " + JSON.stringify(healthJson.keyKind)
        + (healthJson.keyResolved === true ? "" : " - check the secrets-store binding before trusting /api/metals"));
    check("worker: deployed version matches worker.js" + (srcVersion ? " (" + srcVersion + ")" : ""),
      !!srcVersion && healthJson.v === srcVersion,
      "live v" + healthJson.v + " vs source " + (srcVersion || "unknown")
        + (healthJson.v === srcVersion ? "" : " - run wrangler deploy"));
  }

  /* ── 3/3  CORS: the dashboard's origin in, everything else out ─────────────────── */
  const toml = read("wrangler.toml");
  allowedOrigin = toml ? (toml.toString("utf8").match(/^\s*ALLOWED_ORIGIN\s*=\s*"([^"]*)"/m) || [])[1] : null;

  check("cors: wrangler.toml pins ALLOWED_ORIGIN to " + PROD_PAGE,
    allowedOrigin === PROD_PAGE,
    allowedOrigin === null ? "ALLOWED_ORIGIN not found in wrangler.toml" : allowedOrigin
      + (allowedOrigin === PROD_PAGE ? "" : " - the live dashboard could not read its own API"));

  if (hOk && allowedOrigin) {
    check("cors: the dashboard origin is echoed exactly",
      health.headers.get("access-control-allow-origin") === allowedOrigin,
      "Access-Control-Allow-Origin: " + health.headers.get("access-control-allow-origin")
        + " (want " + allowedOrigin + ")");
    check("cors: Vary: Origin is set (so caches cannot mix the two answers)",
      /(^|,\s*)origin(\s*,|$)/i.test(health.headers.get("vary") || ""),
      "Vary: " + (health.headers.get("vary") || "(absent)"));

    const foreign = "https://not-the-dashboard.example";
    const bad = await get(API_URL + "/api/health", { headers: { Origin: foreign } });
    const acao = bad.ok ? bad.headers.get("access-control-allow-origin") : null;
    check("cors: a foreign origin is not granted access",
      bad.ok && acao !== foreign,
      !bad.ok ? "request failed: " + bad.error
        : "Access-Control-Allow-Origin: " + acao + (acao === foreign ? " - the dashboard origin is not enforced" : ""));

    const pre = await get(API_URL + "/api/health", {
      method: "OPTIONS",
      headers: { Origin: allowedOrigin, "Access-Control-Request-Method": "GET" }
    });
    check("cors: preflight answers 204 with the dashboard origin",
      pre.ok && pre.status === 204 && pre.headers.get("access-control-allow-origin") === allowedOrigin
        && /GET/i.test(pre.headers.get("access-control-allow-methods") || ""),
      pre.ok ? "HTTP " + pre.status + ", allow-origin " + pre.headers.get("access-control-allow-origin")
        + ", allow-methods " + pre.headers.get("access-control-allow-methods")
        : "request failed: " + pre.error);
  }
}

/* ── verdict ──────────────────────────────────────────────────────────────────── */
if (fails.length) {
  console.log("\nSMOKE FAILED (" + fails.length + "):");
  for (const f of fails) {
    const d = f.detail ? String(f.detail) : "";
    console.log("  - " + f.name + (d ? "  ->  " + (d.length > 140 ? d.slice(0, 137) + "..." : d) : ""));
  }
  console.log("This deploy is not verified: fix the failing checks above before calling it done"
    + (ONCE ? " (--once skipped the edge-staleness re-fetch)." : "."));
  process.exit(1);
}
console.log("\nSMOKE PASSED: " + PAGE_URL + " serves the tested bundle " + brief(testedHash)
  + (testedVersion === "unknown" ? "" : " (v" + testedVersion + ")") + ", all " + files.length
  + " files match"
  + (PAGE_ONLY ? " (page only - the Worker and CORS were not checked)."
    : ", the Worker is healthy and its origin is pinned to " + allowedOrigin + "."));
process.exit(0);
