/* Drives the stamper behind the docs pages' numbers, not a copy of it.
 *
 * docs/DEPLOY_AND_VERIFY.html and docs/PUBLISHING.html state the page version, the Worker
 * version, the build tag, the bundle hash, the file count, their own step counts and the check
 * totals of the last recorded run. Left typed they were stale within one release, so _guide.mjs
 * reads them from the files (and from docs/last-run.json) and writes them between `data-live`
 * markers. What has to be proven here is the mechanism, not today's output:
 *
 *   - every file-backed value is read from the file that owns it, and the build tag is the same
 *     string `node _smoke.mjs --worker-tag` prints - a page naming another tag would send the
 *     reader after a Worker that cannot exist;
 *   - the totals the pages quote are the ones the record holds, and the record holds whole
 *     numbers with a date, because a count is only evidence if a run produced it;
 *   - a stale value is replaced and its neighbours are not, and a second pass writes nothing;
 *   - a marker that no longer matches a value, or a value that left a page, is an error instead
 *     of a number that quietly stops being written.
 *
 * The record cases work with the record present or absent: `--record` runs this file inside the
 * harness *before* it writes its own record, so a test that demanded one could never produce the
 * first. Absent, the assertion becomes that the absence is reported rather than answered with a
 * number nobody measured - and the gate's `--check` refuses a page with no record at all.
 *
 * It deliberately does not assert that the pages are currently stamped: during a release they
 * lag the bump until the gate's --sync restamps them, and this test runs inside that gate.
 *
 * No dependencies. `_guide.mjs` only runs its CLI when invoked directly, so importing it here
 * touches nothing on disk.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCS, fileValues, guideValues, parseRecord, readRecord, recordContent, stamp, MarkerError, RecordError,
} from "./_guide.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

let n = 0, fails = 0;
const ok = (name, cond, detail) => {
  n++;
  if (!cond) fails++;
  console.log((cond ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "  -> " + detail));
};
function throws(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

const GUIDE = DOCS[0];
const PUB = DOCS[1];
const v = fileValues(GUIDE.path);
const pageHtml = read("index.html");
const workerSrc = read("worker.js");
const rec = (() => { try { return readRecord(); } catch { return null; } })();
/* a fixture needs every key a page owns; the recorded three are synthetic unless a real record
   exists, since the fixture is about the rewrite, not about the numbers */
const fixtureValues = (doc) => Object.assign(fileValues(doc.path), {
  checks: rec ? rec.harness : 1,
  checks_browser: rec ? rec.browser : 1,
  recorded: rec ? rec.recorded : "2026-01-01",
});

/* ── each value is read from the file that owns it ───────────────────────────── */
{
  const configured = (pageHtml.match(/\bVERSION:\s*"([^"]+)"/) || [])[1];
  ok("values: the page version is CONFIG.VERSION, not the version typed into a page",
    v.page === configured && !!configured, "page v" + v.page);

  const worker = (workerSrc.match(/const VERSION = "([^"]+)"/) || [])[1];
  ok("values: the Worker version is the constant in worker.js", v.worker === worker, "worker " + v.worker);

  const tagRun = spawnSync(process.execPath, ["_smoke.mjs", "--worker-tag"], { cwd: ROOT, encoding: "utf8" });
  ok("values: the build tag is the tag you would deploy with",
    tagRun.status === 0 && v.tag === tagRun.stdout.trim(),
    v.tag + (tagRun.status === 0 && v.tag === tagRun.stdout.trim() ? "" : " vs " + String(tagRun.stdout).trim()));

  ok("values: the bundle hash is sha256(deploy/index.html), abbreviated like the gate prints it",
    v.bundle === sha(readFileSync(join(ROOT, "deploy/index.html"))).slice(0, 12), v.bundle);

  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else out.push(relative(join(ROOT, "deploy"), full));
    }
    return out;
  };
  const served = walk(join(ROOT, "deploy")).filter((f) => f !== "_headers" && f !== "_redirects");
  ok("values: the file count is the number of files the deploy actually publishes",
    v.files === served.length, v.files + " of " + served.length + " served");

  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve"];
  const stepsOf = (p) => (read(p).match(/<li class="step"[ >]/g) || []).length;
  const word = (k) => words[k] || String(k);
  const per = [GUIDE, PUB].map((d) => {
    const f = fileValues(d.path);
    return { path: d.path, steps: f.steps, word: f.steps_word, real: stepsOf(d.path) };
  });
  ok("values: each page's step count and heading word come from that page's own markup",
    per.every((p) => p.steps === p.real
      && p.word === word(p.real).charAt(0).toUpperCase() + word(p.real).slice(1)),
    per.map((p) => p.path.replace(/^docs\//, "") + " " + p.steps + " / " + p.word).join(" · "));
}

/* ── the totals come from the record, and the record is a real measurement ───── */
{
  if (rec) {
    const quote = guideValues(GUIDE.path);
    ok("record: the pages quote the totals the recorded run printed",
      quote.checks === rec.harness && guideValues(PUB.path).checks_browser === rec.browser
      && quote.recorded === rec.recorded,
      rec.harness + " harness · " + rec.browser + " browser · " + rec.recorded);
    ok("record: both totals are whole numbers - a count is only evidence if a run produced it",
      Number.isInteger(rec.harness) && rec.harness > 0 && Number.isInteger(rec.browser) && rec.browser > 0,
      rec.harness + " and " + rec.browser);
  } else {
    const missing = throws(() => guideValues(GUIDE.path));
    ok("record: absent, it is reported - never answered with a total nobody measured",
      missing instanceof RecordError, String(missing && missing.message));
  }
  const bad = [
    ["not JSON at all", "{ nope"],
    ["no date", '{"harness": 1, "browser": 1}'],
    ["a zero total", '{"recorded": "2026-10-22", "harness": 0, "browser": 1}'],
    ["a fractional total", '{"recorded": "2026-10-22", "harness": 1.5, "browser": 1}'],
    ["no browser total", '{"recorded": "2026-10-22", "harness": 1}'],
  ];
  const accepted = bad.filter(([, raw]) => !(throws(() => parseRecord(raw)) instanceof RecordError));
  ok("record: a malformed record is refused, so a page cannot quote a half-written one",
    !accepted.length, accepted.map(([why]) => why).join(" · ") || bad.length + " shapes refused");

  /* what the release writes is built from two counts it has just measured, so the writer refuses
     anything but whole positive numbers - a 0 or a float would reach a page as a real total */
  const body = recordContent(306, 146);
  const round = parseRecord(body);
  ok("record: two measured totals round-trip through the writer to a readable record",
    round.harness === 306 && round.browser === 146 && /^\d{4}-\d{2}-\d{2}$/.test(round.recorded),
    round.harness + " · " + round.browser + " · " + round.recorded);
  const refused = [[0, 146], [306, 0], [-1, 146], [306, 1.5], ["306", 146], [null, 146]]
    .filter(([h, b]) => !(throws(() => recordContent(h, b)) instanceof RecordError));
  ok("record: a total that is not a positive whole number is refused before it can be written",
    !refused.length, refused.map(([h, b]) => h + "/" + b).join(" · ") || "6 shapes refused");
}

/* ── every page's markers are well formed, and only state what it owns ──────── */
{
  const checked = [GUIDE, PUB].map((d) => {
    const html = read(d.path);
    const r = throws(() => stamp(html, fixtureValues(d), d.keys));
    return { path: d.path, error: r && r.message };
  });
  ok("markers: both pages mark only values this tool reads, and state every one they own",
    checked.every((c) => !c.error),
    checked.filter((c) => c.error).map((c) => c.path + ": " + c.error).join(" · ") || "2 pages valid");
}

/* ── one value replaced, the others left byte for byte ──────────────────────── */
const fixture = (doc, over = {}) => {
  const values = fixtureValues(doc);
  return doc.keys.map((k) => "<span data-live=\"" + k + "\">" + (k in over ? over[k] : values[k]) + "</span>")
    .join("\n");
};
{
  const vals = fixtureValues(GUIDE);
  const stale = fixture(GUIDE, { page: "2.30.0", files: "9", checks: "9" });
  const r = stamp(stale, vals, GUIDE.keys);
  ok("stamp: only the values that disagree are rewritten",
    r.changed.length === 3 && r.changed.map((c) => c.key).sort().join(",") === "checks,files,page",
    r.changed.map((c) => c.key + " " + c.from + " → " + c.to).join(" · "));
  ok("stamp: the result states this tree's values, and the untouched spans keep their bytes",
    r.html === fixture(GUIDE) && r.html.includes("<span data-live=\"page\">" + vals.page + "</span>"),
    "page " + vals.page + " · checks " + vals.checks);
  const again = stamp(r.html, vals, GUIDE.keys);
  ok("stamp: a second pass writes nothing, so the gate's restamp cannot loop",
    again.changed.length === 0 && again.html === r.html, "idempotent");
  ok("stamp: a page with nothing to change is reported as unchanged, not rewritten",
    stamp(fixture(GUIDE), vals, GUIDE.keys).changed.length === 0);
  ok("stamp: the publishing page's own key set is the one that applies to it",
    stamp(fixture(PUB), fixtureValues(PUB), PUB.keys).changed.length === 0,
    PUB.keys.join(", "));
}

/* ── a marker that cannot be honoured is an error, not a silent miss ─────────── */
{
  const vals = fixtureValues(GUIDE);
  const unknown = throws(() => stamp(fixture(GUIDE) + "\n<span data-live=\"nope\">1</span>", vals, GUIDE.keys));
  ok("refuse: a marker naming a value nothing reads",
    unknown instanceof MarkerError && /nope/.test(unknown.message), String(unknown && unknown.message));

  const decorated = throws(() => stamp(
    fixture(GUIDE).replace("<span data-live=\"page\">", "<span class=\"v\" data-live=\"page\">"), vals, GUIDE.keys));
  ok("refuse: a marker with an attribute of its own (the rewrite would miss it)",
    decorated instanceof MarkerError, String(decorated && decorated.message).slice(0, 90));

  const nested = throws(() => stamp(
    fixture(GUIDE).replace("<span data-live=\"page\">" + vals.page, "<span data-live=\"page\"><b>" + vals.page),
    vals, GUIDE.keys));
  ok("refuse: a marker with markup inside it",
    nested instanceof MarkerError, String(nested && nested.message).slice(0, 90));

  const dropped = throws(() => stamp(GUIDE.keys.filter((k) => k !== "tag")
    .map((k) => "<span data-live=\"" + k + "\">" + vals[k] + "</span>").join("\n"), vals, GUIDE.keys));
  ok("refuse: a value that left the page (its marker removed)",
    dropped instanceof MarkerError && /tag/.test(dropped.message), String(dropped && dropped.message));

  const markup = throws(() => stamp(fixture(GUIDE), Object.assign({}, vals, { page: "2.30.<5" }), GUIDE.keys));
  ok("refuse: a value that carries markup (it would break the page, not describe it)",
    markup instanceof MarkerError, String(markup && markup.message).slice(0, 90));
}

console.log("\n" + (n - fails) + "/" + n + " checks passed");
process.exit(fails ? 1 : 0);
