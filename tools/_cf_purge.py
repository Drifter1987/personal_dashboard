#!/usr/bin/env python3
"""Remove the Cloudflare skill symlinks from every agent directory except Freebuff's.

Freebuff reads skills from ~/.agents/skills (its own config dir). Every other agent
holds a symlink/reparse point to those same directories. This script removes ONLY the
links; the canonical directories under ~/.agents/skills are never touched.

Windows note: these reparse points are NOT reported by os.path.islink, so we detect
them by resolving realpath() and comparing against the canonical target. We only ever
call os.unlink/os.rmdir on the link itself - never shutil.rmtree, which would follow
the link and delete the real skills.

Usage:
  python _cf_purge.py            # dry run: report what would be removed
  python _cf_purge.py --apply    # actually remove the links
"""
import os
import sys
import json
import collections

HOME = os.path.expanduser("~")
CANON = os.path.realpath(os.path.join(HOME, ".agents", "skills"))

SKILLS = [
    "agents-sdk", "basin", "cf-cli", "cloudflare", "cloudflare-email-service",
    "cloudflare-one", "cloudflare-one-migrations", "durable-objects", "k2",
    "nextjs-on-cloudflare", "sandbox-migrate-to-next", "sandbox-next",
    "sandbox-stable", "turnstile-spin", "web-perf", "workers-best-practices",
    "workers-profiling", "wrangler",
]

# Never walk into these.
SKIP = ("node_modules", os.path.join("AppData", "Local", "Programs"),
        os.path.join("AppData", "Local", "npm-cache"), os.path.join("AppData", "Roaming", "npm"),
        ".git", "account-skills", "freebuff-desktop")

# Directories that hold REAL copies (not links) of the skills and need a different
# remedy (plugin uninstall) rather than link removal.
PLUGIN_DIRS = [
    os.path.join(HOME, ".claude", "plugins", "marketplaces", "cloudflare"),
    os.path.join(HOME, ".claude", "plugins", "cache", "cloudflare"),
    os.path.join(HOME, ".codex", ".tmp", "plugins", "plugins", "cloudflare"),
]


def is_reparse_point(path):
    """True when path is a link/junction (even one os.path.islink misses)."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if os.path.islink(path):
        return True
    # Windows reparse tag: 0xA0000003 mount point, 0xA000000C LX symlink, 0xA0000001 name surrogate
    tag = getattr(st, "st_reparse_tag", 0)
    return tag in (0xA0000003, 0xA000000C, 0xA0000001)


def targets():
    """Yield (parent_dir, skill, full_path) for every linked skill entry."""
    found = []
    for root, dirs, _files in os.walk(HOME):
        if any(s in root for s in SKIP):
            dirs[:] = []
            continue
        if root[len(HOME):].count(os.sep) > 6:
            dirs[:] = []
            continue
        keep = []
        for d in dirs:
            p = os.path.join(root, d)
            if is_reparse_point(p):
                # a link: record it if it is one of our skills, but never descend into it
                if d in SKILLS and not p.startswith(CANON):
                    if os.path.realpath(p) == os.path.realpath(os.path.join(CANON, d)):
                        found.append((root, d, p))
                continue
            keep.append(d)
        dirs[:] = keep
    return found


def main():
    apply = "--apply" in sys.argv
    found = targets()

    by_parent = collections.defaultdict(list)
    for parent, skill, _p in found:
        by_parent[parent].append(skill)

    print("canonical (Freebuff):", CANON)
    print("skills kept in Freebuff:", len(SKILLS))
    print()
    print("=== link sets to remove: %d, total links: %d ===" % (len(by_parent), len(found)))
    for parent in sorted(by_parent):
        skills = sorted(by_parent[parent])
        print("%-62s %2d %s" % (parent.replace(HOME, "~"), len(skills),
                                "" if len(skills) == 18 else "PARTIAL: " + ",".join(skills)))

    print()
    print("=== plugin/cache dirs holding REAL copies of these skills (not touched by link removal) ===")
    for p in PLUGIN_DIRS:
        if os.path.isdir(p):
            n = sum(1 for s in SKILLS if os.path.exists(os.path.join(p, "skills", s, "SKILL.md")) or os.path.exists(os.path.join(p, s, "SKILL.md")))
            print("   %-70s %s" % (p.replace(HOME, "~"), "present (%d skills)" % n if n else "present"))
        else:
            print("   %-70s %s" % (p.replace(HOME, "~"), "absent"))

    if not apply:
        print("\nDRY RUN - nothing removed. Re-run with --apply.")
        return 0

    removed, failed = [], []
    for parent, skill, p in found:
        try:
            os.unlink(p)          # symlink / file reparse point
        except OSError:
            try:
                os.rmdir(p)       # directory junction
            except OSError as e:
                failed.append((p, str(e)))
                continue
        removed.append(p)

    log = os.path.join(HOME, "_cf_skills_removed.json")
    with open(log, "w", encoding="utf-8") as f:
        json.dump({"removed": removed, "failed": failed, "canonical": CANON}, f, indent=2)

    print("\nremoved links: %d   failed: %d" % (len(removed), len(failed)))
    for p, e in failed:
        print("   FAILED", p, e)
    print("log:", log)

    # verify Freebuff's copy survived intact
    missing = [s for s in SKILLS if not os.path.exists(os.path.join(CANON, s, "SKILL.md"))]
    print("canonical skills still intact: %d/%d" % (len(SKILLS) - len(missing), len(SKILLS)))
    if missing:
        print("   MISSING:", missing)
    return 1 if (failed or missing) else 0


if __name__ == "__main__":
    sys.exit(main())
