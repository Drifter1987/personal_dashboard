/* Dashboard API Worker v1.12.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Metals: 11 providers (10 that use an API key + 1 keyless fallback).
 * BYOK (bring your own key): the dashboard may call /api/metals with headers
 *   X-Provider: <provider id>      (optional, defaults to the Worker's provider)
 *   X-Api-Key:  <your own key>     (optional, overrides the Worker's key)
 * Keys are only ever sent in headers, never in the URL, and are never echoed
 * back in a response (upstream error text is scrubbed first).
 *
 * Worker configuration (Dashboard → Worker → Settings → Variables and Secrets):
 *   METALS_API_KEY (Secret)          — optional; the Worker's own provider key.
 *                                      May also be a Secrets Store binding, in
 *                                      which case it is read with await .get().
 *   METALS_PROVIDER (Text, optional) — provider id, e.g. "fastforex".
 *   ALLOWED_ORIGIN (Text, optional)  — e.g. https://my-dashboard.pages.dev
 *
 * Provider ids: gold-api, fastforex, metals.dev, metalpriceapi, metals-api,
 *   goldapi-io, goldapi-net, twelvedata, tradermade, alphavantage, api-ninjas
 *
 * /api/news: Auto and Finance are feed cards, built from several RSS/Atom feeds that
 *   were verified live and round-robin interleaved so no single publisher can fill
 *   them. The AI card is a releases card: trending open-weight models from the
 *   Hugging Face API, vendor blogs (Qwen, Ollama, ComfyUI, Replicate, Google) and a
 *   GitHub releases channel, scored so launch/open-source/free/runs-locally signals
 *   rise and funding/policy/opinion pieces sink. Cached 1h at the edge (?fresh=1
 *   forces a refetch for the card refresh button). Every AI item also carries a short
 *   `why` list naming the ranking rules that matched it, so the card can show why an
 *   item is on it instead of leaving the order unexplained. Subrequests run in waves
 *   (Workers allows 6 simultaneous outbound connections). The GitHub card is not here
 *   — the page reads api.github.com directly, from the browser.
 *
 * /api/history: long history for the Time-travel chart, for metals (IMF, monthly), currencies
 *   (ECB daily, the weekly Yahoo pair for the currencies the ECB never quotes, and any pair
 *   crossed through USD when neither source names it) and coins (Yahoo weekly, priced in any
 *   currency by the same cross). Cached 6h; ?fresh=1 bypasses the read.
 *
 * /api/rates: spot rates for the Currencies card, any base against any targets, on those same
 *   USD legs - so the currencies the ECB never publishes (LBP, SAR, EGP…) work as a base and
 *   as a quoted row. Cached 10 min at the edge; ?fresh=1 bypasses the read.
 *
 * /api/repos: the GitHub card. Weekly trending is read from github.com/trending and ranked
 *   by the stars-gained figure GitHub prints on each row; the all-time five come from
 *   api.github.com search (stars desc). Cached 6h; a GitHub 403 falls back to the previous
 *   copy and then to a dated snapshot, which the payload marks stale.
 * /api/generators: the image & video free-allowance table — a dated, hand-checked dataset
 *   with a source link per tool (no vendor publishes a free-quota API).
 *
 * Every cached route serves the stored copy straight through as a stream and hands the
 * refresh write to ctx.waitUntil, so a request waits for neither the JSON re-encode nor the
 * cache put.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const VERSION = "1.13.0";
const UA = "dashboard-worker/" + VERSION;
const METALS = ["XAU", "XAG", "XPT", "XPD"];
const MNAME = { XAU: "gold", XAG: "silver", XPT: "platinum", XPD: "palladium" };
const PROVIDER_DEFAULT = "fastforex";   // used when a key is available
const PROVIDER_KEYLESS = "gold-api";    // used when no key is available
const TTL_METALS = 12 * 3600;

const NEWS_CARDS = { auto: 3, ai: 5, fin: 3 };
const NEWS_TTL = 3600;                    /* 1h; the page caches each card for 1h too */
const NEWS_CONCURRENCY = 5;               /* Workers allows 6 open outbound connections per request */
/* The edge cache key has to be an absolute URL. The old "news-v1" key made
 * new Request() throw, so /api/news silently skipped both the read and the write
 * and every page load refetched all the feeds. v1 to v2 is also the cache bust. */
const NEWS_CACHE_KEY = "https://news-cache.internal/news/v4";

/* Feeds verified live (HTTP 200 + parseable items) on 2026-10-11. The old registry
 * shipped two dead automotive feeds — motorauthority.com/rss answers 403 and
 * rss.autoblog.com no longer resolves — which kept Automotive empty. */
/* Auto and Finance stay interleaved feed cards; the AI card has its own sources below. */
const RSS = {
  auto: [
    "https://www.carscoops.com/feed/",
    "https://insideevs.com/feed/",
    "https://www.caranddriver.com/rss/all.xml/"
  ],
  fin: [
    "https://feeds.bbci.co.uk/news/business/rss.xml",
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://www.cnbc.com/id/100003114/device/rss/rss.html"
  ]
};

/* ─────────────── AI card sources ───────────────
 * The AI card answers "what can I actually use now?", so it is built from release
 * channels rather than general AI news: the Hugging Face trending-models API for new
 * open-weight models, the blogs that announce new models and free tools, and the
 * llama.cpp release channel for the local-runtime crowd. Every source verified live
 * on 2026-10-11; a dead one contributes nothing and leaves the rest alone.
 * (Reddit, Stability, Mistral, BFL and DeepSeek were probed and left out: 404, 429 or
 * no feed at all.) */
const AI_SOURCES = [
  { kind: "models",   label: "Hugging Face", url: "https://huggingface.co/api/models?sort=trendingScore&limit=8&direction=-1" },
  { kind: "feed",     label: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
  { kind: "feed",     label: "Qwen",         url: "https://qwenlm.github.io/blog/index.xml" },
  { kind: "feed",     label: "Ollama",       url: "https://ollama.com/blog/rss.xml" },
  { kind: "feed",     label: "ComfyUI",      url: "https://blog.comfy.org/feed" },
  { kind: "feed",     label: "Replicate",    url: "https://replicate.com/blog/rss" },
  { kind: "feed",     label: "Google AI",    url: "https://blog.google/technology/ai/rss/" },
  { kind: "releases", label: "llama.cpp",    url: "https://github.com/ggml-org/llama.cpp/releases.atom" }
];
/* Promoted: something people can download and run today, especially open, local and free.
 * Each rule carries the short label shown under the headline, so the badge a reader sees
 * is the very rule that moved the item up — not a second guess made at paint time. The
 * regexes and weights are unchanged; only the label is new. */
const AI_UP = [
  { tag: "open weights",     re: /open[- ]?source|open[- ]?weights?|apache[- ]?2|mit licen|gguf|ggml|quantiz|safetensors|\bweights\b/i, w: 14 },
  { tag: "runs locally",     re: /\blocal(ly)?\b|on[- ]device|offline|self[- ]host|ollama|llama\.cpp|lm studio|vllm|comfyui/i, w: 12 },
  { tag: "just released",    re: /releas(e|ed|es)|launch(ed|es)?|now available|generally available|available now|\bis out\b|\bships?\b|unveil/i, w: 10 },
  { tag: "free",             re: /\bfree\b|no[- ]cost|free tier|for free|open beta|\bbeta\b|\bpreview\b|try it|playground|\bdemo\b/i, w: 8 },
  { tag: "free daily limit", re: /\bdaily\b|per\s+day|\/\s?day|\ba day\b|day limit|rate limit|usage limit|quota|credits?/i, w: 6 },
  { tag: "image/video",      re: /image|video|voice|speech|audio|\b3d\b|diffusion|render/i, w: 5 },
  { tag: "model",            re: /\bmodel\b|\bllm\b|checkpoint|fine[- ]?tun|lora/i, w: 5 },
  { tag: "API access",       re: /\bapi\b|\baccess\b|\bplan\b/i, w: 3 },
  { tag: "",                 re: /v?\d+\.\d+|\b\d+\s?b\b/i, w: 2 }
];
/* Demoted: business, legal and commentary pieces are not tools you can use today. */
const AI_DOWN = [
  [/funding|raise[sd]?\b|valuation|series [a-e]\b|\bipo\b|shares?\b|stock|earnings|revenue|acquisition/i, -14],
  [/lawsuit|regulat|senate|court|antitrust|\bban\b|\bpolicy\b|privacy|gdpr/i, -12],
  [/layoff|job cuts|hiring|union/i, -10],
  [/opinion|analysis\b|\bwhy\b|essay|podcast|webinar|conference|summit|disrupt|awards?\b|nominat|sponsored/i, -10]
];
/* A dashboard people scan at a glance (and share by QR) should not surface adult model names. */
const AI_BLOCK = /uncensored|nsfw|\bxxx\b|porn|erotic|hentai/i;

function compact(n) {
  const v = Number(n);
  if (!isFinite(v)) return "0";
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(v);
}
/* Relevance = keyword signals + kind + how fresh the item is (12h: +12, a week: 0). */
function aiScore(it) {
  const hay = (it.title + " " + (it.desc || "")).toLowerCase();
  let s = 0;
  for (const r of AI_UP) if (r.re.test(hay)) s += r.w;
  for (const [re, w] of AI_DOWN) if (re.test(hay)) s += w;
  if (it.kind === "model") s += 16;      /* "new open-source models" is the headline ask */
  /* Build/version items get no freshness boost: llama.cpp ships several times a day, and
   * recency would otherwise float a build number above a real model or tool announcement. */
  if (it.kind === "release") return s;
  const t = Date.parse(it.time || "");
  if (!isNaN(t)) s += Math.max(0, 12 - (Date.now() - t) / 43200000);
  return s;
}
/* Which rules matched, reported back with the item. Ordered by what a reader cares about
 * — can I get the weights, can I run it at home, is it free and how much do I get — and
 * capped at three so the card stays scannable. Two rules are deliberately absent: a
 * version number is not a reason, and neither is the word "model" — that is the item's
 * type, which the card title already says, so only real signals earn a badge. */
const WHY_ORDER = ["open weights", "runs locally", "free daily limit", "trending model", "free", "just released", "image/video", "API access"];
const WHY_MAX = 3;
function aiWhy(it) {
  const hay = (it.title + " " + (it.desc || "")).toLowerCase();
  const hit = {};
  for (const r of AI_UP) if (r.tag && r.re.test(hay)) hit[r.tag] = 1;
  if (it.kind === "model") hit["trending model"] = 1;   /* straight off the Hugging Face trending list */
  return WHY_ORDER.filter((tag) => hit[tag]).slice(0, WHY_MAX);
}
/* ─────────────── free-tier quota ───────────────
 * The card answers "what can I use today, and how much of it do I get for free?", so the
 * free allowance is the one number a reader compares between items — and it arrives as
 * prose, in whatever unit and whatever period the announcement happened to use ("50 images
 * per day", "600 requests/month", "20 free credits", "1 million free credits"). Parsed and
 * normalised once here, every item's allowance lands in the page's quota column in the same
 * shape, and a per-day figure is what makes a daily allowance and a monthly one comparable
 * at a glance. Nothing is inferred: an amount needs a real unit (a version number, a model
 * size or a price is not a quota), a period-less amount is only believed for credits, and
 * the exact phrase the figure came from rides along as `raw` for the tooltip. The page's
 * offline fallback carries a verbatim mirror of this block, and the test suite runs both
 * over one fixture list, so the two cannot drift apart unnoticed.
 */
const Q_UNITS = [
  ["images", /^(?:images?|imgs?|pictures?|photos?|renders?|artworks?|upscales?)$/i],
  ["videos", /^(?:videos?|clips?|reels?|animations?)$/i],
  ["generations", /^(?:generations?|gens?|creations?)$/i],
  ["prompts", /^prompts?$/i],
  ["requests", /^(?:requests?|reqs?|calls?|queries|query)$/i],
  ["tokens", /^tokens?$/i],
  ["words", /^words?$/i],
  ["characters", /^(?:characters?|chars?)$/i],
  ["messages", /^(?:messages?|msgs?|chats?|conversations?)$/i],
  ["hours", /^(?:hours?|hrs?)$/i],
  ["minutes", /^(?:minutes?|mins?)$/i],
  ["seconds", /^seconds?$/i],
  ["credits", /^credits?$/i],
  ["jobs", /^(?:jobs?|tasks?|downloads?|exports?|batches?)$/i],
  ["GB", /^(?:gbs?|gigabytes?)$/i]
];
/* Periods collapse onto a per-day rate: hour ×24, week ÷7, month ÷30, year ÷365. Month and
 * year use the calendar average, so "600 requests/month" reads as 20/day and lands in the
 * same column as "50 images/day" instead of looking ten times bigger. A period needs either
 * a connector ("per day", "/day", "a day") or to be the first word after the amount, so the
 * "3-day trial" in "50 free images (3-day trial)" is a trial length, not a quota period. */
const Q_PERIODS = [
  { re: /(?:\/|per\s+|a\s+|an\s+|each\s+|every\s+)\s*hours?\b|^\s*(?:hour|hourly|hours)\b/i, per: "hour", rate: 24 },
  { re: /(?:\/|per\s+|a\s+|an\s+|each\s+|every\s+)\s*days?\b|^\s*(?:day|daily|days)\b/i, per: "day", rate: 1 },
  { re: /(?:\/|per\s+|a\s+|an\s+|each\s+|every\s+)\s*weeks?\b|^\s*(?:week|weekly|weeks)\b/i, per: "week", rate: 1 / 7 },
  { re: /(?:\/|per\s+|a\s+|an\s+|each\s+|every\s+)\s*months?\b|^\s*(?:month|monthly|months)\b/i, per: "month", rate: 1 / 30 },
  { re: /(?:\/|per\s+|a\s+|an\s+|each\s+|every\s+)\s*years?\b|^\s*(?:year|yearly|annual|annually|years)\b/i, per: "year", rate: 1 / 365 }
];
/* A grant with no period ("20 free credits", "free for up to 20 generations") is a one-off
 * allowance and is reported as such rather than dressed up as a daily rate. */
const Q_GRANT = /\b(?:free|bonus|trial|starter|complimentary)\b/i;
const Q_GRANT_BEFORE = /\b(?:free|trial|starter|complimentary|bonus)\b[^.!?]{0,12}$/i;
/* "daily 50 images" puts the period before the amount; "50 free images per day" after it. */
const Q_BEFORE = /\b(daily|weekly|monthly|hourly|per\s+day|a\s+day|each\s+day)\b/i;
/* An amount, then the unit among the next few words: qualifiers can sit between them
 * ("20 free credits", "100 free API calls") but a second number ends the search, so the
 * "2" of "Qwen 2.1 with 50 free images/day" cannot be paired with "images". */
const Q_AMT = /\b(\d[\d,]*(?:\.\d+)?)\s*(k|m|mn|bn|thousand|million|billion)?\b/gi;
const Q_WORD = /[a-z]{2,14}/gi;
const Q_WORDS_MAX = 4;
const Q_MULT = { k: 1e3, m: 1e6, mn: 1e6, bn: 1e9, thousand: 1e3, million: 1e6, billion: 1e9 };
const Q_UNLIMITED = /\b(unlimited|unmetered|uncapped|no\s+(?:daily\s+|usage\s+|monthly\s+)?limits?)\b/i;
const Q_DAY_UNITS = /^(?:images|videos|generations|prompts|requests)$/;
function qUnit(word) {
  for (const pair of Q_UNITS) if (pair[1].test(word)) return pair[0];
  return "";
}
/* The stated allowance, normalised: { n, unit, per, perDay, raw }. null when the item
 * states none — the page shows a dash there rather than an invented figure. */
function aiQuota(it) {
  const hay = ((it.title || "") + " — " + (it.desc || "")).slice(0, 400);
  const found = [];
  Q_AMT.lastIndex = 0;
  let m;
  while ((m = Q_AMT.exec(hay))) {
    const n = parseFloat(m[1].replace(/,/g, "")) * (Q_MULT[(m[2] || "").toLowerCase()] || 1);
    if (!isFinite(n) || n <= 0 || n > 1e6) continue;   /* a multi-million allowance is not a quota */
    const before = hay.slice(Math.max(0, m.index - 18), m.index);
    /* "$5 in free credits" is a price line, not a count, so a currency sign disqualifies
     * the amount outright. */
    if (/[$€£¥]/.test(before)) continue;
    const between = hay.slice(m.index + m[0].length, m.index + m[0].length + 60).replace(/\d[\s\S]*$/, "");
    Q_WORD.lastIndex = 0;
    let unit = "", end = -1, w, words = 0;
    while ((w = Q_WORD.exec(between)) && words++ < Q_WORDS_MAX) {
      const u = qUnit(w[0]);
      if (u) { unit = u; end = w.index + w[0].length; break; }
    }
    if (!unit) continue;
    const granted = unit === "credits" || Q_GRANT.test(between.slice(0, end)) || Q_GRANT_BEFORE.test(before);
    const after = between.slice(end, end + 26);
    let per = "", rate = 0, spanAt = 0, spanLen = 0;
    for (const p of Q_PERIODS) {
      const hit = p.re.exec(after);
      if (hit) { per = p.per; rate = p.rate; spanAt = hit.index; spanLen = hit[0].length; break; }
    }
    if (!per && Q_BEFORE.test(before)) per = "day";
    /* No period and no grant: an amount on its own is not an allowance, so no chip. */
    if (!per && !granted) continue;
    const perDay = per ? Math.round(n * (rate || 1) * 100) / 100 : null;
    found.push({
      at: m.index,
      score: (per && per !== "total" ? 4 : 0) + (Q_DAY_UNITS.test(unit) ? 2 : 0) + (unit === "credits" ? 1 : 0) + (per === "day" ? 1 : 0),
      q: {
        n: Math.round(n), unit: unit, per: per || "total", perDay: perDay,
        raw: hay.slice(m.index, m.index + m[0].length + end + spanAt + spanLen).replace(/\s+/g, " ").trim().slice(0, 80)
      }
    });
  }
  if (found.length) {
    /* Several amounts can appear (a free tier plus a paid one): take the most useful —
     * a stated period over a bare grant, a generative unit over infrastructure — and the
     * earliest when they tie. */
    found.sort((a, b) => (b.score - a.score) || (a.at - b.at));
    return found[0].q;
  }
  const unl = Q_UNLIMITED.exec(hay);
  if (unl) return { n: null, unit: "unlimited", per: "day", perDay: null, raw: unl[0].slice(0, 80) };
  return null;
}
/* Newest trending open-weight models, with the numbers that show they are being used. */
async function fetchModels(url, n) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const arr = await r.json();
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, n).map((m) => ({
      title: m.id + " · " + compact(m.likes) + " likes · " + compact(m.downloads) + " downloads",
      link: "https://huggingface.co/" + m.id,
      desc: [m.pipeline_tag, (m.tags || []).slice(0, 10).join(", ")].filter(Boolean).join(" · "),
      time: m.createdAt || "",
      source: "huggingface.co",
      kind: "model"
    }));
  } catch (e) { return []; }
}
/* "llama.cpp b11559" reads better than a bare build number. */
function releaseTag(link, title) {
  const m = /\/(?:releases\/tag|tag)\/([^\/?#]+)/i.exec(link || "");
  return m ? m[1] : String(title || "").replace(/^release\s+/i, "").trim();
}
async function fetchSource(src, n) {
  if (src.kind === "models") return fetchModels(src.url, n);
  const items = await fetchFeed(src.url, n + 2);
  if (src.kind !== "releases") return items;
  return items.map((it) => ({
    title: src.label + " " + releaseTag(it.link, it.title),
    link: it.link,
    desc: (it.desc || "").slice(0, 220),
    time: it.time,
    source: "github.com",
    kind: "release"
  }));
}
/* Rank the pooled AI items, cap two per source so one blog cannot fill the card. */
function rankAI(pool, n) {
  const seen = {}, scored = [];
  for (const it of pool) {
    if (!it || !it.link || seen[it.link] || AI_BLOCK.test(it.title || "")) continue;
    seen[it.link] = 1;
    it.score = aiScore(it);
    scored.push(it);
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [], perSource = {}, budget = { release: 1 };   /* at most one build/version */
  const key = (it) => (it.srcKey == null ? "?" : it.srcKey);
  const fits = (it) => (perSource[key(it)] || 0) < 2 && !(it.kind && budget[it.kind] <= 0);
  const take = (it) => {
    perSource[key(it)] = (perSource[key(it)] || 0) + 1;
    if (it.kind && budget[it.kind] != null) budget[it.kind]--;
    out.push(it);
  };
  for (const it of scored) { if (out.length >= n) break; if (fits(it)) take(it); }
  const picked = {};
  out.forEach((it) => { picked[it.link] = 1; });
  for (const it of scored) {              /* quiet day: relax the caps rather than show fewer */
    if (out.length >= n) break;
    if (!picked[it.link]) { picked[it.link] = 1; out.push(it); }
  }
  return out.slice(0, n).map((it) => {
    it.why = aiWhy(it);
    const q = aiQuota(it);            /* the free allowance travels with the item */
    if (q) it.quota = q;
    delete it.score;
    return it;
  });
}


/* ─────────────── small helpers ─────────────── */
const enc = (s) => encodeURIComponent(s);
function num(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) && n > 0 ? n : null;
}
/* "ounces per USD" → "USD per ounce"; already-inverted quotes pass through. */
function invert(v) { const n = num(v); return n == null ? null : (n < 1 ? 1 / n : n); }
/* rates/results container lookup for the *-per-USD style providers. */
function usdPrice(j, m) {
  const bag = (j && (j.rates || j.results || j.data)) || {};
  const direct = bag["USD" + m];
  if (direct != null) return num(direct);
  const v = bag[m];
  return v == null ? null : invert(v);
}
function sanitize(s, key) {
  let out = String(s == null ? "" : s).slice(0, 200);
  if (key) out = out.split(key).join("***").split(enc(key)).join("***");
  return out;
}
/* A Workers secret is a string; a Secrets Store binding is an object with get(). */
async function readSecret(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v.get === "function") { try { return String((await v.get()) || "").trim(); } catch (e) { return ""; } }
  if (typeof v.value === "string") return v.value.trim();
  return "";
}

/* ─────────────── long history: the whole story, 1990 → now ───────────────
 * The chart card asks one question — "what is the whole story of this thing?" — so this
 * route reaches as far back as keyless data goes and reports where that actually is:
 *   metals   IMF Primary Commodity Prices — every metal the source prices monthly, from 1992
 *            (the deepest free vintage; the IMF publishes nothing earlier through its API, and
 *            FRED/LBMA/stooq are key-gated, bot-walled or unreachable), each series from its
 *            own start where the IMF began later;
 *   currency ECB reference rates via Frankfurter, from 1999-01-04 (the euro's first day —
 *            there is no free pre-euro daily series), later for currencies the ECB added
 *            afterwards, which the response reports as `first`; currencies outside the ECB's
 *            set (SAR, AED, EGP, PKR and their neighbours) fall to the weekly Yahoo pair,
 *            which begins in 2002-2007 and says so;
 *   crypto   each coin's own first Yahoo Finance print (BTC 2014-09, ETH/XRP 2017-11,
 *            SOL 2020-04), weekly so a 12-year run stays small; a coin Yahoo has no pair for
 *            gets CoinGecko's last 365 daily closes, reported at that cadence.
 * Yahoo sends no CORS headers, so it can only be reached from here (not from the page),
 * and all three sources are cached at the edge for HIST_TTL. History moves slowly but not
 * never, so ?fresh=1 bypasses the read the way /api/news does.
 */
const HIST_TTL = 6 * 3600;
const HIST_MAX = 1400;            /* points handed to the chart, whatever the source cadence */
const HIST_FROM = "1990-01-01";    /* what the card asks for; sources start later and say so */
const IMF_URL = "https://api.imf.org/external/sdmx/2.1/data/PCPS/G001.";
const LB_PER_TONNE = 2204.62;      /* the IMF quotes the base metals per tonne */
/* Every metal the IMF prices monthly, with the unit it states and `div`, which converts a quote
 * published per tonne into the unit the card shows (copper and cobalt read per pound, matching
 * the Metals card); everything else passes through untouched. Each series carries its own start
 * date, which the payload reports and the caption prints, so a metal the IMF only began pricing
 * in 2010 says so instead of claiming 1992.
 *
 * The IMF's table holds 17 metals. Lithium and chromium are deliberately absent: the source
 * states no unit for either (lithium's magnitudes are CNY per tonne under a USD key), and a row
 * plotting an unlabelled scale against a "USD" axis would be quietly wrong. Cobalt's metadata
 * says "US dollars per pound" while the values are per metric tonne — 30,920 in 1992 is $14.03
 * a pound, the real 1992 price, and its 2008 peak of 95,023 matches the period's ~$95k/tonne
 * spike — so it is divided like copper rather than trusted at face value. */
const IMF_METALS = {
  XAU: { ind: "PGOLD", label: "Gold", unit: "USD/oz", div: 1 },
  XAG: { ind: "PSILVER", label: "Silver", unit: "USD/oz", div: 1 },
  XPT: { ind: "PPLAT", label: "Platinum", unit: "USD/oz", div: 1 },
  XPD: { ind: "PPALLA", label: "Palladium", unit: "USD/oz", div: 1 },
  HG: { ind: "PCOPP", label: "Copper", unit: "USD/lb", div: LB_PER_TONNE },
  ALU: { ind: "PALUM", label: "Aluminium", unit: "USD/t", div: 1 },
  NI: { ind: "PNICK", label: "Nickel", unit: "USD/t", div: 1 },
  ZNC: { ind: "PZINC", label: "Zinc", unit: "USD/t", div: 1 },
  PB: { ind: "PLEAD", label: "Lead", unit: "USD/t", div: 1 },
  SN: { ind: "PTIN", label: "Tin", unit: "USD/t", div: 1 },
  FE: { ind: "PIORECR", label: "Iron ore", unit: "USD/t", div: 1 },
  MO: { ind: "PLMMODY", label: "Molybdenum", unit: "USD/t", div: 1 },
  MN: { ind: "PMANGELE", label: "Manganese", unit: "USD/t", div: 1 },
  CO: { ind: "PCOBA", label: "Cobalt", unit: "USD/lb", div: LB_PER_TONNE },
  URA: { ind: "PURAN", label: "Uranium", unit: "USD/lb", div: 1 }
};
/* The ECB publishes these and no others; anything outside the list falls to the Yahoo pair. */
const ECB_CURRENCIES = ["AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR"];
/* Weekly Yahoo pairs for the currencies the ECB never quotes, from each pair's own first print
 * (2002-2007) — the regional currencies a dashboard like this actually gets asked for. */
const YAHOO_FX = ["SAR", "AED", "QAR", "KWD", "OMR", "BHD", "JOD", "EGP", "PKR", "NGN", "KES", "MAD", "TND", "DZD", "LBP", "IQD", "YER", "SDG", "LYD", "SYP", "RUB"];

/* Keep a fixed budget of points, always including the first and the last, so a 7,100-day
 * ECB run and a 417-month IMF run cost the page the same and the series still starts where
 * the data starts. Thinning is disclosed, never hidden: `total` carries the source's own
 * point count, so the card can say "7,140 daily points · 1,400 plotted" instead of passing
 * a sampled series off as the whole cadence. */
function thin(pts, max) {
  if (!pts.length || pts.length <= max) return pts;
  const out = [], step = (pts.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * step)]);
  return out;
}
function ymd(ms) { return ms ? new Date(ms).toISOString().slice(0, 10) : ""; }
/* Assembly shared by the three kinds: thin, then describe what was actually found. */
function histPayload(o) {
  const raw = o.points || [];
  const pts = thin(raw, HIST_MAX);
  const first = pts.length ? ymd(pts[0][0]) : "";
  return {
    kind: o.kind, symbol: o.symbol, label: o.label || o.symbol, unit: o.unit,
    source: o.source, cadence: o.cadence, first: first, last: pts.length ? ymd(pts[pts.length - 1][0]) : "",
    count: pts.length, total: raw.length, thinned: pts.length < raw.length,
    requestedFrom: o.from || HIST_FROM, points: pts, note: o.note || ""
  };
}
/* IMF SDMX: the key is dot-separated — the colon form answers 400 for a single series, and
 * the JSON carries the observation times in structure.dimensions.observation[0].values. */
async function imfSeries(ind, from) {
  const start = String(from || HIST_FROM).slice(0, 7);
  const url = IMF_URL + ind + ".USD.M?startPeriod=" + start;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { pts: [], note: "IMF HTTP " + r.status };
  const j = await r.json();
  const times = ((((j.structure || {}).dimensions || {}).observation || [])[0] || {}).values || [];
  const sets = ((j.dataSets || [])[0] || {}).series || {};
  const pts = [];
  for (const key of Object.keys(sets)) {
    const obs = (sets[key] || {}).observations || {};
    for (const k of Object.keys(obs)) {
      const cell = obs[k] || [];
      const v = cell[0];
      const id = times[Number(k)] && times[Number(k)].id;
      const m = id ? /^(\d{4})-M(\d{2})$/.exec(id) : null;
      if (v == null || !m || !isFinite(Number(v))) continue;
      pts.push([Date.UTC(Number(m[1]), Number(m[2]) - 1, 1), Number(v)]);
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  return { pts: pts, note: pts.length ? "" : "IMF returned no observations" };
}
/* Yahoo chart: timestamps plus a close per bucket. No CORS, so this only ever runs here. */
async function yahooSeries(ticker, interval, from) {
  const p1 = Math.floor(Date.parse(String(from || HIST_FROM) + "T00:00:00Z") / 1000) || 0;
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + enc(ticker) +
    "?period1=" + p1 + "&period2=" + Math.floor(Date.now() / 1000) + "&interval=" + interval;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { pts: [], note: "Yahoo HTTP " + r.status };
  const j = await r.json();
  const res = (((j.chart || {}).result) || [])[0];
  if (!res) return { pts: [], note: "Yahoo has no series for " + ticker };
  const ts = res.timestamp || [];
  const closes = ((((res.indicators || {}).quote) || [{}])[0] || {}).close || [];
  const pts = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !isFinite(c)) continue;
    pts.push([ts[i] * 1000, Number(c)]);
  }
  return { pts: pts, note: pts.length ? "" : "Yahoo returned no closes" };
}
/* ECB reference rates through Frankfurter, which clamps the range itself and reports the
 * clamped start_date — for most pairs 1999-01-04, later where the ECB added the currency. */
async function ecbSeries(base, quote, from) {
  const url = "https://api.frankfurter.dev/v1/" + (from || HIST_FROM) + "..?from=" + enc(base) + "&to=" + enc(quote);
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { pts: [], note: "ECB HTTP " + r.status, began: "" };
  const j = await r.json();
  const rates = j.rates || {};
  const pts = Object.keys(rates).sort().map((d) => {
    const v = (rates[d] || {})[quote];
    return [Date.parse(d + "T00:00:00Z"), v == null ? NaN : Number(v)];
  }).filter((p) => isFinite(p[1]));
  return { pts: pts, note: pts.length ? "" : "no rates for " + base + quote, began: j.start_date || "" };
}
/* Any currency against any other: when neither the ECB nor a direct Yahoo bar names the
 * pair (EUR/SAR, AED/PKR), build it from its two USD legs - each leg read from the source
 * that actually publishes it - and divide one by the other, quote per base. The coarser leg
 * sets the dates: where a weekly Yahoo leg is involved its own bars are the points and the
 * ECB's daily rates are read there, so a weekly value is never restamped onto daily dates
 * to fake a finer series. A USD leg is the identity and is never fetched. */
async function usdLeg(code, from) {
  if (code === "USD") return { pts: null, cadence: "daily", src: "USD" };
  if (ECB_CURRENCIES.indexOf(code) >= 0) {
    const e = await ecbSeries("USD", code, from);
    if (e.pts.length) return { pts: e.pts, cadence: "daily", src: "ECB" };
  }
  const y = await yahooSeries("USD" + code + "=X", "1wk", from);
  if (y.pts.length) return { pts: y.pts, cadence: "weekly", src: "Yahoo" };
  return null;
}
/* One merger serves every cross, FX pairs and coins alike: walk the coarser of the two
 * legs and carry the finer leg's last value forward to that date, so a weekly rate is
 * never restamped onto daily dates to fake a finer series. `fn(a, b)` reads the two legs
 * in their own units and returns the crossed value; a leg that is absent (or 0) leaves
 * the output empty rather than inventing a rate. */
function mergeLegs(a, b, fn) {
  const legs = [a, b].filter((l) => l && l.pts && l.pts.length);
  const coarse = legs.filter((l) => l.cadence === "weekly");
  const spine = [];
  (coarse.length ? coarse : legs).forEach((l) => l.pts.forEach((p) => spine.push(p[0])));
  spine.sort((x, z) => x - z);
  const pts = [];
  let i = 0, j = 0, va = a && a.pts ? 0 : 1, vb = b && b.pts ? 0 : 1,
    ha = !(a && a.pts), hb = !(b && b.pts), lastT = -1;
  for (const t of spine) {
    if (t === lastT) continue;
    lastT = t;
    while (a && a.pts && i < a.pts.length && a.pts[i][0] <= t) { va = a.pts[i][1]; ha = true; i++; }
    while (b && b.pts && j < b.pts.length && b.pts[j][0] <= t) { vb = b.pts[j][1]; hb = true; j++; }
    if (!ha || !hb) continue;
    const v = fn(va, vb);
    if (isFinite(v) && v > 0) pts.push([t, v]);
  }
  return { pts: pts, cadence: coarse.length ? "weekly" : "daily" };
}
/* The conversion a coin uses when it is priced abroad: the coin keeps its own bars and
 * each one is multiplied by the base's USD leg as it stood then, so a weekly rate is held
 * across the coin's own week rather than the two weekly calendars being interleaved into
 * dates the coin never printed at. Returns [] until the rate series reaches the coin. */
function convertSeries(pts, legPts, fn) {
  const out = [];
  let lv = 0, li = 0, have = false;
  for (const p of pts) {
    while (li < legPts.length && legPts[li][0] <= p[0]) { lv = legPts[li][1]; have = true; li++; }
    if (!have) continue;
    const v = fn(p[1], lv);
    if (isFinite(v) && v > 0) out.push([p[0], v]);
  }
  return out;
}
async function crossSeries(base, quote, from) {
  const lb = await usdLeg(base, from);
  const lq = await usdLeg(quote, from);
  if (!lb || !lq) {
    return {
      pts: [], cadence: "weekly", source: "USD cross",
      note: "no USD series for " + (lb ? quote : base) + " \u2014 the pair cannot be crossed"
    };
  }
  const merged = mergeLegs(lb, lq, (perBase, perQuote) => perQuote / perBase);
  const srcs = [];
  [lb, lq].forEach((l) => { if (l.src !== "USD" && srcs.indexOf(l.src) < 0) srcs.push(l.src); });
  return {
    pts: merged.pts, cadence: merged.cadence, source: "USD cross",
    note: merged.pts.length ? "crossed through USD (" + srcs.join(" + ") + ")"
      : "the USD legs for " + base + "/" + quote + " do not overlap"
  };
}
/* The last-resort crypto series: CoinGecko's public API now refuses anything older than a
 * year, so it is only used when Yahoo has no pair for a coin, and it says so. */
async function cgSeries(id) {
  const url = "https://api.coingecko.com/api/v3/coins/" + enc(id) + "/market_chart?vs_currency=usd&days=365";
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { pts: [], note: "CoinGecko HTTP " + r.status };
  const j = await r.json();
  const pts = (j.prices || []).filter((p) => p && isFinite(p[1])).map((p) => [Number(p[0]), Number(p[1])]);
  return { pts: pts, note: "Yahoo has no pair for this coin: showing CoinGecko's last 365 days" };
}
async function historyPayload(kind, symbol, base, cgId, from) {
  if (kind === "metal") {
    const sym = String(symbol || "").toUpperCase();
    const m = IMF_METALS[sym];
    if (!m) return { error: "unknown metal", symbols: Object.keys(IMF_METALS) };
    const got = await imfSeries(m.ind, from);
    const pts = m.div > 1 ? got.pts.map((p) => [p[0], Math.round((p[1] / m.div) * 1e4) / 1e4]) : got.pts;
    const began = pts.length ? ymd(pts[0][0]).slice(0, 7) : "";
    return histPayload({
      kind: kind, symbol: sym, label: m.label, unit: m.unit,
      source: "IMF PCPS", cadence: "monthly", points: pts, from: from,
      /* Most metals start in 1992, but the IMF only began pricing molybdenum in 2010 and a few
       * others in 2012 — each row says where its own series begins. */
      note: got.note || (began && began > "1992-01" ? "IMF series begins " + began : "")
    });
  }
  if (kind === "fx") {
    const quote = String(symbol || "EUR").toUpperCase();
    const b = String(base || "USD").toUpperCase();
    /* A currency the ECB does not publish skips straight to Yahoo rather than asking Frankfurter
     * for a code it will reject; a pair it does publish still goes through the ECB, since
     * Frankfurter resolves crosses the Yahoo pair names cannot express. */
    const ecbCovers = ECB_CURRENCIES.indexOf(quote) >= 0 && ECB_CURRENCIES.indexOf(b) >= 0;
    const got = ecbCovers ? await ecbSeries(b, quote, from) : { pts: [], note: "", began: "" };
    if (got.pts.length) {
      return histPayload({
        kind: kind, symbol: b + quote, label: b + "/" + quote, unit: quote, source: "ECB reference rates",
        cadence: "daily", points: got.pts, from: from,
        note: got.note || (got.began && got.began > String(from || HIST_FROM) ? "ECB data begins " + got.began : "")
      });
    }
    const y = await yahooSeries(b + quote + "=X", "1wk", from);
    if (y.pts.length) {
      return histPayload({
        kind: kind, symbol: b + quote, label: b + "/" + quote, unit: quote, source: "Yahoo Finance",
        cadence: "weekly", points: y.pts, from: from,
        note: "outside the ECB's set \u2014 Yahoo data begins " + ymd(y.pts[0][0])
      });
    }
    /* Neither source names this pair directly (EUR/SAR, AED/PKR): cross it through USD
     * rather than giving up, each leg read from the source that actually publishes it. */
    const cr = await crossSeries(b, quote, from);
    if (cr.pts.length) {
      return histPayload({
        kind: kind, symbol: b + quote, label: b + "/" + quote, unit: quote, source: cr.source,
        cadence: cr.cadence, points: cr.pts, from: from, note: cr.note
      });
    }
    return histPayload({
      kind: kind, symbol: b + quote, label: b + "/" + quote, unit: quote, source: cr.source,
      cadence: cr.cadence, points: [], from: from,
      note: cr.note || y.note || got.note || ""
    });
  }
  if (kind === "crypto") {
    const ticker = String(symbol || "btc").toUpperCase();
    const b = String(base || "USD").toUpperCase();
    let got = await yahooSeries(ticker + "-USD", "1wk", from);
    let note = got.note;
    /* The cadence follows whichever source answered: Yahoo prints weekly, CoinGecko's fallback
     * is a daily run, and labelling a year of daily closes "weekly" would misstate the series. */
    let cadence = "weekly", source = "Yahoo Finance";
    if (!got.pts.length) {
      const cg = await cgSeries(String(cgId || ""));
      if (cg.pts.length) { got = cg; note = cg.note; cadence = "daily"; source = "CoinGecko"; }
      else if (!note) note = cg.note;
    }
    if (b === "USD") {
      return histPayload({
        kind: kind, symbol: ticker, label: ticker, unit: "USD", source: source, cadence: cadence,
        points: got.pts, from: from, note: note
      });
    }
    /* A coin's own series is quoted in USD, so priced in another currency it is that series
     * times the currency's USD leg - the same cross the FX pairs go through, read the same
     * way (units per USD), so LBP or EUR is a picker choice rather than a second source. */
    const leg = await usdLeg(b, from);
    if (!got.pts.length || !leg || !leg.pts) {
      return histPayload({
        kind: kind, symbol: ticker, label: ticker + "/" + b, unit: b, source: source, cadence: cadence,
        points: [], from: from,
        note: note || (leg ? "" : "no USD series for " + b + " \u2014 the coin cannot be priced in it")
      });
    }
    const crossed = convertSeries(got.pts, leg.pts, (coinUsd, perBase) => coinUsd * perBase);
    const srcs = [source === "Yahoo Finance" ? "Yahoo" : source];
    if (leg.src !== "USD" && srcs.indexOf(leg.src) < 0) srcs.push(leg.src);
    return histPayload({
      kind: kind, symbol: ticker, label: ticker + "/" + b, unit: b, source: "USD cross",
      cadence: cadence, points: crossed, from: from,
      note: crossed.length ? "crossed through USD (" + srcs.join(" + ") + ")"
        : "the USD legs for " + ticker + "/" + b + " do not overlap"
    });
  }
  return { error: "unknown kind", kinds: ["metal", "fx", "crypto"] };
}

/* ─────────────── spot rates for the currencies card ───────────────
 * The ECB table the card reads (through Frankfurter) stops at the currencies the ECB
 * publishes, which leaves out the ones a dashboard like this is actually asked about.
 * /api/rates answers any base against any target set on the same legs the chart crosses:
 * every currency is read as "units per USD" from whoever publishes it - the ECB's daily
 * reference rate, otherwise the weekly Yahoo pair - and the cross is a single division.
 * LBP therefore works as a base and as a quoted currency alike, which the ECB table
 * alone cannot express, and both the card and the chart describe pairs the same way.
 */
const RATES_TTL = 600;              /* 10 min at the edge; the card caches for 30 */
async function perUsd(code) {
  const c = String(code || "").toUpperCase();
  if (c === "USD") return { v: 1, src: "USD" };
  if (ECB_CURRENCIES.indexOf(c) >= 0) {
    try {
      const r = await fetch("https://api.frankfurter.dev/v1/latest?from=USD&to=" + enc(c),
        { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      if (r.ok) {
        const v = (((await r.json()).rates) || {})[c];
        if (isFinite(v) && v > 0) return { v: Number(v), src: "ECB" };
      }
    } catch (e) {}
  }
  /* A month of dailies is all a spot rate needs, and keeps the Yahoo call small. */
  const y = await yahooSeries("USD" + c + "=X", "1d", ymd(Date.now() - 30 * 86400000));
  if (y.pts.length) return { v: y.pts[y.pts.length - 1][1], src: "Yahoo" };
  return null;
}
async function ratesPayload(base, list) {
  const b = String(base || "USD").toUpperCase();
  const lb = await perUsd(b);
  if (!lb) return { error: "no rate series for " + b, base: b, rates: {}, sources: {} };
  const targets = list.map((c) => String(c).toUpperCase().trim()).filter((c) => c && c !== b).slice(0, 40);
  const got = await inWaves(targets.map((c) => () => perUsd(c)), 5);
  const rates = {}, sources = {};
  targets.forEach((c, i) => {
    const l = got[i];
    if (!l || !(lb.v > 0)) return;
    /* Returned as computed: a rate is a ratio, and rounding a small one (1 LBP in USD)
     * to 8 decimals stops it multiplying back to 1. The card formats it for display. */
    rates[c] = l.v / lb.v;
    sources[c] = l.src;
  });
  sources[b] = lb.src;
  return { base: b, asof: new Date().toISOString(), rates: rates, sources: sources };
}

/* ─────────────── free image & video allowances ───────────────
 * A card of its own, because the question is its own: which image and video generators
 * give you something free every day, and how much? These figures are NOT live — no vendor
 * publishes a free-quota API — so every row is a number read off that vendor's own pricing
 * or help page on GEN_CHECKED, and every row links to that page. The card prints the
 * checked date, so a figure that has moved since is one click from the source. Only tools
 * whose vendor states a number are listed: Sora was discontinued in April 2026, Kling,
 * Hailuo, Luma, Wan and Grok Imagine publish no free-allowance figure, and Pika's and
 * Vidu's own pages disagree with themselves. Units are the vendor's own — credits, tokens,
 * stamina and compute units are not images, and the note column says so rather than
 * inventing a conversion. The page carries a verbatim mirror of this block for offline use
 * and the harness compares the two copies, so they cannot drift apart.
 */
/* GEN-DATA-BEGIN (mirrored verbatim in index.html; the harness compares the two copies) */
const GEN_CHECKED = "2026-10-13";
const GEN_TOOLS = [
{"id":"bing","tool":"Bing Image Creator","kind":"image","n":15,"unit":"creations","span":"day","note":"genNBing","url":"https://www.bing.com/images/create/help"},
{"id":"leonardo","tool":"Leonardo.Ai","kind":"image","n":150,"unit":"fastTokens","span":"day","note":"genNLeonardo","url":"https://leonardo.ai/pricing"},
{"id":"krea","tool":"Krea","kind":"image","n":100,"unit":"units","span":"day","note":"genNKrea","url":"https://www.krea.ai/docs/user-guide/help-and-support/compute-units"},
{"id":"nightcafe","tool":"NightCafe","kind":"image","n":5,"unit":"credits","span":"day","note":"genNNight","url":"https://creator.nightcafe.studio/pricing"},
{"id":"seaart","tool":"SeaArt","kind":"image","n":150,"unit":"stamina","span":"day","note":"genNSea","url":"https://docs.seaart.ai/guide-1/1-seaart-ai-basic-page"},
{"id":"playground","tool":"Playground","kind":"image","n":10,"unit":"images","span":"3h","note":"genNPlay","url":"https://playgroundai.com/design/pricing"},
{"id":"recraft","tool":"Recraft","kind":"image","n":30,"unit":"generations","span":"day","note":"genNRecraft","url":"https://www.recraft.ai/features/image-converter"},
{"id":"ideogram","tool":"Ideogram","kind":"image","n":30,"unit":"credits","span":"week","note":"genNIdeo","url":"https://docs.ideogram.ai/plans-and-billing/available-plans"},
{"id":"flow","tool":"Google Flow (Veo)","kind":"video","n":50,"unit":"credits","span":"day","note":"genNFlow","url":"https://support.google.com/flow/answer/16526234"},
{"id":"pixverse","tool":"PixVerse","kind":"video","n":30,"unit":"credits","span":"day","note":"genNPix","url":"https://app.pixverse.ai/subscribe"},
{"id":"dreamina","tool":"Dreamina","kind":"video","n":120,"unit":"credits","span":"day","note":"genNDream","url":"https://dreamina.capcut.com/ai-video/free-image-to-video-generator-credits-faq"},
{"id":"runway","tool":"Runway","kind":"video","n":125,"unit":"credits","span":"once","note":"genNRunway","url":"https://help.runwayml.com/hc/en-us/articles/50404627334547-Free-plan-details"},
{"id":"ltx","tool":"LTX Studio","kind":"video","n":800,"unit":"credits","span":"once","note":"genNLtx","url":"https://support.ltx.studio/hc/en-us/articles/32039381455122-Understanding-the-free-plan"}
];
/* GEN-DATA-END */

/* ─────────────── GitHub card: trending this week + most-starred ever ───────────────
 * The card asks two questions and gets two sources, because no single one answers both:
 *   week  github.com/trending?since=weekly — the list GitHub itself publishes, read from
 *         its HTML (GitHub has no trending API; the search API's "new repos, most stars"
 *         answer is a different question and is only the fallback). The page's own order
 *         is not sorted by the figure it prints on each row, so the five are ranked by
 *         that printed figure — stars gained this week — and the card says so, instead of
 *         inheriting an order a reader cannot explain.
 *   all   api.github.com search, stars desc — the five most-starred repositories ever,
 *         read from GitHub's own index. Unauthenticated, no token to leak, cached at the
 *         edge for REPOS_TTL; when the search refuses (403 rate limit) the previous copy
 *         is served, and failing that the snapshot below, marked `stale` so the card never
 *         passes a stored figure off as live.
 * AUDIT: the fixture in _fixture_trending.html is six real rows of the page as it stands
 * (2026-10-13); the harness parses it and requires the same five names the live page gives.
 */
const REPOS_TTL = 6 * 3600;
const REPOS_CACHE_KEY = "https://repos-cache.internal/v1";
const REPOS_N = 5;
const TREND_URL = "https://github.com/trending?since=weekly";
const TREND_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
/* Verified live on 2026-10-13 (api.github.com search, stars desc). Used only when the
 * search is rate-limited and no cached copy exists; the card prints the date when it is. */
const REPOS_SNAPSHOT_DATE = "2026-10-13";
const REPOS_SNAPSHOT = [
  { name: "codecrafters-io/build-your-own-x", stars: 552875, lang: "Markdown", desc: "Master programming by recreating your favorite technologies from scratch.", url: "https://github.com/codecrafters-io/build-your-own-x" },
  { name: "sindresorhus/awesome", stars: 518280, lang: "", desc: "Awesome lists about all kinds of interesting topics.", url: "https://github.com/sindresorhus/awesome" },
  { name: "public-apis/public-apis", stars: 488096, lang: "Python", desc: "A collective list of free APIs", url: "https://github.com/public-apis/public-apis" },
  { name: "freeCodeCamp/freeCodeCamp", stars: 456960, lang: "TypeScript", desc: "freeCodeCamp.org's open-source codebase and curriculum. Learn math, programming, and computer science for free.", url: "https://github.com/freeCodeCamp/freeCodeCamp" },
  { name: "EbookFoundation/free-programming-books", stars: 398898, lang: "Python", desc: "Freely available programming books", url: "https://github.com/EbookFoundation/free-programming-books" }
];
/* The trending page's markup: one <article class="Box-row"> per repo, the repo link in the
 * heading, the language in a microdata span, the total beside the stargazers link and the
 * week's gain in the footer span. Narrow regexes rather than a DOM; a row without a name
 * and a gain is dropped, so a layout change costs a row instead of printing a wrong number. */
function ghNum(s) { return Number(String(s == null ? "" : s).replace(/[^0-9.]/g, "")) || 0; }
function parseTrending(html) {
  const out = [], seen = {};
  const re = /<article class="Box-row">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const a = m[1];
    const nm = /href="\/([\w.-]+\/[\w.-]+)"[^>]*class="Link"/.exec(a);
    const wk = /([\d,]+)\s+stars? this week/.exec(a);
    /* The anchor's own text is the total, but GitHub puts a star <svg> before it, so the
     * count is read from inside this anchor only — from its href to its closing </a> — and
     * never from the forks anchor that follows, which would hand back the wrong number. */
    const tot = (function () {
      const seg = /href="\/[^"]+\/stargazers"([\s\S]*?)<\/a>/.exec(a);
      if (!seg) return null;
      const digits = seg[1].replace(/<[^>]*>/g, " ").match(/([\d,]{2,})/);
      return digits ? digits[1] : null;
    })();
    const lg = /itemprop="programmingLanguage">([^<]+)</.exec(a);
    const de = /<p class="[^"]*col-9[^"]*">([\s\S]*?)<\/p>/.exec(a);
    if (!nm || !wk) continue;
    const name = nm[1];
    if (seen[name]) continue;
    seen[name] = 1;
    const weekStars = ghNum(wk[1]);
    if (!weekStars) continue;
    out.push({
      name: name, url: "https://github.com/" + name, desc: de ? strip(de[1]) : "",
      lang: lg ? strip(lg[1]) : "", weekStars: weekStars, stars: ghNum(tot)
    });
  }
  out.sort((a, b) => b.weekStars - a.weekStars);
  return out;
}
/* The list GitHub publishes, ranked by the gain GitHub prints on each row. */
async function trendingWeek(n) {
  try {
    const r = await fetch(TREND_URL, {
      headers: { "User-Agent": TREND_UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) return { items: [], source: "trending", note: "github.com/trending HTTP " + r.status };
    const rows = parseTrending(await r.text()).slice(0, n);
    if (!rows.length) return { items: [], source: "trending", note: "github.com/trending returned no parseable rows" };
    return { items: rows, source: "trending", note: "" };
  } catch (e) { return { items: [], source: "trending", note: sanitize(e && e.message, "") }; }
}
/* Fallback only: repos created in the last seven days, most starred. Answers "which new
 * repos took off", not "what is trending", so the payload names the source it used. */
async function weekBySearch(n) {
  const d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const got = await ghSearch("created:%3E" + d, n);
  return { items: got.items, source: "search", note: got.note };
}
async function ghSearch(q, n) {
  try {
    const r = await fetch("https://api.github.com/search/repositories?q=" + q + "&sort=stars&order=desc&per_page=" + n, {
      headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) return { items: [], note: "api.github.com search HTTP " + r.status };
    const j = await r.json();
    const items = (j.items || []).map((x) => ({
      name: String(x.full_name || ""), url: String(x.html_url || ""),
      desc: String(x.description || "").slice(0, 300), lang: x.language || "", stars: ghNum(x.stargazers_count)
    })).filter((x) => x.name && x.url && x.stars > 0);
    items.sort((a, b) => b.stars - a.stars);
    return { items: items.slice(0, n), note: items.length ? "" : "api.github.com returned no repositories" };
  } catch (e) { return { items: [], note: sanitize(e && e.message, "") }; }
}
/* Both lists, with a last-good path for each: cache first, bundled snapshot second, and
 * the payload always says which source answered so the card can print it. */
async function reposPayload() {
  const [wk, al] = await Promise.all([trendingWeek(REPOS_N), ghSearch("stars:%3E1", REPOS_N)]);
  let week = wk, all = al, prev = null;
  if (!week.items.length || !all.items.length) prev = await cacheGet(REPOS_CACHE_KEY);
  let weekStale = false, allStale = false, staleDate = "";
  if (!week.items.length) {
    week = await weekBySearch(REPOS_N);
    if (!week.items.length && prev && (prev.week || []).length) {
      week = { items: prev.week, source: prev.weekSource === "search" ? "search" : "trending", note: prev.weekNote || "" };
      weekStale = true; staleDate = String(prev.fetchedAt || "").slice(0, 10);
    }
  }
  if (!all.items.length) {
    if (prev && (prev.all || []).length) {
      all = { items: prev.all, note: prev.allNote || "" };
      allStale = true; if (!staleDate) staleDate = String(prev.fetchedAt || "").slice(0, 10);
    } else {
      all = { items: REPOS_SNAPSHOT.slice(0, REPOS_N), note: "" };
      allStale = true; staleDate = REPOS_SNAPSHOT_DATE;
    }
  }
  const payload = {
    fetchedAt: new Date().toISOString(),
    week: week.items, weekSource: week.source, weekNote: week.note || "", weekStale: weekStale,
    all: all.items, allSource: allStale ? "snapshot" : "search", allNote: all.note || "",
    allStale: allStale, staleDate: staleDate
  };
  if (!payload.all.length) { payload.all = REPOS_SNAPSHOT.slice(0, REPOS_N); payload.allSource = "snapshot"; payload.allStale = true; payload.staleDate = REPOS_SNAPSHOT_DATE; }
  return payload;
}

/* ─────────────── provider registry ───────────────
 * mode "batch": one request returns every metal.
 * mode "one":   one request per metal; `call` may list fallback URLs to try.
 * `pick` returns USD per troy ounce, or null when that field is absent.
 */
const P = {
  "gold-api": {
    label: "Gold-API.com", needsKey: false, mode: "one",
    call: (m) => [{ url: "https://api.gold-api.com/price/" + m }],
    pick: (j) => num(j && (j.price != null ? j.price : j.rate))
  },
  fastforex: {
    /* FastForex only accepts a metal as the BASE currency (from=XAU), never as a
     * target, so the old "to=XAU" shape returned nothing usable. /metals/spot is
     * the dedicated route (Premium/trial plans); fetch-multi is the fallback. */
    label: "FastForex.io", needsKey: true, mode: "one",
    call: (m, k) => [
      { url: "https://api.fastforex.io/metals/spot?api_key=" + enc(k) + "&metal=" + m + "&currency=USD" },
      { url: "https://api.fastforex.io/fetch-multi?api_key=" + enc(k) + "&from=" + m + "&to=USD" }
    ],
    pick: (j) => {
      if (!j) return null;
      const quote = j.mid != null ? j.mid : (j.ask != null ? j.ask : j.bid);
      if (quote != null) return num(quote);
      const r = j.results && j.results.USD;
      return r == null ? null : num(r);   /* metals-as-base quotes are already USD per ounce */
    }
  },
  "metals.dev": {
    label: "Metals.dev", needsKey: true, mode: "batch",
    call: (k) => [{ url: "https://api.metals.dev/v1/latest?api_key=" + enc(k) + "&currency=USD&unit=toz" }],
    pick: (j, m) => {
      const M = j && j.metals;
      if (!M) return null;
      return num(M[MNAME[m]] != null ? M[MNAME[m]] : M[m]);
    }
  },
  metalpriceapi: {
    label: "MetalpriceAPI.com", needsKey: true, mode: "batch",
    call: (k) => [{ url: "https://api.metalpriceapi.com/v1/latest?api_key=" + enc(k) + "&base=USD&currencies=" + METALS.join(",") }],
    pick: (j, m) => usdPrice(j, m)
  },
  "metals-api": {
    label: "Metals-API (apilayer)", needsKey: true, mode: "batch",
    call: (k) => [{ url: "https://metals-api.com/api/latest?access_key=" + enc(k) + "&base=USD&symbols=" + METALS.join(",") }],
    pick: (j, m) => usdPrice(j, m)
  },
  "goldapi-io": {
    label: "GoldAPI.io", needsKey: true, mode: "one",
    call: (m, k) => [{ url: "https://www.goldapi.io/api/" + m + "/USD", headers: { "x-access-token": k } }],
    pick: (j) => num(j && j.price)
  },
  "goldapi-net": {
    label: "GoldAPI.net", needsKey: true, mode: "one",
    call: (m, k) => [{ url: "https://app.goldapi.net/price/" + m + "/USD?x-api-key=" + enc(k) }],
    pick: (j) => num(j && (j.price != null ? j.price : (j.data && j.data.price)))
  },
  twelvedata: {
    label: "Twelve Data", needsKey: true, mode: "one",
    call: (m, k) => [
      { url: "https://api.twelvedata.com/price?symbol=" + enc(m + "/USD") + "&apikey=" + enc(k) },
      { url: "https://api.twelvedata.com/time_series?symbol=" + enc(m + "/USD") + "&interval=1min&outputsize=1&apikey=" + enc(k) }
    ],
    pick: (j) => (j && j.values && j.values[0]) ? num(j.values[0].close) : num(j && j.price)
  },
  tradermade: {
    label: "TraderMade", needsKey: true, mode: "batch",
    call: (k) => [{ url: "https://marketdata.tradermade.com/api/v1/live?currency=" + METALS.map((m) => m + "USD").join(",") + "&api_key=" + enc(k) }],
    pick: (j, m) => {
      const q = j && j.quotes;
      if (!q || !q.length) return null;
      for (const x of q) {
        const base = String((x && (x.base_currency || x.base)) || "").toUpperCase();
        if (base === m) return num(x.mid != null ? x.mid : x.ask);
      }
      return null;
    }
  },
  alphavantage: {
    label: "Alpha Vantage", needsKey: true, mode: "one", metals: ["XAU", "XAG"],
    call: (m, k) => [
      { url: "https://www.alphavantage.co/query?function=GOLD_SILVER_SPOT&symbol=" + m + "&apikey=" + enc(k) },
      { url: "https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=" + m + "&to_currency=USD&apikey=" + enc(k) }
    ],
    pick: (j) => {
      if (!j) return null;
      if (j.price != null) return num(j.price);
      const r = j["Realtime Currency Exchange Rate"];
      return r ? num(r["5. Exchange Rate"]) : null;
    }
  },
  "api-ninjas": {
    label: "API Ninjas", needsKey: true, mode: "one", metals: ["XAU"],
    call: (m, k) => [{ url: "https://api.api-ninjas.com/v1/goldspot", headers: { "X-Api-Key": k } }],
    pick: (j) => num(j && (j.price != null ? j.price : (Array.isArray(j) && j[0] && j[0].price)))
  }
};
const PROVIDER_IDS = Object.keys(P);

function cors(origin, allowed) {
  const a = allowed || "*";
  const ok = a === "*" || a === origin;
  return {
    "Access-Control-Allow-Origin": ok ? (a === "*" ? "*" : origin) : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-Provider",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
const J = (obj, H, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, H) });

function jreq(u) { return new Request(u, { method: "GET" }); }
async function cacheGet(url) {
  try { const hit = await caches.default.match(jreq(url)); return hit ? await hit.json() : null; }
  catch (e) { return null; }
}
async function cachePut(url, obj, ttl) {
  try {
    await caches.default.put(jreq(url), new Response(JSON.stringify(obj), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + ttl }
    }));
  } catch (e) { /* cache is best-effort */ }
}

/* Edge cache for the JSON routes. `key` must be an absolute URL, and `skipRead`
 * lets a caller (a card's refresh button) ask for a fresh copy while still
 * refreshing the stored one. */
/* Best-effort cache write that can never escalate: a synchronous throw, a rejected promise
 * and a missing cache all end as a resolved promise, so the caller's response is unaffected
 * and a broken cache cannot send the request back for a second upstream fetch. */
function cacheWrite(cache, key, res) {
  let put;
  try { put = cache.put(jreq(key), res.clone()); } catch (e) { return Promise.resolve(); }
  return Promise.resolve(put).catch(() => {});
}
async function cachedJSON(key, ttlSec, fn, skipRead, ctx) {
  try {
    const cache = caches.default;
    if (!skipRead) {
      const hit = await cache.match(jreq(key));
      if (hit) return { res: hit, hit: true };
    }
    const fresh = await fn();
    const res = new Response(fresh.body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + ttlSec } });
    /* Storing the copy is housekeeping, not part of the answer: when the runtime can keep
     * this isolate alive after the response (ctx.waitUntil), the write is handed over and the
     * client gets its bytes now. With no such hook - a plain `node` run of this file, say -
     * the write is awaited instead, because nothing else would keep it alive. */
    const write = cacheWrite(cache, key, res);
    if (ctx && typeof ctx.waitUntil === "function") { try { ctx.waitUntil(write); } catch (e) { await write; } }
    else await write;
    return { res: res, hit: false };
  } catch (e) {
    const out = await fn();
    return { res: new Response(out.body, { headers: { "Content-Type": "application/json" } }), hit: false };
  }
}

/* ─────────────── fetch one provider ─────────────── */
async function hit(spec) {
  const r = await fetch(spec.url, {
    headers: Object.assign({ "User-Agent": UA }, spec.headers || {}),
    signal: AbortSignal.timeout(12000)
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) {}
  return { ok: r.ok, status: r.status, j, text };
}
function upstreamNote(got, key) {
  if (!got) return "network error";
  const body = got.j || {};
  const msg = body.error || body.message || body.msg || body.info || body["Error Message"] || "";
  return sanitize(msg ? msg : ("HTTP " + got.status) + " " + got.text.slice(0, 120), key);
}
async function tryProvider(prov, key) {
  const list = prov.metals || METALS;
  const rates = {};
  if (prov.mode === "batch") {
    let got = null, err = "";
    try { got = await hit(prov.call(key)[0]); } catch (e) { err = sanitize(e && e.message, key); }
    if (got) {
      for (const m of list) { const v = prov.pick(got.j, m); if (v != null) rates[m] = v; }
      if (!Object.keys(rates).length) err = upstreamNote(got, key);
    }
    return { rates, err };
  }
  const out = await Promise.all(list.map(async (m) => {
    let note = "";
    for (const spec of prov.call(m, key)) {
      try {
        const got = await hit(spec);
        const v = prov.pick(got.j, m);
        if (v != null) return { m, v };
        if (!note) note = upstreamNote(got, key);   /* keep why it failed, scrubbed */
      } catch (e) { if (!note) note = sanitize(e && e.message, key); }
    }
    return { m, v: null, note };
  }));
  for (const r of out) if (r.v != null) rates[r.m] = r.v;
  const reason = out.map((r) => r.note).filter(Boolean)[0];
  return { rates, err: Object.keys(rates).length ? "" : (reason || "no price field found in the provider response") };
}

/* Provider choice: BYOK header > Worker variable > sensible default.
 * A provider that needs a key is silently downgraded to the keyless one
 * when no key is available, so the widget always shows something. */
async function metalsPayload(env, headerProvider, headerKey, ctx) {
  const envKey = await readSecret(env.METALS_API_KEY);
  const byok = (headerKey || "").trim();
  const key0 = byok || envKey;
  const wanted = String(headerProvider || env.METALS_PROVIDER || "").trim().toLowerCase();
  let pid = P[wanted] ? wanted : (key0 ? PROVIDER_DEFAULT : PROVIDER_KEYLESS);
  if (P[pid].needsKey && !key0) pid = PROVIDER_KEYLESS;
  const ck = "https://metals-cache.internal/v3/" + pid;   /* bump to invalidate after a provider fix */
  const skipCache = !!byok;   /* a BYOK caller is testing their own key: never hand them a cached answer */
  if (!skipCache) {
    const hitCached = await cacheGet(ck);
    if (hitCached) return Object.assign({}, hitCached, { cached: true });
  }

  let prov = P[pid];
  let r = await tryProvider(prov, prov.needsKey ? key0 : "");
  let fallbackFrom = "", fallbackNote = "";
  if (!Object.keys(r.rates).length && pid !== PROVIDER_KEYLESS) {
    fallbackFrom = pid;
    fallbackNote = sanitize(r.err || "no usable response", key0);
    const r2 = await tryProvider(P[PROVIDER_KEYLESS], "");
    if (Object.keys(r2.rates).length) { prov = P[PROVIDER_KEYLESS]; pid = PROVIDER_KEYLESS; r = r2; }
  }
  const payload = {
    provider: pid,
    label: prov.label,
    source: byok ? "byok" : (envKey ? "worker" : "none"),
    rates: r.rates,
    missing: METALS.filter((m) => !(m in r.rates)),
    updated: new Date().toISOString()
  };
  if (fallbackFrom) { payload.fallbackFrom = fallbackFrom; if (fallbackNote) payload.fallbackNote = fallbackNote; }
  if (!Object.keys(r.rates).length) payload.note = r.err || "upstream error";
  else if (!skipCache) {
    /* same rule as cachedJSON: never hold the answer back for a best-effort cache write */
    const write = cachePut(ck, payload, TTL_METALS);
    if (ctx && typeof ctx.waitUntil === "function") { try { ctx.waitUntil(write); } catch (e) { await write; } }
    else await write;
  }
  return payload;
}

/* ─────────────── news feeds: RSS + Atom ───────────────
 * Titles and descriptions arrive either as plain text or wrapped in CDATA.
 * CDATA has to be unwrapped BEFORE tags are stripped: `<[^>]*>` matches
 * `<![CDATA[headline]]>` as one big "tag" and deleted the headline with it, so
 * every BBC and CoinDesk item lost its title and was filtered out — the Finance
 * card stayed empty although both of its feeds were healthy.
 * Atom entries (<entry>, <link href="…"/>) are handled too: The Verge publishes
 * Atom only, and the old <item>-only parser quietly returned nothing for it.
 */
function strip(s) {
  return String(s == null ? "" : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => entity(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => entity(parseInt(d, 10)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}
function entity(n) { try { return String.fromCodePoint(n); } catch (e) { return ""; } }
function field(block, name) {
  const m = new RegExp("<" + name + "[^>]*>([\\s\\S]*?)<\\/" + name + ">", "i").exec(block);
  return m ? m[1].trim() : "";
}
/* RSS: <link>url</link>. Atom: <link href="url"/>. Either may ride on <guid>. */
function linkOf(block) {
  let link = field(block, "link");
  if (!/^https?:/i.test(link)) { const g = field(block, "guid"); if (/^https?:/i.test(g)) link = g; }
  if (!/^https?:/i.test(link)) { const h = /<link[^>]*\shref=["']([^"']+)["']/i.exec(block); if (h) link = h[1]; }
  return strip(link);
}
function sourceOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return "RSS"; } }
function parseFeed(xml, n, source) {
  const items = [];
  const re = /<(item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < n) {
    const b = m[0];
    const title = strip(field(b, "title"));
    const link = linkOf(b);
    if (!title || !/^https?:/i.test(link)) continue;   /* one malformed item must not drop the feed */
    items.push({
      title: title,
      link: link,
      desc: strip(field(b, "description") || field(b, "summary") || field(b, "content")),
      time: strip(field(b, "pubDate") || field(b, "published") || field(b, "updated")),
      source: source
    });
  }
  return items;
}
async function fetchFeed(url, n) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5" },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return [];
    return parseFeed(await r.text(), n, sourceOf(url));
  } catch (e) { return []; }
}
/* Subrequests run in waves: Workers caps simultaneous open outbound connections at
 * six, and the registry holds ten feed URLs. */
async function inWaves(thunks, limit) {
  const out = [];
  for (let i = 0; i < thunks.length; i += limit) {
    out.push.apply(out, await Promise.all(thunks.slice(i, i + limit).map((t) => t())));
  }
  return out;
}
/* Round-robin across a card's feeds so no single publisher can fill it: the old
 * concatenate-then-slice hid feed #2 completely whenever feed #1 had enough items. */
function interleave(buckets, n) {
  const out = [], seen = {};
  for (let round = 0; round <= n && out.length < n; round++) {
    for (const bucket of buckets) {
      const it = bucket && bucket[round];
      if (!it || out.length >= n || seen[it.link]) continue;
      seen[it.link] = 1;
      out.push(it);
    }
  }
  return out;
}
/* Auto and Finance are still plain interleaved feed cards; AI is ranked by relevance.
 * Every card is built only from its own sources, so a dead source leaves the others
 * untouched. A totally failed card comes back as [] and the page falls back. */
async function newsPayload() {
  const plan = [];
  for (const cat of ["auto", "fin"]) RSS[cat].forEach((url, i) => plan.push({ cat: cat, i: i, url: url }));
  AI_SOURCES.forEach((src, i) => plan.push({ cat: "ai", i: i, src: src }));
  const got = await inWaves(plan.map((p) => () => (p.src ? fetchSource(p.src, NEWS_CARDS.ai) : fetchFeed(p.url, (NEWS_CARDS[p.cat] || 3) + 1))), NEWS_CONCURRENCY);
  const feeds = { auto: [], fin: [] }, aiPool = [];
  plan.forEach((p, k) => {
    const items = got[k] || [];
    if (p.cat === "ai") items.forEach((it) => { it.srcKey = p.i; aiPool.push(it); });
    else feeds[p.cat][p.i] = items;
  });
  return {
    fetchedAt: new Date().toISOString(),
    auto: interleave(feeds.auto, NEWS_CARDS.auto),
    ai: rankAI(aiPool, NEWS_CARDS.ai),
    fin: interleave(feeds.fin, NEWS_CARDS.fin)
  };
}

/* ─────────────── Due-date reminders (Web Push) ───────────────
 * The dashboard keeps its cards in the browser, and a browser that is closed cannot decide
 * anything — so the schedule lives here and a cron tick turns it into notifications:
 *   GET  /api/push/key        the VAPID public key the browser subscribes with
 *   POST /api/push/register   one record per device: subscription, local time, due cards
 *   POST /api/push/test       an immediate push, so the setup can be proven
 *   POST /api/push/off        forget this device
 * What is stored is only what a reminder needs: the endpoint, its two keys, the local time
 * and the titles of open cards that carry a due date. Nothing about the rest of the app.
 *
 * The crypto is RFC 8291 (aes128gcm) and RFC 8292 (VAPID) on WebCrypto alone: a fresh ECDH
 * key per message, HKDF-SHA256 with the "WebPush: info" mix-in, AES-128-GCM with a 0x02 last-
 * record delimiter, and an ES256 JWT signed with the account's VAPID key. The payload is
 * verified against http_ece (the decryptor web-push itself uses) in the repo's test harness.
 */
const enc8 = new TextEncoder();   /* the file already has `enc` for encodeURIComponent */
const PUSH_PREFIX = "p:";
const PUSH_MAX_ITEMS = 200;
const PUSH_TEXT_MAX = 120;
const PUSH_KEEP_DAYS = 120;

const b64u = (bytes) => {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
function unb64u(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/* HKDF-SHA256: extract is HMAC(key = salt, message = ikm) — getting that order backwards
 * still yields a plausible-looking key, and then every push service silently fails to
 * decrypt the payload. Expand is a single block (both callers ask for <= 32 bytes). */
async function hkdf(ikm, salt, info, len) {
  const k = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", k, ikm));
  const pk = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const t = new Uint8Array(await crypto.subtle.sign("HMAC", pk, new Uint8Array([...info, 1])));
  return t.slice(0, len);
}
async function encryptPush(text, p256dh, authSecret) {
  const uaPub = unb64u(p256dh), auth = unb64u(authSecret);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const info = new Uint8Array([...enc8.encode("WebPush: info"), 0, ...uaPub, ...asPub]);
  const ikm = await hkdf(ecdh, auth, info, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, new Uint8Array([...enc8.encode("Content-Encoding: aes128gcm"), 0]), 16);
  const nonce = await hkdf(ikm, salt, new Uint8Array([...enc8.encode("Content-Encoding: nonce"), 0]), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = new Uint8Array([...enc8.encode(text), 2]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, plain));
  const rec = new Uint8Array(16 + 4 + 1 + 65 + ct.length);
  rec.set(salt, 0);
  new DataView(rec.buffer).setUint32(16, 4096, false);
  rec[20] = 65;
  rec.set(asPub, 21);
  rec.set(ct, 86);
  return rec;
}
function vapidJwk(env) {
  const raw = env.VAPID_JWK;
  if (!raw) return null;
  if (typeof raw === "object" && typeof raw.get === "function") return null;  /* secrets store: not used here */
  try {
    const jwk = JSON.parse(typeof raw === "string" ? raw : "");
    return jwk && jwk.d && jwk.x && jwk.y ? jwk : null;
  } catch (e) { return null; }
}
function vapidPublic(jwk) { return b64u(new Uint8Array([4, ...unb64u(jwk.x), ...unb64u(jwk.y)])); }
async function vapidAuth(endpoint, env) {
  const jwk = vapidJwk(env);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc8.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc8.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:reminders@dashboard.local"
  })));
  const signed = head + "." + claims;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc8.encode(signed)));
  return "vapid t=" + signed + "." + b64u(sig) + ", k=" + vapidPublic(jwk);
}
async function sendPush(rec, payload, env) {
  const auth = await vapidAuth(rec.endpoint, env);
  if (!auth) return { ok: false, status: 503, error: "no vapid key" };
  const body = await encryptPush(JSON.stringify(payload), rec.keys.p256dh, rec.keys.auth);
  const res = await fetch(rec.endpoint, {
    method: "POST",
    headers: {
      TTL: "86400",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: auth,
      Urgency: payload.urgency || "normal"
    },
    body
  });
  return { ok: res.ok, status: res.status };
}
const dayUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
/* The record says when the user wants the digest in their own timezone, so the tick asks the
 * runtime what that clock reads rather than guessing an offset that shifts twice a year. */
function localParts(now, tz) {
  try {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(now));
    const g = (k) => { const p = f.find((x) => x.type === k); return p ? p.value : ""; };
    return { date: g("year") + "-" + g("month") + "-" + g("day"), min: (Number(g("hour")) % 24) * 60 + Number(g("minute")) };
  } catch (e) {
    const d = new Date(now);
    return { date: dayUTC(now), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
}
function minutesOf(at) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || "")); return m ? Math.min(1439, Number(m[1]) * 60 + Number(m[2])) : 8 * 60; }
function dueDigest(items, lang) {
  const ar = lang === "ar";
  const n = items.length;
  const title = n === 1
    ? (ar ? "بطاقة مستحقة اليوم" : "A card is due today")
    : (ar ? n + " بطاقات مستحقة اليوم" : n + " cards due today");
  const names = items.slice(0, 4).map((it) => it.text).join(" · ");
  const body = n > 4 ? names + (ar ? " +" + (n - 4) + " أخرى" : " +" + (n - 4) + " more") : names;
  return { title, body, tag: "pd-due", url: "/?p=3" };
}
async function pushStoreKey(endpoint) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc8.encode(endpoint)));
  return PUSH_PREFIX + [...d].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function validSub(sub) {
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys) return false;
  if (sub.endpoint.length > 2048) return false;
  try { if (new URL(sub.endpoint).protocol !== "https:") return false; } catch (e) { return false; }
  try {
    return unb64u(sub.keys.p256dh).length === 65 && unb64u(sub.keys.auth).length === 16;
  } catch (e) { return false; }
}
/* One digest per device per day. The tick runs every 15 minutes and fires on the first tick
 * at or after the chosen minute, so a late or missed tick still delivers; `lastSent` stops it
 * repeating, and a 404/410 from the push service means the subscription is gone for good. */
async function runPushDigests(env, now) {
  const out = { scanned: 0, sent: 0, pruned: 0, failed: 0 };
  if (!env.PUSH) return out;
  let cursor;
  do {
    const page = await env.PUSH.list({ prefix: PUSH_PREFIX, cursor, limit: 500 });
    for (const k of page.keys) {
      out.scanned++;
      const rec = await env.PUSH.get(k.name, "json");
      if (!rec || !rec.endpoint || !rec.keys) { await env.PUSH.delete(k.name); out.pruned++; continue; }
      if (now - (rec.updated || 0) > PUSH_KEEP_DAYS * 86400000) { await env.PUSH.delete(k.name); out.pruned++; continue; }
      const local = localParts(now, rec.tz);
      if (local.min < minutesOf(rec.at)) continue;
      if (rec.lastSent === local.date) continue;
      const due = (rec.items || []).filter((it) => it && it.due && it.due <= local.date);
      rec.updated = now;
      if (!due.length) { rec.lastSent = local.date; await env.PUSH.put(k.name, JSON.stringify(rec)); continue; }
      const res = await sendPush(rec, dueDigest(due, rec.lang), env);
      if (res.status === 404 || res.status === 410) { await env.PUSH.delete(k.name); out.pruned++; continue; }
      rec.lastStatus = res.status;
      if (res.ok) { rec.lastSent = local.date; rec.sentAt = now; rec.tries = 0; out.sent++; }
      else { rec.tries = (rec.tries || 0) + 1; if (rec.tries >= 6) rec.lastSent = local.date; out.failed++; }
      await env.PUSH.put(k.name, JSON.stringify(rec));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

const MAX_BODY = 65536;
async function readJson(request) {
  try {
    const txt = await request.text();
    if (txt.length > MAX_BODY) return { error: "body too large" };
    const json = JSON.parse(txt);
    return json && typeof json === "object" ? { json } : { error: "bad json" };
  } catch (e) { return { error: "bad json" }; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowed = (env.ALLOWED_ORIGIN || "*").trim();
    const H = cors(request.headers.get("Origin") || "", allowed);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
    const path = url.pathname;

    if (path === "/api/health") {
      const v = env.METALS_API_KEY;
      const kind = v == null ? "none" : (typeof v === "string" ? "env" : (typeof v.get === "function" ? "secrets-store" : "unknown"));
      const resolved = kind === "none" ? false : (await readSecret(v)) !== "";
      return J({
        ok: true,
        v: VERSION,
        hasMetalsKey: kind !== "none",
        keyKind: kind,
        keyResolved: resolved,
        defaultProvider: (env.METALS_PROVIDER || "").trim() || (kind === "none" ? PROVIDER_KEYLESS : PROVIDER_DEFAULT),
        providers: PROVIDER_IDS.map((id) => ({ id, label: P[id].label, needsKey: P[id].needsKey })),
        byok: "send X-Provider and X-Api-Key headers to /api/metals"
      }, H);
    }

    if (path === "/api/metals") {
      const payload = await metalsPayload(env, request.headers.get("X-Provider"), request.headers.get("X-Api-Key"), ctx);
      if (!Object.keys(payload.rates).length) return J(Object.assign({ error: "no rates" }, payload), H, 502);
      return J(payload, H);
    }

    /* Long history for the chart card. /api/metals/history stays as an alias so a page
     * older than this Worker keeps working. */
    if (path === "/api/history" || path === "/api/metals/history") {
      const kind = (path === "/api/metals/history" ? "metal" : (url.searchParams.get("kind") || "metal")).toLowerCase();
      const symbol = url.searchParams.get("symbol") || (kind === "fx" ? "EUR" : kind === "crypto" ? "btc" : "XAU");
      const base = url.searchParams.get("base") || "USD";
      const from = url.searchParams.get("from") || HIST_FROM;
      if (["metal", "fx", "crypto"].indexOf(kind) < 0) return J({ error: "unknown kind", kinds: ["metal", "fx", "crypto"] }, H, 400);
      if (kind === "metal" && !IMF_METALS[String(symbol).toUpperCase()]) return J({ error: "unknown metal", symbols: Object.keys(IMF_METALS) }, H, 400);
      const key = "https://history-cache.internal/v3/" + kind + "/" + symbol + "/" + base + "/" + from;
      try {
        const got = await cachedJSON(key, HIST_TTL, async () => {
          return { body: JSON.stringify(await historyPayload(kind, symbol, base, url.searchParams.get("cg"), from)) };
        }, url.searchParams.get("fresh") === "1", ctx);
        return new Response(got.res.body, {
          headers: Object.assign({
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-History-Cache": got.hit ? "hit" : "miss",
            "X-History-Version": VERSION
          }, H)
        });
      } catch (e) {
        return J({ error: sanitize(e && e.message ? e.message : "history fetch failed", ""), points: [] }, H, 502);
      }
    }

    /* Spot rates for the currencies card: any base against any targets, including the
     * currencies the ECB never publishes (LBP, SAR, EGP…), on the chart's own USD legs. */
    if (path === "/api/rates") {
      const base = url.searchParams.get("base") || "USD";
      const list = (url.searchParams.get("to") || YAHOO_FX.join(",")).split(",");
      const key = "https://rates-cache.internal/v1/" + base.toUpperCase() + "/" + list.join(",").toUpperCase();
      try {
        const got = await cachedJSON(key, RATES_TTL, async () => {
          return { body: JSON.stringify(await ratesPayload(base, list)) };
        }, url.searchParams.get("fresh") === "1", ctx);
        return new Response(got.res.body, {
          headers: Object.assign({
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Rates-Cache": got.hit ? "hit" : "miss",
            "X-Rates-Version": VERSION
          }, H)
        });
      } catch (e) {
        return J({ error: sanitize(e && e.message ? e.message : "rates fetch failed", ""), rates: {} }, H, 502);
      }
    }

    /* The GitHub card: trending this week plus the most-starred repositories ever. */
    if (path === "/api/repos") {
      const { res, hit } = await cachedJSON(REPOS_CACHE_KEY, REPOS_TTL, async () => {
        return { body: JSON.stringify(await reposPayload()) };
      }, url.searchParams.get("fresh") === "1", ctx);
      return new Response(res.body, {
        headers: Object.assign({
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Repos-Cache": hit ? "hit" : "miss",
          "X-Repos-Version": VERSION
        }, H)
      });
    }

    /* The image & video free-allowance table: a static, dated dataset, so it is built per
     * request rather than cached — the card only calls it once an hour anyway. */
    if (path === "/api/generators") {
      return J({ checked: GEN_CHECKED, tools: GEN_TOOLS }, H);
    }

    if (path === "/api/news") {
      /* ?fresh=1 skips the edge read but still refreshes the entry, so a card's
       * refresh button can ask for a genuinely fresh copy. */
      const { res, hit } = await cachedJSON(NEWS_CACHE_KEY, NEWS_TTL, async () => {
        return { body: JSON.stringify(await newsPayload()) };
      }, url.searchParams.get("fresh") === "1", ctx);
      return new Response(res.body, {
        headers: Object.assign({
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-News-Cache": hit ? "hit" : "miss",
          "X-News-Version": VERSION
        }, H)
      });
    }

    /* ── reminders ──────────────────────────────────────────────────────────────
     * A write from a foreign page is refused outright rather than merely hidden by CORS:
     * the browser would block that page from reading the answer, but the push would still
     * be registered. */
    if (path.startsWith("/api/push")) {
      const origin = request.headers.get("Origin") || "";
      if (request.method === "POST" && allowed !== "*" && origin !== allowed) {
        return J({ error: "origin not allowed" }, H, 403);
      }
      const jwk = vapidJwk(env);
      if (path === "/api/push/key") {
        if (!jwk) return J({ error: "reminders are not configured on this Worker" }, H, 503);
        return J({ ok: true, key: vapidPublic(jwk), subject: env.VAPID_SUBJECT || "", version: VERSION }, H);
      }
      if (path === "/api/push/register" && request.method === "POST") {
        if (!jwk) return J({ error: "reminders are not configured on this Worker" }, H, 503);
        if (!env.PUSH) return J({ error: "this Worker has no PUSH store bound" }, H, 503);
        const { json, error } = await readJson(request);
        if (error) return J({ error }, H, 400);
        const sub = json.sub;
        if (!validSub(sub)) return J({ error: "invalid subscription" }, H, 400);
        const items = (Array.isArray(json.items) ? json.items : []).slice(0, PUSH_MAX_ITEMS).map((it) => ({
          id: String(it && it.id != null ? it.id : "").slice(0, 40),
          text: String((it && it.text) || "").slice(0, PUSH_TEXT_MAX),
          due: /^\d{4}-\d{2}-\d{2}$/.test(it && it.due) ? it.due : ""
        })).filter((it) => it.due);
        const at = /^\d{1,2}:\d{2}$/.test(json.at) ? json.at : "08:00";
        const key = await pushStoreKey(sub.endpoint);
        const prev = (await env.PUSH.get(key, "json")) || {};
        const rec = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          tz: typeof json.tz === "string" ? json.tz.slice(0, 64) : "UTC",
          at,
          lang: json.lang === "ar" ? "ar" : "en",
          items,
          updated: Date.now(),
          created: prev.created || Date.now(),
          lastSent: prev.lastSent || "",
          lastStatus: prev.lastStatus || 0
        };
        await env.PUSH.put(key, JSON.stringify(rec));
        return J({ ok: true, at: rec.at, tz: rec.tz, items: items.length, version: VERSION }, H);
      }
      if (path === "/api/push/test" && request.method === "POST") {
        const { json, error } = await readJson(request);
        if (error) return J({ error }, H, 400);
        if (!validSub(json.sub)) return J({ error: "invalid subscription" }, H, 400);
        const ar = json.lang === "ar";
        const payload = {
          title: ar ? "تذكير تجريبي" : "Test reminder",
          body: ar ? "التذكيرات تعمل على هذا الجهاز." : "Reminders work on this device.",
          tag: "pd-test",
          url: "/?p=3"
        };
        const res = await sendPush(json.sub, payload, env);
        if (res.status === 503) return J({ error: "reminders are not configured on this Worker" }, H, 503);
        if (res.status === 404 || res.status === 410) return J({ error: "this device is no longer subscribed", status: res.status }, H, 410);
        return J({ ok: res.ok, status: res.status }, H, res.ok ? 200 : 502);
      }
      if (path === "/api/push/off" && request.method === "POST") {
        const { json, error } = await readJson(request);
        if (error) return J({ error }, H, 400);
        if (!json || typeof json.endpoint !== "string") return J({ error: "endpoint required" }, H, 400);
        if (!env.PUSH) return J({ ok: true, removed: 0 }, H);
        await env.PUSH.delete(await pushStoreKey(json.endpoint));
        return J({ ok: true, removed: 1 }, H);
      }
      return J({ error: "unknown push route" }, H, 404);
    }

    return J({
      ok: true,
      v: VERSION,
      routes: ["/api/health", "/api/metals", "/api/metals/history", "/api/history", "/api/rates", "/api/news", "/api/repos", "/api/generators", "/api/push/key", "/api/push/register", "/api/push/test", "/api/push/off"],
      providers: PROVIDER_IDS
    }, H);
  },
  /* The cron tick. Wrangler declares the schedule; the handler is deliberately dull - scan,
   * decide, send, record - so a failure is one device's problem and never the run's. */
  async scheduled(event, env) {
    const out = await runPushDigests(env, Date.now());
    console.log("push digest " + JSON.stringify(out) + " cron=" + (event && event.cron ? event.cron : ""));
    /* Returned rather than discarded: the runtime ignores it, and the test harness reads it. */
    return out;
  }
};
