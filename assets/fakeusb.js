/* A simulated STM32 ROM DFU bootloader with the shape of a WebUSB USBDevice, for tests/test.html
   and the ?demo page. It keeps real flash rules: a page must be erased (0xFF) before it is written,
   writes come in 8-byte double words, and nothing a DNLOAD asks for happens until GETSTATUS.

   FL.fakeusb.device(opts):
     opts.flashBase (0x08000000), flashSize (512 KB), pageSize (2 KB), transferSize (2048)
     opts.layoutName   the alternate's name; null to leave interfaceName empty as some browsers do
     opts.busyPolls    GETSTATUS calls answering dfuDNBUSY before an operation finishes (1)
     opts.pollTimeout  bwPollTimeout in ms (5)
     opts.latency      ms each control transfer takes (0); opts.eraseMs per page erase (0)
     opts.fill         the flash's starting byte (0xA5, an old program)
     opts.protected    refuse every set-address, like a read-protected (RDP) part
     opts.noUpload     stall UPLOAD
     opts.corruptAt    flip one written byte at this address (a bad verify)
     opts.startState   the state it starts in (dfuIDLE)
   The device records what it did in .log and .jumped (the address it left to). */
(function (FL) {
  'use strict';
  var S = { dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuMANIFEST_SYNC: 6, dfuMANIFEST: 7, dfuUPLOAD_IDLE: 9, dfuERROR: 10 };
  var ERR = { OK: 0, TARGET: 1, WRITE: 3, ERASE: 4, PROG: 6, ADDRESS: 8, STALLEDPKT: 0x0F };

  function wait(ms) { return ms ? new Promise(function (r) { setTimeout(r, ms); }) : Promise.resolve(); }
  function networkError(msg) { var e = new Error(msg || 'A transfer error has occurred.'); e.name = 'NetworkError'; return e; }

  function device(opts) {
    opts = opts || {};
    var base = opts.flashBase !== undefined ? opts.flashBase : 0x08000000;
    var size = opts.flashSize || 512 * 1024, page = opts.pageSize || 2048, xfer = opts.transferSize || 2048;
    var name = opts.layoutName !== undefined ? opts.layoutName : '@Internal Flash  /0x' + base.toString(16).toUpperCase().padStart(8, '0') + '/' +
      (size / page) + '*' + String(page / 1024).padStart(2, '0') + 'Kg';
    var flash = new Uint8Array(size).fill(opts.fill === undefined ? 0xA5 : opts.fill);
    var st = { state: opts.startState || S.dfuIDLE, status: ERR.OK, pointer: base, pending: null, busy: 0 };
    var busyPolls = opts.busyPolls === undefined ? 1 : opts.busyPolls, pollTimeout = opts.pollTimeout === undefined ? 5 : opts.pollTimeout;

    var alternates = [
      { alternateSetting: 0, interfaceClass: 0xFE, interfaceSubclass: 1, interfaceProtocol: 2, interfaceName: name },
      { alternateSetting: 1, interfaceClass: 0xFE, interfaceSubclass: 1, interfaceProtocol: 2, interfaceName: name === null ? null : '@Option Bytes   /0x1FFF7800/01*048 e' },
      { alternateSetting: 2, interfaceClass: 0xFE, interfaceSubclass: 1, interfaceProtocol: 2, interfaceName: name === null ? null : '@OTP Memory   /0x1FFF7000/01*01Ke' }
    ];
    var itf = { interfaceNumber: 0, claimed: false, alternate: alternates[0], alternates: alternates };
    var dev = {
      vendorId: 0x0483, productId: 0xDF11, productName: 'DFU in FS Mode', manufacturerName: 'STMicroelectronics', serialNumber: opts.serial || 'FAKE0001',
      opened: false, configuration: null, configurations: [{ configurationValue: 1, interfaces: [itf] }],
      flash: flash, log: [], jumped: null, gone: false, writes: 0, erases: 0
    };
    function live() { if (dev.gone) return Promise.reject(networkError('The device was disconnected.')); return wait(opts.latency); }

    dev.open = function () { return live().then(function () { dev.opened = true; }); };
    dev.close = function () { dev.opened = false; return Promise.resolve(); };
    dev.selectConfiguration = function (v) { return live().then(function () { dev.configuration = dev.configurations[0]; }); };
    dev.claimInterface = function (n) { return live().then(function () { if (!dev.opened) throw networkError('Not open'); itf.claimed = true; }); };
    dev.releaseInterface = function (n) { itf.claimed = false; return live(); };
    dev.selectAlternateInterface = function (n, a) { return live().then(function () { itf.alternate = alternates[a]; }); };

    function stall(why) { dev.log.push('stall: ' + why); st.state = S.dfuERROR; st.status = ERR.STALLEDPKT; return { status: 'stall' }; }
    function fail(code, why) { dev.log.push('error: ' + why); st.state = S.dfuERROR; st.status = code; }
    function inFlash(a, n) { return a >= base && a + n <= base + size; }

    // Run the operation a DNLOAD queued; called once the busy polls are done.
    function finish() {
      var p = st.pending; st.pending = null;
      if (!p) return;
      if (p.kind === 'cmd') {
        var d = p.data, cmd = d[0], addr = d.length >= 5 ? (d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24)) >>> 0 : null;
        if (cmd === 0x21) {
          if (opts.protected) return fail(ERR.TARGET, 'read-protected');
          if (addr === null || !inFlash(addr, 1)) return fail(ERR.ADDRESS, 'bad address');
          st.pointer = addr; dev.log.push('set ' + addr.toString(16));
        } else if (cmd === 0x41) {
          if (addr === null) return fail(ERR.TARGET, 'mass erase not simulated');
          if (!inFlash(addr, 1) || (addr - base) % page) return fail(ERR.ADDRESS, 'erase not on a page');
          flash.fill(0xFF, addr - base, addr - base + page); dev.erases++; dev.log.push('erase ' + addr.toString(16));
        } else return fail(ERR.TARGET, 'unknown command ' + cmd);
      } else if (p.kind === 'data') {
        var at = st.pointer + (p.block - 2) * xfer, bytes = p.data;
        if (!inFlash(at, bytes.length)) return fail(ERR.ADDRESS, 'write outside flash');
        if (bytes.length % 8) return fail(ERR.PROG, 'not a whole double word');
        for (var i = 0; i < bytes.length; i++) if (flash[at - base + i] !== 0xFF) return fail(ERR.PROG, 'write to unerased flash at ' + (at + i).toString(16));
        flash.set(bytes, at - base);
        if (opts.corruptAt !== undefined && opts.corruptAt >= at && opts.corruptAt < at + bytes.length) flash[opts.corruptAt - base] ^= 0x10;
        dev.writes++; dev.log.push('write ' + at.toString(16) + ' ' + bytes.length);
      }
    }

    dev.controlTransferOut = function (setup, data) {
      return live().then(function () {
        if (setup.requestType !== 'class') return { status: 'stall' };
        var bytes = data ? new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength) : data) : new Uint8Array(0);
        switch (setup.request) {
          case 1: // DNLOAD
            if (st.state !== S.dfuIDLE && st.state !== S.dfuDNLOAD_IDLE) return stall('DNLOAD in state ' + st.state);
            if (!bytes.length) { st.state = S.dfuMANIFEST_SYNC; dev.log.push('leave requested'); return { status: 'ok', bytesWritten: 0 }; }
            if (setup.value === 0) {
              if (opts.protected && bytes[0] === 0x21) return stall('protected');
              st.pending = { kind: 'cmd', data: bytes };
            } else if (setup.value >= 2) st.pending = { kind: 'data', block: setup.value, data: bytes };
            else return stall('block 1');
            st.state = S.dfuDNLOAD_SYNC; st.busy = busyPolls;
            return { status: 'ok', bytesWritten: bytes.length };
          case 4: // CLRSTATUS
            if (st.state === S.dfuERROR) { st.state = S.dfuIDLE; st.status = ERR.OK; }
            return { status: 'ok', bytesWritten: 0 };
          case 6: // ABORT
            if (st.state === S.dfuERROR) return stall('ABORT in error');
            st.state = S.dfuIDLE; st.pending = null;
            return { status: 'ok', bytesWritten: 0 };
          default: return stall('out request ' + setup.request);
        }
      });
    };

    dev.controlTransferIn = function (setup, length) {
      var self = this;
      return live().then(function () {
        if (setup.requestType === 'standard' && setup.request === 6 && (setup.value >> 8) === 2) return { status: 'ok', data: new DataView(configDescriptor().buffer.slice(0, length)) };
        if (setup.requestType !== 'class') return { status: 'stall' };
        switch (setup.request) {
          case 3: { // GETSTATUS
            var timeout = 0;
            if (st.state === S.dfuDNLOAD_SYNC || st.state === S.dfuDNBUSY) {
              if (st.busy > 0) { st.busy--; st.state = S.dfuDNBUSY; timeout = pollTimeout; }
              else { st.state = S.dfuDNLOAD_IDLE; finish(); }
            } else if (st.state === S.dfuMANIFEST_SYNC) {
              // The ROM jumps to the app: the device is gone before this transfer completes.
              dev.jumped = st.pointer; dev.gone = true; dev.opened = false; dev.log.push('jumped ' + st.pointer.toString(16));
              throw networkError();
            }
            var erasing = st.state === S.dfuDNBUSY && st.pending && st.pending.kind === 'cmd' && st.pending.data[0] === 0x41;
            var out = new Uint8Array([st.status, timeout & 0xFF, (timeout >> 8) & 0xFF, 0, st.state, 0]);
            return wait(erasing ? opts.eraseMs : 0).then(function () { return { status: 'ok', data: new DataView(out.buffer) }; });
          }
          case 5: return { status: 'ok', data: new DataView(new Uint8Array([st.state]).buffer) };
          case 2: { // UPLOAD
            if (opts.noUpload) return stall('upload refused');
            if (st.state !== S.dfuIDLE && st.state !== S.dfuUPLOAD_IDLE) return stall('UPLOAD in state ' + st.state);
            if (setup.value < 2) return stall('upload block ' + setup.value);
            var at = st.pointer + (setup.value - 2) * xfer, n = Math.min(length, xfer);
            if (!inFlash(at, n)) return stall('upload outside flash');
            st.state = S.dfuUPLOAD_IDLE;
            return { status: 'ok', data: new DataView(flash.slice(at - base, at - base + n).buffer) };
          }
          default: return stall('in request ' + setup.request);
        }
      });
    };

    function configDescriptor() {
      var parts = [[9, 2, 0, 0, 1, 1, 0, 0xC0, 50]];
      alternates.forEach(function (a) { parts.push([9, 4, 0, a.alternateSetting, 0, 0xFE, 1, 2, 4 + a.alternateSetting]); });
      parts.push([9, 0x21, 0x0B, 0xFF, 0x00, xfer & 0xFF, (xfer >> 8) & 0xFF, 0x1A, 0x01]);
      var all = [].concat.apply([], parts);
      all[2] = all.length & 0xFF; all[3] = all.length >> 8;
      return new Uint8Array(all);
    }

    dev.state = function () { return st.state; };
    dev.read = function (addr, n) { return flash.slice(addr - base, addr - base + n); };
    return dev;
  }

  /* A Web Serial port that records what was done to it: { opened: [{baudRate}], signals: [..], closed }. */
  function serialPort(opts) {
    opts = opts || {};
    var port = { info: { usbVendorId: opts.vid || 0x0483, usbProductId: opts.pid || 0x5740 }, opened: [], signals: [], closed: 0, readable: null, writable: null };
    port.getInfo = function () { return port.info; };
    port.open = function (o) { if (opts.busy) return Promise.reject(Object.assign(new Error('Failed to open serial port.'), { name: 'NetworkError' })); port.opened.push(o); return Promise.resolve(); };
    port.setSignals = function (s) { port.signals.push(s); return Promise.resolve(); };
    port.close = function () { port.closed++; return opts.vanish ? Promise.reject(Object.assign(new Error('The device has been lost.'), { name: 'NetworkError' })) : Promise.resolve(); };
    return port;
  }

  /* A firmware console that edits its own line, the way a board's own console can: it echoes, keeps
     history (Up/Down, Ctrl-P/N), moves (Left/Right, Home/End, Ctrl-A/E), erases (Backspace, Delete,
     Ctrl-U), completes with Tab, clears with Ctrl-L and `clear`, and redraws its line with
     \r <prompt> <line> ESC[K ESC[nD. opts: { name, banner, onData(text), commands: { name: fn(args, sh) } }.
     input(text) takes what the terminal sends; start() prints the banner and the prompt; stop(). */
  function shell(opts) {
    var line = '', cur = 0, hist = [], back = 0, saved = '', esc = 0, param = '', watch = 0;
    var emit = function (t) { opts.onData(t); };
    var prompt = function () { return (opts.name || 'demo') + '> '; };
    function redraw() { emit('\r' + prompt() + line + '\x1b[K' + (line.length > cur ? '\x1b[' + (line.length - cur) + 'D' : '')); }
    function set(s) { line = s; cur = s.length; redraw(); }
    function histMove(older) {
      if (older ? back >= hist.length : back === 0) return;
      if (back === 0) saved = line;
      back += older ? 1 : -1;
      set(back === 0 ? saved : hist[hist.length - back]);
    }
    var commands = Object.assign({
      help: function () { return 'Commands: ' + Object.keys(commands).sort().join(', ') + '\r\nkeys: Tab completes, Up/Down history, Left/Right/Home/End move, Ctrl-U erases, Ctrl-L redraws.'; },
      clear: function () { emit('\x1b[2J\x1b[H'); return 'OK'; },
      watch: function () { var n = 0; watch = setInterval(function () { n++; emit('\r\x1b[K' + 'watch ' + n + '  T=' + (21.4 + Math.sin(n / 3) * 0.2).toFixed(2) + ' °C'); }, 200); return null; }
    }, opts.commands || {});
    function run(text) {
      var parts = text.trim().split(/\s+/), name = parts[0];
      if (!name) return;
      var fn = commands[name.toLowerCase()];
      var out = fn ? fn(parts.slice(1), api) : 'ERR unknown command: ' + name + ' (try help)';
      if (out !== null && out !== undefined) emit(out + '\r\n');
    }
    function stopWatch() { clearInterval(watch); watch = 0; emit('\r\x1b[K' + 'OK watch stopped\r\n' + prompt()); }
    function key(ch) {
      if (watch) { stopWatch(); return; }
      if (esc === 1) { esc = ch === '[' ? 2 : 0; param = ''; return; }
      if (esc === 2) {
        if (/[0-9]/.test(ch)) { param += ch; return; }
        esc = 0;
        if (ch === 'A') histMove(true); else if (ch === 'B') histMove(false);
        else if (ch === 'C' && cur < line.length) { cur++; emit('\x1b[C'); }
        else if (ch === 'D' && cur > 0) { cur--; emit('\x1b[D'); }
        else if (ch === 'H') { cur = 0; redraw(); } else if (ch === 'F') { cur = line.length; redraw(); }
        else if (ch === '~' && param === '3' && cur < line.length) { line = line.slice(0, cur) + line.slice(cur + 1); redraw(); }
        return;
      }
      var c = ch.charCodeAt(0);
      if (c === 27) { esc = 1; return; }
      if (ch === '\r' || ch === '\n') {
        emit('\r\n');
        var text = line;
        if (text.trim() && hist[hist.length - 1] !== text) hist.push(text);
        line = ''; cur = 0; back = 0;
        run(text);
        if (!watch) emit(prompt());
        return;
      }
      if (c === 0x7f || c === 8) { if (cur > 0) { line = line.slice(0, cur - 1) + line.slice(cur); cur--; redraw(); } return; }
      if (c === 1) { cur = 0; redraw(); return; }
      if (c === 5) { cur = line.length; redraw(); return; }
      if (c === 3) { emit('^C\r\n' + prompt()); line = ''; cur = 0; back = 0; return; }
      if (c === 12) { emit('\x1b[2J\x1b[H'); redraw(); return; }
      if (c === 16) { histMove(true); return; }
      if (c === 14) { histMove(false); return; }
      if (c === 21) { line = line.slice(cur); cur = 0; redraw(); return; }
      if (ch === '\t') {
        var hits = Object.keys(commands).filter(function (k) { return k.indexOf(line) === 0; });
        if (hits.length === 1) set(hits[0] + ' ');
        else if (hits.length > 1) { emit('\r\n' + hits.sort().join('  ') + '\r\n'); redraw(); }
        return;
      }
      if (c < 0x20) return;
      line = line.slice(0, cur) + ch + line.slice(cur); cur++;
      if (cur === line.length) emit(ch); else redraw();
    }
    var api = {
      input: function (text) { for (var i = 0; i < text.length; i++) key(text.charAt(i)); },
      start: function () { emit((opts.banner || '') + '\r\n' + prompt()); },
      stop: function () { clearInterval(watch); watch = 0; },
      emit: emit
    };
    return api;
  }

  FL.fakeusb = { device: device, serialPort: serialPort, shell: shell };
})(window.FL = window.FL || {});
