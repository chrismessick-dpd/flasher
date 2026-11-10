"""Tests for tools/publish.py's pure parts: python tests/test_publish.py"""
import json, pathlib, sys, unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "tools"))
import publish as P  # noqa: E402

BOARD = {"id": "test-g4", "name": "Test board", "flash": {"base": "0x08000000", "size": "0x80000"},
         "ram": {"base": "0x20000000", "size": "0x1C000"}, "dfu": {"vid": "0x0483", "pid": "0xDF11"}}
NOW, LATER = "2026-11-10T12:00:00Z", "2026-11-11T09:30:00Z"


def image(size=4096, sp=0x2001C000, reset=0x08000199):
    return sp.to_bytes(4, "little") + reset.to_bytes(4, "little") + bytes(size - 8)


def entry(fid, sha="a" * 64, desc="Blinks."):
    return {"id": fid, "board": "test-g4", "name": fid.title(), "summary": desc, "description": desc, "size": 10, "sha256": sha,
            "path": f"firmware/test-g4/{fid}.bin", "source": {"repo": "o/r", "sha": "1" * 40, "path": "ex/" + fid, "dirty": False}, "built": NOW}


class HeaderComment(unittest.TestCase):
    def test_paragraphs(self):
        s, d = P.header_comment("// First line\n// goes on.\n//\n// Second paragraph.\n#include <x.h>\n// not this\n")
        self.assertEqual(s, "First line goes on.")
        self.assertEqual(d, "First line\ngoes on.\n\nSecond paragraph.")

    def test_keeps_indent_and_none(self):
        self.assertEqual(P.header_comment("//   help   all\n")[1], "  help   all")
        self.assertEqual(P.header_comment("#include <x.h>\n"), ("", ""))


class CheckImage(unittest.TestCase):
    def test_good_and_top_of_ram(self):
        self.assertEqual(P.check_image(image(), BOARD), [])

    def test_bad(self):
        self.assertTrue(P.check_image(image(sp=0x2001C004), BOARD))
        self.assertTrue(P.check_image(image(reset=0x08000198), BOARD))
        self.assertTrue(P.check_image(image(reset=0x08002001), BOARD))
        self.assertTrue(P.check_image(image(size=0x80008), BOARD))
        self.assertTrue(P.check_image(b"\x00" * 4, BOARD))

    def test_ids(self):
        self.assertEqual(P.fw_id("ChoppedPWMV2"), "choppedpwmv2")
        self.assertEqual(P.fw_id("Display Link_2"), "display-link-2")


class PlanManifest(unittest.TestCase):
    def test_first_publish(self):
        b, changed, bc = P.plan_manifest(None, BOARD, [entry("blink")], NOW)
        m = json.loads(b)
        self.assertEqual(changed, ["blink"])
        self.assertTrue(bc)
        self.assertEqual(m["firmware"][0]["published"], NOW)
        self.assertNotIn("id", m["boards"]["test-g4"])

    def test_additive_and_unchanged(self):
        old, _, _ = P.plan_manifest(None, BOARD, [entry("blink"), entry("pulse")], NOW)
        # Republishing the same builds changes nothing.
        same, changed, bc = P.plan_manifest(old, BOARD, [entry("blink"), entry("pulse")], LATER)
        self.assertEqual((same, changed, bc), (old, [], False))
        # A new build of one: only it changes, in place; the other keeps its date.
        new, changed, _ = P.plan_manifest(old, BOARD, [entry("blink", sha="b" * 64)], LATER)
        m = json.loads(new)
        self.assertEqual(changed, ["blink"])
        self.assertEqual([f["id"] for f in m["firmware"]], ["blink", "pulse"])
        self.assertEqual(m["firmware"][0]["published"], LATER)
        self.assertEqual(m["firmware"][1]["published"], NOW)
        self.assertEqual(m["updated"], LATER)

    def test_other_boards_untouched(self):
        other = dict(BOARD, id="other")
        old, _, _ = P.plan_manifest(None, other, [dict(entry("x"), board="other", path="firmware/other/x.bin")], NOW)
        new, changed, _ = P.plan_manifest(old, BOARD, [entry("x")], LATER)
        m = json.loads(new)
        self.assertEqual(sorted(m["boards"]), ["other", "test-g4"])
        self.assertEqual([(f["board"], f["id"]) for f in m["firmware"]], [("other", "x"), ("test-g4", "x")])

    def test_refuses_foreign_layout(self):
        old = json.dumps({"format": 1, "boards": {}, "firmware": []}).encode()   # one line, not this script's layout
        with self.assertRaises(P.Fail):
            P.plan_manifest(old, BOARD, [entry("blink")], NOW)
        with self.assertRaises(P.Fail):
            P.plan_manifest(P.dump({"format": 2}), BOARD, [entry("blink")], NOW)

    def test_confirm_code_ignores_times_only(self):
        bin_a, bin_b = image(), image(reset=0x080001A1)
        dry, _, _ = P.plan_manifest(None, BOARD, [entry("blink")], NOW)
        later = json.loads(P.plan_manifest(None, BOARD, [entry("blink")], LATER)[0])
        later["firmware"][0]["built"] = LATER                    # a rebuild with the same bytes
        later = P.dump(later)
        self.assertNotEqual(dry, later)
        code = P.confirm_code("c0ffee", {"manifest.json": dry, "firmware/test-g4/blink.bin": bin_a})
        self.assertEqual(code, P.confirm_code("c0ffee", {"manifest.json": later, "firmware/test-g4/blink.bin": bin_a}))
        self.assertNotEqual(code, P.confirm_code("c0ffee", {"manifest.json": later, "firmware/test-g4/blink.bin": bin_b}))
        self.assertNotEqual(code, P.confirm_code("beef00", {"manifest.json": dry, "firmware/test-g4/blink.bin": bin_a}))
        other = P.plan_manifest(None, BOARD, [entry("blink", desc="Different.")], NOW)[0]
        self.assertNotEqual(code, P.confirm_code("c0ffee", {"manifest.json": other, "firmware/test-g4/blink.bin": bin_a}))

    def test_project_recorded_and_proven(self):
        old, _, _ = P.plan_manifest(None, BOARD, [entry("blink")], NOW)              # no projects map yet
        new, changed, bc = P.plan_manifest(old, dict(BOARD, project="gen"), [entry("blink")], LATER, ("gen", "Thermostat"))
        m = json.loads(new)
        self.assertTrue(bc)
        self.assertEqual(changed, [])
        self.assertEqual(m["projects"], {"gen": {"name": "Thermostat"}})
        self.assertEqual(m["boards"]["test-g4"]["project"], "gen")
        same, changed, bc = P.plan_manifest(new, dict(BOARD, project="gen"), [entry("blink")], LATER, ("gen", "Thermostat"))
        self.assertEqual((same, changed, bc), (new, [], False))
        renamed, _, bc = P.plan_manifest(new, dict(BOARD, project="gen"), [entry("blink")], LATER, ("gen", "Thermostat 2"))
        self.assertTrue(bc)
        self.assertEqual(json.loads(renamed)["projects"]["gen"]["name"], "Thermostat 2")

    def test_home_of(self):
        roster = json.dumps({"schema": 1, "users": {}, "shared": {
            "gen": {"id": "gen", "repo": "o/review-flasher-gen"}, "old": {"id": "old", "repo": "o/review-flasher-old", "deleted": True}}}).encode()
        self.assertEqual(P.home_of(roster, "gen", "o/flasher_data"), "o/review-flasher-gen")
        self.assertEqual(P.home_of(roster, "old", "o/flasher_data"), "o/flasher_data")
        self.assertEqual(P.home_of(roster, "other", "o/flasher_data"), "o/flasher_data")
        self.assertEqual(P.home_of(None, "gen", "o/flasher_data"), "o/flasher_data")
        with self.assertRaises(P.Fail):
            P.home_of(b"{not json", "gen", "o/flasher_data")

    def test_git_blob_sha(self):
        self.assertEqual(P.git_blob_sha(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a")



class Images(unittest.TestCase):
    """flasher.json's images: one firmware built as a whole, rather than a folder of sketches."""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.src = pathlib.Path(self.tmp.name)
        (self.src / "app" / "build").mkdir(parents=True)
        (self.src / "app" / "main.c").write_text("int main(void) { return 0; }" + chr(10))

    def tearDown(self):
        self.tmp.cleanup()

    def test_items(self):
        cfg = {"images": [{"name": "Thermostat App", "source": "app", "output": "app/build/app.bin", "exclude": ["app/build"],
                           "description": "The app." + chr(10) + "All of it." + chr(10) * 2 + "More."}]}
        it = P.list_items(cfg, self.src)[0]
        self.assertEqual((it["id"], it["summary"], it["rel"]), ("thermostat-app", "The app. All of it.", "app"))
        self.assertEqual(it["bin"], self.src / "app" / "build" / "app.bin")

    def test_bad_items(self):
        for bad in ([{"name": "x", "source": "app"}], [{"name": "x", "source": "nope", "output": "a.bin"}],
                    [{"name": "A b", "source": "app", "output": "a"}, {"name": "a-b", "source": "app", "output": "b"}],
                    [{"name": "x", "id": "Bad Id", "source": "app", "output": "a"}]):
            with self.assertRaises(P.Fail):
                P.list_items({"images": bad}, self.src)

    def test_newest_skips_the_build(self):
        import os
        os.utime(self.src / "app" / "main.c", (1000, 1000))
        out = self.src / "app" / "build" / "app.bin"
        out.write_bytes(b"x")
        os.utime(out, (5000, 5000))
        self.assertEqual(P.newest_in(self.src / "app", [self.src / "app" / "build"]), 1000)
        self.assertEqual(P.newest_in(self.src / "app", []), 5000)


class BoardRef(unittest.TestCase):
    """A second firmware repo for a board names it by id and takes its details from the manifest."""
    MAN = json.dumps({"format": 1, "boards": {"test-g4": dict({k: v for k, v in BOARD.items() if k != "id"}, project="tstat",
        run={"vid": "0x0483", "pid": "0x5740"}, runAlso=[{"vid": "0x1234", "pid": "0x0007"}])}, "firmware": []}).encode()

    def test_found_and_runs(self):
        b = P.board_from_manifest(self.MAN, "test-g4", "tstat", "o/r")
        self.assertEqual(b["id"], "test-g4")
        self.assertTrue(P.runs_on(b, {"vid": "0x1234", "pid": "0x0007"}))
        self.assertTrue(P.runs_on(b, {"vid": "0x0483", "pid": 0x5740}))
        self.assertFalse(P.runs_on(b, {"vid": "0x1234", "pid": "0x5740"}))
        # Unchanged details: publishing under the reference never rewrites the board.
        _, _, changed = P.plan_manifest(None, b, [], NOW)
        old, _, _ = P.plan_manifest(None, b, [entry("blink")], NOW)
        _, _, bc = P.plan_manifest(old, b, [entry("blink")], LATER)
        self.assertFalse(bc)

    def test_missing_or_other_project(self):
        with self.assertRaises(P.Fail):
            P.board_from_manifest(self.MAN, "other", "tstat", "o/r")
        with self.assertRaises(P.Fail):
            P.board_from_manifest(self.MAN, "test-g4", "elsewhere", "o/r")
        with self.assertRaises(P.Fail):
            P.board_from_manifest(None, "test-g4", "tstat", "o/r")

def elf32(segments):
    """A minimal little-endian ELF32 file with one PT_LOAD per (paddr, bytes)."""
    import struct
    ph = 52
    data_at = ph + 32 * len(segments)
    head = bytearray(b"\x7fELF" + bytes([1, 1, 1]) + bytes(9))
    head += struct.pack("<HHIIIIIHHHHHH", 2, 40, 1, 0, ph, 0, 0, 52, 32, len(segments), 40, 0, 0)
    phs, body, at = bytearray(), bytearray(), data_at
    for paddr, b in segments:
        phs += struct.pack("<IIIIIIII", 1, at, paddr | 0x10000000, paddr, len(b), len(b), 5, 4)
        body += b
        at += len(b)
    return bytes(head + phs + body)


LAYOUT = {"skip": [["0x0800C000", "0x08010000"]],
          "regions": [{"base": "0x08010000", "sizes": ["0x8000", "0x10000", "0x10000"], "app": True},
                      {"base": "0x70000000", "end": "0x70400000", "unit": "0x10000"}]}


class Units(unittest.TestCase):
    """Bridge boards: an ELF split into erase units, as the reference host tool lays them out."""

    def test_crc_vector(self):
        import zlib
        self.assertEqual(zlib.crc32(b"123456789") & 0xFFFFFFFF, 0xCBF43926)

    def test_split(self):
        segs = P.elf_segments(elf32([(0x0800C000, b"SWDP"), (0x08010000, b"\x01" * 0x8010), (0x7000FFF0, b"\x02" * 0x20)]))
        self.assertEqual([a for a, _ in segs], [0x0800C000, 0x08010000, 0x7000FFF0], "load addresses")
        units, region, skipped = P.split_units(segs, LAYOUT)
        self.assertEqual(skipped, 4, "the record sector is left out")
        self.assertEqual(sorted(units), [0x08010000, 0x08018000, 0x70000000, 0x70010000], "a segment spills into the next unit")
        self.assertEqual(len(units[0x08018000]), 0x10000)
        self.assertEqual(units[0x08018000][:0x10], b"\x01" * 0x10)
        self.assertEqual(units[0x08018000][0x10:0x20], b"\xff" * 0x10, "0xFF past the image")
        self.assertEqual(units[0x70000000][0xFFF0:], b"\x02" * 0x10)
        self.assertEqual((region[0x08010000], region[0x70010000]), (0, 1))

    def test_outside(self):
        with self.assertRaises(P.Fail):
            P.split_units([(0x08000000, b"boot")], LAYOUT)
        with self.assertRaises(P.Fail):
            P.elf_segments(b"MZ" + bytes(60))

    def test_entry(self):
        import zlib
        segs = [(0x08010000, b"\x01" * 0x100), (0x08018000, b"\x03" * 0x10)] + [(0x70000000 + k * 0x10000, bytes([k]) * 0x10000) for k in range(20)]
        e, files, stats = P.units_entry("disp", "b", segs, LAYOUT)
        self.assertEqual(e["kind"], "units")
        self.assertEqual(e["path"], "firmware/b/disp/")
        self.assertEqual([p["addr"] for p in e["parts"]], [0x08010000, 0x70000000, 0x70100000], "1 MB windows")
        self.assertEqual(e["parts"][1]["size"], 0x100000)
        self.assertEqual(sorted(files), [p["path"] for p in e["parts"]])
        self.assertEqual(e["parts"][0]["path"], "firmware/b/disp/08010000.bin")
        app = files["firmware/b/disp/08010000.bin"]
        self.assertEqual(e["commit"], {"crc32": zlib.crc32(app) & 0xFFFFFFFF, "length": 0x18000})
        u = e["parts"][1]["units"][3]
        self.assertEqual(u, [0x70030000, 0x10000, zlib.crc32(bytes([3]) * 0x10000) & 0xFFFFFFFF])
        self.assertEqual(e["size"], sum(len(b) for b in files.values()))
        self.assertEqual(stats["units"], 22)

    def test_app_gap(self):
        with self.assertRaises(P.Fail):
            P.units_entry("disp", "b", [(0x08018000, b"\x01")], LAYOUT)

    def test_republish_is_the_same(self):
        segs = [(0x08010000, b"\x01" * 0x100)]
        e1, _, _ = P.units_entry("disp", "b", segs, LAYOUT)
        old, _, _ = P.plan_manifest(None, BOARD, [dict(entry("disp"), **e1)], NOW)
        _, changed, _ = P.plan_manifest(old, BOARD, [dict(entry("disp"), **e1)], LATER)
        self.assertEqual(changed, [])
        e2, _, _ = P.units_entry("disp", "b", [(0x08010000, b"\x02" * 0x100)], LAYOUT)
        _, changed, _ = P.plan_manifest(old, BOARD, [dict(entry("disp"), **e2)], LATER)
        self.assertEqual(changed, ["disp"], "new parts change the entry")

if __name__ == "__main__":
    unittest.main(verbosity=1)
