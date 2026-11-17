# Flashing through an ST-LINK from the browser: findings

2026-11-17. Research only; no code in Flasher yet. Chris asked whether Flasher could drive an ST-LINK (and
maybe a J-Link) directly, for boards with no USB bootloader path. The example is a client board: an
STM32H563 main MCU with a custom CAN bootloader at 0x08000000, and two STM32G0B1 USB-CAN bridges, all flashed
today with STM32CubeProgrammer or a J-Link.

## Short answer

- **ST-LINK: feasible, with work.** Nothing in Chrome or Windows blocks it. ST's driver binds WinUSB, which is
  what WebUSB needs on Windows, and Chromium's blocklist has no ST or SEGGER entries. There is no
  maintained, permissively licensed library that flashes an H5 or a G0 from a browser. Flasher would carry
  its own small ST-LINK transport, SWD memory access on the right access port, and flash code per family.
  The ST-LINK transport would be ported from probe-rs (MIT/Apache-2.0) or pyOCD (Apache-2.0).
- **J-Link: not practical.** Its USB protocol is SEGGER's own and undocumented. SEGGER's WebUSB feature is for
  J-Link OB boards with a preloaded flash loader, through SEGGER's page. The only open implementation
  (libjaylink) is GPL and reverse-engineered.
- **Proven on this machine (2026-11-17):** Chrome 158 opened the bench STLINK-V3 with ST's driver as installed,
  claimed its debug interface, and got answers to GET_VERSION, GET_VERSION_EX, and GET_CURRENT_MODE. The J-Link
  opened and its interface claimed too, but no J-Link commands were sent (see *Tested in Chrome*).

## 1. WebUSB access

### What this machine has (read only, 2026-11-17)

| Device | USB id | Driver bound | Notes |
| --- | --- | --- | --- |
| ST-LINK/V2 | 0483:3748 | WinUSB (ST's `stlink_winusb`, provider STMicroelectronics 2.2.0.0) | Whole device; interface GUID `{DBCE1CD9-A320-4b51-A365-A0C3F3C5FB29}` |
| STLINK-V3 (the bench probe) | 0483:3754 | Composite (`usbccgp`): MI_00 "ST-Link Debug" on WinUSB with the same GUID; MI_01 the virtual COM port on `usbser` | The debug function is the one WebUSB needs |
| J-Link | 1366:1020 | WinUSB (SEGGER 3.0.0.0), GUID `{C78607E8-…}` | WinUSB, so reachable by WebUSB in principle |
| STM32 ROM DFU | 0483:DF11 | WinUSB (ST 1.3.0.0) | What Flasher uses today, through the same kind of driver |

All four were "not present" when listed (none plugged in). The bindings are remembered by Windows, so they
apply the next time each is plugged in.

### Why that matters

- Chrome on Windows can open a device, or one function of a composite device, only when WinUSB is bound to it.
  ST's driver *is* WinUSB with ST's own interface GUID, so no driver swap (Zadig and the like) should be needed.
  An ST employee wrote in January 2026 that STLINK-V3 needs no driver at all on Windows: it carries
  Microsoft OS descriptors that make Windows bind WinUSB by itself.
- Flasher already talks WebUSB to ST's WinUSB-bound DFU device on this machine, which is the same mechanism.
- **Chromium's blocklist** (`chrome/browser/usb/usb_blocklist.cc`, read 2026-11-17) lists only security keys
  (Yubico, Feitian, Titan, Nitrokey, and others). No 0x0483 (ST) or 0x1366 (SEGGER) entries.
- **Protected interface classes** (HID, mass storage, audio, video, smart card, wireless) can't be claimed.
  The ST-LINK debug interface is vendor-specific (class 0xFF), so it isn't protected. A V2-1's or V3's
  mass-storage drive is protected, but the page doesn't need it.

### Tested in the browser pane

- On `http://localhost:8774` (secure context), Claude's built-in Chromium 156: `navigator.usb` and
  `navigator.serial` exist, `getDevices()` is empty, and `requestDevice({filters: [0483, 1366]})`
  found nothing to pick (`NotFoundError`).
- That was expected with nothing plugged in, and the pane isn't Chrome or Edge, so it proves only that the API
  is there. With the probes plugged in, the pane still cancels at once: it has no device picker.

### Tested in Chrome (2026-11-17, probe only, no target touched)

A throwaway page on `localhost:8774` in Chrome 158; Chris picked each probe in Chrome's picker. A picker
opened by an automated click is cancelled, so a person has to pick.

**STLINK-V3 (0483:3754):**
- `open` and `claimInterface(0)` both succeeded, with no driver change. ST's driver was as installed, and
  nothing else held the probe.
- Interfaces:

  | Interface | Class | Endpoints |
  | --- | --- | --- |
  | 0 | vendor-specific | bulk in 1, bulk out 1, and bulk in 2 (trace), 512 bytes each (high speed) |
  | 1 | CDC control | interrupt in 4 |
  | 2 | CDC data | bulk out 5 and bulk in 5 |

  The virtual COM port shows in WebUSB but stays with Windows' serial driver. Web Serial is the way to it.
- `GET_VERSION` (0xF1) returned `30 00 83 04 54 37`: an ST-LINK v3, with the VID and PID echoed.
- `GET_VERSION_EX` (0xFB) returned firmware **V3J16M9**. That is well above probe-rs's minimum for V3
  (3.2), so the multi-AP commands the H563 needs should be there.
- `GET_CURRENT_MODE` returned 0x0401. Its low byte, 1, is mass-storage mode, which is what an idle V3
  reports. A flasher would leave that mode and enter SWD.

**J-Link (1366:1020):**
- `open` and `claimInterface(0)` succeeded: one vendor-specific interface, with bulk in 1 and bulk out 1.
- So WebUSB reaches the J-Link too. What stops it is the undocumented protocol, not the browser or the driver.

### Risks on the access side

- **One owner at a time.** WinUSB gives one process the device. If ST's `stlinkserver`,
  STM32CubeProgrammer, CubeIDE, or OpenOCD holds the probe, `claimInterface` fails. None was running on
  2026-11-17. Flasher should say "Close STM32CubeProgrammer or CubeIDE" on that error.
- **Probe firmware.** Old ST-LINK firmware lacks the commands that pick an access port (needed for the H5,
  below). probe-rs requires V2 firmware 2.26 or later and V3 firmware 3.2 or later in general. The exact
  minimum for multi-AP reads and writes should be checked in its source before relying on it. The page can
  read the version (GET_VERSION) and ask for an ST-LINK upgrade.
- **CMSIS-DAP on an ST-LINK:** no official CMSIS-DAP firmware for ST-LINK V2-1 or V3 was found, so DAPjs
  can't talk to them. DAPjs (MIT) does work with any CMSIS-DAP probe (MCU-Link, the Raspberry Pi Debug Probe,
  and DAPLink boards), which is a fallback if the ST-LINK path stalls. Whether its memory calls can be pointed
  at AP1 still needs checking: its low-level DP and AP calls suggest yes.

## 2. Prior art

| Project | What it does | License | Fit |
| --- | --- | --- | --- |
| [devanlai/webstlink](https://github.com/devanlai/webstlink) | pystlink ported to WebUSB: registers, memory, halt and run, flash | MIT | V2 and V2-1 only; flashing tested on the STM32F103 only; single access port; old (Chrome 61 era) |
| [phryniszak/jstlink](https://github.com/phryniszak/jstlink) | ST-LINK V2 and V3 over WebUSB, with an RTT demo | GPL-3.0 | Has V3 support, but can't be copied into Flasher unless Flasher is GPL |
| pystlink | The Python original | MIT | Old; no G0 or H5 |
| [probe-rs](https://probe.rs/) `probe/stlink` | Native ST-LINK V2 and V3 driver, multi-AP, with G0 and H5 targets and CMSIS-pack flash algorithms | MIT or Apache-2.0 | Best reference for commands and AP handling. No browser (WASM and WebUSB) build was found |
| pyOCD `stlink` | ST-LINK backend | Apache-2.0 | A second permissive reference |
| OpenOCD `stlink_usb.c` | The fullest ST-LINK command set | GPL-2.0 | Read only for understanding, never copy |
| [DAPjs](https://github.com/ARMmbed/dapjs) | CMSIS-DAP over WebUSB | MIT | Only for CMSIS-DAP probes |
| SEGGER [J-Link WebUSB](https://kb.segger.com/J-Link_WebUSB) | Programs through J-Link OB from SEGGER's page | Proprietary | Not usable by Flasher |
| ST | No browser STM32CubeProgrammer was found | — | — |

Nothing maintained in 2025 to 2026 flashes an H5 from a browser through an ST-LINK, as far as these searches found.

**License note.** `flasher/` has no LICENSE file yet. Code ported from probe-rs, pyOCD, or webstlink is fine
under MIT or Apache-2.0 with their notices kept. jstlink and OpenOCD are GPL and stay out unless Chris picks a GPL license.
ST's CMSIS-pack flash algorithms (`.FLM`) carry ST's own license: check it before shipping one.

## 3. What it would take

### Layers

1. **ST-LINK transport.** Bulk endpoints of the debug interface. V2 and V2-1 use OUT 0x02 and IN 0x81; V3 uses
   OUT 0x01 and IN 0x81. Commands are 16-byte frames. Needed: GET_VERSION (V3 uses its own V3 version
   command), mode changes (leave DFU and mass-storage modes, enter SWD), set the SWD frequency (V3 has its own
   command), drive NRST, read and write debug registers, read and write memory 32 bits and 8 bits per AP, and
   GETLASTRWSTATUS2 after each transfer. Roughly 400 to 600 lines of JavaScript, ported from probe-rs.
2. **Target access.** Halt, reset, connect-under-reset, and DHCSR and DEMCR handling. The **H563 needs AP1**:
   on STM32H5, AP0 reaches only the DBGMCU and the ROM table, and the Cortex-M33's memory is behind AP1. The
   G0B1 is on AP0. This is why webstlink's single-AP code can't flash the H563 as is.
3. **Flash code per family.** See below.
4. **Flasher UI.** A new board method beside DfuSe and the bridge passthrough: `method: 'swd'`, with the
   family in the private manifest. The same image formats (`.bin` with a base address, `.hex`), with verify
   by read-back and a final reset.

### Flash code per family

There are two ways to write the flash:

- **Register-level from the page.** Unlock, set PG, write the words through the debug port, then poll BSY. This
  is simplest, with no target code. But every poll is a USB round trip (about 1 ms on Windows WebUSB), so it
  is only fast if the flash stalls the bus while it programs and the page can stream whole blocks without
  polling. Whether each part stalls or rejects writes while busy has to be checked on the bench.
- **A small RAM loader.** The page writes a loader and a block of data into SRAM, runs it, and waits for
  it to finish. That is one round trip per block (kilobytes), not per word. This is how CubeProgrammer, probe-rs,
  and OpenOCD get their speed. It is about 100 lines of C or assembly per family, ours to write (or from a
  CMSIS pack, license permitting), built once and shipped as bytes in Flasher.

Recommendation: register-level first, for both families, to get it working, then measure. Add the RAM loader
if 512 KB takes more than about a minute.

**STM32G0B1 (512 KB, dual bank, 2 KB pages, 64-bit double-word programming).**
- FLASH at 0x40022000: KEYR, SR, and CR (PG, PER and PNB, MER1 and MER2, STRT, LOCK, OBL_LAUNCH).
- Erase the pages the image covers, or MER1 and MER2 for a full chip. Write double words. Verify by reading back.
- **The empty-flash latch.** `FLASH_ACR.PROGEMPTY` is evaluated only at power-on or option-byte load.
  A part that was blank at power-on boots ROM DFU on every later non-power-on reset, including a probe's
  reset after flashing. The bench saw exactly this on 2026-11-16. After programming a blank part, Flasher must
  do one of these:
  - clear the bit, if the debug port can write it;
  - an OBL_LAUNCH, which reloads option bytes and resets;
  - tell the user to unplug and replug the board's power.

  Which of these works from the debug port is to be tried on the bench.
- Option bytes: otherwise not needed. Read OPTR only to report RDP and boot settings.

**STM32H563 (2 MB, two 1 MB banks, 8 KB sectors, 128-bit quad-word programming with ECC, TrustZone off).**
- Through AP1. Non-secure registers (FLASH_NSKEYR, NSSR, and NSCR in RM0481) at 0x40022000.
- Program a quad-word at a time (four 32-bit writes in order, then wait); erase by sector (SER, SNB, BKSEL)
  or bank.
- **Erase only what the image covers.** On the client board the CAN bootloader sits at 0x08000000. A mass
  erase is only right for a full image that includes the bootloader. A board entry should say which
  sectors are protected, and Flasher should refuse an image that overlaps them unless it's a full image.
- **`PWR_SCCR` is write-once after power-on**, and that board needs LDO mode set by its own firmware. The probe
  and any loader must never touch PWR. Flashing at the reset supply settings is what CubeProgrammer does today.
- Option bytes (TrustZone, write protection, and boot address) are not needed. Read them to report, never write.

### Connect-under-reset

- Hold NRST, connect SWD, set DHCSR halt and DEMCR reset-catch, then release NRST. The core stops at the first
  instruction, before the application can reconfigure the SWD pins, sleep, or lock anything.
- The ST-LINK does this with its drive-NRST command. **NRST must be wired to the probe's connector**
  (the STDC14 and the 20-pin connector have it; a bare 4-wire SWD lead doesn't).
- Fallback: connect while running ("hot plug"), halt, and then a system reset with reset-catch (AIRCR
  SYSRESETREQ).

### The hot-plug interrupt stop (bench, 2026-11-16)

- On 2026-11-16, a hot-plug SWD connection stopped the H563 application's interrupts. Its cause is unknown, and
  nothing here explains it.
- Candidates to check, all unverified:
  - the probe halting or resetting on connect;
  - DBGMCU freeze bits left set;
  - a debug-mode bit left on after a halt and step.
- **It doesn't affect flashing.** A flasher always connects under reset, programs a halted core, and then
  resets (or power-cycles) into the new image. A reset clears that state.
- It would matter only for a later "attach without disturbing" feature, such as RTT.

### Expected speed (estimates to measure, not measurements)

| Path | 512 KB (G0B1) | 2 MB (H563) |
| --- | --- | --- |
| Register-level, polling each word | Minutes | Too slow |
| Register-level, streamed blocks (if the bus stalls while busy) | About 10 to 30 s | About 30 to 90 s |
| RAM loader, V2 (full speed USB) | About 5 to 15 s | About 20 to 40 s |
| RAM loader, V3 (high speed USB) | About 5 to 10 s, bound by flash program time | About 15 to 30 s |

- The flash itself sets the floor: thousands of double-words or quad-words at tens of µs each.
- Verify (read back) is fast on both: memory reads stream at hundreds of KB/s on a V3.

### Rough effort

| Piece | Effort |
| --- | --- |
| Probe transport, version check, SWD connect-under-reset, and multi-AP memory access | 2 to 3 days |
| G0B1 register-level erase, write, verify, reset, and the PROGEMPTY handling | 1 to 2 days, with bench time |
| H563 on AP1: sector erase, quad-word write, and verify | 1 to 2 days, with bench time |
| Flasher UI, manifest fields, and a simulated probe for `?demo` and tests | 2 days |
| RAM loaders, if register-level is too slow | 2 to 3 days |

In all, about 1.5 to 2.5 weeks to something Chris can use on both targets.

### Risks

- `claimInterface` fails while another program holds the probe. The V3 worked here; an older V2 on another
  PC may still sit on a pre-WinUSB ST driver.
- Bricking risk is low but not zero. A bad option-byte write could set RDP or lock out debug. **Flasher
  should never write option bytes** without a separate, explicit step.
- The H563's protected bootloader region: a wrong erase range wipes the CAN bootloader. It can be recovered with
  the same probe, but the board then needs the full image.
- Edge and Chrome only (no Firefox or Safari), as today.
- It's a second programming path to maintain beside DfuSe and the bridge passthrough.

## 4. Other paths worth weighing

- **The G0B1 bridges already have a ROM DFU path.** They show up on this machine as STM32 Bootloader devices
  (0483:DF11, WinUSB). Flasher's existing DfuSe code flashes G0 parts through that. The work is getting them
  into DFU (BOOT0, an empty part, or the firmware's own DFU detach), plus the PROGEMPTY note above. This may
  cover the bridges with no probe at all.
- **The H563 over its own CAN bootloader** through a bridge on gs_usb (also a WinUSB vendor device), the
  way Flasher's bridge-board passthrough works. That is a third protocol, but it needs no probe, and it works
  for anyone with only a USB cable. It doesn't help a blank board or a broken bootloader, which is where the
  probe earns its place.
- **A CMSIS-DAP probe with DAPjs** instead of the ST-LINK, if the ST-LINK path hits a wall.

## Next steps (each waits on Chris)

1. ~~Prove access~~: done for the STLINK-V3 (2026-11-17). Still to try: an ST-LINK/V2, and Edge.
2. **Pick a license for the `flasher` repo** (MIT fits the sources above), before any ported code goes in.
3. Decide scope: G0B1 only, H563 only, or both; and whether the bridges should go through ROM DFU instead.
4. Then build, in the order of section 3's effort table, with the bench to hand.

## Built (2026-11-17)

Chris asked for "a web alternative to the ST programmer GUI": ST-LINK with a J-Link toggle, MIT. It is
`probe.html` (README, *Debug probe*). Register-level flash writes came first, as recommended above; a RAM loader
is still an option if the bench shows them slow. The J-Link turned out to be reachable by WebUSB, so it has a
bit-level SWD path through SEGGER's raw I/O command (experimental). Not yet tried on a real target.

### Bench results (2026-11-17)

- **STLINK-V3 on an H563:** connect under reset, identify (AP1), read 2 MB in 8.8 s at 3.3 MHz (363 KB/s at 8 MHz,
  480 KB/s at 24 MHz), erase and program blank sectors in both banks at about 180 KB/s with no interrupted blocks,
  verify, erase again, and an option-byte write and restore all worked. The flash outside the test sectors was
  unchanged (same SHA-256 before and after).
- **J-Link V13 on a G0B1:** identifies and reads (185 KB/s) after one fix: its SWD replies arrive one bit early.
  Long reads rebooted it twice, once into its bootloader. Not understood yet; beta.
- Register-level writes are fast enough on the H5, so a RAM flash loader isn't needed there. The G0 is untried.
