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


if __name__ == "__main__":
    unittest.main(verbosity=1)
