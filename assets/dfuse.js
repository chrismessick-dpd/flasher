/* DfuSe over WebUSB: ST's DFU 1.1a extensions, as the STM32 ROM bootloader speaks them.

   Plain DFU moves numbered blocks; DfuSe adds commands sent as block 0 of a DNLOAD:
     0x21 <addr>   set the address pointer
     0x41 <addr>   erase the page holding addr (0x41 alone erases everything; never used here)
   and data blocks are numbered from 2: block n lands at pointer + (n - 2) * transfer size.
   Nothing a DNLOAD asks for happens until the host polls GETSTATUS, which says dfuDNBUSY with a
   poll timeout while the flash works, then dfuDNLOAD_IDLE. Leaving is a set-address to the
   start of flash plus a zero-length DNLOAD; the next GETSTATUS starts the app, so the device
   drops off the bus and that call (or close) may fail. That failure is the success case.

   `device` is a WebUSB USBDevice, or anything with the same shape (tests/test.html uses
   assets/fakeusb.js). Everything here is promise-based and has no DOM, so the tests can drive it. */
(function (FL) {
  'use strict';

  var REQ = { DETACH: 0, DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, GETSTATE: 5, ABORT: 6 };
  var STATE = { appIDLE: 0, appDETACH: 1, dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5,
    dfuMANIFEST_SYNC: 6, dfuMANIFEST: 7, dfuMANIFEST_WAIT_RESET: 8, dfuUPLOAD_IDLE: 9, dfuERROR: 10 };
  var STATE_NAMES = Object.keys(STATE).reduce(function (o, k) { o[STATE[k]] = k; return o; }, {});
  // DFU 1.1 bStatus values, worded for the person at the page.
  var STATUS_TEXT = {
    0x00: 'no error', 0x01: 'the target refused the request', 0x02: 'the file is not for this device',
    0x03: 'the flash could not be written', 0x04: 'the flash could not be erased', 0x05: 'the erase check failed',
    0x06: 'programming failed', 0x07: 'the written data did not verify', 0x08: 'the address is outside the device’s memory',
    0x09: 'the download ended early', 0x0A: 'the device’s firmware is corrupt', 0x0B: 'vendor error',
    0x0C: 'unexpected USB reset', 0x0D: 'unexpected power-on reset', 0x0E: 'unknown error', 0x0F: 'the device stalled an unexpected request'
  };
  var CMD = { SET_ADDRESS: 0x21, ERASE: 0x41 };
  var DFU_CLASS = 0xFE, DFU_SUBCLASS = 0x01;

  function DfuError(message, code, detail) {
    var e = new Error(message);
    e.name = 'DfuError'; e.code = code || 'dfu'; if (detail) e.detail = detail;
    return e;
  }
  function hex(n, w) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w || 8, '0'); }

  /* A DfuSe memory layout string, the alternate setting's name:
       "@Internal Flash  /0x08000000/256*02Kg"
       "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg"
       "@Option Bytes  /0x1FFF7800/01*048 e"
     One or more "/<start>/<count>*<size><unit><type>,..." regions follow the name. Units are
     ' ' or 'B' (bytes), 'K', or 'M'; the type letter a–g holds readable (1), erasable (2), and
     writable (4) bits. Returns { name, segments: [{ start, end, pageSize, readable, erasable, writable }] }
     with one segment per run of equal pages, or null when it isn't a DfuSe name. */
  function parseLayout(text) {
    if (typeof text !== 'string' || text.charAt(0) !== '@') return null;
    var parts = text.slice(1).split('/');
    if (parts.length < 3) return null;
    var out = { name: parts[0].trim(), segments: [] };
    for (var i = 1; i + 1 < parts.length; i += 2) {
      var addr = parseInt(parts[i].trim(), 16);
      if (!isFinite(addr)) return null;
      var runs = parts[i + 1].split(',');
      for (var j = 0; j < runs.length; j++) {
        var m = /^\s*(\d+)\s*\*\s*(\d+)\s*([ BKM]?)\s*([a-g])\s*$/.exec(runs[j]);
        if (!m) return null;
        var count = parseInt(m[1], 10), size = parseInt(m[2], 10);
        size *= m[3] === 'K' ? 1024 : m[3] === 'M' ? 1048576 : 1;
        var bits = m[4].charCodeAt(0) - 0x60;
        out.segments.push({ start: addr, end: addr + count * size, pageSize: size, readable: !!(bits & 1), erasable: !!(bits & 2), writable: !!(bits & 4) });
        addr += count * size;
      }
    }
    return out.segments.length ? out : null;
  }

  // The segment holding addr, or null.
  function segmentAt(layout, addr) {
    var s = layout && layout.segments;
    for (var i = 0; s && i < s.length; i++) if (addr >= s[i].start && addr < s[i].end) return s[i];
    return null;
  }

  // Page start addresses covering [start, start + length), or throws if any byte is outside a
  // writable, erasable segment.
  function pagesFor(layout, start, length) {
    var pages = [], addr = start, end = start + length;
    while (addr < end) {
      var seg = segmentAt(layout, addr);
      if (!seg || !seg.writable || !seg.erasable) throw DfuError('The image runs to ' + hex(end) + ', past the writable flash at ' + hex(addr) + '.', 'range');
      var page = seg.start + Math.floor((addr - seg.start) / seg.pageSize) * seg.pageSize;
      pages.push(page);
      addr = page + seg.pageSize;
    }
    return pages;
  }

  /* The DFU functional descriptor (type 0x21) from a configuration descriptor's bytes:
     { attributes, detachTimeout, transferSize, version } or null. */
  function parseFunctional(bytes) {
    var b = bytes instanceof DataView ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
    for (var i = 0; i + 1 < b.length;) {
      var len = b[i], type = b[i + 1];
      if (len < 2) break;
      if (type === 0x21 && len >= 7 && i + len <= b.length) {
        return { attributes: b[i + 2], detachTimeout: b[i + 3] | (b[i + 4] << 8), transferSize: b[i + 5] | (b[i + 6] << 8),
          version: len >= 9 ? (b[i + 7] | (b[i + 8] << 8)) : 0 };
      }
      i += len;
    }
    return null;
  }

  function defaultSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* One DfuSe session on one device.
     opts: { sleep(ms), now(), log(text), fallbackLayout: string, altName: RegExp, pollLimitMs } */
  function Dfuse(device, opts) {
    this.device = device;
    this.opts = opts || {};
    this.sleep = this.opts.sleep || defaultSleep;
    this.now = this.opts.now || function () { return Date.now(); };
    this.log = this.opts.log || function () {};
    this.iface = null; this.alt = null; this.layout = null; this.transferSize = 0;
  }

  // Open the device, claim its DFU interface, and pick the internal flash alternate setting.
  Dfuse.prototype.open = function () {
    var self = this, d = this.device;
    return Promise.resolve(d.opened ? null : d.open()).then(function () {
      return d.configuration ? null : d.selectConfiguration(1);
    }).then(function () {
      var cfg = d.configuration, found = [];
      (cfg && cfg.interfaces || []).forEach(function (itf) {
        (itf.alternates || []).forEach(function (a) {
          if (a.interfaceClass === DFU_CLASS && a.interfaceSubclass === DFU_SUBCLASS) found.push({ itf: itf, alt: a });
        });
      });
      if (!found.length) throw DfuError('This USB device has no DFU interface.', 'no-dfu');
      var want = self.opts.altName || /^@Internal Flash/i;
      var pick = found.filter(function (f) { return want.test(f.alt.interfaceName || ''); })[0];
      var named = found.some(function (f) { return f.alt.interfaceName; });
      // No names at all (the browser didn't read them): the flash is alternate 0 on ST's ROM.
      if (!pick && !named) pick = found.filter(function (f) { return f.alt.alternateSetting === 0; })[0];
      if (!pick) throw DfuError('The DFU device has no internal flash setting (it lists ' +
        found.map(function (f) { return '“' + (f.alt.interfaceName || '#' + f.alt.alternateSetting) + '”'; }).join(', ') + ').', 'no-flash');
      self.iface = pick.itf.interfaceNumber; self.alt = pick.alt.alternateSetting;
      self.layout = parseLayout(pick.alt.interfaceName || '') || parseLayout(self.opts.fallbackLayout || '');
      if (!self.layout) throw DfuError('Couldn’t read the flash layout from the device, and the board gives none.', 'no-layout');
      self.log('DFU interface ' + self.iface + ', alternate ' + self.alt + ': ' + (pick.alt.interfaceName || self.opts.fallbackLayout + ' (from the board)'));
      return d.claimInterface(self.iface);
    }).then(function () {
      return self.alt ? d.selectAlternateInterface(self.iface, self.alt) : null;
    }).then(function () {
      return self.readTransferSize();
    }).then(function (n) {
      self.transferSize = n;
      self.log('Transfer size ' + n + ' bytes');
      return self;
    });
  };

  // wTransferSize from the DFU functional descriptor; 2048 (the ROM's) if it can't be read.
  Dfuse.prototype.readTransferSize = function () {
    var d = this.device;
    var setup = { requestType: 'standard', recipient: 'device', request: 6, value: 0x0200, index: 0 };
    return d.controlTransferIn(setup, 9).then(function (head) {
      if (head.status !== 'ok' || !head.data || head.data.byteLength < 4) return null;
      var total = head.data.getUint16(2, true);
      return d.controlTransferIn(setup, total);
    }).then(function (full) {
      var f = full && full.status === 'ok' ? parseFunctional(full.data) : null;
      return f && f.transferSize ? f.transferSize : 2048;
    }).catch(function () { return 2048; });
  };

  Dfuse.prototype.out = function (request, value, data) {
    var self = this;
    return this.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: request, value: value, index: this.iface }, data)
      .then(function (r) {
        if (r.status !== 'ok') throw DfuError('The device stalled ' + Object.keys(REQ)[request] + '.', 'stall');
        return r;
      }, function (e) { self.log('USB error: ' + (e && e.message)); throw e; });
  };
  Dfuse.prototype.in = function (request, value, length) {
    return this.device.controlTransferIn({ requestType: 'class', recipient: 'interface', request: request, value: value, index: this.iface }, length)
      .then(function (r) {
        if (r.status !== 'ok') throw DfuError('The device stalled ' + Object.keys(REQ)[request] + '.', 'stall');
        return r.data;
      });
  };

  Dfuse.prototype.getStatus = function () {
    return this.in(REQ.GETSTATUS, 0, 6).then(function (v) {
      return { status: v.getUint8(0), pollTimeout: v.getUint8(1) | (v.getUint8(2) << 8) | (v.getUint8(3) << 16), state: v.getUint8(4) };
    });
  };
  Dfuse.prototype.clearStatus = function () { return this.out(REQ.CLRSTATUS, 0); };
  Dfuse.prototype.abort = function () { return this.out(REQ.ABORT, 0); };

  // Back to dfuIDLE from wherever the device was left (an error, an upload, a download).
  Dfuse.prototype.ensureIdle = function () {
    var self = this;
    return this.getStatus().then(function (s) {
      if (s.state === STATE.dfuIDLE) return s;
      self.log('Device was in ' + STATE_NAMES[s.state] + '; resetting to idle');
      return (s.state === STATE.dfuERROR ? self.clearStatus() : self.abort()).then(function () { return self.getStatus(); }).then(function (s2) {
        if (s2.state === STATE.dfuERROR) return self.clearStatus().then(function () { return self.getStatus(); });
        return s2;
      });
    }).then(function (s) {
      if (s.state !== STATE.dfuIDLE) throw DfuError('The device won’t go idle (it says ' + STATE_NAMES[s.state] + ').', 'state');
      return s;
    });
  };

  // Poll GETSTATUS until the download finishes; rejects on dfuERROR with the device's reason.
  Dfuse.prototype.waitDone = function (what) {
    var self = this, limit = this.opts.pollLimitMs || 15000, start = this.now();
    function step() {
      return self.getStatus().then(function (s) {
        if (s.state === STATE.dfuDNBUSY || s.state === STATE.dfuDNLOAD_SYNC) {
          if (self.now() - start > limit) throw DfuError(what + ' timed out.', 'timeout');
          return self.sleep(s.pollTimeout).then(step);
        }
        if (s.state === STATE.dfuERROR || s.status !== 0) {
          var err = DfuError(what + ' failed: ' + (STATUS_TEXT[s.status] || 'status ' + s.status) + '.', 'status', s);
          return self.clearStatus().catch(function () {}).then(function () { throw err; });
        }
        return s;
      });
    }
    return step();
  };

  Dfuse.prototype.command = function (cmd, addr, what) {
    var self = this, data = new Uint8Array(addr === undefined ? 1 : 5);
    data[0] = cmd;
    if (addr !== undefined) { data[1] = addr & 0xFF; data[2] = (addr >>> 8) & 0xFF; data[3] = (addr >>> 16) & 0xFF; data[4] = (addr >>> 24) & 0xFF; }
    return this.out(REQ.DNLOAD, 0, data).then(function () { return self.waitDone(what); });
  };
  Dfuse.prototype.setAddress = function (addr) { return this.command(CMD.SET_ADDRESS, addr, 'Setting the address ' + hex(addr)); };
  Dfuse.prototype.erasePage = function (addr) { return this.command(CMD.ERASE, addr, 'Erasing the page at ' + hex(addr)); };

  // The first set-address shows whether the flash can be reached at all: a read-protected
  // STM32 refuses it.
  Dfuse.prototype.probe = function (base) {
    var self = this;
    return this.ensureIdle().then(function () { return self.setAddress(base); }).catch(function (e) {
      if (e.name !== 'DfuError') throw e;
      throw DfuError('The board refused the flash address ' + hex(base) + '. Its flash may be read-protected (RDP), which needs ' +
        'STM32CubeProgrammer to clear (that erases it). ' + e.message, 'protected', e.detail);
    });
  };

  Dfuse.prototype.erase = function (start, length, progress) {
    var self = this, pages = pagesFor(this.layout, start, length), i = 0;
    function next() {
      if (i >= pages.length) return Promise.resolve(pages.length);
      return self.erasePage(pages[i]).then(function () { i++; if (progress) progress(i, pages.length); return next(); });
    }
    return next();
  };

  // Write bytes at start, one transfer-size chunk per set-address + block 2, as dfu-util does.
  // The STM32G4 programs 8-byte double words, so the tail is padded with 0xFF to a multiple of 8.
  Dfuse.prototype.write = function (start, bytes, progress) {
    var self = this, xfer = this.transferSize, padded = bytes;
    if (bytes.length % 8) { padded = new Uint8Array(bytes.length + 8 - bytes.length % 8).fill(0xFF); padded.set(bytes); }
    var off = 0;
    function next() {
      if (off >= padded.length) return Promise.resolve(padded.length);
      var chunk = padded.subarray(off, Math.min(off + xfer, padded.length)), addr = start + off;
      return self.setAddress(addr).then(function () {
        return self.out(REQ.DNLOAD, 2, chunk);
      }).then(function () {
        return self.waitDone('Writing ' + hex(addr));
      }).then(function () {
        off += chunk.length; if (progress) progress(Math.min(off, bytes.length), bytes.length);
        return next();
      });
    }
    return next();
  };

  // Read length bytes from start: set the pointer once, go idle, then UPLOAD blocks 2, 3, …
  Dfuse.prototype.read = function (start, length, progress) {
    var self = this, xfer = this.transferSize, out = new Uint8Array(length), off = 0, block = 2;
    function next() {
      if (off >= length) return self.abort().then(function () { return out; });
      var n = Math.min(xfer, length - off);
      return self.in(REQ.UPLOAD, block, n).then(function (v) {
        var got = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        if (got.length < n) throw DfuError('The device sent ' + got.length + ' bytes where ' + n + ' were asked for, at ' + hex(start + off) + '.', 'short');
        out.set(got.subarray(0, n), off);
        off += n; block++; if (progress) progress(off, length);
        return next();
      });
    }
    return this.ensureIdle().then(function () { return self.setAddress(start); })
      .then(function () { return self.abort(); }).then(next).catch(function (e) {
        if (e.name === 'DfuError' && e.code === 'stall') throw DfuError('The board won’t let its flash be read back (UPLOAD refused), so the image can’t be verified.', 'no-upload');
        throw e;
      });
  };

  /* Erase, write, and read back. progress({ phase: 'erase'|'write'|'verify', done, total }).
     Resolves { pages, bytes, verified } or rejects with a DfuError. */
  Dfuse.prototype.flash = function (base, image, progress, opts) {
    var self = this, pages = 0, verify = !(opts && opts.verify === false);
    var p = function (phase) { return function (done, total) { if (progress) progress({ phase: phase, done: done, total: total }); }; };
    return Promise.resolve().then(function () {
      pagesFor(self.layout, base, image.length);   // fails before anything is erased if it won't fit
      return self.probe(base);
    }).then(function () {
      return self.erase(base, image.length, p('erase'));
    }).then(function (n) {
      pages = n;
      return self.write(base, image, p('write'));
    }).then(function () {
      if (!verify) return null;
      return self.read(base, image.length, p('verify')).then(function (back) {
        for (var i = 0; i < image.length; i++) {
          if (back[i] !== image[i]) throw DfuError('Verify failed: the byte at ' + hex(base + i) + ' reads ' + hex(back[i], 2) + ', not ' + hex(image[i], 2) + '.', 'verify');
        }
        return true;
      });
    }).then(function (verified) {
      return { pages: pages, bytes: image.length, verified: !!verified };
    });
  };

  // Start the app at addr. The board resets and leaves the bus, so errors after the request are
  // expected and swallowed.
  Dfuse.prototype.leave = function (addr) {
    var self = this, d = this.device;
    return this.ensureIdle().then(function () { return self.setAddress(addr); }).then(function () {
      return self.out(REQ.DNLOAD, 2, new Uint8Array(0));   // block 2, empty: as dfu-util's dfuse_do_leave
    }).then(function () {
      return self.getStatus().catch(function () { return null; });
    }).then(function () {
      return Promise.resolve().then(function () { return d.releaseInterface && d.releaseInterface(self.iface); }).catch(function () {});
    }).then(function () {
      return Promise.resolve().then(function () { return d.close && d.close(); }).catch(function () {});
    });
  };

  Dfuse.prototype.close = function () {
    var d = this.device;
    return Promise.resolve().then(function () { return d.opened && d.close(); }).catch(function () {});
  };

  FL.dfuse = { Dfuse: Dfuse, DfuError: DfuError, parseLayout: parseLayout, parseFunctional: parseFunctional, pagesFor: pagesFor,
    segmentAt: segmentAt, REQ: REQ, STATE: STATE, STATE_NAMES: STATE_NAMES, STATUS_TEXT: STATUS_TEXT, CMD: CMD, hex: hex };
})(window.FL = window.FL || {});
