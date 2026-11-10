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
  function loadRepo(token, fetchImpl) {
    var cfg = FL.config, A = FL.access;
    return A.load({ token: token, fetch: fetchImpl }).then(function (loaded) {
      var c = A.combine(loaded);
      c.fte = loaded.fte; c.login = loaded.login; c.roster = loaded.roster; c.access = loaded; c.invites = loaded.invites;
      loaded.errors.forEach(function (e) { c.problems.push(e); });
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
    boards: {
      'tstat-main': {
        name: 'Smart Thermostat Main PCBA', mcu: 'STM32G431 (made up for the demo)',
        flash: { base: '0x08000000', size: '0x20000' }, ram: { base: '0x20000000', size: '0x8000' },
        run: { vid: '0x0483', pid: '0x5740', name: 'Acme Thermostat' }, dfu: { vid: '0x0483', pid: '0xDF11', name: 'DFU in FS Mode' },
        touchBaud: 1200,
        manualDfu: ['Hold S2 (BOOT).', 'Press and release S1 (RESET).', 'Release S2. Both LEDs stay off: the board is waiting in its bootloader.'],
        notes: 'The Main PCBA (Signoff EE board pdemo7). Its USB-C port is the one by the terminal blocks.'
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
        built: '2026-11-02T10:12:00Z', published: '2026-11-02T10:15:00Z' }
    ]
  };

  function loadDemo() {
    var boards = {}, problems = [];
    Object.keys(DEMO_MANIFEST.boards).forEach(function (id) { boards[id] = I.cleanBoard(id, DEMO_MANIFEST.boards[id], problems); });
    var images = {};
    var list = DEMO_MANIFEST.firmware.map(function (f) {
      images[f.id] = makeImage(f.size, f.seed, boards[f.board]);
      return f;
    });
    return Promise.all(list.map(function (f) { return I.sha256(images[f.id]).then(function (h) { return h; }); })).then(function (hashes) {
      var m = JSON.parse(JSON.stringify(DEMO_MANIFEST));
      m.firmware.forEach(function (f, i) { f.sha256 = hashes[i]; f.path = 'firmware/' + f.board + '/' + f.id + '.bin'; delete f.seed; });
      var c = I.cleanManifest(m);
      c.head = 'demo'; c.updated = m.updated; c.source = 'the demo';
      c.fetch = function (f) { return Promise.resolve(images[f.id].slice()); };
      return c;
    });
  }

  FL.catalog = { auth: auth, loadRepo: loadRepo, loadDemo: loadDemo, makeImage: makeImage, DEMO_MANIFEST: DEMO_MANIFEST };
})(window.FL = window.FL || {});
