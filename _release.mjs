#!/usr/bin/env node
/* One release, one command.

     node _release.mjs patch --en "..." --ar "..."  bump the patch version and release it
     node _release.mjs 2.31.0 --en "..." --ar "..." release an explicit version
     node _release.mjs minor --en @notes-en.txt --ar @notes-ar.txt --dry-run
     node _release.mjs --help

   A release used to be five hand-run steps in an order that matters: bump CONFIG.VERSION, the
   <title>, deploy/sw.js's VERSION and the CHANGELOG array; regenerate CHANGELOG.md; rebuild the
   bundle with `node _deploy.mjs --sync`; commit; tag. Every one of those was a place to forget
   something that the gate only catches later, and the tag had to name the version the page
   ships or the publish job would put a page labelled something else at the fixed address.

   This script does exactly that sequence, and nothing else:

     1. preflight - on `main`, a clean tracked tree, the tag free, the new version greater
        than the running one. Nothing is written until all four hold.
     2. write - CONFIG.VERSION, <title>, deploy/sw.js VERSION, and the new entry at the top of
        the CHANGELOG array (escaped as a JS string, so a quote or a newline cannot break the
        page); then CHANGELOG.md is regenerated from that array by _changelog.mjs.
     3. commit, then gate - the gate must run on the release commit: while an older release tag
        still points at HEAD, the gate correctly refuses a page that carries the new version.
        `node _deploy.mjs --sync --record` then runs the real harness, repairs the bundle from the
        page it just proved.
     4. fold the rebuilt bundle into that same commit with --amend, so what is tagged is the
        tested bundle and nothing else; then the annotated tag `v<version>`, and
        `node _deploy.mjs --artifacts-only` once more to prove the tag names the version.

   If the gate fails, the release commit is undone and every file this run touched is restored
   to the bytes it had before, so a red release leaves no half-bumped page behind.

   It does NOT push. A pushed tag publishes (the workflow in .github/workflows/checks.yml does
   that), and publishing needs the owner's explicit go-ahead every time.

   Notes are required in both languages, at the length the harness asks for (> 80 characters),
   because a release whose note is missing a language is invisible to half its readers and the
   gate would reject it anyway - after the files had already been rewritten.
*/
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

const PAGE = "index.html";
const SW = "deploy/sw.js";
const BUNDLE_PAGE = "deploy/index.html";
const HEADERS = "deploy/_headers";
const NOTES = "CHANGELOG.md";
const ZIP = "dashboard-site.zip";
/* the docs pages quote this version, this bundle's hash, the Worker's build tag and the check
   totals of the last recorded run, and _deploy.mjs restamps them during the gate below - so they
   are written by this run and have to be restored with the rest when a gate fails */
const GUIDE = "docs/DEPLOY_AND_VERIFY.html";
const PUBLISHING = "docs/PUBLISHING.html";
const RECORD = "docs/last-run.json";
/* every path this run can write: snapshotted before step 2 so a red gate can restore them */
const TOUCHED = [PAGE, SW, BUNDLE_PAGE, HEADERS, NOTES, ZIP, GUIDE, PUBLISHING, RECORD];

const MIN_NOTE = 81; /* the harness requires the decoded string to be longer than 80 chars */

const HELP = `One release, one command: bump, rebuild, verify, commit, tag.

  node _release.mjs <version|patch|minor|major> --en "..." --ar "..." [options]

  --en <text>     English release note (required; @path reads a file)
  --ar <text>     Arabic release note (required; @path reads a file)
  --title <text>  the clause after "Release <version>: " in the commit subject
                  (default: --en's first sentence, or its first clause when long)
  --date <Y-M-D>  the changelog date (default: today, local)
  --dry-run       validate everything and print the plan; write nothing, tag nothing
  --help

Requires a clean tracked tree on main. The tag is created locally; pushing it publishes, so
this script never pushes. The release commit is "Release <version>: <title>".`;

/* ── versions ─────────────────────────────────────────────────────────────────── */
export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text || "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error("not a version: " + (!x ? a : b));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/* An explicit version or one of the three bump words. Throws with a readable reason rather
   than guessing, because a release that quietly becomes 2.31.0.1 is worse than a refusal. */
export function nextVersion(current, spec) {
  const cur = parseVersion(current);
  if (!cur) throw new Error("the page's CONFIG.VERSION is not a version: " + current);
  const word = String(spec || "").trim().toLowerCase();
  let next;
  if (word === "major") next = [cur[0] + 1, 0, 0];
  else if (word === "minor") next = [cur[0], cur[1] + 1, 0];
  else if (word === "patch") next = [cur[0], cur[1], cur[2] + 1];
  else {
    next = parseVersion(word);
    if (!next) throw new Error('"' + spec + '" is not a version or patch/minor/major');
  }
  const text = next.join(".");
  if (compareVersions(text, current) <= 0) {
    throw new Error("v" + text + " is not newer than the running v" + current);
  }
  return text;
}

/* ── the page's three version sites, and the note ─────────────────────────────── */
const TITLE_RE = /<title>Home Dashboard v[0-9.]+<\/title>/;
const CONFIG_RE = /(^  VERSION: ")([0-9.]+)(",)/m;
const CHANGELOG_OPEN = /\};const CHANGELOG = \[\n/;
const SW_RE = /(^const VERSION = ")([0-9.]+)(";)/m;

function needOne(html, re, what) {
  const all = html.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  const n = all ? all.length : 0;
  if (n !== 1) throw new Error(what + ": expected exactly one match, found " + n);
}

/* A JS double-quoted string that cannot end the page's <script>. JSON.stringify already
   escapes quotes, backslashes, newlines and control characters; `</script` is the one HTML
   sequence it leaves alone, and inside a JS string `<\/script` is the same value. */
export function jsString(text) {
  return JSON.stringify(String(text)).replace(/<\/(?=script)/gi, "<\\/");
}

export function entryLine(entry) {
  return "{v:" + JSON.stringify(entry.v) + ", d:" + JSON.stringify(entry.d)
    + ", en:" + jsString(entry.en) + ", ar:" + jsString(entry.ar) + "},";
}

export function bumpPage(html, version, entry) {
  needOne(html, TITLE_RE, "page title");
  needOne(html, CONFIG_RE, "CONFIG.VERSION");
  needOne(html, CHANGELOG_OPEN, "CHANGELOG array");
  let out = html.replace(TITLE_RE, () => "<title>Home Dashboard v" + version + "</title>");
  out = out.replace(CONFIG_RE, (_m, a, _v, b) => a + version + b);
  out = out.replace(CHANGELOG_OPEN, () => "};const CHANGELOG = [\n" + entryLine(entry) + "\n");
  return out;
}

export function bumpWorker(src, version) {
  needOne(src, SW_RE, "deploy/sw.js VERSION");
  return src.replace(SW_RE, (_m, a, _v, b) => a + version + b);
}

export function validateNote(which, text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) throw new Error("--" + which + " is required: a release note in " + (which === "en" ? "English" : "Arabic"));
  if (t.length < MIN_NOTE) {
    throw new Error("--" + which + ' is ' + t.length + " chars; the harness wants more than " + (MIN_NOTE - 1)
      + ", because a release note is a paragraph rather than a label");
  }
  return t;
}

export function localDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

export function commitSubject(version, title) {
  const clause = String(title || "").trim().replace(/\.$/, "");
  return "Release " + version + (clause ? ": " + clause : "");
}

/* The commit body is the release note, wrapped so `git log` reads as prose. */
export function wrap(text, width = 92) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if ((line + " " + w).length <= width) line += " " + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/* ── shell helpers ───────────────────────────────────────────────────────────── */
function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return {
    ok: r.status === 0,
    status: r.status,
    out: String(r.stdout || "").trim(),
    err: String(r.stderr || "").trim(),
  };
}
function node(args, opts = {}) {
  return spawnSync(process.execPath, args.map((a) => (a.startsWith("--") ? a : join(ROOT, a))), {
    cwd: ROOT,
    encoding: "utf8",
    ...opts,
  });
}
function readNote(value) {
  const v = String(value);
  if (v.startsWith("@")) {
    const p = resolve(ROOT, v.slice(1));
    if (!existsSync(p)) throw new Error("no such notes file: " + v.slice(1));
    return readFileSync(p, "utf8").trim();
  }
  return v;
}

/* ── the run ─────────────────────────────────────────────────────────────────── */
export function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    console.error("_release.mjs: " + e.message + "\n\n" + HELP);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const pagePath = join(ROOT, PAGE);
  const swPath = join(ROOT, SW);
  if (!existsSync(pagePath) || !existsSync(swPath)) {
    console.error("_release.mjs: run this from the project root (" + PAGE + " / " + SW + " not found).");
    return 1;
  }

  const page = readFileSync(pagePath, "utf8");
  const sw = readFileSync(swPath, "utf8");
  const running = (page.match(/CONFIG\s*=\s*\{[\s\S]*?\n  VERSION: "([0-9.]+)"/) || [])[1];
  if (!running) {
    console.error("_release.mjs: no CONFIG.VERSION found in " + PAGE + " - nothing written.");
    return 1;
  }
  let version, entry;
  try {
    version = nextVersion(running, opts.spec);
    entry = {
      v: version,
      d: opts.date || localDate(new Date()),
      en: validateNote("en", readNote(opts.en)),
      ar: validateNote("ar", readNote(opts.ar)),
    };
  } catch (e) {
    console.error("_release.mjs: " + e.message + "\n\n" + HELP);
    return 2;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.d)) {
    console.error("_release.mjs: --date must be YYYY-MM-DD, not " + JSON.stringify(entry.d));
    return 2;
  }

  const tag = "v" + version;
  const subject = commitSubject(version, opts.title || defaultTitle(entry.en));

  console.log("── release " + version + " (running v" + running + ") ──");

  /* 1. preflight. A release is a commit and a tag, so the tree has to be a clean checkout of
        main and the name has to be free; a dirty tree would tag changes nobody reviewed. */
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) {
    console.error("_release.mjs: not a git repository (" + branch.err + ")");
    return 1;
  }
  if (branch.out !== "main") {
    console.error("_release.mjs: on branch \"" + branch.out + "\"; a release is tagged from main,"
      + " and CI refuses to publish a tag that is not on main. Merge first.");
    return 1;
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (!dirty.ok) {
    console.error("_release.mjs: git status failed: " + dirty.err);
    return 1;
  }
  if (dirty.out) {
    console.error("_release.mjs: the tracked tree is not clean, so a release commit would carry"
      + " changes nobody chose for this release:\n" + dirty.out
      + "\nCommit or stash them first; nothing was written.");
    return 1;
  }
  if (git(["rev-parse", "-q", "--verify", "refs/tags/" + tag]).ok) {
    console.error("_release.mjs: tag " + tag + " already exists - version numbers are never reused.");
    return 1;
  }
  console.log("PASS  preflight: main · tracked tree clean · " + tag + " free · v" + version + " > v" + running);

  if (opts.dryRun) {
    console.log("\n--dry-run: nothing was written and nothing was tagged. The release would --");
    console.log("  page:     " + PAGE + " -> CONFIG.VERSION, <title> and the newest CHANGELOG entry " + version);
    console.log("  worker:   " + SW + " -> const VERSION = \"" + version + "\"");
    console.log("  notes:    " + NOTES + " regenerated from the array");
    console.log("  commit:   " + subject);
    console.log("  gate:     node _deploy.mjs --sync --record on that commit - bundle repaired, docs' totals re-recorded");
    console.log("  tag:      " + tag + " (annotated) · node _deploy.mjs --artifacts-only after it");
    console.log("\n  " + entryLine(entry));
    return 0;
  }

  /* 2. write. Snapshot first: a red gate puts every byte back where it was. */
  const before = new Map(TOUCHED.map((rel) => {
    const p = join(ROOT, rel);
    return [rel, existsSync(p) ? readFileSync(p) : null];
  }));
  const restore = () => {
    for (const [rel, bytes] of before) {
      const p = join(ROOT, rel);
      if (bytes === null) { if (existsSync(p)) rmSync(p); }
      else writeFileSync(p, bytes);
    }
    console.log("  restored " + TOUCHED.length + " file(s) to the bytes they had before this run");
  };

  try {
    writeFileSync(pagePath, bumpPage(page, version, entry));
    writeFileSync(swPath, bumpWorker(sw, version));
  } catch (e) {
    console.error("_release.mjs: " + e.message);
    restore();
    return 1;
  }
  console.log("PASS  page: title, CONFIG.VERSION and the newest changelog entry are " + version);
  console.log("PASS  worker: " + SW + " VERSION is " + version);

  const gen = node(["_changelog.mjs"], { encoding: "utf8" });
  if (gen.status !== 0) {
    console.error("_release.mjs: node _changelog.mjs failed:\n" + String(gen.stderr || gen.stdout || "").trim());
    restore();
    return 1;
  }
  console.log("PASS  notes: " + NOTES + " regenerated from the array");

  /* 3. the release commit, before the gate. The gate's tag check compares any v* tag at HEAD
        with the page's version, and until this commit exists the PREVIOUS release tag is at
        HEAD - so gating first would fail on a correct bump. Committing first also means the
        subject and body are the ones that get tagged. The bundle in this commit is still the
        previous build; step 4 puts the rebuilt one in. */
  const files = [PAGE, SW, BUNDLE_PAGE, HEADERS, NOTES, ZIP, GUIDE, PUBLISHING, RECORD];
  const add = git(["add", "--"].concat(files));
  if (!add.ok) {
    console.error("_release.mjs: git add failed: " + add.err);
    restore();
    return 1;
  }
  const commit = git(["commit", "-m", subject, "-m", wrap(entry.en), "--"].concat(files));
  if (!commit.ok) {
    console.error("_release.mjs: git commit failed:\n" + (commit.err || commit.out)
      + "\n\nThe release files are staged and modified; no tag was created."
      + " `git reset` unstages them, and all " + files.length + " paths can be restored with `git checkout --`.");
    return 1;
  }
  const undoCommit = () => git(["reset", "--mixed", "HEAD~1"]);
  console.log("PASS  commit: " + git(["rev-parse", "--short", "HEAD"]).out + "  " + subject);

  /* 4. the gate, on the commit it will tag. --sync rebuilds deploy/ from the page the harness
        just proved, and --record re-measures the check totals the docs pages quote - the harness
        count from this same run, the browser contract measured now - so a release cannot ship
        totals taken from some earlier tree. */
  console.log("\n── gate: node _deploy.mjs --sync --record ──");
  const gate = node(["_deploy.mjs", "--sync", "--record"], { stdio: "inherit" });
  if (gate.status !== 0) {
    console.error("\n_release.mjs: the gate refused the release; the commit and the version bump are undone.");
    if (!undoCommit().ok) {
      console.error("_release.mjs: the release commit could not be undone (git reset failed)."
        + " HEAD still carries the bump - inspect with `git log -1 --stat` before touching anything.");
      return 1;
    }
    restore();
    return 1;
  }
  console.log("PASS  gate: harness + rebuilt bundle are green, and the docs' totals are this run's");

  /* 5. what gets tagged must be the tested bundle, so the repaired files are amended into the
        release commit rather than left as a dirty tree beside it. */
  const reAdd = git(["add", "--"].concat(files));
  const amend = reAdd.ok && git(["commit", "--amend", "--no-edit", "--"].concat(files));
  if (!amend || !amend.ok) {
    console.error("_release.mjs: the bundle passed the gate but could not be amended into the release commit:"
      + "\n" + ((amend && (amend.err || amend.out)) || reAdd.err || "git add failed")
      + "\nThe commit exists, the tree is dirty with the rebuilt bundle, and no tag was created.");
    return 1;
  }
  const head = git(["rev-parse", "--short", "HEAD"]).out;
  console.log("PASS  commit: " + head + "  " + subject + " · rebuilt bundle included");

  const tagRun = git(["tag", "-a", tag, "-m", "Release " + version]);
  if (!tagRun.ok) {
    console.error("_release.mjs: the commit exists but tagging failed: " + (tagRun.err || tagRun.out)
      + "\nRun `git tag -a " + tag + " -m \"Release " + version + "\"` once the cause is fixed.");
    return 1;
  }
  console.log("PASS  tag: " + tag + " (annotated) at " + head);

  /* The tag check lives in every gate run, so this proves the pairing after the fact. */
  const check = node(["_deploy.mjs", "--artifacts-only"], { stdio: "inherit" });
  if (check.status !== 0) {
    console.error("\n_release.mjs: the release is committed and tagged, but the post-tag gate failed."
      + "\nDo not push " + tag + " until it is green: `git tag -d " + tag + "` removes the local tag.");
    return 1;
  }

  console.log("\nRELEASE READY: v" + version + " is committed, tagged and gate-clean.");
  console.log("Nothing was pushed. Publishing is the tag push, and it needs your go-ahead:");
  console.log("  git push origin main && git push origin " + tag);
  return 0;
}

/* The first sentence is a decent default subject on its own. When it is too long for
   `git log --oneline`, the first clause is a better cut than a truncation: it ends where the
   sentence itself paused, and only a sentence with no clause break falls back to a word cut. */
export function defaultTitle(text) {
  const source = String(text).trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(source);
  let s = (m ? m[1] : source).replace(/[.!?]$/, "");
  if (s.length > 72) {
    const clause = /^(.{20,72}?)(?::|;|,)\s/.exec(s);
    if (clause) s = clause[1];
  }
  if (s.length <= 72) return s;
  const cut = s.slice(0, 72);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "");
}

export function parseArgv(argv) {
  const out = { spec: null, en: null, ar: null, title: null, date: null, dryRun: false, help: false };
  const value = (i, flag) => {
    if (i >= argv.length) throw new Error(flag + " needs a value");
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--en" || a === "--note-en") { out.en = value(++i, a); }
    else if (a === "--ar" || a === "--note-ar") { out.ar = value(++i, a); }
    else if (a === "--title") { out.title = value(++i, a); }
    else if (a === "--date") { out.date = value(++i, a); }
    else if (a.startsWith("-")) throw new Error("unknown flag " + a);
    else if (!out.spec) out.spec = a;
    else throw new Error("unexpected argument " + a);
  }
  if (!out.help && !out.spec) throw new Error("name the version (or patch/minor/major)");
  return out;
}

const HERE = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(main(process.argv.slice(2)));
}
