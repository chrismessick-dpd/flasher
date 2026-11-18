/* Firmware images and the catalog that lists them.

   An image is a raw .bin written at the start of flash. Before anything is erased it must:
   fit the board's flash; start with a stack pointer inside RAM (the top of RAM itself is the
   usual value, since the stack grows down); and have an odd (Thumb) reset vector inside the image.

   The catalog is manifest.json in the tool's private data repo (README, *The data repo*):
     { format: 1, updated, boards: { <id>: board }, firmware: [entry] }
   A board says how to reach it and what its memory is; boards live in the manifest, not in this
   public repo, so a client's board details never appear here. */
(function (FL) {
  'use strict';

  function num(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\s*0x[0-9a-f]+\s*$/i.test(v)) return parseInt(v, 16);
    if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return parseInt(v, 10);
    return NaN;
  }
  function u32(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }
  var hex = function (n, w) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w || 8, '0'); };

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* Check an image against a board: { ok, errors: [text], warnings: [text], sp, reset }. */
  function check(bytes, board) {
    var errors = [], warnings = [], out = { ok: false, errors: errors, warnings: warnings, sp: null, reset: null };
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!b.length) { errors.push('The file is empty.'); return out; }
    if (b[0] === 0x7F && b[1] === 0x45 && b[2] === 0x4C && b[3] === 0x46) { errors.push('This is an ELF file. Flash the .bin the build writes beside it.'); return out; }
    if (b[0] === 0x3A && /^:[0-9A-F]{8}/i.test(String.fromCharCode.apply(null, b.subarray(0, 12)))) { errors.push('This is an Intel HEX file. Flash the .bin the build writes beside it.'); return out; }
    if (b.length < 8) { errors.push('The file is only ' + b.length + ' bytes, too short to be firmware.'); return out; }
    var flash = board.flash, ram = board.ram;
    if (b.length > flash.size) errors.push('The image is ' + fmtBytes(b.length) + ' (' + b.length + ' bytes), more than the ' + fmtBytes(flash.size) + ' of flash on ' + board.name + '.');
    var sp = out.sp = u32(b, 0), reset = out.reset = u32(b, 4);
    if (!(sp > ram.base && sp <= ram.base + ram.size)) {
      errors.push('The first word, ' + hex(sp) + ', isn’t a stack pointer in RAM (' + hex(ram.base) + ' to ' + hex(ram.base + ram.size) + '). This doesn’t look like firmware for ' + board.name + '.');
    } else if (sp % 8) warnings.push('The stack pointer ' + hex(sp) + ' isn’t 8-byte aligned.');
    var entry = (reset & ~1) >>> 0;
    if (!(reset & 1)) errors.push('The reset vector ' + hex(reset) + ' is even; Cortex-M code addresses are odd (Thumb).');
    else if (entry < flash.base || entry >= flash.base + b.length) errors.push('The reset vector ' + hex(reset) + ' points outside the image (' + hex(flash.base) + ' to ' + hex(flash.base + b.length) + '). Was it built for another load address?');
    out.ok = !errors.length;
    return out;
  }

  function sha256(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then(function (d) {
      return Array.prototype.map.call(new Uint8Array(d), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    });
  }

  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 400) : ''; }
  function usb(v) {
    if (!v || typeof v !== 'object') return null;
    var vid = num(v.vid), pid = num(v.pid);
    return vid >= 0 && vid <= 0xFFFF && pid >= 0 && pid <= 0xFFFF ? { vid: vid, pid: pid, name: str(v.name, 80) } : null;
  }
  function mem(v) {
    if (!v || typeof v !== 'object') return null;
    var base = num(v.base), size = num(v.size);
    return base >= 0 && size > 0 ? { base: base, size: size } : null;
  }

  /* One board from the manifest, cleaned, or null with a reason in problems. */
  function cleanBoard(id, b, problems) {
    var bad = function (why) { problems.push('Board “' + id + '”: ' + why); return null; };
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) return bad('the id may only use a–z, 0–9, _ and -.');
    if (!b || typeof b !== 'object') return bad('not an object.');
    if (b.kind === 'bridge') return cleanBridge(id, b, bad);
    var flash = mem(b.flash), ram = mem(b.ram), dfu = usb(b.dfu);
    if (!flash) return bad('flash needs base and size.');
    if (!ram) return bad('ram needs base and size.');
    if (!dfu) return bad('dfu needs vid and pid.');
    // run: the USB id of the board's own firmware, which takes the touch. runAlso: the ids of other
    // firmware the same board may be running (another code base built for it), each touched the same
    // way. Kept apart from run, so a page that only knows run still reads the manifest.
    var run = usb(b.run);
    var runs = run ? [run].concat((Array.isArray(b.runAlso) ? b.runAlso : []).map(usb).filter(Boolean).slice(0, 7)) : [];
    // detach: the USB ids of firmware with no serial port but a DFU runtime interface (candleLight,
    // for one). Flasher restarts a board running it with DFU detach over WebUSB instead of the touch.
    var detach = (Array.isArray(b.detach) ? b.detach : []).map(usb).filter(Boolean).slice(0, 4);
    return {
      id: id, name: str(b.name, 80) || id, mcu: str(b.mcu, 60), flash: flash, ram: ram, dfu: dfu,
      run: run, runs: runs, touchBaud: run ? (num(b.touchBaud) || 1200) : 0, detach: detach,
      layout: str(b.layout, 200),                         // DfuSe layout if the browser can't read the device's
      manualDfu: Array.isArray(b.manualDfu) ? b.manualDfu.map(function (s) { return str(s, 300); }).filter(Boolean).slice(0, 8) : [],
      notes: str(b.notes, 1200)
    };
  }

  /* A board with no USB of its own, updated through another board's bridge (assets/sboot.js;
     README, *Bridge boards*): touch lists the host firmware that takes the touchBaud touch (run is
     its first, as for a DFU board), bridge is the port that appears, and expect is what the
     bootloader's INFO must say. */
  function cleanBridge(id, b, bad) {
    var touch = (Array.isArray(b.touch) ? b.touch : []).map(usb).filter(Boolean).slice(0, 8), bridge = usb(b.bridge);
    if (!touch.length) return bad('a bridge board needs touch: the USB ids of the host firmware that opens the bridge.');
    if (!bridge) return bad('a bridge board needs bridge: the USB id of the bridge’s serial port.');
    var ex = b.expect && typeof b.expect === 'object' ? b.expect : {}, opt = function (v) { var n = num(v); return n >= 0 ? n : null; };
    var link = num(b.linkBaud) || 1000000, fast = num(b.fastBaud) || 0, touchBaud = num(b.touchBaud) || 2400, exitBaud = num(b.exitBaud) || 1200;
    if (touchBaud === exitBaud || link === exitBaud || fast === exitBaud) return bad('touchBaud, linkBaud, fastBaud, and exitBaud must differ from the exit rate.');
    return {
      id: id, kind: 'bridge', name: str(b.name, 80) || id, mcu: str(b.mcu, 60), notes: str(b.notes, 1200),
      run: touch[0], runs: touch, touchBaud: touchBaud, exitBaud: exitBaud, bridge: bridge, linkBaud: link, fastBaud: fast,
      expect: { device: opt(ex.device), appBase: opt(ex.appBase), qspiBase: opt(ex.qspiBase), singleBank: !!ex.singleBank },
      // units: the board's erase-unit layout, as flasher.json gives it (publish.py --board-only writes it), so the
      // page can split a .hex or .elf from this computer into blocks itself. Without it, only published firmware.
      units: unitLayout(b.units),
      manualDfu: [], flash: null, ram: null, dfu: null
    };
  }

  /* A bridge board's erase units, as flasher.json and publish.py's unit_map describe them: skip (address
     ranges left out), and regions, each { base, sizes: [...] } or { base, end, unit }, with app: true on the
     regions COMMIT covers. Returns the cleaned layout, or null when it's missing or doesn't validate. */
  function unitLayout(u) {
    if (!u || typeof u !== 'object' || !Array.isArray(u.regions) || !u.regions.length) return null;
    var regions = [];
    for (var i = 0; i < u.regions.length && i < 16; i++) {
      var rg = u.regions[i] || {}, base = num(rg.base);
      if (!(base >= 0)) return null;
      if (Array.isArray(rg.sizes)) {
        var starts = [], at = base;
        for (var k = 0; k < rg.sizes.length && k < 256; k++) { var sz = num(rg.sizes[k]); if (!(sz > 0)) return null; starts.push([at, sz]); at += sz; }
        regions.push({ lo: base, hi: at, starts: starts, unit: 0, app: !!rg.app });
      } else {
        var unit = num(rg.unit), end = num(rg.end);
        if (!(unit > 0) || !(end > base) || (end - base) % unit) return null;
        regions.push({ lo: base, hi: end, starts: null, unit: unit, app: !!rg.app });
      }
    }
    if (!regions.some(function (r) { return r.app; })) return null;
    var skip = (Array.isArray(u.skip) ? u.skip : []).map(function (x) { return [num(x && x[0]), num(x && x[1])]; }).filter(function (x) { return x[0] >= 0 && x[1] > x[0]; });
    return { regions: regions, skip: skip };
  }

  /* A board's erase-unit layout worked out from its bootloader's INFO (assets/sboot.js) and the chip's sector
     table (assets/sectors.js), in unitLayout's shape: the internal sectors from appBase to appEnd (the region
     COMMIT covers), the external flash in its erase block (INFO's qspiBlock, else 64 KB), and everything from the
     start of flash up to appBase skipped (the bootloader's own sectors). Throws with a reason. */
  var QSPI_BLOCK = 0x10000;
  function layoutFromInfo(info) {
    var S = FL.sectors, secs = S && S.sectors(info.device, info.singleBank), c = S && S.chip(info.device);
    if (!secs) {
      if (c && !info.singleBank) throw new Error('The board’s flash is in dual-bank mode. Flasher works out sectors only in single-bank mode, which the bootloader expects.');
      throw new Error('Flasher doesn’t know the sectors of this chip (device ' + hex(info.device, 3) + ') yet.');
    }
    var lo = info.appBase >>> 0, hi = info.appEnd >>> 0, i0 = -1, i1 = -1;
    secs.forEach(function (s, i) { if (s[0] === lo) i0 = i; if (s[0] + s[1] === hi) i1 = i; });
    if (i0 < 0) throw new Error('The bootloader says the application starts at ' + hex(lo) + ', which isn’t the start of a sector on ' + c.name + '.');
    if (i1 < i0) throw new Error('The bootloader says the application ends at ' + hex(hi) + ', which isn’t the end of a sector after ' + hex(lo) + ' on ' + c.name + '.');
    var regions = [{ lo: lo, hi: hi, starts: secs.slice(i0, i1 + 1), unit: 0, app: true }];
    if (info.qspiSize > 0) {
      var block = info.qspiBlock > 0 ? info.qspiBlock : QSPI_BLOCK, qlo = info.qspiBase >>> 0;
      if (info.qspiSize % block) throw new Error('The external flash size (' + fmtBytes(info.qspiSize) + ') isn’t a whole number of ' + fmtBytes(block) + ' blocks.');
      regions.push({ lo: qlo, hi: qlo + info.qspiSize, starts: null, unit: block, app: false });
    }
    return { regions: regions, skip: lo > c.base ? [[c.base, lo]] : [], chip: c.name, qspiBlockGuessed: info.qspiSize > 0 && !(info.qspiBlock > 0) };
  }
  /* Every erase unit of a layout, [{ addr, size }] (the simulated board in tests and ?demo). */
  function layoutUnits(layout) {
    var out = [];
    layout.regions.forEach(function (r) {
      if (r.starts) r.starts.forEach(function (s) { out.push({ addr: s[0], size: s[1] }); });
      else for (var a = r.lo; a < r.hi; a += r.unit) out.push({ addr: a, size: r.unit });
    });
    return out;
  }

  /* A file's segments ({ addr, data }) as the board's erase units, exactly as publish.py's split_units and
     units_entry make them: each unit the image touches, filled with 0xFF and the image laid over it, its CRC-32,
     the units grouped into parts within 1 MB windows, and the COMMIT record over the application's units, which
     must run back to back from its region's base. crc32 is FL.sboot.crc32. Throws with a reason. */
  function unitsImage(segments, layout, crc32) {
    function unitFor(addr) {
      for (var i = 0; i < layout.regions.length; i++) {
        var r = layout.regions[i];
        if (addr >= r.lo && addr < r.hi) {
          if (r.unit) return { start: r.lo + Math.floor((addr - r.lo) / r.unit) * r.unit, size: r.unit, region: i };
          for (var k = 0; k < r.starts.length; k++) if (addr >= r.starts[k][0] && addr < r.starts[k][0] + r.starts[k][1]) return { start: r.starts[k][0], size: r.starts[k][1], region: i };
        }
      }
      throw new Error(hex(addr) + ' is outside every block this board’s bootloader writes (its own sectors, or not flash).');
    }
    var units = {}, skipped = 0;
    segments.forEach(function (sg) {
      var addr = sg.addr >>> 0, data = sg.data;
      if (layout.skip.some(function (x) { return addr >= x[0] && addr < x[1]; })) { skipped += data.length; return; }
      var pos = 0;
      while (pos < data.length) {
        var u = unitFor(addr + pos), cur = units[u.start];
        if (!cur) cur = units[u.start] = { addr: u.start, size: u.size, region: u.region, bytes: new Uint8Array(u.size).fill(0xFF) };
        var off = addr + pos - u.start, n = Math.min(data.length - pos, u.size - off);
        cur.bytes.set(data.subarray(pos, pos + n), off);
        pos += n;
      }
    });
    var list = Object.keys(units).map(function (k) { return units[k]; }).sort(function (a, b) { return a.addr - b.addr; });
    if (!list.length) throw new Error('The file has nothing in the blocks this board’s bootloader writes.');
    var parts = [];
    list.forEach(function (u) {
      u.crc = crc32(u.bytes);
      var p = parts[parts.length - 1];
      if (p && p.addr + p.size === u.addr && Math.floor(p.addr / 0x100000) === Math.floor(u.addr / 0x100000)) { p.members.push(u); p.size += u.size; }
      else parts.push({ addr: u.addr, size: u.size, members: [u] });
    });
    parts.forEach(function (p) {
      p.path = 'local/' + p.addr.toString(16).padStart(8, '0') + '.bin';
      p.bytes = new Uint8Array(p.size);
      p.members.forEach(function (u) { p.bytes.set(u.bytes, u.addr - p.addr); u.part = p; });
    });
    var appRegion = layout.regions.filter(function (r) { return r.app; })[0], app = list.filter(function (u) { return layout.regions[u.region].app; });
    if (!app.length) throw new Error('The file has no application (nothing at ' + hex(appRegion.lo) + '), and the bootloader’s commit covers it. Use the image built with the application.');
    var at = appRegion.lo, ccrc = 0, clen = 0;
    app.forEach(function (u) {
      if (u.addr !== at) throw new Error('The application’s blocks must run back to back from ' + hex(appRegion.lo) + '; there’s a gap at ' + hex(at) + '.');
      ccrc = crc32(u.bytes, ccrc); clen += u.size; at += u.size;
    });
    return {
      kind: 'units', skipped: skipped, size: list.reduce(function (n, u) { return n + u.size; }, 0),
      units: list.map(function (u) { return { addr: u.addr, size: u.size, crc: u.crc, part: u.part }; }),
      parts: parts.map(function (p) { return { path: p.path, addr: p.addr, size: p.size, bytes: p.bytes }; }),
      commit: { crc: ccrc >>> 0, length: clen }
    };
  }

  /* A firmware entry made of erase units (kind "units"), for a bridge board: its parts are files
     under path, each a run of whole units, and every unit carries its CRC-32. Returns the cleaned
     fields or a reason (string). */
  function cleanUnits(f) {
    var dir = 'firmware/' + f.board + '/' + f.id + '/';
    if (f.path !== dir) return 'path must be ' + dir + '.';
    if (!Array.isArray(f.parts) || !f.parts.length || f.parts.length > 512) return 'parts must list the files.';
    var parts = [], units = [], last = -1, total = 0;
    for (var i = 0; i < f.parts.length; i++) {
      var p = f.parts[i] || {}, addr = num(p.addr), size = num(p.size);
      if (typeof p.path !== 'string' || p.path.indexOf(dir) !== 0 || !/^[0-9a-f]{8}\.bin$/.test(p.path.slice(dir.length))) return 'part ' + (i + 1) + ': path must be ' + dir + '<8 hex digits>.bin.';
      if (!(addr >= 0) || !(size > 0) || !/^[0-9a-f]{64}$/.test(p.sha256 || '')) return 'part ' + (i + 1) + ': needs addr, size, and sha256.';
      var part = { path: p.path, addr: addr, size: size, sha256: p.sha256 }, at = addr;
      if (!Array.isArray(p.units) || !p.units.length) return 'part ' + (i + 1) + ': units must list its erase units.';
      for (var k = 0; k < p.units.length; k++) {
        var u = p.units[k] || [], ua = num(u[0]), us = num(u[1]), uc = num(u[2]);
        if (ua !== at || !(us > 0) || !(uc >= 0 && uc <= 0xFFFFFFFF)) return 'part ' + (i + 1) + ': its units must be [addr, size, crc32], back to back from its addr.';
        if (ua <= last) return 'parts must be in address order without overlaps.';
        units.push({ addr: ua, size: us, crc: uc >>> 0, part: part });
        at += us; last = ua + us - 1;
      }
      if (at - addr !== size) return 'part ' + (i + 1) + ': its units add up to ' + (at - addr) + ' bytes, not its size ' + size + '.';
      parts.push(part); total += size;
    }
    var cm = f.commit || {}, ccrc = num(cm.crc32), clen = num(cm.length);
    if (!(ccrc >= 0) || !(clen > 0)) return 'commit needs crc32 and length.';
    if (f.size !== total) return 'size must be the parts’ total, ' + total + '.';
    return { parts: parts, units: units, commit: { crc: ccrc >>> 0, length: clen } };
  }

  /* Validate a parsed manifest: { boards: {id: board}, firmware: [entry], problems: [text] }.
     A firmware entry whose board is unknown, or whose path isn't firmware/<board>/<id>.bin, is dropped. */
  /* Entries the page writes (docs/working-projects.md): a firmware's own project (it wins over its board's),
     which fields an FTE edited (publish.py leaves those alone), images uploaded as they are (kind "file"), and
     passthrough systems. */
  var ID = /^[a-z0-9][a-z0-9_-]{0,63}$/, FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/, HEX64 = /^[0-9a-f]{64}$/;
  var FORMATS = ['bin', 'hex', 'elf'];
  function partPaths(path, n) { var out = []; for (var i = 1; i <= n; i++) out.push(path + '.' + ('00' + i).slice(-3)); return out; }
  function cleanStored(f, path) {   // { format, size, sha256, path, parts (a count), paths } of a stored file, or a reason
    if (!f || typeof f !== 'object') return 'no file.';
    var parts = Math.floor(+f.parts) || 0;
    if (FORMATS.indexOf(f.format) < 0) return 'format must be bin, hex, or elf.';
    if (f.path !== path) return 'path must be ' + path + '.';
    if (!HEX64.test(f.sha256 || '')) return 'sha256 must be 64 hex digits.';
    if (!(f.size > 0)) return 'bad size.';
    if (parts < 0 || parts > 999) return 'bad parts.';
    return { format: f.format, size: f.size, sha256: f.sha256, path: path, parts: parts, paths: parts ? partPaths(path, parts) : [path] };
  }
  function cleanSystem(id, s, problems) {
    var bad = function (why) { problems.push('System “' + id + '”: ' + why); return null; };
    if (!ID.test(id)) return bad('bad id.');
    if (!s || typeof s !== 'object') return bad('not an object.');
    var host = s.host && typeof s.host === 'object' ? s.host : {}, ln = s.link && typeof s.link === 'object' ? s.link : {}, rm = s.remote && typeof s.remote === 'object' ? s.remote : {};
    var rate = function (v, d) { var n = num(v); return n >= 300 && n <= 12000000 ? n : d; };
    var link = { touchBaud: rate(ln.touchBaud, 2400), linkBaud: rate(ln.linkBaud, 1000000), fastBaud: rate(ln.fastBaud, 4000000), exitBaud: rate(ln.exitBaud, 1200) };
    if (link.touchBaud === link.exitBaud || link.linkBaud === link.exitBaud || link.fastBaud === link.exitBaud) return bad('the exit rate must differ from the others.');
    var out = { id: id, name: str(s.name, 80) || 'Passthrough system', project: ID.test(s.project || '') ? s.project : '',
      host: { name: str(host.name, 80), usb: (Array.isArray(host.usb) ? host.usb : []).map(usb).filter(Boolean).slice(0, 8).map(function (u) { return { vid: u.vid, pid: u.pid }; }) },
      link: link, remote: { name: str(rm.name, 80), file: null, release: null }, updated: str(s.updated, 40), by: str(s.by, 100) };
    if (rm.file) {
      var name = typeof rm.file.name === 'string' && FILE_NAME.test(rm.file.name) && /[.](hex|elf)$/i.test(rm.file.name) ? rm.file.name : '';
      if (!name) return bad('the remote’s file must be a .hex or .elf.');
      var st = cleanStored(rm.file, 'systems/' + id + '/' + name);
      if (typeof st === 'string') return bad('the remote’s file: ' + st);
      out.remote.file = Object.assign({ name: name }, st);
    }
    var r = rm.release;
    if (r && typeof r === 'object' && /^[A-Za-z0-9_-]{1,64}$/.test(r.review || '') && /^[A-Za-z0-9_-]{1,64}$/.test(r.release || '') && HEX64.test(r.sha256 || '')) {
      out.remote.release = { repo: str(r.repo, 140), review: r.review, release: r.release, version: str(r.version, 40), target: str(r.target, 120), sha256: r.sha256,
        board: /^[a-z0-9][a-z0-9_-]{0,47}$/.test(r.board || '') ? r.board : '' };
    }
    return out;
  }

  function cleanManifest(m) {
    var problems = [], boards = {}, firmware = [], systems = [];
    if (!m || typeof m !== 'object') return { boards: boards, firmware: firmware, systems: systems, problems: ['manifest.json isn’t a JSON object.'] };
    if (m.format !== 1) problems.push('manifest.json has format ' + JSON.stringify(m.format) + '; this page reads format 1.');
    Object.keys(m.boards || {}).forEach(function (id) { var b = cleanBoard(id, m.boards[id], problems); if (b) boards[id] = b; });
    (Array.isArray(m.firmware) ? m.firmware : []).forEach(function (f, i) {
      var label = 'Firmware #' + (i + 1) + (f && f.id ? ' (“' + String(f.id).slice(0, 40) + '”)' : '');
      if (!f || typeof f !== 'object') return problems.push(label + ': not an object.');
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.id || '')) return problems.push(label + ': bad id.');
      if (!boards[f.board]) return problems.push(label + ': unknown board “' + str(f.board, 40) + '”.');
      var bridged = boards[f.board].kind === 'bridge', units = null, stored = null;
      if (f.kind === 'file') {
        // An image uploaded from the page as it is: a .bin, .hex, or .elf, maybe in parts. A bridge board's must
        // carry addresses (.hex or .elf).
        stored = cleanStored(f, 'firmware/' + f.board + '/' + f.id + '.' + f.format);
        if (typeof stored === 'string') return problems.push(label + ': ' + stored);
        if (bridged && stored.format === 'bin') return problems.push(label + ': a bridge board’s image needs addresses: a .hex or .elf.');
      } else if (bridged !== (f.kind === 'units')) return problems.push(label + ': ' + (bridged ? 'a bridge board’s firmware must be kind “units” or “file”.' : 'firmware of kind “units” needs a bridge board.'));
      else if (bridged) { units = cleanUnits(f); if (typeof units === 'string') return problems.push(label + ': ' + units); }
      else if (f.path !== 'firmware/' + f.board + '/' + f.id + '.bin') return problems.push(label + ': path must be firmware/' + f.board + '/' + f.id + '.bin.');
      if (!/^[0-9a-f]{64}$/.test(f.sha256 || '')) return problems.push(label + ': sha256 must be 64 hex digits.');
      if (!(f.size > 0)) return problems.push(label + ': bad size.');
      var src = f.source && typeof f.source === 'object' ? f.source : {};
      firmware.push({
        id: f.id, board: f.board, name: str(f.name, 80) || f.id, summary: str(f.summary, 400), description: str(f.description, 6000),
        size: f.size, sha256: f.sha256, path: f.path, built: str(f.built, 40), published: str(f.published, 40),
        source: { repo: str(src.repo, 100), sha: /^[0-9a-f]{7,40}$/.test(src.sha || '') ? src.sha : '', path: str(src.path, 200), dirty: !!src.dirty }
      });
      var e = firmware[firmware.length - 1];
      if (units) { e.kind = 'units'; e.parts = units.parts; e.units = units.units; e.commit = units.commit; }
      if (stored) { e.kind = 'file'; e.format = stored.format; e.paths = stored.paths; e.partCount = stored.parts; }
      if (ID.test(f.project || '')) e.project = f.project;
      var ed = f.edited && typeof f.edited === 'object' ? f.edited : {};
      e.edited = { name: ed.name === true, project: ed.project === true };
      if (str(f.uploadedBy, 100)) e.uploadedBy = str(f.uploadedBy, 100);
    });
    var sys = m.systems && typeof m.systems === 'object' && !Array.isArray(m.systems) ? m.systems : {};
    Object.keys(sys).forEach(function (id) { var x = cleanSystem(id, sys[id], problems); if (x) systems.push(x); });
    return { boards: boards, firmware: firmware, systems: systems, problems: problems };
  }

  /* A board for a local .bin when no catalog board fits: any STM32 in its ROM DFU bootloader.
     Its flash size is taken from the device's own layout once it's connected. */
  var GENERIC = cleanBoard('stm32-dfu', {
    name: 'Any STM32', mcu: 'STM32', flash: { base: 0x08000000, size: 0x200000 }, ram: { base: 0x20000000, size: 0x100000 },
    dfu: { vid: 0x0483, pid: 0xDF11, name: 'DFU in FS Mode' },
    manualDfu: ['Hold the board’s BOOT0 button (or tie BOOT0 high).', 'Press and release reset.', 'Release BOOT0. The board now waits in its ROM bootloader.'],
    notes: 'No checks beyond “is this firmware”: the flash size comes from the board once it’s connected. Flasher tries a 1200-baud restart on the serial port picked; without an answer, the board goes into update mode by hand.'
  }, []);

  FL.image = { cleanSystem: cleanSystem, partPaths: partPaths, FORMATS: FORMATS, unitLayout: unitLayout, layoutFromInfo: layoutFromInfo, layoutUnits: layoutUnits, unitsImage: unitsImage, check: check, sha256: sha256, cleanManifest: cleanManifest, cleanBoard: cleanBoard, GENERIC: GENERIC, num: num, hex: hex, fmtBytes: fmtBytes, u32: u32 };
})(window.FL = window.FL || {});
