/* A simulated ST-LINK/V3 with an STM32 behind it, for ?demo and the tests. It answers the same 16-byte
   commands stlink.js sends and keeps the flash controller's rules, so the page and the tests exercise the
   real command stream:
   - G0B1 (512 KB, two banks of 2 KB pages, double-word writes) on AP0;
   - H563 (2 MB, two banks of 8 KB sectors, quad-word writes) on AP1, whose AP0 reaches no memory.
   Not modelled: timing, clocks, and peripherals beyond reading back what was written. */
(function () {
  'use strict';
  var FL = window.FL = window.FL || {};

  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function le(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }

  var CHIPS = {
    g0: { name: 'G0B1', ap: 0, cpuid: 0x410CC601, idAddr: 0x40015800, idcode: 0x20000467, flash: 512 * 1024, sector: 2048, unit: 8,
      sizeAddr: 0x1FFF75E0, uidAddr: 0x1FFF7590, sram: 0x20000000, sramSize: 144 * 1024 },
    h5: { name: 'H563', ap: 1, cpuid: 0x411FD210, idAddr: 0x44024000, idcode: 0x10010484, flash: 2048 * 1024, sector: 8192, unit: 16,
      sizeAddr: 0x08FFF80C, uidAddr: 0x08FFF800, sram: 0x20000000, sramSize: 640 * 1024 }
  };
  var FB = 0x40022000;

  function Chip(kind, o) {
    o = o || {};
    var c = this.c = CHIPS[kind];
    this.kind = kind;
    this.flash = new Uint8Array(c.flash).fill(0xFF);
    this.ram = new Uint8Array(c.sramSize);
    this.regs = {};        // peripheral words written (any address not modelled)
    this.halted = false; this.debugen = false; this.vc = false; this.inReset = false; this.resets = 0;
    this.locked = true; this.optLocked = true;
    this.cr = 0; this.sr = 0; this.acr = kind === 'g0' ? (o.empty ? 1 << 16 : 0) | 0x600 : 0x13;
    this.pending = null;   // a partly written unit: { addr, bytes }
    this.keyStep = 0; this.optKeyStep = 0;
    if (kind === 'g0') { this.optr = 0xFFFFFEAA; this.opt = { 0x2C: 0x000000FF, 0x30: 0x000000FF, 0x4C: 0x000000FF, 0x50: 0x000000FF, 0x80: 0 }; }
    // H5: product state Open (0xED), BOOT_UBE ST-iRoT (0xC3), watchdogs by software, no resets on Stop/Standby.
    else { this.opt = { 0x50: 0x30F0EDD8, 0x70: 0xC3000000, 0x80: 0x080000C3, 0xE8: 0xFFFFFFFF, 0x1E8: 0xFFFFFFFF }; this.optcr = 1; }
    this.optPrg = {};
    this.writes = [];      // flash program writes seen, for tests
    this.noNrst = !!o.noNrst;
    this.log = [];
  }

  Chip.prototype.inFlash = function (a) { return a >= 0x08000000 && a < 0x08000000 + this.c.flash; };

  Chip.prototype.read32 = function (a, ap) {
    var c = this.c, k = this.kind;
    if (ap !== c.ap) throw 0x11;
    if (a === 0xE000ED00) return c.cpuid;
    if (a === 0xE000EDF0) { var rs = this.resetSt ? 1 << 25 : 0; this.resetSt = false; return ((this.debugen ? 1 : 0) | (this.halted ? 1 << 17 : 0) | (1 << 16) | rs) >>> 0; }
    if (a === 0xE000EDFC) return this.vc ? 1 : 0;
    if (a === 0xE000EDF8) return this.dcrdr || 0;
    if (a === c.idAddr) return c.idcode;
    if (a === c.sizeAddr - (c.sizeAddr & 3)) { var kb = c.flash / 1024; return (c.sizeAddr & 3) ? (kb << 16) >>> 0 : kb; }
    if (a >= c.uidAddr && a < c.uidAddr + 12) return [0x00230041, 0x3233510A, 0x37373439][(a - c.uidAddr) >> 2];
    if (this.inFlash(a)) { var o = a - 0x08000000; return u32(this.flash, o); }
    if (a >= c.sram && a < c.sram + c.sramSize) return u32(this.ram, a - c.sram);
    if (a >= FB && a < FB + 0x400) return this.flashReg(a - FB);
    return this.regs[a] || 0;
  };

  Chip.prototype.flashReg = function (off) {
    var k = this.kind;
    if (k === 'g0') {
      if (off === 0x00) return this.acr;
      if (off === 0x10) return this.sr;
      if (off === 0x14) return (this.cr | (this.locked ? 1 << 31 : 0) | (this.optLocked ? 1 << 30 : 0)) >>> 0;
      if (off === 0x20) return this.optr;
      return this.opt[off] || 0;
    }
    if (off === 0x1C) return this.optcr;
    if (off === 0x20) return (this.sr | (this.pending ? 2 : 0)) >>> 0;
    if (off === 0x28) return (this.cr | (this.locked ? 1 : 0)) >>> 0;
    if (this.opt[off] !== undefined) return this.opt[off];
    if (this.opt[off - 4] !== undefined) return this.optPrg[off - 4] !== undefined ? this.optPrg[off - 4] : this.opt[off - 4];
    return 0;
  };

  Chip.prototype.err = function (bit) { this.sr = (this.sr | (1 << bit)) >>> 0; };

  Chip.prototype.write32 = function (a, v, ap) {
    var c = this.c;
    if (ap !== c.ap) throw 0x11;
    v >>>= 0;
    if (a === 0xE000EDF0) {
      if ((v >>> 16) !== 0xA05F) return;
      this.debugen = !!(v & 1);
      if (v & 2) this.halted = true; else if (!this.inReset) this.halted = false;
      if (!this.debugen) this.halted = false;
      return;
    }
    if (a === 0xE000EDFC) { this.vc = !!(v & 1); return; }
    if (a === 0xE000ED0C) { if ((v >>> 16) === 0x05FA && (v & 4)) this.reset(); return; }
    if (a === 0xE000EDF4) { this.dcrdr = v & 0x10000 ? this.dcrdr : 0x20000000 + (v & 31) * 4; return; }
    if (a === 0xE000EDF8) { this.dcrdr = v; return; }
    if (this.inFlash(a)) return this.flashWrite(a, v);
    if (a >= c.sram && a < c.sram + c.sramSize) { this.ram.set(le(v), a - c.sram); return; }
    if (a >= FB && a < FB + 0x400) return this.flashCtl(a - FB, v);
    this.regs[a] = v;
  };

  Chip.prototype.reset = function () {
    this.resets++;
    this.resetSt = true;
    this.halted = this.debugen && this.vc;
    this.locked = true; this.optLocked = true; this.cr = 0; this.pending = null;
    if (this.kind === 'h5') this.optcr = 1;
  };

  Chip.prototype.flashWrite = function (a, v) {
    var pg = this.kind === 'g0' ? 1 : 2, u = this.c.unit;
    if (this.locked || !(this.cr & pg)) { this.err(this.kind === 'g0' ? 7 : 18); return; }
    if (!this.pending) {
      if (a % u) { this.err(this.kind === 'g0' ? 5 : 20); return; }
      this.pending = { addr: a, bytes: [] };
    } else if (a !== this.pending.addr + this.pending.bytes.length) { this.err(this.kind === 'g0' ? 7 : 20); this.pending = null; return; }
    this.pending.bytes.push.apply(this.pending.bytes, le(v));
    if (this.pending.bytes.length === u) {
      var o = this.pending.addr - 0x08000000, ok = true;
      for (var i = 0; i < u; i++) if (this.flash[o + i] !== 0xFF) ok = false;
      if (!ok) this.err(this.kind === 'g0' ? 3 : 20);
      else { this.flash.set(this.pending.bytes, o); this.writes.push(this.pending.addr); }
      this.pending = null;
    }
  };

  Chip.prototype.flashCtl = function (off, v) {
    var k = this.kind, KEY1 = 0x45670123, KEY2 = 0xCDEF89AB;
    if (k === 'g0') {
      if (off === 0x00) { this.acr = v; return; }
      if (off === 0x08) { if (v === KEY1) this.keyStep = 1; else if (v === KEY2 && this.keyStep === 1) { this.locked = false; this.keyStep = 0; } else this.keyStep = 0; return; }
      if (off === 0x0C) { if (this.locked) return; if (v === 0x08192A3B) this.optKeyStep = 1; else if (v === 0x4C5D6E7F && this.optKeyStep === 1) this.optLocked = false; return; }
      if (off === 0x10) { this.sr = (this.sr & ~(v & 0xC3FB)) >>> 0; return; }
      if (off === 0x20) { if (!this.optLocked) this.optPrg.optr = v; return; }
      if (this.opt[off] !== undefined && off !== 0x80) { if (!this.optLocked) this.optPrg[off] = v; return; }
      if (off !== 0x14) return;
      if (this.locked) return;
      if (v & (1 << 31)) { this.locked = true; this.optLocked = true; this.cr = 0; return; }
      this.cr = v & ~((1 << 16) | (1 << 17) | (1 << 27));
      if (!(v & 1)) this.pending = null;   // PG off drops a half-written unit
      if (v & (1 << 16)) {
        if (v & 2) {
          var page = (v >>> 3) & 0x3FF, bank = v & (1 << 13) ? 1 : 0, at = bank * (this.c.flash / 2) + page * 2048;
          if (page >= 128) { this.err(7); return; }
          this.flash.fill(0xFF, at, at + 2048); this.log.push('erase page ' + (bank + 1) + ':' + page);
        } else if (v & (4 | (1 << 15))) {
          if (v & 4) this.flash.fill(0xFF, 0, this.c.flash / 2);
          if (v & (1 << 15)) this.flash.fill(0xFF, this.c.flash / 2);
          this.log.push('mass erase');
        }
        this.sr |= 1;
      }
      if (v & (1 << 17)) { if (this.optLocked) { this.err(7); return; } if (this.optPrg.optr !== undefined) this.optrStaged = this.optPrg.optr; this.optStaged = true; }
      if (v & (1 << 27)) {
        if (this.optStaged) {
          var oldRdp = this.optr & 255;
          if (this.optrStaged !== undefined) this.optr = this.optrStaged >>> 0;
          var self = this; Object.keys(this.optPrg).forEach(function (r) { if (r !== 'optr') self.opt[r] = self.optPrg[r]; });
          if (oldRdp !== 0xAA && (this.optr & 255) === 0xAA) this.flash.fill(0xFF);
          this.optStaged = false; this.optPrg = {}; this.optrStaged = undefined;
        }
        this.acr &= ~(1 << 16);
        this.reset();
        this.linkDropped = true;
      }
      return;
    }
    // H5
    if (off === 0x04) { if (v === KEY1) this.keyStep = 1; else if (v === KEY2 && this.keyStep === 1) { this.locked = false; this.keyStep = 0; } else this.keyStep = 0; return; }
    if (off === 0x0C) { if (v === 0x08192A3B) this.optKeyStep = 1; else if (v === 0x4C5D6E7F && this.optKeyStep === 1) this.optcr &= ~1; return; }
    if (off === 0x30) { this.sr = (this.sr & ~(v & 0xFF0000)) >>> 0; return; }
    if (off === 0x1C) {
      if (v & 1) { this.optcr |= 1; return; }
      if ((v & 2) && !(this.optcr & 1)) { var s = this; Object.keys(this.optPrg).forEach(function (r) { s.opt[r] = s.optPrg[r]; }); this.optPrg = {}; this.sr |= 1 << 16; }
      return;
    }
    if (this.opt[off - 4] !== undefined && (off & 4)) { if (!(this.optcr & 1)) this.optPrg[off - 4] = v; return; }
    if (off !== 0x28) return;
    if (this.locked) return;
    if (v & 1) { this.locked = true; this.cr = 0; return; }
    this.cr = v & ~(32 | 16);
    if ((v & 16) && this.pending) {   // FW: force out a partial quad-word
      var po = this.pending.addr - 0x08000000; this.flash.set(this.pending.bytes, po); this.pending = null;
    }
    if (!(v & 2)) this.pending = null;
    if (v & 32) {
      var bankSize = this.c.flash / 2, bk = v & (1 << 31) ? 1 : 0;
      if (v & 4) { var snb = (v >>> 6) & 127, at2 = bk * bankSize + snb * 8192; this.flash.fill(0xFF, at2, at2 + 8192); this.log.push('erase sector ' + (bk + 1) + ':' + snb); }
      else if (v & (1 << 15)) { this.flash.fill(0xFF); this.log.push('mass erase'); }
      else if (v & 8) { this.flash.fill(0xFF, bk * bankSize, (bk + 1) * bankSize); this.log.push('bank erase ' + (bk + 1)); }
      this.sr |= 1 << 16;
    }
  };

  /* The ST-LINK/V3 side: a WebUSB device whose bulk endpoints speak the probe's commands. */
  function FakeStLink(kind, o) {
    o = o || {};
    this.chip = new Chip(kind || 'g0', o);
    this.vendorId = 0x0483; this.productId = 0x3754; this.productName = 'STLINK-V3'; this.manufacturerName = 'STMicroelectronics';
    this.serialNumber = 'DEMO0001';
    this.opened = false;
    this.configuration = null;
    this.out = []; this.expect = null; this.mode = 1; this.nrstLow = false; this.aps = {}; this.last = 0x80;
    this.khz = 8000; this.cmdLog = [];
    this.waitEvery = o.waitEvery || 0; this.writeCount = 0; this.waits = 0;
  }
  FakeStLink.prototype.open = async function () { this.opened = true; };
  FakeStLink.prototype.close = async function () { this.opened = false; };
  FakeStLink.prototype.selectConfiguration = async function () {
    this.configuration = { interfaces: [
      { interfaceNumber: 0, alternate: { interfaceClass: 0xFF, endpoints: [{ direction: 'in', endpointNumber: 1, type: 'bulk' }, { direction: 'out', endpointNumber: 1, type: 'bulk' }, { direction: 'in', endpointNumber: 2, type: 'bulk' }] } },
      { interfaceNumber: 1, alternate: { interfaceClass: 2, endpoints: [] } }
    ] };
  };
  FakeStLink.prototype.claimInterface = async function () { if (!this.configuration) await this.selectConfiguration(); };
  FakeStLink.prototype.releaseInterface = async function () {};
  FakeStLink.prototype.reply = function (bytes) { this.out.push(new Uint8Array(bytes)); };
  FakeStLink.prototype.transferIn = async function (ep, len) {
    var b = this.out.shift();
    if (!b) throw new Error('fake ST-LINK: nothing to read');
    return { status: 'ok', data: new DataView(b.buffer, 0, Math.min(len, b.length)) };
  };
  FakeStLink.prototype.transferOut = async function (ep, data) {
    var b = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    if (this.expect) { var x = this.expect; this.expect = null; this.writeMem(x, b); return { status: 'ok' }; }
    this.cmdLog.push(Array.from(b.slice(0, 3)));
    this.command(b);
    return { status: 'ok', bytesWritten: b.length };
  };
  FakeStLink.prototype.command = function (b) {
    var c = b[0], ch = this.chip;
    if (c === 0xF1) return this.reply([0x30, 0x00, 0x83, 0x04, 0x54, 0x37]);
    if (c === 0xFB) return this.reply([3, 0, 16, 9, 0, 0, 0, 0, 0x83, 0x04, 0x54, 0x37]);
    if (c === 0xF5) return this.reply([this.mode, 4]);
    if (c === 0xF7) return this.reply([0, 6, 0, 0].concat(le(Math.round(1536 * 3.3 / 2.4))));  // 3.30 V
    if (c === 0xF3) { this.mode = 1; return; }
    if (c !== 0xF2) return;
    var s = b[1];
    if (s === 0x21) { this.mode = 1; return; }
    if (s === 0x30) { this.mode = 2; return this.reply([0x80, 0]); }
    if (s === 0x3C) {
      if (ch.noNrst) return this.reply([0x80, 0]);   // NRST not wired: the chip never sees it
      if (b[2] === 0) { this.nrstLow = true; ch.inReset = true; }
      else if (b[2] === 1) { if (this.nrstLow) { ch.inReset = false; ch.reset(); } this.nrstLow = false; }
      else ch.reset();
      return this.reply([0x80, 0]);
    }
    if (s === 0x61) { this.khz = u32(b, 4); return this.reply([0x80, 0, 0, 0].concat(le(this.khz))); }
    if (s === 0x62) { var r = new Array(52).fill(0); r[0] = 0x80; r.splice(4, 4, ...le(this.khz)); r.splice(8, 4, ...le(3)); r.splice(12, 12, ...le(24000), ...le(8000), ...le(1000)); return this.reply(r); }
    if (s === 0x43) return this.reply([0x80, 0]);
    if (s === 0x4B) { this.aps[b[2]] = true; return this.reply([0x80, 0]); }
    if (s === 0x3E) { var st = this.last; this.last = 0x80; return this.reply([st].concat(new Array(11).fill(0))); }
    var addr = u32(b, 2), len = b[6] | (b[7] << 8), ap = b[8];
    if (s === 0x07 || s === 0x0C) {
      var out = new Uint8Array(s === 0x0C ? Math.max(len, 2) : len);
      try {
        if (this.mode !== 2) throw 0x05;
        for (var i = 0; i < len; i += 4) {
          var w = ch.read32(((addr + i) & ~3) >>> 0, ap), bytes = le(w);
          for (var j = 0; j < 4 && i + j < len; j++) out[i + j] = bytes[((addr + i) & 3) + j] !== undefined ? bytes[((addr + i) & 3) + j] : 0;
        }
      } catch (e) { this.last = typeof e === 'number' ? e : 0x12; }
      return this.reply(out);
    }
    if (s === 0x08 || s === 0x0D) { this.expect = { addr: addr, len: len, ap: ap, bytes: s === 0x0D }; return; }
  };
  FakeStLink.prototype.writeMem = function (x, b) {
    var ch = this.chip;
    try {
      if (this.mode !== 2) throw 0x05;
      if (x.bytes) {
        // byte writes: read-modify-write a word (enough for RAM and the demo)
        for (var i = 0; i < x.len; i++) {
          var a = x.addr + i, w = ch.read32((a & ~3) >>> 0, x.ap), sh = (a & 3) * 8;
          ch.write32((a & ~3) >>> 0, ((w & ~(255 << sh)) | (b[i] << sh)) >>> 0, x.ap);
        }
      } else {
        // waitEvery: the n-th block write stops at an odd word, as a probe whose AP answered WAIT would
        var stop = this.waitEvery && x.len > 16 && ++this.writeCount % this.waitEvery === 0 ? ((x.len >> 3) << 2) + 4 : x.len;
        for (var k = 0; k < stop; k += 4) ch.write32(x.addr + k, u32(b, k), x.ap);
        if (stop < x.len) { this.waits++; throw 0x10; }
      }
    } catch (e) { this.last = typeof e === 'number' ? e : 0x12; }
  };

  FL.fakeprobe = { FakeStLink: FakeStLink, Chip: Chip, CHIPS: CHIPS };
})();
