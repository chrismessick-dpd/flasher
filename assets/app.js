/* Flasher: pick firmware, flash a board over USB from Chrome or Edge.

   The flow (README, *How a flash works*):
     1. A running board gets the 1200-baud touch on its USB serial port (Web Serial), which makes
        its firmware reboot into the chip's ROM DFU bootloader. A blank board is put there by hand.
     2. The DFU device is picked (WebUSB), then erased, written, and read back (assets/dfuse.js).
     3. The board is told to start the new firmware.
   Once the browser has been allowed a device, it is found again without a picker, so after the
   first time a flash is one click. */
(function (FL) {
  'use strict';
  var D = FL.dfuse, I = FL.image, C = FL.catalog;
  var DEMO = /[?&]demo\b/.test(location.search);
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtDate(iso) {
    var d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  }
  var hex4 = function (n) { return n.toString(16).toUpperCase().padStart(4, '0'); };

  // ── Settings: the suite's theme; this tool's sidebar ──
  var SETTINGS_KEY = 'signoff.v1.settings';
  var SIDE_KEY = (DEMO ? 'flasher.demo.' : 'flasher.v1.') + 'sideCollapsed';
  function readTheme() { try { return (JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}).theme || 'auto'; } catch (e) { return 'auto'; } }
  function writeTheme(t) { try { var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; s.theme = t; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* storage blocked */ } }
  function isDark(t) { return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches); }
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    var b = $('#theme-btn'), dark = isDark(t);
    b.title = dark ? 'Light mode' : 'Dark mode';
    b.innerHTML = dark
      ? '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="3.6"/><path d="M10 1.8v2.1M10 16.1v2.1M1.8 10h2.1M16.1 10h2.1M4.2 4.2l1.5 1.5M14.3 14.3l1.5 1.5M4.2 15.8l1.5-1.5M14.3 5.7l1.5-1.5"/></svg>'
      : '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7z"/></svg>';
  }

  // ── State ──
  var S = {
    catalog: null, loading: false, error: '',
    view: 'home', fwId: '',            // view: 'home' | 'fw' | 'local'
    local: null,                       // { name, bytes, sha256, boardId }
    skipTouch: false,
    run: null,                         // the flash in progress or last finished, for the current firmware
    con: null                          // { text, open, demo }
  };
  var demoBoard = { running: true };   // the simulated board's state in ?demo

  function boards() { return (S.catalog && S.catalog.boards) || {}; }
  function current() {
    if (S.view === 'fw' && S.catalog) {
      var f = S.catalog.firmware.filter(function (x) { return x.id + '@' + x.board === S.fwId; })[0];
      return f ? { fw: f, board: boards()[f.board] } : null;
    }
    if (S.view === 'local' && S.local) {
      var b = boards()[S.local.boardId] || I.GENERIC;
      return { fw: { id: 'local', name: S.local.name, size: S.local.bytes.length, sha256: S.local.sha256, local: true }, board: b };
    }
    return null;
  }

  // ── Loading the catalog ──
  function load() {
    S.error = '';
    if (DEMO) { S.loading = true; render(); return C.loadDemo().then(done, fail); }
    var tok = C.auth.token();
    if (!tok) { S.catalog = null; S.loading = false; render(); return Promise.resolve(); }
    S.loading = true; render();
    return C.loadRepo(tok).then(done, fail);
    function done(c) { S.catalog = c; S.loading = false; restoreFromUrl(); if (current()) prepareBytes(); render(); }
    function fail(e) { S.catalog = null; S.loading = false; S.error = e.message || String(e); render(); }
  }

  // ?fw=<board>/<id> opens one firmware. Read once at start: renders while loading rewrite the address.
  var linked = /[?&]fw=([a-z0-9_-]+)\/([a-z0-9_-]+)/.exec(location.search);
  function restoreFromUrl() {
    if (linked && S.view === 'home') { S.view = 'fw'; S.fwId = linked[2] + '@' + linked[1]; }
    linked = null;
  }
  function setUrl() {
    var c = current(), q = [];
    if (DEMO) q.push('demo');
    if (c && !c.fw.local) q.push('fw=' + c.fw.board + '/' + c.fw.id);
    try { history.replaceState(null, '', location.pathname + (q.length ? '?' + q.join('&') : '')); } catch (e) { /* file:// */ }
  }

  // ── Rendering ──
  function render() {
    renderSide();
    renderAccount();
    var v = $('#view'), c = current();
    if ((S.view === 'fw' || S.view === 'local') && !c) S.view = 'home';
    if (S.loading && linked) return;   // keep ?fw= in the address until the list is here
    v.innerHTML = S.view === 'home' ? homeHtml() : fwHtml(current());
    $('#toolbar-title').textContent = c ? c.fw.name : 'Flasher';
    document.title = (c ? c.fw.name + ' · ' : '') + 'Flasher';
    setUrl();
  }

  function renderSide() {
    var list = $('#fw-list'), h = '';
    if (S.catalog) {
      var by = {};
      S.catalog.firmware.forEach(function (f) { (by[f.board] = by[f.board] || []).push(f); });
      Object.keys(boards()).forEach(function (bid) {
        var fws = by[bid] || [];
        h += '<div class="side-group"><div class="side-head"><span class="side-label">' + esc(boards()[bid].name) + '</span></div>';
        h += fws.length ? fws.map(function (f) {
          var key = f.id + '@' + f.board, on = S.view === 'fw' && S.fwId === key;
          return '<button class="proj' + (on ? ' active' : '') + '" data-act="open-fw" data-fw="' + esc(key) + '" title="' + esc(f.summary || f.name) + '">' +
            '<span class="proj-body"><span class="proj-name">' + esc(f.name) + '</span><span class="proj-sub">' + esc(I.fmtBytes(f.size) + (f.built ? ' · ' + fmtDate(f.built) : '')) + '</span></span></button>';
        }).join('') : '<div class="side-empty">No firmware yet</div>';
        h += '</div>';
      });
    } else if (S.loading) h = '<div class="side-empty">Loading firmware…</div>';
    else if (!DEMO && !C.auth.token()) h = '<div class="side-empty">Sign in to list firmware.</div>';
    if (S.local) {
      h += '<div class="side-group"><div class="side-head"><span class="side-label">From this computer</span></div>' +
        '<button class="proj' + (S.view === 'local' ? ' active' : '') + '" data-act="open-local"><span class="proj-body"><span class="proj-name">' + esc(S.local.name) +
        '</span><span class="proj-sub">' + esc(I.fmtBytes(S.local.bytes.length)) + '</span></span></button></div>';
    }
    list.innerHTML = h;
  }

  function renderAccount() {
    var dot = $('#account-dot'), t = $('#account-title'), s = $('#account-sub');
    if (DEMO) { dot.dataset.tone = 'ok'; t.textContent = 'Demo'; s.textContent = 'Made-up firmware, simulated board'; return; }
    var tok = C.auth.token();
    if (!tok) { dot.dataset.tone = 'idle'; t.textContent = 'Not signed in'; s.textContent = 'Sign in to list firmware'; return; }
    if (S.loading) { dot.dataset.tone = 'busy'; t.textContent = 'Signed in'; s.textContent = 'Loading firmware…'; return; }
    if (S.error) { dot.dataset.tone = 'error'; t.textContent = 'Signed in'; s.textContent = 'Couldn’t read the firmware list'; return; }
    dot.dataset.tone = 'ok'; t.textContent = 'Signed in'; s.textContent = S.catalog ? S.catalog.firmware.length + ' firmware · ' + FL.config.repo : FL.config.repo;
  }

  var ICON = {
    chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M13.2 7l-3.7 5.5h5L10.8 17"/><path d="M8 1.5V4M16 1.5V4M8 20v2.5M16 20v2.5M1.5 8H4M1.5 16H4M20 8h2.5M20 16h2.5"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14.5 8.5l2 2"/></svg>'
  };

  function browserNote() {
    if (DEMO) return '';
    var usb = !!navigator.usb, serial = !!navigator.serial;
    if (usb && serial) return '';
    if (!window.isSecureContext) return '<div class="hint fl-warn"><b>Needs https</b>Browsers only allow USB access from https pages or localhost. Open Flasher from its GitHub Pages address.</div>';
    return '<div class="hint fl-warn"><b>Use Chrome or Edge</b>This browser can’t reach USB devices' + (usb ? ' over serial' : '') +
      '. Flashing needs WebUSB and Web Serial, which Chrome and Edge have on Windows, macOS, and Linux (Firefox and Safari don’t).</div>';
  }

  function homeHtml() {
    var h = '<div class="page"><div class="page-head"><div class="page-head-text"><div class="eyebrow">Dovetail tools</div>' +
      '<h1 class="page-title">Flash a board</h1><div class="page-sub">Pick the firmware, plug the board in by USB, and flash it from Chrome or Edge. No Arduino IDE needed.</div></div></div>';
    h += browserNote();
    if (S.loading) return h + '<div class="card fl-pad"><p class="fl-muted">Loading firmware from ' + esc(DEMO ? 'the demo' : FL.config.owner + '/' + FL.config.repo) + '…</p></div></div>';
    if (!DEMO && !C.auth.token()) {
      return h + '<div class="card empty"><div class="empty-art">' + ICON.key + '</div><h2>Sign in to list firmware</h2>' +
        '<p>The firmware lives in a private GitHub repository. Sign in with the GitHub access you use for Signoff; if you’re signed in to Signoff EE in this browser, you’re already set.</p>' +
        '<div class="fl-row fl-center"><button class="btn btn-primary" data-act="account">Sign in…</button><button class="btn" data-act="open-file">Open a .bin file…</button></div>' +
        '<p class="note">Just looking? <a href="?demo">Try the demo</a>, which flashes a simulated board.</p></div></div>';
    }
    if (S.error) {
      return h + '<div class="hint fl-bad"><b>Couldn’t read the firmware list</b>' + esc(S.error) + '</div>' +
        '<div class="fl-row"><button class="btn btn-primary" data-act="reload">Try again</button><button class="btn" data-act="account">GitHub sign-in…</button><button class="btn" data-act="open-file">Open a .bin file…</button></div></div>';
    }
    if (!S.catalog) return h + '</div>';
    var c = S.catalog;
    if (c.problems.length) h += '<details class="guide"><summary>' + c.problems.length + ' entr' + (c.problems.length === 1 ? 'y' : 'ies') + ' in manifest.json skipped</summary><ul>' + c.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></details>';
    var by = {};
    c.firmware.forEach(function (f) { (by[f.board] = by[f.board] || []).push(f); });
    Object.keys(c.boards).forEach(function (bid) {
      var b = c.boards[bid];
      h += '<div class="fl-board"><div class="fl-board-head"><h2 class="section-title">' + esc(b.name) + '</h2>' + (b.mcu ? '<span class="chip">' + esc(b.mcu) + '</span>' : '') + '</div>';
      if (b.notes) h += '<p class="fl-muted fl-board-note">' + esc(b.notes) + '</p>';
      h += '<div class="grid grid-3">' + (by[bid] || []).map(function (f) {
        return '<button class="card fl-fw" data-act="open-fw" data-fw="' + esc(f.id + '@' + f.board) + '">' +
          '<span class="fl-fw-name">' + esc(f.name) + '</span><span class="fl-fw-sum">' + esc(f.summary || 'No description.') + '</span>' +
          '<span class="chips"><span class="chip">' + esc(I.fmtBytes(f.size)) + '</span>' + (f.built ? '<span class="chip">' + esc(fmtDate(f.built)) + '</span>' : '') +
          (f.source.dirty ? '<span class="chip fl-chip-warn" title="Built from a checkout with uncommitted changes">Uncommitted changes</span>' : '') + '</span></button>';
      }).join('') + '</div></div>';
    });
    if (!c.firmware.length) h += '<div class="card empty"><h2>Nothing published yet</h2><p>' + esc(c.source) + ' has no firmware in its manifest.</p></div>';
    h += '<p class="note fl-foot">From ' + esc(c.source) + (c.updated ? ', updated ' + esc(fmtDate(c.updated)) : '') + '. Every file is checked against its SHA-256 before it’s flashed.</p>';
    return h + '</div>';
  }

  function fwHtml(c) {
    var fw = c.fw, b = c.board, run = S.run && S.run.key === runKey() ? S.run : null;
    var h = '<div class="page"><div class="page-head"><div class="page-head-text"><div class="eyebrow">' + esc(b.name) + '</div>' +
      '<h1 class="page-title">' + esc(fw.name) + '</h1><div class="page-sub"><span class="chips">' +
      '<span class="chip">' + esc(I.fmtBytes(fw.size)) + ' of ' + esc(I.fmtBytes(b.flash.size)) + '</span>' +
      (fw.built ? '<span class="chip">Built ' + esc(fmtDate(fw.built)) + '</span>' : '') +
      (fw.source && fw.source.sha ? '<span class="chip" title="' + esc(fw.source.repo + ' ' + fw.source.path) + '">' + esc((fw.source.repo || '').split('/').pop() + ' @ ' + fw.source.sha.slice(0, 7)) + '</span>' : '') +
      (fw.source && fw.source.dirty ? '<span class="chip fl-chip-warn" title="The checkout it was built from had uncommitted changes">Uncommitted changes</span>' : '') +
      '<span class="chip fl-mono" title="SHA-256 ' + esc(fw.sha256) + '">' + esc(fw.sha256.slice(0, 12)) + '</span></span></div></div></div>';
    h += browserNote();
    if (fw.local) {
      var opts = Object.keys(boards()).map(function (id) { return '<option value="' + esc(id) + '"' + (S.local.boardId === id ? ' selected' : '') + '>' + esc(boards()[id].name) + '</option>'; }).join('');
      h += '<div class="card fl-pad"><div class="field"><label for="local-board">Board</label><select class="input" id="local-board" data-change="local-board">' + opts +
        '<option value=""' + (S.local.boardId && boards()[S.local.boardId] ? '' : ' selected') + '>' + esc(I.GENERIC.name) + '</option></select></div>' +
        '<p class="note">The board decides the checks (flash size, RAM) and how it’s restarted into DFU mode.' + (S.catalog ? '' : ' Sign in to choose one of Dovetail’s boards.') + '</p></div>';
    } else if (fw.description) {
      h += '<h2 class="section-title">About this firmware</h2><div class="card fl-pad fl-desc">' + esc(fw.description) + '</div>';
    }
    h += '<h2 class="section-title">Flash it</h2>' + flashHtml(c, run);
    if (S.con) h += consoleHtml();
    return h + '</div>';
  }

  function stepState(run, step) {
    if (!run) return '';
    var order = ['restart', 'write', 'start'], at = order.indexOf(run.step), me = order.indexOf(step);
    if (run.ok) return 'done';
    if (me < at) return 'done';
    if (me === at) return run.error ? 'bad' : run.busy ? 'now' : run.waitPick ? 'now' : '';
    return '';
  }

  function flashHtml(c, run) {
    var b = c.board, chk = S.check, busy = run && run.busy;
    var h = '<div class="card fl-pad fl-flash">';
    if (chk && chk.errors.length) h += '<div class="hint fl-bad"><b>This image can’t be flashed</b>' + chk.errors.map(esc).join('<br>') + '</div>';
    if (chk && chk.warnings.length) h += '<div class="hint fl-warn"><b>Check</b>' + chk.warnings.map(esc).join('<br>') + '</div>';
    var canTouch = !!(b.run && (DEMO || navigator.serial));
    h += '<ol class="fl-steps">';
    h += '<li class="fl-step ' + stepState(run, 'restart') + '"><span class="fl-num">1</span><div><div class="fl-step-title">Restart into the bootloader</div>' +
      (canTouch
        ? '<div class="fl-step-sub">' + (S.skipTouch ? 'Skipped: the board is already in DFU mode.' : 'Flasher asks the running board (“' + esc(b.run.name || 'USB serial') + '”) to restart into its USB bootloader. The first time, pick its port in the browser’s list.') + '</div>' +
          '<label class="fl-check"><input type="checkbox" data-change="skip"' + (S.skipTouch ? ' checked' : '') + (busy ? ' disabled' : '') + '> The board is already in DFU mode, or is blank</label>'
        : '<div class="fl-step-sub">Put the board in DFU mode by hand (below).</div>') +
      '</div></li>';
    h += '<li class="fl-step ' + stepState(run, 'write') + '"><span class="fl-num">2</span><div><div class="fl-step-title">Erase, write, and verify</div>' +
      '<div class="fl-step-sub">Pick “' + esc(b.dfu.name || 'DFU in FS Mode') + '” (USB ' + hex4(b.dfu.vid) + ':' + hex4(b.dfu.pid) + ') the first time. The whole image is read back and compared.</div>' +
      (run && (run.step === 'write' || run.ok) ? '<div class="busy-bar fl-bar"><i style="width:' + Math.round((run.ok ? 1 : run.pct || 0) * 100) + '%"></i></div><div class="fl-step-sub fl-phase">' + esc(run.ok ? 'Written and verified' : run.phase || '') + '</div>' : '') +
      '</div></li>';
    h += '<li class="fl-step ' + stepState(run, 'start') + '"><span class="fl-num">3</span><div><div class="fl-step-title">Start the firmware</div>' +
      '<div class="fl-step-sub">The board leaves the bootloader and runs what was just written.</div></div></li>';
    h += '</ol>';
    if (run && run.error) h += '<div class="hint fl-bad"><b>' + esc(run.errorTitle || 'The flash stopped') + '</b>' + esc(run.error) + (run.errorHelp ? '<div class="fl-help">' + run.errorHelp + '</div>' : '') + '</div>';
    if (run && run.ok) h += '<div class="hint fl-good"><b>Done</b>' + esc(c.fw.name) + ' is on the board and running (' + esc(I.fmtBytes(run.bytes)) + ', ' + run.pages + ' pages, verified) in ' + (run.ms / 1000).toFixed(1) + ' s.</div>';
    h += '<div class="fl-row">';
    var blocked = (chk && chk.errors.length) || (!DEMO && !navigator.usb) || !S.bytesReady;
    if (run && run.waitPick && !busy) h += '<button class="btn btn-primary" data-act="pick-dfu">Choose the board in DFU mode</button>';
    else h += '<button class="btn btn-primary" data-act="flash"' + (busy || blocked ? ' disabled' : '') + '>' + (busy ? 'Flashing…' : run && run.ok ? 'Flash again' : 'Flash board') + '</button>';
    if (run && run.ok && b.run) h += '<button class="btn" data-act="console"' + (S.con && S.con.open ? ' disabled' : '') + '>Open console</button>';
    if (!S.bytesReady && !S.bytesError) h += '<span class="fl-muted">Fetching the image…</span>';
    if (S.bytesError) h += '<span class="fl-muted fl-bad-text">' + esc(S.bytesError) + '</span>';
    h += '</div>';
    if (run && run.log.length) h += '<details class="fl-log"' + (run.error ? ' open' : '') + '><summary>Details</summary><div class="log">' + run.log.map(function (l) { return '<div class="' + (l.cls || '') + '">' + esc(l.text) + '</div>'; }).join('') + '</div></details>';
    h += '<details class="guide fl-manual"><summary>Board not showing up, or blank?</summary>' + manualHtml(b) + '</details>';
    return h + '</div>';
  }

  function manualHtml(b) {
    var steps = b.manualDfu.length ? b.manualDfu : I.GENERIC.manualDfu;
    return '<p>Put it in DFU mode by hand, then tick “already in DFU mode” and flash:</p><ol>' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p>The bootloader is in the chip’s ROM, so a failed or interrupted flash can always be retried this way.</p>' +
      '<p>On Windows, if “' + esc(b.dfu.name || 'DFU in FS Mode') + '” never appears in the browser’s list, the board needs the WinUSB driver: <a href="#" data-act="driver">Windows driver help</a>.</p>';
  }

  function consoleHtml() {
    return '<h2 class="section-title">Console</h2><div class="card fl-pad"><pre class="fl-console" id="console-out">' + esc(S.con.text) + '</pre>' +
      '<form class="fl-row" data-submit="console"><input class="input fl-grow" id="console-in" placeholder="' + (S.con.open ? 'Type a command and press Enter' : 'Closed') + '" autocomplete="off"' + (S.con.open ? '' : ' disabled') + '>' +
      (S.con.open ? '<button class="btn" type="button" data-act="console-close">Close</button>' : '<button class="btn" type="button" data-act="console">Reopen</button>') + '</form>' +
      '<p class="note">Lines end with a newline. The port opens at 115200 baud (never 1200, which would restart the board into its bootloader).</p></div>';
  }

  // ── The image for the current firmware ──
  var bytesFor = null;   // { key, bytes }
  function runKey() { var c = current(); return c ? (c.fw.local ? 'local:' + c.fw.sha256 : c.fw.id + '@' + c.fw.board) + '|' + c.board.id : ''; }
  function prepareBytes() {
    var c = current(), key = runKey();
    S.check = null; S.bytesReady = false; S.bytesError = '';
    if (!c) return;
    var got = c.fw.local ? Promise.resolve(S.local.bytes) : bytesFor && bytesFor.key === key ? Promise.resolve(bytesFor.bytes) : S.catalog.fetch(c.fw);
    got.then(function (bytes) {
      if (runKey() !== key) return;
      bytesFor = { key: key, bytes: bytes };
      S.check = I.check(bytes, c.board); S.bytesReady = true; render();
    }, function (e) {
      if (runKey() !== key) return;
      S.bytesError = e.code === 'mismatch' ? 'The file in the repo doesn’t match its recorded SHA-256, so it won’t be flashed. Publish it again.' : (e.message || String(e));
      render();
    });
  }

  // ── Flashing ──
  function log(text, cls) { if (S.run) { S.run.log.push({ text: text, cls: cls }); } }
  function upd() { render(); }

  function findDfu(b) {
    if (DEMO) return Promise.resolve(demoBoard.running ? null : demoDevice());
    if (!navigator.usb) return Promise.resolve(null);
    return navigator.usb.getDevices().then(function (list) {
      return list.filter(function (d) { return d.vendorId === b.dfu.vid && d.productId === b.dfu.pid; })[0] || null;
    });
  }
  function waitDfu(b, ms) {
    var until = Date.now() + ms;
    function again() {
      return findDfu(b).then(function (d) { return d || (Date.now() > until ? null : FL.serial.sleep(250).then(again)); });
    }
    return again();
  }
  function pickSerial(b) {
    if (DEMO) return Promise.resolve(demoBoard.running ? FL.fakeusb.serialPort({ vid: b.run.vid, pid: b.run.pid }) : null);
    var filter = { usbVendorId: b.run.vid, usbProductId: b.run.pid };
    return navigator.serial.getPorts().then(function (ports) {
      var mine = ports.filter(function (p) { return FL.serial.matches(p.getInfo(), b.run); });
      if (mine.length === 1) return mine[0];
      return navigator.serial.requestPort({ filters: [filter] });
    }).catch(function (e) {
      if (e && e.name === 'NotFoundError') return null;   // the picker was closed, or no such port
      throw e;
    });
  }

  var demoDev = null;
  function demoDevice() {
    if (!demoDev || demoDev.gone) demoDev = FL.fakeusb.device({ flashSize: 128 * 1024, latency: 3, pollTimeout: 6, eraseMs: 4, serial: 'DEMO' });
    return demoDev;
  }

  function startFlash() {
    var c = current();
    if (!c || !bytesFor || bytesFor.key !== runKey() || (S.run && S.run.busy)) return;
    var b = c.board;
    S.run = { key: runKey(), busy: true, step: 'restart', log: [], pct: 0, phase: '', t0: Date.now() };
    // A console left open holds the board's serial port, and the restart request needs it.
    var closing = con ? con.close() : Promise.resolve();
    con = null; S.con = null; clearInterval(demoTimer);
    upd();
    closing.catch(function () {}).then(function () { return findDfu(b); }).then(function (dev) {
      if (dev) { log('Found the board already in DFU mode (' + dev.productName + ').'); return dev; }
      if (S.skipTouch || !b.run || (!DEMO && !navigator.serial)) return null;
      return pickSerial(b).then(function (port) {
        if (!port) { log('No running board picked; looking for one in DFU mode instead.'); return null; }
        log('Restarting the board into its bootloader (' + b.touchBaud + '-baud touch)…');
        return FL.serial.touch(port, { baud: b.touchBaud }).then(function () {
          if (DEMO) setTimeout(function () { demoBoard.running = false; }, 700);
          log('Waiting for the board to come back in DFU mode…');
          return waitDfu(b, 6000);
        });
      });
    }).then(function (dev) {
      S.run.step = 'write';
      if (dev) return writeTo(dev, c);
      return askForDfu(c, true);
    }).catch(function (e) { stopWith(e, c); });
  }

  // The DFU device picker. Called from the Flash click (which may no longer count as a click by
  // the time we get here) or from "Choose the board in DFU mode" (a fresh one).
  function askForDfu(c, first) {
    var b = c.board;
    if (DEMO) {
      if (demoBoard.running) return stopWith(Object.assign(new Error('No board in DFU mode was found.'), { code: 'none' }), c);
      return writeTo(demoDevice(), c);
    }
    return navigator.usb.requestDevice({ filters: [{ vendorId: b.dfu.vid, productId: b.dfu.pid }] }).then(function (dev) {
      S.run.waitPick = false; return writeTo(dev, c);
    }, function (e) {
      if (e && e.name === 'SecurityError' && first) {
        // The browser wants a fresh click before it shows its list.
        S.run.busy = false; S.run.waitPick = true;
        log('The board should be in DFU mode now. Click “Choose the board in DFU mode”.');
        upd(); return;
      }
      if (e && e.name === 'NotFoundError') e = Object.assign(new Error('No board in DFU mode was chosen.'), { code: 'none' });
      throw e;
    }).catch(function (e) { stopWith(e, c); });
  }

  function writeTo(dev, c) {
    var b = c.board, bytes = bytesFor.bytes, base = b.flash.base;
    S.run.busy = true; S.run.waitPick = false; S.run.step = 'write'; S.run.phase = 'Connecting…'; upd();
    var dfu = new D.Dfuse(dev, { log: function (t) { log(t); }, fallbackLayout: b.layout });
    var W = { erase: [0, 0.15, 'Erasing'], write: [0.15, 0.6, 'Writing'], verify: [0.75, 0.25, 'Verifying'] };
    var lastDraw = 0;
    return dfu.open().then(function () {
      var seg = D.segmentAt(dfu.layout, base);
      var top = dfu.layout.segments.reduce(function (m, s) { return s.writable && s.end > m ? s.end : m; }, 0);
      if (!seg) throw D.DfuError('The device’s flash doesn’t start at ' + D.hex(base) + '. Is this the right board?', 'range');
      if (top - base !== b.flash.size && !c.fw.local) log('Note: ' + b.name + ' should have ' + I.fmtBytes(b.flash.size) + ' of flash; this device reports ' + I.fmtBytes(top - base) + '.', 'err');
      if (bytes.length > top - base) throw D.DfuError('The image (' + I.fmtBytes(bytes.length) + ') is larger than this device’s flash (' + I.fmtBytes(top - base) + ').', 'range');
      log('Erasing, writing, and verifying ' + bytes.length + ' bytes at ' + D.hex(base) + '…');
      return dfu.flash(base, bytes, function (p) {
        var w = W[p.phase]; S.run.pct = w[0] + w[1] * (p.total ? p.done / p.total : 0);
        S.run.phase = w[2] + ' · ' + (p.phase === 'erase' ? p.done + ' of ' + p.total + ' pages' : I.fmtBytes(p.done) + ' of ' + I.fmtBytes(p.total));
        var now = Date.now(); if (now - lastDraw > 80 || p.done === p.total) { lastDraw = now; drawProgress(); }
      });
    }).then(function (res) {
      S.run.pages = res.pages; S.run.bytes = res.bytes;
      log('Verified: every byte reads back as written.', 'ok');
      S.run.step = 'start'; S.run.phase = 'Starting…'; upd();
      return dfu.leave(base);
    }).then(function () {
      if (DEMO) { demoBoard.running = true; demoDev = null; }
      log('Started the firmware at ' + D.hex(base) + '.', 'ok');
      S.run.busy = false; S.run.ok = true; S.run.ms = Date.now() - S.run.t0;
      // The board now runs what was just written, so the next flash starts with the restart
      // request again (left ticked, the DFU list would be empty).
      S.skipTouch = false;
      upd();
    }).catch(function (e) { dfu.close(); throw e; });
  }

  // Update just the bar and its text while writing, without rebuilding the page.
  function drawProgress() {
    var bar = $('.fl-bar i'), ph = $('.fl-phase');
    if (!bar || !ph) return upd();
    bar.style.width = Math.round(S.run.pct * 100) + '%'; ph.textContent = S.run.phase;
  }

  function stopWith(e, c) {
    var run = S.run, b = c.board;
    if (!run) return;
    run.busy = false; run.waitPick = false;
    var win = /Windows/.test(navigator.userAgent), name = e && e.name, msg = (e && e.message) || String(e);
    run.errorTitle = 'The flash stopped'; run.errorHelp = '';
    if (e && e.code === 'none') {
      run.errorTitle = 'No board in DFU mode';
      run.error = msg + (S.skipTouch && b.run
        ? ' “Already in DFU mode” is ticked, so Flasher didn’t ask the board to restart. If it’s running firmware, untick that box and flash again.'
        : ' If the board was running, its firmware may not answer the restart request (or it’s blank).');
      run.errorHelp = '<details open><summary>Put it in DFU mode by hand</summary>' + manualHtml(b) + '</details>';
    } else if (e && e.code === 'busy') {
      run.error = msg;
    } else if (name === 'SecurityError' || /access denied/i.test(msg)) {
      run.errorTitle = 'The browser couldn’t open the board';
      run.error = msg + (win ? ' On Windows this usually means the board isn’t on the WinUSB driver, or another program (STM32CubeProgrammer, the Arduino IDE) has it open.' : ' Another program may have it open.');
      run.errorHelp = '<a href="#" data-act="driver">Windows driver help</a>';
    } else if (name === 'NetworkError' || name === 'NotFoundError' || /disconnected|lost/i.test(msg)) {
      run.errorTitle = 'The board disconnected';
      run.error = msg + ' Check the cable, put the board in DFU mode by hand, and flash again. A half-written flash is fine: the bootloader is in ROM and can’t be erased.';
    } else {
      run.error = msg;
    }
    log(run.errorTitle + ': ' + msg, 'err');
    upd();
  }

  // ── Console ──
  var con = null, demoTimer = 0;
  function openConsole() {
    var c = current(); if (!c || !c.board.run) return;
    var b = c.board;
    S.con = { text: '', open: false }; render();
    var add = function (t) { S.con.text = (S.con.text + t).slice(-20000); var o = $('#console-out'); if (o) { o.textContent = S.con.text; o.scrollTop = o.scrollHeight; } };
    if (DEMO) {
      S.con.open = true; render();
      add('Acme Thermostat ' + c.fw.name + '\r\nType help for commands.\r\n');
      clearInterval(demoTimer);
      var t = 21.4;
      demoTimer = setInterval(function () { t += (Math.random() - 0.5) * 0.1; add('T=' + t.toFixed(1) + ' °C  RH=38 %  24VAC ok\r\n'); }, 1000);
      con = { send: function (line) { add('> ' + line + 'OK\r\n'); return Promise.resolve(); }, close: function () { clearInterval(demoTimer); S.con.open = false; render(); return Promise.resolve(); } };
      return;
    }
    add('Looking for ' + (b.run.name || 'the board') + '…\n');
    var filter = { usbVendorId: b.run.vid, usbProductId: b.run.pid };
    var until = Date.now() + 5000;
    function find() {
      return navigator.serial.getPorts().then(function (ports) {
        var p = ports.filter(function (x) { return FL.serial.matches(x.getInfo(), b.run); })[0];
        if (p) return p;
        return Date.now() > until ? navigator.serial.requestPort({ filters: [filter] }) : FL.serial.sleep(300).then(find);
      });
    }
    find().then(function (port) {
      con = new FL.serial.Console(add, function () { if (S.con) { S.con.open = false; add('\n[closed]\n'); render(); } });
      return con.open(port).then(function () { S.con.open = true; render(); var i = $('#console-in'); if (i) i.focus(); });
    }).catch(function (e) {
      add('Couldn’t open the console: ' + (e.name === 'NotFoundError' ? 'no port chosen.' : e.message) + '\n'); S.con.open = false; render();
    });
  }

  // ── Sheets ──
  function sheet(html, wide) {
    var root = $('#sheet-root');
    root.innerHTML = '<div class="sheet-wrap" data-act="sheet-bg"><div class="sheet' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div></div>';
    var f = root.querySelector('input, button'); if (f) f.focus();
  }
  function closeSheet() { $('#sheet-root').innerHTML = ''; }

  function accountSheet() {
    if (DEMO) return sheet('<div class="sheet-head"><h2>Demo</h2><p>The demo needs no sign-in. Its firmware is made up and flashes a board simulated in this page.</p></div><div class="sheet-foot"><a class="btn" href="./">Leave the demo</a><button class="btn btn-primary" data-act="sheet-close">Done</button></div>');
    var tok = C.auth.token();
    if (tok) {
      return sheet('<div class="sheet-head"><h2>GitHub sign-in</h2><p>Signed in with a token ending …' + esc(tok.slice(-4)) + '. Flasher reads ' + esc(FL.config.owner + '/' + FL.config.repo) + ' with it, and never writes.</p></div>' +
        '<div class="sheet-body"><p class="note">This is the sign-in the Signoff tools share in this browser. Signing out here signs out of Signoff EE, ME, FW, PL, and Fabcheck too.</p></div>' +
        '<div class="sheet-foot"><button class="btn btn-danger" data-act="sign-out">Sign out</button><span class="spacer"></span><button class="btn" data-act="sheet-close">Close</button></div>');
    }
    sheet('<form data-submit="sign-in"><div class="sheet-head"><h2>Sign in to GitHub</h2><p>The firmware is in a private repository, ' + esc(FL.config.owner + '/' + FL.config.repo) + '. Paste a GitHub token that can read it.</p></div>' +
      '<div class="sheet-body"><div class="field"><label for="tok">Token</label><input class="input fl-mono" id="tok" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></div>' +
      '<label class="fl-check"><input type="checkbox" id="tok-remember" checked> Remember on this computer</label>' +
      '<details class="guide"><summary>Making a token</summary><ol><li>On GitHub, open Settings › Developer settings › Fine-grained tokens › Generate new token.</li>' +
      '<li>Resource owner: ' + esc(FL.config.owner) + '. Repository access: only ' + esc(FL.config.repo) + '.</li><li>Permissions: Contents, read-only.</li></ol>' +
      '<p>If you use Signoff EE, its token works here too: sign in there and this page picks it up.</p></details></div>' +
      '<div class="sheet-foot"><button class="btn" type="button" data-act="sheet-close">Cancel</button><button class="btn btn-primary" type="submit">Sign in</button></div></form>');
  }

  function driverSheet() {
    sheet('<div class="sheet-head"><h2>Windows driver help</h2><p>Chrome and Edge reach a USB device on Windows only when it uses Windows’ WinUSB driver. A board in DFU mode (“DFU in FS Mode”, USB 0483:DF11) needs it once per computer. The board’s serial port needs nothing.</p></div>' +
      '<div class="sheet-body fl-prose">' +
      '<h3>Try it first</h3><p>If STM32CubeProgrammer is installed (the Arduino IDE’s STM32 uploads use it), its “STM32 Bootloader” driver is probably there already, and that driver is WinUSB. Flash, and if the board shows up in the browser’s list, you’re done.</p>' +
      '<h3>If it never shows up</h3><p>Put the board in DFU mode, then install one of these:</p>' +
      '<ul><li><b>ST’s driver (best).</b> With STM32CubeProgrammer installed, run <span class="fl-mono">STM32Bootloader.bat</span> as administrator from <span class="fl-mono">C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\Drivers\\DFU_Driver</span>. It is WinUSB, so the browser and STM32CubeProgrammer both keep working.</li>' +
      '<li><b>Zadig</b>, on a computer without STM32CubeProgrammer. Options › List all devices, pick “DFU in FS Mode” (0483 DF11), choose WinUSB, and click Replace driver (or Install).</li></ul>' +
      '<h3>Zadig and the Arduino IDE</h3><p>Zadig’s WinUSB doesn’t register the device the way ST’s driver does, so STM32CubeProgrammer, and with it the Arduino IDE’s USB (DFU) uploads, may stop finding the board in DFU mode. To undo it: with the board in DFU mode, open Device Manager, right-click it (under Universal Serial Bus devices), choose Uninstall device, tick “Attempt to remove the driver for this device”, unplug and replug it, then install ST’s driver as above.</p>' +
      '<h3>macOS and Linux</h3><p>No driver is needed. On Linux, let your user reach the board with a udev rule:</p><pre class="log">SUBSYSTEM=="usb", ATTR{idVendor}=="0483", ATTR{idProduct}=="df11", MODE="0660", TAG+="uaccess"</pre>' +
      '</div><div class="sheet-foot"><button class="btn btn-primary" data-act="sheet-close">Done</button></div>', true);
  }

  // ── Toasts ──
  function toast(text) {
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
    $('#toasts').appendChild(t); setTimeout(function () { t.remove(); }, 3600);
  }

  // ── Events ──
  function select(view, key) {
    if (S.run && S.run.busy) return toast('Wait for the flash to finish.');
    if (con) { con.close(); con = null; }
    S.view = view; S.fwId = key || ''; S.run = null; S.con = null;
    document.body.querySelector('.app').classList.remove('nav-open');
    prepareBytes(); render(); $('#main').scrollTop = 0;
  }

  function sideCollapsed(on) {
    var app = $('#app');
    if (matchMedia('(max-width: 860px)').matches) { app.classList.toggle('nav-open'); return; }
    var v = on === undefined ? !app.classList.contains('side-collapsed') : on;
    app.classList.toggle('side-collapsed', v);
    try { localStorage.setItem(SIDE_KEY, v ? '1' : ''); } catch (e) { /* storage blocked */ }
  }

  document.addEventListener('click', function (ev) {
    if (ev.target === $('#app') && $('#app').classList.contains('nav-open')) { $('#app').classList.remove('nav-open'); ev.stopPropagation(); return; }
    var el = ev.target.closest('[data-act]'); if (!el) return;
    var act = el.dataset.act;
    if (act === 'sheet-bg' && ev.target !== el) return;
    if (el.tagName === 'A' && act !== 'home') ev.preventDefault();
    switch (act) {
      case 'home': ev.preventDefault(); select('home'); break;
      case 'open-fw': select('fw', el.dataset.fw); break;
      case 'open-local': select('local'); break;
      case 'open-file': if (S.run && S.run.busy) toast('Wait for the flash to finish.'); else $('#file-input').click(); break;
      case 'flash': startFlash(); break;
      case 'pick-dfu': { var c = current(); if (c && S.run) { S.run.busy = true; S.run.waitPick = false; upd(); askForDfu(c, false); } break; }
      case 'console': openConsole(); break;
      case 'console-close': if (con) { con.close(); con = null; } break;
      case 'account': accountSheet(); break;
      case 'driver': driverSheet(); break;
      case 'sheet-bg': case 'sheet-close': closeSheet(); break;
      case 'sign-out': C.auth.clear(); closeSheet(); S.catalog = null; S.view = S.local ? 'local' : 'home'; load(); toast('Signed out'); break;
      case 'reload': load(); break;
      case 'theme': { var t = isDark(readTheme()) ? 'light' : 'dark'; writeTheme(t); applyTheme(t); break; }
      case 'nav': sideCollapsed(); break;
    }
  }, true);

  document.addEventListener('change', function (ev) {
    var k = ev.target.dataset && ev.target.dataset.change;
    if (k === 'skip') { S.skipTouch = ev.target.checked; render(); }
    if (k === 'local-board') { S.local.boardId = ev.target.value; S.run = null; prepareBytes(); render(); }
  });

  document.addEventListener('submit', function (ev) {
    var k = ev.target.dataset.submit; if (!k) return;
    ev.preventDefault();
    if (k === 'sign-in') {
      var t = $('#tok').value.trim();
      if (!t) return;
      C.auth.set(t, $('#tok-remember').checked); closeSheet(); load();
    }
    if (k === 'console' && con && S.con && S.con.open) {
      var i = $('#console-in'), line = i.value; i.value = '';
      con.send(line + '\n').catch(function (e) { toast('Couldn’t send: ' + e.message); });
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && $('#sheet-root').innerHTML) { closeSheet(); return; }
    var typing = /INPUT|TEXTAREA|SELECT/.test((ev.target.tagName || ''));
    if (ev.key === '[' && !typing && !ev.ctrlKey && !ev.metaKey) sideCollapsed();
  });

  $('#file-input').addEventListener('change', function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f) return;
    if (f.size > 16 * 1048576) return toast('That file is over 16 MB; it isn’t firmware for these boards.');
    f.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      return I.sha256(bytes).then(function (h) {
        var ids = Object.keys(boards());
        S.local = { name: f.name, bytes: bytes, sha256: h, boardId: S.local && boards()[S.local.boardId] ? S.local.boardId : ids.length === 1 ? ids[0] : '' };
        select('local');
      });
    });
  });

  // Never leave mid-flash: the board would be left half-written (recoverable, but slow).
  window.addEventListener('beforeunload', function (ev) { if (S.run && S.run.busy) { ev.preventDefault(); ev.returnValue = ''; } });
  // Another tab signing in or out (Signoff EE, say) changes what this page can read.
  window.addEventListener('storage', function (ev) { if (ev.key === 'signoff.token' && !DEMO && !(S.run && S.run.busy)) load(); });

  // ── Start ──
  applyTheme(readTheme());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { applyTheme(readTheme()); });
  try { if (localStorage.getItem(SIDE_KEY)) $('#app').classList.add('side-collapsed'); } catch (e) { /* storage blocked */ }
  $('#version').textContent = FL.VERSION ? 'v' + FL.VERSION : '';
  if (DEMO) {
    var banner = $('#demo-banner');
    banner.innerHTML = 'Demo: the made-up Smart Thermostat for Acme Climate. Flashing goes to a board simulated in this page; nothing touches USB. <a href="./">Leave the demo</a>';
    banner.hidden = false; document.body.classList.add('has-banner');
    document.querySelectorAll('[data-demo-href]').forEach(function (a) { a.href = a.getAttribute('href') + '?demo'; });
  }
  FL.app = { state: S, load: load, render: render, demoBoard: demoBoard };
  load();
})(window.FL = window.FL || {});
