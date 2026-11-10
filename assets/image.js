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
    var flash = mem(b.flash), ram = mem(b.ram), dfu = usb(b.dfu);
    if (!flash) return bad('flash needs base and size.');
    if (!ram) return bad('ram needs base and size.');
    if (!dfu) return bad('dfu needs vid and pid.');
    var run = usb(b.run);
    return {
      id: id, name: str(b.name, 80) || id, mcu: str(b.mcu, 60), flash: flash, ram: ram, dfu: dfu,
      run: run, touchBaud: run ? (num(b.touchBaud) || 1200) : 0,
      layout: str(b.layout, 200),                         // DfuSe layout if the browser can't read the device's
      manualDfu: Array.isArray(b.manualDfu) ? b.manualDfu.map(function (s) { return str(s, 300); }).filter(Boolean).slice(0, 8) : [],
      notes: str(b.notes, 1200)
    };
  }

  /* Validate a parsed manifest: { boards: {id: board}, firmware: [entry], problems: [text] }.
     A firmware entry whose board is unknown, or whose path isn't firmware/<board>/<id>.bin, is dropped. */
  function cleanManifest(m) {
    var problems = [], boards = {}, firmware = [];
    if (!m || typeof m !== 'object') return { boards: boards, firmware: firmware, problems: ['manifest.json isn’t a JSON object.'] };
    if (m.format !== 1) problems.push('manifest.json has format ' + JSON.stringify(m.format) + '; this page reads format 1.');
    Object.keys(m.boards || {}).forEach(function (id) { var b = cleanBoard(id, m.boards[id], problems); if (b) boards[id] = b; });
    (Array.isArray(m.firmware) ? m.firmware : []).forEach(function (f, i) {
      var label = 'Firmware #' + (i + 1) + (f && f.id ? ' (“' + String(f.id).slice(0, 40) + '”)' : '');
      if (!f || typeof f !== 'object') return problems.push(label + ': not an object.');
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.id || '')) return problems.push(label + ': bad id.');
      if (!boards[f.board]) return problems.push(label + ': unknown board “' + str(f.board, 40) + '”.');
      if (f.path !== 'firmware/' + f.board + '/' + f.id + '.bin') return problems.push(label + ': path must be firmware/' + f.board + '/' + f.id + '.bin.');
      if (!/^[0-9a-f]{64}$/.test(f.sha256 || '')) return problems.push(label + ': sha256 must be 64 hex digits.');
      if (!(f.size > 0)) return problems.push(label + ': bad size.');
      var src = f.source && typeof f.source === 'object' ? f.source : {};
      firmware.push({
        id: f.id, board: f.board, name: str(f.name, 80) || f.id, summary: str(f.summary, 400), description: str(f.description, 6000),
        size: f.size, sha256: f.sha256, path: f.path, built: str(f.built, 40), published: str(f.published, 40),
        source: { repo: str(src.repo, 100), sha: /^[0-9a-f]{7,40}$/.test(src.sha || '') ? src.sha : '', path: str(src.path, 200), dirty: !!src.dirty }
      });
    });
    return { boards: boards, firmware: firmware, problems: problems };
  }

  /* A board for a local .bin when no catalog board fits: any STM32 in its ROM DFU bootloader.
     Its flash size is taken from the device's own layout once it's connected. */
  var GENERIC = cleanBoard('stm32-dfu', {
    name: 'Any STM32 in DFU mode', mcu: 'STM32', flash: { base: 0x08000000, size: 0x200000 }, ram: { base: 0x20000000, size: 0x100000 },
    dfu: { vid: 0x0483, pid: 0xDF11, name: 'DFU in FS Mode' },
    manualDfu: ['Hold the board’s BOOT0 button (or tie BOOT0 high).', 'Press and release reset.', 'Release BOOT0. The board now waits in its ROM bootloader.'],
    notes: 'No checks beyond “is this firmware”: the flash size comes from the board once it’s connected.'
  }, []);

  FL.image = { check: check, sha256: sha256, cleanManifest: cleanManifest, cleanBoard: cleanBoard, GENERIC: GENERIC, num: num, hex: hex, fmtBytes: fmtBytes, u32: u32 };
})(window.FL = window.FL || {});
