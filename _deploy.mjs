#!/usr/bin/env node
/* The deploy gate. Nothing about this project gets published until this exits 0.

     node _deploy.mjs                  run the harness, then verify the release bundle
     node _deploy.mjs --artifacts-only skip the harness (a fast re-check of the bundle)
     node _deploy.mjs --sync           after a green run, repair the bundle from index.html
     node _deploy.mjs --help

   Two things are true when this exits 0, and neither is worth much on its own:

     1. the shipped page and Worker pass the harness (node _check.mjs) against the real sources;
     2. the thing that gets published is the thing that was tested - deploy/index.html is
        byte-identical to index.html, and every file in deploy/ sits in dashboard-site.zip with
        the same CRC-32 (the zip bookkeeping lives in _zip.py).

   A failing check stops the run before anything is written, so a red gate can never leave a
   half-updated bundle behind. The same commands run in CI (.github/workflows/checks.yml).
*/
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
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
  const page = sha(PAGE);
  const copy = sha(join(DEPLOY, PAGE));
  check("bundle: deploy/" + PAGE + " is byte-identical to " + PAGE,
    !!page && page === copy,
    copy === null ? "deploy/" + PAGE + " is missing" : brief(page) + " / " + brief(copy));

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
  if (sha(PAGE) !== sha(join(DEPLOY, PAGE))) {
    copyFileSync(join(ROOT, PAGE), join(ROOT, DEPLOY, PAGE));
    console.log("  copied " + PAGE + " -> " + join(DEPLOY, PAGE));
    repaired++;
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

/* ── verdict ──────────────────────────────────────────────────────────────────── */
if (fails.length) {
  console.log("\nFAILED (" + fails.length + "): " + fails.join("; "));
  const reason = ARTIFACTS_ONLY
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
