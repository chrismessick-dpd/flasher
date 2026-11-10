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
