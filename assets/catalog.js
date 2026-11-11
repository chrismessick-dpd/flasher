/* Where the firmware list comes from.

   Real use: manifest.json and firmware/<board>/<id>.bin in the private data repo
   (FL.config.owner / FL.config.repo), read with the suite's GitHub sign-in (`signoff.token`, the
   same key Signoff EE and Fabcheck use) through the vendored engine's GitHubStore. Every file is
   checked against the SHA-256 the manifest gives before it is offered for flashing.

   ?demo: the made-up Smart Thermostat for Acme Climate. Its images are generated here (a valid
   vector table and filler), so the public repo carries no binaries. */
(function (FL) {
  'use strict';
  var I = FL.image;

  FL.config = { owner: 'chrismessick-dpd', repo: 'flasher_data', branch: 'main' };

  var TOKEN_KEY = 'signoff.token';
  function clean(t) { return String(t || '').replace(/\s+/g, ''); }
  var auth = {
    token: function () { try { return clean(sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''); } catch (e) { return ''; } },
    set: function (t, remember) {
      try {
        sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY);
        (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, clean(t));
      } catch (e) { /* storage blocked */ }
    },
    clear: function () { try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch (e) { /* storage blocked */ } }
  };

  /* The catalog from the data repo: resolves { boards, firmware, problems, fetch(entry) → bytes, head }.
     fetchImpl is for tests. */
  /* Everything this token may flash (assets/access.js): an FTE's flasher_data plus every shared
     project repo, or only the review-flasher-* repos shared with a client or contractor.
     Resolves the combined catalog, with fte, login, roster, and access (what was loaded). */
  function fromLoaded(loaded) {
    var c = FL.access.combine(loaded);
    c.fte = loaded.fte; c.login = loaded.login; c.roster = loaded.roster; c.access = loaded; c.invites = loaded.invites;
    loaded.errors.forEach(function (e) { c.problems.push(e); });
    return c;
  }
  /* The catalog this browser kept from its last sync (FL.access.slim), ready to flash from with this token. */
  function fromKept(kept, token, fetchImpl) { return fromLoaded(FL.access.revive(kept, { token: token, fetch: fetchImpl })); }

  function loadRepo(token, fetchImpl) {
    var cfg = FL.config, A = FL.access;
    return A.load({ token: token, fetch: fetchImpl }).then(function (loaded) {
      var c = fromLoaded(loaded);
      if (!loaded.fte && !loaded.repos.length) {
        var e0 = new Error(loaded.invites.length
          ? 'You’ve been invited to firmware on GitHub. Accept the invitation to see it.'
          : 'No firmware is shared with you yet. Ask the person who invited you to add you to a project in Flasher’s People & access.');
        e0.code = loaded.invites.length ? 'invited' : 'none'; e0.invites = loaded.invites; throw e0;
      }
      if (loaded.fte && !loaded.repos.some(function (r) { return r.raw; })) {
        var e1 = new Error(A.dataFull() + ' has no manifest.json yet. Nothing has been published.'); e1.code = 'empty'; e1.catalog = c; throw e1;
      }
      return c;
    }).catch(function (e) {
      if (e.status === 401) e.message = 'GitHub refused the saved token. Sign in again.';
      else if (e.status === 403) e.message = 'GitHub said no (' + e.message + '). The token may lack read access to ' + cfg.repo + ', or the hourly limit is used up.';
      throw e;
    });
  }

  // ── The demo ──
  // A small deterministic number source, so the demo images are the same on every visit.
  function prng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s & 0xFF; }; }
  function makeImage(size, seed, board) {
    var b = new Uint8Array(size), r = prng(seed), i;
    for (i = 8; i < size; i++) b[i] = r();
    var sp = board.ram.base + board.ram.size, reset = board.flash.base + 0x1C1 + (seed % 64) * 4;
    [sp, reset].forEach(function (w, k) { for (var j = 0; j < 4; j++) b[k * 4 + j] = (w >>> (8 * j)) & 0xFF; });
    for (i = 8; i < 0x1C0; i += 4) { var v = reset; for (var j2 = 0; j2 < 4; j2++) b[i + j2] = (v >>> (8 * j2)) & 0xFF; }
    return b;
  }

  var DEMO_MANIFEST = {
    format: 1,
    updated: '2026-11-06T16:20:00Z',
    projects: { thermostat: { name: 'Smart Thermostat' } },
    boards: {
      'tstat-main': {
        name: 'Smart Thermostat Main PCBA', mcu: 'STM32G431 (made up for the demo)', project: 'thermostat',
        flash: { base: '0x08000000', size: '0x20000' }, ram: { base: '0x20000000', size: '0x8000' },
        run: { vid: '0x0483', pid: '0x5740', name: 'Acme Thermostat' }, dfu: { vid: '0x0483', pid: '0xDF11', name: 'DFU in FS Mode' },
        touchBaud: 1200,
        manualDfu: ['Hold S2 (BOOT).', 'Press and release S1 (RESET).', 'Release S2. Both LEDs stay off: the board is waiting in its bootloader.'],
        notes: 'The Main PCBA (Signoff EE board pdemo7). Its USB-C port is the one by the terminal blocks.'
      },
      'tstat-display': {
        kind: 'bridge', name: 'Display & Sensor Board', mcu: 'STM32F7 (made up for the demo)', project: 'thermostat',
        touch: [{ vid: '0x0483', pid: '0x5740', name: 'Acme Thermostat' }], touchBaud: 2400, exitBaud: 1200,
        bridge: { vid: '0x0483', pid: '0x5742', name: 'Acme Thermostat passthrough' }, linkBaud: 1000000, fastBaud: 4000000,
        expect: { device: '0x4A5', appBase: '0x08010000', qspiBase: '0x70000000', singleBank: true },
        notes: 'The Display & Sensor Board (Signoff EE board pdemo11) has no USB port of its own. Flasher reaches its bootloader through the Main PCBA’s USB-C port, which passes the link through.'
      }
    },
    firmware: [
      { id: 'thermostat-1-4-0', board: 'tstat-main', name: 'Thermostat Firmware 1.4.0', seed: 7, size: 96812,
        summary: 'The release candidate: schedules, the touch display, Wi-Fi, and over-the-air updates.',
        description: 'The release candidate reviewed in Signoff FW (Thermostat Firmware).\n\nSchedules and setpoints are kept through a power cut. The heat and cool calls drive the two relays, with the compressor’s 5-minute minimum off time.\n\nAfter flashing, the display shows the setup screen.',
        source: { repo: 'acme-climate/thermostat-fw', sha: '4f1c2e9a7b3d5c60e8f9a1b2c3d4e5f60718293a', path: 'app/Thermostat', dirty: false },
        built: '2026-11-06T15:58:00Z', published: '2026-11-06T16:20:00Z' },
      { id: 'bringup', board: 'tstat-main', name: 'Bring-up', seed: 3, size: 21480,
        summary: 'Blinks both LEDs and prints every sensor once a second on the USB console.',
        description: 'Bring-up: blinks both LEDs and prints every sensor once a second.\n\nOpen the console after flashing to read the temperature, humidity, and the 24 VAC sense input.',
        source: { repo: 'acme-climate/thermostat-fw', sha: '4f1c2e9a7b3d5c60e8f9a1b2c3d4e5f60718293a', path: 'examples/Bringup', dirty: false },
        built: '2026-11-06T15:58:00Z', published: '2026-11-06T16:20:00Z' },
      { id: 'relay-test', board: 'tstat-main', name: 'Relay test', seed: 11, size: 26904,
        summary: 'Clicks the heat and cool relays in turn, 2 s each, with a console command to stop.',
        description: 'Relay test: clicks the heat relay, then the cool relay, 2 s each.\n\nType stop in the console to hold both off.',
        source: { repo: 'acme-climate/thermostat-fw', sha: '9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7081920', path: 'examples/RelayTest', dirty: true },
        built: '2026-11-02T10:12:00Z', published: '2026-11-02T10:15:00Z' },
      { id: 'display-1-4-0', board: 'tstat-display', kind: 'units', name: 'Display Firmware 1.4.0', seed: 23,
        summary: 'The touch display and its pictures and fonts, written through the Main PCBA.',
        description: 'The display board’s firmware for release 1.4.0: the home screen, the schedule editor, and the setup screens, with their pictures and fonts in the board’s external flash.\n\nOnly the blocks that differ from what’s on the board are written, so an update that changes code but not pictures takes seconds. Try Compare only first: it changes nothing.',
        source: { repo: 'acme-climate/thermostat-fw', sha: '4f1c2e9a7b3d5c60e8f9a1b2c3d4e5f60718293a', path: 'display', dirty: false },
        built: '2026-11-06T15:58:00Z', published: '2026-11-06T16:20:00Z' }
    ]
  };

  /* The demo display's image as erase units: two internal flash sectors of code, then pictures and
     fonts in 64 KB external flash blocks, each unit filled with 0xFF past its data. */
  var DEMO_DISPLAY = { internal: [[0x08010000, 0x8000, 0x7A40], [0x08018000, 0x10000, 0x0E200]], qspi: [0x70000000, 0x10000, 22, 0x7C20] };
  function demoUnits(seed, older) {
    var r = prng(seed), out = [];
    function unit(addr, size, used) {
      var b = new Uint8Array(size).fill(0xFF);
      for (var i = 0; i < used; i++) b[i] = r();
      out.push({ addr: addr, size: size, bytes: b });
    }
    DEMO_DISPLAY.internal.forEach(function (u) { unit(u[0], u[1], u[2]); });
    var q = DEMO_DISPLAY.qspi;
    for (var k = 0; k < q[2]; k++) unit(q[0] + k * q[1], q[1], k === q[2] - 1 ? q[3] : q[1]);
    if (older) {
      // What the demo board holds: the previous release, whose code and two picture blocks differ.
      [0, 1, 7, 8].forEach(function (i) { var b = out[i].bytes; for (var j = 64; j < 4096; j += 7) b[j] ^= 0x3C; });
    }
    return out;
  }
  /* Units grouped into parts as publish.py groups them: back-to-back units within one 1 MB window. */
  function partsOf(units) {
    var parts = [];
    units.forEach(function (u) {
      var p = parts[parts.length - 1];
      if (p && p.addr + p.size === u.addr && Math.floor(p.addr / 0x100000) === Math.floor(u.addr / 0x100000)) { p.units.push(u); p.size += u.size; }
      else parts.push({ addr: u.addr, size: u.size, units: [u] });
    });
    parts.forEach(function (p) {
      p.bytes = new Uint8Array(p.size);
      p.units.forEach(function (u) { p.bytes.set(u.bytes, u.addr - p.addr); });
    });
    return parts;
  }

  function loadDemo() {
    var boards = {}, problems = [];
    Object.keys(DEMO_MANIFEST.boards).forEach(function (id) { boards[id] = I.cleanBoard(id, DEMO_MANIFEST.boards[id], problems); });
    var images = {}, files = {}, unitParts = {};
    var list = DEMO_MANIFEST.firmware.map(function (f) {
      if (f.kind === 'units') {
        var parts = unitParts[f.id] = partsOf(demoUnits(f.seed));
        images[f.id] = new Uint8Array(parts.reduce(function (n, p) { return n + p.size; }, 0));
        parts.reduce(function (at, p) { images[f.id].set(p.bytes, at); return at + p.size; }, 0);
      } else images[f.id] = makeImage(f.size, f.seed, boards[f.board]);
      return f;
    });
    var partHashes = [];
    Object.keys(unitParts).forEach(function (id) { unitParts[id].forEach(function (p) { partHashes.push(I.sha256(p.bytes).then(function (h) { p.sha256 = h; })); }); });
    return Promise.all(partHashes).then(function () {
      return Promise.all(list.map(function (f) { return I.sha256(images[f.id]); }));
    }).then(function (hashes) {
      var m = JSON.parse(JSON.stringify(DEMO_MANIFEST)), B = FL.sboot;
      m.firmware.forEach(function (f, i) {
        f.sha256 = hashes[i]; f.path = 'firmware/' + f.board + '/' + f.id + '.bin'; delete f.seed;
        if (f.kind !== 'units') return;
        var dir = f.path = 'firmware/' + f.board + '/' + f.id + '/', app = [], appCrc = 0;
        f.parts = unitParts[f.id].map(function (p) {
          var path = dir + p.addr.toString(16).padStart(8, '0') + '.bin';
          files[path] = p.bytes;
          return { path: path, addr: p.addr, size: p.size, sha256: p.sha256, units: p.units.map(function (u) {
            if (u.addr < boards[f.board].expect.qspiBase) { app.push(u); appCrc = B.crc32(u.bytes, appCrc); }
            return [u.addr, u.size, B.crc32(u.bytes)];
          }) };
        });
        f.size = images[f.id].length;
        f.commit = { crc32: appCrc, length: app.reduce(function (n, u) { return n + u.size; }, 0) };
      });
      var c = I.cleanManifest(m), names = FL.access.projectsIn(m);
      c.projects = {};
      Object.keys(c.boards).forEach(function (bid) {
        var pid = FL.access.projectOf(bid, m.boards[bid]);
        c.boards[bid].project = pid; c.projects[pid] = { name: names[pid], repo: 'the demo' };
      });
      c.head = 'demo'; c.updated = m.updated; c.source = 'the demo';
      c.fetch = function (f) { return Promise.resolve((files[f.path] || images[f.id]).slice()); };
      // The board the demo's display update writes to, holding the previous release.
      c.demoDisplay = function (id) {
        var b = c.boards['tstat-display'], units = demoUnits(DEMO_MANIFEST.firmware.filter(function (f) { return f.id === id; })[0].seed, true);
        var sim = FL.fakebridge.display({ units: units, appBase: b.expect.appBase, qspiBase: b.expect.qspiBase, device: b.expect.device, latency: 1, eraseMs: 12, bootMs: 250 });
        units.forEach(function (u) { sim.load(u.addr, u.bytes); });
        return sim;
      };
      return c;
    });
  }

  FL.catalog = { auth: auth, loadRepo: loadRepo, fromKept: fromKept, loadDemo: loadDemo, makeImage: makeImage, partsOf: partsOf, DEMO_MANIFEST: DEMO_MANIFEST };
})(window.FL = window.FL || {});
