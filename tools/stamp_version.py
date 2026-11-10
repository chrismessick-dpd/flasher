"""Stamp assets/version.js with a hash of the tool's files, so a page shows which build it runs.

    python tools/stamp_version.py
"""
import hashlib, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ["index.html"] + sorted(str(p.relative_to(ROOT)).replace("\\", "/")
                                for p in (ROOT / "assets").rglob("*.*") if p.name != "version.js")
h = hashlib.sha256()
for f in FILES:
    h.update(f.encode() + b"\0" + (ROOT / f).read_bytes().replace(b"\r\n", b"\n"))
v = h.hexdigest()[:8]
(ROOT / "assets" / "version.js").write_text(f"window.FL = window.FL || {{}}; window.FL.VERSION = '{v}';\n", encoding="utf-8", newline="\n")
print("version", v)
