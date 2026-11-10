"""Re-copy Signoff EE's stylesheet into assets/suite.css so Flasher shares the suite's look.

    python tools/sync_suite_css.py          copy
    python tools/sync_suite_css.py --check  fail if the copy is stale
"""
import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT.parent / "ee_design_review" / "assets" / "styles.css"
DST = ROOT / "assets" / "suite.css"
HEADER = ("/* Vendored from ee_design_review/assets/styles.css (Signoff EE) so Flasher shares the suite's tokens and components.\n"
          "   Do not edit here: re-copy with tools/sync_suite_css.py when Signoff EE's stylesheet changes. */\n")

want = HEADER + SRC.read_text(encoding="utf-8").replace("\r\n", "\n")
if "--check" in sys.argv:
    have = DST.read_text(encoding="utf-8").replace("\r\n", "\n") if DST.exists() else ""
    if have != want:
        sys.exit(f"{DST} is stale: run python tools/sync_suite_css.py")
    print("suite.css is up to date")
else:
    DST.write_bytes(want.encode("utf-8"))
    print(f"Copied {SRC} -> {DST}")
