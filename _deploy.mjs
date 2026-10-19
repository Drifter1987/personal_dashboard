#!/usr/bin/env node
/* The deploy gate. Nothing about this project gets published until this exits 0.

     node _deploy.mjs                  run the harness, then verify the release bundle
     node _deploy.mjs --artifacts-only skip the harness (a fast re-check of the bundle)
     node _deploy.mjs --sync           after a green run, repair the bundle from index.html
     node _deploy.mjs --help

   Three things are true when this exits 0, and none is worth much on its own:

     1. the shipped page and Worker pass the harness (node _check.mjs) against the real sources;
     2. the thing that gets published is the thing that was tested - deploy/index.html is
        index.html with its one inline script pinned by SHA-256 and nothing else changed, and
        every file in deploy/ sits in dashboard-site.zip with the same CRC-32 (the zip
        bookkeeping lives in _zip.py);
     3. if a release tag (v*) points at this commit, it names the page's CONFIG.VERSION. The
        workflow publishes on any v* tag, so a tag naming a version the page does not carry
        would put the wrong version at a fixed address under the wrong name.

   A failing check stops the run before anything is written, so a red gate can never leave a
   half-updated bundle behind. The same commands run in CI (.github/workflows/checks.yml).
*/
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAGE = "index.html";
const DEPLOY = "deploy";
const ZIP = "dashboard-site.zip";

const HELP = `The deploy gate: harness + release bundle.

  node _deploy.mjs                  run the harness, then verify the release bundle
  node _deploy.mjs --artifacts-only skip the harness (fast re-check of the bundle)
  node _deploy.mjs --sync           after a green run, repair the bundle from index.html

Exits 0 only when every check passed; 1 otherwise (and then writes nothing).`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const SYNC = argv.includes("--sync");
const ARTIFACTS_ONLY = argv.includes("--artifacts-only");
const unknown = argv.filter((a) => !["--sync", "--artifacts-only"].includes(a));
if (unknown.length) {
  console.error("_deploy.mjs: unknown flag(s) " + unknown.join(" ") + "\n\n" + HELP);
  process.exit(2);
}

let harnessPassed = false;
let tagFailed = false;
const fails = [];
const check = (name, ok, detail) => {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "  -> " + detail));
  if (!ok) fails.push(name);
};
const sha = (rel) => {
  const p = join(ROOT, rel);
  return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
};
const brief = (h) => (h ? h.slice(0, 12) : "missing");

/* ── hardening the shipped page ────────────────────────────────────────────────
   The page is one file with one inline script and no inline handlers, so the policy can name
   that script by its SHA-256 and drop 'unsafe-inline' altogether: a <script> that was not in
   the bundle has a different hash and cannot run, and neither can anything else injected into
   the document. The hash is computed here, at bundle time, because it has to be the hash of the
   bytes being shipped - the source keeps 'unsafe-inline' so the file you open while working
   always runs, and a stale hash could never be published: the gate compares the bundle to the
   hardened source byte for byte, so a script edit that was not re-bundled fails it.
   Browsers ignore 'unsafe-inline' as soon as a hash is present; the deployed policy carries
   'self' and the hash and nothing else in that clause. */
function scriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) continue; /* external scripts are already covered by 'self' */
    out.push("sha256-" + createHash("sha256").update(m[2], "utf8").digest("base64"));
  }
  return out;
}
function scriptPolicy(html) {
  const hashes = scriptHashes(html);
  return "script-src 'self'" + hashes.map((h) => " '" + h + "'").join("") + ";";
}
function harden(html) {
  return {
    html: html.replace(/script-src[^;]*;/, scriptPolicy(html)),
    policy: scriptPolicy(html),
    hashes: scriptHashes(html),
  };
}

/* python 3, for the zip bookkeeping only */
function findPython() {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["-c", "import sys,json,zipfile,zlib;print(sys.version_info[0])"], { encoding: "utf8" });
    if (r.status === 0 && String(r.stdout || "").trim() === "3") return cmd;
  }
  return null;
}
function zipState(py) {
  const r = spawnSync(py, [join(ROOT, "_zip.py"), "check", ZIP, DEPLOY], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return { error: String(r.stderr || r.stdout || "exited " + r.status).trim().split("\n")[0] };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: "unreadable _zip.py output: " + String(r.stdout).slice(0, 120) };
  }
}
function zipVerb(py, verb, name, src) {
  const r = spawnSync(py, [join(ROOT, "_zip.py"), verb, ZIP, name, src], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return { error: String(r.stderr || r.stdout || "exited " + r.status).trim().split("\n")[0] };
  return { ok: true, out: String(r.stdout).trim() };
}

function verifyBundle(py, state) {
  const sourcePath = join(ROOT, PAGE);
  const copyPath = join(DEPLOY, PAGE);
  const sourceHtml = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : "";
  const copyHtml = existsSync(copyPath) ? readFileSync(copyPath, "utf8") : null;
  const want = harden(sourceHtml);
  /* not "identical" but "identical except the pinned script": the one difference between the
     source and the bundle is the policy clause the build computes. */
  check("bundle: deploy/" + PAGE + " is " + PAGE + " with its script pinned by hash, and nothing else changed",
    !!copyHtml && copyHtml === want.html && want.hashes.length === 1,
    copyHtml === null ? "deploy/" + PAGE + " is missing"
      : want.hashes.length !== 1 ? "the page has " + want.hashes.length + " inline scripts, so one hash cannot cover it"
        : want.html === copyHtml ? brief(sha(PAGE)) + " + 1 hash"
          : "the bundle holds a different page (or an old hash) - run --sync after reviewing");
  if (copyHtml) {
    const shipped = harden(copyHtml);
    check("bundle: the hash in the shipped policy is the hash of the shipped script",
      copyHtml.indexOf(shipped.policy) >= 0 && shipped.hashes.length === 1
      && want.policy === shipped.policy && !/script-src[^;]*'unsafe-inline'/.test(copyHtml),
      shipped.hashes.length === 1 ? "script " + shipped.hashes[0].slice(7, 19) + "… · no 'unsafe-inline'"
        : shipped.hashes.length + " inline scripts");
    const headersHtml = existsSync(join(DEPLOY, "_headers")) ? readFileSync(join(DEPLOY, "_headers"), "utf8") : "";
    check("bundle: the header policy carries the same pinned script clause",
      headersHtml.indexOf(want.policy) >= 0 && !/script-src[^;]*'unsafe-inline'/.test(headersHtml),
      headersHtml.indexOf(want.policy) >= 0 ? "same hash on the response header" : "the header policy does not match the page's");
  }

  if (!state || state.error) {
    check("bundle: " + ZIP + " is readable and comparable", false, (state && state.error) || "not inspected");
    return;
  }
  const stale = state.stale.map((s) => s.name + " (zip " + s.zip.crc + " vs disk " + s.disk.crc + ")");
  check("bundle: " + ZIP + " carries every file under " + DEPLOY + "/ (" + state.members + " members, " + state.files + " files)",
    state.missing.length === 0, state.missing.length ? "missing from the zip: " + state.missing.join(", ") : undefined);
  check("bundle: every zip member still matches its file (CRC-32)", stale.length === 0,
    stale.length ? stale.join(" | ") : undefined);
  check("bundle: no orphan member in " + ZIP, state.orphan.length === 0,
    state.orphan.length ? "in the zip, not in " + DEPLOY + "/: " + state.orphan.join(", ") : undefined);
}

/* ── 1/2  the harness ───────────────────────────────────────────────────────────
   _check.mjs runs the real Worker against the real sources, so its exit status is the
   verdict - this step only reports it. */
if (!ARTIFACTS_ONLY) {
  console.log("── 1/2  harness: node _check.mjs (the shipped Worker, against the live sources) ──");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(ROOT, "_check.mjs")], { stdio: "inherit", cwd: ROOT });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.log("\nFAIL  harness: node _check.mjs exited " + r.status + " after " + secs + "s");
    console.log("DEPLOY BLOCKED: " + PAGE + " or worker.js failed the harness. The bundle was not touched.");
    process.exit(1);
  }
  harnessPassed = true;
  console.log("\nPASS  harness: node _check.mjs exited 0 (" + secs + "s)");
} else {
  console.log("── harness skipped (--artifacts-only): this run says nothing about the code ──");
}

/* ── 2/2  the release bundle ───────────────────────────────────────────────── */
console.log("\n── 2/2  release bundle: " + DEPLOY + "/  →  " + ZIP + " ──");
const py = findPython();
check("bundle: python 3 available for the zip bookkeeping", !!py,
  py || "neither python3 nor python found - the zip cannot be verified");
let state = py ? zipState(py) : null;
verifyBundle(py, state);

/* repair, but only what a repair can honestly fix: the page copy and the zip's own members.
   The harness already passed by this point, so --sync can never launder a broken page. */
if (SYNC && fails.length) {
  console.log("\n--sync: rebuilding the bundle from " + PAGE + " --");
  let repaired = 0;
  const hardened = harden(readFileSync(join(ROOT, PAGE), "utf8"));
  const copyPath = join(ROOT, DEPLOY, PAGE);
  if (!existsSync(copyPath) || readFileSync(copyPath, "utf8") !== hardened.html) {
    writeFileSync(copyPath, hardened.html);
    console.log("  wrote " + join(DEPLOY, PAGE) + " - " + PAGE + " with its script pinned (" + hardened.hashes.length + " hash)");
    repaired++;
  }
  /* the header policy is the page's policy plus the two rules only a header can carry, so its
     script clause is rewritten from the same hash rather than being kept by hand */
  const hdrPath = join(ROOT, DEPLOY, "_headers");
  if (existsSync(hdrPath)) {
    const before = readFileSync(hdrPath, "utf8");
    const after = before.replace(/script-src[^;]*;/, hardened.policy);
    if (after !== before) {
      writeFileSync(hdrPath, after);
      console.log("  rewrote the script clause in " + join(DEPLOY, "_headers"));
      repaired++;
    }
  }
  /* the copy above can make a zip member stale that matched a moment ago, so the zip is
     compared against the deploy folder as it stands now, not as it stood before the copy */
  state = py ? zipState(py) : null;
  if (py && state && !state.error) {
    for (const s of state.stale) {
      const r = zipVerb(py, "set", s.name, join(DEPLOY, s.name));
      console.log(r.error ? "  FAILED to replace " + s.name + ": " + r.error : "  replaced zip member " + s.name);
      repaired += r.error ? 0 : 1;
    }
    for (const name of state.missing) {
      const r = zipVerb(py, "add", name, join(DEPLOY, name));
      console.log(r.error ? "  FAILED to add " + name + ": " + r.error : "  added zip member " + name);
      repaired += r.error ? 0 : 1;
    }
    for (const name of state.orphan) {
      console.log("  orphan member " + name + " stays: it has no file in " + DEPLOY + "/ - remove it by hand if it is stale");
    }
  }
  if (repaired) {
    fails.length = 0;
    console.log("");
    state = py ? zipState(py) : null;
    verifyBundle(py, state);
    console.log("  (bundle repaired - " + repaired + " item" + (repaired === 1 ? "" : "s") + " rewritten)");
  }
}

/* ── release identity: the tag has to name the version that ships ───────────────
   A release tag is the only thing the workflow will publish, and the publish step uploads
   deploy/ as it stands - the upload itself never says which version it holds. So a tag that
   does not match the page's CONFIG.VERSION puts a page labelled something else at a fixed
   address, permanently and silently. This is a gate failure, like any other.

   Two ways a tag is seen, because a shallow CI checkout may not have the tag object at all:
     - CI: GITHUB_REF=refs/tags/vX.Y.Z on the very run that will publish;
     - locally: every tag pointing at HEAD (the runbook is commit -> tag -> gate -> push).
   No release tag at all is not a failure: a push to main, a pull request and an ordinary
   local run have no release to match, and the gate must not refuse them. */
function releaseTags() {
  const ref = process.env.GITHUB_REF || "";
  if ((process.env.GITHUB_REF_TYPE || "") === "tag" || ref.indexOf("refs/tags/") === 0) {
    const name = process.env.GITHUB_REF_NAME || ref.slice("refs/tags/".length);
    return { tags: name ? [name] : [], how: "GITHUB_REF " + (ref || name) };
  }
  const r = spawnSync("git", ["tag", "--points-at", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return { tags: [], how: "no tag information (git tag exited " + r.status + ")" };
  return {
    tags: String(r.stdout || "").split(/\r?\n/).map((t) => t.trim()).filter(Boolean),
    how: "git tag --points-at HEAD",
  };
}
{
  const pageFile = existsSync(join(ROOT, PAGE)) ? PAGE : join(DEPLOY, PAGE);
  const pageHtml = existsSync(join(ROOT, pageFile)) ? readFileSync(join(ROOT, pageFile), "utf8") : "";
  const version = (pageHtml.match(/\bVERSION:\s*"([^"]+)"/) || [])[1] || null;
  const { tags, how } = releaseTags();
  const releases = tags.filter((t) => /^v\d/.test(t));
  const wrong = releases.filter((t) => t.slice(1) !== version);
  tagFailed = !version || wrong.length > 0;
  check("release: the release tag names the version the page ships",
    !!version && wrong.length === 0,
    !version ? "no CONFIG.VERSION found in " + pageFile
      : wrong.length ? "tag " + wrong.join(", ") + " but " + pageFile + " is v" + version
        : releases.length ? releases.join(", ") + " = v" + version
          : "no release tag at HEAD (" + how + ") - nothing to match; page v" + version);
}

/* ── verdict ──────────────────────────────────────────────────────────────────── */
if (fails.length) {
  console.log("\nFAILED (" + fails.length + "): " + fails.join("; "));
  const reason = tagFailed
    ? "a release tag points at this commit but does not name the version the page ships"
    : ARTIFACTS_ONLY
      ? "the bundle is not the tested page (and this run did not execute the harness)"
      : harnessPassed
        ? "the harness is green, but the release bundle is not the page that passed it"
        : "the shipped page or Worker failed the harness";
  console.log("DEPLOY BLOCKED: " + reason + ".");
  process.exit(1);
}
if (ARTIFACTS_ONLY) {
  console.log("\nBUNDLE OK: " + PAGE + " and " + ZIP + " agree - but --artifacts-only skipped the harness,\n"
    + "so this is not a release check. Run it plain (node _deploy.mjs) before publishing.");
} else {
  console.log("\nRELEASE READY: the page, the Worker and " + ZIP + " agree, and the harness is green.");
  console.log("Nothing was published - this gate only decides whether publishing may start.");
}
