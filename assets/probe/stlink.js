/* ST-LINK over WebUSB: the probe's own command set (V2, V2-1, and V3), framed as probe-rs frames it.

   Every command is a 16-byte frame on the debug interface's bulk OUT endpoint; data goes out after it
   (writes) or comes back on bulk IN (reads). Memory goes through an access port (AP): AP0 on most STM32s,
   AP1 for the Cortex-M33 on the STM32H5. One command at a time: calls are queued.

   The probe API (shared with jlink.js):
     open(), close(), info, voltage(), connect({ khz, underReset }), disconnect(), nrst(level),
     read(ap, addr, len) → Uint8Array, write(ap, addr, bytes), read32(ap, addr), write32(ap, addr, value),
     speeds() */
(function () {
  'use strict';
  var FL = window.FL = window.FL || {};

  var C = {
    GET_VERSION: 0xF1, DEBUG: 0xF2, DFU: 0xF3, SWIM: 0xF4, GET_MODE: 0xF5, GET_VOLTAGE: 0xF7, GET_VERSION_EX: 0xFB,
    DFU_EXIT: 0x07, SWIM_EXIT: 0x01,
    READMEM_32: 0x07, WRITEMEM_32: 0x08, READMEM_8: 0x0C, WRITEMEM_8: 0x0D,
    EXIT: 0x21, ENTER2: 0x30, ENTER_SWD: 0xA3,
    LASTRW2: 0x3E, DRIVE_NRST: 0x3C, SWD_SET_FREQ: 0x43, READ_DAP: 0x45, WRITE_DAP: 0x46,
    INIT_AP: 0x4B, SET_COM_FREQ: 0x61, GET_COM_FREQ: 0x62
  };
  var STATUS = {
    0x80: 'OK', 0x01: 'unknown error', 0x02: 'SPI error', 0x03: 'DMA error', 0x04: 'unknown JTAG chain',
    0x05: 'no device connected', 0x06: 'internal error', 0x07: 'command wait', 0x08: 'command error',
    0x09: 'could not read the target ID (is it powered and wired?)', 0x0A: 'alignment error',
    0x0B: 'debug power error', 0x0C: 'write error', 0x0D: 'write verify error', 0x0E: 'already open in another mode',
    0x10: 'AP wait', 0x11: 'AP fault', 0x12: 'AP error', 0x13: 'AP parity error', 0x14: 'DP wait', 0x15: 'DP fault',
    0x16: 'DP error', 0x17: 'DP parity error', 0x18: 'AP write data error', 0x19: 'AP sticky error',
    0x1A: 'AP sticky overrun error', 0x1D: 'bad AP', 0x41: 'frequency not supported', 0x42: 'unknown command'
  };
  var WAITS = { 0x10: 1, 0x14: 1 };
  // V2's SWD clock is a delay count (probe-rs's table): kHz → count.
  var V2_FREQ = [[4600, 0], [1800, 1], [1200, 2], [950, 3], [650, 5], [480, 7], [400, 9], [360, 10], [240, 15], [150, 25], [125, 31], [100, 40]];
  var NAMES = { 0x3748: 'ST-LINK/V2', 0x374B: 'ST-LINK/V2-1', 0x374A: 'ST-LINK/V2-1', 0x3742: 'ST-LINK/V2-1', 0x3752: 'ST-LINK/V2-1',
    0x374E: 'STLINK-V3', 0x374F: 'STLINK-V3', 0x3753: 'STLINK-V3', 0x3754: 'STLINK-V3', 0x3757: 'STLINK-V3PWR' };
  var FILTERS = Object.keys(NAMES).map(function (p) { return { vendorId: 0x0483, productId: +p }; });
  var BLOCK = 1024;  // never cross a 1 KB boundary in one transfer: the AP's address auto-increment wraps there

  function ProbeError(msg, code) { var e = new Error(msg); e.code = code; return e; }
  function u32le(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
  // A USB read that never comes back (a hung probe) becomes an error after 5 s instead of freezing the page.
  function within(p, ms, what) {
    var timer; return Promise.race([p, new Promise(function (_, rej) { timer = setTimeout(function () { rej(ProbeError('The ' + what + ' stopped answering. Unplug it, plug it back in, and connect again.', 'timeout')); }, ms); })]).finally(function () { clearTimeout(timer); });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function StLink(device, opts) {
    this.dev = device;
    this.opts = opts || {};
    this.sleep = this.opts.sleep || sleep;
    this.kind = 'stlink';
    this.info = { name: NAMES[device.productId] || 'ST-LINK', pid: device.productId, serial: device.serialNumber || '' };
    this.q = Promise.resolve();
    this.aps = {};
    this.hw = 0; this.jtag = 0;
    this.epOut = 0; this.epIn = 0; this.iface = 0;
  }

  // One USB exchange at a time, in order, whatever the callers do.
  StLink.prototype.run = function (fn) {
    var self = this, p = this.q.then(function () { return fn.call(self); });
    this.q = p.catch(function () {});
    return p;
  };

  StLink.prototype.xfer = async function (cmd, out, inLen) {
    var frame = new Uint8Array(16); frame.set(cmd);
    await within(this.dev.transferOut(this.epOut, frame), 5000, 'ST-LINK');
    if (out && out.length) await within(this.dev.transferOut(this.epOut, out), 5000, 'ST-LINK');
    if (!inLen) return null;
    var r = await within(this.dev.transferIn(this.epIn, inLen), 5000, 'ST-LINK');
    if (r.status !== 'ok') throw ProbeError('The ST-LINK stopped answering (USB ' + r.status + ').', 'usb');
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  };
  // A debug command whose first reply byte is a status.
  StLink.prototype.cmd = async function (cmd, inLen) {
    for (var attempt = 0; ; attempt++) {
      var r = await this.xfer(cmd, null, inLen || 2);
      if (r[0] === 0x80) return r;
      if (WAITS[r[0]] && attempt < 12) { await this.sleep(Math.min(50, 1 << attempt)); continue; }
      throw ProbeError('ST-LINK: ' + (STATUS[r[0]] || 'status 0x' + r[0].toString(16)) + '.', r[0]);
    }
  };
  StLink.prototype.lastStatus = async function () {
    var r = await this.xfer([C.DEBUG, C.LASTRW2], null, 12);
    if (r[0] !== 0x80) {
      var e = ProbeError('ST-LINK: ' + (STATUS[r[0]] || 'status 0x' + r[0].toString(16)) + '.', r[0]);
      e.wait = !!WAITS[r[0]];
      throw e;
    }
  };

  StLink.prototype.open = function () {
    return this.run(async function () {
      var d = this.dev;
      if (!d.opened) await d.open();
      if (!d.configuration) await d.selectConfiguration(1);
      var it = d.configuration.interfaces.filter(function (i) { return i.alternate.interfaceClass === 0xFF; })[0];
      if (!it) throw ProbeError('This device has no ST-LINK debug interface.', 'noiface');
      this.iface = it.interfaceNumber;
      try { await d.claimInterface(this.iface); }
      catch (e) { throw ProbeError('Another program has the ST-LINK open. Close STM32CubeProgrammer, CubeIDE, or OpenOCD, then try again.', 'busy'); }
      var eps = it.alternate.endpoints;
      this.epOut = eps.filter(function (e) { return e.direction === 'out'; })[0].endpointNumber;
      this.epIn = eps.filter(function (e) { return e.direction === 'in' && e.type === 'bulk'; })[0].endpointNumber;
      await this.idle();
      var v = await this.xfer([C.GET_VERSION], null, 6);
      var w = (v[0] << 8) | v[1];
      this.hw = w >> 12; this.jtag = (w >> 6) & 63;
      var swim = w & 63, msd = 0, bridge = 0;
      if (this.hw >= 3) {
        var x = await this.xfer([C.GET_VERSION_EX], null, 12);
        this.hw = x[0]; swim = x[1]; this.jtag = x[2]; msd = x[3]; bridge = x[4];
      }
      this.info.hw = this.hw; this.info.jtag = this.jtag;
      this.info.firmware = 'V' + this.hw + 'J' + this.jtag + (this.hw >= 3 ? 'M' + msd + (bridge ? 'B' + bridge : '') : 'S' + swim);
      this.info.multiAp = this.hw >= 3 || this.jtag >= 28;
      if (this.hw < 3 && this.jtag < 26) throw ProbeError('This ST-LINK\'s firmware (' + this.info.firmware + ') is too old. Update it with STM32CubeProgrammer\'s firmware upgrade, then try again.', 'firmware');
      return this.info;
    });
  };

  // Leave whatever mode the probe was left in (DFU, a debug session); mass-storage mode needs nothing.
  StLink.prototype.idle = async function () {
    var m = await this.xfer([C.GET_MODE], null, 2);
    if (m[0] === 2) await this.xfer([C.DEBUG, C.EXIT]);
    else if (m[0] === 0) await this.xfer([C.DFU, C.DFU_EXIT]);
    else if (m[0] === 3) await this.xfer([C.SWIM, C.SWIM_EXIT]);
  };

  StLink.prototype.voltage = function () {
    return this.run(async function () {
      var r = await this.xfer([C.GET_VOLTAGE], null, 8);
      var dv = new DataView(r.buffer, r.byteOffset, 8), a0 = dv.getUint32(0, true), a1 = dv.getUint32(4, true);
      return a0 ? 2 * a1 * 1.2 / a0 : null;
    });
  };

  // The SWD clocks this probe offers, in kHz, fastest first.
  StLink.prototype.speeds = function () {
    return this.run(async function () {
      if (this.hw < 3) return V2_FREQ.map(function (f) { return f[0]; });
      var r = await this.cmd([C.DEBUG, C.GET_COM_FREQ, 0], 52), dv = new DataView(r.buffer, r.byteOffset, 52);
      var n = Math.min(dv.getUint32(8, true), 10), out = [];
      for (var i = 0; i < n; i++) out.push(dv.getUint32(12 + 4 * i, true));
      return out.sort(function (a, b) { return b - a; });
    });
  };
  StLink.prototype.setSpeed = async function (khz) {
    if (this.hw >= 3) {
      var r = await this.cmd([C.DEBUG, C.SET_COM_FREQ, 0, 0].concat(u32le(khz)), 8);
      return new DataView(r.buffer, r.byteOffset, 8).getUint32(4, true) || khz;
    }
    var pick = V2_FREQ.filter(function (f) { return f[0] <= khz; })[0] || V2_FREQ[V2_FREQ.length - 1];
    await this.cmd([C.DEBUG, C.SWD_SET_FREQ, pick[1]]);
    return pick[0];
  };

  // NRST: 'low', 'high', or 'pulse'.
  StLink.prototype.nrst = function (level) {
    return this.run(function () { return this.cmd([C.DEBUG, C.DRIVE_NRST, { low: 0, high: 1, pulse: 2 }[level]]); });
  };

  // Start an SWD session. With underReset, NRST is held low first and left low: the caller releases it.
  StLink.prototype.connect = function (o) {
    o = o || {};
    return this.run(async function () {
      await this.idle();
      this.aps = {};
      if (o.underReset) await this.cmd([C.DEBUG, C.DRIVE_NRST, 0]);
      this.khz = await this.setSpeed(o.khz || 4000);
      await this.cmd([C.DEBUG, C.ENTER2, C.ENTER_SWD, 0]);
      return this.khz;
    });
  };
  StLink.prototype.disconnect = function () {
    return this.run(async function () { this.aps = {}; await this.xfer([C.DEBUG, C.EXIT]); });
  };
  StLink.prototype.close = async function () {
    try { await this.disconnect(); } catch (e) { /* already gone */ }
    try { await this.dev.releaseInterface(this.iface); } catch (e) { /* closed */ }
    try { await this.dev.close(); } catch (e) { /* closed */ }
  };

  StLink.prototype.ap = async function (ap) {
    if (this.aps[ap]) return;
    if (!this.info.multiAp) { if (ap) throw ProbeError('This ST-LINK\'s firmware can\'t reach access port ' + ap + '. Update its firmware.', 'firmware'); return; }
    await this.cmd([C.DEBUG, C.INIT_AP, ap]);
    this.aps[ap] = true;
  };
  function memCmd(c, addr, len, ap) { return [C.DEBUG, c].concat(u32le(addr), [len & 255, len >> 8, ap]); }

  // A memory access, retried while the target says WAIT (the flash stalls the bus while it programs).
  StLink.prototype.mem = async function (fn) {
    for (var attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (e) { if (!e.wait || attempt >= 12) throw e; await this.sleep(Math.min(50, 1 << attempt)); }
    }
  };

  // Reads are always whole, aligned 32-bit words, sliced to what was asked: some areas (the H5's flash
  // information block) refuse byte reads.
  StLink.prototype.read = function (ap, addr, len) {
    return this.run(async function () {
      await this.ap(ap);
      var lo = (addr & ~3) >>> 0, total = ((addr - lo + len + 3) & ~3), buf = new Uint8Array(total), at = 0, self = this;
      while (at < total) {
        var a = lo + at, n = Math.min(total - at, BLOCK - (a % BLOCK));
        var b = await this.mem(async function () {
          var r = await self.xfer(memCmd(C.READMEM_32, a, n, ap), null, n);
          await self.lastStatus(); return r;
        });
        if (b.length !== n) throw ProbeError('The ST-LINK returned ' + b.length + ' of ' + n + ' bytes.', 'short');
        buf.set(b, at); at += n;
      }
      return buf.slice(addr - lo, addr - lo + len);
    });
  };

  // o.noRetry: a WAIT throws (e.wait) instead of sending the block again (flash: a unit can't be written twice).
  StLink.prototype.write = function (ap, addr, bytes, o) {
    var once = o && o.noRetry;
    return this.run(async function () {
      await this.ap(ap);
      var at = 0, len = bytes.length, self = this;
      while (at < len) {
        var a = addr + at, left = len - at, n;
        if (a & 3 || left < 4) {
          n = a & 3 ? Math.min(left, 4 - (a & 3)) : left;
          var part = bytes.slice(at, at + n);
          await this.mem(async function () { await self.xfer(memCmd(C.WRITEMEM_8, a, n, ap), part); await self.lastStatus(); });
          at += n; continue;
        }
        n = Math.min(left & ~3, BLOCK - (a % BLOCK));
        var chunk = bytes.slice(at, at + n), send = async function () { await self.xfer(memCmd(C.WRITEMEM_32, a, n, ap), chunk); await self.lastStatus(); };
        if (once) await send(); else await this.mem(send);
        at += n;
      }
    });
  };

  StLink.prototype.read32 = async function (ap, addr) {
    var b = await this.read(ap, addr, 4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  };
  StLink.prototype.write32 = function (ap, addr, v) { return this.write(ap, addr, new Uint8Array(u32le(v >>> 0))); };

  // DP and AP registers directly (port 0xFFFF is the DP).
  StLink.prototype.readDap = function (port, reg) {
    return this.run(async function () {
      var r = await this.cmd([C.DEBUG, C.READ_DAP, port & 255, port >> 8, reg, 0], 8);
      return new DataView(r.buffer, r.byteOffset, 8).getUint32(4, true);
    });
  };

  FL.stlink = {
    StLink: StLink, FILTERS: FILTERS, NAMES: NAMES, STATUS: STATUS, C: C,
    is: function (d) { return d.vendorId === 0x0483 && !!NAMES[d.productId]; }
  };
})();
