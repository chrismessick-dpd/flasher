/* Probe page tests: the real stlink.js, jlink.js, target.js, stm32.js, files.js, and svd.js against the
   simulated probes (assets/probe/fakeprobe.js, tests/fakejlink.js), which keep the flash controller's
   rules. The page title ends PASS, FAIL, or ERROR. */
(function () {
  'use strict';
  var FL = window.FL, F = FL.files, X = FL.stm32, T = FL.target;
  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }
  function eq(a, b, what) { if (a !== b) throw new Error((what || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
  function ok(v, what) { if (!v) throw new Error(what || 'expected true'); }
  async function rejects(p, re, what) {
    try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error((what || 'error') + ': unexpected “' + e.message + '”'); return e; }
    throw new Error((what || 'promise') + ' should have failed');
  }
  var noSleep = function () { return Promise.resolve(); };
  FL.svd.base = '../assets/probe/svd/';
  function pattern(n, seed) { var b = new Uint8Array(n); for (var i = 0; i < n; i++) b[i] = (i * 31 + (seed || 7) + (i >> 8)) & 255; return b; }

  async function stlinkTarget(kind, o) {
    var dev = new FL.fakeprobe.FakeStLink(kind, o), p = new FL.stlink.StLink(dev, { sleep: noSleep });
    await p.open();
    var t = new T.Target(p, { sleep: noSleep });
    var chip = await t.connect({ underReset: !(o && o.hot), khz: 4000 });
    return { dev: dev, chip: chip, t: t, p: p, sim: dev.chip };
  }
  async function jlinkTarget(kind, o) {
    var dev = new FL.fakejlink.FakeJLink(kind, o), p = new FL.jlink.JLink(dev, { sleep: noSleep });
    await p.open();
    var t = new T.Target(p, { sleep: noSleep });
    var chip = await t.connect({ underReset: true, khz: 4000 });
    return { dev: dev, chip: chip, t: t, p: p, sim: dev.chip };
  }

  // ── Files ──
  test('Intel HEX: extended addresses, records, and round trip', function () {
    var a = pattern(300, 1), b = pattern(20, 2);
    var text = F.toHex([{ addr: 0x0800FFF0, data: a }, { addr: 0x20000000, data: b }]);
    ok(/^:02000004080087/m.test(text) || /:020000040800F2/m.test(text), 'has an extended linear address record');
    var img = F.parse('x.hex', new TextEncoder().encode(text));
    eq(img.format, 'Intel HEX'); eq(img.segments.length, 2);
    eq(img.segments[0].addr, 0x0800FFF0); eq(img.segments[0].data.length, 300); eq(img.segments[1].addr, 0x20000000);
    ok(img.segments[0].data.every(function (x, i) { return x === a[i]; }), 'bytes kept across the 64 KB boundary');
  });
  test('Intel HEX: a bad checksum is refused', function () {
    var bad = ':0400000001020304F1\n:00000001FF\n';
    try { F.parse('b.hex', new TextEncoder().encode(bad)); } catch (e) { ok(/checksum/.test(e.message)); return; }
    throw new Error('should have failed');
  });
  test('S-record: S3 data and S7 entry', function () {
    function rec(type, addrBytes, data) {
      var body = [addrBytes.length + data.length + 1].concat(addrBytes, data), sum = 255 - (body.reduce(function (s, x) { return s + x; }, 0) & 255);
      return 'S' + type + body.concat([sum]).map(function (x) { return x.toString(16).toUpperCase().padStart(2, '0'); }).join('');
    }
    var text = ['S00600004844521B', rec(3, [8, 0, 0, 0], [1, 2, 3, 4]), rec(3, [8, 0, 0, 4], [5, 6]), rec(7, [8, 0, 0, 0xC1], [])].join('\n');
    var img = F.parse('a.s37', new TextEncoder().encode(text));
    eq(img.format, 'S-record'); eq(img.segments.length, 1); eq(img.segments[0].data.length, 6); eq(img.entry, 0x080000C1);
  });
  test('ELF: PT_LOAD segments at their physical addresses', function () {
    // A minimal ELF32 with two program headers: .text at 0x08000000 and .data loaded at 0x08000100 (runs at 0x20000000).
    var b = new Uint8Array(0x200), dv = new DataView(b.buffer);
    b.set([0x7F, 0x45, 0x4C, 0x46, 1, 1, 1]);
    dv.setUint32(24, 0x080000C1, true); dv.setUint32(28, 52, true); dv.setUint16(42, 32, true); dv.setUint16(44, 3, true);
    function ph(i, type, off, vaddr, paddr, filesz) { var o = 52 + 32 * i; dv.setUint32(o, type, true); dv.setUint32(o + 4, off, true); dv.setUint32(o + 8, vaddr, true); dv.setUint32(o + 12, paddr, true); dv.setUint32(o + 16, filesz, true); }
    ph(0, 1, 0x100, 0x08000000, 0x08000000, 0x40); ph(1, 1, 0x140, 0x20000000, 0x08000040, 0x10); ph(2, 1, 0x150, 0x20000010, 0x20000010, 0);
    for (var i = 0x100; i < 0x150; i++) b[i] = i & 255;
    var img = F.parse('fw.elf', b);
    eq(img.format, 'ELF'); eq(img.segments.length, 1, 'the two load images touch and merge'); eq(img.segments[0].addr, 0x08000000); eq(img.segments[0].data.length, 0x50); eq(img.entry, 0x080000C1);
  });
  test('Binary: placed at the base address given', function () {
    var img = F.parse('a.bin', pattern(10), 0x08004000);
    ok(img.needsBase); eq(img.segments[0].addr, 0x08004000);
  });

  // ── ST-LINK framing ──
  test('ST-LINK: version, voltage, and speeds', async function () {
    var dev = new FL.fakeprobe.FakeStLink('g0'), p = new FL.stlink.StLink(dev, { sleep: noSleep });
    var info = await p.open();
    eq(info.firmware, 'V3J16M9'); eq(info.name, 'STLINK-V3'); ok(info.multiAp);
    eq(Math.round((await p.voltage()) * 100), 330);
    eq((await p.speeds())[0], 24000);
  });
  test('ST-LINK: memory reads at odd addresses and lengths', async function () {
    var x = await stlinkTarget('g0'); x.sim.ram.set(pattern(64, 3));
    var got = await x.t.read(0x20000003, 13);
    ok(got.every(function (b, i) { return b === x.sim.ram[3 + i]; }), 'bytes match');
    await x.t.write(0x20000005, new Uint8Array([0xAA, 0xBB, 0xCC]));
    eq(x.sim.ram[5], 0xAA); eq(x.sim.ram[7], 0xCC); eq(x.sim.ram[8], pattern(64, 3)[8], 'neighbors untouched');
  });
  test('ST-LINK: a 1 KB-crossing block is split at the boundary', async function () {
    var x = await stlinkTarget('g0'), before = x.dev.cmdLog.length;
    await x.t.read(0x20000300, 0x400);
    var reads = x.dev.cmdLog.slice(before).filter(function (c) { return c[0] === 0xF2 && c[1] === 0x07; });
    eq(reads.length, 2, 'two 32-bit reads');
  });

  // ── Target ──
  test('Connect under reset: G0B1 on AP0, halted, identified', async function () {
    var x = await stlinkTarget('g0');
    eq(x.chip.name, 'STM32G0B1/G0C1'); eq(x.chip.ap, 0); eq(x.chip.flashSize, 512 * 1024); ok(x.chip.dual); eq(x.chip.bankSize, 256 * 1024);
    ok((await x.t.status()).halted, 'halted at reset');
  });
  test('Connect under reset: H563 found on AP1', async function () {
    var x = await stlinkTarget('h5');
    eq(x.chip.name, 'STM32H562/H563/H573'); eq(x.chip.ap, 1); eq(x.chip.flashSize, 2048 * 1024); eq(x.chip.sectorSize, 8192);
    ok(/Open/.test(x.chip.protection), x.chip.protection);
  });
  test('Hot plug leaves the core running and untouched', async function () {
    var x = await stlinkTarget('g0', { hot: true });
    ok(!x.sim.halted, 'still running'); ok(!x.sim.debugen, 'debug not switched on');
  });
  test('Halt, run, and reset and halt', async function () {
    var x = await stlinkTarget('g0', { hot: true });
    await x.t.halt(); ok(x.sim.halted);
    await x.t.run(); ok(!x.sim.halted);
    var r0 = x.sim.resets; await x.t.resetHalt(); ok(x.sim.halted); eq(x.sim.resets, r0 + 1);
    await x.t.resetRun(); ok(!x.sim.halted); ok(!x.sim.debugen, 'debug off after reset and run');
  });

  test('Disconnect switches debug off after a halt and run; hot plug never switches it on', async function () {
    var x = await stlinkTarget('g0');
    await x.t.halt(); await x.t.run();
    ok(x.t.touched, 'this session switched debug on'); ok(x.sim.debugen, 'debug still on while running');
    await x.t.release(); ok(!x.sim.debugen, 'off after release');
    var h = await stlinkTarget('g0', { hot: true }); ok(!h.t.touched, 'hot plug untouched');
  });
  test('Under reset with NRST not wired: noticed, and the core is reset from the debugger', async function () {
    var dev = new FL.fakeprobe.FakeStLink('g0', { noNrst: true }), p = new FL.stlink.StLink(dev, { sleep: noSleep }), lines = [];
    await p.open();
    var t = new T.Target(p, { sleep: noSleep, log: function (l) { lines.push(l); } }), r0 = dev.chip.resets;
    await t.connect({ underReset: true });
    ok(lines.some(function (l) { return /no effect/.test(l); }), lines.join(' | '));
    ok(dev.chip.halted, 'halted'); eq(dev.chip.resets, r0 + 1, 'reset once, by AIRCR');
  });

  // ── Flash ──
  test('Sectors: G0B1 bank 2 pages are numbered within the bank', function () {
    var chip = { flashBase: 0x08000000, flashSize: 512 * 1024, dual: true, bankSize: 256 * 1024, sectorSize: 2048 };
    var s = X.sectorsFor(chip, 0x0803F800, 0x08040800);
    eq(s.length, 2); eq(s[0].bank, 1); eq(s[0].index, 127); eq(s[1].bank, 2); eq(s[1].index, 0);
  });
  test('G0B1: erase only what the image covers, program, verify', async function () {
    var x = await stlinkTarget('g0'), data = pattern(5000, 9);
    x.sim.flash.fill(0x11, 0, 0x4000);  // a "bootloader" below the image
    var list = X.sectorsFor(x.chip, 0x08004000, 0x08004000 + data.length);
    await X.eraseSectors(x.t, x.chip, list);
    await X.program(x.t, x.chip, 0x08004000, data);
    await X.verify(x.t, 0x08004000, data);
    eq(x.sim.flash[0x3FFF], 0x11, 'the bootloader is untouched');
    eq(x.sim.flash[0x4000 + 5000], 0xFF, 'padding to a double word is erased flash');
    ok(x.sim.locked, 'locked again');
  });
  test('G0B1: bank 2 erase and program', async function () {
    var x = await stlinkTarget('g0'), data = pattern(4096, 4), at = 0x08040000;
    x.sim.flash.fill(0, 0x40000, 0x41000);
    await X.eraseSectors(x.t, x.chip, X.sectorsFor(x.chip, at, at + data.length));
    ok(x.sim.log.indexOf('erase page 2:0') >= 0, x.sim.log.join());
    await X.program(x.t, x.chip, at, data); await X.verify(x.t, at, data);
  });
  test('G0B1: writing over unerased flash fails with the chip\'s error', async function () {
    var x = await stlinkTarget('g0');
    x.sim.flash.fill(0, 0, 16);
    await rejects(X.program(x.t, x.chip, 0x08000000, pattern(16)), /no longer erased|PROGERR/);
  });
  test('G0B1: the EMPTY latch is cleared after a first image at 0x08000000', async function () {
    var x = await stlinkTarget('g0', { empty: true }), data = pattern(64);
    ok(x.sim.acr & (1 << 16), 'set before');
    await X.program(x.t, x.chip, 0x08000000, data);
    var lines = []; await X.afterProgram(x.t, x.chip, function (l) { lines.push(l); });
    ok(!(x.sim.acr & (1 << 16)), 'cleared'); ok(/Cleared/.test(lines[0]));
  });
  test('G0B1: mass erase both banks', async function () {
    var x = await stlinkTarget('g0'); x.sim.flash.fill(0);
    await X.massErase(x.t, x.chip);
    ok(x.sim.flash.every(function (b) { return b === 0xFF; }));
  });
  test('G0B1: careful (one unit at a time) mode writes the same', async function () {
    var x = await stlinkTarget('g0'), data = pattern(200);
    await X.program(x.t, x.chip, 0x08001000, data, null, { slow: true }); await X.verify(x.t, 0x08001000, data);
  });
  test('ST-LINK WAIT partway through a block: the page is erased again and rewritten (G0B1)', async function () {
    var x = await stlinkTarget('g0', { waitEvery: 2 }), data = pattern(5000, 12), at = 0x08003000, lines = [];
    await X.eraseSectors(x.t, x.chip, X.sectorsFor(x.chip, at, at + data.length));
    var r = await X.program(x.t, x.chip, at, data, null, { log: function (l) { lines.push(l); } });
    await X.verify(x.t, at, data);
    ok(r.redone > 0 && x.dev.waits > 0, 'redone ' + r.redone + ', waits ' + x.dev.waits); ok(/interrupted/.test(lines[0]));
  });
  test('ST-LINK WAIT partway through a block: a partial quad-word is forced out, then rewritten (H563)', async function () {
    var x = await stlinkTarget('h5', { waitEvery: 3 }), data = pattern(12000, 13), at = 0x08004000;
    await X.eraseSectors(x.t, x.chip, X.sectorsFor(x.chip, at, at + data.length));
    var r = await X.program(x.t, x.chip, at, data);
    await X.verify(x.t, at, data);
    ok(r.redone > 0, 'redone ' + r.redone);
  });
  test('Refuses an image outside the flash', async function () {
    var x = await stlinkTarget('g0');
    await rejects(X.program(x.t, x.chip, 0x0807FFF0, pattern(64)), /outside/);
  });
  test('H563: sector erase in bank 2 (BKSEL) and quad-word program on AP1', async function () {
    var x = await stlinkTarget('h5'), at = 0x08100000 + 8192 * 3, data = pattern(9000, 5);
    x.sim.flash.fill(0, 0x100000 + 8192 * 3, 0x100000 + 8192 * 5);
    await X.eraseSectors(x.t, x.chip, X.sectorsFor(x.chip, at, at + data.length));
    ok(x.sim.log.indexOf('erase sector 2:3') >= 0 && x.sim.log.indexOf('erase sector 2:4') >= 0, x.sim.log.join());
    await X.program(x.t, x.chip, at, data); await X.verify(x.t, at, data);
    eq(x.sim.flash[0x100000 + 8192 * 3 + 9000], 0xFF, 'quad-word padding');
  });
  test('H563: refuses to write with the banks swapped', async function () {
    var x = await stlinkTarget('h5'); x.chip.swapped = true;
    await rejects(X.program(x.t, x.chip, 0x08000000, pattern(16)), /swap/i);
  });
  test('Verify names the first differing address', async function () {
    var x = await stlinkTarget('g0'), data = pattern(32);
    await X.program(x.t, x.chip, 0x08000000, data);
    data[17] ^= 1;
    var e = await rejects(X.verify(x.t, 0x08000000, data), /Verify failed at 0x08000011/);
    eq(e.addr, 0x08000011);
  });

  // ── Option bytes ──
  test('G0B1: options read, RDP level 2 refused, level 1 → 0 warns', async function () {
    var x = await stlinkTarget('g0'), cur = await X.readOptions(x.t, x.chip);
    eq(cur.RDP, 0xAA); eq(cur.NRST_MODE, 3); eq(cur.nBOOT_SEL, 1);
    eq(X.review(x.chip, cur, { RDP: 0xCC }).refused.length, 1);
    eq(X.review(x.chip, Object.assign({}, cur, { RDP: 0xBB }), { RDP: 0xAA }).warnings.length, 1);
    eq(X.review(x.chip, cur, { BOOT_LOCK: 1 }).refused.length, 1);
    await rejects(X.writeOptions(x.t, x.chip, { RDP: 0xCC }), /Refused/);
  });
  test('G0B1: an option change is written, launched, and survives a reconnect', async function () {
    var x = await stlinkTarget('g0');
    var r = await X.writeOptions(x.t, x.chip, { BORR_LEV: 2, BOREN: 1, WRP1A_STRT: 0, WRP1A_END: 3 });
    ok(r.reset, 'OBL_LAUNCH resets');
    var t2 = new T.Target(x.p, { sleep: noSleep }), chip2 = await t2.connect({ underReset: true });
    var cur = await X.readOptions(t2, chip2);
    eq(cur.BORR_LEV, 2); eq(cur.BOREN, 1); eq(cur.WRP1A_END, 3); eq(cur.RDP, 0xAA, 'untouched');
  });
  test('H563: product state, boot entry, and TrustZone are refused; BOR is written', async function () {
    var x = await stlinkTarget('h5'), cur = await X.readOptions(x.t, x.chip);
    eq(cur.PRODUCT_STATE, 0xED); eq(cur.TZEN, 0xC3);
    ['PRODUCT_STATE', 'BOOT_UBE', 'TZEN', 'NSBOOT_LOCK', 'SWAP_BANK'].forEach(function (k) { var c = {}; c[k] = 1; eq(X.review(x.chip, cur, c).refused.length, 1, k); });
    var r = await X.writeOptions(x.t, x.chip, { BOR_LEV: 2, IWDG_STOP: 0 });
    ok(!r.reset);
    var after = await X.readOptions(x.t, x.chip);
    eq(after.BOR_LEV, 2); eq(after.IWDG_STOP, 0); eq(after.PRODUCT_STATE, 0xED); eq(after.BOOT_UBE, 0xC3);
  });

  // ── SVD ──
  test('SVD: an opened file parses, derived peripherals copy registers, fields encode', function () {
    var xml = '<?xml version="1.0"?><device><name>TEST</name><size>32</size><resetValue>0</resetValue><peripherals>' +
      '<peripheral><name>TIM2</name><baseAddress>0x40000000</baseAddress><registers>' +
      '<register><name>CR1</name><addressOffset>0x0</addressOffset><fields><field><name>CEN</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>' +
      '<field><name>CMS</name><bitRange>[6:5]</bitRange><enumeratedValues><enumeratedValue><name>Edge</name><value>0</value></enumeratedValue><enumeratedValue><name>Center1</name><value>1</value></enumeratedValue></enumeratedValues></field></fields></register>' +
      '<register><name>DR</name><addressOffset>0x4C</addressOffset><readAction>clear</readAction></register></registers></peripheral>' +
      '<peripheral derivedFrom="TIM2"><name>TIM3</name><baseAddress>0x40000400</baseAddress></peripheral>' +
      '<peripheral derivedFrom="TIM2"><name>SEC_TIM2</name><baseAddress>0x50000000</baseAddress></peripheral></peripherals></device>';
    var dev = FL.svd.parseXml(xml);
    eq(dev.p.length, 2, 'secure alias dropped'); eq(dev.p[1].n, 'TIM3'); eq(dev.p[1].r.length, 2);
    var cms = dev.p[0].r[0].f[1]; eq(cms.l, 5); eq(cms.w, 2); eq(cms.e[1], 'Center1');
    eq(FL.svd.withField(0, cms, 3), 0x60); eq(FL.svd.fieldValue(0x40, cms), 2);
    ok(FL.svd.sideEffects(dev.p[0].r[1]), 'DR with a readAction');
  });
  test('SVD: the bundled G0B1 file loads and has FLASH', async function () {
    var dev = await FL.svd.bundled('STM32G0B1');
    var fl = dev.p.filter(function (p) { return p.n === 'FLASH'; })[0];
    ok(fl, 'FLASH'); eq(fl.b, 0x40022000);
    ok(fl.r.some(function (r) { return r.n === 'OPTR'; }), 'OPTR');
  });

  // ── J-Link ──
  test('J-Link: SWD request bytes', function () {
    var s = new FL.jlink.Seq(); s.txn(0, 1, 0, 0);   // read DP IDR
    var req = 0; for (var i = 0; i < 8; i++) req |= s.out[i] << i;
    eq(req, 0xA5);
    var w = new FL.jlink.Seq(); w.txn(1, 0, 0xC, 0);  // write AP DRW
    var r2 = 0; for (i = 0; i < 8; i++) r2 |= w.out[i] << i;
    eq(r2, 0xBB);
  });
  test('J-Link: open, connect under reset, identify a G0B1', async function () {
    var x = await jlinkTarget('g0');
    eq(x.p.info.firmware, 'J-Link V11 compiled Jan  1 2026');
    eq(x.chip.name, 'STM32G0B1/G0C1'); ok(x.sim.halted, 'halted'); eq(Math.round(await x.p.voltage() * 10), 33);
  });
  test('J-Link: H563 on AP1, read and write memory', async function () {
    var x = await jlinkTarget('h5');
    eq(x.chip.ap, 1);
    await x.t.write(0x20000010, pattern(600, 6));
    var got = await x.t.read(0x20000010, 600);
    ok(got.every(function (b, i) { return b === pattern(600, 6)[i]; }), 'round trip');
  });
  test('J-Link: batches resume after WAIT without repeating or skipping writes', async function () {
    var x = await jlinkTarget('g0', { waitEvery: 37 }), data = pattern(3000, 8);
    await X.eraseSectors(x.t, x.chip, X.sectorsFor(x.chip, 0x08002000, 0x08002000 + data.length));
    await X.program(x.t, x.chip, 0x08002000, data);
    await X.verify(x.t, 0x08002000, data);
    ok(x.dev.waits > 5, 'WAITs happened: ' + x.dev.waits);
  });

  // ── Run ──
  (async function () {
    var out = document.getElementById('out'), pass = 0, fail = 0;
    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      try { await t.fn(); pass++; out.insertAdjacentHTML('beforeend', '<span class="pass">✓ ' + t.name + '</span>\n'); }
      catch (e) { fail++; out.insertAdjacentHTML('beforeend', '<span class="fail">✕ ' + t.name + ': ' + (e && e.message || e) + '</span>\n'); console.error(t.name, e); }
    }
    out.insertAdjacentHTML('beforeend', '\n' + pass + ' passed, ' + fail + ' failed');
    document.title = (fail ? 'FAIL' : 'PASS') + ' ' + pass + '/' + tests.length;
  })().catch(function (e) { document.title = 'ERROR'; document.getElementById('out').textContent += '\n' + e.stack; });
})();
