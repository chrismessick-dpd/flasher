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
  project name in the manifest. Then (Chris) the project and its repo were renamed to a generic
  name: GitHub's rename keeps collaborators, the manifest's `projects` key and board `project` change, and
  `users.json` tombstones the old `shared` id (`deleted`, which `model.sharedRepo` honors) beside the new
  one. `flasher.json` must name the new id, or `publish.py` puts a second copy in `flasher_data`.
- **Account pill (2026-11-10, Chris):** "Signed in · N firmware" over the GitHub ID (`.sync-who`, from
  EE's styles), as the suite's sync pill now shows the ID on its second line.
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
- **Settings sheet like Signoff EE's (2026-11-10, Chris; not committed):** the account pill opens
  Settings (`accountSheet`): Appearance, EE's four-step token guide, the token, Remember, a
  read-only Repositories fold, a log, Test connection (`FL.access.load`), and Sign out (with a
  confirm). The name field is kept but hidden and never written (Flasher signs nothing).
- **Bridge boards (2026-11-10, Chris; not committed):** a board with no USB of its own, updated
  through a host board's passthrough from the page (README, *Bridge boards*; `assets/sboot.js`,
  simulated by `assets/fakebridge.js`). The client's display is the first: its board and image are
  in `flasher_data` under the FTE-only firmware project once published, with `flasher.json`
  in the display repo. `publish.py` splits the ELF into erase units exactly as the client's own
  host tool does (checked against that tool on the real ELF). Sharing a project
  copies and removes every part (`FL.access.filesOf`). The demo has one: the thermostat's Display &
  Sensor Board through the Main PCBA. The protocol's framing is public at Chris's OK; memory maps
  and USB ids stay in the manifest.

- **Debug probe page (2026-11-17, Chris: "a web alternative to the ST programmer GUI", ST-LINK with a J-Link
  toggle, MIT license; pushed: `flasher` `33e6841`).** `probe.html` and `assets/probe/` (README, *Debug probe*). Chris chose:
  a new page in Flasher; the H563 and G0B1 first; option bytes edited with a diff and a typed confirmation,
  with the lock-for-good ones refused; registers from ST's SVDs, bundled. `LICENSE` (MIT) added. Research and
  the probe-only access test: `docs/stlink-webusb.md`. Tests: `tests/probe.html` (36) against the simulated
  ST-LINK and J-Link. Tried in `?demo` and `?demo=h5`.
  **Bench, 2026-11-17 (Chris: "whatever bench testing to get things working").** STLINK-V3 (V3J16M9) on a client
  H563, under reset: identified on AP1, 2 MB read in 8.8 s at 3.3 MHz (480 KB/s at 24 MHz), blank sectors in both
  banks erased, programmed at about 180 KB/s with no rewrites, verified, and erased again (whole-flash SHA-256
  unchanged), BOR_LEV written 0 → 1 → 0 (OPTSR back to its original), RCC and GPIOA registers read (a peripheral
  with its clock off returns one stale value everywhere; the page now says so). Fixed on the bench: the H5's flash
  information area refuses byte reads (reads are now always aligned words), and the J-Link reports each SWD bit
  one clock early (bits shift by one, as OpenOCD reads them). J-Link V13 on a G0B1 bridge, hot plug: identified,
  64 KB read at 185 KB/s, chip untouched. Then two longer reads (512 KB) rebooted the J-Link, the second time into
  its bootloader ("BTL"), before any write; the bridge was never halted. Cause not found; batches are now smaller
  and every USB call times out after 5 s, but the J-Link is labeled beta and shouldn't be used for long transfers
  until that's understood. Not tried on hardware: G0 programming and G0 option bytes (the ST-LINK was on the H563).

- **One page, three tabs (2026-11-17, Chris; pushed: `flasher` `3d9e296`).** Designed in `lab/layout.html` (Chris chose
  direction B: tabs across the top, the firmware list kept in the sidebar) and `lab/passthrough.html` (the
  route, concept C). `index.html` has **Serial bootloader**, **Debug probe**, and **Console** tabs (`S.tab`,
  `?tab=`), one pane each (`#view`, `#probe-view`, `#console-view`), so the console stays connected across them.
  Chris's choices: the probe is a tab (its scripts load on first use, `loadProbe`; `assets/probe/app.js` is
  mounted with `FL.probeApp.mount(root, host)` and keeps its events inside `#probe-view`), and it programs the
  sidebar's pick from GitHub (`currentImage`); a file flashed as **Any STM32** tries the 1200-baud restart on
  any port first, then shows BOOT0 steps (`noanswer`); the console opens any port at a chosen rate, and a flash
  of its board pauses it and reopens it after (`pauseConsoleFor`, `resumeConsole`); no draggable console.
  Every update draws its route with a live block map (`assets/route.js`, `directRoute`, `bridgeRoute`; sboot's
  compare progress now names each block, `index`/`differs`, and `checked` follows each read-back). `probe.html`
  redirects to the tab. The probe's Erase & program draws the same route (this computer → the probe → the chip,
  `progRoute`; `setRun` takes the pass and its fraction). Then (Chris): home is the banner and the empty flash tool
  (`emptyToolHtml`), no firmware cards; the probe tab has the bootloader's layout (pushed `af98be2`), nothing under the top bar (the
  page's heading, the connection card `.pb-conn`, and one panel `.pb-panel` whose tabs are its pages). Tests: 62 browser, 36 probe, 24 Python. Tried in `?demo` (direct, bridge, file with
  and without an answer, console pause, probe programming the picked firmware), light, dark, and 375 px. Not
  tried on hardware.

- **Files through the passthrough, and drag and drop (2026-11-17, Chris: "the drag and drop program type
  ability", .hex or .elf only).** A `.hex` or `.elf` dropped on the page (or opened) can go to a bridge board: the
  page splits it into the board's erase units as `publish.py` does (`FL.image.unitsImage`, tested against
  `test_publish.py`'s cases), from the board's `units` layout, which `publish.py` now writes into the board's
  manifest entry (`--board-only` for one already published). A `.hex` or `.elf` for a direct board is flattened at
  its flash base. Files drop anywhere; on the Debug probe tab they go to the probe. `assets/probe/files.js` loads with
  the page. Also: the ⓘ details toggle on flash panels (`flasher.v1.detailsHidden`), and the stacked route centered
  with its left edges aligned. Tried in `?demo` (the display's blocks from a dropped `.hex`, 4 of 24 rewritten).
  The real display board's layout was written at Chris's OK (`--board-only`, `flasher_data` `7810c80`, proven additive, read
  back: only `units` added to its entry). Not yet tried on the board: a `.hex` from its build with Compare only first.

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

## Probe details that matter

- **Sources.** ST-LINK command bytes, response lengths, AP byte, and size limits are probe-rs's
  (`probe-rs/src/probe/stlink/`). Flash sequences, keys, and addresses are ST's HAL and CMSIS headers
  (`%USERPROFILE%/STM32Cube/Repository/STM32Cube_FW_G0_V1.6.3`, `…_H5_V1.6.0`) and the SVDs. Take new ones from
  there, not memory.
- **Addresses above 0x80000000 are negative after `&` in JavaScript.** Use `>>> 0` (two bugs so far).
- **The H5's core is on AP1**; its AP0 reaches only the DBGMCU and ROM table. `Target.findAp` tries both.
- **Program** streams 1 KB blocks with PG set (never resent: `noRetry`) and checks the error bits after each.
  A flash error bit stops the write. A cut transfer (an ST-LINK WAIT partway) can leave a unit half-written, so
  that block's pages or sectors are erased again and rewritten unit by unit (`redo`; the H5 first forces out
  a partial quad-word with FW). On the G0, whether clearing PG drops a half double-word is untested on silicon.
- **Disconnect** switches debug off (DHCSR = key, DEMCR = 0) whenever this session switched it on (`touched`:
  a halt, run, reset, or under-reset connect), so a stray BKPT can't halt the chip later. Hot plug that only
  read leaves DHCSR untouched. Under reset checks S_RESET_ST and says so when NRST had no effect.
- **J-Link batches** keep overrun detection on, so after a WAIT later transactions are refused and the data
  phase is always sent; SELECT and CSW count as done only once acknowledged (`noteSel`). A retry that made
  progress resets the retry count.
- **The ST-LINK's picker** can't be answered by a script: Chrome cancels it. A person picks the probe once.
- **Bench rule.** Ask Chris which board is on the probe before connecting (Under reset resets it), and before
  writing flash or option bytes on a real chip.

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
3. Run `python tests/test_publish.py` (24 tests), and open `flasher/tests/probe.html` (PASS, 36 tests).
4. Check `flasher/index.html?demo` and flash something: the simulated flash takes about 5 s.
5. In the browser pane, scripts are cached: fetch changed files with `{cache: 'reload'}` before
   reloading.
