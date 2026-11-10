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

  test('cleanBoard: runAlso adds firmware ids the board may be running; run stays the first', function () {
    var b = I.cleanBoard('two', {
      flash: { base: 0, size: 1 }, ram: { base: 0, size: 1 }, dfu: { vid: 1, pid: 2 },
      run: { vid: '0x0483', pid: '0x5740', name: 'Sketch' },
      runAlso: [{ vid: '0x1234', pid: '0x0007', name: 'App' }, { vid: 'bad' }, 'junk']
    }, []);
    eq(b.run.pid, 0x5740); eq(b.runs.length, 2); eq(b.runs[1].vid, 0x1234); eq(b.touchBaud, 1200);
    var none = I.cleanBoard('none', { flash: { base: 0, size: 1 }, ram: { base: 0, size: 1 }, dfu: { vid: 1, pid: 2 }, runAlso: [{ vid: 1, pid: 3 }] }, []);
    eq(none.run, null, 'runAlso without run: no touch'); eq(none.runs.length, 0);
  });

  test('serial: matches, filters, and names cover every id', function () {
    var S = FL.serial, runs = [{ vid: 1, pid: 2, name: 'Sketch' }, { vid: 3, pid: 4, name: 'App' }, { vid: 5, pid: 6, name: 'App' }];
    ok(S.matches({ usbVendorId: 3, usbProductId: 4 }, runs), 'second id');
    ok(S.matches({ usbVendorId: 1, usbProductId: 2 }, runs[0]), 'one id, as before');
    ok(!S.matches({ usbVendorId: 1, usbProductId: 4 }, runs), 'vid and pid must pair');
    ok(!S.matches(null, runs)); ok(!S.matches({ usbVendorId: 1, usbProductId: 2 }, null));
    eq(JSON.stringify(S.filters(runs.slice(0, 2))), '[{"usbVendorId":1,"usbProductId":2},{"usbVendorId":3,"usbProductId":4}]');
    eq(S.portNames(runs, 'x'), 'Sketch or App', 'names once each'); eq(S.portNames([], 'the board'), 'the board');
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

  // ── The console terminal ──
  var T = FL.term;
  test('terminal: lines, carriage return, backspace, and erase to end of line', function () {
    var s = new T.Screen();
    s.write('hello\r\nworld\rW');
    eq(s.text(), 'hello\nWorld');
    s.write('\x1b[K');
    eq(s.text(), 'hello\nW', 'ESC[K cuts after the cursor');
    s.write('ab\bX');
    eq(s.text(), 'hello\nWaX');
  });
  test('terminal: cursor left and right, and a redrawn line', function () {
    var s = new T.Screen();
    s.write('gen> status\x1b[3D');           // cursor on the "t" of "tus"
    eq(s.col, 8);
    s.write('\rgen> pwm on\x1b[K\x1b[2D');   // a history recall redraws the line
    eq(s.text(), 'gen> pwm on'); eq(s.col, 9);
    s.write('\x1b[C'); eq(s.col, 10);
  });
  test('terminal: ESC[2J ESC[H clears, and other sequences are dropped, not drawn', function () {
    var s = new T.Screen();
    s.write('one\r\ntwo\r\n\x1b[2J\x1b[Hthree\x1b[1;32m!\x1b[0m\x1b[?25l\x1b]0;title\x07');
    eq(s.text(), 'three!');
  });
  test('terminal: tabs, long scrollback trimmed', function () {
    var s = new T.Screen({ max: 50 });
    s.write('a\tb\r\n');
    eq(s.text().split('\n')[0], 'a       b');
    for (var i = 0; i < 200; i++) s.write('line ' + i + '\r\n');
    ok(s.lines.length <= 50, 'kept ' + s.lines.length); ok(/line 199/.test(s.text()), 'newest kept');
  });
  test('terminal: html escapes and draws the cursor', function () {
    var s = new T.Screen();
    s.write('<b>&');
    eq(s.html(false), '&lt;b&gt;&amp;');
    ok(/<span class="fl-cur"> <\/span>$/.test(s.html(true)), 'cursor after the text');
  });
  test('keyBytes: what a terminal sends', function () {
    var k = function (key, mods) { return T.keyBytes(Object.assign({ key: key }, mods || {}), false); };
    eq(k('Enter'), '\r'); eq(k('Backspace'), '\x7f'); eq(k('Tab'), '\t'); eq(k('ArrowUp'), '\x1b[A'); eq(k('ArrowDown'), '\x1b[B');
    eq(k('ArrowLeft'), '\x1b[D'); eq(k('Home'), '\x1b[H'); eq(k('Delete'), '\x1b[3~'); eq(k('x'), 'x'); eq(k('Shift'), null);
    eq(k('c', { ctrlKey: true }), '\x03'); eq(k('l', { ctrlKey: true }), '\x0c'); eq(k('v', { ctrlKey: true }), null, 'paste is the browser’s');
    eq(T.keyBytes({ key: 'c', ctrlKey: true }, true), null, 'Ctrl-C copies a selection');
    eq(k('r', { metaKey: true }), null);
  });
  test('console: typing, history with Up, Tab completion, and clear, through the terminal', function () {
    var s = new T.Screen(), sh = F.shell({ name: 'gen', banner: 'Banner', onData: function (t) { s.write(t); }, commands: { status: function () { return 'OK idle'; } } });
    sh.start();
    sh.input('stat\t');                       // Tab completes "status "
    eq(s.text().split('\n').pop(), 'gen> status');
    sh.input('\r');
    ok(/OK idle\ngen>$/.test(s.text()), 'ran it: ' + JSON.stringify(s.text()));
    sh.input('hel'); sh.input('\x7f\x7f\x7f');
    eq(s.text().split('\n').pop(), 'gen>', 'backspace erased');
    sh.input('\x1b[A');                       // Up: the last command comes back
    eq(s.text().split('\n').pop(), 'gen> status');
    sh.input('\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[DX');   // edit mid-line
    eq(s.text().split('\n').pop(), 'gen> Xstatus');
    sh.input('\x1b[F\x15clear\r');            // End, Ctrl-U (erases to the left), then clear
    eq(s.text(), 'OK\ngen>');
  });

  // ── The catalog ──
  // ── Access: flasher_data for FTEs, review-flasher-* per shared project (tests/fakegithub.js) ──
  var AC = FL.access, OWNER = FL.config.owner, M = Signoff.model;
  var BOARD_RAW = { name: 'T', flash: { base: '0x08000000', size: '0x80000' }, ram: { base: '0x20000000', size: '0x1C000' }, dfu: { vid: 1155, pid: 57105 } };
  function boardIn(project, name) { return Object.assign({}, BOARD_RAW, { name: name, project: project }); }
  // A data repo with two projects (alpha: board a1; beta: boards b1 and b2), one image per board.
  function world(extraTokens) {
    var gh = FakeGitHub({ owner: OWNER, tokens: Object.assign({ chris: OWNER, fte2: 'pat', bob: 'bob', eve: 'eve' }, extraTokens || {}) });
    var imgs = { a1: image(4096, 1), b1: image(4096, 2), b2: image(6144, 3) };
    return Promise.all(Object.keys(imgs).map(function (k) { return I.sha256(imgs[k]); })).then(function (h) {
      var m = { format: 1, updated: '2026-11-10T12:00:00Z', projects: { alpha: { name: 'Alpha' }, beta: { name: 'Beta Box' } },
        boards: { a1: boardIn('alpha', 'Alpha main'), b1: boardIn('beta', 'Beta main'), b2: boardIn('beta', 'Beta display') }, firmware: [] };
      Object.keys(imgs).forEach(function (k, i) { m.firmware.push({ id: 'fw-' + k, board: k, name: 'FW ' + k, path: 'firmware/' + k + '/fw-' + k + '.bin', sha256: h[i], size: imgs[k].length }); });
      var files = { 'README.md': '# data', 'manifest.json': AC.dump(m) };
      Object.keys(imgs).forEach(function (k) { files['firmware/' + k + '/fw-' + k + '.bin'] = imgs[k]; });
      var roster = M.emptyRoster();
      roster.users.pat = M.stamp({ login: 'pat', name: 'Pat', role: 'fte', projects: [] }, OWNER);
      files['users.json'] = AC.dump(roster);
      return gh.repo(FL.config.repo, files, { collaborators: ['pat'] }).then(function () { return { gh: gh, imgs: imgs, manifest: m }; });
    });
  }
  function as(w, token) { return { token: token, fetch: w.gh.fetch, login: token === 'chris' ? OWNER : token }; }

  test('access: projects and split', function () {
    var m = { format: 1, projects: { p: { name: 'P' } }, boards: { x: { name: 'X', project: 'p' }, y: { name: 'Y' } }, firmware: [{ id: 'f', board: 'x' }, { id: 'g', board: 'y' }] };
    var names = AC.projectsIn(m);
    eq(names.p, 'P'); eq(names.y, 'Y', 'a board with no project is its own');
    var s = AC.split(m, 'p');
    eq(Object.keys(s.move.boards).join(), 'x'); eq(s.move.firmware.length, 1); eq(s.move.projects.p.name, 'P');
    eq(Object.keys(s.keep.boards).join(), 'y'); eq(s.keep.firmware.length, 1); ok(!s.keep.projects.p, 'project name moves');
    eq(Object.keys(m.boards).length, 2, 'input untouched');
    ok(/^\{\n  "format": 1,\n/.test(AC.dump(m)) && /\n$/.test(AC.dump(m)), 'publish.py’s layout');
  });
  test('access: an FTE sees flasher_data, and a wrong token is refused', function () {
    return world().then(function (w) {
      return FL.catalog.loadRepo('fte2', w.gh.fetch).then(function (c) {
        ok(c.fte, 'FTE'); eq(c.login, 'pat'); eq(c.firmware.length, 3); eq(Object.keys(c.projects).sort().join(), 'alpha,beta');
        eq(c.projects.beta.name, 'Beta Box'); eq(c.boards.b1.project, 'beta');
        return c.fetch(c.firmware[0]).then(function (b) { eq(b.length, 4096); });
      }).then(function () { return rejects(FL.catalog.loadRepo('nobody', w.gh.fetch), /refused the saved token/); });
    });
  });
  test('access: a changed file in the repo isn’t flashed', function () {
    return world().then(function (w) {
      var m = JSON.parse(w.gh.text(FL.config.repo, 'manifest.json'));
      m.firmware[0].sha256 = 'f'.repeat(64);
      return w.gh.repo(FL.config.repo, Object.assign(w.gh.files(FL.config.repo), { 'manifest.json': AC.dump(m) }), { collaborators: ['pat'] }).then(function () {
        return FL.catalog.loadRepo('fte2', w.gh.fetch);
      }).then(function (c) { return rejects(c.fetch(c.firmware[0]), /doesn’t match/); });
    });
  });
  test('access: someone with nothing shared, or only an invitation', function () {
    return world().then(function (w) {
      return rejects(FL.catalog.loadRepo('bob', w.gh.fetch), /No firmware is shared with you/).then(function () {
        w.gh.repos[FL.config.repo].invitations.push({ id: 7, login: 'bob' });   // a new FTE, invited to flasher_data
        return rejects(FL.catalog.loadRepo('bob', w.gh.fetch), /invited/).then(function (e) {
          return new Signoff.GitHubAccount('bob', w.gh.fetch).acceptInvitation(e.invites[0].id);
        }).then(function () { return FL.catalog.loadRepo('bob', w.gh.fetch); }).then(function (c) { ok(c.fte, 'accepted: an FTE'); eq(c.firmware.length, 3); });
      });
    });
  });
  test('access: sharing a project moves it into its own repo; the contractor sees only it', function () {
    var w, roster;
    return world().then(function (x) {
      w = x;
      return AC.load(as(w, 'chris'));
    }).then(function (loaded) {
      roster = loaded.roster;
      roster.users.bob = M.stamp({ login: 'bob', name: 'Bob', role: 'contractor', projects: ['beta'] }, OWNER);
      return AC.saveRoster(as(w, 'chris'), roster);
    }).then(function (merged) {
      var log = [];
      return AC.share(as(w, 'chris'), merged, 'beta', function (t) { log.push(t); }).then(function (res) {
        eq(res.repo, OWNER + '/review-flasher-beta-box'); eq(res.failed.length, 0);
        var dst = w.gh.files('review-flasher-beta-box'), src = w.gh.files(FL.config.repo);
        ok(dst['firmware/b1/fw-b1.bin'] && dst['firmware/b2/fw-b2.bin'], 'images copied');
        ok(!src['firmware/b1/fw-b1.bin'] && src['firmware/a1/fw-a1.bin'], 'moved ones removed, the rest kept');
        var moved = JSON.parse(w.gh.text('review-flasher-beta-box', 'manifest.json')), kept = JSON.parse(w.gh.text(FL.config.repo, 'manifest.json'));
        eq(Object.keys(moved.boards).sort().join(), 'b1,b2'); eq(Object.keys(kept.boards).join(), 'a1');
        eq(JSON.parse(w.gh.text(FL.config.repo, 'users.json')).shared.beta.repo, res.repo, 'recorded');
        eq(w.gh.repos['review-flasher-beta-box'].actions, false, 'Actions off');
        ok(w.gh.repos['review-flasher-beta-box'].invitations.some(function (i) { return i.login === 'pat'; }), 'the other FTE invited');
        return AC.invite(as(w, 'chris'), res.repo, ['bob']);
      });
    }).then(function () {
      // Bob sees the invitation, accepts it, and then sees Beta only.
      return rejects(FL.catalog.loadRepo('bob', w.gh.fetch), /invited/).then(function (e) {
        eq(e.invites.length, 1);
        return new Signoff.GitHubAccount('bob', w.gh.fetch).acceptInvitation(e.invites[0].id);
      });
    }).then(function () { return FL.catalog.loadRepo('bob', w.gh.fetch); }).then(function (c) {
      ok(!c.fte, 'not an FTE'); eq(c.firmware.map(function (f) { return f.id; }).sort().join(), 'fw-b1,fw-b2');
      return c.fetch(c.firmware[0]);
    }).then(function (b) {
      ok(b.length > 0, 'bob can read the image');
      // The other FTE has an invitation to the new repo: offered, not an error. Accepted, all three show.
      return FL.catalog.loadRepo('fte2', w.gh.fetch);
    }).then(function (c) {
      eq(c.firmware.length, 1); eq(c.invites.length, 1); eq(c.problems.length, 0, 'no error for a repo waiting on its invitation');
      return new Signoff.GitHubAccount('fte2', w.gh.fetch).acceptInvitation(c.invites[0].id);
    }).then(function () { return FL.catalog.loadRepo('fte2', w.gh.fetch); }).then(function (c) {
      eq(c.firmware.length, 3); eq(c.invites.length, 0);
      eq(c.firmware.filter(function (f) { return f.repo === OWNER + '/review-flasher-beta-box'; }).length, 2);
      return Promise.all(c.firmware.map(function (f) { return c.fetch(f); }));
    }).then(function () {
      // Taking Beta away from Bob.
      return AC.revoke(as(w, 'chris'), OWNER + '/review-flasher-beta-box', ['bob']);
    }).then(function () { return rejects(FL.catalog.loadRepo('bob', w.gh.fetch), /No firmware is shared/); });
  });
  test('access: a share that stopped part way is picked up again', function () {
    var w;
    return world().then(function (x) {
      w = x;
      return w.gh.repo('review-flasher-beta-box', { 'README.md': '# empty' });   // made, then the share stopped
    }).then(function () { return AC.load(as(w, 'chris')); }).then(function (l) {
      return AC.share(as(w, 'chris'), l.roster, 'beta');
    }).then(function (res) {
      eq(res.repo, OWNER + '/review-flasher-beta-box', 'adopted, not -2');
      return w.gh.repo('review-flasher-alpha', { 'notes.txt': 'someone else’s' });
    }).then(function () { return AC.load(as(w, 'chris')); }).then(function (l) {
      return AC.share(as(w, 'chris'), l.roster, 'alpha');
    }).then(function (res) { eq(res.repo, OWNER + '/review-flasher-alpha-2', 'a repo holding other things is left alone'); });
  });
  test('access: who has what', function () {
    return world().then(function (w) {
      w.gh.repos[FL.config.repo].invitations.push({ id: 9, login: 'eve' });
      return AC.accessMap(as(w, 'chris'), [AC.dataFull()]).then(function (m) {
        eq(m[AC.dataFull()].pat, 'yes'); eq(m[AC.dataFull()].eve, 'invited'); eq(m[AC.dataFull()].bob, undefined);
      });
    });
  });
  test('the demo catalog: valid images that match their hashes', function () {
    return FL.catalog.loadDemo().then(function (c) {
      eq(c.firmware.length, 4); eq(c.problems.length, 0);
      return Promise.all(c.firmware.map(function (f) {
        return c.fetch(f).then(function (b) {
          if (f.kind !== 'units') ok(I.check(b, c.boards[f.board]).ok, f.id + ' passes the checks');
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

  // ── Bridge boards: the serial bootloader through a passthrough (assets/sboot.js) ──
  var B = FL.sboot, FB = FL.fakebridge;
  function bytesOf(s) { return new Uint8Array(Array.prototype.map.call(s, function (ch) { return ch.charCodeAt(0); })); }
  // A made-up image: two internal sectors and five 64 KB external blocks, filled with 0xFF past the data.
  function bridgeImage(seed, older) {
    var r = (function (s) { return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s & 0xFF; }; })(seed || 9);
    var units = [[0x08010000, 0x8000, 0x6000], [0x08018000, 0x10000, 0x2100]], at = 0x70000000;
    for (var k = 0; k < 5; k++) units.push([at + k * 0x10000, 0x10000, k === 4 ? 0x1234 : 0x10000]);
    var list = units.map(function (u) { var b = new Uint8Array(u[1]).fill(0xFF); for (var i = 0; i < u[2]; i++) b[i] = r(); return { addr: u[0], size: u[1], bytes: b }; });
    if (older) [0, 4].forEach(function (i) { list[i].bytes[100] ^= 0xFF; });
    return list;
  }
  function bridgePlan(list) {
    var parts = FL.catalog.partsOf(list), units = [], files = {}, app = 0, appLen = 0;
    parts.forEach(function (p) {
      p.path = 'firmware/t/x/' + p.addr.toString(16).padStart(8, '0') + '.bin'; files[p.path] = p.bytes;
      p.units.forEach(function (u) {
        units.push({ addr: u.addr, size: u.size, crc: B.crc32(u.bytes), part: p });
        if (u.addr < 0x70000000) { app = B.crc32(u.bytes, app); appLen += u.size; }
      });
    });
    return { image: { units: units, parts: parts, commit: { crc: app, length: appLen } }, files: files };
  }
  function bridgeSim(list) {
    var sim = FB.display({ units: list, appBase: 0x08010000, qspiBase: 0x70000000, device: 0x4A5, bootMs: 5 });
    list.forEach(function (u) { sim.load(u.addr, u.bytes); });
    return sim;
  }
  var EXPECT = { device: 0x4A5, appBase: 0x08010000, qspiBase: 0x70000000, singleBank: true };

  test('crc32: zlib’s check value, and continuing over pieces', function () {
    eq(B.crc32(bytesOf('123456789')), 0xCBF43926);
    eq(B.crc32(bytesOf('6789'), B.crc32(bytesOf('12345'))), 0xCBF43926);
    eq(B.crc32(new Uint8Array(0)), 0);
  });

  test('frames: round trip, damaged and split frames, and bytes kept for the next one', function () {
    var a = B.frame(0x85, 7, [0, 1, 2, 3], B.RSP), c = B.frame(0x81, 8, [0], B.RSP), rx = new B.Rx();
    var bad = a.slice(); bad[7] ^= 1;
    rx.push(new Uint8Array([0x00, 0x5A]));     // noise, and a lone sync byte
    rx.push(bad); rx.push(a.subarray(0, 5));
    eq(rx.take(), null, 'damaged frame skipped, the next one incomplete');
    var both = new Uint8Array(a.length - 5 + c.length); both.set(a.subarray(5), 0); both.set(c, a.length - 5);
    rx.push(both);
    var f = rx.take(); eq(f.cmd, 0x85); eq(f.seq, 7); eq(Array.from(f.payload).join(), '0,1,2,3');
    eq(rx.take().seq, 8, 'the frame after it was kept'); eq(rx.take(), null);
  });

  test('update: compare only changes nothing; then only the differing blocks are written', async function () {
    var now = bridgeImage(9), plan = bridgePlan(now), sim = bridgeSim(bridgeImage(9, true)), port = FB.port(sim);
    var link = new B.Link(port), fetched = [];
    var opts = { expect: EXPECT, fetchPart: function (p) { fetched.push(p.path); return Promise.resolve(plan.files[p.path]); } };
    await link.open(1000000);
    var cmp = await B.update(link, plan.image, Object.assign({ compareOnly: true }, opts));
    eq(cmp.changed.length, 2); eq(cmp.changed[0].addr, 0x08010000); eq(cmp.changed[1].addr, 0x70020000);
    eq(sim.counts[B.CMD.ERASE] || 0, 0, 'compare erases nothing'); eq(fetched.length, 0, 'and downloads nothing');
    var res = await B.update(link, plan.image, opts);
    eq(res.changed.length, 2); eq(res.written, 0x8000 + 0x10000);
    eq(sim.counts[B.CMD.ERASE], 2); eq(sim.record, B.RECORD.COMPLETE); ok(sim.running, 'started');
    eq(fetched.join(), 'firmware/t/x/08010000.bin,firmware/t/x/70000000.bin', 'only the parts holding a changed block');
    now.forEach(function (u) { eq(B.crc32(sim.read(u.addr, u.size)), B.crc32(u.bytes), 'block ' + B.hex(u.addr)); });
    await link.close();
  });

  test('update: up to date writes nothing; an unfinished update is finished even so', async function () {
    var now = bridgeImage(4), plan = bridgePlan(now), sim = bridgeSim(now), link = new B.Link(FB.port(sim));
    await link.open(1000000);
    var res = await B.update(link, plan.image, { expect: EXPECT, fetchPart: function () { throw new Error('no download'); } });
    ok(res.upToDate); eq(sim.counts[B.CMD.BEGIN] || 0, 0);
    sim.record = B.RECORD.INCOMPLETE; sim.running = false;
    res = await B.update(link, plan.image, { expect: EXPECT, fetchPart: function () { throw new Error('no download'); } });
    ok(!res.upToDate); eq(sim.counts[B.CMD.BEGIN], 1); eq(sim.counts[B.CMD.COMMIT], 1); eq(sim.record, B.RECORD.COMPLETE);
    await link.close();
  });

  test('update: a faster link after SET_BAUD, and lost answers retried', async function () {
    var now = bridgeImage(5), plan = bridgePlan(now), sim = bridgeSim(bridgeImage(5, true)), port = FB.port(sim), link = new B.Link(port), notes = [];
    sim.dropEvery = 9;
    await link.open(1000000);
    var res = await B.update(link, plan.image, { expect: EXPECT, fastBaud: 4000000, log: function (t) { notes.push(t); }, fetchPart: function (p) { return Promise.resolve(plan.files[p.path]); } });
    eq(sim.baud, 4000000); eq(link.baud, 4000000); eq(port.opened.length, 2, 'reopened at the new rate');
    eq(res.changed.length, 2); eq(sim.record, B.RECORD.COMPLETE);
    ok(notes.some(function (t) { return /No answer/.test(t); }), 'a retry was logged');
    await link.close();
  });

  test('update: the wrong board is refused before anything is written', async function () {
    var plan = bridgePlan(bridgeImage(6)), sim = bridgeSim(bridgeImage(6, true)), link = new B.Link(FB.port(sim));
    sim.device = 0x449;
    await link.open(1000000);
    await rejects(B.update(link, plan.image, { expect: EXPECT, fetchPart: function () {} }), /isn’t the board.*0x449.*wrong/, 'wrong chip');
    eq(sim.counts[B.CMD.BEGIN] || 0, 0);
    await link.close();
  });

  test('update: a download that doesn’t match its CRC stops before BEGIN', async function () {
    var plan = bridgePlan(bridgeImage(7)), sim = bridgeSim(bridgeImage(7, true)), link = new B.Link(FB.port(sim));
    await link.open(1000000);
    await rejects(B.update(link, plan.image, { expect: EXPECT, fetchPart: function (p) { var b = plan.files[p.path].slice(); b[200] ^= 1; return Promise.resolve(b); } }), /mismatch/);
    eq(sim.counts[B.CMD.BEGIN] || 0, 0);
    await link.close();
  });

  test('the exit rate leaves the passthrough', async function () {
    var sim = bridgeSim(bridgeImage(8)), exited = 0, port = FB.port(sim, { onExit: function () { exited++; } });
    await port.open({ baudRate: 1200 }); await port.close();
    eq(exited, 1); eq(sim.exits, 1);
  });

  test('manifest: bridge boards and units firmware', function () {
    var plan = bridgePlan(bridgeImage(3)), sha = 'a'.repeat(64);
    var parts = plan.image.parts.map(function (p) {
      return { path: 'firmware/disp/app/' + p.addr.toString(16).padStart(8, '0') + '.bin', addr: p.addr, size: p.size, sha256: sha,
        units: p.units.map(function (u) { return [u.addr, u.size, B.crc32(u.bytes)]; }) };
    });
    var total = parts.reduce(function (n, p) { return n + p.size; }, 0);
    function man(f, board) {
      return { format: 1, boards: {
        disp: Object.assign({ kind: 'bridge', name: 'Display', touch: [{ vid: 1, pid: 2, name: 'Host' }], bridge: { vid: 1, pid: 3 }, expect: { device: '0x4A5', appBase: '0x08010000' } }, board || {}),
        dfu1: { flash: { base: 0, size: 1 }, ram: { base: 0, size: 1 }, dfu: { vid: 1, pid: 2 } }
      }, firmware: [Object.assign({ id: 'app', board: 'disp', kind: 'units', path: 'firmware/disp/app/', parts: parts, size: total, sha256: sha, commit: { crc32: plan.image.commit.crc, length: plan.image.commit.length } }, f || {})] };
    }
    var c = I.cleanManifest(man());
    eq(c.problems.length, 0, c.problems.join('; '));
    var b = c.boards.disp, f = c.firmware[0];
    eq(b.kind, 'bridge'); eq(b.touchBaud, 2400); eq(b.exitBaud, 1200); eq(b.linkBaud, 1000000); eq(b.runs.length, 1); eq(b.expect.device, 0x4A5);
    eq(f.units.length, 7); eq(f.parts.length, 2); eq(f.units[2].part, f.parts[1]); eq(f.commit.length, 0x18000);
    function problem(fw, board) { var x = I.cleanManifest(man(fw, board)); return x.firmware.length ? '' : x.problems.join(' '); }
    ok(/path must be/.test(problem({ path: 'firmware/disp/app.bin' })));
    ok(/size must be/.test(problem({ size: total - 1 })));
    ok(/commit needs/.test(problem({ commit: {} })));
    var gap = JSON.parse(JSON.stringify(parts)); gap[0].units[1][0] += 0x1000;
    ok(/back to back/.test(problem({ parts: gap })));
    var odd = JSON.parse(JSON.stringify(parts)); odd[1].path = 'firmware/disp/app/qspi.bin';
    ok(/8 hex digits/.test(problem({ parts: odd })));
    ok(/must be kind/.test(problem({ kind: undefined })));
    ok(/needs a bridge board/.test(I.cleanManifest({ format: 1, boards: man().boards, firmware: [Object.assign({}, man().firmware[0], { board: 'dfu1', path: 'firmware/dfu1/app/' })] }).problems.join(' ')));
    var nob = I.cleanManifest(man(null, { bridge: null }));
    ok(!nob.boards.disp && /needs bridge/.test(nob.problems.join(' ')), 'a bridge board needs its port');
  });

  test('the demo’s display board updates through the simulated passthrough', async function () {
    var c = await FL.catalog.loadDemo(), f = c.firmware.filter(function (x) { return x.kind === 'units'; })[0], b = c.boards[f.board];
    eq(c.problems.length, 0, c.problems.join('; '));
    var sim = c.demoDisplay(f.id); sim.latency = 0; sim.eraseMs = 0; sim.bootMs = 0;
    var link = new B.Link(FB.port(sim));
    await link.open(b.linkBaud);
    var res = await B.update(link, { units: f.units, parts: f.parts, commit: f.commit }, { expect: b.expect, fastBaud: b.fastBaud, fetchPart: function (p) { return c.fetch(p); } });
    eq(res.changed.length, 4, 'two code blocks and two picture blocks differ');
    f.units.forEach(function (u) { eq(B.crc32(sim.read(u.addr, u.size)), u.crc); });
    await link.close();
  });

  test('access: sharing a project copies and removes every part of a bridge board’s image', async function () {
    var w = await world(), plan = bridgePlan(bridgeImage(12)), m = JSON.parse(w.gh.text(FL.config.repo, 'manifest.json'));
    var files = w.gh.files(FL.config.repo), dir = 'firmware/b3/disp/', parts = [];
    for (var i = 0; i < plan.image.parts.length; i++) {
      var p = plan.image.parts[i], path = dir + p.addr.toString(16).padStart(8, '0') + '.bin';
      files[path] = p.bytes;
      parts.push({ path: path, addr: p.addr, size: p.size, sha256: await I.sha256(p.bytes), units: p.units.map(function (u) { return [u.addr, u.size, B.crc32(u.bytes)]; }) });
    }
    m.boards.b3 = { kind: 'bridge', name: 'Beta panel', project: 'beta', touch: [{ vid: 1, pid: 2 }], bridge: { vid: 1, pid: 3 } };
    m.firmware.push({ id: 'disp', board: 'b3', name: 'Panel', kind: 'units', path: dir, parts: parts, size: parts.reduce(function (n, x) { return n + x.size; }, 0),
      sha256: 'b'.repeat(64), commit: { crc32: plan.image.commit.crc, length: plan.image.commit.length } });
    files['manifest.json'] = AC.dump(m);
    await w.gh.repo(FL.config.repo, files, { collaborators: ['pat'] });
    eq(AC.filesOf(m.firmware[3]).length, 2); eq(AC.filesOf(m.firmware[0]).length, 1);
    var loaded = await AC.load(as(w, 'chris'));
    var res = await AC.share(as(w, 'chris'), loaded.roster, 'beta');
    var dst = w.gh.files('review-flasher-beta-box'), src = w.gh.files(FL.config.repo);
    parts.forEach(function (x) { ok(dst[x.path], x.path + ' copied'); ok(!src[x.path], x.path + ' removed from the data repo'); });
    var c = await FL.catalog.loadRepo('chris', w.gh.fetch), f = c.firmware.filter(function (x) { return x.kind === 'units'; })[0];
    eq(f.repo, res.repo, 'listed from the shared repo');
    var got = await c.fetch({ repo: f.repo, path: f.parts[1].path, sha256: f.parts[1].sha256 });
    eq(got.length, f.parts[1].size, 'a part reads back from there');
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
