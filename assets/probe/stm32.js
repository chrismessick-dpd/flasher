/* STM32 flash and option bytes over SWD, register by register, as ST's HAL does it (STM32Cube FW_G0
   1.6.3 and FW_H5 1.6.0: stm32*_hal_flash*.c). One family file's worth each: the G0 (G0B1 first) and the
   H5 (H563 first). An unknown chip still connects for memory and registers, with no flash operations.

   Program: unlock, set PG, stream the image in 1 KB blocks (the flash stalls the bus while it programs),
   wait for BSY after each block, check the error bits, then read it all back. A block that fails is read
   back, and only its still-erased units are written again, one at a time. */
(function () {
  'use strict';
  var FL = window.FL = window.FL || {};
  var KEY1 = 0x45670123, KEY2 = 0xCDEF89AB, OPTKEY1 = 0x08192A3B, OPTKEY2 = 0x4C5D6E7F;
  var BLOCK = 1024;

  function hex(v, n) { return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(n || 8, '0'); }
  function bits(v, lsb, w) { return w === 32 ? v >>> 0 : (v >>> lsb) & ((1 << w) - 1); }
  function setBits(v, lsb, w, x) { if (w === 32) return x >>> 0; var m = ((1 << w) - 1) << lsb; return ((v & ~m) | ((x << lsb) & m)) >>> 0; }
  function u16(b) { return b[0] | (b[1] << 8); }
  function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }

  // Wait until none of busyMask's bits are set; then return the status register.
  async function waitIdle(t, sr, busyMask, ms) {
    var t0 = now();
    for (;;) {
      var v = await t.r32(sr);
      if (!(v & busyMask)) return v;
      if (now() - t0 > (ms || 5000)) throw new Error('The flash stayed busy (status ' + hex(v) + ').');
      await t.sleep(1);
    }
  }

  // ── STM32G0 (RM0444). Dual bank on the G0B1/G0C1: 2 KB pages, numbered within each bank, BKER for bank 2.
  var G0 = {
    id: 'g0', unit: 8, base: 0x40022000, flashBase: 0x08000000,
    ACR: 0x00, KEYR: 0x08, OPTKEYR: 0x0C, SR: 0x10, CR: 0x14, OPTR: 0x20,
    SR_ERR: 0xC3FA,        // OPERR, PROGERR, WRPERR, PGAERR, SIZERR, PGSERR, MISERR, FASTERR, RDERR, OPTVERR
    SR_BUSY: (1 << 16) | (1 << 17) | (1 << 18),
    CR_PG: 1, CR_PER: 2, CR_MER1: 4, CR_BKER: 1 << 13, CR_MER2: 1 << 15, CR_STRT: 1 << 16, CR_OPTSTRT: 1 << 17,
    CR_OBL_LAUNCH: 1 << 27, CR_OPTLOCK: 1 << 30, CR_LOCK: 1 << 31,
    devices: { 0x467: 'STM32G0B1/G0C1' },
    svd: { 0x467: 'STM32G0B1' },
    sizeAddr: 0x1FFF75E0, uidAddr: 0x1FFF7590,
    errNames: { 1: 'OPERR', 3: 'PROGERR', 4: 'WRPERR (write-protected)', 5: 'PGAERR (alignment)', 6: 'SIZERR', 7: 'PGSERR (sequence)', 8: 'MISERR', 9: 'FASTERR', 14: 'RDERR', 15: 'OPTVERR (option bytes invalid)' }
  };
  G0.layout = async function (t, chip) {
    var optr = await t.r32(this.base + this.OPTR);
    // 512 KB parts are always two banks; smaller G0B1/G0C1 parts are when DUAL_BANK is set.
    var dual = chip.flashSize >= 512 * 1024 || !!(optr & (1 << 21));
    chip.dual = dual;
    chip.swapped = dual && !(optr & (1 << 20));
    chip.bankSize = dual ? chip.flashSize / 2 : chip.flashSize;
    chip.sectorSize = 2048;
    chip.rdp = optr & 0xFF;
    chip.protection = chip.rdp === 0xAA ? 'Level 0 (none)' : chip.rdp === 0xCC ? 'Level 2 (permanent)' : 'Level 1 (read protection)';
  };

  // ── STM32H5 (RM0481). Two banks of 8 KB sectors; non-secure registers (TrustZone off). Quad-word writes.
  var H5 = {
    id: 'h5', unit: 16, base: 0x40022000, flashBase: 0x08000000,
    NSKEYR: 0x04, OPTKEYR: 0x0C, OPTCR: 0x1C, NSSR: 0x20, NSCR: 0x28, NSCCR: 0x30,
    OPTSR_CUR: 0x50, OPTSR_PRG: 0x54, OPTSR2_CUR: 0x70, OPTSR2_PRG: 0x74, NSBOOTR_CUR: 0x80, NSBOOTR_PRG: 0x84,
    WRP1R_CUR: 0xE8, WRP1R_PRG: 0xEC, WRP2R_CUR: 0x1E8, WRP2R_PRG: 0x1EC,
    SR_ERR: 0xFE0000,      // WRPERR, PGSERR, STRBERR, INCERR, OBKERR, OBKWERR, OPTCHANGEERR
    SR_BUSY: 1 | 2 | 8,    // BSY, WBNE, DBNE
    CR_LOCK: 1, CR_PG: 2, CR_SER: 4, CR_BER: 8, CR_STRT: 32, CR_MER: 1 << 15, CR_BKSEL: 1 << 31,
    devices: { 0x484: 'STM32H562/H563/H573' },
    svd: { 0x484: 'STM32H563' },
    sizeAddr: 0x08FFF80C, uidAddr: 0x08FFF800,
    errNames: { 17: 'WRPERR (write-protected)', 18: 'PGSERR (sequence)', 19: 'STRBERR (strobe)', 20: 'INCERR (inconsistency)', 21: 'OBKERR', 22: 'OBKWERR', 23: 'OPTCHANGEERR' },
    STATES: { 0xED: 'Open', 0x17: 'Provisioning', 0x2E: 'iROT provisioned', 0xC6: 'TZ-closed', 0x72: 'Closed', 0x5C: 'Locked (permanent)', 0x9A: 'Regression', 0xA3: 'NS regression' }
  };
  H5.layout = async function (t, chip) {
    var optcr = await t.r32(this.base + this.OPTCR), sr = await t.r32(this.base + this.OPTSR_CUR), sr2 = await t.r32(this.base + this.OPTSR2_CUR);
    chip.dual = true;
    chip.swapped = !!(optcr >>> 31);
    chip.bankSize = chip.flashSize / 2;
    chip.sectorSize = 8192;
    chip.state = bits(sr, 8, 8);
    chip.tzen = bits(sr2, 24, 8) === 0xB4;
    chip.protection = 'Product state: ' + (this.STATES[chip.state] || hex(chip.state, 2)) + (chip.tzen ? ', TrustZone on' : '');
  };

  var FAMILIES = [G0, H5];

  // Shared: which erase units (pages or sectors) cover [lo, hi).
  function sectorsFor(chip, lo, hi) {
    var out = [], ss = chip.sectorSize, base = chip.flashBase, end = base + chip.flashSize;
    lo = Math.max(lo, base); hi = Math.min(hi, end);
    for (var a = base + Math.floor((lo - base) / ss) * ss; a < hi; a += ss) {
      var off = a - base, bank = chip.dual && off >= chip.bankSize ? 2 : 1;
      out.push({ addr: a, size: ss, bank: bank, index: (off % (chip.dual ? chip.bankSize : chip.flashSize)) / ss });
    }
    return out;
  }

  function errText(fam, sr) {
    var names = [];
    Object.keys(fam.errNames).forEach(function (b) { if (sr & (1 << b)) names.push(fam.errNames[b]); });
    return names.join(', ') || hex(sr);
  }

  // ── Identify. Works for any STM32 whose DBGMCU IDCODE is at one of the usual places.
  async function identify(t) {
    var core = (t.cpuid >>> 4) & 0xFFF, idcode = 0;
    var places = core === 0xD21 ? [0x44024000, 0xE0044000] : core === 0xC60 ? [0x40015800] : [0xE0042000, 0x40015800, 0x44024000];
    for (var i = 0; i < places.length && !(idcode & 0xFFF); i++) { try { idcode = await t.r32(places[i]); } catch (e) { /* not here */ } }
    var dev = idcode & 0xFFF, rev = idcode >>> 16;
    var fam = FAMILIES.filter(function (f) { return f.devices[dev]; })[0] || null;
    var chip = { devId: dev, revId: rev, core: FL.target.CORES[core] || hex(core, 3), ap: t.ap, family: fam, name: fam ? fam.devices[dev] : 'Unknown (DEV_ID ' + hex(dev, 3) + ')', svd: fam ? fam.svd[dev] : null };
    if (!fam) return chip;
    chip.flashBase = fam.flashBase;
    try { chip.flashSize = ((await t.r32(fam.sizeAddr)) & 0xFFFF) * 1024; } catch (e) { chip.flashSize = 0; }  // word reads: the H5's info area refuses byte reads
    try {
      var u = await t.read(fam.uidAddr, 12);
      chip.uid = Array.from(u).reverse().map(function (b) { return b.toString(16).padStart(2, '0'); }).join('').toUpperCase();
    } catch (e) { chip.uid = ''; }
    await fam.layout(t, chip);
    return chip;
  }

  // ── Flash operations, shared by both families through each family's register names.
  function regs(fam) {
    return fam === H5
      ? { key: fam.base + fam.NSKEYR, sr: fam.base + fam.NSSR, cr: fam.base + fam.NSCR, clear: async function (t) { await t.w32(fam.base + fam.NSCCR, fam.SR_ERR | (1 << 16)); } }
      : { key: fam.base + fam.KEYR, sr: fam.base + fam.SR, cr: fam.base + fam.CR, clear: async function (t) { await t.w32(fam.base + fam.SR, fam.SR_ERR | 1); } };
  }

  async function unlock(t, fam) {
    var r = regs(fam), lock = fam === H5 ? fam.CR_LOCK : fam.CR_LOCK >>> 0;
    await waitIdle(t, r.sr, fam.SR_BUSY);
    if ((await t.r32(r.cr)) & lock) { await t.w32(r.key, KEY1); await t.w32(r.key, KEY2); }
    if ((await t.r32(r.cr)) & lock) throw new Error('The flash would not unlock.');
    await r.clear(t);
  }
  async function lock(t, fam) {
    var r = regs(fam);
    try { await t.w32(r.cr, fam === H5 ? fam.CR_LOCK : fam.CR_LOCK >>> 0); } catch (e) { /* best effort */ }
  }
  async function finish(t, fam, what) {
    var r = regs(fam), sr = await waitIdle(t, r.sr, fam.SR_BUSY, 30000);
    if (sr & fam.SR_ERR) { await r.clear(t); throw new Error(what + ' failed: ' + errText(fam, sr) + '.'); }
  }
  function refuseSwapped(chip) {
    if (chip.swapped) throw new Error('Bank swap is on in this chip\'s option bytes. Flasher doesn\'t write a swapped flash yet; turn the swap off first.');
    if (chip.tzen) throw new Error('TrustZone is on in this chip. Flasher only writes with TrustZone off.');
  }

  async function eraseSectors(t, chip, list, progress) {
    var fam = chip.family, r = regs(fam);
    refuseSwapped(chip);
    await unlock(t, fam);
    try {
      for (var i = 0; i < list.length; i++) {
        var s = list[i], cr;
        if (fam === H5) cr = fam.CR_SER | (s.index << 6) | (s.bank === 2 ? fam.CR_BKSEL : 0);
        else cr = fam.CR_PER | (s.index << 3) | (s.bank === 2 ? fam.CR_BKER : 0);
        await t.w32(r.cr, cr >>> 0);
        await t.w32(r.cr, (cr | fam.CR_STRT) >>> 0);
        await finish(t, fam, 'Erasing ' + hex(s.addr));
        if (progress) progress((i + 1) / list.length, 'Erased ' + (i + 1) + ' of ' + list.length);
      }
      await t.w32(r.cr, 0);
    } finally { await lock(t, fam); }
  }
  async function massErase(t, chip, progress) {
    var fam = chip.family, r = regs(fam);
    refuseSwapped(chip);
    await unlock(t, fam);
    try {
      var cr = fam === H5 ? fam.CR_MER : fam.CR_MER1 | (chip.dual ? fam.CR_MER2 : 0);
      await t.w32(r.cr, cr);
      await t.w32(r.cr, (cr | fam.CR_STRT) >>> 0);
      if (progress) progress(0.5, 'Erasing the whole flash');
      await finish(t, fam, 'Mass erase');
      await t.w32(r.cr, 0);
      if (progress) progress(1, 'Erased');
    } finally { await lock(t, fam); }
  }


  // Pad [addr, addr + data) out to whole units with 0xFF (erased flash).
  function padded(fam, addr, data) {
    var u = fam.unit, lo = addr - (addr % u), hi = Math.ceil((addr + data.length) / u) * u;
    if (lo === addr && hi === addr + data.length) return { addr: addr, data: data };
    var b = new Uint8Array(hi - lo).fill(0xFF); b.set(data, addr - lo);
    return { addr: lo, data: b };
  }

  /* Program. A block that fails partway (a WAIT, an error bit) may leave a unit half-written in the flash
     controller, which can't be finished or written again. So the block's pages or sectors are erased again
     and rewritten from their start, one unit at a time, from the image (they were erased before this, so
     whatever of them lies outside the image is erased flash). */
  async function program(t, chip, addr, data, progress, o) {
    o = o || {};
    var fam = chip.family, r = regs(fam);
    refuseSwapped(chip);
    if (addr < chip.flashBase || addr + data.length > chip.flashBase + chip.flashSize) throw new Error('The image (' + hex(addr) + ' to ' + hex(addr + data.length) + ') is outside this chip\'s flash.');
    var p = padded(fam, addr, data), redone = 0;
    await unlock(t, fam);
    var t0 = now();
    try {
      await t.w32(r.cr, fam.CR_PG);
      for (var at = 0; at < p.data.length;) {
        var a = p.addr + at, n = Math.min(p.data.length - at, BLOCK - (a % BLOCK)), chunk = p.data.subarray(at, at + n);
        if (o.slow) await writeUnits(t, fam, a, chunk);
        else {
          var cut = null;
          try { await t.write(a, chunk, { noRetry: true }); } catch (e) { cut = e; }
          // A flash error (PROGERR, WRPERR, …) is the chip's verdict and stops the write; only a cut transfer is redone.
          if (!cut) await finish(t, fam, 'Writing ' + hex(a));
          else {
            var e = cut;
            if (++redone > 8) throw new Error('Writing kept failing (last at ' + hex(a) + ': ' + e.message + '). Try a slower SWD clock or Careful write.');
            if (o.log) o.log('Writing ' + hex(a) + ' was interrupted (' + e.message + '); erasing that ' + (fam === H5 ? 'sector' : 'page') + ' and writing it again carefully.');
            await redo(t, chip, p, a + n);
          }
        }
        at += n;
        if (progress) progress(at / p.data.length, 'Wrote ' + FL.files.fmtBytes(at) + ' of ' + FL.files.fmtBytes(p.data.length));
      }
      await t.w32(r.cr, 0);
    } finally { await lock(t, fam); }
    return { ms: now() - t0, bytes: p.data.length, redone: redone };
  }
  // Recover from an interrupted block ending at `end`: flush or drop a half unit, erase the units the block
  // touched, and rewrite them from their start up to `end`.
  async function redo(t, chip, p, end) {
    var fam = chip.family, r = regs(fam);
    await waitIdle(t, r.sr, fam.SR_BUSY & ~2).catch(function () {});
    if (fam === H5 && ((await t.r32(r.sr)) & 2)) { await t.w32(r.cr, fam.CR_PG | 16); await waitIdle(t, r.sr, fam.SR_BUSY).catch(function () {}); }  // FW: force out a partial quad-word
    await t.w32(r.cr, 0);
    await r.clear(t);
    var list = sectorsFor(chip, Math.max(p.addr, end - BLOCK), end);
    for (var i = 0; i < list.length; i++) {
      var s = list[i], cr = fam === H5 ? fam.CR_SER | (s.index << 6) | (s.bank === 2 ? fam.CR_BKSEL : 0) : fam.CR_PER | (s.index << 3) | (s.bank === 2 ? fam.CR_BKER : 0);
      await t.w32(r.cr, cr >>> 0); await t.w32(r.cr, (cr | fam.CR_STRT) >>> 0);
      await finish(t, fam, 'Erasing ' + hex(s.addr) + ' again');
    }
    await t.w32(r.cr, 0);
    var from = Math.max(p.addr, list[0].addr);
    await t.w32(r.cr, fam.CR_PG);
    await writeUnits(t, fam, from, p.data.subarray(from - p.addr, end - p.addr));
  }
  async function writeUnits(t, fam, a, chunk) {
    var u = fam.unit;
    for (var i = 0; i < chunk.length; i += u) {
      await t.write(a + i, chunk.subarray(i, i + u), { noRetry: true });
      await finish(t, fam, 'Writing ' + hex(a + i));
    }
  }

  async function verify(t, addr, data, progress) {
    var step = 16384;
    for (var at = 0; at < data.length; at += step) {
      var n = Math.min(step, data.length - at), got = await t.read(addr + at, n);
      for (var i = 0; i < n; i++) if (got[i] !== data[at + i]) {
        var e = new Error('Verify failed at ' + hex(addr + at + i) + ': read ' + hex(got[i], 2) + ', expected ' + hex(data[at + i], 2) + '.');
        e.addr = addr + at + i; throw e;
      }
      if (progress) progress(Math.min(1, (at + n) / data.length), 'Checked ' + FL.files.fmtBytes(at + n) + ' of ' + FL.files.fmtBytes(data.length));
    }
  }

  // After programming a G0 that was blank at power-on: its EMPTY latch would boot the ROM on the next reset.
  async function afterProgram(t, chip, log) {
    if (chip.family !== G0) return;
    var acr = await t.r32(G0.base + G0.ACR);
    if (acr & (1 << 16)) {
      var first = await t.r32(chip.flashBase);
      if (first !== 0xFFFFFFFF) {
        await t.w32(G0.base + G0.ACR, (acr & ~(1 << 16)) >>> 0);
        var again = await t.r32(G0.base + G0.ACR);
        if (log) log(again & (1 << 16) ? 'FLASH_ACR.EMPTY is still set: the next reset may boot the ROM bootloader. Power-cycle the board.' : 'Cleared FLASH_ACR.EMPTY, so the next reset boots the new image.');
      }
    }
  }

  /* ── Option bytes. Each field: reg (CUR offset; prg is the register written), lsb, width, and how to show
     and guard it. refuse: never written by Flasher. warn(next, cur): a sentence shown in the diff. */
  var LEVELS = { 0: 'Level 0 (lowest)', 1: 'Level 1', 2: 'Level 2', 3: 'Level 3 (highest)' };
  function yes(on, off) { return { 1: on, 0: off }; }

  G0.options = [
    { key: 'RDP', reg: 0x20, lsb: 0, width: 8, label: 'Read protection (RDP)', values: { 0xAA: 'Level 0: no protection', 0xBB: 'Level 1: read protection' },
      show: function (v) { return v === 0xAA ? 'Level 0: no protection' : v === 0xCC ? 'Level 2: permanent' : 'Level 1: read protection (' + hex(v, 2) + ')'; },
      guard: function (n, c) {
        if (n === 0xCC) return { refuse: 'Level 2 is permanent: the chip could never be debugged or reprogrammed again. Flasher never sets it.' };
        if (c !== 0xAA && n === 0xAA) return { warn: 'Going from level 1 to level 0 erases the whole flash.' };
        if (c === 0xAA && n !== 0xAA) return { warn: 'At level 1 the debugger can no longer read the flash. Going back to level 0 erases it.' };
      } },
    { key: 'BOREN', reg: 0x20, lsb: 8, width: 1, label: 'Brown-out reset', values: yes('On', 'Off') },
    { key: 'BORF_LEV', reg: 0x20, lsb: 9, width: 2, label: 'Brown-out falling threshold', values: LEVELS },
    { key: 'BORR_LEV', reg: 0x20, lsb: 11, width: 2, label: 'Brown-out rising threshold', values: LEVELS },
    { key: 'nRST_STOP', reg: 0x20, lsb: 13, width: 1, label: 'Entering Stop', values: yes('No reset', 'Reset') },
    { key: 'nRST_STDBY', reg: 0x20, lsb: 14, width: 1, label: 'Entering Standby', values: yes('No reset', 'Reset') },
    { key: 'nRSTS_HDW', reg: 0x20, lsb: 15, width: 1, label: 'Entering Shutdown', values: yes('No reset', 'Reset') },
    { key: 'IWDG_SW', reg: 0x20, lsb: 16, width: 1, label: 'Independent watchdog', values: yes('Started by software', 'Started by hardware at reset') },
    { key: 'IWDG_STOP', reg: 0x20, lsb: 17, width: 1, label: 'IWDG in Stop', values: yes('Runs', 'Frozen') },
    { key: 'IWDG_STDBY', reg: 0x20, lsb: 18, width: 1, label: 'IWDG in Standby', values: yes('Runs', 'Frozen') },
    { key: 'WWDG_SW', reg: 0x20, lsb: 19, width: 1, label: 'Window watchdog', values: yes('Started by software', 'Started by hardware at reset') },
    { key: 'nSWAP_BANK', reg: 0x20, lsb: 20, width: 1, label: 'Bank swap', values: yes('Off (bank 1 at 0x08000000)', 'On (bank 2 at 0x08000000)'),
      guard: function (n) { if (n === 0) return { warn: 'With the banks swapped, the chip boots from bank 2, and Flasher won\'t write the flash until the swap is off again.' }; } },
    { key: 'DUAL_BANK', reg: 0x20, lsb: 21, width: 1, label: 'Flash banks', values: yes('Dual bank', 'Single bank'),
      guard: function () { return { warn: 'Changing the bank mode changes the flash layout. Erase the whole flash afterward.' }; } },
    { key: 'RAM_PARITY_CHECK', reg: 0x20, lsb: 22, width: 1, label: 'SRAM parity check', values: yes('Off', 'On') },
    { key: 'nBOOT_SEL', reg: 0x20, lsb: 24, width: 1, label: 'Boot selection', values: yes('From nBOOT0 (BOOT0 pin ignored)', 'From the BOOT0 pin'),
      guard: function () { return { warn: 'Boot settings decide whether the chip starts your code, the ROM bootloader, or SRAM.' }; } },
    { key: 'nBOOT1', reg: 0x20, lsb: 25, width: 1, label: 'nBOOT1', values: yes('1 (with BOOT0 = 1: ROM bootloader)', '0 (with BOOT0 = 1: SRAM)'),
      guard: function () { return { warn: 'Boot settings decide whether the chip starts your code, the ROM bootloader, or SRAM.' }; } },
    { key: 'nBOOT0', reg: 0x20, lsb: 26, width: 1, label: 'nBOOT0', values: yes('1 (boot from flash)', '0 (boot from the ROM bootloader or SRAM)'),
      guard: function (n) { if (n === 0) return { warn: 'With nBOOT0 = 0 and nBOOT_SEL = 1, the chip boots the ROM bootloader or SRAM, never your code.' }; } },
    { key: 'NRST_MODE', reg: 0x20, lsb: 27, width: 2, label: 'NRST pin', values: { 1: 'Reset input only', 2: 'GPIO (no reset pin)', 3: 'Bidirectional reset (default)' },
      guard: function (n) { if (n === 2) return { warn: 'As a GPIO, NRST no longer resets the chip, so Connect under reset stops working. Firmware that turns off SWD can then lock the debugger out.' }; } },
    { key: 'IRHEN', reg: 0x20, lsb: 29, width: 1, label: 'Internal resets drive NRST', values: yes('Yes', 'No') },
    { key: 'WRP1A_STRT', reg: 0x2C, lsb: 0, width: 7, label: 'Bank 1 write protection A: first page', num: true, guard: wrpWarn },
    { key: 'WRP1A_END', reg: 0x2C, lsb: 16, width: 7, label: 'Bank 1 write protection A: last page', num: true, guard: wrpWarn },
    { key: 'WRP1B_STRT', reg: 0x30, lsb: 0, width: 7, label: 'Bank 1 write protection B: first page', num: true, guard: wrpWarn },
    { key: 'WRP1B_END', reg: 0x30, lsb: 16, width: 7, label: 'Bank 1 write protection B: last page', num: true, guard: wrpWarn },
    { key: 'WRP2A_STRT', reg: 0x4C, lsb: 0, width: 7, label: 'Bank 2 write protection A: first page', num: true, guard: wrpWarn, dual: true },
    { key: 'WRP2A_END', reg: 0x4C, lsb: 16, width: 7, label: 'Bank 2 write protection A: last page', num: true, guard: wrpWarn, dual: true },
    { key: 'WRP2B_STRT', reg: 0x50, lsb: 0, width: 7, label: 'Bank 2 write protection B: first page', num: true, guard: wrpWarn, dual: true },
    { key: 'WRP2B_END', reg: 0x50, lsb: 16, width: 7, label: 'Bank 2 write protection B: last page', num: true, guard: wrpWarn, dual: true },
    { key: 'BOOT_LOCK', reg: 0x80, lsb: 16, width: 1, label: 'Boot lock (secure area)', values: yes('On', 'Off'), refuse: 'Boot lock forces the chip to boot its secure area and can lock it out. Flasher never changes it.' }
  ];
  function wrpWarn() { return { warn: 'A write-protected range (first page ≤ last page) can\'t be erased or programmed until the protection is removed. First page > last page means no protection.' }; }

  H5.options = [
    { key: 'PRODUCT_STATE', reg: 0x50, prg: 0x54, lsb: 8, width: 8, label: 'Product state', show: function (v) { return (H5.STATES[v] || '?') + ' (' + hex(v, 2) + ')'; },
      refuse: 'Product state changes can close debug access for good (Locked is permanent). Use STM32CubeProgrammer\'s provisioning tools for that.' },
    { key: 'BOR_LEV', reg: 0x50, prg: 0x54, lsb: 0, width: 2, label: 'Brown-out level', values: LEVELS },
    { key: 'BORH_EN', reg: 0x50, prg: 0x54, lsb: 2, width: 1, label: 'Brown-out on high threshold', values: yes('On', 'Off') },
    { key: 'IWDG_SW', reg: 0x50, prg: 0x54, lsb: 3, width: 1, label: 'Independent watchdog', values: yes('Started by software', 'Started by hardware at reset') },
    { key: 'WWDG_SW', reg: 0x50, prg: 0x54, lsb: 4, width: 1, label: 'Window watchdog', values: yes('Started by software', 'Started by hardware at reset') },
    { key: 'NRST_STOP', reg: 0x50, prg: 0x54, lsb: 6, width: 1, label: 'Entering Stop', values: yes('No reset', 'Reset') },
    { key: 'NRST_STDBY', reg: 0x50, prg: 0x54, lsb: 7, width: 1, label: 'Entering Standby', values: yes('No reset', 'Reset') },
    { key: 'IO_VDD_HSLV', reg: 0x50, prg: 0x54, lsb: 16, width: 1, label: 'VDD I/O high speed at low voltage', values: yes('On', 'Off'),
      guard: function (n) { if (n === 1) return { warn: 'Only for VDD below 2.7 V. With VDD above that, the I/Os can be damaged.' }; } },
    { key: 'IO_VDDIO2_HSLV', reg: 0x50, prg: 0x54, lsb: 17, width: 1, label: 'VDDIO2 I/O high speed at low voltage', values: yes('On', 'Off'),
      guard: function (n) { if (n === 1) return { warn: 'Only for VDDIO2 below 2.7 V. With VDDIO2 above that, the I/Os can be damaged.' }; } },
    { key: 'IWDG_STOP', reg: 0x50, prg: 0x54, lsb: 20, width: 1, label: 'IWDG in Stop', values: yes('Runs', 'Frozen') },
    { key: 'IWDG_STDBY', reg: 0x50, prg: 0x54, lsb: 21, width: 1, label: 'IWDG in Standby', values: yes('Runs', 'Frozen') },
    { key: 'BOOT_UBE', reg: 0x50, prg: 0x54, lsb: 22, width: 8, label: 'Unique boot entry', show: function (v) { return v === 0xB4 ? 'OEM-iRoT (0xB4)' : v === 0xC3 ? 'ST-iRoT (0xC3)' : hex(v, 2); },
      refuse: 'The unique boot entry chooses the root of trust the chip boots through. Flasher never changes it.' },
    { key: 'SWAP_BANK', reg: 0x50, prg: 0x54, lsb: 31, width: 1, label: 'Bank swap', values: yes('On (bank 2 at 0x08000000)', 'Off'),
      refuse: 'Bank swap changes which bank boots. Flasher doesn\'t write a swapped flash yet, so it doesn\'t set it either.' },
    { key: 'SRAM1_3_RST', reg: 0x70, prg: 0x74, lsb: 2, width: 1, label: 'SRAM1 and SRAM3 on system reset', values: yes('Kept', 'Erased') },
    { key: 'SRAM2_RST', reg: 0x70, prg: 0x74, lsb: 3, width: 1, label: 'SRAM2 on system reset', values: yes('Kept', 'Erased') },
    { key: 'BKPRAM_ECC', reg: 0x70, prg: 0x74, lsb: 4, width: 1, label: 'Backup RAM ECC', values: yes('Off', 'On') },
    { key: 'SRAM3_ECC', reg: 0x70, prg: 0x74, lsb: 5, width: 1, label: 'SRAM3 ECC', values: yes('Off', 'On') },
    { key: 'SRAM2_ECC', reg: 0x70, prg: 0x74, lsb: 6, width: 1, label: 'SRAM2 ECC', values: yes('Off', 'On') },
    { key: 'USBPD_DIS', reg: 0x70, prg: 0x74, lsb: 8, width: 1, label: 'USB Type-C dead battery pull-downs', values: yes('Off', 'On') },
    { key: 'TZEN', reg: 0x70, prg: 0x74, lsb: 24, width: 8, label: 'TrustZone', show: function (v) { return v === 0xB4 ? 'On (0xB4)' : v === 0xC3 ? 'Off (0xC3)' : hex(v, 2); },
      refuse: 'Turning TrustZone on changes the whole memory map, and turning it off needs a regression. Flasher never changes it.' },
    { key: 'NSBOOT_LOCK', reg: 0x80, prg: 0x84, lsb: 0, width: 8, label: 'Boot address lock', show: function (v) { return v === 0xB4 ? 'Locked (0xB4)' : v === 0xC3 ? 'Unlocked (0xC3)' : hex(v, 2); },
      refuse: 'Locking the boot address can\'t be undone without a regression. Flasher never changes it.' },
    { key: 'NSBOOTADD', reg: 0x80, prg: 0x84, lsb: 8, width: 24, label: 'Boot address (bits 31:8)', addr: true,
      guard: function () { return { warn: 'The chip starts from this address after reset. A wrong one leaves it unable to run your code.' }; } },
    { key: 'WRPSG1', reg: 0xE8, prg: 0xEC, lsb: 0, width: 32, label: 'Bank 1 write protection (1 bit per 4 sectors; 0 = protected)', mask: true, guard: wrpWarnH5 },
    { key: 'WRPSG2', reg: 0x1E8, prg: 0x1EC, lsb: 0, width: 32, label: 'Bank 2 write protection (1 bit per 4 sectors; 0 = protected)', mask: true, guard: wrpWarnH5 }
  ];
  function wrpWarnH5() { return { warn: 'Protected sectors can\'t be erased or programmed until the protection is removed.' }; }

  // Read every option field: { key: value }, from the CUR registers.
  async function readOptions(t, chip) {
    var fam = chip.family, cache = {}, out = {};
    for (var i = 0; i < fam.options.length; i++) {
      var f = fam.options[i];
      if (f.dual && !chip.dual) continue;
      if (cache[f.reg] === undefined) cache[f.reg] = await t.r32(fam.base + f.reg);
      out[f.key] = bits(cache[f.reg], f.lsb, f.width);
    }
    return out;
  }

  // Check a set of changes against the guards: { refused: [...], warnings: [...] }.
  function review(chip, cur, changes) {
    var fam = chip.family, refused = [], warnings = [];
    Object.keys(changes).forEach(function (k) {
      var f = fam.options.filter(function (x) { return x.key === k; })[0];
      if (!f) { refused.push({ key: k, why: 'Unknown field.' }); return; }
      if (f.refuse) { refused.push({ key: k, why: f.refuse }); return; }
      var g = f.guard && f.guard(changes[k], cur[k]);
      if (g && g.refuse) refused.push({ key: k, why: g.refuse });
      else if (g && g.warn) warnings.push({ key: k, why: g.warn });
    });
    return { refused: refused, warnings: warnings };
  }

  /* Write option changes. G0: write OPTR (and WRP) from a fresh read, OPTSTRT, then OBL_LAUNCH, which
     resets the chip (the SWD link drops; the caller reconnects). H5: write the _PRG registers from a fresh
     read, OPTSTRT; the new values show in _CUR at once or after a reset. */
  async function writeOptions(t, chip, changes, log) {
    var fam = chip.family, cur = await readOptions(t, chip), rv = review(chip, cur, changes);
    if (rv.refused.length) throw new Error('Refused: ' + rv.refused.map(function (r) { return r.key + ' (' + r.why + ')'; }).join('; '));
    var byReg = {};
    Object.keys(changes).forEach(function (k) {
      var f = fam.options.filter(function (x) { return x.key === k; })[0], prg = f.prg !== undefined ? f.prg : f.reg;
      (byReg[prg] = byReg[prg] || []).push(f);
    });
    await unlock(t, fam);
    if (fam === H5) {
      if ((await t.r32(fam.base + fam.OPTCR)) & 1) { await t.w32(fam.base + fam.OPTKEYR, OPTKEY1); await t.w32(fam.base + fam.OPTKEYR, OPTKEY2); }
      if ((await t.r32(fam.base + fam.OPTCR)) & 1) throw new Error('The option bytes would not unlock.');
    } else {
      await t.w32(fam.base + fam.OPTKEYR, OPTKEY1); await t.w32(fam.base + fam.OPTKEYR, OPTKEY2);
      if ((await t.r32(fam.base + fam.CR)) & fam.CR_OPTLOCK) throw new Error('The option bytes would not unlock.');
    }
    var regsOut = Object.keys(byReg).map(Number);
    for (var i = 0; i < regsOut.length; i++) {
      var reg = regsOut[i], v = await t.r32(fam.base + reg), before = v;
      byReg[reg].forEach(function (f) { v = setBits(v, f.lsb, f.width, changes[f.key]); });
      if (log) log('Option register ' + hex(fam.base + reg) + ': ' + hex(before) + ' → ' + hex(v));
      await t.w32(fam.base + reg, v);
    }
    if (fam === H5) {
      var o = await t.r32(fam.base + fam.OPTCR);
      await t.w32(fam.base + fam.OPTCR, (o | 2) >>> 0);
      var sr = await waitIdle(t, fam.base + fam.NSSR, fam.SR_BUSY, 30000);
      if (sr & fam.SR_ERR) { await regs(fam).clear(t); throw new Error('Option change failed: ' + errText(fam, sr) + '.'); }
      await t.w32(fam.base + fam.OPTCR, 1);  // lock the options again
      await lock(t, fam);
      return { reset: false };
    }
    var cr = await t.r32(fam.base + fam.CR);
    await t.w32(fam.base + fam.CR, (cr | fam.CR_OPTSTRT) >>> 0);
    var sr0 = await waitIdle(t, fam.base + fam.SR, fam.SR_BUSY, 30000);
    if (sr0 & fam.SR_ERR) { await regs(fam).clear(t); throw new Error('Option change failed: ' + errText(fam, sr0) + '.'); }
    if (log) log('Loading the new option bytes (OBL_LAUNCH): the chip resets.');
    try { await t.w32(fam.base + fam.CR, (fam.CR_OBL_LAUNCH) >>> 0); } catch (e) { /* the reset cuts the link */ }
    return { reset: true };
  }

  FL.stm32 = {
    FAMILIES: FAMILIES, G0: G0, H5: H5, identify: identify, sectorsFor: sectorsFor, eraseSectors: eraseSectors, massErase: massErase,
    program: program, verify: verify, afterProgram: afterProgram, readOptions: readOptions, writeOptions: writeOptions, review: review,
    padded: padded, bits: bits, setBits: setBits, hex: hex
  };
})();
