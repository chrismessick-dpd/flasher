"""Turn an ST SVD file into the compact, gzipped JSON the probe page's Registers view loads.

    python tools/svd_to_json.py "C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeProgrammer/SVD/STM32H563.svd"

Writes assets/probe/svd/<NAME>.json.gz. Secure aliases (SEC_*) are dropped (Flasher works with TrustZone
off), a derived peripheral keeps only its name, base, and the one it copies ("from"), and descriptions are
cut to their first sentence. ST's SVDs are Apache-2.0 (see LICENSE).
"""
import gzip, json, pathlib, re, sys
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent


def num(s, default=None):
    if s is None or s.strip() == "":
        return default
    s = s.strip().lower().replace("#", "0b") if s.strip().startswith("#") else s.strip().lower()
    return int(s, 0)


def short(s, n=140):
    if not s:
        return ""
    s = re.sub(r"\s+", " ", s).strip()
    m = re.match(r"(.+?[.:;])(\s|$)", s)
    s = m.group(1) if m else s
    return s if len(s) <= n else s[: n - 1] + "…"


def fields_of(reg):
    out = []
    for f in reg.iter("field"):
        lsb = num(f.findtext("bitOffset"))
        width = num(f.findtext("bitWidth"))
        if lsb is None:
            rng = f.findtext("bitRange")
            if rng:
                hi, lo = (int(x) for x in rng.strip("[]").split(":"))
                lsb, width = lo, hi - lo + 1
            else:
                lsb, msb = num(f.findtext("lsb")), num(f.findtext("msb"))
                width = msb - lsb + 1
        e = {"n": f.findtext("name"), "l": lsb, "w": width or 1}
        acc = f.findtext("access")
        if acc and acc != "read-write":
            e["a"] = acc
        d = short(f.findtext("description"))
        if d:
            e["d"] = d
        enums = {}
        for ev in f.iter("enumeratedValue"):
            v = ev.findtext("value")
            try:
                enums[str(num(v))] = ev.findtext("name") + (": " + short(ev.findtext("description"), 60) if ev.findtext("description") else "")
            except (ValueError, TypeError):
                pass
        if enums:
            e["e"] = enums
        out.append(e)
    return sorted(out, key=lambda x: x["l"])


def regs_of(p, defaults):
    out = []
    for r in p.iter("register"):
        dim = num(r.findtext("dim"))
        base = {"n": r.findtext("name"), "o": num(r.findtext("addressOffset"))}
        size = num(r.findtext("size"), defaults["size"])
        if size != 32:
            base["s"] = size
        acc = r.findtext("access") or defaults["access"]
        if acc and acc != "read-write":
            base["a"] = acc
        rst = num(r.findtext("resetValue"), defaults["reset"])
        if rst:
            base["r"] = rst
        ra = r.findtext("readAction")
        if ra:
            base["ra"] = ra
        d = short(r.findtext("description"))
        if d:
            base["d"] = d
        base["f"] = fields_of(r)
        if dim:
            inc = num(r.findtext("dimIncrement"))
            idx = (r.findtext("dimIndex") or "").split(",")
            for i in range(dim):
                c = dict(base)
                tag = idx[i] if len(idx) == dim else str(i)
                c["n"] = base["n"].replace("[%s]", tag).replace("%s", tag)
                c["o"] = base["o"] + i * inc
                out.append(c)
        else:
            out.append(base)
    return sorted(out, key=lambda x: x["o"])


def convert(path):
    root = ET.parse(path).getroot()
    name = root.findtext("name")
    defaults = {"size": num(root.findtext("size"), 32), "access": root.findtext("access"), "reset": num(root.findtext("resetValue"), 0)}
    periphs = []
    for p in root.iter("peripheral"):
        pn = p.findtext("name")
        if pn.startswith("SEC_"):
            continue
        e = {"n": pn, "b": num(p.findtext("baseAddress"))}
        grp = p.findtext("groupName")
        if grp:
            e["g"] = grp
        if p.get("derivedFrom"):
            e["from"] = p.get("derivedFrom")
        else:
            d = short(p.findtext("description"))
            if d:
                e["d"] = d
            e["r"] = regs_of(p, defaults)
        periphs.append(e)
    periphs.sort(key=lambda x: x["n"])
    cpu = root.find("cpu")
    return {"name": name, "cpu": cpu.findtext("name") if cpu is not None else "", "p": periphs}


def main():
    for src in sys.argv[1:]:
        data = convert(src)
        out = ROOT / "assets" / "probe" / "svd" / (data["name"] + ".json.gz")
        out.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        out.write_bytes(gzip.compress(raw, 9, mtime=0))
        print(out.relative_to(ROOT), len(data["p"]), "peripherals,", len(raw), "bytes JSON,", out.stat().st_size, "gzipped")


if __name__ == "__main__":
    main()
