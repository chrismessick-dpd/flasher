# Flasher

Flash prebuilt firmware onto a board from Chrome or Edge, with no Arduino IDE. Pick the firmware,
plug the board in by USB, and click **Flash board**. Part of the Dovetail Signoff suite.

- **Real use:** the firmware list and images come from Flasher's private repos, read with the suite's
  GitHub sign-in. FTEs see every project; clients and contractors see only the projects shared with
  them (*Access*). Every image is checked against its SHA-256 before it's flashed.
- **Flash and Console** are two tabs of one panel. The console is a terminal on the board's USB serial
  port (*The console*).
- **`?demo`:** the suite's made-up Smart Thermostat for Acme Climate. It flashes a board simulated
  in the page, so it runs anywhere and touches no USB.
- **Open a .bin file…** flashes a file from this computer.

It's a static page with no build step and no outside scripts. Serve the tools folder and open
`flasher/index.html`, or use its GitHub Pages address. WebUSB and Web Serial need https or
localhost.

## How a flash works

The boards are STM32s. The chip's ROM has a USB DFU bootloader (USB `0483:DF11`) that can't be erased,
so a board never needs a first flash by other means, and a failed flash can always be retried.

1. **Restart into the bootloader.** If the board is running firmware that supports it, Flasher
   opens its USB serial port at 1200 baud and drops DTR (Web Serial), as the Arduino IDE does. The
   firmware then reboots into the ROM bootloader. A blank board, or one whose firmware doesn't
   listen, is put there by hand; the board's own steps come from its entry in the manifest.
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

The Console tab is a small terminal (`assets/term.js`) on the board's USB serial port, opened at
115200 baud (never 1200, which restarts the board into its bootloader). Every key goes to the board as a
terminal sends it, so a firmware console that edits its own line works as it does in PuTTY: Up and Down recall history, Tab completes, Ctrl-L redraws, and `clear` clears.
- **Keys.** Ctrl-C copies when text is selected, else goes to the board. Paste sends the text, with
  each line end as Enter.
- **Drawing.** The terminal draws `
`, `
`, backspace, tabs, erase in line and in screen, and
  cursor moves. Colors and other sequences are dropped.
- **Typing.** Keys go through a hidden text field, as in xterm.js, so phone keyboards, dictation, and
  input methods work.
- **Clear** clears only the window.
- **Flashing** closes the console first, since the restart into DFU mode needs the port.

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
- `layout` is the DfuSe layout to use if the browser can't read the device's alternate setting names.
- Numbers may be JSON numbers or `"0x…"` strings.
- Entries that don't validate are skipped and listed on the page (`FL.image.cleanManifest`).

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

## Files

| File | What |
| --- | --- |
| `index.html` | The page; CSP allows scripts from this site and `connect-src` to GitHub's API only |
| `assets/dfuse.js` | DfuSe over WebUSB: layout and descriptor parsing, erase, write, read, and leave |
| `assets/image.js` | Image checks, SHA-256, and manifest validation; the generic STM32 board for local files |
| `assets/serial.js` | The 1200-baud touch, and the serial port under the console |
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
