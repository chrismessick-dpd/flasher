/* J-Link over WebUSB: SEGGER's USB commands as libjaylink documents them, and SWD built bit by bit on
   its raw SWD I/O command (0xCF), so it speaks the same probe API as stlink.js.

   SWD transactions are sent in batches, one USB exchange per batch. Overrun detection (CTRL/STAT
   ORUNDETECT) is on, so after a WAIT or FAULT every later transaction in the batch is refused and the
   data phase is always on the wire: a batch can be resumed exactly where it stopped. Status: experimental,
   tried against the bench J-Link for open and claim only. */
(function () {
  'use strict';
  var FL = window.FL = window.FL || {};

  var CMD = { VERSION: 0x01, SET_SPEED: 0x05, HW_STATUS: 0x07, GET_SPEEDS: 0xC0, SELECT_IF: 0xC7, SWD_IO: 0xCF, RESET_LOW: 0xDC, RESET_HIGH: 0xDD };
  var ACK_OK = 1, ACK_WAIT = 2, ACK_FAULT = 4;
  var DP = { IDR: 0x0, ABORT: 0x0, CTRL: 0x4, SELECT: 0x8, RDBUFF: 0xC };
  var AP = { CSW: 0x00, TAR: 0x04, DRW: 0x0C };
  var MAX_WORDS = 32;  // AP transfers per batch: each SWD I/O command stays under about 2,000 bits (a V13 hung on ~10,000)

  function ProbeError(msg, code) { var e = new Error(msg); e.code = code; return e; }
  // A USB read that never comes back (a hung probe) becomes an error after 5 s instead of freezing the page.
  function within(p, ms, what) {
    var timer; return Promise.race([p, new Promise(function (_, rej) { timer = setTimeout(function () { rej(ProbeError('The ' + what + ' stopped answering. Unplug it, plug it back in, and connect again.', 'timeout')); }, ms); })]).finally(function () { clearTimeout(timer); });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function parity(v) { v ^= v >>> 16; v ^= v >>> 8; v ^= v >>> 4; v ^= v >>> 2; v ^= v >>> 1; return v & 1; }

  // A run of SWD clock cycles: per cycle, whether the probe drives SWDIO and with what.
  function Seq() { this.dir = []; this.out = []; }
  Seq.prototype.put = function (v, n) { for (var i = 0; i < n; i++) { this.dir.push(1); this.out.push((v >>> i) & 1); } };
  Seq.prototype.take = function (n) { var at = this.dir.length; for (var i = 0; i < n; i++) { this.dir.push(0); this.out.push(0); } return at; };
  Seq.prototype.ones = function (n) { for (var i = 0; i < n; i++) { this.dir.push(1); this.out.push(1); } };
  // One transaction. Returns where its ACK (and a read's data) land in the reply.
  Seq.prototype.txn = function (isAp, rnw, reg, value, idle) {
    var a2 = (reg >> 2) & 1, a3 = (reg >> 3) & 1;
    var req = 1 | (isAp << 1) | (rnw << 2) | (a2 << 3) | (a3 << 4) | (parity(isAp | (rnw << 1) | (a2 << 2) | (a3 << 3)) << 5) | (1 << 7);
    this.put(req, 8);
    this.take(1);                       // turnaround
    var t = { ack: this.take(3), rnw: rnw, ap: isAp, reg: reg };
    if (rnw) { t.data = this.take(33); this.take(1); }
    else { this.take(1); this.put(value >>> 0, 32); this.put(parity(value >>> 0), 1); }
    this.put(0, idle || 2);
    return t;
  };
  function bitsVal(bits, at, n) { var v = 0; for (var i = n - 1; i >= 0; i--) v = (v * 2) + bits[at + i]; return v >>> 0; }

  function JLink(device, opts) {
    this.dev = device;
    this.opts = opts || {};
    this.sleep = this.opts.sleep || sleep;
    this.kind = 'jlink';
    this.info = { name: 'J-Link', pid: device.productId, serial: device.serialNumber || '' };
    this.q = Promise.resolve();
    this.sel = null; this.csw = {}; this.idle = 2;
  }
  JLink.prototype.run = function (fn) {
    var self = this, p = this.q.then(function () { return fn.call(self); });
    this.q = p.catch(function () {});
    return p;
  };
  JLink.prototype.send = function (bytes) { return within(this.dev.transferOut(this.epOut, new Uint8Array(bytes)), 5000, 'J-Link'); };
  JLink.prototype.recv = async function (n) {
    var out = new Uint8Array(n), got = 0;
    while (got < n) {
      var r = await within(this.dev.transferIn(this.epIn, Math.max(64, n - got)), 5000, 'J-Link');
      if (r.status !== 'ok') throw ProbeError('The J-Link stopped answering (USB ' + r.status + ').', 'usb');
      var b = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      out.set(b.subarray(0, n - got), got); got += b.length;
    }
    return out;
  };

  JLink.prototype.open = function () {
    return this.run(async function () {
      var d = this.dev;
      if (!d.opened) await d.open();
      if (!d.configuration) await d.selectConfiguration(1);
      var it = d.configuration.interfaces.filter(function (i) { return i.alternate.interfaceClass === 0xFF; })[0];
      if (!it) throw ProbeError('This J-Link has no vendor interface. Its driver may need SEGGER\'s WinUSB setting (J-Link Configurator).', 'noiface');
      this.iface = it.interfaceNumber;
      try { await d.claimInterface(this.iface); }
      catch (e) { throw ProbeError('Another program has the J-Link open. Close J-Link Commander, Ozone, or the IDE, then try again.', 'busy'); }
      var eps = it.alternate.endpoints;
      this.epOut = eps.filter(function (e) { return e.direction === 'out'; })[0].endpointNumber;
      this.epIn = eps.filter(function (e) { return e.direction === 'in'; })[0].endpointNumber;
      await this.send([CMD.VERSION]);
      var lenB = await this.recv(2), len = lenB[0] | (lenB[1] << 8);
      var s = new TextDecoder('latin1').decode(await this.recv(len)).replace(/\0[\s\S]*$/, '').trim();
      this.info.firmware = s.split('\n')[0];
      this.info.name = /J-Link/i.test(s) ? (s.match(/J-Link[^\n,]*/i) || ['J-Link'])[0].replace(/\s+compiled.*/i, '').trim() : 'J-Link';
      return this.info;
    });
  };

  JLink.prototype.voltage = function () {
    return this.run(async function () { await this.send([CMD.HW_STATUS]); var b = await this.recv(8); return (b[0] | (b[1] << 8)) / 1000; });
  };
  JLink.prototype.speeds = function () {
    return this.run(async function () {
      await this.send([CMD.GET_SPEEDS]);
      var b = await this.recv(6), base = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0, div = b[4] | (b[5] << 8);
      var max = Math.floor(base / Math.max(div, 1) / 1000);
      return [50000, 30000, 15000, 12000, 8000, 4000, 2000, 1000, 500, 100].filter(function (k) { return k <= max; });
    });
  };
  JLink.prototype.nrst = function (level) {
    return this.run(async function () {
      if (level === 'low') return this.send([CMD.RESET_LOW]);
      if (level === 'high') return this.send([CMD.RESET_HIGH]);
      await this.send([CMD.RESET_LOW]); await this.sleep(20); await this.send([CMD.RESET_HIGH]);
    });
  };

  // Clock a sequence out and read SWDIO back for every cycle.
  JLink.prototype.io = async function (seq) {
    var n = seq.dir.length, nb = Math.ceil(n / 8), buf = new Uint8Array(4 + 2 * nb);
    buf[0] = CMD.SWD_IO; buf[1] = 0; buf[2] = n & 255; buf[3] = n >> 8;
    for (var i = 0; i < n; i++) { if (seq.dir[i]) buf[4 + (i >> 3)] |= 1 << (i & 7); if (seq.out[i]) buf[4 + nb + (i >> 3)] |= 1 << (i & 7); }
    await within(this.dev.transferOut(this.epOut, buf), 5000, 'J-Link');
    var r = await this.recv(nb + 1);
    if (r[nb] !== 0) throw ProbeError('The J-Link reported an SWD I/O error (' + r[nb] + ').', 'io');
    // The J-Link reports the line as sampled one clock early: cycle k's value is at bit k - 1 of the reply
    // (OpenOCD's jlink driver reads the ACK straight after the request for the same reason). Seen on a V13.
    var bits = new Uint8Array(n);
    for (var k = 1; k < n; k++) bits[k] = (r[(k - 1) >> 3] >> ((k - 1) & 7)) & 1;
    return bits;
  };

  // A list of transactions in one batch: [{ ap, rnw, reg, value }]. Returns { done, results, ack }:
  // how many went through (ACK OK), their read values, and the ACK of the first that didn't.
  JLink.prototype.batch = async function (list) {
    var seq = new Seq(), self = this;
    var slots = list.map(function (t) { return seq.txn(t.ap ? 1 : 0, t.rnw ? 1 : 0, t.reg, t.value || 0, self.idle); });
    var bits = await this.io(seq), results = [];
    for (var i = 0; i < slots.length; i++) {
      var ack = bitsVal(bits, slots[i].ack, 3);
      if (ack !== ACK_OK) return { done: i, results: results, ack: ack };
      if (slots[i].rnw) {
        var v = bitsVal(bits, slots[i].data, 32);
        if (parity(v) !== bits[slots[i].data + 32]) return { done: i, results: results, ack: -1 };
        results.push(v);
      } else results.push(null);
    }
    return { done: list.length, results: results, ack: ACK_OK };
  };
  // Clear sticky errors after a refused transaction (ABORT: ORUNERRCLR, WDERRCLR, STKERRCLR, STKCMPCLR).
  JLink.prototype.recover = async function () {
    var r = await this.batch([{ ap: 0, rnw: 0, reg: DP.ABORT, value: 0x1E }]);
    if (r.done !== 1) { await this.lineReset(); this.sel = null; await this.batch([{ ap: 0, rnw: 1, reg: DP.IDR }]); await this.batch([{ ap: 0, rnw: 0, reg: DP.ABORT, value: 0x1E }]); }
  };
  function ackText(a) { return a === ACK_WAIT ? 'WAIT' : a === ACK_FAULT ? 'FAULT' : a === -1 ? 'a parity error' : a === 7 ? 'no answer (is the target powered and wired?)' : 'ACK ' + a; }

  JLink.prototype.lineReset = async function () {
    var s = new Seq();
    s.ones(56); s.put(0xE79E, 16); s.ones(56); s.put(0, 8);
    await this.io(s);
  };

  JLink.prototype.connect = function (o) {
    o = o || {};
    return this.run(async function () {
      this.sel = null; this.csw = {}; this.cswSet = {}; this.idle = 2;
      await this.send([CMD.SELECT_IF, 1]); await this.recv(4);
      var khz = Math.min(o.khz || 4000, 0xFFFE);
      await this.send([CMD.SET_SPEED, khz & 255, khz >> 8]);
      this.khz = khz;
      if (o.underReset) await this.send([CMD.RESET_LOW]);
      await this.lineReset();
      var id = await this.batch([{ ap: 0, rnw: 1, reg: DP.IDR }]);
      if (id.done !== 1) throw ProbeError('The target\'s debug port didn\'t answer (' + ackText(id.ack) + ').', 'nodp');
      this.dpidr = id.results[0];
      await this.batch([{ ap: 0, rnw: 0, reg: DP.ABORT, value: 0x1E }]);
      // Power up the debug and system domains; overrun detection on.
      await this.batch([{ ap: 0, rnw: 0, reg: DP.CTRL, value: 0x50000001 }]);
      for (var i = 0; i < 50; i++) {
        var c = await this.batch([{ ap: 0, rnw: 1, reg: DP.CTRL }]);
        if (c.done === 1 && ((c.results[0] & 0xA0000000) >>> 0) === 0xA0000000) return khz;
        await this.sleep(2);
      }
      throw ProbeError('The target\'s debug domain didn\'t power up.', 'power');
    });
  };
  JLink.prototype.disconnect = function () { return Promise.resolve(); };
  JLink.prototype.close = async function () {
    try { await this.dev.releaseInterface(this.iface); } catch (e) { /* closed */ }
    try { await this.dev.close(); } catch (e) { /* closed */ }
  };

  // Transactions that point the DP at an AP's bank 0 and set its CSW to 32-bit, auto-incrementing.
  // Neither counts as done until the batch carrying it is acknowledged past it (see noteSel).
  JLink.prototype.prep = async function (ap) {
    var out = [];
    if (this.sel !== ap) out.push({ ap: 0, rnw: 0, reg: DP.SELECT, value: (ap << 24) >>> 0 });
    if (this.csw[ap] === undefined) {
      for (var tries = 0; ; tries++) {
        var r = await this.batch(out.concat([{ ap: 1, rnw: 1, reg: AP.CSW }, { ap: 0, rnw: 1, reg: DP.RDBUFF }]));
        if (r.done === out.length + 2) { this.csw[ap] = ((r.results[r.results.length - 1] & ~0x3F) | 0x12) >>> 0; break; }  // 32-bit, single auto-increment
        await this.recover();
        if (r.ack !== ACK_WAIT || tries > 8) throw ProbeError('Access port ' + ap + ' didn\'t answer (' + ackText(r.ack) + ').', 'ap');
      }
      this.sel = ap; out = [];
    }
    if (!this.cswSet || !this.cswSet[ap]) out.push({ ap: 1, rnw: 0, reg: AP.CSW, value: this.csw[ap] });
    return out;
  };
  function noteSel(self, ap, pre, r) {
    if (r.done < pre.length) return;
    self.sel = ap;
    self.cswSet = self.cswSet || {}; self.cswSet[ap] = true;
  }

  // Read words, resuming after a WAIT. Posted reads: each DRW read returns the previous one's data.
  JLink.prototype.readWords = async function (ap, addr, count) {
    var out = [], tries = 0;
    while (out.length < count) {
      var start = addr + 4 * out.length, n = Math.min(count - out.length, MAX_WORDS, (1024 - (start % 1024)) / 4);
      var pre = await this.prep(ap), list = pre.concat([{ ap: 1, rnw: 0, reg: AP.TAR, value: start }]);
      for (var i = 0; i < n; i++) list.push({ ap: 1, rnw: 1, reg: AP.DRW });
      list.push({ ap: 0, rnw: 1, reg: DP.RDBUFF });
      var r = await this.batch(list), base = pre.length + 1;
      noteSel(this, ap, pre, r);
      // results[base + i + 1] holds word i (the read after it carries it).
      var good = Math.max(0, Math.min(n, r.done - base - 1));
      for (var k = 0; k < good; k++) out.push(r.results[base + k + 1]);
      if (r.done === list.length) { tries = 0; continue; }
      await this.recover();
      if (r.ack === ACK_FAULT && good === 0) throw ProbeError('Reading ' + FL.files.hex(start) + ' faulted (no memory or peripheral there, or its clock is off).', 0x11);
      if (good) tries = 0;  // progress: only a run of WAITs with nothing done gives up
      if (++tries > 8) throw ProbeError('The target kept answering ' + ackText(r.ack) + ' at ' + FL.files.hex(start) + '.', 'wait');
      this.idle = Math.min(16, this.idle * 2);
    }
    return out;
  };
  JLink.prototype.writeWords = async function (ap, addr, words) {
    var at = 0, tries = 0;
    while (at < words.length) {
      var start = addr + 4 * at, n = Math.min(words.length - at, MAX_WORDS, (1024 - (start % 1024)) / 4);
      var pre = await this.prep(ap), list = pre.concat([{ ap: 1, rnw: 0, reg: AP.TAR, value: start }]);
      for (var i = 0; i < n; i++) list.push({ ap: 1, rnw: 0, reg: AP.DRW, value: words[at + i] });
      list.push({ ap: 0, rnw: 1, reg: DP.RDBUFF });  // waits for the last write to finish
      var r = await this.batch(list), base = pre.length + 1;
      noteSel(this, ap, pre, r);
      if (r.done === list.length) { at += n; tries = 0; continue; }
      var good = Math.max(0, Math.min(n, r.done - base));
      at += good;
      await this.recover();
      if (r.ack === ACK_FAULT && good === 0) throw ProbeError('Writing ' + FL.files.hex(start) + ' faulted.', 0x11);
      if (good) tries = 0;  // progress: only a run of WAITs with nothing done gives up
      if (++tries > 8) throw ProbeError('The target kept answering ' + ackText(r.ack) + ' at ' + FL.files.hex(start) + '.', 'wait');
      this.idle = Math.min(16, this.idle * 2);
    }
  };

  JLink.prototype.read = function (ap, addr, len) {
    return this.run(async function () {
      var lo = (addr & ~3) >>> 0, hi = lo + ((addr - lo + len + 3) & ~3), words = await this.readWords(ap, lo, (hi - lo) / 4), b = new Uint8Array(hi - lo);
      words.forEach(function (w, i) { b[4 * i] = w & 255; b[4 * i + 1] = (w >>> 8) & 255; b[4 * i + 2] = (w >>> 16) & 255; b[4 * i + 3] = (w >>> 24) & 255; });
      return b.slice(addr - lo, addr - lo + len);
    });
  };
  // Word writes; a partial word at either end is read, merged, and written back.
  JLink.prototype.write = function (ap, addr, bytes) {
    return this.run(async function () {
      var lo = (addr & ~3) >>> 0, hi = lo + ((addr - lo + bytes.length + 3) & ~3), b = new Uint8Array(hi - lo);
      if (lo !== addr || hi !== addr + bytes.length) {
        var head = await this.readWords(ap, lo, 1), tail = await this.readWords(ap, hi - 4, 1);
        [head[0]].forEach(function (w) { for (var i = 0; i < 4; i++) b[i] = (w >>> (8 * i)) & 255; });
        [tail[0]].forEach(function (w) { for (var i = 0; i < 4; i++) b[hi - lo - 4 + i] = (w >>> (8 * i)) & 255; });
      }
      b.set(bytes, addr - lo);
      var words = [];
      for (var i = 0; i < b.length; i += 4) words.push((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0);
      await this.writeWords(ap, lo, words);
    });
  };
  JLink.prototype.read32 = async function (ap, addr) { var w = await this.run(function () { return this.readWords(ap, addr, 1); }); return w[0]; };
  JLink.prototype.write32 = function (ap, addr, v) { return this.run(function () { return this.writeWords(ap, addr, [v >>> 0]); }); };

  FL.jlink = {
    JLink: JLink, Seq: Seq, parity: parity,
    FILTERS: [{ vendorId: 0x1366 }],
    is: function (d) { return d.vendorId === 0x1366; }
  };
})();
