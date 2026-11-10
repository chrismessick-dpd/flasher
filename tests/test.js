/* Flasher tests. The fake device keeps the ROM bootloader's rules (assets/fakeusb.js), so these
   exercise the same request sequence a real board sees. */
(function () {
  'use strict';
  var D = FL.dfuse, I = FL.image, F = FL.fakeusb;
  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }
  function eq(a, b, what) { if (a !== b) throw new Error((what || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
  function ok(v, what) { if (!v) throw new Error(what || 'expected true'); }
  function rejects(p, re, what) {
    return p.then(function () { throw new Error((what || 'promise') + ' should have failed'); }, function (e) {
      if (re && !re.test(e.message + ' ' + (e.code || ''))) throw new Error((what || 'error') + ': unexpected “' + e.message + '” (' + e.code + ')');
      return e;
    });
  }
  var noSleep = function () { return Promise.resolve(); };

  // A made-up board shaped like a 512 KB / 112 KB STM32G4.
  var BOARD = I.cleanBoard('test-g4', {
    name: 'Test board', flash: { base: '0x08000000', size: '0x80000' }, ram: { base: '0x20000000', size: '0x1C000' },
    dfu: { vid: '0x0483', pid: '0xDF11' }, run: { vid: '0x0483', pid: '0x5740', name: 'Test' }
  }, []);
  function image(size, seed) { return FL.catalog.makeImage(size, seed || 5, BOARD); }
  function session(dev, opts) { return new D.Dfuse(dev, Object.assign({ sleep: noSleep }, opts || {})); }

  // ── Parsing ──
  test('parseLayout: a G4’s single run of 2 KB pages', function () {
    var l = D.parseLayout('@Internal Flash  /0x08000000/256*02Kg');
    eq(l.name, 'Internal Flash'); eq(l.segments.length, 1);
    eq(l.segments[0].start, 0x08000000); eq(l.segments[0].end, 0x08080000); eq(l.segments[0].pageSize, 2048);
    ok(l.segments[0].readable && l.segments[0].erasable && l.segments[0].writable, 'g = readable, erasable, writable');
  });
  test('parseLayout: F4 sectors, units, and read-only types', function () {
    var l = D.parseLayout('@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg');
    eq(l.segments.length, 3); eq(l.segments[1].start, 0x08010000); eq(l.segments[2].end, 0x08100000);
    var o = D.parseLayout('@Option Bytes  /0x1FFF7800/01*048 e');
    eq(o.segments[0].pageSize, 48); ok(!o.segments[0].erasable && o.segments[0].writable && o.segments[0].readable, 'e = readable, writable');
    var two = D.parseLayout('@Mixed /0x08000000/2*1Ka/0x20000000/1*4Kg');
    eq(two.segments.length, 2); eq(two.segments[1].start, 0x20000000);
    eq(D.parseLayout('Internal Flash'), null); eq(D.parseLayout('@x/zz/1*2Kg'), null);
  });
  test('pagesFor: covers the image, refuses past the end', function () {
    var l = D.parseLayout('@Internal Flash  /0x08000000/256*02Kg');
    eq(D.pagesFor(l, 0x08000000, 2048).length, 1);
    eq(D.pagesFor(l, 0x08000000, 2049).length, 2);
    eq(D.pagesFor(l, 0x08000000, 31000).length, 16);
    var thrown = null; try { D.pagesFor(l, 0x08000000, 512 * 1024 + 1); } catch (e) { thrown = e; }
    ok(thrown && thrown.code === 'range', 'too long');
  });
  test('parseFunctional: wTransferSize from a configuration descriptor', function () {
    var bytes = [9, 2, 36, 0, 1, 1, 0, 0xC0, 50, 9, 4, 0, 0, 0, 0xFE, 1, 2, 4, 9, 4, 0, 1, 0, 0xFE, 1, 2, 5, 9, 0x21, 0x0B, 0xFF, 0, 0x00, 0x08, 0x1A, 0x01];
    var f = D.parseFunctional(new Uint8Array(bytes));
    eq(f.transferSize, 2048); eq(f.version, 0x011A); eq(f.attributes, 0x0B);
    eq(D.parseFunctional(new Uint8Array([9, 2, 9, 0, 1, 1, 0, 0, 0])), null);
  });

  // ── Image checks ──
  test('check: a good image, with the stack pointer at the very top of RAM', function () {
    var b = image(31000);
    eq(I.u32(b, 0), 0x2001C000, 'sp = top of RAM');
    var c = I.check(b, BOARD);
    ok(c.ok, c.errors.join(' '));
  });
  test('check: stack pointer outside RAM, or a flash address', function () {
    var b = image(4096);
    b.set([0x04, 0xC0, 0x01, 0x20], 0);          // 0x2001C004: past the top
    ok(/stack pointer/.test(I.check(b, BOARD).errors.join()), 'past top');
    b.set([0x00, 0x00, 0x00, 0x20], 0);          // 0x20000000: the base itself is not a valid initial SP
    ok(!I.check(b, BOARD).ok, 'at base');
    b.set([0x00, 0x10, 0x00, 0x08], 0);          // a flash address
    ok(!I.check(b, BOARD).ok, 'in flash');
  });
  test('check: reset vector even, or outside the image', function () {
    var b = image(4096);
    b.set([0x00, 0x02, 0x00, 0x08], 4);
    ok(/even/.test(I.check(b, BOARD).errors.join()), 'even');
    b.set([0x01, 0x20, 0x00, 0x08], 4);          // 0x08002001: past a 4 KB image
    ok(/outside the image/.test(I.check(b, BOARD).errors.join()), 'outside');
    b.set([0x01, 0x02, 0x00, 0x00], 4);          // an address-0 build
    ok(!I.check(b, BOARD).ok, 'other load address');
  });
  test('check: too big, empty, ELF, and Intel HEX', function () {
    ok(/more than/.test(I.check(image(512 * 1024 + 8), BOARD).errors.join()), 'too big');
    ok(I.check(image(512 * 1024), BOARD).ok, 'exactly full is fine');
    ok(/empty/.test(I.check(new Uint8Array(0), BOARD).errors.join()), 'empty');
    ok(/ELF/.test(I.check(new Uint8Array([0x7F, 0x45, 0x4C, 0x46, 1, 1, 1, 0, 0, 0]), BOARD).errors.join()), 'elf');
    ok(/HEX/.test(I.check(new TextEncoder().encode(':020000040800F2\n:10000000'), BOARD).errors.join()), 'hex');
  });

  // ── The manifest ──
  test('cleanManifest: hex strings, unknown boards, bad paths, and bad hashes', function () {
    var sha = 'a'.repeat(64);
    var c = I.cleanManifest({ format: 1, boards: {
      'b1': { name: 'B1', flash: { base: '0x08000000', size: 524288 }, ram: { base: '0x20000000', size: '0x1C000' }, dfu: { vid: '0x0483', pid: '0xdf11' } },
      'Bad Id': { flash: {}, ram: {}, dfu: {} },
      'b2': { name: 'No dfu', flash: { base: 0, size: 1 }, ram: { base: 0, size: 1 } }
    }, firmware: [
      { id: 'ok', board: 'b1', path: 'firmware/b1/ok.bin', sha256: sha, size: 10, name: 'OK <b>', source: { sha: 'abc1234', repo: 'o/r' } },
      { id: 'ghost', board: 'nope', path: 'firmware/nope/ghost.bin', sha256: sha, size: 10 },
      { id: 'escape', board: 'b1', path: 'firmware/b1/../../x.bin', sha256: sha, size: 10 },
      { id: 'short', board: 'b1', path: 'firmware/b1/short.bin', sha256: 'abc', size: 10 }
    ] });
    eq(Object.keys(c.boards).join(), 'b1'); eq(c.boards.b1.flash.size, 524288); eq(c.boards.b1.dfu.pid, 0xDF11);
    eq(c.boards.b1.run, null, 'no run: no touch'); eq(c.boards.b1.touchBaud, 0);
    eq(c.firmware.length, 1); eq(c.firmware[0].name, 'OK <b>', 'kept raw; escaped when drawn');
    eq(c.problems.length, 5);
  });

  // ── DfuSe against the simulated bootloader ──
  test('flash: erase, write, verify, and leave on a 512 KB part', function () {
    var dev = F.device(), img = image(31003, 9);   // odd length: the tail is padded to a double word
    var s = session(dev), seen = {};
    return s.open().then(function () {
      eq(s.transferSize, 2048, 'from the descriptor'); eq(s.alt, 0); eq(s.layout.segments[0].pageSize, 2048);
      return s.flash(0x08000000, img, function (p) { seen[p.phase] = p; });
    }).then(function (r) {
      eq(r.pages, 16); eq(r.verified, true);
      eq(seen.erase.done, 16); eq(seen.write.done, 31003); eq(seen.verify.done, 31003);
      var back = dev.read(0x08000000, img.length);
      for (var i = 0; i < img.length; i++) if (back[i] !== img[i]) throw new Error('flash differs at ' + i);
      eq(dev.read(0x08000000 + 31003, 1)[0], 0xFF, 'padding is erased-state');
      eq(dev.read(0x08000000 + 16 * 2048, 1)[0], 0xA5, 'pages past the image are untouched');
      eq(dev.erases, 16); eq(dev.writes, 16);
      return s.leave(0x08000000);
    }).then(function () {
      eq(dev.jumped, 0x08000000, 'started at flash'); ok(dev.gone, 'device left the bus');
    });
  });
  test('flash: the transfer size follows the device (1024)', function () {
    var dev = F.device({ transferSize: 1024 }), s = session(dev);
    return s.open().then(function () { eq(s.transferSize, 1024); return s.flash(0x08000000, image(8192)); })
      .then(function () { eq(dev.writes, 8); });
  });
  test('busy polling waits each bwPollTimeout', function () {
    var waits = [], dev = F.device({ busyPolls: 3, pollTimeout: 7 });
    var s = new D.Dfuse(dev, { sleep: function (ms) { waits.push(ms); return Promise.resolve(); } });
    return s.open().then(function () { return s.flash(0x08000000, image(2048)); }).then(function () {
      // set address (probe), erase, set address and data (write), set address (verify): 5 downloads × 3 busy polls
      eq(waits.length, 15); ok(waits.every(function (w) { return w === 7; }), 'waited the device’s timeout');
    });
  });
  test('a poll that never finishes times out', function () {
    var t = 0, dev = F.device({ busyPolls: 1e9, pollTimeout: 100 });
    var s = new D.Dfuse(dev, { sleep: function (ms) { t += ms; return Promise.resolve(); }, now: function () { return t; }, pollLimitMs: 1000 });
    return s.open().then(function () { return rejects(s.flash(0x08000000, image(2048)), /timed out|protected/); });
  });
  test('writing without an erase: dfuERROR, reported, then cleared', function () {
    var dev = F.device(), s = session(dev);
    return s.open().then(function () { return rejects(s.write(0x08000000, image(2048)), /programming failed/); })
      .then(function () { eq(dev.state(), 2, 'CLRSTATUS put it back to dfuIDLE'); return s.flash(0x08000000, image(2048)); })
      .then(function (r) { eq(r.verified, true, 'recovers'); });
  });
  test('a bad byte on write fails the verify', function () {
    var dev = F.device({ corruptAt: 0x08001234 }), s = session(dev);
    return s.open().then(function () { return rejects(s.flash(0x08000000, image(16384)), /Verify failed: the byte at 0x08001234/); });
  });
  test('a read-protected part says so', function () {
    var dev = F.device({ protected: true }), s = session(dev);
    return s.open().then(function () { return rejects(s.flash(0x08000000, image(2048)), /read-protected/); })
      .then(function () { eq(dev.erases, 0, 'nothing erased'); });
  });
  test('a part that refuses UPLOAD can’t be verified, and says so', function () {
    var dev = F.device({ noUpload: true }), s = session(dev);
    return s.open().then(function () { return rejects(s.flash(0x08000000, image(2048)), /can’t be verified|no-upload/); });
  });
  test('verify can be turned off', function () {
    var dev = F.device({ noUpload: true }), s = session(dev);
    return s.open().then(function () { return s.flash(0x08000000, image(2048), null, { verify: false }); })
      .then(function (r) { eq(r.verified, false); });
  });
  test('starting in dfuERROR or dfuUPLOAD_IDLE: brought back to idle', function () {
    var a = F.device({ startState: 10 }), b = F.device({ startState: 9 });
    return session(a).open().then(function (s) { return s.flash(0x08000000, image(4096)); })
      .then(function () { return session(b).open(); }).then(function (s) { return s.flash(0x08000000, image(4096)); })
      .then(function (r) { eq(r.verified, true); });
  });
  test('an image past the end of flash is refused before anything is erased', function () {
    var dev = F.device({ flashSize: 128 * 1024 }), s = session(dev);
    return s.open().then(function () { return rejects(s.flash(0x08000000, image(200 * 1024)), /past the writable flash/); })
      .then(function () { eq(dev.erases, 0); });
  });
  test('no interface names: alternate 0 and the board’s layout', function () {
    var dev = F.device({ layoutName: null }), s = session(dev, { fallbackLayout: '@Internal Flash  /0x08000000/256*02Kg' });
    return s.open().then(function () { eq(s.alt, 0); eq(s.layout.segments[0].end, 0x08080000); return s.flash(0x08000000, image(4096)); });
  });
  test('no names and no board layout: a clear error', function () {
    return rejects(session(F.device({ layoutName: null })).open(), /layout/);
  });
  test('the flash alternate is picked by name, never option bytes', function () {
    var dev = F.device();
    dev.configurations[0].interfaces[0].alternates.reverse();
    dev.configurations[0].interfaces[0].alternates.forEach(function (a, i) { a.alternateSetting = i; });
    var s = session(dev);
    return s.open().then(function () { eq(s.alt, 2); ok(/Internal Flash/.test(dev.configurations[0].interfaces[0].alternate.interfaceName), 'selected'); });
  });
  test('a disconnect mid-write rejects with the browser’s error', function () {
    var dev = F.device(), s = session(dev), n = 0;
    return s.open().then(function () {
      return rejects(s.flash(0x08000000, image(16384), function (p) { if (p.phase === 'write' && ++n === 3) dev.gone = true; }), /disconnected/);
    });
  });

  // ── Serial ──
  test('the 1200-baud touch: open at 1200, drop DTR, hold, close', function () {
    var port = F.serialPort(), slept = [];
    return FL.serial.touch(port, { sleep: function (ms) { slept.push(ms); return Promise.resolve(); } }).then(function () {
      eq(port.opened.length, 1); eq(port.opened[0].baudRate, 1200);
      eq(port.signals[0].dataTerminalReady, false); ok(slept[0] >= 20, 'held longer than the firmware’s 20 ms');
      eq(port.closed, 1);
    });
  });
  test('the touch: a port that vanishes on close is fine; a busy one is explained', function () {
    return FL.serial.touch(F.serialPort({ vanish: true }), { sleep: noSleep }).then(function () {
      var busy = F.serialPort({ busy: true }), tries = 0, open = busy.open;
      busy.open = function (o) { tries++; return open(o); };
      return rejects(FL.serial.touch(busy, { sleep: noSleep }), /Another program has it open: close the Arduino IDE/).then(function () {
        eq(tries, 2, 'one retry');
      });
    });
  });

  // ── The catalog ──
  // A fake GitHub holding one repo: just enough of the git data API for GitHubStore.snapshot and blobs.
  function fakeGitHub(files) {
    var blobs = {}, tree = [];
    return Promise.all(Object.keys(files).map(function (p) {
      var bytes = typeof files[p] === 'string' ? new TextEncoder().encode(files[p]) : files[p];
      return Signoff.github.gitBlobShaBytes(bytes).then(function (sha) { blobs[sha] = bytes; tree.push({ path: p, type: 'blob', sha: sha, size: bytes.length }); });
    })).then(function () {
      var calls = [];
      var fetchImpl = function (url, opts) {
        calls.push(url);
        var body = null, status = 200;
        if (/\/git\/ref\/heads\/main$/.test(url)) body = { object: { sha: 'c0ffee' } };
        else if (/\/git\/commits\/c0ffee$/.test(url)) body = { tree: { sha: 't1' } };
        else if (/\/git\/trees\/t1/.test(url)) body = { tree: tree };
        else { var m = /\/git\/blobs\/([0-9a-f]+)$/.exec(url); if (m && blobs[m[1]]) body = { content: Signoff.github.bytesToB64(blobs[m[1]]), encoding: 'base64' }; else { status = 404; body = { message: 'Not Found' }; } }
        if (!/Bearer tok/.test(opts.headers.Authorization || '')) { status = 401; body = { message: 'Bad credentials' }; }
        return Promise.resolve({ ok: status === 200, status: status, text: function () { return Promise.resolve(JSON.stringify(body)); } });
      };
      fetchImpl.calls = calls;
      return fetchImpl;
    });
  }
  test('loadRepo: reads manifest.json and checks each file’s SHA-256', function () {
    var good = image(4096), bad = image(4096, 77);
    return Promise.all([I.sha256(good)]).then(function (h) {
      var manifest = { format: 1, boards: { 't': { name: 'T', flash: { base: '0x08000000', size: '0x80000' }, ram: { base: '0x20000000', size: '0x1C000' }, dfu: { vid: 1155, pid: 57105 } } },
        firmware: [{ id: 'a', board: 't', path: 'firmware/t/a.bin', sha256: h[0], size: 4096 }, { id: 'b', board: 't', path: 'firmware/t/b.bin', sha256: h[0], size: 4096 }] };
      return fakeGitHub({ 'manifest.json': JSON.stringify(manifest), 'firmware/t/a.bin': good, 'firmware/t/b.bin': bad });
    }).then(function (fetchImpl) {
      return FL.catalog.loadRepo('tok', fetchImpl).then(function (c) {
        eq(c.firmware.length, 2); eq(c.head, 'c0ffee');
        return c.fetch(c.firmware[0]).then(function (bytes) {
          eq(bytes.length, 4096);
          return rejects(c.fetch(c.firmware[1]), /mismatch|doesn’t match/, 'changed file');
        });
      }).then(function () {
        return rejects(FL.catalog.loadRepo('wrong', fetchImpl), /refused the saved token/);
      });
    });
  });
  test('loadRepo: an empty data repo says nothing is published', function () {
    return fakeGitHub({ 'README.md': '# data' }).then(function (fetchImpl) {
      return rejects(FL.catalog.loadRepo('tok', fetchImpl), /no manifest\.json/);
    });
  });
  test('the demo catalog: valid images that match their hashes', function () {
    return FL.catalog.loadDemo().then(function (c) {
      eq(c.firmware.length, 3); eq(c.problems.length, 0);
      return Promise.all(c.firmware.map(function (f) {
        return c.fetch(f).then(function (b) {
          ok(I.check(b, c.boards[f.board]).ok, f.id + ' passes the checks');
          return I.sha256(b).then(function (h) { eq(h, f.sha256, f.id + ' hash'); });
        });
      }));
    });
  });
  test('the demo board flashes on the simulated device it uses', function () {
    return FL.catalog.loadDemo().then(function (c) {
      var f = c.firmware[0], b = c.boards[f.board], dev = F.device({ flashSize: 128 * 1024 }), s = session(dev, { fallbackLayout: b.layout });
      return c.fetch(f).then(function (bytes) { return s.open().then(function () { return s.flash(b.flash.base, bytes); }); })
        .then(function (r) { eq(r.verified, true); });
    });
  });

  // ── Run ──
  var out = document.getElementById('out'), failed = 0;
  tests.reduce(function (p, t) {
    return p.then(function () {
      return Promise.resolve().then(t.fn).then(function () {
        out.insertAdjacentHTML('beforeend', '<div class="pass">✓ ' + t.name + '</div>');
      }, function (e) {
        failed++;
        out.insertAdjacentHTML('beforeend', '<div class="fail">✕ ' + t.name + '</div><pre>' + String(e && (e.stack || e.message) || e).replace(/</g, '&lt;') + '</pre>');
      });
    });
  }, Promise.resolve()).then(function () {
    out.insertAdjacentHTML('afterbegin', '<p><b>' + (tests.length - failed) + ' of ' + tests.length + ' passed</b></p>');
    document.title = failed ? 'FAIL' : 'PASS';
  }).catch(function (e) { document.title = 'ERROR'; out.textContent = String(e); });
})();
