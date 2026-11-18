/* Flasher lab · layout. A clickable mock of Flasher with top-bar tabs (Serial bootloader, Debug probe,
   Console). Nothing here touches USB, serial, or GitHub; flashing, connecting, and the console are timers.
   Direction A: tabs only. Direction B: tabs plus a firmware rail. "Who" switches between signed out, an FTE,
   and a contractor with one shared project. Demo data: the made-up Smart Thermostat (Acme Climate). */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem('flasher.lab.layout.' + k); localStorage.setItem('flasher.lab.layout.' + k, v); } catch (e) { return null; } }

  // ── Made-up demo data ──
  var PROJECTS = [
    { id: 'smart-thermostat', name: 'Smart Thermostat', shared: true, boards: [
      { id: 'tstat-main', name: 'Main PCBA', mcu: 'STM32G474', restart: 'usb', fw: [
        { id: 'thermo', name: 'Thermostat Firmware', ver: '1.4.0', sum: 'The release candidate: schedules, the touch display, Wi-Fi, and over-the-air updates.', size: '86 KB' },
        { id: 'bringup', name: 'Bring-up', ver: '0.3.1', sum: 'Blinks both LEDs and prints every sensor once a second on the USB console.', size: '21 KB' },
        { id: 'relay', name: 'Relay test', ver: '0.2.0', sum: 'Clicks the heat and cool relays in turn, 2 s each.', size: '26 KB', warn: 'Built with uncommitted changes' }
      ] },
      { id: 'tstat-display', name: 'Display & Sensor Board', mcu: 'STM32G071', restart: 'bridge', host: 'Main PCBA', fw: [
        { id: 'disp', name: 'Display Firmware', ver: '1.4.0', sum: 'Drives the touch display and reads the temperature and humidity sensors.', size: '48 KB' }
      ] }
    ] },
    { id: 'zone-controller', name: 'Zone Controller', shared: false, boards: [
      { id: 'zc-main', name: 'Controller', mcu: 'STM32G0B1', restart: 'usb', fw: [
        { id: 'zc', name: 'Zone Controller Firmware', ver: '0.9.2', sum: 'Opens and closes four zone dampers from the thermostats’ calls.', size: '64 KB' }
      ] }
    ] }
  ];
  var GENERIC = { id: 'generic', name: 'Any STM32', mcu: 'STM32 (read once connected)', restart: 'try' };
  var WHO = { out: null, fte: { login: 'dovetail-fte', role: 'FTE' }, contractor: { login: 'acme-contractor', role: 'Contractor' } };

  var S = {
    restart: store('restart') || 'ok', who: store('who') || 'out', tab: store('tab') || 'serial',
    src: 'project', fw: '', file: null, fileBoard: 'generic',
    flash: null, conn: false, suite: false, sheet: false, rail: false,
    probe: { kind: 'stlink', reset: true, khz: 4000, on: false, view: 'device', prog: null, src: 'file' },
    con: { open: false, baud: 115200, eol: 'crlf', stamps: false, filter: '', lines: [], input: '', hist: [], hi: 0, watch: false, focus: false }
  };

  if (S.who === 'out') S.src = 'file';   // signed out, the file is the way in

  function projects() {
    if (S.who === 'out') return [];
    return PROJECTS.filter(function (p) { return S.who === 'fte' || p.shared; });
  }
  function count() { var n = 0; projects().forEach(function (p) { p.boards.forEach(function (b) { n += b.fw.length; }); }); return n; }
  function find(key) {
    var r = null;
    projects().forEach(function (p) { p.boards.forEach(function (b) { b.fw.forEach(function (f) { if (p.id + '/' + b.id + '/' + f.id === key) r = { p: p, b: b, f: f }; }); }); });
    return r;
  }
  function chosen() {
    if (S.src === 'file' && S.file) {
      var b = GENERIC; projects().forEach(function (p) { p.boards.forEach(function (x) { if (x.id === S.fileBoard) b = x; }); });
      return { f: { name: S.file.name, size: S.file.size, ver: '' }, b: b, local: true };
    }
    return S.src === 'project' ? find(S.fw) : null;
  }

  // ── Icons ──
  var I = {
    mark: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M13.2 7l-3.7 5.5h5L10.8 17"/><path d="M8 1.5V4M16 1.5V4M8 20v2.5M16 20v2.5M1.5 8H4M1.5 16H4M20 8h2.5M20 16h2.5"/></svg>',
    serial: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5v10"/><path d="M7 5.5l3-3 3 3"/><rect x="6" y="12.5" width="8" height="5" rx="1.2"/></svg>',
    probe: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 10h4l2-4.5 3 9 2-4.5h4"/></svg>',
    console: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M6 8l2.5 2L6 12M10.5 12.5h3.5"/></svg>',
    lock: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="12" height="8.5" rx="2"/><path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9"/></svg>',
    file: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5H5.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M11.5 2.5V7H16"/></svg>',
    chip: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="10" height="10" rx="1.6"/><path d="M8 2.5V5M12 2.5V5M8 15v2.5M12 15v2.5M2.5 8H5M2.5 12H5M15 8h2.5M15 12h2.5"/></svg>',
    grid: '<svg viewBox="0 0 18 18" fill="currentColor"><rect x="2" y="2" width="6" height="6" rx="1.5"/><rect x="10" y="2" width="6" height="6" rx="1.5"/><rect x="2" y="10" width="6" height="6" rx="1.5"/><rect x="10" y="10" width="6" height="6" rx="1.5"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    moon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 12.2A6.8 6.8 0 0 1 7.8 3.5a6.8 6.8 0 1 0 8.7 8.7z"/></svg>',
    menu: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h14M3 10h14M3 14h14"/></svg>',
    people: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7.5" cy="7" r="2.8"/><path d="M2.5 16.5c.6-2.8 2.6-4.3 5-4.3s4.4 1.5 5 4.3"/><circle cx="14" cy="7.8" r="2.2"/><path d="M13.6 12.3c2 .1 3.4 1.4 3.9 3.7"/></svg>'
  };
  var FW_ICON = '<span class="fl-proj-icon">' + I.chip + '</span>';

  // ── Top bar ──
  var TABS = [['serial', 'Serial bootloader', 'Serial', I.serial], ['probe', 'Debug probe', 'Probe', I.probe], ['console', 'Console', 'Console', I.console]];
  function topBar() {
    var h = '<header class="lx-top">';
    h += '<button class="icon-btn lx-rail-btn" data-act="rail" title="Firmware list" aria-label="Firmware list">' + I.menu + '</button>';
    h += '<a class="lx-brand" href="#" data-act="home"><span class="brand-mark">' + I.mark + '</span><span class="lx-brand-name">Flasher</span></a>';
    h += '<nav class="lx-tabs" role="tablist">' + TABS.map(function (t) {
      var live = (t[0] === 'console' && S.con.open) || (t[0] === 'probe' && S.probe.on);
      return '<button role="tab" data-act="tab" data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '" aria-selected="' + (S.tab === t[0]) + '">' +
        t[3] + '<span class="lx-long">' + t[1] + '</span><span class="lx-short">' + t[2] + '</span>' + (live ? '<span class="lx-live" title="Open"></span>' : '') + '</button>';
    }).join('') + '</nav>';
    h += '<div class="lx-top-right">' + connChip();
    return h + '</div></header>';
  }
  function connChip() {
    var tone = '', text = '';
    if (S.tab === 'probe') { tone = S.probe.on ? 'ok' : ''; text = S.probe.on ? 'ST-LINK V3 · STM32G474 · 3.29 V' : 'No probe'; }
    else if (S.tab === 'console') { tone = S.con.open ? 'ok' : ''; text = S.con.paused ? 'COM5 · paused for a flash' : S.con.open ? 'COM5 · ' + S.con.baud + ' baud' : 'No port open'; if (S.con.paused) tone = 'busy'; }
    else { tone = S.flash && !S.flash.done ? 'busy' : S.conn ? 'ok' : ''; text = S.flash && !S.flash.done ? 'Flashing…' : S.conn ? 'Main PCBA on COM5' : 'No board'; }
    return '<span class="lx-conn"><span class="sync-dot"' + (tone ? ' data-tone="' + tone + '"' : '') + '></span>' + esc(text) + '</span>';
  }

  // ── Firmware lists (in the Serial card for A, in the rail for B) ──
  function fwList() {
    var ps = projects();
    if (!ps.length) return lockCard('Project firmware is private', 'Sign in with GitHub to see the projects shared with you. Flashing a file, the probe, and the console work without signing in.');
    return ps.map(function (p) {
      return p.boards.map(function (b) {
        return '<div class="lx-group"><div class="lx-group-h">' + esc(p.name) + ' <span class="lx-board">· ' + esc(b.name) + '</span></div>' +
          b.fw.map(function (f) {
            var key = p.id + '/' + b.id + '/' + f.id;
            return '<button class="lx-fw' + (S.src === 'project' && S.fw === key ? ' on' : '') + '" data-act="pick" data-key="' + key + '">' + FW_ICON +
              '<span class="lx-fw-body"><span class="lx-fw-name">' + esc(f.name) + '</span><span class="lx-fw-sub">' + esc(f.sum) + '</span></span><span class="lx-ver">' + esc(f.ver) + '</span></button>';
          }).join('') + '</div>';
      }).join('');
    }).join('') + (S.who === 'contractor' ? '<p class="lx-mini">Showing the 1 project shared with you.</p>' : '');
  }
  function lockCard(title, text) {
    return '<div class="lx-lock">' + I.lock + '<b>' + esc(title) + '</b>' + esc(text) + '<br><button class="btn btn-primary" data-act="signin">Sign in with GitHub</button></div>';
  }
  function fileBlock() {
    var h = '<button class="lx-drop" data-act="file">' + I.file + '<b>Drop a .bin file here</b><br>or click to choose one. It stays on this computer.</button>';
    if (S.file) {
      h += '<div class="lx-file">' + I.file + '<span class="lx-fw-body"><b>' + esc(S.file.name) + '</b><div class="lx-fw-sub">' + esc(S.file.size) + ' · SHA-256 3f9a…c21e</div></span><button class="btn" data-act="unfile">Remove</button></div>';
      var opts = [[GENERIC.id, GENERIC.name]];
      projects().forEach(function (p) { p.boards.forEach(function (b) { if (b.restart === 'usb') opts.push([b.id, p.name + ' ' + b.name]); }); });
      h += '<div class="lx-row"><label class="fl-muted" for="lx-fb">Board</label><select class="input" id="lx-fb" data-change="fileboard">' + opts.map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === S.fileBoard ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></div>';
      if (S.who === 'out') h += '<p class="lx-mini">Signed in, a project’s board can be chosen here, so Flasher can restart it into update mode for you.</p>';
    }
    return h;
  }

  // ── Serial bootloader ──
  function viewSerial() {
    var c = chosen();
    var h = '<div class="lx-page"><h1 class="lx-h">Serial bootloader</h1><p class="lx-lede">Flash a board over USB through the STM32’s own ROM bootloader. No probe and no IDE.</p>';
    h += c ? '<div class="card lx-card">' + flashPanel(c, true) + '</div>'
      : '<div class="card lx-card">' + (S.src === 'file' ? fileBlock() : '<div class="lx-empty">Pick firmware in the list, or flash a file from this computer.<div class="lx-or">or</div></div>' + fileBlock()) + '</div>';
    return h + '</div>';
  }
  function flashPanel(c, wide) {
    if (!c) return '<div class="lx-empty">Choose firmware first.</div>';
    var b = c.b, fl = S.flash, h = '';
    if (wide) h += '<div class="lx-card-h">' + FW_ICON + esc(c.f.name) + (c.f.ver ? ' <span class="lx-ver">' + esc(c.f.ver) + '</span>' : '') + (c.local ? '<button class="btn" style="margin-left:auto" data-act="unfile">Remove file</button>' : '') + '</div>';
    if (c.f.warn) h += '<div class="hint fl-warn"><b>Check</b>' + esc(c.f.warn) + '.</div>';
    h += '<dl class="lx-kv"><dt>Board</dt><dd>' + esc(b.name) + '</dd><dt>Chip</dt><dd>' + esc(b.mcu) + '</dd><dt>Size</dt><dd>' + esc(c.f.size) + '</dd><dt>Update mode</dt><dd>' +
      ({ usb: 'Flasher restarts it for you over USB', bridge: 'Through the ' + esc(b.host) + '’s USB', try: 'Flasher tries a USB restart; BOOT0 by hand if it doesn’t answer' }[b.restart]) + '</dd></dl>';
    var steps = b.restart === 'try'
      ? [['Restart into update mode', fl && fl.byHand ? 'Put in update mode by hand.' : 'Pick the board’s serial port in Chrome’s list. Flasher sends it a 1200-baud restart, which works if its firmware listens for one (Arduino-style boards do).'],
        ['Pick it in Chrome’s list', '“DFU in FS Mode”. The first time, Windows may need the driver.'], ['Erase, write, and verify', ''], ['Start it', 'Press reset if it doesn’t start on its own.']]
      : b.restart === 'bridge'
        ? [['Connect the ' + b.host, 'Plug its USB in; the display board stays on its cable.'], ['Hand over to the display board', 'The ' + b.host + ' passes the update through.'], ['Erase, write, and verify', ''], ['Restart both', '']]
        : [['Connect the board', 'Plug in its USB. Flasher finds it by its USB id.'], ['Restart into update mode', 'A 1200-baud touch; the board comes back as “DFU in FS Mode”.'], ['Erase, write, and verify', ''], ['Start the new firmware', '']];
    var at = fl ? fl.step : -1;
    h += '<ol class="fl-steps">' + steps.map(function (s, i) {
      var cls = fl ? (i < at || fl.done ? 'done' : i === at ? (fl.stuck ? 'stuck' : 'now') : '') : '';
      var sub = s[1];
      if (i === 2 && fl && at === 2) sub = fl.phase + ' · ' + fl.pct + '%';
      return '<li class="fl-step ' + cls + '"><span class="fl-num">' + (i + 1) + '</span><div><div class="fl-step-title">' + esc(s[0]) + '</div>' +
        (sub ? '<div class="fl-step-sub">' + esc(sub) + '</div>' : '') + (i === 2 && fl && at === 2 ? '<div class="bar fl-bar"><span style="width:' + fl.pct + '%"></span></div>' : '') + '</div></li>';
    }).join('') + '</ol>';
    if (fl && fl.stuck) return h + '<div class="hint fl-warn"><b>The board didn’t answer the restart</b>Its firmware may not listen for one, or it isn’t running. Put it in update mode by hand:' +
      '<ol class="lx-hand"><li>Hold BOOT0 (or tie it high).</li><li>Press and release reset.</li><li>Release BOOT0. The board now waits in its ROM bootloader.</li></ol></div>' +
      '<div class="lx-row"><button class="btn btn-primary" data-act="byhand">It’s in update mode</button><button class="btn" data-act="reflash">Try the restart again</button><button class="btn" data-act="unflash">Cancel</button></div>';
    if (!fl && b.restart === 'try') h += '<p class="lx-mini" style="margin:0 0 8px">Already in update mode (BOOT0 held at reset)? <a href="#" data-act="byhand">Skip the restart</a>.</p>';
    if (fl && fl.done) h += '<div class="hint fl-good"><b>Done</b>Written and verified in 4.8 s. The board is running ' + esc(c.f.name) + '.</div><div class="lx-row"><button class="btn" data-act="to-console">Open the console</button><button class="btn" data-act="reflash">Flash again</button></div>';
    else h += '<button class="btn btn-primary lx-flash-btn" data-act="flash"' + (fl ? ' disabled' : '') + '>' + (fl ? 'Flashing…' : 'Flash') + '</button>';
    return h;
  }

  // ── Debug probe ──
  var SUB = [['device', 'Device'], ['memory', 'Memory'], ['program', 'Erase & program'], ['registers', 'Registers'], ['options', 'Option bytes'], ['log', 'Log']];
  function viewProbe() {
    var p = S.probe;
    var h = '<div class="lx-strip"><span class="seg"><button data-act="pkind" data-kind="stlink" class="' + (p.kind === 'stlink' ? 'on' : '') + '"' + (p.on ? ' disabled' : '') + '>ST-LINK</button>' +
      '<button data-act="pkind" data-kind="jlink" class="' + (p.kind === 'jlink' ? 'on' : '') + '"' + (p.on ? ' disabled' : '') + ' title="Experimental: long transfers have rebooted a J-Link">J-Link (beta)</button></span>' +
      '<label class="fl-check" style="margin:0"><input type="checkbox" data-change="preset"' + (p.reset ? ' checked' : '') + (p.on ? ' disabled' : '') + '> Under reset</label>' +
      '<select class="input" data-change="khz"' + (p.on ? ' disabled' : '') + '>' + [24000, 8000, 4000, 1800, 1000, 480].map(function (k) {
        return '<option value="' + k + '"' + (k === p.khz ? ' selected' : '') + '>' + (k >= 1000 ? k / 1000 + ' MHz' : k + ' kHz') + '</option>';
      }).join('') + '</select><span class="grow"></span>' +
      (p.on ? '<span class="lx-strip-chip"><span class="sync-dot" data-tone="ok"></span>STM32G474RE · halted</span><button class="btn" data-act="pconnect">Disconnect</button>'
        : '<button class="btn btn-primary" data-act="pconnect">Connect</button>') + '</div>';
    h += '<nav class="lx-subtabs">' + SUB.map(function (s) {
      return '<button data-act="psub" data-sub="' + s[0] + '" class="' + (p.view === s[0] ? 'on' : '') + '">' + s[1] + '</button>';
    }).join('') + '</nav>';
    var body = !p.on && p.view !== 'log' && p.view !== 'program'
      ? '<div class="card lx-card"><div class="lx-empty"><b style="display:block;color:var(--text);font-size:15px;margin-bottom:6px">Not connected</b>Plug in the probe, wire it to the board (SWDIO, SWCLK, GND, VDD, and NRST for Under reset), and click Connect.<br>The first time, Chrome asks which probe to use.</div></div>'
      : ({ device: probeDevice, memory: probeMemory, program: probeProgram, registers: probeRegs, options: probeOptions, log: probeLog }[p.view])();
    return h + '<div class="lx-page">' + body + '</div>';
  }
  function probeDevice() {
    return '<div class="lx-grid"><div class="card lx-card"><div class="lx-card-h">Chip</div><dl class="lx-kv"><dt>Device</dt><dd>STM32G474RE, revision Y</dd><dt>Flash</dt><dd>512 KB, 2 banks, 2 KB pages</dd><dt>RAM</dt><dd>128 KB</dd><dt>Read protection</dt><dd>Level 0 (open)</dd><dt>Unique ID</dt><dd class="fl-mono">0032 0041 3156 5012 2036 3838</dd></dl></div>' +
      '<div class="card lx-card"><div class="lx-card-h">Probe</div><dl class="lx-kv"><dt>Probe</dt><dd>' + (S.probe.kind === 'stlink' ? 'STLINK-V3 (made-up serial)' : 'J-Link (beta)') + '</dd><dt>Target voltage</dt><dd>3.29 V</dd><dt>SWD clock</dt><dd>' + (S.probe.khz / 1000) + ' MHz</dd><dt>Connected</dt><dd>' + (S.probe.reset ? 'Under reset' : 'Hot plug') + '</dd></dl>' +
      '<div class="lx-row"><button class="btn" data-act="nop">Reset</button><button class="btn" data-act="nop">Run</button><button class="btn" data-act="nop">Halt</button></div></div></div>';
  }
  function probeMemory() {
    var rows = [], seed = 7;
    for (var r = 0; r < 12; r++) {
      var bytes = [];
      for (var i = 0; i < 16; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; bytes.push(r > 8 ? 'ff' : ('0' + (seed >> 16 & 255).toString(16)).slice(-2)); }
      rows.push('<span class="a">' + (0x08000000 + r * 16).toString(16).toUpperCase() + '</span>  ' + bytes.map(function (b) { return b === 'ff' ? '<span class="z">ff</span>' : b; }).join(' '));
    }
    return '<div class="card lx-card"><div class="lx-row" style="margin:0 0 12px"><input class="input fl-mono" value="0x08000000" style="width:130px"><select class="input"><option>4 KB</option><option>64 KB</option><option>Whole flash</option></select><button class="btn btn-primary" data-act="nop">Read</button><span style="flex:1"></span><button class="btn" data-act="nop">Save as .bin…</button></div><pre class="lx-hex">' + rows.join('\n') + '</pre></div>';
  }
  function probeProgram() {
    var p = S.probe, out = S.who === 'out', g = p.prog;
    var src = '<span class="seg"><button data-act="psrc" data-src="file" class="' + (p.src === 'file' ? 'on' : '') + '">File</button><button data-act="psrc" data-src="project" class="' + (p.src === 'project' ? 'on' : '') + '">From a project</button></span>';
    var h = '<div class="card lx-card"><div class="lx-card-h">Program' + src + '</div>';
    if (p.src === 'project' && out) h += lockCard('Project firmware is private', 'Sign in to program a project’s firmware through the probe. Files from this computer work signed out.');
    else if (p.src === 'project') {
      // The probe writes the firmware picked in the rail, read from GitHub like the bootloader's.
      var sel = find(S.fw);
      h += sel ? '<div class="lx-file" style="margin-top:0">' + I.chip + '<span class="lx-fw-body"><b>' + esc(sel.f.name) + ' ' + esc(sel.f.ver) + '</b><div class="lx-fw-sub">' + esc(sel.p.name + ' · ' + sel.b.name + ' · ' + sel.f.size + ' · from GitHub') + '</div></span></div>' +
          (sel.b.mcu !== 'STM32G474' ? '<div class="hint fl-warn" style="margin:10px 0 0"><b>Another chip</b>Built for the ' + esc(sel.b.mcu) + '; the probe is on an STM32G474.</div>' : '')
        : '<div class="lx-empty" style="padding:16px 10px">Pick firmware in the list on the left. The bootloader and the probe both write what’s picked there.</div>';
    } else h += '<button class="lx-drop" data-act="nop">' + I.file + '<b>Drop a .bin, .hex, .elf, or .srec</b><br>A .bin starts at the address below; the others carry their own.</button>';
    if (!(p.src === 'project' && out)) {
      h += '<div class="lx-row"><label class="fl-muted">Start</label><input class="input fl-mono" value="0x08000000" style="width:130px">' +
        '<label class="fl-check" style="margin:0"><input type="checkbox" checked> Erase what it covers</label><label class="fl-check" style="margin:0"><input type="checkbox" checked> Verify</label><label class="fl-check" style="margin:0"><input type="checkbox"> Run after</label></div>';
      if (g) h += '<div class="lx-row"><div style="flex:1"><div class="fl-step-sub">' + esc(g.done ? 'Programmed and verified, ' + (p.src === 'project' && find(S.fw) ? find(S.fw).f.size : '91 KB') + ' in 0.6 s.' : g.phase + ' · ' + g.pct + '%') + '</div><div class="bar fl-bar"><span style="width:' + g.pct + '%"></span></div></div></div>';
      h += '<div class="lx-row"><button class="btn btn-primary" data-act="pprog"' + (!p.on || (g && !g.done) ? ' disabled' : '') + '>Program</button><button class="btn" data-act="nop"' + (p.on ? '' : ' disabled') + '>Erase whole chip…</button>' + (p.on ? '' : '<span class="fl-muted">Connect first.</span>') + '</div>';
    }
    return h + '</div>';
  }
  function probeRegs() {
    var rows = [['RCC', 'CR', '0x4002 1000', '0x0000 0500', 'HSION, HSIRDY'], ['RCC', 'CFGR', '0x4002 1008', '0x0000 000A', 'SWS = HSE'], ['GPIOA', 'MODER', '0x4800 0000', '0xABFF FFFF', 'PA13, PA14 alternate (SWD)'], ['GPIOA', 'ODR', '0x4800 0014', '0x0000 0020', 'PA5 high']];
    return '<div class="card lx-card"><div class="lx-row" style="margin:0 0 10px"><input class="input" placeholder="Find a peripheral or register" style="flex:1;min-width:180px"><span class="fl-muted">From ST’s SVD for the G474</span></div><table class="lx-table"><thead><tr><th>Peripheral</th><th>Register</th><th>Address</th><th>Value</th><th>Fields</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td><b>' + r[1] + '</b></td><td class="fl-mono">' + r[2] + '</td><td class="fl-mono">' + r[3] + '</td><td>' + r[4] + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }
  function probeOptions() {
    return '<div class="card lx-card"><div class="hint fl-warn"><b>1 change</b>BOR_LEV goes from 0 to 1. Writing option bytes reloads them and resets the chip.</div><table class="lx-table"><thead><tr><th>Option</th><th>Now</th><th>New</th><th>Meaning</th></tr></thead><tbody>' +
      '<tr><td>RDP</td><td class="fl-mono">0xAA</td><td class="fl-mono">0xAA</td><td>Level 0, no read protection</td></tr>' +
      '<tr class="diff"><td>▲ BOR_LEV</td><td class="fl-mono">0</td><td class="fl-mono">1</td><td>Brown-out reset at about 2.0 V</td></tr>' +
      '<tr><td>nBOOT0</td><td class="fl-mono">1</td><td class="fl-mono">1</td><td>Boot pin sets the boot source</td></tr>' +
      '<tr><td>nSWBOOT0</td><td class="fl-mono">1</td><td class="fl-mono">1</td><td>BOOT0 from the pin</td></tr></tbody></table>' +
      '<div class="lx-row"><button class="btn btn-primary" data-act="nop">Write option bytes…</button><button class="btn" data-act="nop">Discard changes</button></div></div>';
  }
  function probeLog() {
    return '<div class="card lx-card"><pre class="lx-hex">' + (S.probe.on ? '10:42:07  ST-LINK V3J16M9, 3.29 V\n10:42:07  Under reset, 4 MHz SWD\n10:42:07  DP IDCODE 0x2BA01477, core on AP0\n10:42:08  STM32G474RE, revision Y, 512 KB' : 'Nothing yet.') + '</pre></div>';
  }

  // ── Console ──
  function viewConsole() {
    var c = S.con, signed = S.who !== 'out';
    var h = '<div class="lx-con"><div class="lx-strip">' +
      (c.open ? '<button class="btn" data-act="cport">Close COM5</button>' : '<button class="btn btn-primary" data-act="cport">Choose a port…</button>') +
      (signed ? '<select class="input" data-change="cfilter" title="Narrow Chrome’s list to one board"' + (c.open ? ' disabled' : '') + '><option value="">Any serial port</option>' +
        projects().map(function (p) { return p.boards.filter(function (b) { return b.restart === 'usb'; }).map(function (b) { return '<option' + (c.filter === b.id ? ' selected' : '') + ' value="' + b.id + '">' + esc(p.name + ' ' + b.name) + '</option>'; }).join(''); }).join('') + '</select>' : '') +
      '<select class="input" data-change="baud">' + [9600, 57600, 115200, 230400, 921600].map(function (b) { return '<option' + (b === c.baud ? ' selected' : '') + '>' + b + '</option>'; }).join('') + '</select>' +
      '<select class="input" title="Line ending sent"><option>CR LF</option><option>LF</option><option>CR</option><option>None</option></select>' +
      '<label class="fl-check" style="margin:0"><input type="checkbox" data-change="stamps"' + (c.stamps ? ' checked' : '') + '> Times</label>' +
      '<span class="grow"></span><button class="btn" data-act="cclear">Clear</button><button class="btn" data-act="nop">Save log…</button></div>' +
      '<div class="lx-con-body"><div class="fl-term" id="lx-term" tabindex="0" aria-label="Terminal: type here"><pre>' +
      c.lines.map(function (l) { return esc((c.stamps ? l[0] + '  ' : '') + l[1]); }).join('\n') +
      (c.open ? (c.lines.length ? '\n' : '') + esc((c.stamps ? now() + '  ' : '') + 't> ' + c.input) + '<span class="fl-cur"> </span>'
        : (c.lines.length ? '' : esc('No port open. Any USB serial device works: a board running its firmware, a USB-UART cable, or a probe’s virtual COM port.'))) +
      '</pre></div><p class="lx-mini">' + (c.open ? 'Click the terminal and type. ↑ and ↓ for history, Tab to complete, Ctrl-L to clear, Ctrl-C to interrupt. Keys go to the board as you type.' : '&nbsp;') + '</p></div></div>';
    return h;
  }

  // ── The rail (direction B) ──
  function rail() {
    var h = '<aside class="lx-rail' + (S.rail ? ' open' : '') + '"><div class="lx-rail-scroll">';
    h += '<div class="side-head"><span class="side-label">Firmware</span></div>';
    h += '<button class="lx-fw' + (S.src === 'file' ? ' on' : '') + '" data-act="src" data-src="file"><span class="fl-proj-icon">' + I.file + '</span><span class="lx-fw-body"><span class="lx-fw-name">' + (S.file ? esc(S.file.name) : 'A file from this computer') + '</span><span class="lx-fw-sub">' + (S.file ? esc(S.file.size) : '.bin, flashed as any STM32') + '</span></span></button>';
    h += '<div style="margin-top:10px">' + fwList() + '</div>';
    h += '<div class="side-head" style="margin-top:16px"><span class="side-label">Dovetail Signoff</span></div><div class="lx-fold">' +
      ['EE', 'ME', 'FW'].map(function (x) { return '<span class="tool-mark tool-mark-text" title="Signoff ' + x + '">' + x + '</span>'; }).join('') + '<span class="tool-mark" title="All tools">' + I.grid + '</span></div>';
    if (S.who === 'fte') h += '<button class="side-link" data-act="nop">' + I.people + ' People &amp; access</button>';
    h += '</div><div class="side-foot"><button class="sync-pill" data-act="' + (S.who === 'out' ? 'signin' : 'sheet') + '"><span class="sync-dot"' + (S.who === 'out' ? '' : ' data-tone="ok"') + '></span><span class="sync-text"><span class="sync-title">' +
      (S.who === 'out' ? 'Not signed in' : 'Synced just now') + '</span><span class="sync-sub' + (S.who === 'out' ? '' : ' sync-who') + '">' + (S.who === 'out' ? 'Sign in for project firmware' : '@' + esc(WHO[S.who].login)) + '</span></span></button>' +
      '<button class="icon-btn" data-act="theme" title="Light or dark">' + I.moon + '</button><button class="icon-btn" data-act="sheet" title="Settings">' + I.gear + '</button></div></aside>';
    return h;
  }

  function sheet() {
    if (!S.sheet) return '';
    var signed = S.who !== 'out';
    return '<div class="lx-scrim" data-act="unsheet"><div class="card lx-sheet" data-stop><h2>Settings</h2>' +
      '<div class="hint"><b>Appearance</b>Light, dark, or the system’s.</div>' +
      '<div class="hint"><b>GitHub</b>' + (signed ? 'Signed in as @' + esc(WHO[S.who].login) + ' (' + esc(WHO[S.who].role) + '). ' + count() + ' firmware in ' + projects().length + ' project' + (projects().length === 1 ? '' : 's') + '.' : 'Not signed in. Flashing files, the probe, and the console work without it.') + '</div>' +
      '<div class="lx-row">' + (signed ? '<button class="btn" data-act="signout">Sign out</button>' : '<button class="btn btn-primary" data-act="signin">Sign in with GitHub</button>') + '<span style="flex:1"></span><button class="btn" data-act="unsheet">Close</button></div></div></div>';
  }

  // ── Render ──
  function render() {
    var y = $('.lx-main') ? $('.lx-main').scrollTop : 0;
    var main = S.tab === 'probe' ? viewProbe() : S.tab === 'console' ? viewConsole() : viewSerial();
    $('#frame').innerHTML = '<div class="lx-app">' + topBar() + '<div class="lx-body-row">' + rail() +
      '<main class="lx-main">' + main + '</main></div></div>' + sheet();
    if ($('.lx-main')) $('.lx-main').scrollTop = y;
    var t = $('.fl-term'); if (t) { t.scrollTop = t.scrollHeight; if (S.con.focus && S.con.open) t.focus({ preventScroll: true }); }
    ['who', 'theme', 'restart'].forEach(function (k) {
      var v = k === 'theme' ? document.documentElement.dataset.theme : S[k];
      Array.prototype.forEach.call(document.querySelectorAll('#ctl-' + k + ' button'), function (b) { b.classList.toggle('on', b.dataset.v === v); });
    });
  }
  function toast(msg) {
    var el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
    $('#toasts').appendChild(el); setTimeout(function () { el.remove(); }, 2600);
  }
  function setTheme(v) { document.documentElement.dataset.theme = v; store('theme', v); }

  // ── Mocked actions ──
  var flashTimer = null;
  function runFlash(byHand) {
    clearInterval(flashTimer);
    var c = chosen(), fails = !byHand && c && c.b.restart === 'try' && S.restart === 'no';
    S.flash = { step: byHand ? 1 : 0, pct: 0, phase: 'Connecting', done: false, byHand: !!byHand }; S.conn = true;
    // One page owns the serial ports: an open Console lets go of the board for the flash and takes it back after.
    if (S.con.open && !S.con.paused) { S.con.paused = true; S.con.watch = false; conLine('— paused: flashing from the Serial bootloader tab —'); }
    render();
    var t = flashTimer = setInterval(function () {
      var f = S.flash; if (!f) return clearInterval(t);
      if (fails && f.step === 0) { if (++f.pct > 4) { f.stuck = true; f.pct = 0; clearInterval(t); } render(); return; }
      if (f.step < 2) { f.step++; if (f.step === 2) f.phase = 'Erasing'; }
      else if (f.pct < 100) { f.pct = Math.min(100, f.pct + 9); f.phase = f.pct < 25 ? 'Erasing' : f.pct < 80 ? 'Writing' : 'Verifying'; }
      else {
        f.step = 3; f.done = true; clearInterval(t);
        if (S.con.paused) { S.con.paused = false; conLine('— reopened COM5 —'); conLine('Smart Thermostat 1.4.0 (made up for the lab)'); }
      }
      render();
    }, 260);
  }
  function runProg() {
    S.probe.prog = { pct: 0, phase: 'Erasing', done: false }; render();
    var t = setInterval(function () {
      var g = S.probe.prog; if (!g) return clearInterval(t);
      g.pct = Math.min(100, g.pct + 12); g.phase = g.pct < 25 ? 'Erasing' : g.pct < 80 ? 'Programming' : 'Verifying';
      if (g.pct >= 100) { g.done = true; clearInterval(t); }
      render();
    }, 150);
  }
  var conTimer = null;
  function now() { var d = new Date(); return d.toTimeString().slice(0, 8); }
  function conLine(s) { S.con.lines.push([now(), s]); if (S.con.lines.length > 400) S.con.lines.shift(); }
  function openCon() {
    S.con.open = true; S.con.lines = []; S.con.input = ''; S.con.focus = true;
    ['Smart Thermostat 1.4.0 (made up for the lab)', 'Type help for commands.'].forEach(conLine);
    conTimer = setInterval(function () { if (S.con.open && S.con.watch) { conLine('temp 21.4 °C  rh 41 %  heat off  cool off'); if (S.tab === 'console') render(); } }, 2000);
  }
  function closeCon() { S.con.open = false; S.con.watch = false; clearInterval(conTimer); conLine('— port closed —'); }
  var REPLY = { help: 'help, temp, relays, version, watch, reboot', temp: '21.4 °C', relays: 'heat off, cool off', version: 'Smart Thermostat 1.4.0', reboot: 'Rebooting…' };
  function conRun(cmd) {
    var c = S.con;
    conLine('t> ' + cmd);
    if (cmd) { c.hist.push(cmd); }
    c.hi = c.hist.length;
    if (cmd === 'watch') { c.watch = true; conLine('Printing every 2 s. Ctrl-C to stop.'); }
    else if (cmd === 'clear') c.lines = [];
    else if (cmd) conLine(REPLY[cmd] || ('unknown command: ' + cmd + ' (try help)'));
  }
  // A real terminal: keys go to the board as typed; the board echoes and edits the line.
  function conKey(e) {
    var c = S.con; if (!c.open || c.paused) return;
    var k = e.key;
    if (e.ctrlKey && (k === 'l' || k === 'L')) c.lines = [];
    else if (e.ctrlKey && (k === 'c' || k === 'C')) { if (window.getSelection().toString()) return; conLine('t> ' + c.input + '^C'); c.input = ''; c.watch = false; }
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (k === 'Enter') { conRun(c.input.trim()); c.input = ''; }
    else if (k === 'Backspace') c.input = c.input.slice(0, -1);
    else if (k === 'ArrowUp') { if (c.hi > 0) c.input = c.hist[--c.hi]; }
    else if (k === 'ArrowDown') { if (c.hi < c.hist.length) { c.hi++; c.input = c.hist[c.hi] || ''; } }
    else if (k === 'Tab') { var m = Object.keys(REPLY).concat(['clear']).filter(function (x) { return c.input && x.indexOf(c.input) === 0; }); if (m.length === 1) c.input = m[0]; }
    else if (k.length === 1) c.input += k;
    else return;
    e.preventDefault(); render();
  }

  document.addEventListener('click', function (e) {
    var lab = e.target.closest('.lx-lab-ctl .seg button');
    if (lab) {
      var k = lab.parentNode.id.replace('ctl-', ''), v = lab.dataset.v;
      if (k === 'theme') setTheme(v); else { S[k] = v; store(k, v); }
      if (k === 'restart') { clearInterval(flashTimer); S.flash = null; }
      if (k === 'who') { if (S.src === 'project' && S.fw && !find(S.fw)) S.fw = ''; S.flash = null; S.src = v === 'out' ? 'file' : S.fw ? 'project' : S.file ? 'file' : 'project'; }
      return render();
    }
    var el = e.target.closest('[data-act]');
    if (!el || !$('#frame').contains(el)) return;
    if (el.dataset.act === 'unsheet' && e.target.closest('[data-stop]') && e.target !== el) return;
    e.preventDefault();
    var a = el.dataset.act;
    switch (a) {
      case 'tab': S.tab = el.dataset.tab; store('tab', S.tab); S.rail = false; break;
      case 'home': S.tab = 'serial'; break;
      case 'src': S.src = el.dataset.src; S.flash = null; S.rail = false; if (S.tab !== 'serial') S.tab = 'serial'; break;
      case 'pick':
        S.src = 'project'; S.fw = el.dataset.key; S.flash = null; S.rail = false;
        if (S.tab === 'probe') { S.probe.src = 'project'; S.probe.view = 'program'; S.probe.prog = null; } else S.tab = 'serial';
        break;
      case 'file': S.file = { name: 'thermostat-dev.bin', size: '91 KB' }; S.src = 'file'; S.flash = null; break;
      case 'unfile': S.file = null; S.flash = null; break;
      case 'flash': runFlash(); return;
      case 'reflash': S.flash = null; runFlash(); return;
      case 'byhand': runFlash(true); return;
      case 'unflash': clearInterval(flashTimer); S.flash = null; if (S.con.paused) { S.con.paused = false; conLine('— reopened COM5 —'); } break;
      case 'to-console': S.tab = 'console'; if (!S.con.open) openCon(); break;
      case 'signin': S.who = 'fte'; store('who', 'fte'); S.sheet = false; toast('Mock: signed in as an FTE'); break;
      case 'signout': S.who = 'out'; store('who', 'out'); S.sheet = false; S.fw = ''; S.src = 'file'; S.flash = null; break;
      case 'sheet': S.sheet = true; break;
      case 'unsheet': S.sheet = false; break;
      case 'rail': S.rail = !S.rail; break;
      case 'theme': setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); break;
      case 'pkind': S.probe.kind = el.dataset.kind; break;
      case 'pconnect': S.probe.on = !S.probe.on; S.probe.prog = null; break;
      case 'psub': S.probe.view = el.dataset.sub; break;
      case 'psrc': S.probe.src = el.dataset.src; break;
      case 'pprog': runProg(); return;
      case 'cport': if (S.con.open) closeCon(); else openCon(); break;
      case 'cclear': S.con.lines = []; break;
      case 'nop': toast('Mocked in the lab'); return;
    }
    render();
  });
  document.addEventListener('change', function (e) {
    var k = e.target.dataset && e.target.dataset.change; if (!k) return;
    if (k === 'fileboard') S.fileBoard = e.target.value;
    if (k === 'preset') S.probe.reset = e.target.checked;
    if (k === 'khz') S.probe.khz = +e.target.value;
    if (k === 'baud') S.con.baud = +e.target.value;
    if (k === 'stamps') S.con.stamps = e.target.checked;
    if (k === 'cfilter') S.con.filter = e.target.value;
    render();
  });
  document.addEventListener('focusin', function (e) { S.con.focus = e.target.id === 'lx-term'; });
  document.addEventListener('keydown', function (e) {
    if (e.target.id === 'lx-term') return conKey(e);
    if (e.key === 'Escape' && (S.sheet || S.rail)) { S.sheet = S.rail = false; render(); } });

  setTheme(store('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  render();
})();
