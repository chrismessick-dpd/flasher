/* Flasher's Debug probe tab: an ST-LINK (or J-Link) in the browser, as a calmer STM32CubeProgrammer.
   Pages: Device, Memory, Program, Registers, Option bytes, and Log. One operation at a time.
   The page (assets/app.js) loads these files the first time the tab opens and calls
   FL.probeApp.mount(root, host): host.image() is the firmware picked in the sidebar (from GitHub or a
   file), host.changed() redraws the page's tabs, and host.demo is 'g0' or 'h5' in ?demo (the simulated
   probe in fakeprobe.js). Everything here stays inside root. */
(function () {
  'use strict';
  var FL = window.FL, F = FL.files, X = FL.stm32, hex = X.hex;
  var DEMO = null, PREFS_KEY = 'flasher.v1.probe';
  var root = null, host = { image: function () { return null; }, changed: function () {} };
  var $ = function (s, r) { return (r || root || document).querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function parseNum(s) { s = String(s || '').trim().replace(/_/g, ''); if (!s) return NaN; return /^0x/i.test(s) ? parseInt(s, 16) : /^[0-9a-f]+$/i.test(s) && /[a-f]/i.test(s) ? parseInt(s, 16) : /^\d+\s*k$/i.test(s) ? parseInt(s, 10) * 1024 : parseInt(s, 10); }

  var prefs = (function () { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (e) { return {}; } })();
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* storage blocked */ } }

  var S = {
    view: 'device',
    kind: prefs.kind === 'jlink' ? 'jlink' : 'stlink',
    underReset: prefs.underReset !== false,
    khz: prefs.khz || 4000,
    probe: null, target: null, chip: null, voltage: null, speeds: null, core: null, regs: null,
    busy: null, log: [],
    mem: { addr: 0x08000000, size: 4096, data: null, at: 0, page: 0 },
    prog: { img: null, base: 0x08000000, erase: 'sectors', verify: true, reset: true, slow: false, run: null },
    svd: { dev: null, name: '', filter: '', open: {}, values: {}, edits: {}, errors: {} },
    ob: { cur: null, edits: {} }
  };

  // ── Log and toasts ──
  function log(msg, err) {
    var d = new Date(), t = d.toTimeString().slice(0, 8);
    S.log.push({ t: t, msg: msg, err: !!err });
    if (S.log.length > 2000) S.log.splice(0, S.log.length - 2000);
    var box = $('#pb-log-lines'); if (box) { box.insertAdjacentHTML('beforeend', line(S.log[S.log.length - 1])); box.scrollTop = box.scrollHeight; }
  }
  function line(l) { return '<div' + (l.err ? ' class="e"' : '') + '><span class="t">' + l.t + '</span> ' + esc(l.msg) + '</div>'; }
  function toast(text, bad) {
    var el = document.createElement('div'); el.className = 'toast' + (bad ? ' toast-bad' : ''); el.textContent = (bad ? '✕ ' : '') + text;
    document.getElementById('toasts').appendChild(el); setTimeout(function () { el.remove(); }, bad ? 7000 : 3500);
  }

  // One operation at a time. fn gets nothing; errors are logged and shown.
  async function op(name, fn) {
    if (S.busy) { toast('Wait for “' + S.busy + '” to finish.'); return; }
    S.busy = name; render();
    try { return await fn(); }
    catch (e) { log(name + ': ' + (e.message || e), true); toast(e.message || String(e), true); if (/stopped answering|disconnected|NetworkError|transfer/i.test(e.message || '')) dropProbe(); }
    finally { S.busy = null; render(); }
  }

  // ── Probe and target ──
  function probeClass() { return S.kind === 'jlink' ? FL.jlink.JLink : FL.stlink.StLink; }
  function filters() { return S.kind === 'jlink' ? FL.jlink.FILTERS : FL.stlink.FILTERS; }
  function matches(d) { return S.kind === 'jlink' ? FL.jlink.is(d) : FL.stlink.is(d); }

  async function pickDevice() {
    if (DEMO) return new FL.fakeprobe.FakeStLink(DEMO === 'h5' ? 'h5' : 'g0', { empty: true });
    if (!navigator.usb) throw new Error('This browser has no WebUSB. Use Chrome or Edge on a computer.');
    var known = (await navigator.usb.getDevices()).filter(matches);
    if (known.length === 1) return known[0];
    return navigator.usb.requestDevice({ filters: filters() });
  }

  async function connect() {
    await op('Connect', async function () {
      if (!S.probe) {
        var dev;
        try { dev = await pickDevice(); }
        catch (e) { if (e.name === 'NotFoundError') { log('No probe picked.'); return; } throw e; }
        var P = probeClass(), p = new P(dev, {});
        var info = await p.open();
        S.probe = p;
        log('Opened ' + info.name + (info.firmware ? ' (firmware ' + info.firmware + ')' : '') + (info.serial ? ', serial ' + info.serial : ''));
        try { S.speeds = await p.speeds(); } catch (e) { S.speeds = null; }
      }
      try { S.voltage = await S.probe.voltage(); log('Target voltage ' + (S.voltage == null ? '?' : S.voltage.toFixed(2) + ' V')); } catch (e) { S.voltage = null; }
      if (S.voltage != null && S.voltage < 1.5) throw new Error('The target reads ' + S.voltage.toFixed(2) + ' V. Is it powered, and is the probe\'s VDD pin connected to it?');
      var t = new FL.target.Target(S.probe, { log: log });
      S.chip = await t.connect({ underReset: S.underReset, khz: S.khz });
      S.target = t;
      var c = S.chip;
      log('Chip: ' + c.name + ', ' + c.core + (c.flashSize ? ', ' + F.fmtBytes(c.flashSize) + ' flash' : '') + (c.protection ? ', ' + c.protection : ''));
      if (c.svd && (!S.svd.dev || S.svd.name !== c.svd)) loadBundledSvd(c.svd);
      if (c.family && S.mem.addr === 0x08000000 && !S.mem.data) S.mem.addr = c.flashBase;
      S.ob = { cur: null, edits: {} };
      await refreshCore();
    });
  }

  async function disconnect(keepProbe) {
    var t = S.target, p = S.probe;
    S.target = null; S.chip = null; S.core = null; S.regs = null;
    // Switch debug off if this session switched it on (a halt, run, or reset), so a stray BKPT can't stop the chip later.
    try { if (t && t.touched) { await t.release(); log('Switched debug off; the core runs on its own.'); } } catch (e) { /* gone */ }
    if (!keepProbe && p) { try { await p.close(); } catch (e) { /* gone */ } S.probe = null; S.voltage = null; S.speeds = null; log('Disconnected.'); }
    else if (p) { try { await p.disconnect(); } catch (e) { /* gone */ } }
    render();
  }
  function dropProbe() { S.target = null; S.chip = null; S.core = null; S.probe = null; }

  async function refreshCore() {
    if (!S.target) return;
    try { S.core = await S.target.status(); } catch (e) { S.core = null; }
    S.regs = null;
  }
  function needTarget() { if (!S.target) throw new Error('Connect to a target first.'); }
  function needFamily() { needTarget(); if (!S.chip.family) throw new Error('Flasher doesn\'t know this chip\'s flash (' + S.chip.name + '). Memory and registers still work.'); }

  // ── Rendering ──
  var PAGES = [
    ['device', 'Device', '<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M7 1.5V4M13 1.5V4M7 16v2.5M13 16v2.5M1.5 7H4M1.5 13H4M16 7h2.5M16 13h2.5"/>'],
    ['memory', 'Memory', '<path d="M3 4h14M3 8h14M3 12h14M3 16h9"/>'],
    ['program', 'Erase & program', '<path d="M10 3v9M6 8l4 4 4-4"/><path d="M4 15.5h12"/>'],
    ['registers', 'Registers', '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 8h14M8 8v9"/>'],
    ['options', 'Option bytes', '<path d="M4 6h8M15 6h1M4 14h1M8 14h8"/><circle cx="13.5" cy="6" r="1.8"/><circle cx="6.5" cy="14" r="1.8"/>'],
    ['log', 'Log', '<path d="M5 3h10v14H5z"/><path d="M8 7h4M8 10h4M8 13h2"/>']
  ];
  function stripHtml() {
    var on = !!S.target, b = S.busy;
    var speeds = (S.speeds && S.speeds.length ? S.speeds : [24000, 8000, 4000, 1800, 1000, 480, 100]);
    if (speeds.indexOf(S.khz) < 0) speeds = speeds.concat([S.khz]).sort(function (a, x) { return x - a; });
    return '<div class="card fl-pad pb-conn"><div class="pb-conn-row">' +
      '<div class="seg" title="Which probe"><button type="button" data-act="kind" data-kind="stlink" class="' + (S.kind === 'stlink' ? 'on' : '') + '"' + (S.probe ? ' disabled' : '') + '>ST-LINK</button>' +
      '<button type="button" data-act="kind" data-kind="jlink" title="Experimental: connects and reads; long transfers have rebooted a J-Link V13 into its bootloader" class="' + (S.kind === 'jlink' ? 'on' : '') + '"' + (S.probe || DEMO ? ' disabled' : '') + '>J-Link (beta)</button></div>' +
      '<label class="pb-check" title="Hold NRST low while connecting, so the application never runs (needs NRST wired to the probe)"><input type="checkbox" data-change="under-reset"' + (S.underReset ? ' checked' : '') + (on ? ' disabled' : '') + '> Under reset</label>' +
      '<select class="input" data-change="khz" title="SWD clock"' + (on ? ' disabled' : '') + '>' + speeds.map(function (k) { return '<option value="' + k + '"' + (k === S.khz ? ' selected' : '') + '>' + (k >= 1000 ? k / 1000 + ' MHz' : k + ' kHz') + '</option>'; }).join('') + '</select>' +
      '<span class="grow"></span>' +
      (on ? '<button class="btn" data-act="disconnect"' + (b ? ' disabled' : '') + '>Disconnect</button>' : '<button class="btn btn-primary" data-act="connect"' + (b ? ' disabled' : '') + '>Connect</button>') +
      '</div><div class="pb-conn-status"><span class="sync-dot' + (b ? ' pb-run' : on ? ' pb-ok' : '') + '"></span>' + esc(status().text) + '</div></div>';
  }
  function subtabsHtml() {
    return '<div class="fl-tabs" role="tablist" aria-label="Probe pages">' + PAGES.map(function (p) {
      return '<button type="button" role="tab" aria-selected="' + (S.view === p[0]) + '" class="' + (S.view === p[0] ? 'on' : '') + '" data-act="view" data-view="' + p[0] + '">' + p[1] + '</button>';
    }).join('') + '</div>';
  }
  // For the page's top bar: whether a target is connected, and what to say about it.
  function status() {
    var c = S.chip;
    return { on: !!S.target, busy: !!S.busy, text: S.busy ? S.busy + '…' : S.target ? c.name.split('/')[0] + (S.voltage != null ? ' · ' + S.voltage.toFixed(2) + ' V' : '') + ' · ' + S.probe.info.name : S.probe ? S.probe.info.name + ' · no target' : 'No probe' };
  }
  function render() {
    if (!root) return;
    var main = document.getElementById('main'), y = main ? main.scrollTop : 0, focus = document.activeElement && document.activeElement.id;
    // Laid out as the Serial bootloader tab is (Chris, 2026-11-17): the page's heading, the probe's
    // connection as a card, then one panel whose tabs are the probe's pages.
    root.innerHTML = '<div class="page"><div class="page-head"><div class="page-head-text"><div class="eyebrow">' + (DEMO ? 'Debug probe · simulated ST-LINK' : 'Debug probe') + '</div>' +
      '<h1 class="page-title">' + esc(S.chip ? S.chip.name.split('/')[0] : 'Connect a probe') + '</h1><div class="page-sub">Wire an ST-LINK or J-Link to the board, and read, program, and debug the chip from Chrome or Edge. Everything runs in the browser, with no IDE or programming software to install.</div></div></div>' +
      stripHtml() + '<div class="card fl-panel pb-panel">' + subtabsHtml() + '<div class="fl-tab-body">' +
      ({ device: viewDevice, memory: viewMemory, program: viewProgram, registers: viewRegisters, options: viewOptions, log: viewLog }[S.view])() + '</div></div></div>';
    if (main && !root.hidden) main.scrollTop = y;
    if (focus && $('#' + focus)) $('#' + focus).focus();
    var box = $('#pb-log-lines'); if (box) box.scrollTop = box.scrollHeight;
    host.changed();
  }
  // Each page's lead-in, under its tab (the page's heading is drawn once, in render).
  function head(eyebrow, title, sub) { return sub ? '<p class="fl-intro pb-lead">' + sub + '</p>' : ''; }
  function dis() { return S.busy ? ' disabled' : ''; }
  function recentLog() {
    return '<div class="card pb-recent"><pre class="pb-log" id="pb-log-lines">' + S.log.slice(-40).map(line).join('') + '</pre></div>';
  }
  function notConnected(what) {
    return '<div class="card empty"><h2>Not connected</h2><p>' + esc(what) + ' Plug in the probe, wire it to the board (SWDIO, SWCLK, GND, VDD, and NRST for Under reset), and click <b>Connect</b>.</p>' +
      '<p class="fl-muted">' + (navigator.usb || DEMO ? 'The first time, Chrome asks which probe to use.' : 'This browser has no WebUSB: use Chrome or Edge.') + '</p></div>';
  }

  function viewDevice() {
    var h = '';
    if (!S.probe) return h + notConnected('No probe is open.') + recentLog();
    var p = S.probe.info, c = S.chip, core = S.core;
    h += '<div class="pb-grid"><div class="card fl-pad"><h2 class="pb-card-title">Probe</h2><dl class="pb-kv">' +
      '<dt>Probe</dt><dd>' + esc(p.name) + '</dd>' + (p.firmware ? '<dt>Firmware</dt><dd>' + esc(p.firmware) + '</dd>' : '') + (p.serial ? '<dt>Serial</dt><dd class="fl-mono">' + esc(p.serial) + '</dd>' : '') +
      '<dt>Target voltage</dt><dd>' + (S.voltage == null ? '?' : S.voltage.toFixed(2) + ' V') + '</dd>' +
      (S.target ? '<dt>SWD clock</dt><dd>' + (S.probe.khz >= 1000 ? S.probe.khz / 1000 + ' MHz' : S.probe.khz + ' kHz') + '</dd>' : '') + '</dl></div>';
    if (c) {
      h += '<div class="card fl-pad"><h2 class="pb-card-title">Target' + (core ? ' <span class="pb-state' + (core.halted ? ' halted' : '') + '">' + (core.halted ? 'Halted' : core.lockup ? 'Locked up' : core.sleeping ? 'Sleeping' : 'Running') + '</span>' : '') + '</h2><dl class="pb-kv">' +
        '<dt>Chip</dt><dd>' + esc(c.name) + '</dd><dt>Core</dt><dd>' + esc(c.core) + ' (AP' + c.ap + ')</dd>' +
        '<dt>Device ID</dt><dd class="fl-mono">' + hex(c.devId, 3) + ', revision ' + hex(c.revId, 4) + '</dd>' +
        (c.flashSize ? '<dt>Flash</dt><dd>' + F.fmtBytes(c.flashSize) + ' at ' + hex(c.flashBase) + (c.dual ? ', two banks' : '') + ', ' + F.fmtBytes(c.sectorSize) + ' ' + (c.family.id === 'h5' ? 'sectors' : 'pages') + (c.swapped ? ', <b>banks swapped</b>' : '') + '</dd>' : '') +
        (c.uid ? '<dt>Unique ID</dt><dd class="fl-mono">' + esc(c.uid) + '</dd>' : '') +
        (c.protection ? '<dt>Protection</dt><dd>' + esc(c.protection) + '</dd>' : '') + '</dl>' +
        '<div class="fl-row"><button class="btn" data-act="halt"' + dis() + '>Halt</button><button class="btn" data-act="run"' + dis() + '>Run</button>' +
        '<button class="btn" data-act="reset-halt"' + dis() + '>Reset and halt</button><button class="btn" data-act="reset-run"' + dis() + '>Reset and run</button>' +
        '<button class="btn" data-act="hard-reset"' + dis() + ' title="Pulse NRST">Hardware reset</button><button class="btn" data-act="refresh"' + dis() + '>Refresh</button></div></div>';
    } else h += '<div class="card fl-pad"><h2 class="pb-card-title">Target</h2><p class="fl-muted">Not connected. Click Connect.</p></div>';
    h += '</div>';
    if (c && core && core.halted) {
      h += '<div class="card fl-pad"><h2 class="pb-card-title">Core registers</h2>';
      if (S.regs) h += '<dl class="pb-kv" style="grid-template-columns:repeat(4,max-content 1fr)">' + FL.target.REGS.map(function (r) { return '<dt>' + r + '</dt><dd class="fl-mono">' + hex(S.regs[r]) + '</dd>'; }).join('') + '</dl>';
      h += '<div class="fl-row"><button class="btn" data-act="read-core"' + dis() + '>' + (S.regs ? 'Read again' : 'Read core registers') + '</button></div></div>';
    }
    return h + recentLog();
  }

  function viewMemory() {
    var h = head('Memory', 'Read and save memory', 'Read any range (flash, RAM, or peripherals), see it as hex, and save it as .bin or .hex. Writes here are for RAM and registers; flash is written on <a href="#" data-act="view" data-view="program">Erase &amp; program</a>.');
    if (!S.target) return h + notConnected('Memory needs a target.');
    var m = S.mem, c = S.chip;
    h += '<div class="card fl-pad"><div class="pb-fields">' +
      '<div class="field"><label for="m-addr">Address</label><input class="input" id="m-addr" value="' + hex(m.addr) + '"></div>' +
      '<div class="field"><label for="m-size">Size</label><input class="input" id="m-size" value="' + (m.size % 1024 ? m.size : m.size / 1024 + 'K') + '"></div>' +
      '<button class="btn btn-primary" data-act="mem-read"' + dis() + '>Read</button>' +
      (c.flashSize ? '<button class="btn" data-act="mem-all"' + dis() + '>Whole flash</button>' : '') +
      '</div>' + (S.prog.run && S.busy === 'Read memory' ? progressBar(S.prog.run) : '') + '</div>';
    if (m.data) {
      var PAGE = 4096, pages = Math.ceil(m.data.length / PAGE), pg = Math.min(m.page, pages - 1), off = pg * PAGE;
      h += '<div class="pb-pager"><b class="fl-mono">' + hex(m.at) + ' – ' + hex(m.at + m.data.length - 1) + '</b> <span class="fl-muted">' + F.fmtBytes(m.data.length) + '</span>' +
        '<span class="fl-grow"></span><button class="btn" data-act="mem-save-bin">Save .bin</button><button class="btn" data-act="mem-save-hex">Save .hex</button></div>';
      if (pages > 1) h += '<div class="pb-pager"><button class="btn" data-act="mem-page" data-d="-1"' + (pg ? '' : ' disabled') + '>‹ Previous</button><span class="fl-muted">Page ' + (pg + 1) + ' of ' + pages + '</span><button class="btn" data-act="mem-page" data-d="1"' + (pg < pages - 1 ? '' : ' disabled') + '>Next ›</button>' +
        '<span class="fl-grow"></span><input class="input" id="m-goto" placeholder="Go to address" style="width:150px"><button class="btn" data-act="mem-goto">Go</button></div>';
      h += '<div class="card"><pre class="pb-hex">' + hexDump(m.data, off, Math.min(PAGE, m.data.length - off), m.at) + '</pre></div>';
    }
    h += '<div class="card fl-pad"><h2 class="pb-card-title">Write a word</h2><div class="pb-fields">' +
      '<div class="field"><label for="w-addr">Address</label><input class="input" id="w-addr" placeholder="0x20000000"></div>' +
      '<div class="field"><label for="w-val">Value (32-bit)</label><input class="input" id="w-val" placeholder="0x00000000"></div>' +
      '<button class="btn" data-act="mem-write"' + dis() + '>Write</button></div><p class="fl-muted fl-help">Writes one 32-bit word: RAM or a peripheral register. Flash addresses are refused here.</p></div>';
    return h + recentLog();
  }
  function hexDump(d, off, n, base) {
    var out = [];
    for (var i = off; i < off + n; i += 16) {
      var bytes = [], chars = '';
      for (var j = 0; j < 16; j++) {
        if (i + j >= off + n) { bytes.push('  '); continue; }
        var b = d[i + j], s = b.toString(16).toUpperCase().padStart(2, '0');
        bytes.push(b === 0xFF ? '<span class="z">' + s + '</span>' : s);
        chars += b >= 32 && b < 127 ? esc(String.fromCharCode(b)) : '.';
      }
      out.push('<span class="a">' + (base + i).toString(16).toUpperCase().padStart(8, '0') + '</span>  ' + bytes.slice(0, 8).join(' ') + '  ' + bytes.slice(8).join(' ') + '  <span class="c">' + chars + '</span>');
    }
    return out.join('\n');
  }
  function progressBar(run) {
    return '<div class="busy-bar fl-bar" style="margin-top:12px"><i style="width:' + Math.round((run.pct || 0) * 100) + '%"></i></div><div class="fl-step-sub fl-phase">' + esc(run.phase || '') + '</div>';
  }

  function viewProgram() {
    var g = S.prog, img = g.img, c = S.chip;
    var h = head('Erase & program', 'Program firmware', 'The firmware picked in the list on the left (from GitHub once signed in), or a .bin, .hex, .elf, or .srec file. Erase, write, verify, and start it. By default only the pages or sectors the image covers are erased, so a bootloader elsewhere in flash is kept.');
    var im = host.image(), listed = g.listed, offerable = im && !im.why && !(listed && listed.key === listedKey(im));
    h += '<div class="card fl-pad"><div class="fl-row" style="margin-top:0">' +
      (offerable ? '<button class="btn btn-primary" data-act="use-listed"' + dis() + '>Use ' + esc(im.title) + '</button>' : '') +
      '<button class="btn' + (offerable ? '' : ' btn-primary') + '" data-act="open-file"' + dis() + '>Open a file…</button>' +
      (img ? '<b>' + esc(img.name) + '</b><span class="fl-muted">' + esc((listed ? 'from ' + listed.from + (listed.board ? ' · ' + listed.board : '') + ' · ' : img.format + ' · ') + F.fmtBytes(img.size)) + '</span>'
        : '<span class="fl-muted">' + esc(g.listNote || 'Pick firmware in the list, or open a file.') + '</span>') + '</div>';
    if (img && g.listNote) h += '<p class="fl-muted fl-help">' + esc(g.listNote) + '</p>';
    var mis = img ? chipMismatch() : '';
    if (mis) h += '<div class="hint fl-warn" style="margin-top:12px"><b>Another chip</b>' + esc(img.name) + ' is built for the ' + esc(mis) + '; the probe is on the ' + esc(c.name) + '.</div>';
    if (img) {
      if (img.needsBase) h += '<div class="pb-fields" style="margin-top:12px"><div class="field"><label for="p-base">Load address for the .bin</label><input class="input" id="p-base" value="' + hex(g.base) + '"></div></div>';
      h += '<table class="pb-seg" style="margin-top:12px"><thead><tr><th>Segment</th><th>From</th><th>To</th><th>Size</th></tr></thead><tbody>' +
        segs().map(function (s, i) { return '<tr><td>' + (i + 1) + '</td><td class="fl-mono">' + hex(s.addr) + '</td><td class="fl-mono">' + hex(s.addr + s.data.length - 1) + '</td><td>' + F.fmtBytes(s.data.length) + '</td></tr>'; }).join('') + '</tbody></table>';
      if (img.entry != null) h += '<p class="fl-muted fl-help">Entry point ' + hex(img.entry) + '.</p>';
      var plan = c && c.family ? erasePlan() : null;
      if (plan && plan.outside) h += '<div class="hint fl-bad" style="margin-top:12px"><b>Outside the flash.</b> ' + esc(plan.outside) + '</div>';
      h += '<div class="pb-opts">' +
        '<label class="pb-check"><input type="radio" name="erase" data-change="erase" value="sectors"' + (g.erase === 'sectors' ? ' checked' : '') + '> Erase only what the image covers' + (plan && plan.list ? ' (' + plan.list.length + ' ' + (c.family.id === 'h5' ? 'sectors' : 'pages') + ', ' + hex(plan.lo) + ' to ' + hex(plan.hi - 1) + ')' : '') + '</label>' +
        '<label class="pb-check"><input type="radio" name="erase" data-change="erase" value="mass"' + (g.erase === 'mass' ? ' checked' : '') + '> Erase the whole flash first (mass erase)</label>' +
        '<label class="pb-check"><input type="checkbox" data-change="verify"' + (g.verify ? ' checked' : '') + '> Verify by reading it back</label>' +
        '<label class="pb-check"><input type="checkbox" data-change="reset"' + (g.reset ? ' checked' : '') + '> Reset and run when done</label>' +
        '<label class="pb-check" title="Write one unit at a time and wait for each. Slower; use it if streamed writes fail."><input type="checkbox" data-change="slow"' + (g.slow ? ' checked' : '') + '> Careful write (one unit at a time)</label></div>' +
        '<div class="fl-row"><button class="btn btn-primary" data-act="program"' + (S.target && !S.busy ? '' : ' disabled') + '>Erase and program</button>' +
        '<button class="btn" data-act="verify-only"' + (S.target && !S.busy ? '' : ' disabled') + '>Compare with the chip</button></div>';
    }
    if (img || (g.run && g.run.kind)) h += '<div id="pb-route" style="margin-top:16px">' + progRoute() + '</div>';
    else if (g.run) h += progressBar(g.run);
    if (g.run) h += (g.run.done ? '<div class="hint ' + (g.run.ok ? 'fl-good' : 'fl-bad') + ' pb-result"><b>' + esc(g.run.ok ? 'Done.' : 'Failed.') + '</b> ' + esc(g.run.msg || '') + '</div>' : '');
    h += '</div>';
    h += '<div class="card fl-pad"><h2 class="pb-card-title">Erase only</h2><div class="pb-fields">' +
      '<div class="field"><label for="e-from">From</label><input class="input" id="e-from" placeholder="0x08000000"></div>' +
      '<div class="field"><label for="e-to">To (exclusive)</label><input class="input" id="e-to" placeholder="0x08004000"></div>' +
      '<button class="btn" data-act="erase-range"' + (S.target && !S.busy ? '' : ' disabled') + '>Erase range</button>' +
      '<button class="btn" data-act="mass-erase"' + (S.target && !S.busy ? '' : ' disabled') + '>Erase the whole flash…</button></div>' +
      '<p class="fl-muted fl-help">A range is rounded out to whole ' + (c && c.family && c.family.id === 'h5' ? '8 KB sectors' : 'pages') + '.</p></div>';
    if (!S.target) h += notConnected('Programming needs a target.');
    return h + recentLog();
  }
  function segs() {
    var img = S.prog.img; if (!img) return [];
    if (img.needsBase) return [{ addr: S.prog.base >>> 0, data: img.segments[0].data }];
    return img.segments;
  }
  function erasePlan() {
    var c = S.chip, ss = segs(), out = { list: [] };
    if (!ss.length) return out;
    var lo = ss[0].addr, hi = ss[ss.length - 1].addr + ss[ss.length - 1].data.length;
    out.lo = lo; out.hi = hi;
    var bad = ss.filter(function (s) { return s.addr < c.flashBase || s.addr + s.data.length > c.flashBase + c.flashSize; });
    if (bad.length) { out.outside = 'Segment at ' + hex(bad[0].addr) + ' is not inside this chip\'s flash (' + hex(c.flashBase) + ' to ' + hex(c.flashBase + c.flashSize - 1) + '). Flasher programs flash only.'; return out; }
    var seen = {};
    ss.forEach(function (s) { X.sectorsFor(c, s.addr, s.addr + s.data.length).forEach(function (x) { if (!seen[x.addr]) { seen[x.addr] = 1; out.list.push(x); } }); });
    out.lo = out.list[0].addr; out.hi = out.list[out.list.length - 1].addr + out.list[out.list.length - 1].size;
    return out;
  }

  // ── Registers ──
  function viewRegisters() {
    var v = S.svd, dev = v.dev;
    var h = head('Registers', dev ? dev.name + ' registers' : 'Registers', 'Peripheral registers from ST\'s SVD files. Nothing is read until you open a peripheral or click Read; registers whose read changes them (FIFOs, flags cleared on read) are only read when you ask for that one.');
    h += '<div class="pb-reg-tools"><input class="input" type="search" id="r-filter" placeholder="Filter peripherals and registers" value="' + esc(v.filter) + '" data-change="r-filter">' +
      '<button class="btn" data-act="open-svd">Open an SVD file…</button>' + (dev ? '<span class="fl-muted">' + esc(v.name) + ' · ' + dev.p.length + ' peripherals</span>' : '') + '</div>';
    if (!dev) return h + '<div class="card empty"><h2>No register file</h2><p>Connect to a G0B1 or H563 to load its registers, or open an SVD file for another chip.</p></div>' + recentLog();
    var f = v.filter.trim().toUpperCase();
    var list = dev.p.filter(function (p) { return !f || p.n.toUpperCase().indexOf(f) >= 0 || (p.g || '').toUpperCase().indexOf(f) >= 0 || p.r.some(function (r) { return r.n.toUpperCase().indexOf(f) >= 0; }); });
    h += list.map(function (p) {
      var open = !!v.open[p.n] || (f && list.length <= 3);
      return '<details class="card pb-periph" data-periph="' + esc(p.n) + '"' + (open ? ' open' : '') + '><summary><span class="pb-pname">' + esc(p.n) + '</span><span class="fl-mono fl-muted">' + hex(p.b) + '</span><span class="pb-pdesc">' + esc(p.d || p.g || '') + '</span></summary>' +
        (open ? '<div class="pb-regs"><div class="fl-row" style="margin:0 0 6px"><button class="btn" data-act="r-read-all" data-p="' + esc(p.n) + '"' + (S.target ? dis() : ' disabled') + '>Read all</button><span class="fl-muted">' + p.r.length + ' registers</span></div>' +
          (S.svd.stale && S.svd.stale[p.n] ? '<div class="hint fl-warn" style="margin-bottom:8px"><b>Clock off?</b> Every register read the same value. A peripheral whose clock is off in RCC returns stale bus data; turn its clock on (RCC) and read again.</div>' : '') +
          p.r.filter(function (r) { return !f || p.n.toUpperCase().indexOf(f) >= 0 || r.n.toUpperCase().indexOf(f) >= 0; }).map(function (r) { return regRow(p, r); }).join('') + '</div>' : '') + '</details>';
    }).join('');
    if (!list.length) h += '<p class="fl-muted">Nothing matches.</p>';
    return h + recentLog();
  }
  function regKey(p, r) { return p.n + '.' + r.n; }
  function regRow(p, r) {
    var v = S.svd, k = regKey(p, r), val = v.values[k], ed = v.edits[k], shown = ed !== undefined ? ed : val;
    var ro = r.a === 'read-only', wo = r.a === 'write-only', se = FL.svd.sideEffects(r);
    var h = '<div class="pb-reg" data-reg="' + esc(k) + '"><div class="pb-reg-head"><span class="pb-rname" data-act="r-read" data-k="' + esc(k) + '" title="Read">' + esc(r.n) + '</span>' +
      '<span class="pb-raddr">' + hex(p.b + r.o) + '</span>' +
      '<input class="input' + (ed !== undefined && ed !== val ? ' pb-changed' : '') + '" data-change="r-val" data-k="' + esc(k) + '" value="' + (shown === undefined ? '' : hex(shown)) + '" placeholder="' + (wo ? 'write-only' : 'not read') + '"' + (ro ? ' readonly' : '') + '>' +
      (wo ? '' : '<button class="btn" data-act="r-read" data-k="' + esc(k) + '"' + (S.target ? dis() : ' disabled') + '>Read</button>') +
      (ro ? '' : '<button class="btn" data-act="r-write" data-k="' + esc(k) + '"' + (S.target && ed !== undefined ? dis() : ' disabled') + '>Write</button>') +
      (se ? '<span class="pb-se" title="Reading this register changes it (a FIFO pops or a flag clears). Read all skips it.">read has side effects</span>' : '') +
      (v.errors[k] ? '<span class="pb-err">' + esc(v.errors[k]) + '</span>' : '') +
      '<span class="pb-rdesc">' + esc(r.d || '') + '</span></div>';
    if (shown !== undefined && r.f.length) {
      h += '<table class="pb-flds"><tbody>' + r.f.slice().reverse().map(function (f) {
        var fv = FL.svd.fieldValue(shown, f), fro = ro || f.a === 'read-only';
        var bits = f.w === 1 ? '[' + f.l + ']' : '[' + (f.l + f.w - 1) + ':' + f.l + ']', ctl;
        if (fro) ctl = '<span class="ro">' + (f.e && f.e[fv] ? esc(f.e[fv]) : (f.w > 4 ? hex(fv, Math.ceil(f.w / 4)) : fv)) + '</span>';
        else if (f.e && Object.keys(f.e).length) {
          ctl = '<select data-change="r-field" data-k="' + esc(k) + '" data-l="' + f.l + '" data-w="' + f.w + '">' + Object.keys(f.e).map(function (ev) { return '<option value="' + ev + '"' + (+ev === fv ? ' selected' : '') + '>' + esc(ev + ': ' + f.e[ev]) + '</option>'; }).join('') +
            (f.e[fv] === undefined ? '<option value="' + fv + '" selected>' + fv + '</option>' : '') + '</select>';
        } else if (f.w === 1) ctl = '<input type="checkbox" data-change="r-field" data-k="' + esc(k) + '" data-l="' + f.l + '" data-w="1"' + (fv ? ' checked' : '') + '>';
        else ctl = '<input data-change="r-field" data-k="' + esc(k) + '" data-l="' + f.l + '" data-w="' + f.w + '" value="' + (f.w > 4 ? hex(fv, Math.ceil(f.w / 4)) : fv) + '" size="10">';
        return '<tr><td>' + esc(f.n) + '</td><td class="bits">' + bits + '</td><td>' + ctl + '</td><td class="fl-muted">' + esc(f.d || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    return h + '</div>';
  }
  function findReg(k) {
    var dot = k.indexOf('.'), pn = k.slice(0, dot), rn = k.slice(dot + 1), p = S.svd.dev.p.filter(function (x) { return x.n === pn; })[0];
    return { p: p, r: p.r.filter(function (x) { return x.n === rn; })[0] };
  }
  async function readReg(k, quiet) {
    var x = findReg(k), a = x.p.b + x.r.o, size = x.r.s || 32;
    try {
      var v;
      if (size === 32) v = await S.target.r32(a);
      else { var b = await S.target.read(a, size / 8); v = b[0] | (size > 8 ? b[1] << 8 : 0); }
      S.svd.values[k] = v >>> 0; delete S.svd.edits[k]; delete S.svd.errors[k];
    } catch (e) {
      S.svd.errors[k] = /fault|error/i.test(e.message) ? 'Bus fault: is the peripheral\'s clock on?' : e.message;
      if (!quiet) throw e;
    }
  }
  async function loadBundledSvd(name) {
    try { S.svd.dev = await FL.svd.bundled(name); S.svd.name = name + ' (bundled)'; S.svd.values = {}; S.svd.edits = {}; S.svd.errors = {}; log('Loaded the ' + name + ' register file.'); render(); }
    catch (e) { log(e.message, true); }
  }

  // ── Option bytes ──
  function viewOptions() {
    var h = head('Option bytes', 'Option bytes', 'The chip\'s fuses: protection, resets, watchdogs, boot, and write protection. Change a field, review the list of changes, and confirm. Settings that can lock a chip for good are shown but never written.');
    if (!S.target) return h + notConnected('Option bytes need a target.');
    var c = S.chip;
    if (!c.family) return h + '<div class="card empty"><h2>Unknown chip</h2><p>Flasher knows the option bytes of the STM32G0B1 and STM32H563 so far.</p></div>' + recentLog();
    var o = S.ob;
    h += '<div class="card fl-pad"><div class="fl-row" style="margin-top:0"><button class="btn' + (o.cur ? '' : ' btn-primary') + '" data-act="ob-read"' + dis() + '>' + (o.cur ? 'Read again' : 'Read option bytes') + '</button>' +
      (o.cur ? '<span class="fl-muted">' + Object.keys(o.edits).length + ' changed</span><span class="fl-grow"></span><button class="btn" data-act="ob-reset"' + (Object.keys(o.edits).length ? '' : ' disabled') + '>Undo changes</button><button class="btn btn-primary" data-act="ob-review"' + (Object.keys(o.edits).length && !S.busy ? '' : ' disabled') + '>Review and write…</button>' : '') + '</div></div>';
    if (!o.cur) return h + recentLog();
    h += '<div class="card table-scroll"><table class="pb-ob"><thead><tr><th>Setting</th><th>Now</th><th>New</th></tr></thead><tbody>' + c.family.options.filter(function (f) { return o.cur[f.key] !== undefined; }).map(function (f) {
      var cur = o.cur[f.key], ed = o.edits[f.key], next = ed !== undefined ? ed : cur, ctl;
      if (f.refuse) ctl = '<span class="refused" title="' + esc(f.refuse) + '">Not changed by Flasher</span>';
      else if (f.values) {
        var vals = Object.assign({}, f.values); if (vals[next] === undefined) vals[next] = (f.show ? f.show(next) : hex(next, 2));
        ctl = '<select data-change="ob" data-k="' + f.key + '">' + Object.keys(vals).map(function (v) { return '<option value="' + v + '"' + (+v === next ? ' selected' : '') + '>' + esc(vals[v]) + '</option>'; }).join('') + '</select>';
      } else ctl = '<input data-change="ob" data-k="' + f.key + '" value="' + (f.num ? next : f.addr ? hex(next << 8) : hex(next, Math.ceil(f.width / 4))) + '" size="12">';
      return '<tr' + (ed !== undefined ? ' class="changed"' : '') + '><td>' + esc(f.label) + '<div class="k">' + f.key + '</div></td><td>' + esc(showOpt(f, cur)) + '</td><td>' + ctl + '</td></tr>';
    }).join('') + '</tbody></table></div>';
    return h + recentLog();
  }
  function showOpt(f, v) {
    if (f.show) return f.show(v);
    if (f.values && f.values[v] !== undefined) return f.values[v];
    if (f.addr) return hex(v << 8);
    if (f.num) return String(v);
    return hex(v, Math.ceil(f.width / 4));
  }
  function optField(k) { return S.chip.family.options.filter(function (f) { return f.key === k; })[0]; }

  function viewLog() {
    return head('Log', 'Log', 'Everything this page did with the probe, newest last.') +
      '<div class="fl-row" style="margin:0 0 10px"><button class="btn" data-act="log-copy">Copy</button><button class="btn" data-act="log-clear">Clear</button></div>' +
      '<div class="card"><pre class="pb-log" id="pb-log-lines">' + S.log.map(line).join('') + '</pre></div>';
  }

  // ── Sheets ──
  function sheet(html) {
    var sr = document.getElementById('sheet-root');
    sr.innerHTML = '<div class="sheet-wrap"><div class="sheet" role="dialog" aria-modal="true">' + html + '</div></div>';
    return sr.querySelector('.sheet');
  }
  function closeSheet() { document.getElementById('sheet-root').innerHTML = ''; }
  function confirmSheet(title, body, word, okLabel) {
    return new Promise(function (resolve) {
      var w = sheet('<div class="sheet-head"><h2>' + esc(title) + '</h2></div><div class="sheet-body">' + body +
        (word ? '<div class="field" style="margin-top:14px"><label for="c-word">Type <b>' + esc(word) + '</b> to confirm</label><input class="input" id="c-word" autocomplete="off"></div>' : '') +
        '</div><div class="sheet-foot"><button class="btn" data-x="no">Cancel</button><button class="btn ' + (word ? 'btn-danger' : 'btn-primary') + '" data-x="yes"' + (word ? ' disabled' : '') + '>' + esc(okLabel || 'Continue') + '</button></div>');
      var inp = w.querySelector('#c-word'), yes = w.querySelector('[data-x=yes]');
      if (inp) { inp.addEventListener('input', function () { yes.disabled = inp.value.trim().toUpperCase() !== word.toUpperCase(); }); inp.focus(); }
      w.addEventListener('click', function (e) { var b = e.target.closest('[data-x]'); if (!b || b.disabled) return; closeSheet(); resolve(b.dataset.x === 'yes'); });
      document.querySelector('#sheet-root .sheet-wrap').addEventListener('click', function (e) { if (e.target === e.currentTarget) { closeSheet(); resolve(false); } });
    });
  }

  // ── Actions ──
  function download(name, data, type) {
    var url = URL.createObjectURL(new Blob([data], { type: type || 'application/octet-stream' }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function chipTag() { return (S.chip ? S.chip.name.split('/')[0].replace(/[^A-Za-z0-9]+/g, '') : 'chip'); }

  async function memRead(addr, size) {
    if (!(size > 0) || size > 16 * 1048576) throw new Error('Give a size from 1 byte to 16 MB.');
    S.prog.run = { pct: 0, phase: 'Reading' };
    var out = new Uint8Array(size), step = 16384, t0 = Date.now();
    for (var at = 0; at < size; at += step) {
      var n = Math.min(step, size - at);
      out.set(await S.target.read(addr + at, n), at);
      S.prog.run = { pct: (at + n) / size, phase: 'Read ' + F.fmtBytes(at + n) + ' of ' + F.fmtBytes(size) };
      var bar = $('.fl-bar i'), ph = $('.fl-phase'); if (bar) bar.style.width = Math.round(S.prog.run.pct * 100) + '%'; if (ph) ph.textContent = S.prog.run.phase;
    }
    S.mem.data = out; S.mem.at = addr; S.mem.page = 0;
    var s = (Date.now() - t0) / 1000;
    log('Read ' + F.fmtBytes(size) + ' from ' + hex(addr) + ' in ' + s.toFixed(1) + ' s' + (s > 0.2 ? ' (' + F.fmtBytes(Math.round(size / s)) + '/s)' : '') + '.');
    S.prog.run = null;
  }

  // part ('erase', 'write', or 'verify') and f (0 to 1) feed the block map; the route redraws in place.
  function setRun(pct, phase, part, f) {
    var run = S.prog.run = Object.assign(S.prog.run || {}, { pct: pct, phase: phase });
    if (part) { run.frac = run.frac || { erase: 0, write: 0, verify: 0 }; run.frac[part] = f; }
    var box = $('#pb-route'); if (box) { box.innerHTML = progRoute(); host.changed(); return; }
    var bar = $('.fl-bar i'), ph = $('.fl-phase'); if (bar) bar.style.width = Math.round(pct * 100) + '%'; if (ph) ph.textContent = phase;
  }
  // The route above Erase & program, as the Serial bootloader tab draws its own (assets/route.js):
  // this computer → the probe → the chip, and the image as a block map.
  function progRoute() {
    var run = S.prog.run, c = S.chip, busy = run && !run.done, ok = run && run.done && run.ok, bad = run && run.done && !run.ok;
    var size = segs().reduce(function (n, s) { return n + s.data.length; }, 0), n = Math.max(8, Math.min(48, Math.ceil(size / 4096) || 24));
    var verb = run && run.kind === 'compare' ? 'Comparing' : (run && run.phase || 'Working').split(/[ ·,.]/)[0];
    var pc = busy ? verb : ok ? (run.kind === 'compare' ? 'Compared' : 'Done') : bad ? 'Stopped' : 'Ready';
    var pr = S.probe ? (S.target ? 'SWD at ' + (S.probe.khz >= 1000 ? S.probe.khz / 1000 + ' MHz' : S.probe.khz + ' kHz') : 'No target') : 'Not connected';
    var core = S.core, chipSt = !c ? 'Not connected' : busy ? 'Halted, being ' + (run.kind === 'compare' ? 'read' : 'programmed') :
      ok && run.kind !== 'compare' ? (S.prog.reset ? 'Running ' + (S.prog.img ? S.prog.img.name : 'it') : 'Programmed, halted') :
      core ? (core.halted ? 'Halted' : core.lockup ? 'Locked up' : 'Running') : 'Connected';
    var fr = (run && run.frac) || {}, cells;
    if (ok && run.kind === 'program') cells = FL.route.passes(n, 1, 1, S.prog.verify ? 1 : 0);
    else if (ok && run.kind === 'compare') cells = FL.route.passes(n, 0, 0, 1);
    else if (ok && run.kind === 'erase') cells = FL.route.passes(n, 1, 0, 0);
    else cells = FL.route.passes(n, fr.erase || 0, fr.write || 0, fr.verify || 0);
    var note = busy ? run.phase : ok ? run.phase : F.fmtBytes(size) + ', drawn as ' + n + ' blocks';
    return FL.route.html({
      nodes: [{ icon: 'pc', name: 'This computer', status: pc, on: true, live: busy, good: ok },
        { icon: 'probe', name: S.probe ? S.probe.info.name : (S.kind === 'jlink' ? 'J-Link' : 'ST-LINK'), status: pr, on: !!S.target, live: busy },
        { icon: 'chip', name: c ? c.name.split('/')[0] : 'The chip', status: chipSt, on: !!c, live: busy, good: ok && run.kind !== 'compare' && S.prog.reset }],
      links: [!!S.probe && busy, !!S.target && busy], note: note, cells: cells, cellsLabel: 'The image in ' + n + ' blocks',
      legend: [['unk', 'Not written yet'], ['erased', 'Erased'], ['diff', 'Written'], ['done', 'Read back and checked']]
    });
  }

  async function doProgram(verifyOnly) {
    needFamily();
    var c = S.chip, ss = segs(), plan = erasePlan();
    if (!ss.length) throw new Error('Open a file first.');
    if (plan.outside) throw new Error(plan.outside);
    if (!verifyOnly && S.prog.erase === 'mass' && !(await confirmSheet('Erase the whole flash?', '<p>Everything in the ' + esc(c.name) + '\'s ' + F.fmtBytes(c.flashSize) + ' of flash is erased before the file is written, including any bootloader.</p>', null, 'Erase and program'))) return;
    var kind = verifyOnly ? 'compare' : 'program', total = ss.reduce(function (n, x) { return n + x.data.length; }, 0), before = 0;
    S.prog.run = { pct: 0, phase: 'Starting', kind: kind, frac: { erase: 0, write: 0, verify: 0 } }; render();
    var t = S.target, t0 = Date.now();
    if (!(await t.status()).halted) { await t.halt(); log('Halted the core.'); }
    if (!verifyOnly) {
      if (S.prog.erase === 'mass') { log('Mass erase…'); await X.massErase(t, c, function (p, m) { setRun(p * 0.15, m, 'erase', p); }); }
      else { log('Erasing ' + plan.list.length + ' ' + (c.family.id === 'h5' ? 'sectors' : 'pages') + ', ' + hex(plan.lo) + ' to ' + hex(plan.hi - 1) + '…'); await X.eraseSectors(t, c, plan.list, function (p, m) { setRun(p * 0.15, m, 'erase', p); }); }
      setRun(0.15, 'Erased', 'erase', 1);
      for (var i = 0; i < ss.length; i++) {
        var s = ss[i], at = before;
        log('Writing ' + F.fmtBytes(s.data.length) + ' at ' + hex(s.addr) + (S.prog.slow ? ' (careful mode)' : '') + '…');
        var r = await X.program(t, c, s.addr, s.data, function (p, m) { setRun(0.15 + p * (S.prog.verify ? 0.55 : 0.85), m, 'write', (at + p * s.data.length) / total); }, { slow: S.prog.slow, log: log });
        before += s.data.length;
        if (r.redone) log('Rewrote ' + r.redone + ' interrupted block' + (r.redone > 1 ? 's' : '') + ' carefully.');
        log('Wrote ' + F.fmtBytes(r.bytes) + ' in ' + (r.ms / 1000).toFixed(1) + ' s (' + F.fmtBytes(Math.round(r.bytes / Math.max(r.ms, 1) * 1000)) + '/s).');
      }
    }
    if (S.prog.verify || verifyOnly) {
      before = 0;
      for (var j = 0; j < ss.length; j++) {
        var vs = ss[j], vat = before;
        await X.verify(t, vs.addr, vs.data, function (p, m) { setRun(verifyOnly ? p : 0.7 + p * 0.3, m, 'verify', (vat + p * vs.data.length) / total); });
        before += vs.data.length;
      }
      log(verifyOnly ? 'The chip matches the file.' : 'Verified.');
    }
    if (!verifyOnly) {
      await X.afterProgram(t, c, log);
      if (S.prog.reset) { await t.resetRun(false); log('Reset; the new image is running.'); }
    }
    var secs = ((Date.now() - t0) / 1000).toFixed(1);
    S.prog.run = { pct: 1, kind: kind, phase: verifyOnly ? 'The chip matches the image' : (S.prog.verify ? 'Written and read back' : 'Written') + ' in ' + secs + ' s', done: true, ok: true, msg: verifyOnly ? 'The chip matches ' + S.prog.img.name + '.' : S.prog.img.name + ' written' + (S.prog.verify ? ' and verified' : '') + ' in ' + secs + ' s.' + (S.prog.reset ? ' The chip was reset and is running it.' : '') };
    await refreshCore();
  }

  async function reviewOptions() {
    var c = S.chip, o = S.ob, rv = X.review(c, o.cur, o.edits);
    var items = Object.keys(o.edits).map(function (k) {
      var f = optField(k), w = rv.warnings.filter(function (x) { return x.key === k; })[0], rf = rv.refused.filter(function (x) { return x.key === k; })[0];
      return '<li><b>' + esc(f.label) + '</b>: ' + esc(showOpt(f, o.cur[k])) + ' → ' + esc(showOpt(f, o.edits[k])) +
        (rf ? '<div class="hint fl-bad" style="margin-top:6px"><b>Refused.</b> ' + esc(rf.why) + '</div>' : '') + (w ? '<div class="hint fl-warn" style="margin-top:6px"><b>Check.</b> ' + esc(w.why) + '</div>' : '') + '</li>';
    }).join('');
    if (rv.refused.length) { await confirmSheet('These changes can\'t be written', '<ul class="pb-diff">' + items + '</ul>', null, 'OK'); return; }
    var reset = c.family.id === 'g0';
    var ok = await confirmSheet('Write the option bytes?', '<p>On the ' + esc(c.name) + ':</p><ul class="pb-diff">' + items + '</ul>' +
      '<p class="fl-muted">' + (reset ? 'The chip reloads its option bytes, which resets it; this page then connects again.' : 'The new values apply at once or after the next reset.') + '</p>', 'WRITE', 'Write option bytes');
    if (!ok) return;
    await op('Write option bytes', async function () {
      var t = S.target;
      if (!(await t.status()).halted) await t.halt();
      var r = await X.writeOptions(t, c, o.edits, log);
      if (r.reset) {
        log('Reconnecting after the option reload…');
        await new Promise(function (res) { setTimeout(res, 300); });
        try { await S.probe.disconnect(); } catch (e) { /* the link dropped */ }
        var t2 = new FL.target.Target(S.probe, { log: log });
        S.chip = await t2.connect({ underReset: S.underReset, khz: S.khz });
        S.target = t2;
      }
      S.ob.cur = await X.readOptions(S.target, S.chip);
      var still = Object.keys(o.edits).filter(function (k) { return S.ob.cur[k] !== o.edits[k]; });
      if (still.length) log('Written; ' + still.join(', ') + ' will show the new value after a reset.');
      else log('Option bytes written and read back.');
      S.ob.edits = {};
      await refreshCore();
      toast('Option bytes written.');
    });
  }

  var actions = {
    view: function (b) { S.view = b.dataset.view; render(); },
    kind: function (b) { S.kind = b.dataset.kind; prefs.kind = S.kind; savePrefs(); render(); },
    connect: connect,
    disconnect: function () { return op('Disconnect', function () { return disconnect(); }); },
    halt: function () { return op('Halt', async function () { await S.target.halt(); log('Halted.'); await refreshCore(); }); },
    run: function () { return op('Run', async function () { await S.target.run(); log('Running.'); await refreshCore(); }); },
    'reset-halt': function () { return op('Reset and halt', async function () { await S.target.resetHalt(); log('Reset; halted at the first instruction.'); await refreshCore(); }); },
    'reset-run': function () { return op('Reset and run', async function () { await S.target.resetRun(false); log('Reset; running.'); await refreshCore(); }); },
    'hard-reset': function () { return op('Hardware reset', async function () { await S.target.resetRun(true); log('NRST pulsed; running.'); await refreshCore(); }); },
    refresh: function () { return op('Refresh', async function () { S.voltage = await S.probe.voltage(); await refreshCore(); }); },
    'read-core': function () { return op('Read core registers', async function () { S.regs = await S.target.readRegs(); }); },
    'mem-read': function () {
      var a = parseNum($('#m-addr').value), n = parseNum($('#m-size').value);
      if (isNaN(a) || isNaN(n)) { toast('Give an address and a size, such as 0x08000000 and 4K.', true); return; }
      S.mem.addr = a >>> 0; S.mem.size = n;
      return op('Read memory', function () { needTarget(); return memRead(S.mem.addr, n); });
    },
    'mem-all': function () { S.mem.addr = S.chip.flashBase; S.mem.size = S.chip.flashSize; return op('Read memory', function () { return memRead(S.chip.flashBase, S.chip.flashSize); }); },
    'mem-page': function (b) { S.mem.page = Math.max(0, S.mem.page + +b.dataset.d); render(); },
    'mem-goto': function () { var a = parseNum($('#m-goto').value), m = S.mem; if (isNaN(a) || a < m.at || a >= m.at + m.data.length) { toast('That address isn\'t in what was read.', true); return; } m.page = Math.floor((a - m.at) / 4096); render(); },
    'mem-save-bin': function () { download(chipTag() + '_' + hex(S.mem.at).slice(2) + '.bin', S.mem.data); },
    'mem-save-hex': function () { download(chipTag() + '_' + hex(S.mem.at).slice(2) + '.hex', F.toHex([{ addr: S.mem.at, data: S.mem.data }]), 'text/plain'); },
    'mem-write': function () {
      var a = parseNum($('#w-addr').value), v = parseNum($('#w-val').value);
      if (isNaN(a) || isNaN(v) || a & 3) { toast('Give a word-aligned address and a value.', true); return; }
      if (S.chip && S.chip.flashSize && a >= S.chip.flashBase && a < S.chip.flashBase + S.chip.flashSize) { toast('That\'s flash: program it on Erase & program.', true); return; }
      return op('Write a word', async function () { await S.target.w32(a >>> 0, v >>> 0); var back = await S.target.r32(a >>> 0); log('Wrote ' + hex(v) + ' at ' + hex(a) + '; reads back ' + hex(back) + '.'); });
    },
    'open-file': function () { var f = document.getElementById('pb-file'); f.value = ''; f.click(); },
    'use-listed': function () { offer(true); },
    program: function () { return op('Program', async function () { try { await doProgram(false); } catch (e) { S.prog.run = Object.assign(S.prog.run || {}, { done: true, ok: false, msg: e.message }); throw e; } }); },
    'verify-only': function () { return op('Compare', async function () { try { await doProgram(true); } catch (e) { S.prog.run = Object.assign(S.prog.run || {}, { done: true, ok: false, msg: e.message }); throw e; } }); },
    'erase-range': function () {
      var lo = parseNum($('#e-from').value), hi = parseNum($('#e-to').value);
      if (isNaN(lo) || isNaN(hi) || hi <= lo) { toast('Give a From and a To address, To after From.', true); return; }
      return op('Erase', async function () {
        needFamily();
        var list = X.sectorsFor(S.chip, lo, hi);
        if (!list.length) throw new Error('That range isn\'t in the flash.');
        S.busy = null;
        var ok = await confirmSheet('Erase ' + list.length + ' ' + (S.chip.family.id === 'h5' ? 'sectors' : 'pages') + '?', '<p>' + hex(list[0].addr) + ' to ' + hex(list[list.length - 1].addr + list[list.length - 1].size - 1) + ' on the ' + esc(S.chip.name) + '.</p>', null, 'Erase');
        S.busy = 'Erase';
        if (!ok) return;
        if (!(await S.target.status()).halted) await S.target.halt();
        S.prog.run = { pct: 0, phase: 'Erasing', kind: 'erase' };
        await X.eraseSectors(S.target, S.chip, list, function (p, m) { setRun(p, m, 'erase', p); });
        S.prog.run = { pct: 1, phase: 'Erased', kind: 'erase', done: true, ok: true, msg: 'Erased ' + list.length + ' from ' + hex(list[0].addr) + '.' };
        log('Erased ' + list.length + ' units from ' + hex(list[0].addr) + '.');
      });
    },
    'mass-erase': async function () {
      if (!S.chip || !S.chip.family) { toast('Connect to a known chip first.', true); return; }
      var ok = await confirmSheet('Erase the whole flash?', '<p>All ' + F.fmtBytes(S.chip.flashSize) + ' of the ' + esc(S.chip.name) + '\'s flash, including any bootloader. The chip can\'t run anything until it\'s programmed again.</p>', 'ERASE', 'Erase everything');
      if (!ok) return;
      return op('Mass erase', async function () {
        if (!(await S.target.status()).halted) await S.target.halt();
        S.prog.run = { pct: 0, phase: 'Erasing', kind: 'erase' };
        await X.massErase(S.target, S.chip, function (p, m) { setRun(p, m, 'erase', p); });
        S.prog.run = { pct: 1, phase: 'Erased', kind: 'erase', done: true, ok: true, msg: 'The whole flash is erased.' };
        log('Mass erase done.');
      });
    },
    'open-svd': function () { var f = document.getElementById('pb-svd'); f.value = ''; f.click(); },
    'r-read': function (b) { var k = b.dataset.k; return op('Read ' + k, function () { needTarget(); return readReg(k); }); },
    'r-read-all': function (b) {
      var p = S.svd.dev.p.filter(function (x) { return x.n === b.dataset.p; })[0];
      return op('Read ' + p.n, async function () {
        needTarget();
        var got = [];
        for (var i = 0; i < p.r.length; i++) { var r = p.r[i]; if (r.a === 'write-only' || FL.svd.sideEffects(r)) continue; await readReg(regKey(p, r), true); if (S.svd.values[regKey(p, r)] !== undefined) got.push(S.svd.values[regKey(p, r)]); }
        // With its clock off, a peripheral answers every register with the same stale bus value.
        var stale = got.length > 3 && got.every(function (v) { return v === got[0]; }) && got[0] !== 0;
        S.svd.stale = S.svd.stale || {}; S.svd.stale[p.n] = stale;
        log('Read ' + p.n + '.' + (stale ? ' Every register read ' + hex(got[0]) + ': its clock is probably off (RCC), so these are not its real values.' : ''), stale);
      });
    },
    'r-write': function (b) {
      var k = b.dataset.k, v = S.svd.edits[k];
      return op('Write ' + k, async function () {
        needTarget();
        var x = findReg(k), a = x.p.b + x.r.o, size = x.r.s || 32;
        if (size === 32) await S.target.w32(a, v); else await S.target.write(a, new Uint8Array(size === 16 ? [v & 255, (v >> 8) & 255] : [v & 255]));
        log('Wrote ' + hex(v) + ' to ' + k + ' (' + hex(a) + ').');
        if (x.r.a !== 'write-only' && !FL.svd.sideEffects(x.r)) await readReg(k, true); else { S.svd.values[k] = v; delete S.svd.edits[k]; }
      });
    },
    'ob-read': function () { return op('Read option bytes', async function () { S.ob.cur = await X.readOptions(S.target, S.chip); S.ob.edits = {}; log('Read the option bytes.'); }); },
    'ob-reset': function () { S.ob.edits = {}; render(); },
    'ob-review': reviewOptions,
    'log-copy': function () { navigator.clipboard.writeText(S.log.map(function (l) { return l.t + ' ' + (l.err ? 'ERROR ' : '') + l.msg; }).join('\n')).then(function () { toast('Log copied.'); }); },
    'log-clear': function () { S.log = []; render(); },
    'sheet-close': closeSheet
  };

  // Only what happens inside the tab is the probe's; the rest of the page has its own handlers.
  function mine(e) { return root && e.target.closest && e.target.closest('#' + root.id); }
  document.addEventListener('click', function (e) {
    if (!mine(e)) return;
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    if (b.tagName === 'A') e.preventDefault();
    var fn = actions[b.dataset.act];
    if (fn) fn(b);
  });
  document.addEventListener('toggle', function (e) {
    var d = e.target; if (!mine(e) || !d.dataset || !d.dataset.periph) return;
    var was = !!S.svd.open[d.dataset.periph];
    if (d.open === was) return;
    S.svd.open[d.dataset.periph] = d.open;
    render();
  }, true);
  document.addEventListener('change', function (e) {
    var el = e.target, k = el.dataset && el.dataset.change;
    if (!k || !mine(e)) return;
    if (k === 'under-reset') { S.underReset = el.checked; prefs.underReset = el.checked; savePrefs(); }
    else if (k === 'khz') { S.khz = +el.value; prefs.khz = S.khz; savePrefs(); }
    else if (k === 'erase') S.prog.erase = el.value;
    else if (k === 'verify') S.prog.verify = el.checked;
    else if (k === 'reset') S.prog.reset = el.checked;
    else if (k === 'slow') S.prog.slow = el.checked;
    else if (k === 'r-val') {
      var v = parseNum(el.value); if (isNaN(v)) { toast('Not a number: ' + el.value, true); render(); return; }
      S.svd.edits[el.dataset.k] = v >>> 0;
    } else if (k === 'r-field') {
      var key = el.dataset.k, base = S.svd.edits[key] !== undefined ? S.svd.edits[key] : S.svd.values[key];
      var fv = el.type === 'checkbox' ? (el.checked ? 1 : 0) : parseNum(el.value);
      if (isNaN(fv)) { toast('Not a number: ' + el.value, true); render(); return; }
      S.svd.edits[key] = FL.svd.withField(base || 0, { l: +el.dataset.l, w: +el.dataset.w }, fv);
    } else if (k === 'ob') {
      var f = optField(el.dataset.k), n = f.values ? +el.value : parseNum(el.value);
      if (isNaN(n)) { toast('Not a number: ' + el.value, true); render(); return; }
      if (f.addr) n = (n >>> 8) & 0xFFFFFF;
      if (n === S.ob.cur[f.key]) delete S.ob.edits[f.key]; else S.ob.edits[f.key] = n >>> 0;
    } else if (k === 'r-filter') return;
    else return;
    render();
  });
  document.addEventListener('input', function (e) {
    if (!mine(e)) return;
    if (e.target.id === 'r-filter') { S.svd.filter = e.target.value; clearTimeout(S.filterTimer); S.filterTimer = setTimeout(render, 200); }
    if (e.target.id === 'p-base') { var v = parseNum(e.target.value); if (!isNaN(v)) S.prog.base = v >>> 0; }
  });
  document.addEventListener('keydown', function (e) {
    var no = e.key === 'Escape' && document.querySelector('#sheet-root [data-x=no]'); if (no) no.click();
  });

  document.getElementById('pb-file').addEventListener('change', async function () {
    var f = this.files[0]; if (!f) return;
    try {
      var img = F.parse(f.name, new Uint8Array(await f.arrayBuffer()), S.prog.base);
      S.prog.img = img; S.prog.run = null; S.prog.listed = null;
      log('Opened ' + f.name + ': ' + img.format + ', ' + img.segments.length + ' segment' + (img.segments.length > 1 ? 's' : '') + ', ' + F.fmtBytes(img.size) + '.');
      S.view = 'program'; render();
    } catch (e) { log(f.name + ': ' + e.message, true); toast(e.message, true); }
  });
  document.getElementById('pb-svd').addEventListener('change', async function () {
    var f = this.files[0]; if (!f) return;
    try { S.svd.dev = FL.svd.parseXml(await f.text()); S.svd.name = f.name; S.svd.values = {}; S.svd.edits = {}; S.svd.errors = {}; log('Loaded ' + f.name + ' (' + S.svd.dev.p.length + ' peripherals).'); render(); }
    catch (e) { log(f.name + ': ' + e.message, true); toast(e.message, true); }
  });
  if (navigator.usb) navigator.usb.addEventListener('disconnect', function (e) {
    if (S.probe && S.probe.dev === e.device) { log('The probe was unplugged.', true); dropProbe(); S.voltage = null; render(); }
  });

  // ── The firmware picked in the sidebar ──
  // The page's pick (from GitHub, or a file) becomes the image to program, unless a file was opened here
  // after it. force: the "Use … from the list" button.
  var pending = false;
  function listedKey(im) { return im.title + '|' + im.bytes.length + '|' + im.base; }
  function offer(force) {
    var im = host.image();
    S.prog.listNote = '';
    if (!im) { pending = false; if (root) render(); return; }
    if (im.why) { S.prog.listNote = im.why; pending = !!im.waiting; if (root) render(); return; }
    pending = false;
    var key = listedKey(im);
    if (!force && S.prog.listed && S.prog.listed.key === key) return;
    try {
      var img = F.parse(im.name, im.bytes, im.base);
      img.name = im.title;
      S.prog.base = im.base >>> 0; S.prog.img = img; S.prog.run = null;
      S.prog.listed = { key: key, from: im.from, board: im.board, mcu: im.mcu };
      log('Took ' + im.title + ' from ' + (im.from === 'GitHub' ? 'GitHub' : 'this computer') + ': ' + F.fmtBytes(img.size) + ' at ' + hex(im.base) + '.');
      S.view = 'program';
    } catch (e) { log(im.title + ': ' + e.message, true); }
    if (root) render();
  }
  // The chip on the probe isn't the one the picked firmware was built for.
  function chipMismatch() {
    var l = S.prog.listed, c = S.chip;
    if (!l || !l.mcu || !c) return '';
    var a = l.mcu.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9), b = c.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9);
    return a.length >= 7 && b.length >= 7 && a.slice(0, 7) !== b.slice(0, 7) ? l.mcu : '';
  }

  // ── Start: mounted by the page ──
  function mount(el, h) {
    root = el; host = Object.assign(host, h || {});
    DEMO = host.demo || null;
    render();
  }
  function show() { if (pending) offer(); else render(); }
  FL.probeApp = { S: S, actions: actions, render: render, connect: connect, mount: mount, show: show, status: status, offer: offer };
})();
