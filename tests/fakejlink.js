/* A simulated J-Link for the tests: SEGGER's USB commands, and an SWD target decoded bit by bit from its
   raw SWD I/O command, with a DP, one MEM-AP per access port (CSW, TAR, DRW, posted reads, RDBUFF), and
   the fake chip from assets/probe/fakeprobe.js behind it. waitEvery: answer WAIT to every n-th AP access,
   to exercise resuming a batch. */
(function () {
  'use strict';
  var FL = window.FL;

  function FakeJLink(kind, o) {
    o = o || {};
    this.chip = new FL.fakeprobe.Chip(kind || 'g0', o);
    this.vendorId = 0x1366; this.productId = 0x1020; this.serialNumber = '000000123';
    this.configuration = null; this.out = [];
    this.waitEvery = o.waitEvery || 0; this.apCount = 0; this.waits = 0;
    this.dp = { ctrl: 0, select: 0, rdbuff: 0, sticky: false };
    this.aps = {};
  }
  FakeJLink.prototype.open = async function () { this.opened = true; };
  FakeJLink.prototype.close = async function () { this.opened = false; };
  FakeJLink.prototype.selectConfiguration = async function () {
    this.configuration = { interfaces: [{ interfaceNumber: 0, alternate: { interfaceClass: 0xFF, endpoints: [{ direction: 'in', endpointNumber: 1, type: 'bulk' }, { direction: 'out', endpointNumber: 1, type: 'bulk' }] } }] };
  };
  FakeJLink.prototype.claimInterface = async function () {};
  FakeJLink.prototype.releaseInterface = async function () {};
  FakeJLink.prototype.transferIn = async function (ep, len) {
    var b = this.out.shift(); if (!b) throw new Error('fake J-Link: nothing to read');
    return { status: 'ok', data: new DataView(b.buffer, 0, b.length) };
  };
  FakeJLink.prototype.transferOut = async function (ep, data) {
    var b = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), c = b[0];
    if (c === 0x01) { var s = new TextEncoder().encode('J-Link V11 compiled Jan  1 2026\0'); this.out.push(new Uint8Array([s.length, 0])); this.out.push(s); }
    else if (c === 0xC7) this.out.push(new Uint8Array([0, 0, 0, 0]));
    else if (c === 0x07) this.out.push(new Uint8Array([0xE4, 0x0C, 0, 0, 0, 0, 0, 0]));   // 3300 mV
    else if (c === 0xC0) this.out.push(new Uint8Array([0x00, 0x6C, 0xDC, 0x02, 4, 0])); // 48 MHz / 4
    else if (c === 0xDC) { this.chip.inReset = true; }
    else if (c === 0xDD) { if (this.chip.inReset) { this.chip.inReset = false; this.chip.reset(); } }
    else if (c === 0xCF) this.swd(b);
    return { status: 'ok' };
  };

  FakeJLink.prototype.swd = function (b) {
    var n = b[2] | (b[3] << 8), nb = Math.ceil(n / 8), dir = [], out = [], inb = new Uint8Array(n);
    for (var i = 0; i < n; i++) { dir.push((b[4 + (i >> 3)] >> (i & 7)) & 1); out.push((b[4 + nb + (i >> 3)] >> (i & 7)) & 1); }
    var p = 0, ones = 0;
    while (p < n) {
      if (!dir[p]) { p++; continue; }
      if (out[p] === 1) {
        // a request starts with 1 after idle; a line reset is 50+ ones
        var run = 0; while (p + run < n && dir[p + run] && out[p + run]) run++;
        if (run >= 50) {
          this.dp.sticky = false; this.dp.select = 0; p += run;
          var seqv = 0; for (var q = 15; q >= 0; q--) seqv = seqv * 2 + (out[p + q] || 0);
          if (seqv === 0xE79E) p += 16;   // JTAG-to-SWD switch
          continue;
        }
        var req = 0; for (var k = 0; k < 8; k++) req |= out[p + k] << k;
        var isAp = (req >> 1) & 1, rnw = (req >> 2) & 1, reg = ((req >> 3) & 3) << 2;
        p += 8; p += 1;  // turnaround
        var ack = 1;
        if (isAp && this.waitEvery && ++this.apCount % this.waitEvery === 0) { ack = 2; this.waits++; }
        if (this.dp.sticky && isAp) ack = 4;
        if (ack !== 1 && (this.dp.ctrl & 1)) this.dp.sticky = true;
        for (k = 0; k < 3; k++) inb[p + k] = (ack >> k) & 1;
        p += 3;
        if (rnw) {
          var v = 0;
          if (ack === 1) v = isAp ? this.apRead(reg) : this.dpRead(reg);
          for (k = 0; k < 32; k++) inb[p + k] = (v >>> k) & 1;
          inb[p + 32] = FL.jlink.parity(v);
          p += 33 + 1;
        } else {
          p += 1;
          var w = 0; for (k = 31; k >= 0; k--) w = (w * 2) + out[p + k];
          p += 33;
          if (ack === 1) { if (isAp) this.apWrite(reg, w >>> 0); else this.dpWrite(reg, w >>> 0); }
        }
        continue;
      }
      p++;
    }
    var r = new Uint8Array(nb + 1);
    // like a real J-Link, each cycle's line value lands one bit early in the reply
    for (i = 1; i < n; i++) if (inb[i]) r[(i - 1) >> 3] |= 1 << ((i - 1) & 7);
    this.out.push(r);
  };
  FakeJLink.prototype.ap = function () { var a = this.dp.select >>> 24; return this.aps[a] = this.aps[a] || { csw: 0x23000040, tar: 0 }; };
  FakeJLink.prototype.dpRead = function (reg) {
    if (reg === 0x0) return 0x0BC11477;
    if (reg === 0x4) { var c = this.dp.ctrl; return (c | (c & 0x50000000 ? 0xA0000000 : 0) | (this.dp.sticky ? 2 : 0)) >>> 0; }
    if (reg === 0xC) return this.dp.rdbuff;
    return 0;
  };
  FakeJLink.prototype.dpWrite = function (reg, v) {
    if (reg === 0x0) { if (v & 0x10) this.dp.sticky = false; return; }
    if (reg === 0x4) this.dp.ctrl = v;
    if (reg === 0x8) this.dp.select = v;
  };
  FakeJLink.prototype.apRead = function (reg) {
    var a = this.ap(), apn = this.dp.select >>> 24, prev = this.dp.rdbuff, v = 0;
    if (reg === 0x0) v = a.csw; else if (reg === 0x4) v = a.tar;
    else if (reg === 0xC) { try { v = this.chip.read32(a.tar >>> 0, apn); } catch (e) { v = 0; } if (((a.csw >> 4) & 3) === 1) a.tar = (a.tar & ~0x3FF) | ((a.tar + 4) & 0x3FF); }
    this.dp.rdbuff = v >>> 0;
    return prev;   // posted: the previous access's data
  };
  FakeJLink.prototype.apWrite = function (reg, v) {
    var a = this.ap(), apn = this.dp.select >>> 24;
    if (reg === 0x0) a.csw = v; else if (reg === 0x4) a.tar = v;
    else if (reg === 0xC) { this.chip.write32(a.tar >>> 0, v, apn); if (((a.csw >> 4) & 3) === 1) a.tar = (a.tar & ~0x3FF) | ((a.tar + 4) & 0x3FF); }
  };

  FL.fakejlink = { FakeJLink: FakeJLink };
})();
