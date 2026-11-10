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
  against `tests/fakegithub.js` and in the page with a fake GitHub; no real share yet. The live
  manifest has no `projects` map until the next publish (its dry run adds the project).
- **Layout like Signoff EE (2026-11-10, Chris):** a sticky header with Open a .bin file on the right;
  the sidebar lists firmware grouped by project in folding groups, with a search; the Dovetail Signoff
  links fold to icons (`setupToolsFold`, copied from EE's `app.js`; keep it in step).
- **Console (2026-11-10, Chris):** a terminal (`assets/term.js`), so the board's own line editing
  works (history, Tab, Ctrl-L, `clear`). Flash and Console are tabs of one panel; About folds.
  Tried in `?demo` against `FL.fakeusb.shell`; not yet against the board.

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
   `flasher/tests/test.html`. It should show PASS (42 tests as of 2026-11-10).
3. Run `python tests/test_publish.py` (13 tests).
4. Check `flasher/index.html?demo` and flash something: the simulated flash takes about 5 s.
5. In the browser pane, scripts are cached: fetch changed files with `{cache: 'reload'}` before
   reloading.
