"""Build example firmware and publish it to Flasher's private data repo.

The firmware repo describes itself in a `flasher.json` at its sketchbook root (so no board or
client details live in this public repo):

    {
      "data_repo": "owner/name",                     the private data repo (Flasher reads it)
      "board": { "id": ..., "name": ..., "flash": {"base", "size"}, "ram": {"base", "size"},
                 "dfu": {"vid", "pid", "name"}, "run": {"vid", "pid", "name"}, "touchBaud": 1200,
                 "manualDfu": [steps], "notes": "...", "mcu": "..." },
      "examples": "path/to/examples",                one folder per sketch, <Name>/<Name>.ino
      "depends": ["path/to/board/package"],         what every sketch builds against (dirty and stale checks)
      "build": ["bash", "tools/build.sh"],           run from the sketchbook root, sketch folders appended
      "output": "build/{name}/{name}.ino.bin"        where the build leaves each .bin
    }

Usage (from the flasher folder):

    python tools/publish.py --source <sketchbook>                  dry run: build, check, and show the plan
    python tools/publish.py --source <sketchbook> --no-build       dry run on the .bin files already built
    python tools/publish.py --source <sketchbook> --only Blink Pulse
    python tools/publish.py --source <sketchbook> --push --confirm <code>   commit what the dry run showed

`--source` can be left out once `tools/publish.local.json` (git-ignored) holds {"source": "<sketchbook>"}.

The token comes from ../ee_tools_token.txt (or FLASHER_TOKEN). It is never printed. A push follows
the suite's rules for data repos: read the head, prove the manifest change is additive (the new
manifest with this publish undone re-serializes to the old bytes exactly), commit with force:false
against that head, and read it back.
"""
import argparse, base64, copy, datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKEN_FILE = ROOT.parent / "ee_tools_token.txt"
LOCAL = ROOT / "tools" / "publish.local.json"
API = "https://api.github.com"


class Fail(Exception):
    pass


# ── Pure helpers (tests/test_publish.py) ──

def num(v):
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        return int(v, 16) if v.strip().lower().startswith("0x") else int(v)
    raise ValueError(f"not a number: {v!r}")


def header_comment(text):
    """The sketch's leading // comment: (summary, description). The summary is its first paragraph on one line."""
    lines = []
    for line in text.replace("\r\n", "\n").split("\n"):
        s = line.strip()
        if not s.startswith("//"):
            break
        lines.append(s[2:][1:] if s[2:].startswith(" ") else s[2:])
    while lines and not lines[-1].strip():
        lines.pop()
    while lines and not lines[0].strip():
        lines.pop(0)
    desc = "\n".join(line.rstrip() for line in lines)
    first = desc.split("\n\n")[0] if desc else ""
    summary = " ".join(x.strip() for x in first.split("\n") if x.strip())
    return summary, desc


def check_image(b, board):
    """Errors for a raw image (same rules as assets/image.js)."""
    errs = []
    if len(b) < 8:
        return ["too short to be firmware"]
    fb, fs = num(board["flash"]["base"]), num(board["flash"]["size"])
    rb, rs = num(board["ram"]["base"]), num(board["ram"]["size"])
    if len(b) > fs:
        errs.append(f"{len(b)} bytes is more than the {fs} bytes of flash")
    sp, reset = int.from_bytes(b[0:4], "little"), int.from_bytes(b[4:8], "little")
    if not (rb < sp <= rb + rs):
        errs.append(f"first word 0x{sp:08X} isn't a stack pointer in RAM")
    if not reset & 1:
        errs.append(f"reset vector 0x{reset:08X} is even")
    elif not (fb <= (reset & ~1) < fb + len(b)):
        errs.append(f"reset vector 0x{reset:08X} is outside the image")
    return errs


def fw_id(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def git_blob_sha(b):
    return hashlib.sha1(b"blob %d\0" % len(b) + b).hexdigest()


def confirm_code(head, files):
    """The code that ties --push to a dry run: the head it read, and every file it would write. In the
    manifest the times (updated, published, built) are left out, since a push run is later, and may
    rebuild, but writes the same bytes; a rebuild that changes bytes changes a .bin's sha and the code."""
    parts = [head]
    for p, b in sorted(files.items()):
        if p == "manifest.json":
            m = json.loads(b)
            m.pop("updated", None)
            for f in m.get("firmware", []):
                f.pop("published", None)
                f.pop("built", None)
            b = dump(m)
        parts.append(f"{p}:{git_blob_sha(b)}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:6]


def dump(m):
    return (json.dumps(m, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def plan_manifest(old_bytes, board, entries, now):
    """The new manifest and which entries changed. old_bytes is None for a repo without one.
    Returns (new_bytes, changed_ids, board_changed). Raises Fail if the change isn't provably additive."""
    old = json.loads(old_bytes) if old_bytes else {"format": 1, "boards": {}, "firmware": []}
    if old_bytes and dump(old) != old_bytes:
        raise Fail("manifest.json isn't in this script's layout (2-space JSON, UTF-8, newline at the end), so the "
                   "additive check can't be made. Fix it by hand first.")
    if old.get("format") != 1:
        raise Fail(f"manifest.json has format {old.get('format')!r}; this script writes format 1")
    new = copy.deepcopy(old)
    new.setdefault("boards", {})
    new.setdefault("firmware", [])
    bid = board["id"]
    bdef = {k: v for k, v in board.items() if k != "id"}
    board_changed = new["boards"].get(bid) != bdef
    new["boards"][bid] = bdef
    changed = []
    for e in entries:
        i = next((k for k, f in enumerate(new["firmware"]) if f.get("id") == e["id"] and f.get("board") == bid), None)
        if i is not None:
            was = new["firmware"][i]
            same = all(was.get(k) == e[k] for k in ("sha256", "size", "name", "summary", "description", "source", "path"))
            if same:
                continue
            new["firmware"][i] = dict(e, published=now)
        else:
            new["firmware"].append(dict(e, published=now))
        changed.append(e["id"])
    if not changed and not board_changed:
        return (old_bytes or dump(new)), [], False
    new["updated"] = now
    new_bytes = dump(new)
    # The proof: undo exactly this publish and the old file comes back byte for byte.
    if old_bytes:
        back = json.loads(new_bytes)
        if bid in old.get("boards", {}):
            back["boards"][bid] = old["boards"][bid]
        else:
            del back["boards"][bid]
        olds = {f.get("id"): f for f in old.get("firmware", []) if f.get("board") == bid}
        back["firmware"] = [olds[f["id"]] if f.get("board") == bid and f["id"] in olds else f
                            for f in back["firmware"] if not (f.get("board") == bid and f["id"] in changed and f["id"] not in olds)]
        if "updated" in old:
            back["updated"] = old["updated"]
        else:
            back.pop("updated", None)
        if dump(back) != old_bytes:
            raise Fail("the new manifest changes more than this publish's entries; refusing")
    return new_bytes, changed, board_changed


# ── GitHub ──

def token():
    t = os.environ.get("FLASHER_TOKEN", "").strip()
    if not t and TOKEN_FILE.exists():
        t = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if not t:
        raise Fail(f"no token: put one in {TOKEN_FILE} or FLASHER_TOKEN")
    return t


def gh(method, path, tok, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={
        "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "Authorization": "Bearer " + tok, "User-Agent": "flasher-publish", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(msg).get("message", msg)
        except ValueError:
            pass
        err = Fail(f"GitHub {method} {path}: {e.code} {msg}")
        err.status = e.code
        raise err


def read_repo(full, tok):
    """{head, tree, entries: {path: sha}, manifest: bytes|None}, or {missing: reason}."""
    try:
        ref = gh("GET", f"/repos/{full}/git/ref/heads/main", tok)
    except Fail as e:
        if getattr(e, "status", 0) in (404, 409):
            return {"missing": "empty (it needs a first commit, such as a README)" if e.status == 409 else "not found, or the token can't open it"}
        raise
    head = ref["object"]["sha"]
    tree = gh("GET", f"/repos/{full}/git/commits/{head}", tok)["tree"]["sha"]
    listing = gh("GET", f"/repos/{full}/git/trees/{tree}?recursive=1", tok)
    if listing.get("truncated"):
        raise Fail("the data repo's tree listing is truncated; too many files to check safely")
    entries = {e["path"]: e["sha"] for e in listing["tree"] if e["type"] == "blob"}
    manifest = None
    if "manifest.json" in entries:
        manifest = base64.b64decode(gh("GET", f"/repos/{full}/git/blobs/{entries['manifest.json']}", tok)["content"])
    return {"head": head, "tree": tree, "entries": entries, "manifest": manifest}


# ── The source repo ──

def git(src, *args):
    r = subprocess.run(["git", "-C", str(src), *args], capture_output=True, text=True)
    if r.returncode:
        raise Fail(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout.strip()


def find_bash(explicit):
    if explicit:
        return explicit
    for p in (r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"):
        if os.path.exists(p):
            return p
    return shutil.which("bash") or "bash"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--source", help="the firmware sketchbook (holds flasher.json)")
    ap.add_argument("--only", nargs="+", metavar="NAME", help="publish only these examples")
    ap.add_argument("--no-build", action="store_true", help="use the .bin files already built")
    ap.add_argument("--bash", help="bash to run the build with (default: Git's)")
    ap.add_argument("--allow-dirty", action="store_true", help="publish sketches with uncommitted changes (they're marked)")
    ap.add_argument("--push", action="store_true", help="commit to the data repo (needs --confirm)")
    ap.add_argument("--confirm", help="the code the dry run printed")
    ap.add_argument("--ci", action="store_true", help="push without a code; only inside GitHub Actions")
    a = ap.parse_args(argv)

    src = a.source or (json.loads(LOCAL.read_text(encoding="utf-8")).get("source") if LOCAL.exists() else None)
    if not src:
        raise Fail("give --source <sketchbook>, or put {\"source\": ...} in tools/publish.local.json")
    src = pathlib.Path(src).resolve()
    cfg_path = src / "flasher.json"
    if not cfg_path.exists():
        raise Fail(f"{cfg_path} not found")
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    board, full = cfg["board"], cfg["data_repo"]
    bid = board["id"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,47}", bid):
        raise Fail(f"board id {bid!r} may only use a-z, 0-9, _ and -")
    for k in ("flash", "ram", "dfu"):
        if k not in board:
            raise Fail(f"flasher.json's board needs {k}")

    ex_dir = src / cfg["examples"]
    names = sorted(p.name for p in ex_dir.iterdir() if (p / (p.name + ".ino")).exists())
    if a.only:
        missing = [n for n in a.only if n not in names]
        if missing:
            raise Fail("not in the examples: " + ", ".join(missing) + " (have " + ", ".join(names) + ")")
        names = [n for n in names if n in a.only]
    if not names:
        raise Fail(f"no sketches in {ex_dir}")

    top = pathlib.Path(git(src, "rev-parse", "--show-toplevel")).resolve()
    sha = git(src, "rev-parse", "HEAD")
    remote = git(src, "remote", "get-url", "origin")
    m = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", remote)
    repo_name = m.group(1) if m else remote

    if not a.no_build:
        cmd = list(cfg.get("build", ["bash", "tools/build.sh"]))
        if cmd[0] == "bash":
            cmd[0] = find_bash(a.bash)
        cmd += [str((ex_dir / n).relative_to(src)).replace("\\", "/") for n in names]
        print(f"Building {len(names)} sketch{'es' if len(names) != 1 else ''}: {' '.join(cmd[1:2])} …", flush=True)
        r = subprocess.run(cmd, cwd=src)
        if r.returncode:
            raise Fail(f"the build failed (exit {r.returncode})")

    # What every sketch builds against (the board package, its core and libraries): a change there
    # changes every image, so it counts toward each sketch's dirty and stale checks.
    entries, problems, warnings = [], [], []
    deps = [src / d for d in cfg.get("depends", [])]
    for d in deps:
        if not d.exists():
            raise Fail(f"flasher.json's depends names {d}, which isn't there")
    dep_rels = [str(d.resolve().relative_to(top)).replace("\\", "/") for d in deps]
    dep_newest = max((p.stat().st_mtime for d in deps for p in d.rglob("*") if p.is_file()), default=0)
    dep_dirty = bool(dep_rels) and bool(git(top, "status", "--porcelain", "--untracked-files=no", "--", *dep_rels))
    if dep_dirty:
        warnings.append("the board package (" + ", ".join(dep_rels) + ") has uncommitted changes")

    for n in names:
        sk = ex_dir / n
        binp = src / cfg.get("output", "build/{name}/{name}.ino.bin").format(name=n)
        if not binp.exists():
            problems.append(f"{n}: {binp} not built")
            continue
        b = binp.read_bytes()
        errs = check_image(b, board)
        if errs:
            problems.append(f"{n}: " + "; ".join(errs))
            continue
        newest = max([p.stat().st_mtime for p in sk.rglob("*") if p.is_file()] + [dep_newest])
        if binp.stat().st_mtime < newest:
            warnings.append(f"{n}: the .bin is older than its sketch or the board package; build again (drop --no-build)")
        rel = str(sk.relative_to(top)).replace("\\", "/")
        dirty = dep_dirty or bool(git(top, "status", "--porcelain", "--untracked-files=no", "--", rel))
        if dirty and not a.allow_dirty:
            problems.append(f"{n}: has uncommitted changes (commit them, or pass --allow-dirty to publish marked)")
            continue
        summary, desc = header_comment((sk / (n + ".ino")).read_text(encoding="utf-8", errors="replace"))
        fid = fw_id(n)
        entries.append({
            "id": fid, "board": bid, "name": n, "summary": summary, "description": desc,
            "size": len(b), "sha256": hashlib.sha256(b).hexdigest(), "path": f"firmware/{bid}/{fid}.bin",
            "source": {"repo": repo_name, "sha": sha, "path": rel, "dirty": dirty},
            "built": datetime.datetime.fromtimestamp(binp.stat().st_mtime, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "_bytes": b,
        })

    print(f"\nSource   {repo_name} @ {sha[:10]}  ({src})")
    print(f"Board    {bid}: {board.get('name', bid)}")
    print(f"Data     {full}")
    for w in warnings:
        print("  warning: " + w)
    for p in problems:
        print("  skipped: " + p)
    if not entries:
        raise Fail("nothing to publish")

    tok = token()
    repo = read_repo(full, tok)
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    clean = [{k: v for k, v in e.items() if k != "_bytes"} for e in entries]
    if "missing" in repo:
        print(f"\n{full} is {repo['missing']}. A first publish would write:")
        new_bytes, changed, _ = plan_manifest(None, board, clean, now)
        for e in entries:
            print(f"  new        {e['path']:<40} {e['size']:>8} bytes  {e['summary'][:60]}")
        print(f"  manifest.json ({len(new_bytes)} bytes)")
        print("\nCreate the repo (private, with a README) before pushing.")
        return 0 if not a.push else 1

    new_bytes, changed, board_changed = plan_manifest(repo["manifest"], board, clean, now)
    files = {}
    print(f"\nPlan against {full} @ {repo['head'][:10]}:")
    for e in entries:
        same_blob = repo["entries"].get(e["path"]) == git_blob_sha(e["_bytes"])
        state = "changed" if e["id"] in changed and e["path"] in repo["entries"] else "new" if e["id"] in changed else "unchanged"
        if e["id"] in changed and not same_blob:
            files[e["path"]] = e["_bytes"]
        print(f"  {state:<10} {e['path']:<40} {e['size']:>8} bytes  {e['summary'][:60]}")
    if changed or board_changed:
        files["manifest.json"] = new_bytes
        what = "the board's details change too; " if board_changed else ""
        print(f"  {'manifest':<10} manifest.json ({len(new_bytes)} bytes; {what}additive: proven)")
    if not files:
        print("\nNothing to publish: the data repo already has these builds.")
        return 0
    code = confirm_code(repo["head"], files)

    if not a.push:
        print(f"\nDry run: nothing written. To publish exactly this: --push --confirm {code}")
        return 0
    if a.ci:
        if os.environ.get("GITHUB_ACTIONS") != "true":
            raise Fail("--ci works only inside GitHub Actions")
    elif a.confirm != code:
        raise Fail(f"--confirm {a.confirm!r} doesn't match this plan ({code}); run the dry run again and check it")

    # Write: blobs, one tree on top of the head's, one commit, ref update with force:false.
    tree = []
    for p, b in sorted(files.items()):
        blob = gh("POST", f"/repos/{full}/git/blobs", tok, {"content": base64.b64encode(b).decode(), "encoding": "base64"})
        if blob["sha"] != git_blob_sha(b):
            raise Fail(f"GitHub stored {p} as {blob['sha']}, not {git_blob_sha(b)}")
        tree.append({"path": p, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    t = gh("POST", f"/repos/{full}/git/trees", tok, {"base_tree": repo["tree"], "tree": tree})
    names_changed = [e["name"] for e in entries if e["id"] in changed]
    listed = names_changed[0] if len(names_changed) == 1 else " and ".join(names_changed) if len(names_changed) == 2 else ", ".join(names_changed[:-1]) + ", and " + names_changed[-1] if names_changed else "board details"
    msg = f"Publish {listed} for {board.get('name', bid)}\n\nBuilt from {repo_name} @ {sha}."
    c = gh("POST", f"/repos/{full}/git/commits", tok, {"message": msg, "tree": t["sha"], "parents": [repo["head"]]})
    gh("PATCH", f"/repos/{full}/git/refs/heads/main", tok, {"sha": c["sha"], "force": False})

    back = read_repo(full, tok)
    if back.get("head") != c["sha"]:
        raise Fail(f"read-back: main is at {back.get('head')}, not the new commit {c['sha']}")
    for p, b in files.items():
        if back["entries"].get(p) != git_blob_sha(b):
            raise Fail(f"read-back: {p} doesn't match what was written")
    if back["manifest"] != new_bytes:
        raise Fail("read-back: manifest.json doesn't match what was written")
    print(f"\nPublished {c['sha'][:10]} to {full}, and read it back: {len(files)} file(s) as written.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as e:
        print("error: " + str(e), file=sys.stderr)
        sys.exit(1)
