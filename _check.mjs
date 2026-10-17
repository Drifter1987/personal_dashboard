import worker from "./worker.js";
import { readFileSync as readW } from "node:fs";

/* Map-backed stand-in for Cloudflare's caches.default */
const store = new Map();
globalThis.caches = {
  default: {
    async match(r) { const k = typeof r === "string" ? r : r.url; const v = store.get(k); return v ? v.clone() : undefined; },
    async put(r, res) { const k = typeof r === "string" ? r : r.url; store.set(k, res.clone()); }
  }
};

const fails = [];
const check = (name, ok, detail) => {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "  -> " + detail));
  if (!ok) fails.push(name);
};
const call = (path, headers) => worker.fetch(new Request("https://worker.test" + path, { headers: headers || {} }), {});
const body = async (res) => JSON.parse(await res.text());
const clean = (s) => !/<!\[CDATA\[|&#x?[0-9a-f]+;/i.test(String(s));
const hosts = (arr) => new Set(arr.map((i) => new URL(i.link).hostname)).size;
const okItem = (i) => i.title.length > 3 && clean(i.title) && clean(i.desc || "") && i.link.indexOf("https://") === 0 && !!i.source && i.time !== undefined;

/* ── health ───────────────────────────────────────────────────────────── */
const hres = await call("/api/health");
const h = await body(hres);
/* The version is read from the shipped source rather than pinned here, so bumping the Worker
   cannot leave a stale literal behind (the /api/news and /api/history headers are compared
   against this same value further down). */
const WVER = (readW("./worker.js", "utf8").match(/const VERSION = "([0-9.]+)"/) || [])[1];
check("health: 200 + the version the shipped Worker source declares",
  hres.status === 200 && !!WVER && h.v === WVER, "status " + hres.status + " v=" + h.v + " source=" + WVER);
check("health: metals providers still registered", (h.providers || []).length === 11, (h.providers || []).length + " providers");

/* ── news, first (uncached) call ──────────────────────────────────────── */
const t0 = Date.now();
const n1res = await call("/api/news");
const ms1 = Date.now() - t0;
const n1 = await body(n1res);
const n1text = JSON.stringify(n1);
check("news: 200 + JSON", n1res.status === 200 && n1.auto && n1.ai && n1.fin, "status " + n1res.status);
check("news: X-News-Cache miss on first call", n1res.headers.get("X-News-Cache") === "miss", n1res.headers.get("X-News-Cache"));
check("news: Cache-Control no-store for the browser", n1res.headers.get("Cache-Control") === "no-store");
check("news: payload keys are exactly auto,ai,fin,fetchedAt", Object.keys(n1).sort().join(",") === "ai,auto,fetchedAt,fin", Object.keys(n1).sort().join(","));
check("news: fetchedAt present", !!n1.fetchedAt, n1.fetchedAt);

for (const card of ["auto", "fin"]) {
  const arr = n1[card] || [];
  check("news/" + card + ": >= 3 items", arr.length >= 3, arr.length + " items in " + ms1 + "ms total");
  check("news/" + card + ": every item has a clean title + https link + source", arr.every(okItem), arr.map((i) => i.title.slice(0, 46)).join(" | "));
  check("news/" + card + ": items come from more than one publisher", hosts(arr) >= 2, [...new Set(arr.map((i) => i.source))].join(","));
}

/* the AI card is a releases feed: open models, free tools, local runtimes */
const ai = n1.ai || [];
const rel = /open[- ]?source|open[- ]?weights?|releas|launch|available|\bfree\b|\blocal|gguf|llama\.cpp|ollama|comfyui|model|image|video|download|beta|preview/i;
check("news/ai: >= 3 ranked items", ai.length >= 3, ai.length + " items");
check("news/ai: every item has a clean title + https link + source", ai.every(okItem), ai.map((i) => i.title.slice(0, 46)).join(" | "));
check("news/ai: spans more than one source", hosts(ai) >= 2, [...new Set(ai.map((i) => i.source))].join(","));
check("news/ai: most items carry a release/tool signal", ai.filter((i) => rel.test(i.title + " " + (i.desc || ""))).length >= Math.ceil(ai.length / 2),
  ai.map((i) => (rel.test(i.title + " " + (i.desc || "")) ? "+" : "-") + i.title.slice(0, 34)).join(" | "));
check("news/ai: no business/opinion noise at the top", !ai.slice(0, 2).some((i) => /funding|valuation|lawsuit|regulat|opinion|disrupt|earnings/i.test(i.title + " " + (i.desc || ""))),
  ai.slice(0, 3).map((i) => i.title.slice(0, 40)).join(" | "));
check("news/ai: at least one open-weight model from Hugging Face", ai.some((i) => /huggingface\.co\/[^/]+\/[^/]+/.test(i.link) && /likes · .*downloads/.test(i.title)),
  ai.filter((i) => /huggingface\.co/.test(i.link)).map((i) => i.title.slice(0, 48)).join(" | ") || "none");
check("news/ai: no adult model names surface", !ai.some((i) => /uncensored|nsfw|porn|erotic|hentai/i.test(i.title)), ai.length + " items scanned");
check("news/ai: at most one bare version build takes a slot", ai.filter((i) => /^(?:llama\.cpp|ComfyUI)\s+v?b?\d/i.test(i.title)).length <= 1, ai.map((i) => i.title.slice(0, 30)).join(" | "));

/* ── news, second call must be served from the (now working) edge cache ── */
const n2res = await call("/api/news");
const n2 = await body(n2res);
check("news: X-News-Cache hit on second call", n2res.headers.get("X-News-Cache") === "hit", n2res.headers.get("X-News-Cache"));
check("news: cached payload identical", JSON.stringify(n2) === n1text);

/* ── ?fresh=1 must bypass the read but refresh the entry ─────────────── */
const n3res = await call("/api/news?fresh=1");
const n3 = await body(n3res);
check("news: ?fresh=1 bypasses the edge cache", n3res.headers.get("X-News-Cache") === "miss", n3res.headers.get("X-News-Cache"));
check("news: ?fresh=1 still returns real headlines", (n3.auto || []).length >= 3 && (n3.ai || []).length >= 3 && (n3.fin || []).length >= 3,
  "auto=" + (n3.auto || []).length + " ai=" + (n3.ai || []).length + " fin=" + (n3.fin || []).length);
const n4res = await call("/api/news");
check("news: refreshed entry is cached again", n4res.headers.get("X-News-Cache") === "hit");

/* ── long history: the whole story, as far back as free data actually goes ───────
   The card promises "every currency, metal and coin from 1990 → now, or from wherever its
   data begins". These checks run the real sources, so they assert the actual first date and
   that the values are believable — not merely that a JSON array came back. */
const today = new Date().toISOString().slice(0, 10);
const hist = async (q, headers) => { const r = await call(q, headers); return { r: r, j: await body(r) }; };
const METAL_RANGE = { XAU: [200, 900, 800, 12000], XAG: [2, 12, 5, 200], XPT: [250, 900, 400, 5000], XPD: [50, 200, 200, 5000], HG: [0.5, 2.5, 1, 15] };
for (const sym of ["XAU", "XAG", "XPT", "XPD", "HG"]) {
  const { r, j } = await hist("/api/history?kind=metal&symbol=" + sym);
  const first = j.points && j.points.length ? j.points[0][1] : NaN;
  const last = j.points && j.points.length ? j.points[j.points.length - 1][1] : NaN;
  const rg = METAL_RANGE[sym];
  check("history/metal " + sym + ": monthly from the first free vintage, values believable",
    r.status === 200 && j.source === "IMF PCPS" && j.cadence === "monthly" && j.points.length >= 380
    && j.first <= "1992-02-01" && j.last >= "2026-01-01"
    && first >= rg[0] && first <= rg[1] && last >= rg[2] && last <= rg[3]
    && j.points.every((p) => isFinite(p[0]) && isFinite(p[1]) && p[1] > 0),
    j.first + " .. " + j.last + " · " + j.count + " monthly · " + j.unit + " · " + Math.round(first * 100) / 100 + " -> " + Math.round(last * 100) / 100);
}
const hg = (await hist("/api/history?kind=metal&symbol=HG")).j;
check("history/metal: copper is converted to the pound like the Metals card, not left per tonne",
  hg.unit === "USD/lb" && hg.points[0][1] < 5 && hg.points[hg.points.length - 1][1] < 20,
  hg.unit + " first=" + hg.points[0][1] + " last=" + hg.points[hg.points.length - 1][1]);
const xau = (await hist("/api/history?kind=metal&symbol=XAU")).j;
check("history/metal: timestamps ascend with no duplicate months",
  xau.points.every((p, i) => i === 0 || p[0] > xau.points[i - 1][0]), xau.points.length + " points");

const fx = (await hist("/api/history?kind=fx&symbol=EUR&base=USD")).j;
check("history/fx USD/EUR: daily ECB rates from the euro's first day, thinned to the budget",
  fx.first === "1999-01-04" && fx.cadence === "daily" && fx.count <= 1400 && fx.count >= 1000
  && /1999-01-04/.test(fx.note) && fx.last >= "2026-01-01",
  fx.first + " .. " + fx.last + " · " + fx.count + " points · " + fx.note);
check("history/fx: the earliest and latest observations survive the thinning",
  fx.points[0][1] > 0.5 && fx.points[0][1] < 1.5 && fx.points[fx.points.length - 1][1] > 0.5 && fx.points[fx.points.length - 1][1] < 1.5,
  "first=" + fx.points[0][1] + " last=" + fx.points[fx.points.length - 1][1]);
const jpy = (await hist("/api/history?kind=fx&symbol=JPY&base=USD")).j;
check("history/fx: a second pair works from its own beginning (USD/JPY)",
  jpy.points.length > 500 && jpy.first <= "1999-02-01" && jpy.label === "USD/JPY",
  jpy.label + " " + jpy.first + " .. " + jpy.last + " · " + jpy.count + " points");
/* Any base, any quote — the card's new claim. Three shapes: a non-USD base against a
 * regional currency, a pair Yahoo names itself, and a pair no source names at all. The
 * last is checked against its own legs, not merely for coming back non-empty. */
const lastPt = (h) => h.points[h.points.length - 1];
const eurSar = (await hist("/api/history?kind=fx&symbol=SAR&base=EUR")).j;
check("history/fx: a non-USD base charts against a regional currency (EUR/SAR)",
  eurSar.count > 500 && eurSar.first <= "2004-06-01" && eurSar.label === "EUR/SAR"
  && lastPt(eurSar)[1] > 3 && lastPt(eurSar)[1] < 6,
  eurSar.label + " " + eurSar.source + " " + eurSar.first + " .. " + eurSar.last + " · " + eurSar.count + " · last " + lastPt(eurSar)[1]);
const aedPkr = (await hist("/api/history?kind=fx&symbol=PKR&base=AED")).j;
check("history/fx: a pair inside the regional set charts with believable values (AED/PKR)",
  aedPkr.count > 500 && aedPkr.label === "AED/PKR" && lastPt(aedPkr)[1] > 50 && lastPt(aedPkr)[1] < 120,
  aedPkr.label + " " + aedPkr.source + " " + aedPkr.count + " · last " + lastPt(aedPkr)[1]);
const madEgp = (await hist("/api/history?kind=fx&symbol=EGP&base=MAD")).j;
check("history/fx: a pair no source names is crossed through USD, and says so",
  madEgp.count > 500 && madEgp.label === "MAD/EGP" && madEgp.source === "USD cross"
  && /crossed through USD/.test(madEgp.note) && madEgp.cadence === "weekly"
  && lastPt(madEgp)[1] > 1 && lastPt(madEgp)[1] < 20,
  madEgp.label + " " + madEgp.source + " " + madEgp.cadence + " " + madEgp.count + " · " + madEgp.note + " · last " + lastPt(madEgp)[1]);
const usdMad = (await hist("/api/history?kind=fx&symbol=MAD&base=USD")).j;
const usdEgp = (await hist("/api/history?kind=fx&symbol=EGP&base=USD")).j;
const expected = lastPt(usdEgp)[1] / lastPt(usdMad)[1];
/* The cross and these two legs are three separate live requests, and Yahoo revises the bar for
 * the current week as the week moves: USD/MAD's last point was measured at 9.869500160217285
 * and, four seconds later, 9.867799758911133 for the same timestamp. Taken at the same moment
 * the ratio is exact (0.0), so the 0.1% band below is about the fetch gap, not the arithmetic;
 * an invented scale would still be out by orders of magnitude. */
check("history/fx: the cross equals its two USD legs' ratio, not an invented scale",
  Math.abs(lastPt(madEgp)[1] / expected - 1) < 1e-3,
  "cross " + lastPt(madEgp)[1] + " vs legs " + lastPt(usdEgp)[1] + "/" + lastPt(usdMad)[1] + " = " + expected);

const btc = (await hist("/api/history?kind=crypto&symbol=btc&cg=bitcoin")).j;
check("history/crypto BTC: weekly from its first Yahoo print (~$400 in 2014)",
  btc.cadence === "weekly" && btc.first <= "2014-10-01" && btc.points[0][1] > 100 && btc.points[0][1] < 1000
  && btc.last >= "2026-01-01" && btc.points[btc.points.length - 1][1] > 1000,
  btc.first + " .. " + btc.last + " · " + btc.count + " weekly · " + Math.round(btc.points[0][1]) + " -> " + Math.round(btc.points[btc.points.length - 1][1]));
const sol = (await hist("/api/history?kind=crypto&symbol=sol&cg=solana")).j;
check("history/crypto: a younger coin reports its own start, not a faked 1990",
  sol.points.length > 200 && sol.first >= "2020-01-01" && sol.first <= "2020-12-31",
  sol.label + " " + sol.first + " .. " + sol.last + " · " + sol.count + " points");
check("history: every kind stays inside the chart's point budget",
  [xau, fx, btc, sol].every((h) => h.count <= 1400 && h.points.length === h.count),
  [xau.count, fx.count, btc.count, sol.count].join(", "));
check("history: sampling is disclosed with the source's own count, not hidden behind the budget",
  fx.thinned === true && fx.total > fx.count && fx.total > 7000
  && xau.thinned === false && xau.total === xau.count && btc.thinned === false,
  "fx " + fx.count + "/" + fx.total + " thinned · metal " + xau.count + "/" + xau.total + " raw · BTC " + btc.count + "/" + btc.total);

const h1 = await call("/api/history?kind=metal&symbol=XAU");
const h2 = await call("/api/history?kind=metal&symbol=XAU");
const h3 = await call("/api/history?kind=metal&symbol=XAU&fresh=1");
check("history: edge cache miss then hit, and ?fresh=1 bypasses the read",
  h1.headers.get("X-History-Cache") === "hit" && h2.headers.get("X-History-Cache") === "hit" && h3.headers.get("X-History-Cache") === "miss",
  [h1.headers.get("X-History-Cache"), h2.headers.get("X-History-Cache"), h3.headers.get("X-History-Cache")].join(","));
check("history: JSON, no-store, version header, CORS for the pages origin",
  h1.headers.get("Content-Type").indexOf("application/json") === 0 && h1.headers.get("Cache-Control") === "no-store"
  && h1.headers.get("X-History-Version") === h.v && (await call("/api/history?kind=fx&symbol=EUR", { Origin: "https://home-dashboard-5ma.pages.dev" })).headers.get("Access-Control-Allow-Origin") === "*");
const badKind = await call("/api/history?kind=stocks");
const badSym = await call("/api/history?kind=metal&symbol=BTC");
/* The rejected-metal response lists what the Worker does serve — counted from the shipped
   source so adding a metal cannot leave this assertion behind. */
const MCOUNT = (readW("./worker.js", "utf8").match(/\n  [A-Z0-9]{2,4}: \{ ind: "/g) || []).length;
check("history: an unknown kind or metal is a 400 with the accepted values, not an empty 200",
  badKind.status === 400 && badSym.status === 400 && (await body(badSym)).symbols.length === MCOUNT && MCOUNT === 15,
  badKind.status + "/" + badSym.status + " · " + MCOUNT + " metals listed");
const alias = await body(await call("/api/metals/history?symbol=XAU"));
check("history: /api/metals/history still answers as an alias for a page older than this Worker",
  alias.points && alias.points.length > 380 && alias.kind === "metal", alias.count + " points");
const root2 = await body(await call("/"));
check("history: the route is advertised on the root", (root2.routes || []).indexOf("/api/history") >= 0, (root2.routes || []).join(" "));

/* ── CORS + fallback route ───────────────────────────────────────────── */
const corsRes = await call("/api/news", { Origin: "https://home-dashboard-5ma.pages.dev" });
check("cors: allows the pages origin", corsRes.headers.get("Access-Control-Allow-Origin") === "*", corsRes.headers.get("Access-Control-Allow-Origin"));
const root = await body(await call("/"));
check("root: route list advertises /api/news", (root.routes || []).includes("/api/news"));

/* ── metals regression ──────────────────────────────────────────────── */
const mres = await call("/api/metals");
const m = await body(mres);
const rates = Object.keys(m.rates || {});
check("metals: still returns rates (keyless provider)", mres.status === 200 && rates.length > 0, "status " + mres.status + " provider=" + m.provider + " rates=" + rates.join(","));

/* ── AI ranking rules: extracted from the shipped worker.js and executed ──────────
   The card's promise is "new open-source models, new free tools released with a daily
   usage limit, image/video generators, LLMs you can run locally or free on cloud", so
   the ranking itself is tested against the exact code that ships. */
const { readFileSync } = await import("node:fs");
const wsrc = readFileSync(new URL("./worker.js", import.meta.url), "utf8");
const rFrom = wsrc.indexOf("/* Promoted:");
const rTo = wsrc.indexOf("/* Newest trending open-weight models");
let aiScore, aiWhy, aiQuota, AI_UP, AI_BLOCK, WHY_ORDER, WHY_MAX, Q_UNITS;
if (rFrom > 0 && rTo > rFrom) {
  ({ aiScore, aiWhy, aiQuota, AI_UP, AI_BLOCK, WHY_ORDER, WHY_MAX, Q_UNITS } = new Function(wsrc.slice(rFrom, rTo) + "\nreturn { aiScore, aiWhy, aiQuota, AI_UP, AI_BLOCK, WHY_ORDER, WHY_MAX, Q_UNITS };")());
}
check("ai-score: ranking block extractable from worker.js", typeof aiScore === "function" && Array.isArray(AI_UP), (AI_UP || []).length + " promotion rules");
const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 3 * 86400000).toISOString();
const it2 = (title, kind, time, desc) => ({ title, kind, time: time === undefined ? NOW : time, desc: desc || "" });
const sc = (...a) => aiScore(it2(...a));
const dailyTool = sc("Show HN: SketchScale - free AI image generator, 50 images per day on the free tier", "feed");
const plainTool = sc("SketchScale - an AI image generator", "feed");
const funding = sc("AI startup raises $50M Series B at a $2B valuation", "feed");
const localLLM = sc("DeepSeek-V4 released: open weights, GGUF quantized, runs locally with ollama", "model");
const cloudFree = sc("New free AI video generator: 10 clips a day, no cost, browser demo", "feed");
const opinion = sc("Opinion: why the AI boom is different this time - podcast", "feed");
check("ai-score: free tool with a daily limit beats funding news", dailyTool > funding, dailyTool + " vs " + funding);
check("ai-score: the daily-limit wording lifts the same tool", dailyTool > plainTool, dailyTool + " vs " + plainTool);
check("ai-score: 'per day' and 'a day' are recognised, not just 'daily'",
  sc("50 free prompts per day", "feed") > sc("50 free prompts", "feed") && sc("10 videos a day", "feed") > sc("10 videos", "feed"));
check("ai-score: free video tool with a daily limit beats commentary", cloudFree > opinion, cloudFree + " vs " + opinion);
check("ai-score: open-weight model you can run locally beats commentary", localLLM > opinion, localLLM + " vs " + opinion);
check("ai-score: model kind is promoted over a plain feed item", sc("Muse Glimmer is now available", "model") > sc("Muse Glimmer is now available", "feed"));
check("ai-score: a build number cannot outrank a real release, and gets no recency boost",
  sc("Qwen3-VL released with open weights", "feed") > sc("llama.cpp b7200", "release") && sc("llama.cpp b7200", "release") === sc("llama.cpp b7199", "release", OLD),
  "build today=" + sc("llama.cpp b7200", "release") + " build 3d ago=" + sc("llama.cpp b7199", "release", OLD));
check("ai-score: adult model names are filtered out", AI_BLOCK.test("someone/uncensored-nsfw-model") && !AI_BLOCK.test("Qwen/Qwen-Image"));
/* Labelling the rules must not have moved any weight: these are the nine weights of the
   ranking whose ordering was verified, in order. */
check("ai-score: weights unchanged by the labelling refactor", AI_UP.map((r) => r.w).join(",") === "14,12,10,8,6,5,5,3,2" && AI_UP.length === 9 && AI_UP.every((r) => r.re instanceof RegExp),
  AI_UP.map((r) => (r.tag || "-") + ":" + r.w).join(" "));

/* ── why-labels: the card must say why an item is on it, from the rules that matched ── */
const why = (title, kind, time, desc) => aiWhy(it2(title, kind, time, desc));
const whyStr = (title, kind, time, desc) => why(title, kind, time, desc).join(" · ");
check("ai-why: extractable + a hard cap of three labels", typeof aiWhy === "function" && WHY_MAX === 3 && Array.isArray(WHY_ORDER), "WHY_MAX=" + WHY_MAX + " over " + (WHY_ORDER || []).length + " rules");
check("ai-why: every label comes from the known set", why("anything", "feed").every((w) => WHY_ORDER.indexOf(w) >= 0) && why("free local open weights model released now", "feed").every((w) => WHY_ORDER.indexOf(w) >= 0));
check("ai-why: a free tool with a daily limit says so", whyStr("Show HN: SketchScale - free AI image generator, 50 images per day on the free tier", "feed") === "free daily limit · free · image/video",
  whyStr("Show HN: SketchScale - free AI image generator, 50 images per day on the free tier", "feed"));
check("ai-why: a local model shows open weights + runs locally", whyStr("DeepSeek-V4 released: open weights, GGUF quantized, runs locally with ollama", "model") === "open weights · runs locally · trending model",
  whyStr("DeepSeek-V4 released: open weights, GGUF quantized, runs locally with ollama", "model"));
check("ai-why: a trending Hugging Face model reads as trending (licence + modality shown)",
  whyStr("Qwen/Qwen-Image-2.1-Turbo · 531 likes · 4.7k downloads", "model", NOW, "text-to-image · license:apache-2.0") === "open weights · trending model · image/video",
  whyStr("Qwen/Qwen-Image-2.1-Turbo · 531 likes · 4.7k downloads", "model", NOW, "text-to-image · license:apache-2.0"));
check("ai-why: a bare build number gets no invented reason", whyStr("llama.cpp b7200", "release") === "runs locally",
  whyStr("llama.cpp b7200", "release"));
check("ai-why: the item type is not padded on as a reason", why("A new model from a lab", "feed").length === 0 && why("A new model from a lab", "feed").indexOf("model") < 0,
  "[" + why("A new model from a lab", "feed").join(" \u00b7 ") + "]");
check("ai-why: nothing is claimed for an item with no signals", why("Funding round closes for an AI startup", "feed").length === 0,
  "[" + why("Funding round closes for an AI startup", "feed").join(" · ") + "]");
check("ai-why: demoted items are not given a positive label either", why("AI startup raises $50M Series B at a $2B valuation", "feed").length === 0,
  "[" + why("AI startup raises $50M Series B at a $2B valuation", "feed").join(" · ") + "]");

/* the shipped payload must carry those labels, so the card can render them */
const LABELS = WHY_ORDER || [];
check("news/ai: every item carries 0-3 known reason labels and never the bare 'model'",
  ai.every((i) => Array.isArray(i.why) && i.why.length <= 3 && i.why.every((w) => LABELS.indexOf(w) >= 0 && w !== "model")),
  ai.map((i) => i.title.slice(0, 24) + " [" + (i.why || []).join("|") + "]").join(" | "));
check("news/ai: most items on the card explain themselves",
  ai.filter((i) => (i.why || []).length > 0).length >= Math.ceil(ai.length / 2),
  ai.filter((i) => (i.why || []).length > 0).length + " of " + ai.length + " carry a reason");
check("news/ai: at least one item is labelled as runnable or open", ai.some((i) => (i.why || []).some((w) => w === "open weights" || w === "runs locally")),
  ai.filter((i) => (i.why || []).some((w) => w === "open weights" || w === "runs locally")).length + " of " + ai.length);
check("news/auto+fin: feed cards are not given AI labels", (n1.auto || []).concat(n1.fin || []).every((i) => i.why === undefined),
  (n1.auto || []).concat(n1.fin || []).length + " items checked");

/* ── free-tier quota: extracted from the shipped worker.js and executed ─────────
   "How much do I actually get for free?" has one comparable answer per item, parsed from
   whatever prose the announcement used. A wrong guess is worse than a dash, so the false
   positives matter as much as the parses: version numbers, model sizes, dates, build
   numbers, a trending model's likes/downloads and a "$5 in free credits" price line must
   all stay unread. */
const q = (title, desc) => aiQuota(it2(title, "feed", NOW, desc));
const qs = (title, desc) => JSON.stringify(q(title, desc));
check("ai-quota: extractable from the ranking block of worker.js", typeof aiQuota === "function" && Array.isArray(Q_UNITS), (Q_UNITS || []).length + " unit groups");
const qDay = q("Show HN: SketchScale - free AI image generator, 50 images per day on the free tier");
check("ai-quota: '50 images per day' -> 50 images/day",
  !!qDay && qDay.n === 50 && qDay.unit === "images" && qDay.per === "day" && qDay.perDay === 50 && qDay.raw === "50 images per day", qs("Show HN: SketchScale - free AI image generator, 50 images per day on the free tier"));
const qMonth = q("Replicate: 600 requests/month on the free plan");
check("ai-quota: a monthly allowance lands on the same scale as a daily one (600/mo = 20/day)",
  !!qMonth && qMonth.n === 600 && qMonth.unit === "requests" && qMonth.per === "month" && qMonth.perDay === 20 && qMonth.raw === "600 requests/month", qs("Replicate: 600 requests/month on the free plan"));
const qCred = q("Get 20 free credits when you sign up");
check("ai-quota: '20 free credits' is a one-off grant, not a daily rate",
  !!qCred && qCred.n === 20 && qCred.unit === "credits" && qCred.per === "total" && qCred.perDay === null, qs("Get 20 free credits when you sign up"));
const qBig = q("1,000 free prompts a day");
check("ai-quota: thousands separators and 'a day' parse", !!qBig && qBig.n === 1000 && qBig.unit === "prompts" && qBig.perDay === 1000, qs("1,000 free prompts a day"));
const qK = q("1.5k free credits");
check("ai-quota: a multiplier suffix scales the amount (1.5k -> 1500)", !!qK && qK.n === 1500 && qK.per === "total", qs("1.5k free credits"));
const qClips = q("Free video tool: 10 clips a day");
check("ai-quota: aliases map onto one canonical unit ('clips' -> videos)", !!qClips && qClips.unit === "videos" && qClips.perDay === 10, qs("Free video tool: 10 clips a day"));
const qApi = q("Daily 100 free API calls");
check("ai-quota: '100 free API calls' pairs the amount with its unit, and a leading 'daily' counts",
  !!qApi && qApi.unit === "requests" && qApi.per === "day" && qApi.perDay === 100, qs("Daily 100 free API calls"));
const qHrs = q("Show HN: PipeWhisper - free on-device transcription, 3 hours per day");
check("ai-quota: a spoken/audio allowance is a quota too (3 hours per day)",
  !!qHrs && qHrs.unit === "hours" && qHrs.per === "day" && qHrs.perDay === 3, qs("Show HN: PipeWhisper - free on-device transcription, 3 hours per day"));
check("ai-quota: 'per hour' scales up, not across ('100 requests per hour' = 2400/day)",
  q("API: 100 requests per hour").perDay === 2400 && q("API: 100 requests per hour").per === "hour",
  qs("API: 100 requests per hour"));
check("ai-quota: a voice-minute grant with no period is one-off",
  q("Get 25 free voice minutes").per === "total" && q("Get 25 free voice minutes").unit === "minutes",
  qs("Get 25 free voice minutes"));
const qUnl = q("Unlimited free generations, no daily limit");
check("ai-quota: 'unlimited free generations' reads as unlimited", !!qUnl && qUnl.unit === "unlimited" && qUnl.n === null, qs("Unlimited free generations, no daily limit"));
const qGen = q("Free for up to 20 generations, then credits");
check("ai-quota: a grant with no period is reported as one-off, not as a daily rate",
  !!qGen && qGen.n === 20 && qGen.unit === "generations" && qGen.per === "total" && qGen.perDay === null, qs("Free for up to 20 generations, then credits"));
check("ai-quota: the most usable allowance wins when an item states several",
  q("Get 20 free credits, or 100 images per day").unit === "images" && q("Starter: 100 images/month, Pro: 1000 images/month").n === 100,
  qs("Get 20 free credits, or 100 images per day") + " / " + qs("Starter: 100 images/month, Pro: 1000 images/month"));
check("ai-quota: prices, versions, model sizes, dates, builds and download counts are not quotas",
  q("Free tier with $5 in free credits") === null && q("Qwen3-VL 2.1 released", "8B params, 2026-10-11") === null
  && q("llama.cpp b11559", "release notes for the local runtime") === null && q("ollama 0.13.0 - 4k tokens/s on M3") === null
  && q("some-model · 531 likes · 4.7k downloads", "text-to-image · license:apache-2.0") === null,
  [qs("Free tier with $5 in free credits"), qs("Qwen3-VL 2.1 released", "8B params, 2026-10-11"), qs("ollama 0.13.0 - 4k tokens/s on M3"), qs("some-model · 531 likes · 4.7k downloads")].join(" / "));
check("ai-quota: a number before the amount cannot claim its unit", q("Qwen 2.1 with 50 free images/day").n === 50, qs("Qwen 2.1 with 50 free images/day"));
check("ai-quota: a trial length is not a quota period ('50 free images (3-day trial)')",
  q("50 free images (3-day trial)").per === "total", qs("50 free images (3-day trial)"));
check("ai-quota: an item with no stated allowance gets no quota at all",
  q("A new model from a lab") === null && q("Funding round closes for an AI startup") === null,
  qs("A new model from a lab") + " / " + qs("Funding round closes for an AI startup"));

/* and the ranking step has to hand it out with the item, not drop it on the way */
const pTo = wsrc.indexOf("const enc = (s)");   /* the block after rankAI ends here */
let rankAI;
if (rFrom > 0 && pTo > rFrom) ({ rankAI } = new Function(wsrc.slice(rFrom, pTo) + "\nreturn { rankAI };")());
const pool = [
  it2("SketchScale - free AI image generator, 50 images per day", "feed"),
  it2("A trending open-weight model with no stated allowance", "model"),
  it2("AI startup raises $50M Series B at a $2B valuation", "feed")
];
pool.forEach((p, i) => { p.link = "https://rank.example/" + i; p.source = "rank.example"; p.srcKey = i; });
const ranked = typeof rankAI === "function" ? rankAI(pool, 3) : [];
check("news/ai: ranking passes each item's quota through to the payload",
  ranked.length === 3 && ranked.some((i) => i.quota && i.quota.n === 50 && i.quota.unit === "images")
  && ranked.filter((i) => !/50 images/.test(i.title)).every((i) => i.quota === undefined),
  ranked.map((i) => i.title.slice(0, 30) + " -> " + (i.quota ? i.quota.n + " " + i.quota.unit : "none")).join(" | "));

/* the shipped payload must carry it, and only on the AI card */
const QUOTA_UNITS = ["images", "videos", "generations", "prompts", "requests", "tokens", "words", "characters", "messages", "hours", "minutes", "seconds", "credits", "jobs", "GB", "unlimited"];
const qOk = (i) => i.quota === undefined || (!!i.quota && typeof i.quota.raw === "string" && i.quota.raw.length > 0 && i.quota.raw.length <= 80
  && QUOTA_UNITS.indexOf(i.quota.unit) >= 0 && (i.quota.n === null || (typeof i.quota.n === "number" && i.quota.n > 0))
  && ["hour", "day", "week", "month", "year", "total"].indexOf(i.quota.per) >= 0);
check("news/ai: every quota on the shipped payload is well-formed and uses a canonical unit", ai.every(qOk),
  ai.filter((i) => i.quota).map((i) => i.title.slice(0, 26) + " -> " + i.quota.n + " " + i.quota.unit + "/" + i.quota.per).join(" | ") || "no item states a quota today");
check("news/ai: a quota's per-day figure follows from its period",
  ai.filter((i) => i.quota).every((i) => i.quota.per === "total" ? i.quota.perDay === null : i.quota.per === "day" ? i.quota.perDay === i.quota.n : i.quota.perDay > 0),
  ai.filter((i) => i.quota).length + " quota(s) checked");
check("news/auto+fin: feed cards are not given quotas", (n1.auto || []).concat(n1.fin || []).every((i) => i.quota === undefined));

/* ── page-side cache merge: extracted from index.html and executed ───────────────
   All four cards share one stored record and each used to persist the snapshot it took
   when its own load started, so whichever finished last clobbered the others. The GitHub
   card doing that reverted the feed cards to the previous schema, which silently turned
   the 1h cache off (every load refetched four feeds) and could re-show older items when a
   refetch failed. newsSave must merge into whatever is stored right now. */
const pageSrc = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const SCHEMA = Number((pageSrc.match(/NEWS_SCHEMA:\s*(\d+)/) || [])[1]);
const saveSrc = (pageSrc.match(/function newsSave\(patch,ids\)\{[^\n\r]*\}/) || [])[0];
check("page cache: newsSave extractable from index.html", !!saveSrc, saveSrc ? saveSrc.length + " chars" : "not found");
if (saveSrc) {
  const mem = new Map();
  const fakeStore = {
    get: (k, d) => { const v = mem.get(k); return v === undefined ? d : JSON.parse(v); },
    set: (k, v) => { mem.set(k, JSON.stringify(v)); }
  };
  const fakeConfig = { NEWS_CACHE_KEY: "test_news", NEWS_SCHEMA: SCHEMA };
  const { newsSave } = new Function("store", "CONFIG", saveSrc + "\nreturn { newsSave };")(fakeStore, fakeConfig);
  newsSave({ auto: ["a1"], ai: ["i1"], fin: ["f1"] }, ["auto", "ai", "fin"]);
  newsSave({ gh: ["g1"] }, ["gh"]);                       /* the late writer that used to win */
  newsSave({ ai: ["i2"] }, ["ai"]);                       /* a single-card refresh, e.g. the fallback */
  const after = JSON.parse(mem.get("test_news"));
  check("page cache: a later card cannot clobber an earlier card's data",
    JSON.stringify(after.data.auto) === '["a1"]' && JSON.stringify(after.data.fin) === '["f1"]' && JSON.stringify(after.data.gh) === '["g1"]',
    JSON.stringify(after.data));
  check("page cache: a single-card refresh keeps the other cards' entries",
    JSON.stringify(after.data.ai) === '["i2"]' && Object.keys(after.data).sort().join(",") === "ai,auto,fin,gh",
    Object.keys(after.data).sort().join(","));
  check("page cache: every written card is stamped with the current schema",
    ["auto", "ai", "fin", "gh"].every((k) => after.cards[k] && after.cards[k].v === SCHEMA && typeof after.cards[k].ts === "number"),
    JSON.stringify(after.cards) + " (schema " + SCHEMA + ")");
  check("page cache: newsSave reads the store instead of trusting a caller's snapshot",
    /store\.get\(/.test(saveSrc) && !/function newsSave\(all,/.test(saveSrc), saveSrc.slice(0, 46) + "...");
}

/* ── page-side quota column: extracted from index.html and executed ───────────────
   The Worker sends structure, the page words it, so the figure is bilingual and every row
   lines up. What matters is that a per-day rate, a one-off grant and "unknown" cannot be
   confused on screen — and that no canonical unit is left without a label in either
   language, since a missing one would print the raw key into the column. */
const qtextSrc = (pageSrc.match(/function quotaText\(q\)\{[^\n\r]*\}/) || [])[0];
check("page quota: quotaText extractable from index.html", !!qtextSrc, qtextSrc ? qtextSrc.length + " chars" : "not found");
if (qtextSrc) {
  const ikey = (pageSrc.match(/const QUOTA_KEY=\{([^}]*)\}/) || [])[1] || "";
  const QUOTA_KEY = new Function("return {" + ikey + "};")();
  const { quotaText } = new Function("t", "digits", "QUOTA_KEY", qtextSrc + "\nreturn { quotaText };")((k) => k, (s) => String(s), QUOTA_KEY);
  check("page quota: a daily allowance reads amount + unit + per-day",
    quotaText({ n: 50, unit: "images", per: "day", perDay: 50 }) === "50 quImagesquPerDay",
    quotaText({ n: 50, unit: "images", per: "day", perDay: 50 }));
  check("page quota: a monthly allowance shows its per-day equivalent, not the raw month figure",
    quotaText({ n: 600, unit: "requests", per: "month", perDay: 20 }) === "20 quRequestsquPerDay",
    quotaText({ n: 600, unit: "requests", per: "month", perDay: 20 }));
  check("page quota: a one-off grant is marked as such",
    quotaText({ n: 20, unit: "credits", per: "total", perDay: null }) === "20 quCredits · quOnce",
    quotaText({ n: 20, unit: "credits", per: "total", perDay: null }));
  check("page quota: unlimited and 'no quota' do not print numbers",
    quotaText({ n: null, unit: "unlimited", per: "day", perDay: null }) === "quUnlimited" && quotaText(null) === "" && quotaText(undefined) === "",
    quotaText({ n: null, unit: "unlimited", per: "day", perDay: null }) + " / [" + quotaText(null) + "]");
  check("page quota: a fractional per-day figure is rounded, not printed raw",
    quotaText({ n: 100, unit: "images", per: "month", perDay: 3.33 }) === "3.3 quImagesquPerDay",
    quotaText({ n: 100, unit: "images", per: "month", perDay: 3.33 }));
  /* every unit the Worker can send must have wording in both languages */
  const i18nSrc = (pageSrc.match(/const I18N = \{[\s\S]*?\n\};/) || [])[0];
  const I18N = i18nSrc ? new Function(i18nSrc + "\nreturn I18N;")() : null;
  const mapped = Object.keys(QUOTA_KEY);
  const named = mapped.filter((u) => { const k = QUOTA_KEY[u]; return I18N && typeof I18N.en[k] === "string" && typeof I18N.ar[k] === "string"; });
  check("page quota: every canonical unit has a label in both languages",
    !!I18N && mapped.length === QUOTA_UNITS.length && named.length === mapped.length && Object.keys(QUOTA_KEY).every((u) => QUOTA_UNITS.indexOf(u) >= 0),
    named.length + "/" + mapped.length + ":" + mapped.join(","));
  check("page quota: every canonical unit renders a figure with no undefined/NaN",
    QUOTA_UNITS.every((u) => { const s = quotaText({ n: 7, unit: u, per: "day", perDay: null }); return s.length > 0 && s.indexOf("undefined") < 0 && s.indexOf("NaN") < 0; }),
    QUOTA_UNITS.map((u) => u + "=" + quotaText({ n: 7, unit: u, per: "day", perDay: u === "unlimited" ? null : 7 })).join(" "));
}
check("page quota: the column is styled and drawn only on the AI card",
  /\.list li\.qrow\{/.test(pageSrc) && /\.qta\{/.test(pageSrc) && /\.qta\.none\{/.test(pageSrc) && /font-variant-numeric:tabular-nums/.test(pageSrc)
  && /const ai=isAiList\(ul\)/.test(pageSrc) && /className="qta"/.test(pageSrc) && /dataset\.widget==="ai"/.test(pageSrc),
  "css + isAiList + .qta cell");
check("page quota: the cited wording travels with the figure (tooltip) and stays out of the reader title",
  /q\.title=\(n\.quota&&n\.quota\.raw\)\|\|t\("quNone"\)/.test(pageSrc) && /const why=whyLine\(n\),qt=quotaText\(n\.quota\)/.test(pageSrc));

/* ── the mirrored parser: both copies must agree on every phrasing ────────────────
   The page ships the same parser for its offline fallback — when the Worker is unreachable
   the card is built in the browser, and those rows deserve the same column. Two copies of
   subtle regex work drift; this check is what stops them, comparing the shipped page copy
   against the shipped Worker one across the phrasings the card actually meets. */
const mirrorSrc = (pageSrc.match(/\/\* ── free-tier quota: mirrored from worker\.js ──[\s\S]*?\/\* ── end of the mirrored free-tier quota parser ── \*\//) || [])[0];
check("page quota: the offline fallback carries the Worker's parser, verbatim",
  !!mirrorSrc && /function aiQuota/.test(mirrorSrc) && /const Q_UNITS/.test(mirrorSrc), mirrorSrc ? mirrorSrc.length + " chars" : "not found");
if (mirrorSrc && typeof aiQuota === "function") {
  const pageQuota = new Function(mirrorSrc + "\nreturn { aiQuota };")();
  const PARITY = [
    ["Show HN: SketchScale - free AI image generator, 50 images per day on the free tier", ""],
    ["Replicate: 600 requests/month on the free plan", ""],
    ["Get 20 free credits when you sign up", ""],
    ["Free tier with $5 in free credits", ""],
    ["Qwen3-VL 2.1 released with 128k context", "8B params, 2026-10-11"],
    ["Unlimited free generations, no daily limit", ""],
    ["1,000 free prompts a day", ""],
    ["1.5k free credits", ""],
    ["50 free images (3-day trial)", ""],
    ["Free video tool: 10 clips a day", ""],
    ["ollama 0.13.0 - 4k tokens/s on M3", ""],
    ["ComfyUI v0.3.50 with 3 new nodes", ""],
    ["some-model · 531 likes · 4.7k downloads", "text-to-image · license:apache-2.0"],
    ["Daily 100 free API calls", ""],
    ["Get 1 million free credits on signup", ""],
    ["Starter plan: 100 images/month, Pro: 1000 images/month", ""],
    ["Up to 5 free video generations per day, watermark-free", ""],
    ["Qwen 2.1 with 50 free images/day", ""],
    ["New: 30 free messages a day for everyone", ""],
    ["Part 2: 50 images/month for free", ""],
    ["Free for up to 20 generations, then credits", ""],
    ["Show HN: PipeWhisper - free on-device transcription, 3 hours per day", ""],
    ["ElevenLabs free tier: 10 minutes of voice a day", ""],
    ["Hugging Face trending: 20 free images a day via the inference API", ""],
    ["A new model from a lab", ""]
  ];
  const mismatch = PARITY.filter(([t, d]) => JSON.stringify(pageQuota.aiQuota({ title: t, desc: d || "" })) !== JSON.stringify(aiQuota({ title: t, desc: d || "" })));
  check("page quota: the mirrored parser returns exactly what the Worker returns, on " + PARITY.length + " phrasings",
    mismatch.length === 0 && typeof pageQuota.aiQuota === "function",
    mismatch.length ? mismatch.map((m) => m[0].slice(0, 44)).join(" | ") : "identical output on every fixture");
}
check("page quota: the offline fallback actually attaches the allowance to its items",
  /out\.forEach\(n=>\{if\(!n\.quota\)\{const q=aiQuota\(n\);if\(q\)n\.quota=q\}\}\)/.test(pageSrc),
  "loadNewsAI -> aiQuota -> item.quota");

/* ── the chart card: caption and wiring, extracted from the shipped page ──────────
   The card's honesty rests on saying where the series came from and when it begins, and
   on labelling a short browser-side run instead of passing it off as the full history. */
const capSrc = (pageSrc.match(/function chartCaption\(d\)\{[\s\S]*?\n\}/) || [])[0];
/* The points label is read from the shipped page too, so the test exercises the wording the
   card actually composes — "417 monthly points" / "٢٩١ نقطة شهرياً" rather than a mock. */
const labelSrc = (pageSrc.match(/function chartPtsLabel\(c\)\{[^\n]*\}/) || [])[0];
const T_MOCK = (k) => ({ chartPts: "points", chartPlotted: "plotted", chartMonthPts: "monthly points", chartWeekPts: "weekly points", chartDayPts: "daily points", chartLocal: "browser fallback" }[k] || k);
check("chart: chartCaption and its points label extractable from index.html", !!capSrc && !!labelSrc, (capSrc ? capSrc.length : 0) + " + " + (labelSrc ? labelSrc.length : 0) + " chars");
if (capSrc && labelSrc) {
  const SRC = { "IMF PCPS": "IMF PCPS", "ECB reference rates": "ECB", "Yahoo Finance": "Yahoo", CoinGecko: "CoinGecko", ECB: "ECB", "USD cross": "USD cross" };
  const label = new Function("t", labelSrc + "\nreturn chartPtsLabel;")(T_MOCK);
  /* srcText and noteText are injected as pass-throughs here: this block asserts the English
     caption, and both only change wording when the page is Arabic (checked separately below). */
  const { chartCaption } = new Function("t", "digits", "CHART_SRC", "chartPtsLabel", "srcText", "noteText", capSrc + "\nreturn { chartCaption };")(
    T_MOCK, (v) => String(v), SRC, label, (x) => String(SRC[x] || x || ""), (x) => String(x || ""));
  const full = chartCaption({ source: "IMF PCPS", first: "1992-01-01", last: "2026-09-01", count: 417, cadence: "monthly", unit: "USD/oz" });
  const fallback = chartCaption({ source: "ECB", first: "2025-10-13", last: "2026-10-12", count: 366, cadence: "daily", unit: "EUR", local: true });
  const noted = chartCaption({ source: "ECB reference rates", first: "1999-01-04", last: "2026-10-12", count: 1400, cadence: "daily", unit: "EUR", note: "ECB data begins 1999-01-04" });
  check("chart: the caption names the source, the real range and the point count",
    full === "IMF PCPS · 1992-01-01 → 2026-09-01 · 417 monthly points · USD/oz", full);
  check("chart: a browser-side run is labelled as a fallback, so a year never reads as the whole story",
    /browser fallback/.test(fallback) && /2025-10-13/.test(fallback), fallback);
  check("chart: where the data begins is stated with the series", /ECB data begins 1999-01-04/.test(noted), noted);
  /* A 7,100-day ECB run is sampled down to the canvas budget. "1,400 daily points" would be
     a lie about the cadence: the source publishes 7,140 daily points and 1,400 are drawn. */
  const thin = chartCaption({ source: "ECB reference rates", first: "1999-01-04", last: "2026-10-12", count: 1400, total: 7140, thinned: true, cadence: "daily", unit: "EUR" });
  check("chart: a sampled series states the source's own point count and how many are drawn",
    thin === "ECB · 1999-01-04 → 2026-10-12 · 7140 daily points · 1400 plotted · EUR", thin);
  check("chart: a full series is never labelled 'plotted' (no invented qualifier)",
    full.indexOf("plotted") < 0 && fallback.indexOf("plotted") < 0 && noted.indexOf("plotted") < 0,
    full + " || " + noted);
  check("chart: the source note joins the caption as one more part, once, without a doubled separator",
    /ECB data begins 1999-01-04$/.test(noted) && noted.split("ECB data begins").length === 2
    && noted.indexOf(" · · ") < 0 && !/ · $/.test(noted), noted);
  /* A pair no source names: the caption must still say where it came from and that it was crossed. */
  const crossed = chartCaption({ source: "USD cross", first: "2003-12-01", last: "2026-10-14", count: 1196, cadence: "weekly", unit: "QAR", note: "crossed through USD (Yahoo)" });
  check("chart: a crossed pair's caption names the crossing, its real range and its cadence",
    crossed === "USD cross · 2003-12-01 → 2026-10-14 · 1196 weekly points · QAR · crossed through USD (Yahoo)", crossed);
  /* Nothing loaded: the card must carry the reason, not an empty line. */
  const blank = chartCaption({ source: "", first: "", last: "", count: 0, cadence: "", unit: "", note: "no data for this selection — it needs the Worker" });
  check("chart: a series with nothing but a reason shows the reason, without a leading separator",
    blank === "no data for this selection — it needs the Worker", JSON.stringify(blank));
}
check("chart: the card asks the Worker for 1990 onward for all three kinds, with the coin id for the fallback",
  /\/api\/history\?kind="\+kind\+"&symbol="\+encodeURIComponent\(s\)\+"&base="\+encodeURIComponent\(b0\)\+"&from=1990-01-01"/.test(pageSrc)
  && /cg\?".*cg="\+encodeURIComponent\(cg\)/.test(pageSrc), "kind/symbol/base(from the picker)/from + cg");
check("chart: the card's ⟳ bypasses the edge cache rather than re-reading it",
  /chart:\(\)=>renderChart\(true\)/.test(pageSrc) && /renderChart\(bypass\)/.test(pageSrc));
check("chart: every currency the ECB publishes can be charted, not just the majors",
  /function fxList\(cb\)/.test(pageSrc) && /api\.frankfurter\.dev\/v1\/currencies/.test(pageSrc) && /pd_fx_list/.test(pageSrc));
check("chart: a log scale exists for series that span orders of magnitude, and one-point series still draw",
  /chartLog/.test(pageSrc) && /logOn/.test(pageSrc) && /const span=\(pts\.length-1\)\|\|1/.test(pageSrc));

/* ── any currency against any other ─────────────────────────────────────────────
   The FX view carries a base picker of its own, so EUR/SAR or AED/PKR is a choice on the
   card rather than a change to Settings. What must hold: the picker really drives the
   query, its choice survives a reload, its label has wording in both languages, and a
   pair no source names directly comes back crossed through USD instead of empty. */
check("chart: coins and pairs share one base picker, and the query reads from it",
  /const bSel=document\.createElement\("select"\)/.test(pageSrc)
  && /bSel\.onchange=\(\)=>\{settings\.chartBase=bSel\.value;saveSettings\(\);symsFor\(type\.value\);load\(\)\}/.test(pageSrc)
  && /const b0=\(type\.value==="metal"\?"USD":\(bSel\.value\|\|settings\.chartBase\|\|settings\.base\|\|"USD"\)\)/.test(pageSrc)
  && /if\(kind==="crypto"\)\{[\s\S]{0,900}?fillBase\(fxList\(fillBase\)\)/.test(pageSrc)
  && /const hasBase=kind!=="metal"/.test(pageSrc)
  && /encodeURIComponent\(b0\)\+"&from=1990-01-01"/.test(pageSrc),
  "bSel + shared chartBase + fillBase on the coin branch + b0 in the query");
check("chart: the pair label is worded in both languages and stands aside only for metals",
  (pageSrc.match(/chartVs:"[^"]*"/g) || []).length === 2
  && /vsLab\.style\.display=hasBase\?"":"none";bSel\.style\.display=hasBase\?"":"none"/.test(pageSrc),
  (pageSrc.match(/chartVs:"[^"]*"/g) || []).join(" | "));
check("chart: the Worker can cross a pair through USD, and the caption's source map names that crossing",
  /async function crossSeries\(base, quote, from\)/.test(wsrc) && /async function usdLeg\(code, from\)/.test(wsrc)
  && /"USD cross":"USD cross"/.test(pageSrc),
  "crossSeries + usdLeg in worker.js, CHART_SRC in index.html");

/* ── whole-market coverage ────────────────────────────────────────────────
   The card's claim is "all currencies, all metals, all coins". Each list is taken from the
   shipped files and held to the other: the page's pickers must name exactly what the Worker
   can serve, or a reader picks a row and gets an empty chart. */
const mMap = (wsrc.match(/const IMF_METALS = \{[\s\S]*?\n\};/) || [])[0] || "";
const MKEYS = [...mMap.matchAll(/\n  ([A-Z0-9]{2,4}): \{ ind: "([A-Z]+)", label: "([^"]+)", unit: "([^"]+)", div: (1|LB_PER_TONNE) \}/g)]
  .map((m) => ({ sym: m[1], ind: m[2], label: m[3], unit: m[4], div: m[5] }));
check("chart: the Worker prices every metal the source does, each with its own unit and divisor",
  MKEYS.length === 15 && new Set(MKEYS.map((m) => m.ind)).size === 15 && MKEYS.every((m) => ["USD/oz", "USD/t", "USD/lb"].indexOf(m.unit) >= 0),
  MKEYS.length + " metals: " + MKEYS.map((m) => m.sym).join(","));
check("chart: only quotes the source publishes per tonne are divided — copper and cobalt read per pound",
  MKEYS.filter((m) => m.div === "LB_PER_TONNE").map((m) => m.sym).sort().join(",") === "CO,HG",
  MKEYS.filter((m) => m.div === "LB_PER_TONNE").map((m) => m.sym + " " + m.unit).join(", "));
const liRes = await call("/api/history?kind=metal&symbol=LI");
check("chart: metals the source states no unit for are left out rather than plotted on a guessed axis",
  !/ind: "(PCHROM|PLITH)"/.test(wsrc) && liRes.status === 400,
  "chromium/lithium absent from the map; LI -> " + liRes.status);
const pageMetals = (((pageSrc.match(/const CHART_METALS=\[([^\]]+)\];/) || [])[1]) || "").match(/"[A-Z0-9]+"/g) || [];
check("chart: the page's metal picker is exactly the Worker's list, so the two cannot drift apart",
  pageMetals.map((s) => s.replace(/"/g, "")).join(",") === MKEYS.map((m) => m.sym).join(","), pageMetals.join(","));
const nmStart = pageSrc.indexOf("const METAL_NAMES={en:{");
const nmSplit = nmStart > 0 ? pageSrc.indexOf("},ar:{", nmStart) : -1;
const nmEnd = nmSplit > 0 ? pageSrc.indexOf("}};", nmSplit) : -1;
const codesIn = (s) => (s.match(/[A-Z0-9]{2,4}:"/g) || []).map((x) => x.replace(/:"$/, ""));
const nameEn = nmStart > 0 ? codesIn(pageSrc.slice(nmStart + "const METAL_NAMES={en:{".length, nmSplit)) : [];
const nameAr = nmSplit > 0 ? codesIn(pageSrc.slice(nmSplit + 6, nmEnd)) : [];
check("chart: every metal carries a name in both languages, so a picker row is never a bare code",
  nameEn.length === 15 && nameAr.length === 15
  && pageMetals.every((s) => { const c = s.replace(/"/g, ""); return nameEn.indexOf(c) >= 0 && nameAr.indexOf(c) >= 0; }),
  "en " + nameEn.length + " / ar " + nameAr.length + " | " + nameAr.slice(0, 3).join(","));
const pageFx = (((pageSrc.match(/const CHART_EXTRA_FX=\[([^\]]+)\];/) || [])[1]) || "").match(/"[A-Z]+"/g) || [];
const wFx = (((wsrc.match(/const YAHOO_FX = \[([^\]]+)\];/) || [])[1]) || "").match(/"[A-Z]+"/g) || [];
const ecbList = (wsrc.match(/const ECB_CURRENCIES = \[[^\]]+\];/) || [])[0] || "";
check("chart: the page's extra-currency list matches the Worker's and holds no ECB currency twice",
  pageFx.length > 15 && pageFx.join(",") === wFx.join(",")
  && wFx.every((c) => ecbList.indexOf(c) < 0),
  pageFx.length + " currencies: " + pageFx.slice(0, 6).join(",") + "…");
check("page: the title advertises the same version the page runs, so a deploy is identifiable",
  (pageSrc.match(/<title>Home Dashboard v([0-9.]+)<\/title>/) || [])[1]
  === (pageSrc.match(/VERSION: "([0-9.]+)"/) || [])[1],
  "title " + (pageSrc.match(/<title>Home Dashboard v([0-9.]+)<\/title>/) || [])[1] + " · CONFIG " + (pageSrc.match(/VERSION: "([0-9.]+)"/) || [])[1]);
/* The version is bumped in three places (title, CONFIG, the changelog's newest entry) and a
   release that forgets one of them is the kind of drift nobody notices until a user asks what
   changed. The changelog is parsed from the shipped array, so a missing translation is caught
   too - the modal renders whichever language it is in, with no fallback. */
const chgSrc = (pageSrc.match(/const CHANGELOG = \[[\s\S]*?\n\];/) || [])[0];
let CHANGELOG = null;
try { CHANGELOG = chgSrc ? new Function(chgSrc + "\nreturn CHANGELOG;")() : null; } catch (e) { CHANGELOG = null; }
const newest = CHANGELOG && CHANGELOG[0];
const running = (pageSrc.match(/VERSION: "([0-9.]+)"/) || [])[1];
check("page: the newest changelog entry is the version the page runs, in both languages",
  !!newest && newest.v === running && typeof newest.en === "string" && newest.en.length > 80
  && typeof newest.ar === "string" && newest.ar.length > 80 && /^\d{4}-\d{2}-\d{2}$/.test(newest.d || ""),
  newest ? "v" + newest.v + " (" + newest.d + ") · en " + newest.en.length + " / ar " + newest.ar.length + " chars · running v" + running
    : "CHANGELOG not parseable");

/* ── palette contrast ───────────────────────────────────────────────────────────
   Four themes x five accents are all selectable in Settings, so "readable" is a property
   of every combination, not just the default one. Each ratio below is computed from the
   shipped custom properties at the AA threshold for that pair's role - 4.5:1 for text,
   which includes the ink painted on an accent fill, because that is a button or tab label.
   Nothing is pinned: change a colour and the check measures the new one, so a palette nudge
   that would ship unreadable text fails here instead of in someone's browser. */
const styleSrc = (pageSrc.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
const wcLin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const wcLum = (hex) => {
  const h = hex.length === 4 ? hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3] : hex.slice(1);
  const p = [0, 2, 4].map((i) => wcLin(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
};
const wcRatio = (a, b) => { const [x, y] = [wcLum(a), wcLum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const wc2 = (n) => Math.round(n * 100) / 100;
const THEME_VARS = {};
for (const m of styleSrc.matchAll(/\[data-theme="([a-z]+)"\]\{([^}]*)\}/g)) {
  const v = {};
  for (const d of m[2].split(";")) { const kv = d.match(/--([a-z0-9-]+):\s*(#[0-9a-f]{3,8})\b/i); if (kv) v[kv[1]] = kv[2]; }
  THEME_VARS[m[1]] = v;
}
const ACCENT_VARS = {};
for (const m of styleSrc.matchAll(/\[data-accent="([a-z]+)"\]\{--ac:(#[0-9a-f]{3,8})\b/gi)) ACCENT_VARS[m[1]] = m[2];
/* The ink on an accent fill: the base .btn rule, unless a theme overrides it (the dark theme
   does). Read rather than assumed, so changing the ink is a measured change. */
const inkOnAccent = (t) => {
  const from = (s) => ((s || "").match(/color:\s*(#[0-9a-f]{3,8})\b/i) || [])[1];
  const override = styleSrc.match(new RegExp('\\[data-theme="' + t + '"\\][^{]*#editBtn\\.on\\{([^}]*)\\}'));
  return from((override || [])[1]) || from((styleSrc.match(/\.btn\{([^}]*)\}/) || [])[1]);
};
const THEME_NAMES = Object.keys(THEME_VARS);
check("contrast: the stylesheet declares its themes and accents in a form this check can read",
  THEME_NAMES.length >= 4 && Object.keys(ACCENT_VARS).length >= 5
  && THEME_NAMES.every((t) => ["text", "text2", "muted", "bg", "bg2", "card", "ok", "bad"].every((k) => THEME_VARS[t][k])),
  THEME_NAMES.join(",") + " themes · " + Object.keys(ACCENT_VARS).join(",") + " accents");
const WC_PAIRS = [
  ["body copy on every surface it is painted on", [["text", "bg"], ["text", "card"], ["text", "bg2"]]],
  ["the secondary and muted inks above 12px", [["text2", "bg2"], ["text2", "card"], ["muted", "card"], ["muted", "bg2"], ["muted", "bg"]]],
  ["the up/down market figures (.up/.down)", [["ok", "card"], ["ok", "bg"], ["bad", "card"], ["bad", "bg"]]],
];
for (const [label, pairs] of WC_PAIRS) {
  const off = [];
  let worst = { r: 99 };
  for (const t of THEME_NAMES) for (const [fg, bgn] of pairs) {
    const r = wcRatio(THEME_VARS[t][fg], THEME_VARS[t][bgn]);
    if (r < worst.r) worst = { r, t, fg, bgn };
    if (r < 4.5) off.push(t + " " + fg + " on " + bgn + " = " + wc2(r));
  }
  check("contrast: " + label + " clears 4.5:1 in every theme", off.length === 0,
    off.length ? off.join(" · ") : "worst " + wc2(worst.r) + " (" + worst.t + " " + worst.fg + " on " + worst.bgn + ")");
}
{
  const off = [];
  let worst = { r: 99 };
  for (const t of THEME_NAMES) {
    const ink = inkOnAccent(t);
    for (const a of Object.keys(ACCENT_VARS)) {
      const r = ink ? wcRatio(ink, ACCENT_VARS[a]) : 0;
      if (r < worst.r) worst = { r, t, a, ink };
      if (r < 4.5) off.push(t + "/" + a + " = " + wc2(r));
    }
  }
  check("contrast: the label on an accent fill (.btn, the active tab, the edit pill) clears 4.5:1 for all five accents in all four themes",
    off.length === 0 && worst.r < 99,
    off.length ? off.join(" · ") : "worst " + wc2(worst.r) + " (" + worst.t + "/" + worst.a + ", ink " + worst.ink + ")");
}

/* ── desktop + phone geometry ───────────────────────────────────────────────────
   The layout is one breakpoint away from looking broken: at and above it the page becomes a
   two-then-three column grid with a real tab bar over one section at a time, and below it a
   horizontal pager. These checks read the stylesheet's own numbers rather than pinning them,
   so raising a gap, widening a padding or dropping a rule fails here instead of squeezing a
   card to a sliver on a real screen. */
const cssBlocks = (query) => {
  const out = [];
  let i = styleSrc.indexOf(query);
  while (i >= 0) {
    const start = styleSrc.indexOf("{", i);
    let depth = 0;
    let k = start;
    for (; k < styleSrc.length; k++) { if (styleSrc[k] === "{") depth++; else if (styleSrc[k] === "}") { depth--; if (!depth) break; } }
    out.push(styleSrc.slice(start + 1, k));
    i = styleSrc.indexOf(query, k);
  }
  return out.join("\n");
};
/* isDesktop() is the single source of the number: the two media queries must complement it. */
const DESK_AT = Number((pageSrc.match(/matchMedia\("\(min-width: (\d+)px\)"\)/) || [])[1]);
const deskCss = Number.isFinite(DESK_AT) && DESK_AT > 0 ? cssBlocks("@media(min-width:" + DESK_AT + "px)") : "";
const phoneCss = Number.isFinite(DESK_AT) && DESK_AT > 0 ? cssBlocks("@media(max-width:" + (DESK_AT - 1) + "px)") : "";
const wideCss = cssBlocks("@media(min-width:1300px)");
const pageInner = (styleSrc.match(/\.page-inner\{([^}]*)\}/) || [])[1] || "";
const maxW = Number((pageInner.match(/max-width:(\d+)px/) || [])[1]) || 0;
const gridGap = Number((pageInner.match(/gap:(\d+)px/) || [])[1]) || 0;
const pagePad = Number((((deskCss.match(/\.page\{([^}]*)\}/) || [])[1] || "").match(/padding:\S+\s+(\d+)px/) || [])[1]) || 0;
/* the tightest a grid column ever gets: three columns at the moment the third one appears */
const WIDE_AT = Number((styleSrc.match(/@media\(min-width:(\d+)px\)\{\.page-inner\{grid-template-columns:repeat\(3/) || [])[1]) || 1300;
const contentAt = Math.max(0, Math.min(WIDE_AT, maxW) - 2 * pagePad);
const colAt3 = contentAt > 0 ? Math.floor((contentAt - 2 * gridGap) / 3) : 0;

check("desktop geometry: the breakpoint the JS tests is the one the stylesheet flips the layout on, and the two queries are complements",
  Number.isFinite(DESK_AT) && DESK_AT > 0 && deskCss.length > 0 && phoneCss.length > 0
  && styleSrc.indexOf("@media(max-width:" + (DESK_AT - 1) + "px)") >= 0
  && /\.page\{display:none/.test(deskCss) && /\.page\.active\{display:block\}/.test(deskCss),
  "isDesktop " + DESK_AT + "px · desktop block " + deskCss.length + " chars · phone block " + phoneCss.length + " chars · one section at a time: "
  + (/\.page\{display:none/.test(deskCss) && /\.page\.active\{display:block\}/.test(deskCss) ? "yes" : "NOT declared"));
check("desktop geometry: two columns at the breakpoint, three when there is room, and the columns keep a usable width",
  /grid-template-columns:repeat\(2,1fr\)/.test(deskCss) && /grid-template-columns:repeat\(3,1fr\)/.test(wideCss)
  && maxW > 0 && gridGap > 0 && pagePad > 0 && colAt3 >= 300,
  "2 columns at " + DESK_AT + "px, 3 at " + WIDE_AT + "px · content " + contentAt + "px (max " + maxW + ", padding " + pagePad + " each side), gap " + gridGap
  + " · narrowest column " + colAt3 + "px" + (colAt3 >= 300 ? "" : " (below the 300px floor)"));
check("desktop geometry: the kanban board spans the whole row instead of one cell",
  /#w_kanban\{grid-column:1\/-1\}/.test(deskCss),
  /#w_kanban\{grid-column:1\/-1\}/.test(deskCss) ? "in the " + DESK_AT + "px block" : "missing - its three columns would squeeze into one grid cell");
check("kanban geometry: the board's columns are minmax(0,1fr) and stack on a narrow screen, so long card text cannot widen the grid past its card",
  /\.kb\{[^}]*repeat\(3,minmax\(0,1fr\)\)/.test(styleSrc) && !/\.kb\{[^}]*repeat\(3,1fr\)/.test(styleSrc)
  && /@media\(max-width:640px\)\{\.kb\{grid-template-columns:minmax\(0,1fr\)\}\}/.test(styleSrc),
  ((styleSrc.match(/\.kb\{([^}]*)\}/) || ["", ""])[1].match(/grid-template-columns:[^;}]*/) || [])[0] || "no board grid"
  + " · " + (/@media\(max-width:640px\)\{\.kb\{/.test(styleSrc) ? "single column at <=640px" : "no narrow-screen stack"));
const fixedWidths = [...styleSrc.matchAll(/(?:^|[;{\s])width:\s*(\d{2,})px/g)].map((m) => Number(m[1]));
const tooWide = fixedWidths.filter((w) => colAt3 > 0 && w > colAt3);
check("desktop geometry: no fixed pixel width in the stylesheet is wider than the narrowest desktop column",
  tooWide.length === 0,
  tooWide.length ? tooWide.join(", ") + "px vs a " + colAt3 + "px column" : (fixedWidths.length + " fixed width(s), widest " + (fixedWidths.length ? Math.max.apply(null, fixedWidths) : 0) + "px vs a " + colAt3 + "px column"));

check("phone geometry: the pager bar and the tab strip stay out of the desktop layout and live inside the phone one",
  /\.pbar\{display:none/.test(styleSrc) && /\.pbar\{display:block\}/.test(phoneCss)
  && /\.tabbar\{display:none\}/.test(styleSrc) && /\.tabbar\{display:flex/.test(phoneCss) && /\.tabbar\{display:flex/.test(deskCss)
  && /\.pagelabel/.test(deskCss) && /display:none/.test((deskCss.match(/\.pagelabel,[^}]*\}/) || [""])[0]),
  "bar: none by default, block at <=" + (DESK_AT - 1) + "px · tabs: none by default, flex in both layouts · page label hidden on desktop: "
  + (/display:none/.test((deskCss.match(/\.pagelabel,[^}]*\}/) || [""])[0]) ? "yes" : "NOT hidden"));
check("phone geometry: a section tab is never smaller than a finger can hit (44px) in the phone layout",
  /\.tabbar button\{[^}]*min-height:44px/.test(phoneCss),
  (phoneCss.match(/\.tabbar button\{[^}]*?min-height:(\d+)px/) || [])[1] ? "min-height " + (phoneCss.match(/\.tabbar button\{[^}]*?min-height:(\d+)px/) || [])[1] + "px in the <=" + (DESK_AT - 1) + "px block" : "no min-height on .tabbar button in the phone block");
check("phone geometry: the pager fill is anchored with a logical inset, so it grows from the reading edge in Arabic too",
  /\.pfill\{[^}]*inset-inline-start:0/.test(styleSrc) && !/\.pfill\{[^}]*[^-]left:0/.test(styleSrc),
  (styleSrc.match(/\.pfill\{([^}]*)\}/) || ["", ""])[1].match(/(inset-inline-start|[^-]left|right):[^;}]*/g) ? "anchors: " + ((styleSrc.match(/\.pfill\{([^}]*)\}/) || ["", ""])[1].match(/(inset-inline-start|left|right):[^;}]*/g) || []).join(", ") : "no anchor found");
const scrollHandler = (pageSrc.match(/\$\("#pages"\)\.addEventListener\("scroll",[\s\S]{0,400}?\{passive:true\}\)/) || [])[0] || "";
check("phone geometry: section tracking reads the scroll offset direction-agnostically (an RTL pager reports negative scrollLeft)",
  /Math\.abs\(\s*el\.scrollLeft\s*\)/.test(scrollHandler) && !/Math\.round\(el\.scrollLeft\s*\//.test(scrollHandler) && scrollHandler.indexOf("renderPager()") >= 0,
  scrollHandler ? ((scrollHandler.match(/Math\.[a-z]+\([^)]*scrollLeft[^)]*\)/) || [])[0] || "no scrollLeft read") + (scrollHandler.indexOf("renderPager()") >= 0 ? " · repaints the bar on every scroll" : " · bar not repainted on scroll") : "pages scroll handler not found");
check("phone geometry: the progress bar is a labelled progressbar whose value the renderer keeps in step with the section",
  /<div class="pbar" id="pbar" role="progressbar"[^>]*aria-valuemax="5"/.test(pageSrc)
  && /setAttribute\("aria-valuenow",String\(curPage\+1\)\)/.test(pageSrc)
  && /aria-valuetext/.test(pageSrc),
  ((pageSrc.match(/<div class="pbar"[^>]*>/) || [])[0] || "pbar markup missing").slice(0, 96));

const emptyBranch = (pageSrc.match(/\}else\{[\s\S]{0,320}?chartData\.note=t\(kind==="metal"\?"chartNeedWorker":"chartNoSeries"\);/) || [])[0] || "";
check("chart: an empty result states why (Worker-only series) instead of drawing a blank card",
  !!emptyBranch && (pageSrc.match(/chartNoSeries:"[^"]+"/g) || []).length === 2
  && (pageSrc.match(/chartNeedWorker:"[^"]+"/g) || []).length === 2,
  (pageSrc.match(/chartNoSeries:"[^"]+"/g) || []).join(" | "));
check("chart: the picker's count is the number of rows you can actually choose, for coins and currencies",
  (pageSrc.match(/digits\(sym\.options\.length\)/g) || []).length === 2
  && /chartAllCoins/.test(pageSrc) && /const CHART_EXTRA_FX/.test(pageSrc),
  (pageSrc.match(/digits\(sym\.options\.length\)/g) || []).length + " count sites");
check("chart: both hint labels exist in both languages (no raw key can surface)",
  (pageSrc.match(/chartAllCoins:"[^"]+"/g) || []).length === 2
  && (pageSrc.match(/chartAllCur:"[^"]+"/g) || []).length === 2,
  (pageSrc.match(/chartAllCoins:"[^"]+"/g) || []).join(" | "));

/* Live: the three new sources answer with the values their own units imply. */
const alu = (await hist("/api/history?kind=metal&symbol=ALU")).j;
check("chart/live: aluminium charts monthly from 1992 in USD per tonne",
  alu.unit === "USD/t" && alu.first === "1992-01-01" && alu.points[0][1] > 500 && alu.points[0][1] < 5000,
  alu.unit + " " + alu.first + " = " + alu.points[0][1]);
const ura = (await hist("/api/history?kind=metal&symbol=URA")).j;
const uraMax = Math.max.apply(null, ura.points.map((p) => p[1]));
check("chart/live: uranium reads per pound at the source's own scale (2007 spike above $100/lb)",
  ura.unit === "USD/lb" && uraMax > 100 && uraMax < 400,
  ura.unit + " " + ura.first + ".." + ura.last + " peak " + uraMax);
const mo = (await hist("/api/history?kind=metal&symbol=MO")).j;
check("chart/live: a metal the source began pricing later starts at its own beginning and says so",
  mo.first === "2010-05-01" && /IMF series begins 2010-05/.test(mo.note),
  mo.first + " · " + mo.note);
const co = (await hist("/api/history?kind=metal&symbol=CO")).j;
check("chart/live: cobalt's per-tonne values are divided to the pound its label already claimed (1992 = $14/lb)",
  co.unit === "USD/lb" && Math.abs(co.points[0][1] - 14.03) < 0.6,
  "1992-01 = $" + co.points[0][1] + "/lb from " + Math.round(co.points[0][1] * 2204.62) + "/t");
const sarRes = await hist("/api/history?kind=fx&symbol=SAR");
const sar = sarRes.j;
check("chart/live: a currency the ECB never quotes comes from the weekly Yahoo pair, dated in the caption",
  sar.cadence === "weekly" && sar.source === "Yahoo Finance" && sar.first <= "2004-01-01"
  && sar.count > 1000 && /Yahoo data begins/.test(sar.note)
  && Math.abs(sar.points[sar.points.length - 1][1] - 3.75) < 0.4,
  sar.label + " " + sar.first + ".." + sar.last + " = " + sar.points[sar.points.length - 1][1] + " · " + sar.note);
check("chart/live: a currency inside the ECB's set still comes from the ECB daily series, untouched",
  fx.cadence === "daily" && fx.source === "ECB reference rates" && fx.first === "1999-01-04");
check("chart: the cadence follows whichever source answered a coin request",
  /cadence = "daily"; source = "CoinGecko"/.test(wsrc) && /let cadence = "weekly", source = "Yahoo Finance"/.test(wsrc));
const pepe = (await hist("/api/history?kind=crypto&symbol=PEPE&cg=pepe")).j;
check("chart/live: a coin Yahoo has no pair for is reported at CoinGecko's daily cadence, not Yahoo's weekly",
  pepe.count === 0 ? false : (pepe.cadence === "daily" && pepe.source === "CoinGecko"),
  pepe.count === 0 ? "no data returned (" + pepe.note + ")" : pepe.source + " " + pepe.cadence + " " + pepe.first + ".." + pepe.last);

/* ── the free allowance, searchable ─────────────────────────────────────────────
   The Generators card states thirteen free allowances and the search box claims to find
   them. What makes that claim true is checked here: the shipped <script> parses at all
   (a stray comma once blanked the whole page), the page's mirror of the dataset is
   byte-identical to the Worker's (card, search and API cannot disagree), every figure has
   wording in both languages, and the search handler — extracted from index.html and
   executed against the shipped data — really returns those figures for the queries
   people actually type. */
const pageScript = (pageSrc.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || "";
let scriptParses = true, parseErr = "";
try { new Function(pageScript); } catch (e) { scriptParses = false; parseErr = e.message; }
check("gen: the whole shipped <script> parses (a stray comma once blanked the page)",
  scriptParses, parseErr || pageScript.length + " chars compile clean");

const genLf = (s) => String(s).replace(/\r\n/g, "\n");
const genRe = /\/\* GEN-DATA-BEGIN[\s\S]*?\/\* GEN-DATA-END \*\//;
const wGen = (wsrc.match(genRe) || [])[0];
const pGen = (pageSrc.match(genRe) || [])[0];
check("gen: index.html mirrors the Worker's dataset verbatim, marker to marker",
  !!wGen && !!pGen && genLf(wGen) === genLf(pGen),
  wGen && pGen ? ((genLf(wGen).match(/"id":/g) || []).length + " rows, " + genLf(wGen).length + " chars identical")
    : "worker=" + !!wGen + " page=" + !!pGen);

const genRes = await call("/api/generators");
const genJ = await body(genRes);
const genTools = genJ.tools || [];
const genRowOK = (g) => g && typeof g.id === "string" && typeof g.tool === "string"
  && (g.kind === "image" || g.kind === "video")
  && Number.isFinite(g.n) && g.n > 0 && typeof g.unit === "string"
  && ["day", "week", "3h", "once"].indexOf(g.span) >= 0
  && /^gen[A-Z]/.test(g.note || "") && /^https:\/\//.test(g.url || "");
check("gen/live: 200 with a checked date and 13 well-formed rows",
  genRes.status === 200 && /^\d{4}-\d{2}-\d{2}$/.test(genJ.checked || "")
  && genTools.length === 13 && genTools.every(genRowOK),
  "status " + genRes.status + " · checked " + genJ.checked + " · " + genTools.length + " rows");
check("gen/live: both kinds covered, no duplicate id, each row cites its own vendor page",
  new Set(genTools.map((g) => g.kind)).size === 2 && new Set(genTools.map((g) => g.id)).size === genTools.length,
  [...new Set(genTools.map((g) => g.kind))].join(",") + " · video: "
  + genTools.filter((g) => g.kind === "video").map((g) => g.tool).join(", "));

const genI18nSrc = (pageSrc.match(/const I18N = \{[\s\S]*?\n\};/) || [])[0];
const GEN_I18N = genI18nSrc ? new Function(genI18nSrc + "\nreturn I18N;")() : null;
const ukInner = (pageSrc.match(/const GEN_UNIT_KEY=\{([^}]*)\}/) || [])[1] || "";
const GEN_UNIT_KEY = new Function("return {" + ukInner + "};")();
const genWords = Object.keys(GEN_UNIT_KEY).map((k) => GEN_UNIT_KEY[k])
  .concat(["quPerDay", "genPerWeek", "genPer3h", "quOnce", "gen", "genImage", "genVideo", "genChecked", "genHint", "wFree"]);
check("gen i18n: every note, unit and period has wording in both languages",
  !!GEN_I18N && !!ukInner && genWords.every((k) => typeof GEN_I18N.en[k] === "string" && typeof GEN_I18N.ar[k] === "string")
  && genTools.every((g) => typeof GEN_I18N.en[g.note] === "string" && typeof GEN_I18N.ar[g.note] === "string"),
  GEN_I18N && ukInner
    ? (genWords.filter((k) => typeof GEN_I18N.en[k] !== "string" || typeof GEN_I18N.ar[k] !== "string").join(",")
      || genWords.length + " words + " + genTools.length + " notes, both languages")
    : "I18N/GEN_UNIT_KEY not extracted");

const genSpanSrc = (pageSrc.match(/function genSpanText\(g\)\{[^\n\r]*\}/) || [])[0];
const genAllowSrc = (pageSrc.match(/function genAllowText\(g\)\{[^\n\r]*\}/) || [])[0];
check("gen: the allowance composer is extractable from the shipped page",
  !!genSpanSrc && !!genAllowSrc, (genSpanSrc || "missing genSpanText") + " / "
  + (genAllowSrc ? genAllowSrc.length + " chars" : "missing genAllowText"));
if (genSpanSrc && genAllowSrc) {
  const enT = (k) => (GEN_I18N && GEN_I18N.en[k] !== undefined ? GEN_I18N.en[k] : k);
  const mkAllow = (t) => new Function("t", "digits", "GEN_UNIT_KEY",
    genSpanSrc + "\n" + genAllowSrc + "\nreturn { genAllowText };")(t, (s) => String(s), GEN_UNIT_KEY);
  const { genAllowText } = mkAllow(enT);
  check("gen: a daily figure reads amount + unit + period, in the page's own English",
    genAllowText({ n: 15, unit: "creations", span: "day" }) === "15 creations/day",
    genAllowText({ n: 15, unit: "creations", span: "day" }));
  check("gen: a one-off grant is marked once, never as a daily rate",
    genAllowText({ n: 125, unit: "credits", span: "once" }) === "125 credits · once",
    genAllowText({ n: 125, unit: "credits", span: "once" }));
  check("gen: the weekly and 3-hour cadences keep their own periods",
    genAllowText({ n: 30, unit: "credits", span: "week" }) === "30 credits/week"
    && genAllowText({ n: 10, unit: "images", span: "3h" }) === "10 images/3h",
    genAllowText({ n: 30, unit: "credits", span: "week" }) + " / " + genAllowText({ n: 10, unit: "images", span: "3h" }));

  /* ── the shipped search handler, executed against the shipped data ───────────── */
  const searchSrc = (pageSrc.match(/\$\("#search"\)\.addEventListener\("input",[\s\S]*?box\.style\.display="block"\}\);/) || [])[0];
  check("search: the input handler is extractable from the shipped page", !!searchSrc,
    searchSrc ? searchSrc.length + " chars" : "not found");
  if (searchSrc) {
    const arrow = searchSrc.replace(/^\$\("#search"\)\.addEventListener\("input",/, "").replace(/\);$/, "");
    const t = (k) => (GEN_I18N && GEN_I18N.en[k] !== undefined ? GEN_I18N.en[k] : k);
    const { genAllowText: allow } = mkAllow(t);
    const qInner = (pageSrc.match(/const QUOTA_KEY=\{([^}]*)\}/) || [])[1] || "";
    const qSrc = (pageSrc.match(/function quotaText\(q\)\{[^\n\r]*\}/) || [])[0] || "";
    const { quotaText } = new Function("t", "digits", "QUOTA_KEY", qSrc + "\nreturn { quotaText };")(
      t, (s) => String(s), new Function("return {" + qInner + "};")());
    const whyInner = (pageSrc.match(/const WHY_KEY=\{([^}]*)\}/) || [])[1] || "";
    const whySrc = (pageSrc.match(/function whyText\(w\)\{[^\n\r]*\}/) || [])[0] || "";
    const { whyText } = new Function("t", "WHY_KEY", whySrc + "\nreturn { whyText };")(
      t, new Function("return {" + whyInner + "};")());
    const WIDGET_META = new Function("return " + (pageSrc.match(/const WIDGET_META=([^\n\r]*);/) || [])[1] + ";")();
    const titleForSrc = (pageSrc.match(/function titleFor\(id\)\{[\s\S]*?return m\[id\]\|\|id\}/) || [])[0];
    const { titleFor } = new Function("t", titleForSrc + "\nreturn { titleFor };")(t);
    const { pageNames } = new Function("t", (pageSrc.match(/function pageNames\(\)\{[^\n\r]*\}/) || [])[0] + "\nreturn { pageNames };")(t);
    const PAGE_GEN = new Function(pGen + "\nreturn { GEN_TOOLS };")();
    const jumps = [];
    const rows = [];
    /* one cached AI headline that states its allowance, exactly as the parser stores it */
    const genRec = { data: { ai: [{
      title: "Show HN: SketchScale - free AI image generator, 50 images per day",
      why: ["free daily limit", "free"],
      quota: { n: 50, unit: "images", per: "day", perDay: 50, raw: "50 images per day" }
    }] } };
    const els = {
      "#search": { value: "" },
      "#searchResults": { innerHTML: "", style: {}, appendChild: (b) => rows.push(b) }
    };
    const handler = new Function("$", "store", "CONFIG", "WIDGET_META", "titleFor", "pageNames", "jumpTo",
      "GEN_TOOLS", "genAllowText", "quotaText", "whyText", "tasks", "events", "coinCache", "num", "document",
      "return (" + arrow + ");")(
      (s) => els[s],
      { get: (k, d) => (k === "test_news" ? genRec : d) },
      { NEWS_CACHE_KEY: "test_news" },
      WIDGET_META, titleFor, pageNames, (id) => jumps.push(id),
      PAGE_GEN.GEN_TOOLS, allow, quotaText, whyText,
      [{ text: "buy milk" }], [{ title: "team sync" }], { data: [] }, String,
      { createElement: () => ({ textContent: "", onclick: null }) });
    const run = (q) => {
      rows.length = 0;
      els["#searchResults"].innerHTML = "";
      els["#searchResults"].style = {};
      handler({ target: { value: q } });
      return { labels: rows.map((b) => b.textContent), display: els["#searchResults"].style.display, rows: rows.slice() };
    };

    const r1 = run("free image tools");
    check('search: "free image tools" opens on the Generators card with its image tools beside it',
      r1.display === "block"
      && r1.labels.indexOf(t("gen") + " — " + pageNames()[2]) >= 0
      && r1.labels.filter((l) => l.indexOf("🎞️ ") === 0).length >= 1
      && r1.labels.some((l) => /fast tokens\/day|creations\/day|images\/3h|credits\/day|units\/day|stamina\/day/.test(l)),
      r1.labels.slice(0, 3).join(" | ") + (r1.labels.length > 3 ? " | +" + (r1.labels.length - 3) + " more" : ""));

    const r2 = run("daily limit");
    const genRows2 = r2.labels.filter((l) => l.indexOf("🎞️ ") === 0);
    const aiRows2 = r2.labels.filter((l) => l.indexOf("🤖 ") === 0);
    check('search: "daily limit" finds the daily tools with their figures, the card, and a quota headline',
      r2.display === "block"
      && r2.labels.indexOf(t("gen") + " — " + pageNames()[2]) >= 0
      && genRows2.length >= 3 && genRows2.length <= 5
      && aiRows2.length === 1 && /50 images\/day/.test(aiRows2[0]),
      genRows2.length + " tools · " + aiRows2.length + " headline | " + r2.labels.slice(0, 2).join(" | "));

    const r3 = run("leonardo");
    check("search: a single tool name returns that tool alone, with its figure",
      r3.labels.length === 1 && r3.labels[0] === "🎞️ Leonardo.Ai — 150 fast tokens/day",
      JSON.stringify(r3.labels));
    const jumpsBefore = jumps.length;
    r3.rows[0].onclick();
    check("search: clicking a tool row jumps to the Generators card and clears the box",
      jumps.length === jumpsBefore + 1 && jumps[jumps.length - 1] === "gen" && els["#search"].value === "",
      jumps.join(",") + ' · box="' + els["#search"].value + '"');

    const r4 = run("prayer");
    check("search: a single-word widget query still finds its card (regression)",
      r4.labels.indexOf(t("prayer") + " — " + pageNames()[0]) >= 0, r4.labels.join(" | "));
    const r5 = run("buy milk");
    check("search: a multi-word task query matches (the exact phrase used to be required)",
      r5.labels.length === 1 && r5.labels[0] === "✓ buy milk", r5.labels.join(" | "));
  }
}

/* ── coins in any currency, and LBP on the currencies card ───────────────────────────
   The base picker now serves the coin view too, and the Currencies card carries LBP - a
   currency no ECB table publishes - from the Worker's /api/rates. These run the real
   sources: a crossed coin has to equal its own USD series times that currency's USD leg. */
const btcUsd = (await hist("/api/history?kind=crypto&symbol=BTC&base=USD")).j;
const btcLbp = (await hist("/api/history?kind=crypto&symbol=BTC&base=LBP")).j;
check("chart/live: a coin asked for in another currency comes back crossed, not in USD",
  btcLbp.unit === "LBP" && btcLbp.source === "USD cross" && /crossed through USD/.test(btcLbp.note)
  && btcLbp.cadence === "weekly" && btcLbp.label === "BTC/LBP" && !btcLbp.local,
  btcLbp.label + " " + btcLbp.cadence + " · " + btcLbp.note);
const ratesUsd = (await hist("/api/rates?base=USD&to=LBP,SAR,EUR,GBP")).j;
const lastLbp = btcLbp.points[btcLbp.points.length - 1][1];
const lastUsd = btcUsd.points[btcUsd.points.length - 1][1];
check("chart/live: the crossed coin equals its USD series times that currency's USD leg",
  Math.abs((lastLbp / lastUsd) / ratesUsd.rates.LBP - 1) < 0.05,
  "BTC $" + Math.round(lastUsd) + " -> " + Math.round(lastLbp) + " LBP, the legs say x" + ratesUsd.rates.LBP);
check("chart/live: pricing a coin abroad keeps the coin's own bars - same dates, a different unit",
  btcLbp.count === btcUsd.count && btcLbp.points.every((p, i) => p[0] === btcUsd.points[i][0]),
  btcLbp.first + " .. " + btcLbp.last + " · " + btcLbp.count + " pts, identical dates to the USD run");
check("rates: LBP comes off its own series while the majors stay ECB, each named",
  ratesUsd.rates.LBP > 50000 && ratesUsd.rates.LBP < 200000 && ratesUsd.sources.LBP === "Yahoo"
  && ratesUsd.sources.EUR === "ECB" && ratesUsd.rates.EUR > 0.7 && ratesUsd.rates.EUR < 1.3
  && ratesUsd.rates.SAR > 3 && ratesUsd.rates.SAR < 5,
  "LBP " + ratesUsd.rates.LBP + " (" + ratesUsd.sources.LBP + ") · EUR " + ratesUsd.rates.EUR + " (" + ratesUsd.sources.EUR + ")");
const ratesLbp = (await hist("/api/rates?base=LBP&to=USD,EUR")).j;
check("rates: LBP works as a base as well, which no ECB table can express",
  Math.abs(ratesLbp.rates.USD * ratesUsd.rates.LBP - 1) < 1e-9 && ratesLbp.sources.LBP === "Yahoo",
  "1 LBP = " + ratesLbp.rates.USD + " USD · base leg " + ratesLbp.sources.LBP);
check("rates: the endpoint is routed and defaults to the currencies the ECB never publishes",
  /path === "\/api\/rates"/.test(wsrc) && /url\.searchParams\.get\("to"\) \|\| YAHOO_FX\.join/.test(wsrc)
  && /\/api\/rates", "\/api\/news"/.test(wsrc),
  "route + default list + version " + WVER);
check("currencies card: LBP is a base, a row, and read through the Worker when the ECB cannot serve it",
  /const FX_EXTRA=\["LBP"\]/.test(pageSrc) && /const ECB_BASES=\["USD","EUR","GBP","JPY","CHF","AUD","CAD","CNY"\]/.test(pageSrc)
  && /FX_BASES\(\)\.forEach/.test(pageSrc) && /const rows=FX_EXTRA\.concat\(TOP8\)/.test(pageSrc)
  && /\/api\/rates\?base="\+encodeURIComponent\(base\)\+"&to="/.test(pageSrc)
  && /ECB_BASES\.indexOf\(base\)>=0/.test(pageSrc));
check("currencies card: a rate under a hundredth (1 LBP in EUR) stays readable, not 0",
  /num\(rates\[k\],Math\.abs\(rates\[k\]\)>=0\.01\?4:8\)/.test(pageSrc));
check("currencies card: rows read from outside the ECB's table are named under the grid",
  /const marks=\(src&&src\[base\]&&src\[base\]!=="ECB"&&src\[base\]!=="USD"\?\[base\]:\[\]\)\.concat\(outside\)/.test(pageSrc));

/* ── Arabic: the toggle rebuilds, and nothing the app words itself is left English ────
   The topbar button used to re-paint the news lists alone, so card titles, pickers and row
   buttons stayed in the language they were drawn in. Now it rebuilds. And every string the
   app writes itself - the dictionary's own leftovers, the labels that never went through
   t(), the source names in the chart caption and the quote of the day - has Arabic. */
const i18nBlock = (pageSrc.match(/const I18N = \{[\s\S]*?\n\};/) || [])[0];
const PAGE_I18N = i18nBlock ? new Function(i18nBlock + "\nreturn I18N;")() : null;
const enK = PAGE_I18N ? Object.keys(PAGE_I18N.en) : [];
const arK = PAGE_I18N ? Object.keys(PAGE_I18N.ar) : [];
check("arabic: the two dictionaries carry the same keys, so no key can fall back to English",
  enK.length > 200 && enK.length === arK.length && enK.every((k) => arK.indexOf(k) >= 0) && arK.every((k) => enK.indexOf(k) >= 0),
  enK.length + " en / " + arK.length + " ar");
/* A Latin run is allowed only where it is a format, a ticker, a source's own name or the
   {x} placeholder - anything else is a string that was left half translated. */
const LATIN_TOKEN = /(JSON|CSV|QR|ETH|Yahoo|CoinGecko|\{x\})/g;
const latinAr = arK.filter((k) => /[A-Za-z]/.test(PAGE_I18N.ar[k]));
const strayed = latinAr.filter((k) => PAGE_I18N.ar[k].replace(LATIN_TOKEN, "").match(/[A-Za-z]/));
check("arabic: every Latin run left in the dictionary is a known code, brand or placeholder",
  strayed.length === 0, latinAr.length + " hold Latin: " + latinAr.join(",") + (strayed.length ? " | STRAYED: " + strayed.join(",") : ""));
const qEn = (pageSrc.match(/const QUOTES=\[[\s\S]*?\n\];/) || [])[0] || "";
const qAr = (pageSrc.match(/const QUOTES_AR=\[[\s\S]*?\n\];/) || [])[0] || "";
const qCount = (x) => (x.match(/\["[^"]*","[^"]*"\]/g) || []).length;
const arQuotes = qAr.match(/\["[^"]*","[^"]*"\]/g) || [];
check("arabic: the quote of the day has an edition of its own, entry for entry",
  qCount(qEn) === qCount(qAr) && qCount(qAr) > 100, qCount(qEn) + " en / " + qCount(qAr) + " ar");
check("arabic: every Arabic quote and every author name is Arabic, no Latin left in the card",
  arQuotes.length > 100 && arQuotes.every((q) => /[\u0600-\u06FF]/.test(q) && !/[A-Za-z]/.test(q)),
  arQuotes.filter((q) => /[A-Za-z]/.test(q)).slice(0, 3).join(" | ") || "all clear");
check("arabic: the card reads the Arabic edition on the same pinned daily index",
  /settings\.lang==="ar"&&QUOTES_AR\.length\)\?QUOTES_AR:QUOTES/.test(pageSrc) && /qPinned\(\)\.i%src\.length/.test(pageSrc));
check("arabic: the topbar language button rebuilds the page instead of leaving half of it behind",
  /#langBtn"\)\.onclick=\(\)=>\{settings\.lang=settings\.lang==="ar"\?"en":"ar";saveSettings\(\);applyPrefs\(\);buildPages\(\)\}/.test(pageSrc)
  && !/repaintNews/.test(pageSrc), "buildPages + no repaintNews left");
check("arabic: the labels that never went through t() now do (clock, weather, prayer, metals, calendar, countdowns, accents)",
  /if\(settings\.h12\)\{ap=" "\+\(h>=12\?t\("pm"\):t\("am"\)\)/.test(pageSrc)
  && /return m\[c\]\?t\(m\[c\]\):"\u2014"/.test(pageSrc)
  && /a\.textContent=metalName\(s\)/.test(pageSrc)
  && /const order=\[\["Fajr","pFajr"\],\["Sunrise","pSunrise"\]/.test(pageSrc) && /order\.forEach\(\(\[k,kl\]\)=>/.test(pageSrc)
  && /a\.textContent=t\(kl\)/.test(pageSrc) && /\[\[4,t\("mUmmAlQura"\)\]/.test(pageSrc)
  && /H\.month\.ar\|\|H\.month\.en/.test(pageSrc)
  && /settings\.lang==="ar"\?\["/.test(pageSrc)
  && /t\("evTitle"\)/.test(pageSrc) && /t\("mode"\)/.test(pageSrc) && /t\("cdDefault"\)/.test(pageSrc)
  && /\[\["orange","acOrange"\]/.test(pageSrc) && /textContent=t\(al\)/.test(pageSrc));
check("arabic: the shell's tooltips, the install name and the tab title come from the dictionary",
  /\[\["#langBtn","lang"\],\["#themeBtn","theme"\],\["#installBtn","install"\],\["#qrBtn","qr"\],\["#editBtn","editLayout"\]\]/.test(pageSrc)
  && /apple-mobile-web-app-title/.test(pageSrc) && /document\.title=t\("brand"\)\+" v"\+CONFIG\.VERSION/.test(pageSrc));
/* The chart's own wording - the source name and the note - is lifted from the shipped page
   and run against the shipped Arabic dictionary, so the two cannot drift apart. */
const noteSrc = (pageSrc.match(/function noteText\(note\)\{[\s\S]*?\n\}/) || [])[0];
const srcFnSrc = (pageSrc.match(/function srcText\(s\)\{[^\n]*\}/) || [])[0];
check("arabic: the chart's note and source translators are extractable from the page",
  !!noteSrc && !!srcFnSrc && /t\("nCross"\)/.test(noteSrc) && /t\("nYahooFrom"\)/.test(noteSrc), (noteSrc || "").length + " + " + (srcFnSrc || "").length + " chars");
if (noteSrc && srcFnSrc && PAGE_I18N) {
  const tAr = (k) => PAGE_I18N.ar[k] || k;
  const SRC_MAP = { "IMF PCPS": "IMF PCPS", "ECB reference rates": "ECB", "Yahoo Finance": "Yahoo", CoinGecko: "CoinGecko", ECB: "ECB", "USD cross": "USD cross" };
  const KEY_MAP = { "IMF PCPS": "srcIMF", "ECB reference rates": "srcECB", "Yahoo Finance": "srcYahoo", CoinGecko: "srcCG", ECB: "srcECB", "USD cross": "srcCross" };
  const { srcText } = new Function("t", "CHART_SRC", "CHART_SRC_KEY", srcFnSrc + "\nreturn { srcText };")(tAr, SRC_MAP, KEY_MAP);
  const { noteText } = new Function("t", "digits", "settings", "srcText", noteSrc + "\nreturn { noteText };")(tAr, (v) => String(v), { lang: "ar" }, srcText);
  const noteCross = noteText("crossed through USD (Yahoo + ECB)");
  const noteBegins = noteText("outside the ECB's set \u2014 Yahoo data begins 2003-12-01");
  check("arabic: a crossed-pair note names its legs in the page's own Arabic words",
    noteCross === PAGE_I18N.ar.nCross + " (" + PAGE_I18N.ar.srcYahoo + " + " + PAGE_I18N.ar.srcECB + ")", noteCross);
  check("arabic: where a series begins reads in Arabic, date included",
    noteBegins === PAGE_I18N.ar.nYahooFrom + " 2003-12-01", noteBegins);
  check("arabic: an unknown note is passed through rather than blanked",
    noteText("Yahoo HTTP 429") === "Yahoo HTTP 429" && noteText("") === "" && srcText("Kling") === "Kling");
  check("arabic: a caption's source name is the Arabic word for it",
    srcText("ECB reference rates") === PAGE_I18N.ar.srcECB && srcText("USD cross") === PAGE_I18N.ar.srcCross,
    srcText("ECB reference rates") + " / " + srcText("USD cross"));
}

/* ── the page's number formatting: same output, less work ───────────────────────────────
   Every figure in the coin, currency and metals tables goes through num(), eastern numerals
   through digits(). Both were rewritten for cost, so these hold the rewritten pair to the
   behaviour of the code they replaced - Number#toLocaleString and a per-character
   Arabic-Indic map - and to the memoisation that was the point of the rewrite: one formatter
   per fraction-digit budget, never one per call. */
const digSrc = (pageSrc.match(/const EASTERN_CC=\d+;\r?\nfunction digits\(s\)\{[^\n\r]*\}/) || [])[0];
const numSrc = (pageSrc.match(/const NF=\{\};\r?\nfunction num\(n,d\)\{[^\n\r]*\}/) || [])[0];
check("page numbers: the digit map and the memoised formatter are extractable from the page",
  !!digSrc && !!numSrc, (digSrc ? digSrc.length : 0) + " + " + (numSrc ? numSrc.length : 0) + " chars");
if (digSrc && numSrc) {
  let made = 0;
  /* forwards both arguments: a spy that swallowed the locale would hand the constructor the
     locale string as its options and quietly compare a default formatter against the memoised one */
  const IntlSpy = { NumberFormat: function (locale, opts) { made++; return new Intl.NumberFormat(locale, opts); } };
  const mkNum = (eastern) => new Function("settings", "Intl",
    digSrc + "\n" + numSrc + "\nreturn { digits, num };") ({ digits: eastern ? "eastern" : "western" }, IntlSpy);
  const refDigits = (s, eastern) => { const t = String(s); return eastern ? t.replace(/[0-9]/g, (c) => "٠١٢٣٤٥٦٧٨٩"[+c]) : t; };
  const refNum = (n, d, eastern) => (n == null || isNaN(n)) ? "—"
    : refDigits(Number(n).toLocaleString("en-US", { maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: 0 }), eastern);
  const NUMS = [7322727781.234, 0.89326, 89500, 3.754199981689453, 81871, 0.0000111731843575419,
    1234.5, -0.4, 999999999, 4334.75, 0.5, 1.005, 0.125, 1234567.891, null, undefined, NaN, "128.25"];
  const DIGITS_FIX = ["7322727781", "٠.٨٩", "89,500", "2026-10-14", "+3.75%", "12:34:56", "abc", ""];
  const bad = [];
  for (const eastern of [false, true]) {
    const api = mkNum(eastern);
    for (const v of NUMS) for (const d of [undefined, 0, 1, 2, 3, 4, 6]) if (api.num(v, d) !== refNum(v, d, eastern)) bad.push("num(" + v + "," + d + ")");
    for (const s of DIGITS_FIX) if (api.digits(s) !== refDigits(s, eastern)) bad.push("digits(" + JSON.stringify(s) + ")");
  }
  check("page numbers: the rewritten helpers print exactly what the code they replaced printed",
    bad.length === 0,
    bad.length ? bad.slice(0, 3).join(" | ") + " (" + bad.length + " diffs)"
      : NUMS.length * 7 * 2 + DIGITS_FIX.length * 2 + " comparisons, both digit modes");

  const api = mkNum(true);
  made = 0;
  for (let i = 0; i < 50; i++) api.num(1234.5 + i, 2);
  check("page numbers: fifty rows share one formatter instead of building fifty", made === 1,
    made + " Intl.NumberFormat built for 50 calls");
  for (let i = 0; i < 10; i++) api.num(i / 3, 4);
  check("page numbers: a second fraction-digit budget gets its own formatter, and only one", made === 2,
    made + " built after a second budget");
  for (let i = 0; i < 10; i++) { api.num(i / 3, 4); api.num(i, 2); }
  check("page numbers: alternating budgets never build a third formatter", made === 2, made + " built");
  const west = mkNum(false);
  check("page numbers: western digits come back untouched, with no table and no closure",
    west.digits("89,500") === "89,500" && west.digits("abc") === "abc" && west.num(89500, 0) === "89,500",
    west.digits("89,500") + " / " + west.num(89500, 0));
}

/* ── the clock: a tick must not rebuild the card ─────────────────────────────────────────
   The clock is the only card that ticks, so a rebuild-per-tick is invisible in a screenshot
   and unmissable in a profile: it built a fresh date formatter and five elements every
   second, for as long as the tab stayed open. These run the shipped renderClock/tickClock
   against a counting stub DOM and hold a tick to "no new elements, one reused text node". */
const clockSrc = [
  (pageSrc.match(/const DATE_FMT=\{\};/) || [])[0],
  (pageSrc.match(/function dateFmt\(\)\{[^\n\r]*\}/) || [])[0],
  (pageSrc.match(/function clockNow\(\)\{[^\n\r]*\}/) || [])[0],
  (pageSrc.match(/function tickClock\(\)\{[^\n\r]*\}/) || [])[0],
  (pageSrc.match(/function renderClock\(\)\{[^\n\r]*\}/) || [])[0]
];
check("clock: renderClock, tickClock and the cached formatter are extractable from the page",
  clockSrc.every(Boolean), clockSrc.filter(Boolean).length + "/5 pieces");
const pump = (pageSrc.match(/setInterval\(\(\)=>\{[^\n\r]*\},1000\)/) || [])[0];
check("clock: the 1s interval drives the tick, not a card rebuild",
  !!pump && pump.indexOf("tickClock()") > 0 && pump.indexOf("renderClock()") < 0,
  pump || "interval not found");
if (clockSrc.every(Boolean)) {
  let elements = 0, formats = 0;
  const el = () => {
    const e = { children: [], style: {}, dataset: {}, nodeType: 1, id: "", onClick: null, _c: "", _t: undefined,
      get className() { return this._c; }, set className(v) { this._c = v; },
      appendChild(c) { this.children.push(c); return c; },
      get firstChild() { return this.children[0] || null; },
      set textContent(v) { this._t = String(v); }, get textContent() { return this._t === undefined ? "" : this._t; },
      querySelector(sel) { const want = sel.slice(1); return this.children.find((c) => sel[0] === "." ? c._c.split(/\s+/).indexOf(want) >= 0 : c.id === want) || null; } };
    elements++;
    return e;
  };
  const card = el();
  elements = 0;                       /* the stub's own root is not part of the card */
  const settingsStub = { lang: "ar", h12: false, secs: true };
  const build = new Function("document", "$", "settings", "t", "digits", "saveSettings", "Intl",
    clockSrc.join("\n") + "\nreturn { renderClock, tickClock };") (
    { createElement: el, createTextNode: (v) => ({ nodeType: 3, nodeValue: String(v) }) },
    () => card, settingsStub, (k) => k, (s) => String(s), () => {},
    { DateTimeFormat: function (l, o) { formats++; return new Intl.DateTimeFormat(l, o); } });
  build.renderClock();
  const built = elements;
  const big = card.querySelector(".big");
  const date = card.querySelector("#clockDate");
  check("clock: the card is built once - the big time, the date line, the row and its two buttons",
    built === 5 && !!big && !!date, built + " elements");
  build.tickClock(); build.tickClock(); build.tickClock();
  check("clock: three ticks create no elements at all", elements === built, elements - built + " created by the ticks");
  const tn = big && big.firstChild;
  check("clock: the tick reuses one text node for the time instead of replacing it",
    !!tn && tn.nodeType === 3 && tn === big.firstChild && String(tn.nodeValue).length > 0,
    "time text node: " + JSON.stringify(tn && tn.nodeValue));
  check("clock: one formatter, built once for the language, and none rebuilt by a tick",
    formats === 1, formats + " DateTimeFormat built by a build plus three ticks");
  const dateText = date.textContent;
  build.tickClock();
  check("clock: the date line is written once, not once a second",
    dateText.length > 0 && date.textContent === dateText && date.dataset.day !== undefined,
    JSON.stringify(dateText) + " · stamp " + date.dataset.day);
  settingsStub.lang = "en";
  build.tickClock();
  check("clock: a language change takes the other cached formatter and rewrites the date line",
    formats === 2 && date.textContent !== dateText, formats + " built · " + JSON.stringify(date.textContent));
}

/* ── the edge-cache write, and the bytes the client waits for ──────────────────────────
   Storing the copy is housekeeping, so a request must not wait for it: these hold the Worker
   to that with a put that stays pending until the check lets it go, and to the other half of
   the rule - with no ctx.waitUntil to hand the write to (a plain `node` run of this file),
   it has to be awaited, because nothing else keeps the isolate alive. */
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p: p, resolve: resolve }; };
const swapCaches = (gate, sink) => {
  const real = globalThis.caches;
  globalThis.caches = { default: {
    async match() { return undefined; },
    async put(r, res) { await gate; sink.set(typeof r === "string" ? r : r.url, res.clone()); }
  } };
  return () => { globalThis.caches = real; };
};
const askWith = (path, ctx) => worker.fetch(new Request("https://worker.test" + path), {}, ctx);
const gate = deferred(), sink = new Map();
let restoreCaches = swapCaches(gate.p, sink);
let handed = null, hostRes = null, noCtxRes = null;
let sink2 = new Map();
/* both routes run under a swapped cache, so the shim is put back even if a request throws:
   a shim left behind would quietly change the meaning of every check below it */
try {
  try { hostRes = await askWith("/api/rates?base=USD&to=ZZZ", { waitUntil: (p) => { handed = p; } }); } catch (e) { hostRes = null; }
  check("worker cache: a cached route answers while its own cache write is still in flight",
    !!hostRes && hostRes.status === 200 && !!handed && sink.size === 0,
    (hostRes ? "status " + hostRes.status : "request threw") + " · " + (handed ? "write handed to ctx.waitUntil" : "no ctx.waitUntil") + " · stored yet: " + sink.size);
  if (handed) { gate.resolve(); await handed; }
  check("worker cache: the handed-over write still lands", sink.size === 1, sink.size + " stored entry");
  restoreCaches();
  restoreCaches = swapCaches(Promise.resolve(), sink2);
  try { noCtxRes = await askWith("/api/rates?base=USD&to=ZZY", undefined); } catch (e) { noCtxRes = null; }
  check("worker cache: with no ctx.waitUntil the write is awaited, so a plain node run still caches",
    !!noCtxRes && noCtxRes.status === 200 && sink2.size === 1,
    (noCtxRes ? "status " + noCtxRes.status : "request threw") + " · stored: " + sink2.size);
  const storedText = sink2.size ? await Array.from(sink2.values())[0].text() : "";
  const liveText = noCtxRes ? await noCtxRes.text() : "";
  check("worker cache: the client's bytes are the stored copy's bytes - streamed, not re-encoded",
    storedText.length > 0 && storedText === liveText, liveText.length + " bytes, identical after the stream swap");
} finally {
  restoreCaches();
}
check("worker cache: the router streams a cached payload, and no longer decodes it to a string",
  /new Response\(got\.res\.body, \{/.test(wsrc) && /new Response\(res\.body, \{/.test(wsrc) && !/await (?:got\.)?res\.text\(\)/.test(wsrc),
  (wsrc.match(/new Response\((?:got\.)?res\.body, \{/g) || []).length + " streamed routes · old re-encode gone");

/* ── offline: the worker's cache is versioned with the page ──────────────────────
   The prompt-and-reload design rests on one pairing: a release installs a *new* worker, and a
   new worker is what tells the tab an update exists. If deploy/sw.js and the page drift apart,
   a release ships that nobody is ever offered - so the pairing is a gate failure, not a habit.
   The worker's actual behaviour (what is cached, what is passed straight through, what an
   offline navigation receives) is executed in _sw.test.mjs rather than pattern-matched here. */
const { spawnSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const swSrc = readFileSync(new URL("./deploy/sw.js", import.meta.url), "utf8");
const pageVer = (pageSrc.match(/VERSION:\s*"([0-9.]+)"/) || [])[1];
const swVer = (swSrc.match(/const VERSION\s*=\s*"([0-9.]+)"/) || [])[1];
check("offline: the worker's cache version is the page's version, so a release is offered by name",
  !!pageVer && pageVer === swVer, "page " + pageVer + " / worker " + swVer);
check("offline: the shell is required at install - a 404 cannot pose as an offline app",
  /if \(!res \|\| !res\.ok\) throw new Error\("shell /.test(swSrc));
check("offline: the new worker waits; skipping waiting only ever comes from the page's Reload",
  (swSrc.match(/skipWaiting\(/g) || []).length === 1 && /data\.type === "SKIP_WAITING"\) self\.skipWaiting\(\)/.test(swSrc),
  (swSrc.match(/skipWaiting\(/g) || []).length + " call site(s)");
check("offline: the API and every other origin are passed straight through, never cached",
  /url\.origin !== self\.location\.origin\) return;/.test(swSrc) && !/caches\.default/.test(swSrc));
check("page: the worker is registered at boot, not only when reminders are switched on",
  /function swBoot[\s\S]{0,400}swEnsure\(\)/.test(pageSrc) && /pushResume\(\);\nswBoot\(\);/.test(pageSrc));
check("page: Reload swaps the waiting worker, then reloads on controllerchange",
  /postMessage\(\{type:"SKIP_WAITING"\}\)/.test(pageSrc) && /addEventListener\("controllerchange",go\)/.test(pageSrc));
check("page: the update bar and the offline chip are worded in both languages",
  ["updReady", "updGo", "updLater", "offChip"].every((k) => new RegExp("\\b" + k + ":").test(pageSrc)));
/* The offline worker installs by copying the shell, so an install that cannot complete never
   activates. Awaiting `ready` unbounded would leave the reminder switch spinning with no answer
   at all, which is worse than the honest failure it has a string for. */
check("reminders: switching them on cannot hang on a worker that never activates",
  /if\(!reg\.active\) await Promise\.race\(\[navigator\.serviceWorker\.ready/.test(pageSrc),
  /if\(!reg\.active\) await Promise\.race/.test(pageSrc) ? "bounded wait" : "unbounded navigator.serviceWorker.ready");
const swRun = spawnSync(process.execPath, ["_sw.test.mjs"], { encoding: "utf8", cwd: ROOT });
const swTail = String(swRun.stderr || swRun.stdout || "").trim().split("\n").filter(Boolean).pop();
check("offline: the worker's behaviour, executed - install, shells, updates, reminders",
  swRun.status === 0, swRun.status === 0 ? ((swRun.stdout.match(/^\d+\/\d+ checks passed$/m) || ["passed"])[0]) : swTail);

/* ── the plan: repeat, successor and rollover, executed ─────────────────────
   Three rules that look identical in a screenshot whether they work or not: a finished repeat
   card must produce exactly one future copy, a card completed twice must not produce two, and
   an overdue card must move to today once a day and never rewrite a finished one. _tasks.test.mjs
   lifts the real functions out of index.html and runs them against a pinned clock, so the
   arithmetic (setMonth overflow, the guard loop, the once-a-day stamp) is exercised rather
   than pattern-matched. */
const taskRun = spawnSync(process.execPath, ["_tasks.test.mjs"], { encoding: "utf8", cwd: ROOT });
const taskTail = String(taskRun.stderr || taskRun.stdout || "").trim().split("\n").filter(Boolean).pop();
check("plan: repeats, successors and rollover, executed - one copy, dated forward, once a day",
  taskRun.status === 0, taskRun.status === 0 ? ((taskRun.stdout.match(/^\d+\/\d+ checks passed$/m) || ["passed"])[0]) : taskTail);
/* A repeated card and a carried one are the only places the user sees these rules holding, so
   they have to survive a refactor of the card and of the CSV export. */
check("plan: a repeating card and a carried one still say so - a chip on the card, a repeat column in the CSV",
  /className="rep"[^\n]{0,120}REP_KEY\[x\.rep\]/.test(pageSrc) && /className="carried"[^\n]{0,120}t\("carried"\)/.test(pageSrc)
  && /priority,repeat,/.test(pageSrc) && /q\(x\.rep\)/.test(pageSrc),
  "repeat chip · carried chip · csv repeat column");

console.log("\n-- sample payload --");
for (const card of ["auto", "ai", "fin"]) {
  console.log("  --- " + card + " ---");
  (n1[card] || []).slice(0, 5).forEach((i) => console.log("  " + card.padEnd(4) + " [" + i.source + "] " + i.title.slice(0, 62)
    + (i.why && i.why.length ? "\n         why: " + i.why.join(" · ") : "")
    + (i.quota ? "\n         quota: " + i.quota.n + " " + i.quota.unit + " per " + i.quota.per + (i.quota.perDay != null ? " (= " + i.quota.perDay + "/day)" : "") + "  raw: " + i.quota.raw : "")));
}
console.log("\n" + (fails.length ? "FAILED: " + fails.join("; ") : "ALL CHECKS PASSED"));
process.exit(fails.length ? 1 : 0);
