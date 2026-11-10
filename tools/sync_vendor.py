"""Copy the Signoff engine files Flasher borrows into assets/vendor/. Don't edit the copies; change them
in ee_design_review and re-run this.

- model.js, github.js   the Signoff engine: GitHubStore, which reads Flasher's private data repo
                        (manifest.json and the firmware files) with the suite's GitHub sign-in.

    python tools/sync_vendor.py           # copy
    python tools/sync_vendor.py --check   # exit 1 if a copy is stale
"""
import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DST = ROOT / "assets" / "vendor"
EE = ROOT.parent / "ee_design_review" / "assets"
HEADER = "/* Vendored from ee_design_review/assets/{name} (the Signoff engine). Do not edit here: re-copy with tools/sync_vendor.py. */\n"
FILES = ["model.js", "github.js"]

stale = []
for name in FILES:
    body = (EE / name).read_text(encoding="utf-8").replace("\r\n", "\n")
    want = (HEADER.format(name=name) + body).encode("utf-8")
    out = DST / name
    if "--check" in sys.argv:
        if not out.exists() or out.read_bytes().replace(b"\r\n", b"\n") != want:   # git may check copies out CRLF
            stale.append(name)
        continue
    DST.mkdir(parents=True, exist_ok=True)
    out.write_bytes(want)
    print(f"Copied {EE / name} -> {out}")
if stale:
    print("Stale: " + ", ".join(stale))
    sys.exit(1)
