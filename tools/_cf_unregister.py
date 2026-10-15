#!/usr/bin/env python3
"""Remove the Cloudflare MCP registration from every agent except Freebuff.

Freebuff keeps its entry in ~/.agents/mcp.json. Everything else is reverted to the
state it was in before the Cloudflare setup:

  * restore from the .bak-20261015-* backup when one exists (exact prior state)
  * otherwise delete the file if the Cloudflare entry was its only content
  * otherwise surgically remove just the Cloudflare entry

Every file we touch is copied to <file>.cf-removed-<ts> first, so nothing is lost.

Usage:
  python _cf_unregister.py            # dry run
  python _cf_unregister.py --apply
"""
import os
import re
import sys
import json
import time
import shutil

HOME = os.path.expanduser("~")
TS = time.strftime("%Y%m%d-%H%M%S")

# path -> ("restore"|"delete"|"edit", backup path or None)
TARGETS = [
    (".qwen/settings.json",                             "delete", None),
    (".cursor/mcp.json",                                "delete", None),
    ("AppData/Roaming/Code/User/mcp.json",              "delete", None),
    (".cline/data/settings/cline_mcp_settings.json",    "delete", None),
    (".gemini/config/mcp_config.json",                  "restore", ".gemini/config/mcp_config.json.bak-20261015-094636"),
    (".config/opencode/opencode.jsonc",                 "restore", ".config/opencode/opencode.jsonc.bak-20261015-094646"),
    (".vibe/config.toml",                               "restore", ".vibe/config.toml.bak-20261015-094646"),
    ("AppData/Local/hermes/config.yaml",                "restore", "AppData/Local/hermes/config.yaml.bak-20261015-094646"),
    (".codex/config.toml",                              "edit",    None),
]

# Instruction files that existed only to carry the Cloudflare guidance.
INSTRUCTION_FILES = [".codex/AGENTS.md", ".claude/CLAUDE.md", ".config/opencode/AGENTS.md"]

# Freebuff's own config - never touched.
KEEP = ".agents/mcp.json"


def p(rel):
    return os.path.join(HOME, rel.replace("/", os.sep))


def strip_toml_section(text, header):
    """Remove a [header] block and its body up to the next section header."""
    lines = text.splitlines(keepends=True)
    out, skipping = [], False
    for ln in lines:
        if ln.strip().startswith("[") and ln.strip().rstrip("]").lstrip("[") == header:
            skipping = True
            continue
        if skipping:
            if ln.lstrip().startswith("["):
                skipping = False
            else:
                continue
        out.append(ln)
    return "".join(out)


def strip_vibe_entry(text):
    """Remove the [[mcp_servers]] element whose name is cloudflare plus its auth block."""
    lines = text.splitlines(keepends=True)
    out, i = [], 0
    while i < len(lines):
        if lines[i].strip() == "[[mcp_servers]]":
            # collect this element until the next top-level line
            j = i + 1
            block = [lines[i]]
            while j < len(lines) and not lines[j].lstrip().startswith("[") and lines[j].strip():
                block.append(lines[j])
                j += 1
            # the auth sub-block belongs to this element
            if j < len(lines) and lines[j].strip() == "[mcp_servers.auth]":
                block.append(lines[j])
                j += 1
                while j < len(lines) and not lines[j].lstrip().startswith("[") and lines[j].strip():
                    block.append(lines[j])
                    j += 1
            if any('name = "cloudflare"' in b for b in block):
                i = j
                continue
            out.extend(block)
            i = j
            continue
        out.append(lines[i])
        i += 1
    return "".join(out)


def strip_hermes(text):
    """Remove the mcp_servers.cloudflare key and the comment line that introduces it."""
    lines = text.splitlines(keepends=True)
    out, i = [], 0
    while i < len(lines):
        ln = lines[i]
        if ln.strip() == "mcp_servers:" or (ln.strip().startswith("mcp_servers:") and "cloudflare" in "".join(lines[i:i+4])):
            # keep the key only if it has other children
            j = i + 1
            block = []
            while j < len(lines) and (lines[j].startswith(" ") or not lines[j].strip()):
                if lines[j].strip().startswith("#") or not lines[j].strip():
                    j += 1
                    continue
                block.append(j)
                j += 1
            kids = [k for k in block if lines[k].strip() == "cloudflare:"]
            if kids and len(block) == len(kids) + sum(
                1 for k in range(min(block), max(block) + 1) if lines[k].startswith("  ") and not lines[k].startswith("   ")):
                pass
            if kids:
                # drop the cloudflare child and its indented body
                keep_block = []
                k = 0
                while k < len(block):
                    b = block[k]
                    if lines[b].strip() == "cloudflare:":
                        # skip this and following deeper-indented lines
                        k += 1
                        while k < len(block) and lines[block[k]].startswith("    "):
                            k += 1
                        continue
                    keep_block.append(b)
                    k += 1
                # also drop the comment describing it, if immediately above
                if i > 0 and "Cloudflare remote MCP server" in lines[i-1]:
                    out.pop() if out and "Cloudflare remote MCP server" in out[-1] else None
                    i -= 1
                if not keep_block:
                    i = max(block) + 1 if block else i + 1
                    continue
                out.append(ln)
                for b in keep_block:
                    out.append(lines[b])
                i = max(block) + 1
                continue
        if "Cloudflare remote MCP server" in ln:
            i += 1
            continue
        out.append(ln)
        i += 1
    return "".join(out)


def main():
    apply = "--apply" in sys.argv
    actions = []

    for rel, mode, backup in TARGETS:
        path = p(rel)
        if not os.path.exists(path):
            actions.append((rel, mode, "SKIP (absent)"))
            continue
        txt = open(path, encoding="utf-8-sig").read()
        if "cloudflare" not in txt.lower():
            actions.append((rel, mode, "SKIP (no cloudflare entry)"))
            continue
        if mode == "restore":
            if backup and os.path.exists(p(backup)):
                actions.append((rel, mode, "restore from " + os.path.basename(backup)))
            else:
                actions.append((rel, mode, "BACKUP MISSING -> would delete instead"))
        elif mode == "delete":
            actions.append((rel, mode, "delete; only-cloudflare content (%d lines)" % (txt.count("\n") + 1)))
        else:
            actions.append((rel, mode, "strip [mcp_servers.cloudflare] section"))

    for rel in INSTRUCTION_FILES:
        path = p(rel)
        if os.path.exists(path):
            txt = open(path, encoding="utf-8-sig").read()
            actions.append((rel, "delete-instruction", "%d lines, cloudflare-guidance only" % (txt.count("\n") + 1)))
        else:
            actions.append((rel, "delete-instruction", "SKIP (absent)"))

    print("=== plan ===")
    for rel, mode, note in actions:
        print("  %-52s %-18s %s" % (rel, mode, note))
    print("\n  %-52s %-18s %s" % (KEEP, "KEEP", "Freebuff's own config"))

    if not apply:
        print("\nDRY RUN - nothing changed. Re-run with --apply.")
        return 0

    print("\n=== applying ===")
    results = []
    for rel, mode, _note in actions:
        path = p(rel)
        if not os.path.exists(path):
            results.append((rel, "skipped")); continue
        if mode == "delete-instruction":
            shutil.copy2(path, path + ".cf-removed-" + TS)
            os.remove(path)
            results.append((rel, "deleted (backed up)")); continue

        shutil.copy2(path, path + ".cf-removed-" + TS)

        if mode == "restore":
            backup = next((b for r, m, b in TARGETS if r == rel), None)
            bp = p(backup) if backup else None
            if bp and os.path.exists(bp):
                shutil.copy2(bp, path)
                results.append((rel, "restored from backup")); continue
            os.remove(path)
            results.append((rel, "deleted (backup missing)")); continue

        if mode == "delete":
            os.remove(path)
            results.append((rel, "deleted")); continue

        # edit
        txt = open(path, encoding="utf-8-sig").read()
        orig = txt
        if rel.endswith(".toml"):
            txt = strip_toml_section(txt, "mcp_servers.cloudflare")
        with open(path, "w", encoding="utf-8") as f:
            f.write(txt)
        results.append((rel, "edited" if txt != orig else "NO CHANGE (pattern missed)"))

    print()
    for rel, res in results:
        print("  %-52s %s" % (rel, res))

    # verification pass
    print("\n=== verification: cloudflare still referenced anywhere? ===")
    leftovers = []
    for rel, _m, _n in TARGETS:
        path = p(rel)
        if os.path.exists(path) and "cloudflare" in open(path, encoding="utf-8-sig").read().lower():
            leftovers.append(rel)
    for rel in INSTRUCTION_FILES:
        path = p(rel)
        if os.path.exists(path) and "cloudflare" in open(path, encoding="utf-8-sig").read().lower():
            leftovers.append(rel)
    if leftovers:
        for l in leftovers:
            print("   STILL PRESENT:", l)
    else:
        print("   clean - no cloudflare reference in any of the other agents' configs")

    keep = p(KEEP)
    print("   Freebuff %s still has cloudflare: %s" % (KEEP, "YES" if os.path.exists(keep) and "cloudflare" in open(keep, encoding="utf-8-sig").read().lower() else "NO"))
    return 1 if leftovers else 0


if __name__ == "__main__":
    sys.exit(main())
