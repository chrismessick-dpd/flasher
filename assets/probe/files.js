/* Programming files: read .bin (with a base address), Intel HEX, Motorola S-record, and ELF (its loadable
   segments, at their physical addresses); write .bin and Intel HEX. An image is a sorted list of
   { addr, data } segments, merged where they touch. */
(function () {
  'use strict';
  var FL = window.FL = window.FL || {};

  function hex(v, n) { return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(n || 8, '0'); }
  function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 ? 2 : 0) + ' MB' : n >= 1024 ? (n / 1024).toFixed(n % 1024 ? 1 : 0) + ' KB' : n + ' bytes'; }
  function text(bytes) { return new TextDecoder('latin1').decode(bytes); }

  // Sort and merge pieces that touch or overlap (a later piece wins where they overlap).
  function merge(pieces) {
    pieces = pieces.filter(function (p) { return p.data.length; }).sort(function (a, b) { return a.addr - b.addr; });
    var out = [];
    pieces.forEach(function (p) {
      var last = out[out.length - 1];
      if (last && p.addr <= last.addr + last.data.length) {
        var end = Math.max(last.addr + last.data.length, p.addr + p.data.length), b = new Uint8Array(end - last.addr);
        b.set(last.data); b.set(p.data, p.addr - last.addr);
        last.data = b;
      } else out.push({ addr: p.addr, data: p.data });
    });
    return out;
  }

  function parseHex(s) {
    var pieces = [], upper = 0, cur = null, entry = null, eof = false;
    s.split(/\r?\n/).forEach(function (line, n) {
      line = line.trim();
      if (!line || eof) return;
      if (line[0] !== ':') throw new Error('Line ' + (n + 1) + ' is not an Intel HEX record.');
      var b = []; for (var i = 1; i < line.length; i += 2) b.push(parseInt(line.substr(i, 2), 16));
      if (b.some(isNaN) || b.length < 5 || b.length !== b[0] + 5) throw new Error('Line ' + (n + 1) + ' is malformed.');
      var sum = b.reduce(function (a, x) { return a + x; }, 0) & 255;
      if (sum) throw new Error('Line ' + (n + 1) + ' has a bad checksum.');
      var len = b[0], off = (b[1] << 8) | b[2], type = b[3], data = b.slice(4, 4 + len);
      if (type === 0) {
        var addr = (upper + off) >>> 0;
        if (cur && cur.addr + cur.bytes.length === addr) cur.bytes.push.apply(cur.bytes, data);
        else { cur = { addr: addr, bytes: data.slice() }; pieces.push(cur); }
      } else if (type === 1) eof = true;
      else if (type === 2) upper = ((data[0] << 8) | data[1]) << 4;
      else if (type === 4) upper = (((data[0] << 8) | data[1]) << 16) >>> 0;
      else if (type === 5 || type === 3) entry = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
    });
    return { segments: merge(pieces.map(function (p) { return { addr: p.addr, data: new Uint8Array(p.bytes) }; })), entry: entry };
  }

  function parseSrec(s) {
    var pieces = [], cur = null, entry = null;
    s.split(/\r?\n/).forEach(function (line, n) {
      line = line.trim();
      if (!line) return;
      if (line[0] !== 'S') throw new Error('Line ' + (n + 1) + ' is not an S-record.');
      var type = +line[1], b = [];
      for (var i = 2; i < line.length; i += 2) b.push(parseInt(line.substr(i, 2), 16));
      if (b.some(isNaN) || b.length !== b[0] + 1) throw new Error('Line ' + (n + 1) + ' is malformed.');
      var sum = b.reduce(function (a, x) { return a + x; }, 0) & 255;
      if (sum !== 255) throw new Error('Line ' + (n + 1) + ' has a bad checksum.');
      var al = { 1: 2, 2: 3, 3: 4, 7: 4, 8: 3, 9: 2 }[type];
      if (!al) return;  // S0 header, S5 and S6 counts
      var addr = 0; for (var k = 0; k < al; k++) addr = (addr * 256) + b[1 + k];
      if (type >= 7) { entry = addr >>> 0; return; }
      var data = b.slice(1 + al, b.length - 1);
      if (cur && cur.addr + cur.bytes.length === addr) cur.bytes.push.apply(cur.bytes, data);
      else { cur = { addr: addr >>> 0, bytes: data }; pieces.push(cur); }
    });
    return { segments: merge(pieces.map(function (p) { return { addr: p.addr, data: new Uint8Array(p.bytes) }; })), entry: entry };
  }

  // ELF32 little-endian: PT_LOAD segments with file bytes, at p_paddr (the load address, as objcopy uses).
  function parseElf(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[4] !== 1) throw new Error('This is a 64-bit ELF; STM32 images are 32-bit.');
    if (bytes[5] !== 1) throw new Error('This ELF is big-endian; STM32 images are little-endian.');
    var phoff = dv.getUint32(28, true), phentsize = dv.getUint16(42, true), phnum = dv.getUint16(44, true), pieces = [];
    for (var i = 0; i < phnum; i++) {
      var o = phoff + i * phentsize, type = dv.getUint32(o, true), off = dv.getUint32(o + 4, true), paddr = dv.getUint32(o + 12, true), filesz = dv.getUint32(o + 16, true);
      if (type === 1 && filesz) pieces.push({ addr: paddr, data: bytes.slice(off, off + filesz) });
    }
    if (!pieces.length) throw new Error('This ELF has no loadable segments.');
    return { segments: merge(pieces), entry: dv.getUint32(24, true) };
  }

  /* Read a file. base: where a .bin goes (default 0x08000000). Returns { format, segments, entry, size, name }. */
  function parse(name, bytes, base) {
    var lower = (name || '').toLowerCase(), img;
    if (bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46) img = parseElf(bytes), img.format = 'ELF';
    else if (/\.(hex|ihx|ihex)$/.test(lower) || (bytes[0] === 0x3A && /^:[0-9A-Fa-f]{10}/.test(text(bytes.slice(0, 12))))) img = parseHex(text(bytes)), img.format = 'Intel HEX';
    else if (/\.(srec|s19|s28|s37|mot)$/.test(lower) || (bytes[0] === 0x53 && /^S[0-9][0-9A-Fa-f]{6}/.test(text(bytes.slice(0, 10))))) img = parseSrec(text(bytes)), img.format = 'S-record';
    else img = { format: 'Binary', segments: [{ addr: base === undefined ? 0x08000000 : base >>> 0, data: bytes }], entry: null, needsBase: true };
    img.name = name;
    img.size = img.segments.reduce(function (a, s) { return a + s.data.length; }, 0);
    if (!img.size) throw new Error('The file holds no data.');
    return img;
  }

  // One flat buffer from the first segment's start to the last's end, gaps filled with 0xFF.
  function flatten(segments) {
    var lo = segments[0].addr, last = segments[segments.length - 1], b = new Uint8Array(last.addr + last.data.length - lo).fill(0xFF);
    segments.forEach(function (s) { b.set(s.data, s.addr - lo); });
    return { addr: lo, data: b };
  }

  function toHex(segments) {
    var lines = [], upper = -1;
    function rec(type, addr, data) {
      var b = [data.length, (addr >> 8) & 255, addr & 255, type].concat(Array.from(data));
      var sum = (256 - (b.reduce(function (a, x) { return a + x; }, 0) & 255)) & 255;
      lines.push(':' + b.concat([sum]).map(function (x) { return x.toString(16).toUpperCase().padStart(2, '0'); }).join(''));
    }
    segments.forEach(function (s) {
      for (var i = 0; i < s.data.length;) {
        var a = (s.addr + i) >>> 0, up = a >>> 16;
        if (up !== upper) { rec(4, 0, [up >> 8, up & 255]); upper = up; }
        var n = Math.min(16, s.data.length - i, 0x10000 - (a & 0xFFFF));
        rec(0, a & 0xFFFF, s.data.subarray(i, i + n));
        i += n;
      }
    });
    rec(1, 0, []);
    return lines.join('\r\n') + '\r\n';
  }

  FL.files = { parse: parse, parseHex: parseHex, parseSrec: parseSrec, parseElf: parseElf, merge: merge, flatten: flatten, toHex: toHex, fmtBytes: fmtBytes, hex: hex };
})();
