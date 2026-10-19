/* Drives the release command's rewriting and version arithmetic, not a copy of them.
 *
 * The release step is the one place a mistake is expensive: a version bumped in two files out
 * of three, a changelog entry that breaks the page's script, or a tag that names a version the
 * page does not carry. The gate catches all three eventually - but only after the run has
 * already rewritten the files. So the pure parts are executed here: the version arithmetic, the
 * three edits, and the escaping that keeps a note with a quote, a backslash or "</script>" from
 * ending the page. The CLI's preflight and gate are not faked; those run for real in `main`.
 *
 * No dependencies. `_release.mjs` only runs its CLI when invoked directly, so importing it here
 * touches nothing on disk.
 */
import fs from "node:fs";
import {
  bumpPage, bumpWorker, commitSubject, compareVersions, defaultTitle, entryLine, jsString, localDate,
  nextVersion, parseArgv, parseVersion, validateNote, wrap,
} from "./_release.mjs";

let n = 0, fails = 0;
const ok = (name, cond, detail) => {
  n++;
  if (!cond) fails++;
  console.log((cond ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "  -> " + detail));
};

/* ── versions ─────────────────────────────────────────────────────────────────── */
{
  ok("version: a three-part version is read", parseVersion("2.31.0")?.join(".") === "2.31.0");
  ok("version: anything else is refused", parseVersion("2.31") === null && parseVersion("v2.31.0") === null
    && parseVersion("2.31.0.1") === null && parseVersion("") === null);
  ok("version: comparison is numeric, not lexical",
    compareVersions("2.9.0", "2.10.0") === -1 && compareVersions("2.10.0", "2.9.0") === 1
    && compareVersions("2.30.1", "2.30.1") === 0);
  ok("version: patch, minor and major bump", nextVersion("2.30.1", "patch") === "2.30.2"
    && nextVersion("2.30.1", "minor") === "2.31.0" && nextVersion("2.30.1", "major") === "3.0.0");
  ok("version: an explicit newer version is taken as written", nextVersion("2.30.1", "2.31.7") === "2.31.7");
  const bad = ["2.30.1", "2.30.0", "2.3", "latest", ""];
  let refused = 0;
  for (const spec of bad) {
    try { nextVersion("2.30.1", spec); } catch (e) { refused++; }
  }
  ok("version: an equal, older or malformed version is refused, never guessed",
    refused === bad.length, refused + "/" + bad.length + " refused");
}

/* ── the page's three version sites and its newest note ──────────────────────── */
const FIXTURE = [
  "<!doctype html><html><head><title>Home Dashboard v2.30.1</title>",
  "<script>\"use strict\";",
  "const CONFIG = {",
  "  VERSION: \"2.30.1\",",
  "  WORKER_URL: \"https://example.test\"",
  "};const CHANGELOG = [",
  '{v:"2.30.1", d:"2026-10-19", en:"old english", ar:"قديم"},',
  '{v:"2.30.0", d:"2026-10-19", en:"older english", ar:"أقدم"},',
  "];",
  "const ICS = [\"BEGIN:VCALENDAR\",\"VERSION:2.0\"];",
  "</script></head><body></body></html>",
].join("\n");

const NOTE_EN = 'He said "it ships" and left \\ a </script> plus\nnew line; the rest of the note is here so it is long enough for the harness to accept it.';
const NOTE_AR = "إصدار الاختبار: يقتبس \"نصاً\" ويكتب سطراً\nجديداً — ويبقى صالحاً. وهذه بقية الفقرة لتكون طويلة بما يكفي ليقبلها الفاحص، فملاحظة الإصدار فقرة لا وسم.";
const ENTRY = { v: "2.31.0", d: "2026-10-20", en: NOTE_EN, ar: NOTE_AR };
const bumped = bumpPage(FIXTURE, ENTRY.v, ENTRY);

{
  ok("page: the title advertises the new version",
    bumped.includes("<title>Home Dashboard v2.31.0</title>") && !bumped.includes("Home Dashboard v2.30.1"));
  ok("page: CONFIG.VERSION is the new version and no other version line moved",
    bumped.includes('VERSION: "2.31.0"') && bumped.includes('VERSION:2.0'), "CONFIG bumped · ICS untouched");
  const block = (bumped.match(/const CHANGELOG = \[[\s\S]*?\n\];/) || [])[0] || "";
  let list = null;
  try { list = new Function(block + "\nreturn CHANGELOG;")(); } catch (e) { list = null; }
  ok("page: the changelog array still parses after an entry is added", Array.isArray(list) && list.length === 3);
  const newest = list && list[0];
  ok("page: the new entry is the newest, and every older entry is kept in order",
    !!newest && newest.v === "2.31.0" && newest.d === "2026-10-20"
    && list[1].v === "2.30.1" && list[2].v === "2.30.0");
  ok("page: a note with quotes, a backslash, a newline and </script> round-trips exactly",
    !!newest && newest.en === NOTE_EN.trim() && newest.ar === NOTE_AR.trim(),
    newest ? newest.en.length + " en / " + newest.ar.length + " ar chars" : "no entry");
  const srcLine = String(bumped.split("};const CHANGELOG = [\n")[1] || "").split("\n")[0];
  ok("page: a note's newline and </script> are escaped in the shipped source, not left raw",
    srcLine.endsWith("},") && srcLine.includes("\\n") && srcLine.includes("<\\/script")
    && !srcLine.includes("</script>"), "one source line, escaped");
}

{
  ok("page: a fixture without a title is refused instead of half-written",
    throws(() => bumpPage(FIXTURE.replace(/<title>[^<]*<\/title>/, ""), ENTRY.v, ENTRY)));
  ok("page: a fixture with two titles is refused, because one hash covers one page",
    throws(() => bumpPage(FIXTURE.replace("<body>", "<title>Home Dashboard v9.9.9</title><body>"), ENTRY.v, ENTRY)));
  ok("page: a fixture with no changelog array is refused",
    throws(() => bumpPage(FIXTURE.replace("};const CHANGELOG = [", "];const OLD = ["), ENTRY.v, ENTRY)));
}

/* ── the worker's one version site ───────────────────────────────────────────── */
{
  const sw = "/* v2.30.1 */\nconst VERSION = \"2.30.1\";\nconst CACHE = \"home-dashboard-\" + VERSION;\n"
    + "const OTHER = \"VERSION 2.30.1\";\n";
  const out = bumpWorker(sw, "2.31.0");
  ok("worker: the cache version is bumped, and comments or unrelated strings are left alone",
    out.includes('const VERSION = "2.31.0";') && out.includes("/* v2.30.1 */")
    && out.includes('const OTHER = "VERSION 2.30.1";'));
  ok("worker: a source with no version line is refused",
    throws(() => bumpWorker("const CACHE = 1;\n", "2.31.0")));
}

/* ── notes, subjects and the date ────────────────────────────────────────────── */
{
  ok("notes: a label is too short for the harness and is refused before anything is written",
    throws(() => validateNote("en", "fixed it")));
  ok("notes: a real Arabic paragraph is accepted", MIN_OK(validateNote("ar", NOTE_AR)));
  ok("notes: an empty note in either language is refused", throws(() => validateNote("en", "  "))
    && throws(() => validateNote("ar", "")));
  ok("notes: a real paragraph is accepted and trimmed", validateNote("en", "\n" + NOTE_EN + " \n") === NOTE_EN.trim());
  ok("subject: the clause is appended to the version and a trailing period is dropped",
    commitSubject("2.31.0", "the list stops clipping.") === "Release 2.31.0: the list stops clipping"
    && commitSubject("2.31.0", "") === "Release 2.31.0");
  const w = wrap("one two three four five six seven eight", 12);
  ok("notes: the commit body is wrapped on word boundaries, not mid-word",
    w.split("\n").every((line) => line.length <= 12) && w.replace(/\n/g, " ") === "one two three four five six seven eight");
  ok("subject: a long note defaults to its first clause, not a cut mid-clause",
    defaultTitle("The release command now performs the whole release: it bumps the page, the worker and the notes.")
      === "The release command now performs the whole release",
    defaultTitle("The release command now performs the whole release: it bumps the page, the worker and the notes."));
  ok("subject: a note with no clause break is cut on a word boundary, never mid-word",
    (() => {
      const t = defaultTitle("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen");
      return t.length <= 72 && !/ $/.test(t) && t.split(" ").every((word) => word.length > 0);
    })());
  ok("subject: a short first sentence is used whole, without its period",
    defaultTitle("Cards pack into their columns. And then some.") === "Cards pack into their columns");
  ok("date: the changelog date is local, so a late-evening release is not dated tomorrow",
    localDate(new Date(2026, 9, 20, 23, 30)) === "2026-10-20");
  ok("escape: a dollar sign in a note is not read as a replacement token",
    jsString("costs $& and $1").includes("$&") && jsString("costs $& and $1").includes("$1"));
}

/* ── the real page still has the three sites this command edits ──────────────── */
{
  const page = fs.readFileSync("index.html", "utf8");
  const real = { v: "9.9.9", d: "2026-10-20", en: NOTE_EN, ar: NOTE_AR };
  const out = bumpPage(page, real.v, real);
  const oldBlock = (page.match(/const CHANGELOG = \[[\s\S]*?\n\];/) || [])[0] || "";
  const newBlock = (out.match(/const CHANGELOG = \[[\s\S]*?\n\];/) || [])[0] || "";
  const oldList = new Function(oldBlock + "\nreturn CHANGELOG;")();
  const newList = new Function(newBlock + "\nreturn CHANGELOG;")();
  ok("real page: a bump adds exactly one entry and changes nothing else in the history",
    newList.length === oldList.length + 1
    && JSON.stringify(newList.slice(1)) === JSON.stringify(oldList),
    oldList.length + " -> " + newList.length + " entries");
  ok("real page: every existing note keeps its text and its version",
    oldList.every((e, i) => newList[i + 1].en === e.en && newList[i + 1].ar === e.ar && newList[i + 1].v === e.v));
  ok("real page: the note this command writes is the note the harness would read",
    newList[0].en.length > 80 && newList[0].ar.length > 80 && newList[0].d === real.d);
}

/* ── the CLI's arguments ─────────────────────────────────────────────────────── */
{
  const a = parseArgv(["patch", "--en", "e", "--ar", "a", "--dry-run"]);
  ok("cli: a bump word, both notes and --dry-run parse",
    a.spec === "patch" && a.en === "e" && a.ar === "a" && a.dryRun === true && a.help === false);
  ok("cli: an explicit version, title and date parse",
    parseArgv(["2.31.0", "--note-en", "e", "--note-ar", "a", "--title", "t", "--date", "2026-10-20"]).spec === "2.31.0");
  ok("cli: no version is an error rather than a default", throws(() => parseArgv(["--en", "e"])));
  ok("cli: an unknown flag is an error rather than being ignored", throws(() => parseArgv(["patch", "--force"])));
  ok("cli: a flag left without a value is an error", throws(() => parseArgv(["patch", "--en"])));
  ok("cli: --help needs no version", parseArgv(["--help"]).help === true);
}

console.log("\n" + (n - fails) + "/" + n + " checks passed");
process.exit(fails ? 1 : 0);

function throws(fn) {
  try { fn(); return false; } catch (e) { return true; }
}
function MIN_OK(v) { return typeof v === "string" && v.length > 80; }
