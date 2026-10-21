#!/usr/bin/env node
/* The docs' numbers, read out of this tree (and out of one recorded run) instead of typed.

     node _guide.mjs                 stamp every page that states a number from this tree
     node _guide.mjs --check         exit 1 if any page and the tree disagree (CI-ready)
     node _guide.mjs --record        run both suites, write docs/last-run.json, then stamp
     node _guide.mjs --record --harness=N
                                     the harness has just run and printed N (the deploy gate
                                     does this, so a release measures it once, not twice)
     node _guide.mjs --help

   Two kinds of number go stale in a hand-written page, and they need different answers.

   The first kind is in the files: the page's version, the Worker's version, the build tag the
   Worker has to be deployed with, the hash of the bundle that gets published, how many files it
   carries, and how many steps a guide has. Those are read from the file that owns each one and
   written between markers:

     bundle <span data-live="bundle">be2bbab4e756</span>

   The second kind is only knowable by running something: how many checks the harness and the
   browser contract print. No file holds that answer, so `--record` runs both suites, refuses to
   write unless they pass, and stores what they printed in docs/last-run.json - one committed
   record with the date it was taken. Every page then states those totals *as of that date*, so
   an old number is visibly a recorded number rather than a claim about today.

   Nothing here decides whether a number is *right*: the files and the run do. This only stops a
   page from claiming one they no longer support. `node _deploy.mjs` runs --check as part of the
   gate and refuses a tree whose pages name a build the files have moved past; --sync restamps
   them along with the bundle, which is what keeps a release's pages and bundle together.
*/
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const ROOT = dirname(HERE);

const PAGE = "index.html";
const BUNDLE = "deploy/index.html";
const DEPLOY = "deploy";
const WORKER = "worker.js";
const RECORD = "docs/last-run.json";
/* the two files a Pages deploy uploads but the browser never fetches as a page */
const NOT_SERVED = new Set(["_headers", "_redirects"]);

/* Every page that states a number from this tree, and the values it is required to state. The
   required list is what stops a value from quietly leaving a page: drop its marker and the run
   fails instead of freezing the last number it happened to show. */
export const DOCS = [
  {
    path: "docs/DEPLOY_AND_VERIFY.html",
    keys: ["page", "worker", "bundle", "tag", "files", "steps", "steps_word", "checks", "recorded"],
  },
  {
    path: "docs/PUBLISHING.html",
    keys: ["page", "steps", "steps_word", "checks_browser", "recorded"],
  },
];

const HELP = `The docs' numbers, read from this tree and from the last recorded run.

  node _guide.mjs           stamp ${DOCS.map((d) => d.path).join(", ")}
  node _guide.mjs --check   exit 1 if a page and the tree disagree (CI-ready)
  node _guide.mjs --record  run node _check.mjs and python _ui.test.py, write ${RECORD},
                            then stamp the pages with what they printed
  node _guide.mjs --record --harness=N
                            take the harness total from a run that has just passed (the deploy
                            gate's own), measure only the browser contract, then write and stamp

Exits 0 when the pages are current (or were just restamped); 1 when --check found a stale value
or a suite failed during --record; 2 when a marker, a value or the record itself is unusable,
since writing a number into those cannot repair them.`;

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const brief = (h) => (h ? h.slice(0, 12) : "missing");
const read = (rel) => {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p) : null;
};
const text = (rel) => String(read(rel) || "");

/* every file that is actually published - the same walk _smoke.mjs makes, so "8 files" here and
   "all 8 files match" in its output are the same eight */
function bundleFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) bundleFiles(full, out);
    else out.push(relative(join(ROOT, DEPLOY), full).split("\\").join("/"));
  }
  return out;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve"];
const stepsIn = (html) => (html.match(/<li class="step"[ >]/g) || []).length;
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const localDate = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
};

/* ── the record: the one kind of number no file can hold ───────────────────────
   A check total exists only while a suite is running. It is captured deliberately, by
   --record, and only when both suites passed - a red run is not evidence of a count. The date
   travels with the numbers so a page can say when they were taken. */
export class RecordError extends Error {}

/* answers what the record *says*, or throws saying what is wrong with it: a record that lost a
   field is worse than no record, because the pages would quote a number that was never printed */
export function parseRecord(raw) {
  let rec;
  try {
    rec = JSON.parse(String(raw));
  } catch (e) {
    throw new RecordError(RECORD + " is not JSON: " + String(e.message || e));
  }
  const bad = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.recorded || ""))) bad.push("recorded (YYYY-MM-DD)");
  for (const k of ["harness", "browser"]) {
    if (!Number.isInteger(rec[k]) || rec[k] <= 0) bad.push(k + " (a positive whole number)");
  }
  if (bad.length) throw new RecordError(RECORD + " is missing " + bad.join(", "));
  return { recorded: rec.recorded, harness: rec.harness, browser: rec.browser };
}

export function readRecord() {
  const raw = read(RECORD);
  if (!raw) throw new RecordError("no " + RECORD + " yet - run `node _guide.mjs --record` to measure it");
  return parseRecord(raw);
}

/* ── what the tree says ────────────────────────────────────────────────────────
   One value per number the pages state, each read from the file that owns it. `fileValues` is
   the half that needs no record, so a test can run before any run has been recorded:

     page        CONFIG.VERSION in index.html, falling back to the <title> (the tag check and the
                 smoke test both end up here; the harness asserts the two agree)
     worker      the VERSION constant in worker.js
     bundle      sha256 of deploy/index.html, abbreviated the way every other script prints it
     tag         sha256 of worker.js, first 16 characters - `node _smoke.mjs --worker-tag`
     files       how many files deploy/ publishes, `_headers` and `_redirects` excluded
     steps       how many <li class="step"> that page has, and the same count as a word (a guide
                 whose heading says "Eight steps" and lists nine is wrong twice)
     checks      the harness total from the record, `checks_browser` likewise */
export function fileValues(doc = DOCS[0].path) {
  const pageHtml = text(PAGE);
  const workerSrc = text(WORKER);
  const bundleBytes = read(BUNDLE);
  /* a step may carry an id of its own, and one of these pages does: counting only the bare
     <li class="step"> would report zero steps for a guide that plainly has seven */
  const steps = stepsIn(text(doc));
  return {
    page: (pageHtml.match(/\bVERSION:\s*"([^"]+)"/) || [])[1]
      || (pageHtml.match(/<title>\s*Home Dashboard v([0-9.]+)\s*<\/title>/i) || [])[1]
      || "unknown",
    worker: (workerSrc.match(/const VERSION = "([^"]+)"/) || [])[1] || "unknown",
    bundle: bundleBytes ? brief(sha(bundleBytes)) : "missing",
    tag: workerSrc ? sha(Buffer.from(workerSrc, "utf8")).slice(0, 16) : "missing",
    files: existsSync(join(ROOT, DEPLOY)) ? bundleFiles(join(ROOT, DEPLOY)).filter((f) => !NOT_SERVED.has(f)).length : 0,
    steps,
    steps_word: capital(WORDS[steps] || String(steps)),
  };
}

export function guideValues(doc = DOCS[0].path) {
  const rec = readRecord();
  return Object.assign(fileValues(doc), {
    checks: rec.harness,
    checks_browser: rec.browser,
    recorded: rec.recorded,
  });
}

/* The marker is a bare span whose entire content is the value, so the rewrite can never land
   inside a link, an attribute or a <code> that holds more than the number. A marker that is
   anything else is an error rather than a silent miss: the failure mode this file exists to
   prevent is a number that quietly stops being written. */
const MARK = /<span data-live="([a-z][a-z0-9_]*)">([^<]*)<\/span>/g;

export class MarkerError extends Error {}

export function stamp(html, values, keys = Object.keys(values)) {
  const loose = [...html.matchAll(/data-live="([^"]*)"/g)];
  const strict = [...html.matchAll(MARK)];
  if (loose.length !== strict.length) {
    const good = new Set(strict.map((m) => m[0]));
    const bad = [...html.matchAll(/<span\b[^>]*data-live="[^"]*"[^>]*>[\s\S]*?<\/span>/g)]
      .map((m) => m[0]).filter((s) => !good.has(s))
      .map((s) => (s.length > 90 ? s.slice(0, 90) + "…" : s));
    throw new MarkerError("a data-live marker must be a bare <span data-live=\"key\">value</span>"
      + (bad.length ? " - found " + bad.join(" · ") : " - one sits outside a span")
      + " (no attributes, no nested markup, nothing but the number)");
  }
  const unknown = [...new Set(strict.map((m) => m[1]).filter((k) => !(k in values)))];
  if (unknown.length) {
    throw new MarkerError("the page marks a value nothing here reads: " + unknown.join(", ")
      + " (known: " + Object.keys(values).join(", ") + ")");
  }
  const shown = [...new Set(strict.map((m) => m[1]))];
  const dropped = keys.filter((k) => !shown.includes(k));
  if (dropped.length) {
    throw new MarkerError("no data-live marker for " + dropped.join(", ")
      + " - a value the page no longer states is a number that can go stale unnoticed");
  }
  const changed = [];
  const out = html.replace(MARK, (whole, key, was) => {
    const value = String(values[key]);
    if (/[<>&]/.test(value)) throw new MarkerError("the " + key + " value is not plain text: " + value);
    if (was !== value) changed.push({ key, from: was, to: value });
    return "<span data-live=\"" + key + "\">" + value + "</span>";
  });
  return { html: out, changed };
}

/* ── the recorded run ─────────────────────────────────────────────────────────
   Both suites are executed here, not sampled: the harness prints one PASS line per check and
   the browser contract prints "n/n checks passed", and those two numbers are what the pages
   quote. A suite that fails records nothing - a red run says the count is not evidence. */
function findPython() {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["-c", "import sys;print(sys.version_info[0])"], { encoding: "utf8" });
    if (r.status === 0 && String(r.stdout || "").trim() === "3") return cmd;
  }
  return null;
}
const tail = (r) => String(r.stderr || r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "no output";

function measureHarness() {
  console.log("record: node _check.mjs (the harness - the Worker and the page, against the real sources)");
  const h = spawnSync(process.execPath, ["_check.mjs"], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20 });
  const out = String(h.stdout || "");
  const checks = (out.match(/^PASS/mg) || []).length;
  if (h.status !== 0 || !/ALL CHECKS PASSED/.test(out) || !checks) {
    console.log("  " + tail(h));
    throw new RecordError("the harness did not pass (" + checks + " PASS line(s)), so nothing was recorded");
  }
  console.log("  " + checks + " checks, all passing");
  return checks;
}

/* The browser contract is measured here and nowhere else: it needs Chromium, it takes minutes,
   and its total is the one number no other command can supply. */
export function runBrowser() {
  const py = findPython();
  if (!py) throw new RecordError("python 3 is needed for the browser contract, and neither python3 nor python runs it");
  console.log("record: " + py + " _ui.test.py (the browser contract, in Chromium - a few minutes)");
  const b = spawnSync(py, ["_ui.test.py"], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20 });
  const out = String(b.stdout || "") + String(b.stderr || "");
  const m = out.match(/(\d+)\/(\d+) checks passed/);
  const checks = m ? Number(m[2]) : 0;
  if (b.status !== 0 || !m || Number(m[1]) !== checks || !checks) {
    console.log("  " + tail(b));
    throw new RecordError("the browser contract did not pass, so nothing was recorded");
  }
  console.log("  " + checks + " checks, all passing");
  return checks;
}

/* the record is only ever these two totals and the day they were taken, so a caller can hand in
   totals it has already measured without the file format leaking into that caller */
export function recordContent(harness, browser) {
  for (const [name, n] of [["harness", harness], ["browser", browser]]) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RecordError("a recorded " + name + " total must be a positive whole number, not " + n);
    }
  }
  return JSON.stringify({ recorded: localDate(), harness, browser }, null, 2) + "\n";
}

export function writeRecord(harness, browser) {
  const body = recordContent(harness, browser);
  writeFileSync(join(ROOT, RECORD), body);
  const rec = parseRecord(body);
  console.log("PASS  record: wrote " + RECORD + "  -> " + rec.harness + " harness checks · "
    + rec.browser + " browser checks · " + rec.recorded);
  return rec;
}

/* `given` is the harness total a caller has just measured itself - the deploy gate, so that a
   release measures the harness once rather than twice and the number recorded is the number the
   gate's verdict was based on */
function record(given) {
  return writeRecord(given || measureHarness(), runBrowser());
}

/* ── stamping the pages ──────────────────────────────────────────────────────── */
const describe = (v) => "page v" + v.page + " · worker " + v.worker + " · bundle " + v.bundle
  + " · build " + v.tag + " · " + v.files + " files · " + v.checks + " harness checks · "
  + v.checks_browser + " browser checks · recorded " + v.recorded;

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const CHECK = argv.includes("--check");
  const RECORD_NOW = argv.includes("--record");
  const harnessArg = argv.find((a) => a.startsWith("--harness="));
  const unknown = argv.filter((a) => a !== "--check" && a !== "--record" && !a.startsWith("--harness="));
  if (unknown.length) {
    console.error("_guide.mjs: unknown flag(s) " + unknown.join(" ") + "\n\n" + HELP);
    return 2;
  }
  if (RECORD_NOW && CHECK) {
    console.error("_guide.mjs: --record runs the suites and writes; --check only reads. Use one.");
    return 2;
  }
  if (harnessArg && !RECORD_NOW) {
    console.error("_guide.mjs: --harness= only means something with --record (it says a harness just ran).");
    return 2;
  }
  let given = 0;
  if (harnessArg) {
    given = Number(harnessArg.slice("--harness=".length));
    if (!Number.isInteger(given) || given <= 0) {
      console.error("_guide.mjs: --harness= needs the number of PASS lines a green run printed, not \""
        + harnessArg.slice("--harness=".length) + "\"");
      return 2;
    }
  }

  try {
    if (RECORD_NOW) record(given);
    return CHECK ? verify() : stampAll();
  } catch (e) {
    if (!(e instanceof MarkerError) && !(e instanceof RecordError)) throw e;
    console.error("_guide.mjs: " + e.message);
    return 2;
  }
}

function pages() {
  return DOCS.map((d) => {
    const html = text(d.path);
    if (!html) throw new MarkerError(d.path + " not found next to this file");
    return { doc: d, html, values: guideValues(d.path) };
  });
}

function verify() {
  const stale = pages().map((p) => {
    const { changed } = stamp(p.html, p.values, p.doc.keys);
    return { path: p.doc.path, changed };
  }).filter((p) => p.changed.length);
  if (!stale.length) {
    const v = guideValues(DOCS[0].path);
    console.log("PASS  docs: " + DOCS.length + " pages state this tree's numbers  -> " + describe(v));
    return 0;
  }
  console.log("FAIL  docs: " + (stale.length === 1 ? "1 page states numbers" : stale.length + " pages state numbers")
    + " this tree no longer has  -> "
    + stale.map((p) => p.path.replace(/^docs\//, "") + ": "
      + p.changed.map((c) => c.key + " \"" + c.from + "\" → \"" + c.to + "\"").join(", ")).join(" · "));
  console.log("      run `node _guide.mjs` to restamp (--sync does it in the gate)");
  return 1;
}

function stampAll() {
  const touched = [];
  for (const p of pages()) {
    const { html, changed } = stamp(p.html, p.values, p.doc.keys);
    if (!changed.length) continue;
    writeFileSync(join(ROOT, p.doc.path), html);
    touched.push({ path: p.doc.path, changed });
  }
  if (!touched.length) {
    console.log("PASS  docs: " + DOCS.length + " pages already state this tree's numbers  -> nothing written");
    return 0;
  }
  console.log("PASS  docs: stamped " + touched.length + " page" + (touched.length === 1 ? "" : "s") + "  -> "
    + touched.map((t) => t.path.replace(/^docs\//, "") + ": "
      + t.changed.map((c) => c.key + " \"" + c.from + "\" → \"" + c.to + "\"").join(", ")).join(" · "));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(HERE)) {
  process.exit(main(process.argv.slice(2)));
}
