/* Internal flash sectors of the chips that run the Dovetail serial bootloader, from ST's reference
   manuals (datasheet facts only), keyed by the DBGMCU device id the bootloader's INFO reports.

   Each entry: { name, base, banks: { single: [[size, count], …], dual: … } }. Sectors run back to back
   from base. A chip whose flash is smaller than the table simply never reaches the later sectors: the
   bootloader's appEnd bounds what's used. Add a chip here when it first runs the bootloader.

   Chips whose sectors are all one size list the same map for both bank modes. F76x and F77x in dual-bank mode
   aren't listed: bank 2 starts at 0x08100000 or 0x08080000 depending on
   the flash size, which INFO doesn't report. The bootloader runs them single-bank (nDBANK set). */
(function (FL) {
  'use strict';
  var K = 1024;
  var CHIPS = {
    0x449: { name: 'STM32F74x/F75x', base: 0x08000000, banks: { single: [[32 * K, 4], [128 * K, 1], [256 * K, 3]] } },
    0x451: { name: 'STM32F76x/F77x', base: 0x08000000, banks: { single: [[32 * K, 4], [128 * K, 1], [256 * K, 7]] } },
    0x452: { name: 'STM32F72x/F73x', base: 0x08000000, banks: { single: [[16 * K, 4], [64 * K, 1], [128 * K, 3]] } },
    // Two 1 MB banks of 8 KB sectors, contiguous from 0x08000000 (bank swap off): the same map either way.
    0x484: { name: 'STM32H56x/H57x', base: 0x08000000, banks: { single: [[8 * K, 256]], dual: [[8 * K, 256]] } }
  };

  /* The sectors of a chip, [[start, size], …], or null when the table doesn't know it (or that bank mode). */
  function sectors(device, singleBank) {
    var c = CHIPS[device], runs = c && c.banks[singleBank ? 'single' : 'dual'];
    if (!runs) return null;
    var out = [], at = c.base;
    runs.forEach(function (r) { for (var i = 0; i < r[1]; i++) { out.push([at, r[0]]); at += r[0]; } });
    return out;
  }
  function chip(device) { return CHIPS[device] || null; }

  FL.sectors = { CHIPS: CHIPS, sectors: sectors, chip: chip };
})(window.FL = window.FL || {});
