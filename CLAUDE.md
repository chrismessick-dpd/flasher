# Flasher (flasher): notes for Claude

Flasher is a static browser tool that flashes prebuilt firmware onto STM32 boards over USB from
Chrome or Edge: the 1200-baud touch over Web Serial, then DfuSe over WebUSB to the chip's ROM
bootloader. Read `README.md` first, and `../CLAUDE.md` for the suite's hard rules.

## Status (2026-11-10)

- **Prototype.** Repos created 2026-11-10 at Chris's OK: `chrismessick-dpd/flasher` (public; Pages
  from `main` once Chris turns it on) and `chrismessick-dpd/flasher_data` (private, a README only,
  Actions off). The hub links to it as a prototype.
- **The name is Flasher** (Chris, 2026-11-10).
- **Access** should work the way it does in the rest of the suite (Chris, 2026-11-10; a later step).
  For now the page reads `flasher_data` with whatever `signoff.token` the browser has.
- **Never tried on a real board.** The DfuSe code is tested against `assets/fakeusb.js`, which
  follows dfu-util's request sequence and the ROM's rules as documented. Not yet seen on real
  hardware:
  - the ROM's real answers;
  - Chrome's `interfaceName` on the DFU alternates;
  - the 1200-baud touch on a real board;
  - the Windows driver story.
- **The first real publish** is next (the data repo exists). The dry run works
  (`python tools/publish.py --no-build`).

## Rules

- **No client data here.** The page, docs, tests, and `publish.py` stay board-agnostic:
  - Board details (names, USB product strings, button steps) live in the private manifest, and in
    `flasher.json` in the firmware's own repo.
  - The firmware itself lives only in the data repo.
  - Grep for `etna|koya|1100200|1100201`, and for the client board's name, before any commit.
  - `tools/publish.local.json` is git-ignored because it holds a local path.
- **The demo is the Smart Thermostat** (`tstat-main`, Main PCBA). Its images are generated in
  `catalog.js` (`makeImage`), and it flashes `FL.fakeusb` in the page.
- **Tokens.** The page uses the suite's `signoff.token` (session or local storage), read-only.
  `publish.py` reads `../ee_tools_token.txt` and never prints it. A push needs the dry run's
  `--confirm` code. Show Chris the dry run first.
- **Engine copies.**
  - `assets/vendor/model.js` and `github.js` come from EE; re-copy them with
    `python tools/sync_vendor.py`.
  - `assets/suite.css` is EE's stylesheet; re-copy it with `python tools/sync_suite_css.py`.
  - Never edit the copies.
  - Chris (2026-11-10): Signoff EE and the hub are the style references; build on suite classes
    (`.page`, `.card`, `.proj`, `.sheet`, `.hint`).
- **Severity never by hue alone** (Chris is colorblind): errors use `--issue-hatch` and ✕, warnings
  `--warn-hatch` and ▲.
- **American English, metric, and the serial comma** in UI text, docs, and commit messages.
- **Commit and push only when Chris asks.**

## DfuSe details that matter

- Each DNLOAD (set-address `0x21`, page erase `0x41`, or data at block 2) only happens when
  GETSTATUS is polled. Wait `bwPollTimeout` while the state is dfuDNBUSY.
- Data: set the address per chunk, then block 2, padded to 8 bytes (G4 double words).
- Verify: set the address once, ABORT to idle, then UPLOAD blocks 2, 3, …
- Leave: a set-address to the flash base, then an empty DNLOAD at block 2. The device then drops
  off the bus, so errors after that are success.
- The flash alternate is found by name (`@Internal Flash`), never option bytes. With no names, it is
  alternate 0, and the board's `layout` is used.
- `wTransferSize` is read from the configuration descriptor (2048 if that fails).
- A refused first set-address is reported as possible read protection (RDP).

## Before finishing a change

1. Run `python tools/stamp_version.py`.
2. Serve the tools folder with preview `signoff-suite-alt` (port 8774), and open
   `flasher/tests/test.html`. It should show PASS (30 tests as of 2026-11-10).
3. Run `python tests/test_publish.py` (11 tests).
4. Check `flasher/index.html?demo` and flash something: the simulated flash takes about 5 s.
5. In the browser pane, scripts are cached: fetch changed files with `{cache: 'reload'}` before
   reloading.
