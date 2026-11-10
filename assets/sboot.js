/* A serial bootloader reached through a host board's USB bridge: Dovetail's serial bootloader
   protocol, version 1.

   Some boards have no USB port of their own. Their bootloader listens on a UART, and another board
   (the host) turns its own USB serial port into a pipe onto that UART when given a baud-rate touch,
   as the 1200-baud touch sends a board to its DFU bootloader. Flasher is the other end of the pipe.
   Which boards do this, their memory maps, and their USB ids live in the private manifest
   (README, *Bridge boards*), never here.

   Frame, both directions, little-endian:
     sync0 sync1 | cmd | seq | len (u16) | payload[len] | crc32 (u32)
   The CRC is zlib's CRC-32 over cmd, seq, len, and payload. Requests use sync 55 A5, responses 5A C3.
   A response repeats the request's seq, sets bit 7 of cmd, and its payload starts with a status
   byte. A request whose CRC fails is answered with BAD_CRC and seq 0.

   An image is a list of erase units, each with the CRC-32 of its whole contents as it reads back
   after an erase and a write (0xFF beyond the image's bytes). Only units whose CRC on the board
   differs are erased and written, so an update that changes code but not assets takes seconds. */
(function (FL) {
  'use strict';

  var REQ = [0x55, 0xA5], RSP = [0x5A, 0xC3];
  var PROTOCOL = 1, MAX_DATA = 4096, HEADER = 6;
  var CMD = { INFO: 0x01, ERASE: 0x02, WRITE: 0x03, READ: 0x04, CRC: 0x05, BEGIN: 0x06, COMMIT: 0x07, GO: 0x08, SET_BAUD: 0x09, RESET: 0x0A };
  var STATUS = ['OK', 'BAD_CRC', 'BAD_CMD', 'BAD_LEN', 'BAD_ADDR', 'PROTECTED', 'ERASE_FAIL', 'PROG_FAIL', 'VERIFY_FAIL', 'QSPI_FAIL', 'BAD_STATE', 'BAD_BAUD'];
  var REASON = { 1: 'the host board holds it there', 2: 'an update was begun and not finished', 3: 'it has no application to run' };
  var RECORD = { EMPTY: 0, PROBE: 1, INCOMPLETE: 2, COMPLETE: 3, UNKNOWN: 4 };
  var RECORD_TEXT = ['never updated this way', 'last written by a probe', 'an update left unfinished', 'last update complete', 'unknown'];

  // ── CRC-32 (zlib's) ──
  var TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  /* CRC-32 of bytes; pass a previous result as `crc` to continue it over more bytes. */
  function crc32(bytes, crc) {
    var c = (crc === undefined ? 0 : crc) ^ 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function le32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }
  function rd16(b, i) { return b[i] | (b[i + 1] << 8); }
  function rd32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }
  var hex = function (n, w) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w || 8, '0'); };

  function frame(cmd, seq, payload, sync) {
    payload = payload || [];
    var out = new Uint8Array(2 + 4 + payload.length + 4);
    out.set(sync || REQ, 0);
    out[2] = cmd; out[3] = seq; out[4] = payload.length & 0xFF; out[5] = payload.length >>> 8;
    out.set(payload, 6);
    out.set(le32(crc32(out.subarray(2, 6 + payload.length))), 6 + payload.length);
    return out;
  }

  /* Bytes as they arrive; take() returns the next good frame { cmd, seq, payload } or null. Bytes
     after a frame are kept: they may be the start of the next one. Damaged frames are skipped. */
  function Rx(sync) { this.sync = sync || RSP; this.buf = new Uint8Array(0); }
  Rx.prototype.push = function (chunk) {
    var b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf, 0); b.set(chunk, this.buf.length); this.buf = b;
  };
  Rx.prototype.take = function () {
    for (;;) {
      var b = this.buf, i = -1;
      for (var k = 0; k + 1 < b.length; k++) if (b[k] === this.sync[0] && b[k + 1] === this.sync[1]) { i = k; break; }
      if (i < 0) { this.buf = b.length ? b.slice(-1) : b; return null; }
      if (i > 0) { this.buf = b = b.slice(i); }
      if (b.length < HEADER) return null;
      var len = rd16(b, 4);
      if (len > MAX_DATA + 16) { this.buf = b.slice(1); continue; }
      var total = HEADER + len + 4;
      if (b.length < total) return null;
      if (rd32(b, HEADER + len) !== crc32(b.subarray(2, HEADER + len))) { this.buf = b.slice(1); continue; }
      var f = { cmd: b[2], seq: b[3], payload: b.slice(HEADER, HEADER + len) };
      this.buf = b.slice(total);
      return f;
    }
  };

  function BootError(msg, code) { var e = new Error(msg); e.code = code || 'boot'; return e; }

  /* A Web Serial port as a byte link: open(baud), write(bytes), frame(timeoutMs), close().
     The reader keeps going through non-fatal stream errors (a framing or overrun error ends the
     current reader, not the port). */
  function Link(port, opts) {
    this.port = port; this.opts = opts || {};
    this.rx = new Rx(); this.waiter = null; this.reader = null; this.closing = false; this.dead = null; this.baud = 0;
  }
  Link.prototype.open = function (baud) {
    var self = this;
    this.closing = false; this.dead = null; this.rx = new Rx();
    return this.port.open({ baudRate: baud, bufferSize: 1 << 16 }).then(function () {
      self.baud = baud;
      self.pumping = self.pump();
    });
  };
  Link.prototype.pump = function () {
    var self = this;
    function round() {
      if (self.closing || !self.port.readable) return Promise.resolve();
      var reader = self.reader = self.port.readable.getReader();
      function more() {
        return reader.read().then(function (r) {
          if (r.done) return;
          if (r.value && r.value.length) { self.rx.push(r.value); self.wake(); }
          return more();
        });
      }
      return more().catch(function (e) { self.lastError = e; }).then(function () {
        try { reader.releaseLock(); } catch (e) { /* already released */ }
        self.reader = null;
        if (!self.closing && self.port.readable) return round();
      });
    }
    return round().then(function () {
      if (!self.closing) { self.dead = self.lastError || new Error('The port closed.'); self.wake(); }
    });
  };
  Link.prototype.wake = function () { var w = this.waiter; if (w) { this.waiter = null; w(); } };
  /* The next good response frame, or null after timeoutMs. Rejects if the port went away. */
  Link.prototype.frame = function (timeoutMs) {
    var self = this, until = Date.now() + timeoutMs;
    return new Promise(function (resolve, reject) {
      var timer = null;
      function check() {
        var f = self.rx.take();
        if (f) { clearTimeout(timer); return resolve(f); }
        if (self.dead) { clearTimeout(timer); var e = BootError('The bridge port went away (' + (self.dead.message || self.dead) + ').', 'lost'); e.name = 'NetworkError'; return reject(e); }
        var left = until - Date.now();
        if (left <= 0) return resolve(null);
        self.waiter = check;
        clearTimeout(timer);
        timer = setTimeout(function () { if (self.waiter === check) self.waiter = null; check(); }, left);
      }
      check();
    });
  };
  Link.prototype.write = function (bytes) {
    var w = this.port.writable.getWriter();
    return w.write(bytes).then(function () { w.releaseLock(); }, function (e) { w.releaseLock(); throw e; });
  };
  Link.prototype.close = function () {
    var self = this;
    this.closing = true;
    return Promise.resolve(this.reader && this.reader.cancel()).catch(function () {}).then(function () {
      return self.pumping;
    }).catch(function () {}).then(function () { return self.port.close(); }).catch(function () {});
  };
  /* Change the rate on both ends: close, then open again at the new rate (Web Serial can't change
     it on an open port). The bridge follows the host's line coding. */
  Link.prototype.reopen = function (baud) { var self = this; return this.close().then(function () { return self.open(baud); }); };

  /* The bootloader on the far end of a Link. call() mirrors the reference host tool exactly: a
     response to an earlier request (a late answer to a retried INFO, a slow erase) is read past,
     never a reason to resend; only a timeout, or BAD_CRC with seq 0, sends the request again. */
  function Bootloader(link, opts) { this.link = link; this.seq = 0; this.log = (opts && opts.log) || function () {}; }
  Bootloader.prototype.call = async function (cmd, payload, timeoutMs, retries) {
    timeoutMs = timeoutMs || 2000; retries = retries === undefined ? 3 : retries;
    for (var attempt = 0; attempt <= retries; attempt++) {
      this.seq = ((this.seq + 1) & 0xFF) || 1;
      var seq = this.seq;
      await this.link.write(frame(cmd, seq, payload || []));
      var until = Date.now() + timeoutMs, resend = false;
      while (!resend) {
        var left = until - Date.now();
        if (left <= 0) break;
        var f = await this.link.frame(left);
        if (!f) break;
        if (!f.payload.length) continue;
        var status = f.payload[0];
        if (status === 0x01 && f.seq === 0) { resend = true; continue; }   // a damaged request, likely ours
        if (f.cmd !== (cmd | 0x80) || f.seq !== seq) continue;           // an older request's answer
        if (status !== 0) { var err = BootError('The board’s bootloader refused command ' + hex(cmd, 2) + ': ' + (STATUS[status] || hex(status, 2)) + '.', 'status'); err.status = status; throw err; }
        return f.payload.subarray(1);
      }
      if (attempt < retries) this.log((resend ? 'Damaged' : 'No answer') + ' for command ' + hex(cmd, 2) + '; trying again.');
    }
    throw BootError('No valid answer to command ' + hex(cmd, 2) + ' after ' + (retries + 1) + ' tries.', 'silent');
  };
  Bootloader.prototype.info = async function (timeoutMs, retries) {
    var b = await this.call(CMD.INFO, [], timeoutMs || 500, retries || 0);
    if (b.length < 40) throw BootError('The bootloader’s INFO answer is too short (' + b.length + ' bytes).', 'info');
    return {
      protocol: b[0], reason: b[1], version: rd16(b, 2), device: rd16(b, 4), singleBank: !!b[6], record: b[7], maxData: rd16(b, 8),
      appBase: rd32(b, 12), appEnd: rd32(b, 16), qspiBase: rd32(b, 20), qspiSize: rd32(b, 24),
      uid: [rd32(b, 28), rd32(b, 32), rd32(b, 36)].map(function (w) { return w.toString(16).toUpperCase().padStart(8, '0'); }).join('')
    };
  };
  Bootloader.prototype.crc = async function (addr, len) { return rd32(await this.call(CMD.CRC, le32(addr).concat(le32(len)), 5000), 0); };
  // A 256 KB internal sector takes about 2 s to erase, a 64 KB QSPI block up to 2 s.
  Bootloader.prototype.erase = function (addr) { return this.call(CMD.ERASE, le32(addr), 10000, 1); };
  Bootloader.prototype.write = function (addr, data) {
    var p = new Uint8Array(4 + data.length); p.set(le32(addr), 0); p.set(data, 4);
    return this.call(CMD.WRITE, p, 3000);
  };

  // While the host board brings the bridge up, the far board restarts into its bootloader (about a
  // second, with external flash to start): ask until it answers.
  async function waitInfo(bl, ms) {
    var until = Date.now() + ms;
    while (Date.now() < until) {
      try { return await bl.info(300, 0); } catch (e) { if (e.code !== 'silent') throw e; }
    }
    throw BootError('The board’s bootloader didn’t answer. Is the board powered, and has its bootloader been written (the first-time setup)?', 'silent');
  }

  /* Check an INFO block against what the board's manifest entry expects. Returns problems. */
  function mismatch(info, expect) {
    var out = [];
    if (info.protocol !== PROTOCOL) out.push('it speaks protocol ' + info.protocol + '; Flasher speaks ' + PROTOCOL);
    if (expect.device != null && info.device !== expect.device) out.push('its chip is ' + hex(info.device, 3) + ', not ' + hex(expect.device, 3));
    if (expect.singleBank && !info.singleBank) out.push('its flash is in dual-bank mode, which this image’s erase units don’t fit');
    if (expect.appBase != null && info.appBase !== expect.appBase) out.push('its application starts at ' + hex(info.appBase) + ', not ' + hex(expect.appBase));
    if (expect.qspiBase != null && info.qspiBase !== expect.qspiBase) out.push('its external flash is at ' + hex(info.qspiBase) + ', not ' + hex(expect.qspiBase));
    return out;
  }

  /* The whole update over an open Link.
       image: { units: [{ addr, size, crc, part }], parts: [{ path, addr, size, sha256 }], commit: { crc, length } }
       opts:  { expect, fastBaud, compareOnly, fetchPart(part) → Promise<Uint8Array>, log(text, cls),
                progress({ phase, done, total }), noGo }
     Resolves { info, changed: [unit], bytes, written, upToDate }. Nothing is erased until every
     part needed is downloaded and checked, so a failure before BEGIN leaves the board as it was. */
  async function update(link, image, opts) {
    var log = opts.log || function () {}, progress = opts.progress || function () {};
    var bl = new Bootloader(link, { log: log });
    progress({ phase: 'connect', done: 0, total: 1 });
    var info = await waitInfo(bl, opts.waitMs || 10000);
    log('Bootloader ' + (info.version >> 8) + '.' + (info.version & 0xFF) + ', protocol ' + info.protocol + ', chip ' + hex(info.device, 3) +
      ', ' + (RECORD_TEXT[info.record] || 'record ' + info.record) + '. Waiting because ' + (REASON[info.reason] || 'reason ' + info.reason) + '.');
    var bad = mismatch(info, opts.expect || {});
    if (bad.length) throw BootError('This isn’t the board this firmware is for: ' + bad.join('; ') + '.', 'wrong');

    if (opts.fastBaud && opts.fastBaud !== link.baud) {
      // Answered at the old rate, then switched. Before BEGIN, so a failed switch changes nothing.
      await bl.call(CMD.SET_BAUD, le32(opts.fastBaud));
      await link.reopen(opts.fastBaud);
      await bl.info(1000, 2);
      log('Link at ' + (opts.fastBaud / 1e6) + ' Mbaud.');
    }

    var units = image.units, changed = [], t0 = Date.now();
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if ((await bl.crc(u.addr, u.size)) !== u.crc) changed.push(u);
      progress({ phase: 'compare', done: i + 1, total: units.length });
    }
    var bytes = changed.reduce(function (n, x) { return n + x.size; }, 0);
    log('Compared ' + units.length + ' blocks in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s: ' + changed.length + ' differ.');
    var out = { info: info, changed: changed, bytes: bytes, written: 0, upToDate: !changed.length && info.record !== RECORD.INCOMPLETE };
    if (opts.compareOnly || out.upToDate) return out;

    // Download only the parts that hold a changed unit, and check each unit against its CRC.
    var need = [], data = {};
    changed.forEach(function (x) { if (need.indexOf(x.part) < 0) need.push(x.part); });
    for (var p = 0; p < need.length; p++) {
      progress({ phase: 'download', done: p, total: need.length });
      data[need[p].path] = await opts.fetchPart(need[p]);
    }
    function unitBytes(x) { var off = x.addr - x.part.addr; return data[x.part.path].subarray(off, off + x.size); }
    changed.forEach(function (x) {
      var b = unitBytes(x);
      if (b.length !== x.size || crc32(b) !== x.crc) throw BootError('The downloaded block at ' + hex(x.addr) + ' doesn’t match its recorded CRC. Publish the firmware again.', 'mismatch');
    });

    await bl.call(CMD.BEGIN, [], 5000);
    t0 = Date.now();
    var done = 0;
    for (var j = 0; j < changed.length; j++) {
      var c = changed[j], buf = unitBytes(c);
      progress({ phase: 'write', done: done, total: bytes, addr: c.addr });
      await bl.erase(c.addr);
      for (var off = 0; off < buf.length; off += MAX_DATA) {
        var chunk = buf.subarray(off, off + MAX_DATA), blank = true;
        for (var k = 0; k < chunk.length; k++) if (chunk[k] !== 0xFF) { blank = false; break; }
        if (!blank) await bl.write(c.addr + off, chunk);   // erased already reads 0xFF
        done += chunk.length;
        progress({ phase: 'write', done: done, total: bytes, addr: c.addr });
      }
      if ((await bl.crc(c.addr, c.size)) !== c.crc) throw BootError('The block at ' + hex(c.addr) + ' doesn’t read back as written.', 'verify');
    }
    try {
      await bl.call(CMD.COMMIT, le32(image.commit.crc).concat(le32(image.commit.length)), 5000);
    } catch (e) {
      // A COMMIT resent after its answer was lost is refused (the update is no longer open), though
      // the first one went through: the record says which.
      if (e.status !== 0x0A || (await bl.info(1000, 2)).record !== RECORD.COMPLETE) throw e;
      log('The commit’s first answer was lost; the board says the update is complete.');
    }
    out.written = done; out.ms = Date.now() - t0;
    log('Wrote and checked ' + changed.length + ' block' + (changed.length === 1 ? '' : 's') + ' in ' + (out.ms / 1000).toFixed(1) + ' s, and marked the update complete.', 'ok');
    if (!opts.noGo) {
      // The board resets as it answers; a lost answer is fine.
      try { await bl.call(CMD.GO, [], 1000, 0); } catch (e) { if (e.code !== 'silent') throw e; }
    }
    return out;
  }

  FL.sboot = {
    crc32: crc32, frame: frame, Rx: Rx, Link: Link, Bootloader: Bootloader, update: update, waitInfo: waitInfo, mismatch: mismatch,
    CMD: CMD, STATUS: STATUS, RECORD: RECORD, REQ: REQ, RSP: RSP, MAX_DATA: MAX_DATA, PROTOCOL: PROTOCOL, le32: le32, rd32: rd32, hex: hex
  };
})(window.FL = window.FL || {});
