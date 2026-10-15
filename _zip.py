#!/usr/bin/env python3
"""dashboard-site.zip bookkeeping for the deploy gate.

The zip is what gets uploaded to Cloudflare Pages, so it is part of the release rather than a
leftover: if it still carries yesterday's index.html, the deploy ships yesterday's page. Two
subcommands, both cheap because CRC-32 for every member is read straight out of the zip's
central directory - nothing is decompressed.

  python _zip.py check dashboard-site.zip deploy
      prints one JSON object: every member of the zip compared against the matching file in
      the deploy folder by CRC-32 and size, plus members with no file and files with no member.

  python _zip.py set dashboard-site.zip index.html deploy/index.html
      replaces one member in place, keeping the entry order and every other member byte-identical.

  python _zip.py add dashboard-site.zip icons/icon-512.png deploy/icons/icon-512.png
      appends a member the zip is missing (a new file in the deploy folder).

`check` always exits 0 and reports in JSON; the caller owns the verdict and the wording.
"""
import json
import os
import sys
import zipfile
import zlib


def crc_file(path):
    c = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            c = zlib.crc32(chunk, c)
    return c & 0xFFFFFFFF


def folder_files(root):
    out = {}
    for base, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out[rel] = {"size": os.path.getsize(full), "crc": crc_file(full)}
    return out


def members(zpath):
    with zipfile.ZipFile(zpath) as z:
        return {i.filename: {"size": i.file_size, "crc": i.CRC & 0xFFFFFFFF}
                for i in z.infolist() if not i.is_dir()}


def cmd_check(zpath, folder):
    in_zip = members(zpath)
    on_disk = folder_files(folder)
    stale = [n for n in sorted(in_zip) if n in on_disk and in_zip[n] != on_disk[n]]
    missing = [n for n in sorted(on_disk) if n not in in_zip]   # in the folder, not in the zip
    orphan = [n for n in sorted(in_zip) if n not in on_disk]    # in the zip, not in the folder
    print(json.dumps({
        "zip": zpath,
        "folder": folder,
        "members": len(in_zip),
        "files": len(on_disk),
        "stale": [{"name": n, "zip": in_zip[n], "disk": on_disk[n]} for n in stale],
        "missing": missing,
        "orphan": orphan,
        "ok": not (stale or missing or orphan),
    }))


def cmd_set(zpath, name, src):
    with open(src, "rb") as f:
        data = f.read()
    with zipfile.ZipFile(zpath) as z:
        infos = z.infolist()
        payloads = {i.filename: z.read(i.filename) for i in infos if not i.is_dir()}
    if name not in payloads:
        sys.exit("_zip.py: %s has no member %r" % (zpath, name))
    payloads[name] = data
    tmp = zpath + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
        for i in infos:
            if i.is_dir():
                continue
            info = zipfile.ZipInfo(i.filename, date_time=i.date_time)
            info.compress_type = i.compress_type
            info.external_attr = i.external_attr
            info.internal_attr = i.internal_attr
            info.create_system = i.create_system
            info.extra = i.extra
            out.writestr(info, payloads[i.filename])
    os.replace(tmp, zpath)
    print(json.dumps({"zip": zpath, "replaced": name, "bytes": len(data), "members": len(payloads)}))


def cmd_add(zpath, name, src):
    with open(src, "rb") as f:
        data = f.read()
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    with zipfile.ZipFile(zpath, "a", zipfile.ZIP_DEFLATED) as out:
        out.writestr(info, data)
    print(json.dumps({"zip": zpath, "added": name, "bytes": len(data)}))


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__.strip())
    cmd = argv[1]
    if cmd == "check" and len(argv) == 4:
        cmd_check(argv[2], argv[3])
    elif cmd == "set" and len(argv) == 5:
        cmd_set(argv[2], argv[3], argv[4])
    elif cmd == "add" and len(argv) == 5:
        cmd_add(argv[2], argv[3], argv[4])
    else:
        sys.exit(__doc__.strip())


if __name__ == "__main__":
    main(sys.argv)
