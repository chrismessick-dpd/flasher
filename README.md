# Flasher

Flash prebuilt firmware onto a board from Chrome or Edge, with no Arduino IDE. Pick the firmware,
plug the board in by USB, and click **Flash board**. Part of the Dovetail Signoff suite.

- **Real use:** the firmware list and images come from Flasher's private repos, read with the suite's
  GitHub sign-in. FTEs see every project; clients and contractors see only the projects shared with
  them (*Access*). Every image is checked against its SHA-256 before it's flashed.
- **One page, three tabs** across the top bar (Chris, 2026-11-17): **Serial bootloader** (flash over USB
  through the chip's ROM bootloader), **Debug probe** (an ST-LINK or J-Link, *Debug probe*), and **Console**
  (a terminal on any serial port, *The console*). The firmware list stays in the sidebar for all three. Each
  tab keeps its own pane, so the console stays connected while you flash or use the probe.
- **Signed out**, a file from this computer, the probe, and the console all work; only the projects'
  firmware needs GitHub.
- **The Serial bootloader tab opens on its tool with nothing picked** (the route, the steps, and a waiting
  Flash button), as the Debug probe tab opens on its tool before a probe is connected; firmware is picked
  in the sidebar. Both tabs share one layout: the page's heading, a card (About this firmware, or the probe's
  connection), then one panel with tabs (Flash, or the probe's pages).
- **The route** above every update shows where it goes, live: this computer → the board, or this computer →
  the host board → the bridge board, each stop saying what it's doing, with a block map of the image under it
  (`assets/route.js`; designed in `lab/passthrough.html`).
- **`?demo`:** the suite's made-up Smart Thermostat for Acme Climate. It flashes a board simulated
  in the page, so it runs anywhere and touches no USB.
- **A file from this computer**, first in the sidebar, flashes a `.bin` as any STM32 (*How a flash works*).

It's a static page with no build step and no outside scripts. Serve the tools folder and open
`flasher/index.html`, or use its GitHub Pages address. WebUSB and Web Serial need https or
localhost.

## How a flash works

The boards are STM32s. The chip's ROM has a USB DFU bootloader (USB `0483:DF11`) that can't be erased,
so a board never needs a first flash by other means, and a failed flash can always be retried.

1. **Restart into the bootloader.** If the board is running firmware that supports it, Flasher
   opens its USB serial port at 1200 baud and drops DTR (Web Serial), as the Arduino IDE does. The
   firmware then reboots into the ROM bootloader. A blank board, or one whose firmware doesn't
   listen, is put there by hand; the board's own steps come from its entry in the manifest. A file
   flashed as **Any STM32** tries the same restart on whichever serial port is picked; if no board comes
   back in update mode, Flasher says the board didn't answer and shows the BOOT0 steps, with
   **It's in update mode** to carry on.
2. **Erase, write, and verify** over WebUSB with ST's DfuSe extensions (`assets/dfuse.js`):
   - set the address and erase each page the image covers;
   - write it in transfer-size chunks (each one a set-address, then block 2);
   - read the whole image back with UPLOAD and compare it.
3. **Start it:** a set-address to the start of flash plus an empty download. The board resets and
   leaves the bus.

Each browser picker needs a click. The first time on a computer, a flash takes two:
1. pick the running board's serial port;
2. pick “DFU in FS Mode”.

After that, the browser remembers both and a flash is one click.

Before anything is erased, an image must:
- fit the board's flash;
- start with a stack pointer inside its RAM (the top of RAM counts);
- have an odd reset vector inside the image.

ELF and Intel HEX files are recognized and refused with a pointer to the `.bin`.

## Bridge boards

Some boards have no USB port of their own: a UART bootloader, reached through another board (the
host) that turns its USB serial port into a passthrough. Flasher updates them the same way from the
page, with Web Serial only (`assets/sboot.js`):

1. The host's firmware gets a baud-rate touch (`touchBaud`, 2400 by default), and comes back on USB
   as the passthrough port (`bridge`), with the board held in its bootloader. The first time,
   Chrome's list needs a click for each port; after that it's one click.
2. Flasher asks the bootloader who it is (INFO) and checks it against the board's `expect`, then
   moves the link to `fastBaud` if the board has one (SET_BAUD, then close and reopen at that rate).
3. It asks the CRC-32 of every erase unit in the image, downloads only the parts that hold a unit
   that differs, checks those against their CRCs, and only then begins: BEGIN, then erase, write
   (4 KB at a time, skipping blocks that are all 0xFF), and read back each unit, then COMMIT and GO.
   **Compare only** stops after the CRCs and changes nothing.
4. Opening the passthrough at `exitBaud` (1200) sends the host back to its own firmware, which
   restarts the board. That happens after a failure too. A board whose update was begun and not
   finished waits in its bootloader until an update finishes, so an interrupted update is run again.

**A file from this computer** reaches a bridge board too: drop a `.hex` or `.elf` on the page (or Open a
file…) and pick the board, marked "(through its passthrough)". The page splits the file into the board's
erase units exactly as `publish.py` splits a published ELF (`FL.image.unitsImage`: each unit filled with 0xFF
and the image laid over it, its CRC-32, parts in 1 MB windows, and COMMIT over the application's units), then
updates it as above, Compare only included. It needs the board's `units` layout in the manifest, which
`publish.py` writes with the board (`--board-only` adds it to a board already published). A `.bin` is refused
for these boards: it has no addresses, and their image spans more than one memory. The file must hold the
application from its region's base, since COMMIT covers it.

**Passthrough systems** (FTEs and `?demo`; `docs/releases-and-passthrough.md`) need no manifest entry at all.
*New passthrough system* in the sidebar opens a diagram of this computer, the **host** (the bridge), the
**link**, and the **remote**; click a block to set it up. The host keeps running its own firmware with the
passthrough, and its USB ids are optional (they only narrow Chrome's list). The link takes the protocol's rates
(knock 2400, link 1 Mbaud, fast 4 Mbaud, exit 1200). The remote takes a `.hex` or `.elf`. When its bootloader
answers INFO, Flasher works out its erase units from the chip's sector table (`assets/sectors.js`, the STM32F7
family and the H56x/H57x so far) and INFO's application and external flash regions (`FL.image.layoutFromInfo`), splits the file,
and updates it as above. The first time, Chrome's second list is unfiltered: pick the port that appeared after the
knock. Flasher uses it only once it answers INFO, remembers its USB id with the system, and sends the exit touch
only to a port that answered (a 1200-baud open resets many boards). Systems are kept in this browser: the list in
localStorage (`flasher.v1.systems`), each remote's file in IndexedDB (`flasher-systems`).

INFO may be longer than its 40 bytes, within protocol 1: `qspiBlock` (u32 at offset 40, the external flash erase
block; 0 = unknown, and Flasher assumes 64 KB) and `board` (16 ASCII bytes at offset 44, NUL-padded). Older pages
ignore them; with an older bootloader, Flasher assumes 64 KB blocks and says so in the log.

The protocol is Dovetail's serial bootloader protocol 1: frames of `55 A5 | cmd | seq | len16 |
payload | crc32` (responses `5A C3`, `cmd | 0x80`, a status byte first), zlib's CRC-32 over
everything after the sync. A response to an older request is read past; only a timeout or a
damaged-frame answer resends. A COMMIT whose answer was lost is refused when resent; Flasher then
reads the record from INFO.

## Windows driver

Chrome and Edge reach a USB device on Windows only when it uses WinUSB. The board's serial port
uses Windows' built-in CDC driver and needs nothing. The DFU bootloader needs WinUSB once per
computer:

- **ST's driver.** STM32CubeProgrammer ships it as
  `Drivers\DFU_Driver\STM32Bootloader.inf`. The copy checked on 2026-11-10 (version 1.3.0, and 1.1.0
  before it) binds WinUSB (`Include = winusb.inf`) and registers ST's own device interface GUID. So on a
  computer where the Arduino IDE already uploads to these boards, the browser should see the board with
  nothing more to do. This is not yet tried with a board.
- **Zadig** (Options › List all devices › “DFU in FS Mode” › WinUSB) works where CubeProgrammer
  isn't installed. Zadig's WinUSB doesn't register ST's interface GUID, so STM32CubeProgrammer, and
  through it the Arduino IDE's DFU uploads, may stop finding the board. That is expected from how
  the two installs differ, but not yet seen. To undo it: Device Manager › the board (in DFU mode) ›
  Uninstall device › tick “Attempt to remove the driver”, replug, and run ST's `STM32Bootloader.bat`.

The page's *Windows driver help* says the same. macOS needs nothing; Linux needs a udev rule (in
the page).

## Access

Flasher keeps its own data, like each tool in the suite ("one tool, one data repo set"), with its own
People list. It isn't tied to Signoff PL's sharing.

- **`flasher_data`** (FTEs only) holds `users.json` (the People list, in the Signoff engine's roster
  format: `users[login] = { name, role, projects }`, `shared[project] = { repo, name }`) and every
  project that no one outside the team has been given.
- **`review-flasher-<project>`**, one private repo per shared project, holds that project's
  `manifest.json` and `firmware/`. Its collaborators are the FTEs and that project's clients and
  contractors.
- **Who sees what.** GitHub enforces it. An FTE is anyone whose token opens `flasher_data`; the page
  then reads it and every shared repo it lists. Anyone else sees the `review-flasher-*` repos their
  token can list. An invitation not yet accepted is offered on the page with an Accept button.
- **People & access** (sidebar, FTEs only) works like Signoff EE's People page:
  - Add person: name, GitHub username, and role (FTE, Client, or Contractor; a client and a contractor
    get the same access).
  - An FTE is invited to `flasher_data` and every shared repo.
  - Giving a client or contractor a project moves that project out of `flasher_data` into its own
    repo the first time (`FL.access.share`), and invites the FTEs and them. The move copies, checks the
    copy, records it in `users.json`, and only then removes the originals.
  - Taking a project away, changing a role, or removing a person takes back the access it gave.
  - Each row's GitHub access says Has access, Invited, or what's missing, with Fix.
  - On a personal account only the owner (`chrismessick-dpd`) can create repos and invite.
- **Projects.** A project is a set of boards: a board's `project` (else the board itself), named in the
  manifest's `projects` map. The firmware repo's `flasher.json` sets it (`project`).

## The console

The Console tab is a small terminal (`assets/term.js`) on any serial port: a board running its firmware, a
USB-UART cable, or a probe's virtual COM port. **Choose a port…** opens Chrome's list of every port, or,
signed in, only one board's (the menu beside it); the rate is a menu, 115200 by default (never 1200, which
restarts an Arduino-style board into its bootloader). Every key goes to the board as a
terminal sends it, so a firmware console that edits its own line works as it does in PuTTY: Up and Down recall history, Tab completes, Ctrl-L redraws, and `clear` clears.
- **Keys.** Ctrl-C copies when text is selected, else goes to the board. Paste sends the text, with
  each line end as Enter.
- **Drawing.** The terminal draws `
`, `
`, backspace, tabs, erase in line and in screen, and
  cursor moves. Colors and other sequences are dropped.
- **Typing.** Keys go through a hidden text field, as in xterm.js, so phone keyboards, dictation, and
  input methods work.
- **Clear** clears only the window; **Save log…** saves it as text.
- **Flashing** the board the console is on (from the Serial bootloader tab) pauses the console, since the
  restart needs the port, and reopens it on the board's new port when the flash ends, whether it worked or
  not. A console on another device stays open. Picking other firmware never closes it.

## The data repos

`flasher_data` and each shared project's repo (`FL.config` in `assets/catalog.js`):

A private repo, `chrismessick-dpd/flasher_data` (`FL.config` in `assets/catalog.js`):

```
manifest.json
firmware/<board>/<id>.bin
users.json            flasher_data only: the People list
```

`manifest.json`, format 1:

```json
{
  "format": 1,
  "updated": "2026-11-10T12:00:00Z",
  "projects": { "<project id>": { "name": "…" } },
  "boards": {
    "<board id>": {
      "name": "…", "mcu": "…", "project": "<project id>",
      "flash": { "base": "0x08000000", "size": "0x80000" },
      "ram":   { "base": "0x20000000", "size": "0x1C000" },
      "dfu":   { "vid": "0x0483", "pid": "0xDF11", "name": "DFU in FS Mode" },
      "run":   { "vid": "0x0483", "pid": "0x5740", "name": "<USB product string>" },
      "runAlso": [{ "vid": "0x…", "pid": "0x…", "name": "<another firmware's product string>" }],
      "detach": [{ "vid": "0x…", "pid": "0x…", "name": "<firmware with a DFU runtime interface>" }],
      "touchBaud": 1200,
      "layout": "@Internal Flash  /0x08000000/256*02Kg",
      "manualDfu": ["step", "step"],
      "notes": "…"
    }
  },
  "firmware": [
    { "id": "blink", "board": "<board id>", "name": "Blink", "summary": "…", "description": "…",
      "size": 31000, "sha256": "…", "path": "firmware/<board id>/blink.bin",
      "source": { "repo": "owner/name", "sha": "<git sha>", "path": "<sketch folder>", "dirty": false },
      "built": "…", "published": "…" }
  ]
}
```

- Boards live in the manifest, not in this public repo, so a client's board details stay private.
  A new board is a new `board` in a firmware repo's `flasher.json` (below), with no change here.
- `run` is optional. Without it there is no 1200-baud touch and the board is always put in DFU mode
  by hand.
- `runAlso` lists the USB ids of other firmware the same board may be running (a second code base
  built for it), each restarted with the same touch. Flasher looks for any of them, and the browser's
  list offers them all. It is kept apart from `run` so an older page still reads the manifest.
- `detach` lists the USB ids of firmware the board may be running that has no serial port but a DFU
  runtime interface (DFU 1.1 runtime mode: class 0xFE, subclass 1, protocol 1), such as candleLight.
  Flasher restarts a board running it with DFU_DETACH over WebUSB instead of the touch, then writes
  through the ROM bootloader as usual. It finds such a board without a list once this browser has
  opened it. Otherwise the DFU list offers it beside the bootloader, and picking it restarts the
  board. With `bitWillDetach` the firmware leaves the bus by itself; without it, Flasher resets the
  device. On Windows, the runtime interface needs the WinUSB driver (Microsoft OS descriptors).
- `layout` is the DfuSe layout to use if the browser can't read the device's alternate setting names.
- A bridge board (*Bridge boards* above) is `"kind": "bridge"`, with `touch` (the host firmware's USB
  ids, a list), `bridge` (the passthrough port's id), `touchBaud`, `exitBaud`, `linkBaud`,
  `fastBaud`, `expect` (`device`, `appBase`, `qspiBase`, `singleBank`, as INFO reports them), and `units`
  (its erase units, from `flasher.json`, for files from a computer). It
  has no `flash`, `ram`, or `dfu`. Its firmware is `"kind": "units"`: `path` is a folder,
  `parts` lists its files (`<path><8 hex digits of the address>.bin`, each with `addr`, `size`,
  `sha256`, and `units`: `[addr, size, crc32]` back to back), `size` is their total, and `commit`
  (`crc32`, `length`) is what COMMIT sends, over the units in the application's region.
- Numbers may be JSON numbers or `"0x…"` strings.
- Entries that don't validate are skipped and listed on the page (`FL.image.cleanManifest`).

## Working and Released projects

The sidebar (2026-11-17, Chris; design: `docs/working-projects.md`) has two parts under *A file from this computer*:

- **Working projects:** Flasher's own, from the manifests (`flasher_data` and the shared `review-flasher-*`
  repos), each with its images and saved passthrough systems. A project made here (*+ New project*, FTEs) stays
  in this browser, marked *Not saved*, until Save; Discard drops it. A saved one has Delete (its entries and
  files go; git history keeps them; a shared project must be unshared first). *Unsorted* holds systems made
  outside a project. The › beside a project opens its page: rename, images (*Upload an image…*: a `.bin`,
  `.hex`, or `.elf` stored as it is), boards (*Define a board…*), systems (*New passthrough system*).
- **Released projects:** Signoff FW's targets by their FW project, each target's releases under it (below).
- **An image's Name and Project** sit in its About card's header for FTEs, with Save and Discard. An image can
  move to another project in its repo on its own; moving it to a project in another repo moves its board, with
  all the board's images.
- **Systems** have Save (asking which project when they have none), and once saved, Discard changes and Delete.
- **Every save** reads the head and `manifest.json`, changes only the entries it names (checked: the manifest
  with them put back is the old one, byte for byte), and commits on that head (`putFiles { head }`), reading
  again and re-applying when someone else saved first. The new manifest entries are `systems`, firmware
  `kind: "file"` (`format`, `parts`), a firmware's own `project`, and `edited`, which `publish.py` respects:
  a republish never changes a name or project an FTE edited.

## Releases from Signoff FW

A second firmware source beside the manifest (2026-11-17, Chris; the design is
`../fw_design_review/docs/releases.md`). FTEs publish builds from Signoff FW's Releases tab, so nobody needs
`publish.py` for them; `flasher_data` and `publish.py` stay for the Arduino examples and other boards.

- **Who sees what: FW sharing.** `assets/fwreleases.js` (`FL.fwr`) reads `fw_design_review_data` (FTEs) and
  every `review-fw-*` repo the token can list, and from each review file only `summary.releases`, cached by blob
  SHA (`flasher.v1.fwReleases`, cleared at Sign out). Flasher's own People list doesn't add to or narrow it.
  Drafts are listed for FTEs only; withdrawn releases are listed with their reason and a warning.
- **The sidebar** has a group per target, "<target> · Signoff FW", one row per release, newest first.
- **A release over USB** is fetched when it's picked: its `release.json`, then the file (joined from its parts),
  refused unless its SHA-256 matches the review's summary. It then opens as a file for the board it names
  (Any STM32 when the manifest doesn't know it), with a banner saying where it's from. A `.bin` release's flash
  address must be its board's flash base.
- **A passthrough release** goes on a passthrough system's remote: from its page (an existing system, or a new
  one), or from the Remote block's *Or a release from Signoff FW*. The system keeps the reference
  (`remote.release`: repo, review, release, version, SHA-256, and board) and its bytes in IndexedDB, as it keeps
  a file; a file picked later replaces it. It never switches by itself: a newer Released build of the same
  target shows "<version> is out" with **Switch**. After INFO, a bootloader that names another board stops the
  update before anything is compared or written; one that names none is logged, and the update goes on.
- **Deep link.** `?release=<review id>/<release id>` (Signoff FW's Open in Flasher) opens that release once the
  list is read.
- **The demo** lists the thermostat's three (Signoff FW's `fdemo3`: 0.8.0 withdrawn, 0.9.0 released, 0.9.1 draft;
  made-up ELF and HEX images for the Main PCBA) and a *Display Firmware* 1.4.0 passthrough release (the demo
  display's build), which a demo system's remote can take.

## Publishing firmware

`tools/publish.py` builds a firmware repo's examples and commits them to their project's repo:
`flasher_data`, or the project's `review-flasher-*` repo once it's shared (from `users.json`). The
firmware repo describes itself in a `flasher.json` at its sketchbook root:
- `data_repo`;
- `project` (`{ "id", "name" }`; default: the board);
- `board` (as in the manifest, plus `id`);
- `examples` (a folder of `<Name>/<Name>.ino` sketches);
- `depends` (what every sketch builds against, such as the board package; counted in the dirty and stale checks);
- `build` (the command, run from the sketchbook with the sketch folders appended);
- `output` (`build/{name}/{name}.ino.bin`).

A bridge board's image is an `elf` in place of `output`, and `flasher.json` then has `units`, the
board's erase units: `skip` (address ranges left out, such as a record the bootloader owns) and
`regions`, each `{ "base", "sizes": [...] }` (sectors of different sizes) or `{ "base", "end",
"unit" }`, with `"app": true` on the regions COMMIT covers. Each unit the ELF's load segments touch
is filled with 0xFF and the image laid over it, exactly as the board reads it back. Units are stored
in parts that never cross a 1 MB boundary, so an update to code alone uploads only its own part.

A firmware repo that builds one image as a whole, rather than a folder of sketches, lists `images`
in place of `examples` and `output`. Each image has `name`, `source` (the folder whose changes count
in the dirty and stale checks), `output` (the `.bin`), and optionally `id`, `exclude` (folders under
`source` to leave out of the stale check, such as the build's own output), `summary`, and
`description`. `build` then runs once, with nothing appended, and `path` can list folders to put
first on `PATH` for it (a vendor toolchain).

Two firmware repos for one board share its details: the second one's `board` is just the board's id
(a string), and the details are read from the manifest the first one published. `runs_as`
(`{ "vid", "pid" }`) is the second firmware's own USB id. The publish refuses until the board's `run`
or `runAlso` lists it, so Flasher can always restart a board running either.

```
python tools/publish.py --source <sketchbook>                  dry run: build, check, show the plan and a code
python tools/publish.py --source <sketchbook> --no-build       dry run on what's already built
python tools/publish.py --source <sketchbook> --only Blink
python tools/publish.py --source <sketchbook> --push --confirm <code>
```

- `tools/publish.local.json` (git-ignored) can hold `{"source": "…"}`.
- The token comes from `../ee_tools_token.txt` or `FLASHER_TOKEN`, and is never printed.
- A sketch with uncommitted changes is skipped unless `--allow-dirty`, which marks it on the page.
- Each entry's description is the sketch's leading `//` comment; its summary is that comment's
  first paragraph.
- A rebuild with the same bytes, source, and text changes nothing.

A push follows the suite's rules for data repos:
1. Read the head.
2. Prove the manifest change is additive: the new manifest with this publish undone re-serializes
   to the old bytes exactly.
3. Commit with `force: false` against that head.
4. Read the result back.

The code ties `--confirm` to exactly the files the dry run showed. The data repo must exist with a
first commit; the dry run works before it does and shows what the first publish would write.

A GitHub Actions workflow can run the same script with `--push --ci` (allowed only inside Actions)
and a repo secret holding a fine-grained token for Flasher's repos (Contents: read and write). Once a
project is shared, its `review-flasher-*` repo must be among the token's repositories too.

## Debug probe

The **Debug probe** tab is a programmer for an engineer's bench: an ST-LINK or J-Link in the browser, as a
calmer STM32CubeProgrammer. Its scripts (`assets/probe/`) load the first time the tab opens; the probe's
settings are a strip under the top bar, and its pages are sub-tabs. It needs no sign-in. Signed in, it
programs the firmware picked in the sidebar (read from GitHub, as the Serial bootloader tab does), and warns
when that firmware was built for another chip; bridge-board firmware, which is in blocks, isn't offered.
`probe.html` now just opens this tab. Pages:

- **Device:** the probe (firmware, target voltage), the chip (core, device ID, flash size and layout, unique
  ID, protection), Halt, Run, Reset and halt, Reset and run, Hardware reset (NRST), and the core registers.
- **Memory:** read any range, page through it as hex, save it as `.bin` or `.hex`; write one word to RAM or a
  register.
- **Erase & program:** the firmware picked in the sidebar, or open `.bin` (with a load address), `.hex`, `.elf`, or `.srec`; erase only the pages or
  sectors the image covers (the default, so a bootloader elsewhere stays) or the whole flash; write, verify by
  reading back, and reset into it, with the route (this computer → the probe → the chip) and a block map as the
  Serial bootloader tab draws them. Erase a range, or the whole flash, on its own.
- **Registers:** every peripheral register from ST's SVD (bundled for the G0B1 and H563; **Open an SVD file**
  for any other chip), with fields decoded and editable, and Read and Write per register. Nothing is read
  until asked, and registers whose read changes them are never read by Read all.
- **Option bytes:** each fuse as a choice, a list of changes with warnings, and a typed confirmation. Never
  written: RDP level 2, the H5's product state, boot entry, TrustZone, boot lock, and bank swap.
- **Log:** everything done, with times.

Connect holds NRST low while it attaches (**Under reset**, the default), so the application never runs and
can't have turned off the SWD pins; NRST must be wired to the probe. Untick it to attach to a running chip
without stopping or touching it.

Chips: the STM32G0B1/G0C1 (two banks of 2 KB pages, double-word writes) and the STM32H562/H563/H573 (two banks
of 8 KB sectors, quad-word writes; its core is on access port 1). The sequences follow ST's HAL. Another chip
still connects for memory and registers. Writing a flash with its banks swapped, or with TrustZone on, is
refused for now. After programming a G0 that was blank at power-on, Flasher clears its `FLASH_ACR.EMPTY` latch
so the next reset boots the new image, not the ROM.

Probes: the ST-LINK/V2, V2-1, and V3 (firmware V2J26 or later; V2J28 or V3 for the H5's access port 1), with
ST's driver as installed. The J-Link speaks SWD bit by bit through SEGGER's raw I/O command, in batches with
overrun detection so a WAIT never repeats or skips a write. It is experimental. Close STM32CubeProgrammer,
CubeIDE, OpenOCD, or J-Link tools first: only one program can hold a probe.

`index.html?demo&tab=probe` (a G0B1) and `?demo=h5&tab=probe` (an H563) run against a simulated ST-LINK (`assets/probe/fakeprobe.js`).
Findings behind the design: `docs/stlink-webusb.md`.

## Files

| File | What |
| --- | --- |
| `index.html` | The page, with its three tabs; CSP allows scripts from this site and `connect-src` to GitHub's API (and the sign-in Worker) only |
| `probe.html` | Opens the Debug probe tab (old links) |
| `assets/route.js` | The route diagram and block map above each update |
| `lab/` | Design labs, not loaded by the tool: `layout.html` (this layout) and `passthrough.html` (the route) |
| `assets/probe/stlink.js` | ST-LINK commands over WebUSB (V2, V2-1, V3), per probe-rs |
| `assets/probe/jlink.js` | J-Link commands over WebUSB and bit-level SWD |
| `assets/probe/target.js` | Cortex-M: connect under reset or hot plug, halt, run, reset, core registers |
| `assets/probe/stm32.js` | STM32 identify, flash erase, program, and verify, and option bytes, per family |
| `assets/probe/files.js` | Programming files: read `.bin`, `.hex`, `.srec`, and ELF; write `.hex` |
| `assets/probe/svd.js` | Register definitions: the bundled SVDs and any opened `.svd` file |
| `assets/probe/svd/` | ST's SVDs for the G0B1 and H563, made compact by `tools/svd_to_json.py` (Apache-2.0) |
| `assets/probe/fakeprobe.js` | A simulated ST-LINK/V3 with a G0B1 or H563 behind it (tests and `?demo`) |
| `assets/probe/app.js`, `probe.css` | The Debug probe tab's UI, mounted by `assets/app.js` |
| `assets/dfuse.js` | DfuSe over WebUSB: layout and descriptor parsing, erase, write, read, and leave |
| `assets/image.js` | Image checks, SHA-256, and manifest validation; the generic STM32 board for local files |
| `assets/serial.js` | The 1200-baud touch, and the serial port under the console |
| `assets/sboot.js` | Bridge boards: the serial bootloader protocol over Web Serial, and the update |
| `assets/fakebridge.js` | A simulated bridge board's bootloader behind a fake serial port (tests and `?demo`) |
| `assets/term.js` | The console's terminal: the screen, escape codes, and the keys |
| `assets/access.js` | Access: reading by role, the People list, sharing a project, and invitations |
| `assets/fakeusb.js` | A simulated STM32 ROM bootloader, serial port, and firmware console (tests and `?demo`) |
| `assets/catalog.js` | Sign-in (`signoff.token`), loading the catalog, and the demo catalog |
| `assets/app.js` | The UI |
| `assets/styles.css` | Flasher's styles; `assets/suite.css` is Signoff EE's (`tools/sync_suite_css.py`) |
| `assets/vendor/` | The Signoff engine's `model.js` and `github.js` (`tools/sync_vendor.py`) |
| `tools/publish.py` | Build and publish (above) |
| `tools/stamp_version.py` | Stamps `assets/version.js` |
| `tests/test.html` | Browser tests against the simulated bootloader and `tests/fakegithub.js`; the title becomes PASS or FAIL |
| `tests/test_publish.py` | `python tests/test_publish.py` |
| `tests/probe.html` | Probe tests against the simulated ST-LINK and `tests/fakejlink.js` (a J-Link with a bit-level SWD target) |
| `tools/svd_to_json.py` | Turns an ST SVD into `assets/probe/svd/<NAME>.json.gz` |
