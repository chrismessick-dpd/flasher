# Flasher (flasher): notes for Claude

Flasher is a static browser tool that flashes prebuilt firmware onto STM32 boards over USB from
Chrome or Edge: the 1200-baud touch over Web Serial, then DfuSe over WebUSB to the chip's ROM
bootloader. Read `README.md` first, and `../CLAUDE.md` for the suite's hard rules.

## Status (2026-11-10)

- **Prototype, in use.** Repos created 2026-11-10 at Chris's OK: `chrismessick-dpd/flasher` (public,
  Pages on) and `chrismessick-dpd/flasher_data` (private, Actions off). The hub links to it as a
  prototype. The name is Flasher (Chris).
- **Published and flashed.** The client board's nine examples were published 2026-11-10 (`flasher_data`
  `f08066f`), and Chris flashed Blink onto a real board from the hosted page: the ROM, the
  1200-baud restart, and the Windows driver all worked.
- **Access (2026-11-10, Chris):** Flasher keeps its own repos and People list ("one tool, one data
  repo set"), not tied to Signoff PL. FTEs see everything; clients and contractors see the projects
  shared with them, each in `review-flasher-<project>` (README, *Access*; `assets/access.js`). Tried
  against `tests/fakegithub.js` and in the page with a fake GitHub; the client project was shared
  under its board id, so the firmware repo's `flasher.json` uses that as its project id (another id
  would publish a second copy into `flasher_data`). Republished in place 2026-11-10 with the
  project name in the manifest.
- **Bootloader hang (2026-11-10):** about 1 restart in 20 left the client board in the ROM
  bootloader with USB up but never enumerated (the host missed the reset's brief disconnect). Fixed
  in that board's package (it drops off USB for 250 ms before resetting; see the firmware repo's
  CLAUDE.md), 150 hammer-test flashes clean. A J-Link toggling `USB->BCDR` DPPU recovers a board
  stuck that way. Flasher remembers
  that a board's update mode has been opened in this browser (`flasher.v1.dfuOk.<vid>:<pid>`), so
  when a restart doesn't bring it back within 6 s it says "The board didn't come back" (press
  reset) instead of offering the picker; without that memory it can't tell a missing board from
  one Chrome hasn't been allowed to see yet.
- **Layout like Signoff EE (2026-11-10, Chris):** a sticky header with Open a .bin file on the right;
  the sidebar lists firmware grouped by project in folding groups, with a search; the Dovetail Signoff
  links fold to icons (`setupToolsFold`, copied from EE's `app.js`; keep it in step).
- **Console (2026-11-10, Chris):** a terminal (`assets/term.js`), so the board's own line editing
  works (history, Tab, Ctrl-L, `clear`). Flash and Console are tabs of one panel; About folds.
  Tried in `?demo` against `FL.fakeusb.shell`; not yet against the board.
- **Two code bases on one board (2026-11-10, Chris; pushed `75a1081`):** the
  client board also runs its STM32CubeIDE firmware, which now takes the same 1200-baud touch. A
  board's `runAlso` lists other firmware USB ids it may be running; Flasher looks for any of them
  (`board.runs`, `FL.serial.matches`/`filters`/`portNames`). `publish.py` publishes a whole-project
  build through `images` (with `path` for a vendor toolchain), and `--board-only` writes only a
  board's details. Chris chose its own FTE-only project for that firmware, with `flasher.json`
  committed in its repo. Published at Chris's OK: the image and its board to `flasher_data`
  (`44cec31`), and `runAlso` on the Arduino board (shared repo `d1ee712`, `--board-only`). Not yet
  tried from the page.
  Then Chris flashed it from the hosted page (2026-11-10).
- **Bridge boards (2026-11-10, Chris; not committed):** a board with no USB of its own, updated
  through a host board's passthrough from the page (README, *Bridge boards*; `assets/sboot.js`,
  simulated by `assets/fakebridge.js`). The client's display is the first: its board and image are
  in `flasher_data` under the FTE-only firmware project once published, with `flasher.json`
  in the display repo. `publish.py` splits the ELF into erase units exactly as the client's own
  host tool does (checked against that tool on the real ELF). Sharing a project
  copies and removes every part (`FL.access.filesOf`). The demo has one: the thermostat's Display &
  Sensor Board through the Main PCBA. The protocol's framing is public at Chris's OK; memory maps
  and USB ids stay in the manifest.

## Rules

- **No client data here.** The page, docs, tests, and `publish.py` stay board-agnostic:
  - Board details (names, USB product strings, button steps) live in the private manifest, and in
    `flasher.json` in the firmware's own repo.
  - The firmware itself lives only in Flasher's private repos.
  - Grep for `etna|koya|1100200|1100201`, and for the client board's name, before any commit.
  - `tools/publish.local.json` is git-ignored because it holds a local path.
- **The demo is the Smart Thermostat** (`tstat-main`, Main PCBA). Its images are generated in
  `catalog.js` (`makeImage`), and it flashes `FL.fakeusb` in the page.
- **Tokens.** The page uses the suite's `signoff.token` (session or local storage). It reads, and
  for an FTE on People & access it writes `users.json`, creates `review-flasher-*` repos, and invites.
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

## Access details that matter

- **The order of a share** (`FL.access.share`): create the repo (or adopt it if it's empty or already
  holds this project), turn Actions off, copy the images and the project's manifest, check every copy
  by git blob SHA, record `shared[project]` in `users.json`, and only then remove the originals from
  `flasher_data`.
- **Manifests stay in `publish.py`'s layout** (`FL.access.dump`: 2-space JSON and a newline), so its
  additive proof still holds after the page moves a project.
- **Saving `users.json`** re-reads it and merges (`model.mergeRosters`, newer wins per entry) before
  writing.
- **Invitations.** A new repo leaves the other FTEs with only an invitation. The page offers waiting
  invitations (Accept) and doesn't count those repos as errors.

## Before finishing a change

1. Run `python tools/stamp_version.py`.
2. Serve the tools folder with preview `signoff-suite-alt` (port 8774), and open
   `flasher/tests/test.html`. It should show PASS (55 tests as of 2026-11-10).
3. Run `python tests/test_publish.py` (24 tests).
4. Check `flasher/index.html?demo` and flash something: the simulated flash takes about 5 s.
5. In the browser pane, scripts are cached: fetch changed files with `{cache: 'reload'}` before
   reloading.
