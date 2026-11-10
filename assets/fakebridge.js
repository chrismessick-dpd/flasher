/* A simulated board behind a USB bridge, for the tests and ?demo: a Web Serial port whose far end
   is a bootloader speaking FL.sboot's protocol, with its own flash.

     var sim = FL.fakebridge.display({ units: [{ addr, size }], appBase, qspiBase, device })
     var port = FL.fakebridge.port(sim, { vid, pid })      // the bridge's serial port

   Opening the port at the exit rate (1200) leaves the bridge: sim.exits counts it and
   opts.onExit() runs. Bytes sent at a rate other than the bootloader's own come back garbled, as a
   real UART would. sim.dropEvery = n loses every nth answer, to exercise the host's retries. */
(function (FL) {
  'use strict';
  var B = FL.sboot;

  function display(opts) {
    opts = opts || {};
    var sim = {
      units: (opts.units || []).map(function (u) { return { addr: u.addr, size: u.size }; }),
      mem: {}, baud: opts.baud || 1000000, record: opts.record === undefined ? B.RECORD.COMPLETE : opts.record,
      begun: false, running: false, booted: false, bootMs: opts.bootMs === undefined ? 30 : opts.bootMs,
      latency: opts.latency || 0, eraseMs: opts.eraseMs || 0, device: opts.device || 0x4A5, appBase: opts.appBase >>> 0,
      qspiBase: opts.qspiBase >>> 0, qspiSize: opts.qspiSize || 0x1000000, singleBank: opts.singleBank !== false,
      exits: 0, log: [], counts: {}, dropEvery: 0, answered: 0
    };
    sim.unitAt = function (a) { return sim.units.filter(function (u) { return a >= u.addr && a < u.addr + u.size; })[0] || null; };
    sim.read = function (addr, len) {
      var out = new Uint8Array(len).fill(0xFF);
      sim.units.forEach(function (u) {
        var m = sim.mem[u.addr]; if (!m) return;
        var lo = Math.max(addr, u.addr), hi = Math.min(addr + len, u.addr + u.size);
        if (lo < hi) out.set(m.subarray(lo - u.addr, hi - u.addr), lo - addr);
      });
      return out;
    };
    /* Lay bytes over the flash directly (the board's state before an update). */
    sim.load = function (addr, bytes) {
      for (var i = 0; i < bytes.length;) {
        var u = sim.unitAt(addr + i); if (!u) throw new Error('No unit at ' + B.hex(addr + i));
        var m = sim.mem[u.addr] || (sim.mem[u.addr] = new Uint8Array(u.size).fill(0xFF));
        var off = addr + i - u.addr, n = Math.min(bytes.length - i, u.size - off);
        m.set(bytes.subarray(i, i + n), off); i += n;
      }
    };
    sim.handle = function (cmd, p) {
      sim.counts[cmd] = (sim.counts[cmd] || 0) + 1;
      var ok = [0], u, addr;
      switch (cmd) {
        case B.CMD.INFO: {
          var b = new Uint8Array(41);
          b[1] = B.PROTOCOL; b[2] = 1; b[3] = 0x00; b[4] = 0x01; b[5] = sim.device & 0xFF; b[6] = sim.device >> 8; b[7] = sim.singleBank ? 1 : 0; b[8] = sim.record;
          b[9] = B.MAX_DATA & 0xFF; b[10] = B.MAX_DATA >> 8;
          [sim.appBase, sim.appBase + 0xF0000, sim.qspiBase, sim.qspiSize, 0x12345678, 0x9ABCDEF0, 0x0BADF00D].forEach(function (w, i) { b.set(B.le32(w), 13 + i * 4); });
          return b;
        }
        case B.CMD.CRC: return [0].concat(B.le32(B.crc32(sim.read(B.rd32(p, 0), B.rd32(p, 4)))));
        case B.CMD.ERASE:
          addr = B.rd32(p, 0); u = sim.unitAt(addr);
          if (!sim.begun) return [0x0A];
          if (!u || u.addr !== addr) return [0x04];
          sim.mem[u.addr] = new Uint8Array(u.size).fill(0xFF);
          return ok;
        case B.CMD.WRITE: {
          addr = B.rd32(p, 0); var data = p.subarray(4); u = sim.unitAt(addr);
          if (!sim.begun) return [0x0A];
          if (!u || addr + data.length > u.addr + u.size) return [0x04];
          var m = sim.mem[u.addr] || (sim.mem[u.addr] = new Uint8Array(u.size).fill(0xFF)), off = addr - u.addr;
          for (var i = 0; i < data.length; i++) { m[off + i] &= data[i]; if (m[off + i] !== data[i]) return [0x08]; }
          return ok;
        }
        case B.CMD.BEGIN: sim.begun = true; sim.record = B.RECORD.INCOMPLETE; return ok;
        case B.CMD.COMMIT: {
          var crc = B.rd32(p, 0), len = B.rd32(p, 4);
          if (!sim.begun) return [0x0A];
          if (B.crc32(sim.read(sim.appBase, len)) !== crc) return [0x08];
          sim.record = B.RECORD.COMPLETE; sim.begun = false; return ok;
        }
        case B.CMD.GO: sim.running = true; return ok;
        case B.CMD.SET_BAUD: { var r = B.rd32(p, 0); if (r < 9600) return [0x0B]; sim.nextBaud = r; return ok; }
        default: return [0x02];
      }
    };
    return sim;
  }

  function port(sim, opts) {
    opts = opts || {};
    var p = { info: { usbVendorId: opts.vid || 0x1209, usbProductId: opts.pid || 0x000C }, readable: null, writable: null, opened: [], baud: 0 };
    var ctrl = null, rx = null, queue = Promise.resolve();
    p.getInfo = function () { return p.info; };
    function deliver(bytes, delay, atBaud) {
      queue = queue.then(function () {
        return new Promise(function (r) { setTimeout(r, delay); });
      }).then(function () {
        if (!ctrl) return;
        if (atBaud !== p.baud) bytes = bytes.map(function (x) { return x ^ 0x5A; });   // the wrong rate: noise
        try { ctrl.enqueue(bytes); } catch (e) { /* closed */ }
      });
    }
    function feed(chunk) {
      if (!sim.booted || sim.running) return;          // still starting, or gone to its application
      if (p.baud !== sim.baud) return;                 // garbage on the UART: no frame parses
      rx.push(chunk);
      var f;
      while ((f = rx.take())) {
        var out = sim.handle(f.cmd, f.payload), slow = f.cmd === B.CMD.ERASE ? sim.eraseMs : 0;
        sim.answered++;
        if (sim.dropEvery && sim.answered % sim.dropEvery === 0) { sim.log.push('dropped ' + f.cmd); continue; }
        deliver(B.frame(f.cmd | 0x80, f.seq, out, B.RSP), sim.latency + slow, sim.baud);
        if (sim.nextBaud) { var nb = sim.nextBaud; sim.nextBaud = 0; queue = queue.then(function () { sim.baud = nb; }); }
      }
    }
    p.open = function (o) {
      if (p.readable) return Promise.reject(Object.assign(new Error('The port is already open.'), { name: 'InvalidStateError' }));
      if (opts.gone && opts.gone()) return Promise.reject(Object.assign(new Error('The device has been lost.'), { name: 'NetworkError' }));
      p.opened.push(o);
      if (o.baudRate === (opts.exitBaud || 1200)) {
        sim.exits++; sim.running = true;
        if (opts.onExit) opts.onExit();
        return Promise.resolve();
      }
      p.baud = o.baudRate; rx = new B.Rx(B.REQ);
      p.readable = new ReadableStream({ start: function (c) { ctrl = c; }, cancel: function () { ctrl = null; } });
      p.writable = new WritableStream({ write: function (chunk) { feed(new Uint8Array(chunk)); } });
      if (!sim.booted) setTimeout(function () { sim.booted = true; }, sim.bootMs);
      return Promise.resolve();
    };
    p.close = function () {
      try { if (ctrl) ctrl.close(); } catch (e) { /* already closed */ }
      ctrl = null; p.readable = null; p.writable = null;
      return Promise.resolve();
    };
    return p;
  }

  FL.fakebridge = { display: display, port: port };
})(window.FL = window.FL || {});
