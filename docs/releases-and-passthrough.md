# Passthrough systems

Status: the design Chris agreed on 2026-11-17. Slice 1 (Flasher only) is built, tried in `?demo`, and pushed;
and not tried on hardware.

## Two layers

- **Public: one file, one board.** Drop a `.bin`, `.hex`, or `.elf`, and Flasher writes it over the board's own
  USB. Projects work as they do today. Clients and contractors see no passthrough wording or steps.
- **Internal (FTEs and `?demo`): passthrough systems.** Beside *Open a file* there's **New passthrough system**,
  which opens a large route diagram with three blocks:

  | Block | What it holds |
  | --- | --- |
  | **Host** (the bridge) | Optional USB ids, used only to narrow Chrome's list. Chris: the host stays alive running its own firmware, which has the passthrough, so Flasher doesn't flash it in a system. |
  | **Link** | The protocol's defaults: touch 2400, link 1 Mbaud, fast 4 Mbaud, and exit 1200. They're rarely changed. |
  | **Remote** | A `.hex` or `.elf` only (it needs addresses). Its erase layout comes from the bootloader's INFO when it connects, so it needs no configuration. |

  Each block shows its state on the diagram: the file, then connected, comparing, and written. A host fronts one
  remote at a time (Chris: not simultaneously), so a system has one remote.

Manifest bridge boards (the display's entry in `flasher_data`) keep working as they are.

## A system is a small object of its own

```
{ v: 1, id, name, host: { usb: [{vid, pid}] | [] }, link: { touchBaud, linkBaud, fastBaud, exitBaud },
  remote: { name, file: { name, sha256 } } }
```

- **Kept in this browser only for now** (Chris), under `flasher.v1.systems`, the recent ones first. The file's
  bytes live in IndexedDB beside it, so a reopened system is ready to run. Saving systems in `flasher_data` (FTE
  only) comes later, once this works.
- **Firmware is a reference.** Today it's a local file. Later it can be a project firmware id or a Signoff FW
  release id, without changing the model (*Signoff integration*, below).

## The layout from the board itself

The bootloader's INFO says almost everything a hand-made `units` layout holds (`assets/sboot.js`):

| INFO field | Gives |
| --- | --- |
| `device` (DBGMCU id) and `singleBank` | the internal sector map, from a public table |
| `appBase`, `appEnd` | the application region; everything below `appBase` is the bootloader's and is skipped |
| `qspiBase`, `qspiSize` | the external flash region (none when the size is 0) |
| `qspiBlock` (new, below) | the external flash erase block |

**The sector table** (`assets/sectors.js`, `FL.sectors`) holds only datasheet facts, keyed by device id and bank
mode. It starts with the F7 family: 0x449 (F74x and F75x), 0x451 (F76x and F77x), and 0x452 (F72x and F73x), each
single-bank and, on 0x451, dual-bank. It grows when another chip runs the bootloader. An unknown chip stops with
"Flasher doesn't know this chip's sectors yet".

**`FL.image.layoutFromInfo(info)`** builds the same `{ regions, skip }` that `unitLayout` builds from a manifest:
internal sectors from `appBase` to `appEnd` marked `app` (COMMIT covers them), external flash in its erase block,
and `skip` below `appBase`. `appBase` and `appEnd` must fall on sector boundaries.

**Splitting happens after INFO.** `sboot.update` takes the file's segments and a `layout(info)` callback, splits
right after INFO, then compares. Published units firmware is unchanged.

### The INFO addition (Chris: yes, a small bootloader tweak)

Two fields inside protocol 1, read only when the answer is long enough. Today's pages need at least 40 bytes and
ignore the rest, so old pages keep working with a new bootloader, and new pages with an old one:

| Offset | Size | Field |
| --- | --- | --- |
| 40 | u32 | `qspiBlock`, the external erase block in bytes (0 = unknown) |
| 44 | 16 bytes | `board`, an ASCII id, NUL-padded (for example `tstat-display`) |

Without `qspiBlock`, Flasher assumes 64 KB, the usual QSPI block erase, and says so in the log. The protocol number
stays 1: changing it would lock out every deployed page (`mismatch` refuses anything but 1). `board` names the
board in the diagram, and later picks its releases.

## Finding the passthrough without ids

- **The person's pick is the gate.** The host is the serial port picked for this (filtered by the system's ids
  when it has some). Flasher never probes ports that weren't picked for this.
- After the touch, the passthrough is a new port. A granted port counts only once it answers INFO at the link
  rate. With no ids, Flasher remembers that port's USB id with the system (`learned`), so later visits find
  it without a pick.
- **The exit touch goes only to the port that answered INFO.** A 1200-baud open resets many USB-serial boards into
  their bootloaders, so it's never sent to an unidentified port.
- **First use still needs two picks:** Web Serial can't filter by product name, and the passthrough is a new USB
  device. Chrome's second list is unfiltered, and the step says to pick the port that just appeared.

## Signoff integration (later, its own session)

Flasher owns *how* to flash a system. The other tools only answer *what goes where*:

- **Signoff FW releases.** One FW review is one target. A Releases tab (built like EE's Revisions, engine code in
  EE behind `config.releases`, synced into ME and FW) stores each build (`.elf`, `.hex`, or `.bin`), a version,
  notes, and how it loads, in `releases/<reviewId>/<releaseId>/` beside the review (in `checkerDirs`, so sharing
  moves it; big files split with `GitHubStore.splitParts`). Flasher lists them as a firmware source, and a
  system's remote can point at a release instead of a file.
- **Signoff PL.** PL already knows which firmware Part goes on which board. A system could be generated from the
  product tree: "Display updates through the Main PCBA".
- **Signoff EE and Loom.** A system's blocks can name EE boards, and Loom's systems already know which harness
  joins them. That gives the diagram real names, and a check could flag a missing passthrough cable.
- Still to decide (Chris): whose access governs a FW release in Flasher, who may publish and whether releases have
  a draft state, and whether `flasher_data` and `publish.py` stay for the Arduino examples.

## Slice 1 (Flasher only, no engine change, no data writes)

1. `FL.sectors` and `FL.image.layoutFromInfo`, with tests.
2. INFO's optional `qspiBlock` and `board`; `sboot.update` splitting after INFO.
3. Passthrough with no ids and protocol-default bauds; the exit touch only to the answering port.
4. New passthrough system: the diagram with Host, Link, and Remote blocks, a `.hex` or `.elf` on the remote,
   recent systems in this browser. FTEs and `?demo` only.
5. The demo: the simulated display answers INFO as a real 0x451 single-bank chip with the new fields, so its
   system runs with no manifest entry.
