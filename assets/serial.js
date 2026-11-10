/* Web Serial: the 1200-baud touch that sends a running board to its bootloader, and a small
   console for after a flash.

   The touch is what the Arduino IDE does: open the board's USB serial port at 1200 baud and
   close it with DTR low. Opening asserts DTR, so it is dropped explicitly and held long enough for
   the firmware to notice (the board's sketch wants 20 ms) before closing. The board then resets,
   so a failing close is normal. (Tried on a real board 2026-11-10.) If the port won't open, another
   program has it, most often the Arduino IDE (its Serial Monitor, or the IDE itself). */
(function (FL) {
  'use strict';

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function touch(port, opts) {
    opts = opts || {};
    var baud = opts.baud || 1200, hold = opts.holdMs === undefined ? 150 : opts.holdMs, nap = opts.sleep || sleep;
    var open = function () { return port.open({ baudRate: baud }); };
    // A port that just appeared may not be ready on Windows yet: one retry, a second later.
    return open().catch(function () { return nap(1000).then(open); }).catch(function (e) {
      var err = new Error('Couldn’t open the board’s serial port' + (e && e.message ? ' (' + e.message + ')' : '') +
        '. Another program has it open: close the Arduino IDE (or its Serial Monitor), PuTTY, or another tab with Flasher, then try again.');
      err.code = 'busy'; throw err;
    }).then(function () {
      return Promise.resolve(port.setSignals ? port.setSignals({ dataTerminalReady: false, requestToSend: false }) : null).catch(function () {});
    }).then(function () { return nap(hold); }).then(function () {
      return Promise.resolve(port.close()).catch(function () {});   // the board may already be resetting
    });
  }

  function matches(info, ids) { return !!ids && info && info.usbVendorId === ids.vid && info.usbProductId === ids.pid; }

  /* A console on an open port: open(port) then send(text); onData(text) gets what arrives.
     Opens at 115200 (any rate but the touch rate: 1200 would send the board back to its bootloader). */
  function Console(onData, onClose) {
    this.onData = onData; this.onClose = onClose || function () {};
    this.port = null; this.reader = null; this.closing = false;
  }
  Console.prototype.open = function (port) {
    var self = this;
    this.port = port; this.closing = false;
    return port.open({ baudRate: 115200 }).then(function () {
      return Promise.resolve(port.setSignals ? port.setSignals({ dataTerminalReady: true }) : null).catch(function () {});
    }).then(function () { self.pump(); });
  };
  Console.prototype.pump = function () {
    var self = this, dec = new TextDecoder();
    var reader = this.reader = this.port.readable.getReader();
    function more() {
      return reader.read().then(function (r) {
        if (r.done) return;
        if (r.value) self.onData(dec.decode(r.value, { stream: true }));
        return more();
      });
    }
    more().catch(function () {}).then(function () {
      try { reader.releaseLock(); } catch (e) { /* already released */ }
      if (!self.closing) self.close();
    });
  };
  // Keys are sent one write each, in order: each waits for the one before.
  Console.prototype.send = function (text) {
    var port = this.port;
    if (!port) return Promise.reject(new Error('The console is closed.'));
    var job = (this.writing || Promise.resolve()).catch(function () {}).then(function () {
      var w = port.writable.getWriter();
      return w.write(new TextEncoder().encode(text)).then(function () { w.releaseLock(); }, function (e) { w.releaseLock(); throw e; });
    });
    this.writing = job;
    return job;
  };
  Console.prototype.close = function () {
    var self = this, port = this.port;
    if (!port) return Promise.resolve();
    this.closing = true; this.port = null;
    return Promise.resolve(this.reader && this.reader.cancel()).catch(function () {}).then(function () {
      return port.close();
    }).catch(function () {}).then(function () { self.onClose(); });
  };

  FL.serial = { touch: touch, matches: matches, Console: Console, sleep: sleep };
})(window.FL = window.FL || {});
