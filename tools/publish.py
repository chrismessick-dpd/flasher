"""Build example firmware and publish it to Flasher's private data repo.

The firmware repo describes itself in a `flasher.json` at its sketchbook root (so no board or
client details live in this public repo):

    {
      "data_repo": "owner/name",                     the private data repo (Flasher reads it)
      "project": { "id": ..., "name": ... },        what People & access shares (default: the board)
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
    python tools/publish.py --source <sketchbook> --board-only     only the board's details (its run ids, button steps)
    python tools/publish.py --source <sketchbook> --push --confirm <code>   commit what the dry run showed

A board updated through another board's USB passthrough (`"kind": "bridge"`, README, *Bridge
boards*) publishes erase units, not a .bin: its image's `elf` is split into the units that
flasher.json's `units` describes, each with its CRC-32, and stored as parts of up to 1 MB.

`--source` can be left out once `tools/publish.local.json` (git-ignored) holds {"source": "<sketchbook>"}.

The token comes from ../ee_tools_token.txt (or FLASHER_TOKEN). It is never printed. A push follows
the suite's rules for data repos: read the head, prove the manifest change is additive (the new
manifest with this publish undone re-serializes to the old bytes exactly), commit with force:false
against that head, and read it back.
"""
import argparse, base64, copy, datetime, hashlib, json, os, pathlib, re, shutil, struct, subprocess, sys, urllib.error, urllib.request, zlib

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


def plan_manifest(old_bytes, board, entries, now, project=None):
    """The new manifest and which entries changed. old_bytes is None for a repo without one.
    project: (id, name) to record in the manifest's projects map, or None.
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
    proj_changed = False
    if project:
        pid, pname = project
        if (new.get("projects") or {}).get(pid) != {"name": pname}:
            new.setdefault("projects", {})[pid] = {"name": pname}
            proj_changed = board_changed = True
    changed = []
    for e in entries:
        i = next((k for k, f in enumerate(new["firmware"]) if f.get("id") == e["id"] and f.get("board") == bid), None)
        if i is not None:
            was = new["firmware"][i]
            same = all(was.get(k) == e.get(k) for k in ("sha256", "size", "name", "summary", "description", "source", "path", "kind", "parts", "commit"))
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
        if proj_changed:
            pid = project[0]
            if pid in old.get("projects", {}):
                back["projects"][pid] = old["projects"][pid]
            elif "projects" in old:
                del back["projects"][pid]
            else:
                del back["projects"]
        if "updated" in old:
            back["updated"] = old["updated"]
        else:
            back.pop("updated", None)
        if dump(back) != old_bytes:
            raise Fail("the new manifest changes more than this publish's entries; refusing")
    return new_bytes, changed, board_changed


def list_items(cfg, src):
    """What flasher.json publishes: one item per example sketch, or the listed images. Each item is
    {name, id, rel, dir, skip, bin, summary, description}."""
    if "images" in cfg:
        out = []
        for i, im in enumerate(cfg["images"]):
            name = im.get("name") or ""
            if not name or ("output" not in im and "elf" not in im) or "source" not in im:
                raise Fail(f"flasher.json's images #{i + 1} needs name, source, and output (or elf)")
            d = src / im["source"]
            if not d.is_dir():
                raise Fail(f"flasher.json's images #{i + 1}: source {d} isn't a folder")
            desc = im.get("description") or im.get("summary") or ""
            out.append({"name": name, "id": im.get("id") or fw_id(name), "rel": im["source"], "dir": d,
                        "skip": [src / x for x in im.get("exclude", [])],
                        "bin": src / im["output"] if "output" in im else None, "elf": src / im["elf"] if "elf" in im else None,
                        "summary": im.get("summary") or " ".join(desc.split("\n\n")[0].split()), "description": desc})
        ids = [x["id"] for x in out]
        if len(set(ids)) != len(ids):
            raise Fail("flasher.json's images have the same id twice")
        for x in out:
            if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", x["id"]):
                raise Fail(f"image id {x['id']!r} may only use a-z, 0-9, _ and -")
        return out
    ex_dir = src / cfg["examples"]
    out = []
    for p in sorted(ex_dir.iterdir()):
        if (p / (p.name + ".ino")).exists():
            summary, desc = header_comment((p / (p.name + ".ino")).read_text(encoding="utf-8", errors="replace"))
            out.append({"name": p.name, "id": fw_id(p.name), "rel": str(p.relative_to(src)).replace("\\", "/"), "dir": p, "skip": [],
                        "bin": src / cfg.get("output", "build/{name}/{name}.ino.bin").format(name=p.name),
                        "summary": summary, "description": desc})
    return out


def newest_in(d, skip):
    """The newest file time under d, leaving out the folders in skip (a build's own output)."""
    skip = [x.resolve() for x in skip]
    t = 0
    for p in d.rglob("*"):
        if p.is_file():
            rp = p.resolve()
            if not any(x == rp or x in rp.parents for x in skip):
                t = max(t, p.stat().st_mtime)
    return t


def runs_on(board, ids):
    """Whether the board's run or runAlso lists this USB id, so Flasher can restart a board running it."""
    want = (num(ids["vid"]), num(ids["pid"]))
    runs = ([board["run"]] if board.get("run") else []) + list(board.get("runAlso") or [])
    return any((num(r["vid"]), num(r["pid"])) == want for r in runs)


def board_from_manifest(manifest_bytes, bid, pid, full):
    """A board another firmware repo publishes, as the manifest has it (for flasher.json's "board": "<id>")."""
    m = json.loads(manifest_bytes) if manifest_bytes else {}
    b = (m.get("boards") or {}).get(bid)
    if not b:
        raise Fail(f"board {bid} isn't in {full}'s manifest yet; publish from the firmware repo that defines it first")
    if b.get("project", bid) != pid:
        raise Fail(f"board {bid} belongs to project {b.get('project')!r} in the manifest, not {pid!r}")
    return dict(b, id=bid)


PART_WINDOW = 0x100000   # parts never cross a 1 MB boundary, so unchanged ones keep their path and bytes


def elf_segments(b):
    """The loadable segments of a little-endian ELF32 file: [(paddr, bytes)], in file order. Uses the
    load address (paddr), where a section's initial values live in flash."""
    if b[:4] != b"\x7fELF":
        raise Fail("not an ELF file")
    if b[4] != 1 or b[5] != 1:
        raise Fail("only little-endian 32-bit ELF files are read")
    phoff, = struct.unpack_from("<I", b, 28)
    phentsize, phnum = struct.unpack_from("<HH", b, 42)
    out = []
    for i in range(phnum):
        p_type, off, _vaddr, paddr, filesz, _memsz, _flags, _align = struct.unpack_from("<IIIIIIII", b, phoff + i * phentsize)
        if p_type == 1 and filesz:   # PT_LOAD
            if off + filesz > len(b):
                raise Fail(f"segment {i} runs past the end of the file")
            out.append((paddr, b[off:off + filesz]))
    return out


def unit_map(layout):
    """flasher.json's units: {"skip": [[lo, hi]], "regions": [{"base", "sizes": [...]} or {"base", "end", "unit"},
    "app": true for the regions COMMIT covers]}. Returns (unit_for(addr) -> (start, size, region index), skips, apps)."""
    regions = []
    for i, rg in enumerate(layout.get("regions") or []):
        base = num(rg["base"])
        if "sizes" in rg:
            starts, at = [], base
            for sz in rg["sizes"]:
                starts.append((at, num(sz)))
                at += num(sz)
            regions.append((base, at, starts, None))
        else:
            unit, end = num(rg["unit"]), num(rg["end"])
            if unit <= 0 or (end - base) % unit:
                raise Fail(f"units region {i + 1}: end - base must be a whole number of units")
            regions.append((base, end, None, unit))
    if not regions:
        raise Fail("flasher.json's units needs regions")
    skips = [(num(a), num(z)) for a, z in layout.get("skip") or []]
    apps = [i for i, rg in enumerate(layout["regions"]) if rg.get("app")]

    def unit_for(addr):
        for i, (lo, hi, starts, unit) in enumerate(regions):
            if lo <= addr < hi:
                if unit:
                    return lo + (addr - lo) // unit * unit, unit, i
                for start, size in starts:
                    if start <= addr < start + size:
                        return start, size, i
        raise Fail(f"0x{addr:08X} is outside every units region (the bootloader's own sectors, or not flash)")
    return unit_for, skips, apps


def split_units(segments, layout):
    """The image as erase units, as the reference host tool lays it out: each unit the image touches,
    filled with 0xFF and the image's bytes laid over it (what it reads back as after an erase and a
    write). Segments inside a skip range are left out. Returns ({start: bytearray}, {start: region}, skipped bytes)."""
    unit_for, skips, _ = unit_map(layout)
    units, region, skipped = {}, {}, 0
    for addr, data in segments:
        if any(lo <= addr < hi for lo, hi in skips):
            skipped += len(data)
            continue
        pos = 0
        while pos < len(data):
            start, size, ri = unit_for(addr + pos)
            buf = units.get(start)
            if buf is None:
                buf = units[start] = bytearray(b"\xff" * size)
                region[start] = ri
            off = addr + pos - start
            n = min(len(data) - pos, size - off)
            buf[off:off + n] = data[pos:pos + n]
            pos += n
    return units, region, skipped


def group_parts(units):
    """Back-to-back units within one 1 MB window, as [(addr, [unit starts])]."""
    parts = []
    for a in sorted(units):
        if parts:
            pa, members = parts[-1]
            last = members[-1]
            if last + len(units[last]) == a and pa // PART_WINDOW == a // PART_WINDOW:
                members.append(a)
                continue
        parts.append((a, [a]))
    return parts


def units_entry(fid, bid, segments, layout):
    """A kind "units" manifest entry (no name, source, or times yet) and its files {path: bytes}."""
    units, region, skipped = split_units(segments, layout)
    if not units:
        raise Fail("the ELF has nothing to write in the units regions")
    _, _, apps = unit_map(layout)
    d = f"firmware/{bid}/{fid}/"
    files, parts, whole = {}, [], hashlib.sha256()
    for pa, members in group_parts(units):
        data = b"".join(bytes(units[a]) for a in members)
        path = d + f"{pa:08x}.bin"
        files[path] = data
        whole.update(data)
        parts.append({"path": path, "addr": pa, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                      "units": [[a, len(units[a]), zlib.crc32(units[a]) & 0xFFFFFFFF] for a in members]})
    app = [a for a in sorted(units) if region[a] in apps]
    if not app:
        raise Fail("no unit is in a region marked app, so there is nothing for COMMIT to cover")
    base = num(layout["regions"][apps[0]]["base"])
    at = base
    for a in app:
        if a != at:
            raise Fail(f"the application's units must run back to back from 0x{base:08X}; there is a gap at 0x{at:08X}")
        at += len(units[a])
    blob = b"".join(bytes(units[a]) for a in app)
    total = sum(len(v) for v in units.values())
    entry = {"kind": "units", "path": d, "parts": parts, "size": total, "sha256": whole.hexdigest(),
             "commit": {"crc32": zlib.crc32(blob) & 0xFFFFFFFF, "length": len(blob)}}
    return entry, files, {"units": len(units), "skipped": skipped, "app": len(blob)}


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
    def blob(path):
        return base64.b64decode(gh("GET", f"/repos/{full}/git/blobs/{entries[path]}", tok)["content"]) if path in entries else None
    return {"head": head, "tree": tree, "entries": entries, "manifest": blob("manifest.json"), "users": blob("users.json")}


def home_of(roster_bytes, pid, data_full):
    """Where a project's firmware lives: its own repo once it's shared with someone outside (Flasher's
    People & access records that in flasher_data's users.json), else the data repo."""
    try:
        shared = (json.loads(roster_bytes) if roster_bytes else {}).get("shared", {}).get(pid) or {}
    except ValueError:
        raise Fail("users.json in the data repo isn't valid JSON")
    return shared["repo"] if shared.get("repo") and not shared.get("deleted") else data_full


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
    ap.add_argument("--board-only", action="store_true", help="publish only the board's details (no build, no images)")
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
    full = cfg["data_repo"]
    # The board: defined here, or (a string) the id of a board another firmware repo already
    # publishes, read from the manifest. Two repos for one board then never fight over its details.
    board_ref = cfg["board"] if isinstance(cfg["board"], str) else None
    board = {"id": board_ref} if board_ref else cfg["board"]
    bid = board["id"]
    # The project the board belongs to: what People & access shares (README, *Access*).
    proj = cfg.get("project") or {}
    pid, pname = proj.get("id") or board.get("project") or bid, proj.get("name") or board.get("name", bid)
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,47}", pid):
        raise Fail(f"project id {pid!r} may only use a-z, 0-9, _ and -")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,47}", bid):
        raise Fail(f"board id {bid!r} may only use a-z, 0-9, _ and -")
    if not board_ref:
        board = dict(board, project=pid)
        for k in (("touch", "bridge") if board.get("kind") == "bridge" else ("flash", "ram", "dfu")):
            if k not in board:
                raise Fail(f"flasher.json's board needs {k}")

    if a.board_only and board_ref:
        raise Fail("--board-only publishes a board's details, and this flasher.json only names its board")
    items = [] if a.board_only else list_items(cfg, src)
    names = [i["name"] for i in items]
    if a.only:
        missing = [n for n in a.only if n not in names]
        if missing:
            raise Fail("not in " + ("the images" if "images" in cfg else "the examples") + ": " + ", ".join(missing) + " (have " + ", ".join(names) + ")")
        items = [i for i in items if i["name"] in a.only]
    if not items and not a.board_only:
        raise Fail("flasher.json's images is empty" if "images" in cfg else "no sketches in " + str(src / cfg["examples"]))

    top = pathlib.Path(git(src, "rev-parse", "--show-toplevel")).resolve()
    sha = git(src, "rev-parse", "HEAD")
    remote = git(src, "remote", "get-url", "origin")
    m = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", remote)
    repo_name = m.group(1) if m else remote

    if not a.no_build and not a.board_only:
        cmd = list(cfg.get("build", ["bash", "tools/build.sh"]))
        if cmd[0] == "bash":
            cmd[0] = find_bash(a.bash)
        env = None
        if cfg.get("path"):
            # Folders the build's tools live in (a vendor toolchain not on PATH), put first.
            env = dict(os.environ, PATH=os.pathsep.join([str(pathlib.Path(x)) for x in cfg["path"]] + [os.environ.get("PATH", "")]))
            exe = shutil.which(cmd[0], path=env["PATH"])
            if exe:
                cmd[0] = exe
        if "images" in cfg:
            print(f"Building: {' '.join(cfg.get('build', []))} …", flush=True)
        else:
            cmd += [i["rel"] for i in items]
            print(f"Building {len(items)} sketch{'es' if len(items) != 1 else ''}: {' '.join(cmd[1:2])} …", flush=True)
        r = subprocess.run(cmd, cwd=src, env=env)
        if r.returncode:
            raise Fail(f"the build failed (exit {r.returncode})")

    # What every image builds against (the board package, its core and libraries): a change there
    # changes every image, so it counts toward each one's dirty and stale checks.
    built, problems, warnings = [], [], []
    deps = [src / d for d in cfg.get("depends", [])]
    for d in deps:
        if not d.exists():
            raise Fail(f"flasher.json's depends names {d}, which isn't there")
    dep_rels = [str(d.resolve().relative_to(top)).replace("\\", "/") for d in deps]
    dep_newest = max((p.stat().st_mtime for d in deps for p in d.rglob("*") if p.is_file()), default=0)
    dep_dirty = bool(dep_rels) and bool(git(top, "status", "--porcelain", "--untracked-files=no", "--", *dep_rels))
    if dep_dirty:
        warnings.append("the board package (" + ", ".join(dep_rels) + ") has uncommitted changes")

    bridged = (board.get("kind") == "bridge") if not board_ref else None
    for it in items:
        n, binp = it["name"], it.get("elf") or it["bin"]
        if not binp.exists():
            problems.append(f"{n}: {binp} not built")
            continue
        b = binp.read_bytes()
        if it.get("elf"):
            if bridged is False:
                raise Fail(f"{n}: an elf image is for a bridge board (\"kind\": \"bridge\")")
            if "units" not in cfg:
                raise Fail("flasher.json needs units (the erase units) to publish an elf image")
            ue, ufiles, stats = units_entry(it["id"], bid, elf_segments(b), cfg["units"])
            print(f"  {n}: {stats['units']} erase units, {ue['size']} bytes in {len(ue['parts'])} parts; "
                  f"COMMIT covers {stats['app']} bytes; {stats['skipped']} bytes left out (skip ranges)")
        elif bridged:
            raise Fail(f"{n}: a bridge board's image must be an elf (published as erase units)")
        newest = max(newest_in(it["dir"], it["skip"]), dep_newest)
        if binp.stat().st_mtime < newest:
            warnings.append(f"{n}: the .bin is older than its source; build again (drop --no-build)")
        rel = str(it["dir"].resolve().relative_to(top)).replace("\\", "/")
        dirty = dep_dirty or bool(git(top, "status", "--porcelain", "--untracked-files=no", "--", rel))
        if dirty and not a.allow_dirty:
            problems.append(f"{n}: has uncommitted changes (commit them, or pass --allow-dirty to publish marked)")
            continue
        e = {
            "id": it["id"], "board": bid, "name": n, "summary": it["summary"], "description": it["description"],
            "size": len(b), "sha256": hashlib.sha256(b).hexdigest(), "path": f"firmware/{bid}/{it['id']}.bin",
            "source": {"repo": repo_name, "sha": sha, "path": rel, "dirty": dirty},
            "built": datetime.datetime.fromtimestamp(binp.stat().st_mtime, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "_bytes": b, "_files": None,
        }
        if it.get("elf"):
            e.update({k: v for k, v in ue.items()})
            e["_files"] = ufiles
        else:
            e["_files"] = {e["path"]: b}
        built.append(e)

    print(f"\nSource   {repo_name} @ {sha[:10]}  ({src})")
    print(f"Board    {bid}{' (as the manifest has it)' if board_ref else ': ' + board.get('name', bid)}  (project {pid}: {pname})")
    print(f"Data     {full}")

    tok = token()
    repo = read_repo(full, tok)
    if "missing" not in repo:
        home = home_of(repo["users"], pid, full)
        if home != full:
            # Shared with a client or contractor: the project's firmware lives in its own repo now.
            print(f"Target   {home}  (the project is shared; its firmware lives there)")
            full, repo = home, read_repo(home, tok)
            if "missing" in repo:
                raise Fail(f"{home} is {repo['missing']}; check Flasher's People & access")
    if board_ref:
        board = board_from_manifest(repo.get("manifest"), bid, pid, full)
    runs_as = cfg.get("runs_as")
    if runs_as and not runs_on(board, runs_as):
        raise Fail(f"board {bid} doesn't list this firmware's USB id ({runs_as.get('vid')}:{runs_as.get('pid')}) in run or "
                   "runAlso, so Flasher couldn't restart a board running it. Add it to runAlso in the flasher.json that "
                   "defines the board, and publish that first.")

    entries = []
    for e in built:
        if (board.get("kind") == "bridge") != (e.get("kind") == "units"):
            problems.append(f"{e['name']}: board {bid} is {'a bridge board' if board.get('kind') == 'bridge' else 'a DFU board'}, "
                            "so its images must be " + ("an elf" if board.get("kind") == "bridge" else "a .bin"))
            continue
        errs = [] if e.get("kind") == "units" else check_image(e["_bytes"], board)
        if errs:
            problems.append(f"{e['name']}: " + "; ".join(errs))
        else:
            entries.append(e)
    for w in warnings:
        print("  warning: " + w)
    for p in problems:
        print("  skipped: " + p)
    if not entries and not a.board_only:
        raise Fail("nothing to publish")
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    clean = [{k: v for k, v in e.items() if not k.startswith("_")} for e in entries]
    if "missing" in repo:
        print(f"\n{full} is {repo['missing']}. A first publish would write:")
        new_bytes, changed, _ = plan_manifest(None, board, clean, now, (pid, pname))
        for e in entries:
            print(f"  new        {e['path']:<40} {e['size']:>8} bytes  {e['summary'][:60]}")
        print(f"  manifest.json ({len(new_bytes)} bytes)")
        print("\nCreate the repo (private, with a README) before pushing.")
        return 0 if not a.push else 1

    new_bytes, changed, board_changed = plan_manifest(repo["manifest"], board, clean, now, (pid, pname))
    files = {}
    print(f"\nPlan against {full} @ {repo['head'][:10]}:")
    for e in entries:
        had = any(p in repo["entries"] for p in e["_files"])
        state = "changed" if e["id"] in changed and had else "new" if e["id"] in changed else "unchanged"
        fresh = 0
        if e["id"] in changed:
            for path, data in e["_files"].items():
                if repo["entries"].get(path) != git_blob_sha(data):
                    files[path] = data
                    fresh += 1
        print(f"  {state:<10} {e['path']:<40} {e['size']:>8} bytes  {e['summary'][:60]}")
        if len(e["_files"]) > 1 and e["id"] in changed:
            print(f"             {fresh} of {len(e['_files'])} parts to upload; the rest are already there byte for byte")
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
