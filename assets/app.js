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
  var DEMO_PROBE = (/[?&]demo=(\w+)/.exec(location.search) || [])[1] || '';   // ?demo=h5: the probe's H563
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
    // The page's tab (Chris, 2026-11-17): 'serial' (the bootloader), 'probe' (a debug probe), or
    // 'console' (any serial port). Each has its own pane, kept while another shows.
    tab: (/[?&]tab=(probe|console)\b/.exec(location.search) || [])[1] || 'serial',
    run: null,                         // the flash in progress or last finished, for the current firmware
    con: null,                         // { open, connecting, error, name, paused }
    conBaud: 115200, conFilter: '',    // the console's rate, and which board's ports to list ('' = any)
    fwr: null,                         // Signoff FW releases (assets/fwreleases.js): { state, targets, errors, fte, error }
    relKey: '', rel: null,             // view 'release': '<review id>/<release id>', and its fetch { busy, error }
    jig: null,                         // Jig's builds (assets/jig.js): { state: 'loading' | 'ok' | 'none' | 'error', items, tag }
    projKey: '', fwEdit: null, writing: ''   // view 'project' (docs/working-projects.md); an image's Name and Project edits; a save under way
  };
  var demoBoard = { running: true };   // the simulated board's state in ?demo

  function boards() { return (S.catalog && S.catalog.boards) || {}; }
  function current() {
    if (S.view === 'fw' && S.catalog) {
      var f = S.catalog.firmware.filter(function (x) { return x.id + '@' + x.board === S.fwId; })[0];
      if (f && f.kind === 'file' && boards()[f.board].kind === 'bridge') return { fw: fileImageFw(f), board: boards()[f.board] };
      return f ? { fw: f, board: boards()[f.board] } : null;
    }
    if (S.view === 'system' && S.sys) return { fw: systemFw(), board: systemBoard(S.sys.sys) };
    if (S.view === 'local' && S.local) {
      var b = boards()[S.local.boardId] || I.GENERIC;
      if (b.kind === 'bridge') return { fw: localUnits(b), board: b };
      return { fw: { id: 'local', name: S.local.name, size: S.local.bytes.length, sha256: S.local.sha256, local: true }, board: b };
    }
    return null;
  }

  // An image uploaded on the page (kind "file") for a board behind a passthrough: read once, then split after INFO,
  // as a system's file is.
  var fileImgs = {};
  function fileImageFw(f) {
    var k = f.id + '@' + f.board, st = fileImgs[k];
    if (!st) {
      fileImgs[k] = st = { loading: true };
      S.catalog.fetch(f).then(function (bytes) { fileImgs[k] = { segments: FL.files.parse(f.path, bytes).segments }; render(); },
        function (e) { fileImgs[k] = { error: e.code === 'mismatch' ? 'The image in the repo doesn’t match its recorded SHA-256.' : e.message || String(e) }; render(); });
    }
    var fw = Object.assign({}, f, { split: true, local: true, kind: 'units', units: [], parts: [], segments: st.segments || null });
    if (st.loading) fw.error = 'Reading ' + f.name + '…'; else if (st.error) fw.error = st.error;
    return fw;
  }

  // A file from this computer for a board reached through a passthrough: its .hex or .elf split into that board's
  // blocks, as publish.py splits a published image (FL.image.unitsImage). Kept until the file or board changes.
  var unitsFor = null;
  function localUnits(b) {
    var key = S.local.sha256 + '|' + b.id;
    if (unitsFor && unitsFor.key === key) return unitsFor.fw;
    var fw = { id: 'local', name: S.local.name, size: S.local.bytes.length, sha256: S.local.sha256, local: true, kind: 'units', units: [], parts: [] };
    if (!b.units) fw.error = 'Flasher doesn’t know ' + b.name + '’s blocks yet: its sector layout isn’t in the firmware list. Publish its details (publish.py --board-only), or flash a published image.';
    else if (!S.local.segments) fw.error = 'A .bin has no addresses, and ' + b.name + '’s image can span more than one memory. Use the .hex or .elf the build makes.';
    else {
      try { Object.assign(fw, I.unitsImage(S.local.segments, b.units, FL.sboot.crc32)); fw.local = true; fw.id = 'local'; fw.name = S.local.name; fw.sha256 = S.local.sha256; }
      catch (e) { fw.error = e.message; }
    }
    unitsFor = { key: key, fw: fw };
    return fw;
  }

  // ── Loading the catalog ──
  // The list is kept in this browser after each sync (Chris, 2026-11-10), for the account it was read
  // with (the engine's tokenTag): a visit shows it at once, then syncs, and the new list replaces it only
  // once it's here. A sync that fails keeps the kept list and says so on the pill.
  var KEEP_KEY = 'flasher.v1.catalog';
  function tagOf(tok) { return tok && window.Signoff && Signoff.model && Signoff.model.tokenTag ? Signoff.model.tokenTag(tok) : ''; }
  function readKept(tok) {
    try {
      var k = JSON.parse(localStorage.getItem(KEEP_KEY) || 'null');
      return k && k.v === 1 && k.tag && k.tag === tagOf(tok) && k.loaded ? k : null;
    } catch (e) { return null; }
  }
  function keep(tok, c) {
    try { localStorage.setItem(KEEP_KEY, JSON.stringify({ v: 1, tag: tagOf(tok), at: Date.now(), loaded: FL.access.slim(c.access) })); } catch (e) { /* storage full or blocked: next visit reads GitHub first */ }
  }
  function forgetKept() { try { localStorage.removeItem(KEEP_KEY); } catch (e) { /* storage blocked */ } }

  function load() {
    S.error = ''; S.syncError = '';
    if (DEMO) {
      S.loading = true; render();
      return C.loadDemo().then(function (c) {
        var f0 = c.fetch; c.fetch = function (f) { return demoFiles[f.id] ? Promise.resolve(demoFiles[f.id].slice()) : f0(f); };
        c.systems = c.systems || [];
        c.firmware.forEach(function (f) { f.project = f.project || (c.boards[f.board] && c.boards[f.board].project); f.edited = f.edited || {}; });
        c.fetchSystemFile = function (x) { return idbFile('get', x.id).then(function (rec) { if (!rec) throw new Error('not in this browser'); return new Uint8Array(rec.bytes); }); };
        done(c); loadJig(); return loadFwr(c);
      }, fail);
    }
    var tok = C.auth.token();
    if (!tok) { S.catalog = null; S.fwr = null; S.loading = false; S.syncing = false; render(); openWantedJig(); return Promise.resolve(); }
    loadFwr(null);   // Signoff FW's releases: their own repos and access, read beside the manifest
    loadJig();       // Jig's builds, for FTEs who can open jig_data
    // Another account (signed in here or in another tab) never sees the last one's list.
    if (S.catalog && S.catalogTag !== tagOf(tok)) { S.catalog = null; S.syncedAt = 0; S.check = null; S.bytesReady = false; bytesFor = null; }
    if (S.syncing) return S.syncing;
    S.catalogTag = tagOf(tok);
    if (!S.catalog) {
      var kept = readKept(tok);
      if (kept) {
        try { S.catalog = C.fromKept(kept.loaded, tok); S.syncedAt = kept.at; restoreFromUrl(); if (current()) prepareBytes(); openWantedJig(); }
        catch (e) { S.catalog = null; forgetKept(); }
      }
    }
    S.loading = !S.catalog; render();
    var mine = function () { return tagOf(C.auth.token()) === tagOf(tok); };   // still the same account when it answers
    S.syncing = C.loadRepo(tok).then(function (c) { if (!mine()) return; keep(tok, c); S.syncedAt = Date.now(); done(c); }, function (e) { if (mine()) fail(e); })
      .then(function () { S.syncing = null; render(); });
    return S.syncing;
    function done(c) {
      S.catalog = c; S.loading = false; restoreFromUrl();
      if (DEMO) seedDemoSystem(c);
      if (window.SignoffInvites && !DEMO) window.SignoffInvites.refresh();
      // A flash under way keeps the bytes it has; a list that changed under the open firmware fetches it again.
      if (current() && !(S.run && S.run.busy) && !(S.bytesReady && bytesFor && bytesFor.key === runKey())) prepareBytes();
      render();
      openWantedJig();
    }
    function fail(e) {
      if (S.catalog && !DEMO && e.code !== 'none' && e.code !== 'invited') { S.syncError = e.message || String(e); S.loading = false; render(); return; }
      if (e.code === 'none' || e.code === 'invited') forgetKept();
      S.catalog = e.catalog || null; S.invites = e.invites || []; S.loading = false; S.error = e.message || String(e); S.errorCode = e.code || ''; render();
    }
  }

  // ── Signoff FW releases (assets/fwreleases.js; ../fw_design_review/docs/releases.md) ──
  // FW sharing decides who sees them: the targets this token's FW repos hold. Drafts show to FTEs only.
  var fwrLoading = null;
  function loadFwr(demoCatalog) {
    if (fwrLoading) return fwrLoading;
    var tok = C.auth.token(), tag = tagOf(tok);
    if (!DEMO && !tok) { S.fwr = null; return Promise.resolve(); }
    if (S.fwr && S.fwr.tag !== (DEMO ? 'demo' : tag)) S.fwr = null;   // another account's list is never shown
    if (!S.fwr) S.fwr = { state: 'loading', targets: [], errors: [] };
    fwrLoading = (DEMO ? FL.fwr.loadDemo(demoCatalog) : FL.fwr.load({ token: tok })).then(function (r) {
      if (!DEMO && tagOf(C.auth.token()) !== tag) return;
      S.fwr = Object.assign(r, { state: 'ok', tag: DEMO ? 'demo' : tag });
      openWantedRelease();
    }, function (e) {
      S.fwr = { state: 'error', error: e.message || String(e), targets: [], errors: [], tag: tag };
    }).then(function () { fwrLoading = null; render(); });
    return fwrLoading;
  }
  function fwrFte() { return DEMO || !!(S.fwr && S.fwr.fte) || !!(S.catalog && S.catalog.fte); }
  function relShown(r) { return r.state !== 'draft' || fwrFte(); }
  function relOf(key) {
    var m = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(key || ''), out = null;
    if (!m || !S.fwr || !S.fwr.targets) return null;
    S.fwr.targets.forEach(function (t) {
      if (t.id !== m[1]) return;
      t.releases.forEach(function (r) { if (r.id === m[2] && relShown(r)) out = { target: t, rel: r, key: key }; });
    });
    return out;
  }
  function relLabel(x) { return x.target.name + ' ' + x.rel.version; }
  function relState(r) {
    return '<span class="chip fl-rel-' + r.state + '">' + esc(FL.fwr.LABEL[r.state]) + '</span>';
  }
  function fetchRel(x) {
    return S.fwr.demo ? S.fwr.fetch(x.target, x.rel) : FL.fwr.fetchRelease(x.target, x.rel, { token: C.auth.token() });
  }
  // ?release=<review id>/<release id> (Signoff FW's Open in Flasher) opens one, once the releases are read.
  var wantRel = (/[?&]release=([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)/.exec(location.search) || [])[1] || '';
  function openWantedRelease() {
    var k = wantRel; wantRel = '';
    if (!k) return;
    if (relOf(k)) openRelease(k);
    else toast('That release isn’t one you can open here: it may be a draft, or not shared with you.');
  }
  // A release over USB is fetched, checked, and opened as a file for its board; a passthrough one waits for a
  // system to put it on (its page lists them).
  function openRelease(key) {
    var x = relOf(key);
    if (!x) return;
    if (S.run && S.run.busy) return toast('Wait for the flash to finish.');
    S.relKey = key; S.rel = null;
    if (x.rel.via === 'passthrough') { select('release'); return; }
    S.rel = { busy: true, error: '' }; select('release');
    fetchRel(x).then(function (f) {
      if (S.relKey !== key || S.view !== 'release') return;
      S.rel = null;
      openLocalBytes(f.name, f.bytes, f.sha256, boards()[f.load.board] ? f.load.board : '', { key: key, target: x.target.name, version: x.rel.version, state: x.rel.state, withdrawnWhy: x.rel.withdrawnWhy || '', base: f.load.base });
    }, function (e) { if (S.relKey === key) { S.rel = { busy: false, error: e.message || String(e) }; render(); } });
  }
  // ── Builds from Jig (assets/jig.js) ──
  // ?jig=<project>/<commit> (Jig's Flash) opens that build as a file for its board, once the board list is here:
  // the copy Jig left in this browser, else read from jig_data. Tried once.
  var wantJig = (/[?&]jig=([a-z0-9-]+\/[0-9a-f]+)/.exec(location.search) || [])[1] || '';
  function openWantedJig() {
    var k = wantJig;
    if (!k || !FL.jig) return;
    wantJig = '';
    openJig(k);
  }
  // A build: the copy Jig left in this browser, else read from jig_data (a row of From Jig, or a link opened later).
  // The demo's rows are made here, as the demo's other images are.
  function openJig(k) {
    if (S.run && S.run.busy) return toast('Wait for the flash to finish.');
    S.jigBusy = k; render();
    var demoRow = DEMO && S.jig && S.jig.items.filter(function (x) { return x.key === k && x.demo; })[0];
    FL.jig.take(k, DEMO).then(function (got) {
      if (got) return got;
      if (demoRow && boards()[demoRow.flasher]) {
        var bin = FL.catalog.makeImage(demoRow.size, 13, boards()[demoRow.flasher]), commit = k.split('/')[1];
        return I.sha256(bin).then(function (h) {
          return { key: k, project: demoRow.project, commit: commit, name: FL.jig.fileName(demoRow.name, commit), bytes: bin, sha256: h, board: demoRow.flasher, projectName: demoRow.name };
        });
      }
      var tok = C.auth.token();
      if (DEMO || !tok) throw new Error(DEMO ? 'That build isn’t in this browser. Press Flash in the Jig demo again.' : 'Sign in to read that build from Jig.');
      return FL.jig.fetch(k, { token: tok });
    }).then(function (b) {
      S.jigBusy = '';
      openLocalBytes(b.name, b.bytes, b.sha256, boards()[b.board] ? b.board : '', null);
      if (S.local && S.local.sha256 === b.sha256) { S.local.jig = { key: k, project: b.project, commit: b.commit, name: b.projectName, board: b.board }; setUrl(); render(); }
    }, function (e) { S.jigBusy = ''; render(); toast('Couldn’t open the Jig build: ' + (e.message || e)); });
  }
  // From Jig: each Jig project's newest passing build. Jig is for FTEs: a sign-in that can't open jig_data sees no section.
  var jigLoading = null;
  function loadJig() {
    if (!FL.jig) return Promise.resolve();
    if (jigLoading) return jigLoading;
    var tok = C.auth.token(), tag = DEMO ? 'demo' : tagOf(tok);
    if (!DEMO && !tok) { S.jig = null; return Promise.resolve(); }
    if (S.jig && S.jig.tag !== tag) S.jig = null;
    if (!S.jig) S.jig = { state: 'loading', items: [], tag: tag };
    var got = DEMO ? Promise.resolve([{ key: 'status-led-k3m9/4d3e0b1c', project: 'status-led-k3m9', name: 'Status LED blink', at: new Date(Date.now() - 3600000).toISOString(),
      size: 22016, boardName: 'Main PCBA (Smart Thermostat)', flasher: 'tstat-main', demo: true }]).then(function (items) { return { items: items, boards: ['tstat-main'] }; }) : FL.jig.list({ token: tok });
    jigLoading = got.then(function (r) {
      if (!DEMO && tagOf(C.auth.token()) !== tag) return;
      S.jig = { state: 'ok', items: r.items, boards: r.boards, tag: tag };
    }, function (e) {
      S.jig = { state: e.status === 404 || e.status === 403 ? 'none' : 'error', error: e.message || String(e), items: [], tag: tag };
    }).then(function () { jigLoading = null; render(); });
    return jigLoading;
  }
  function jigNewHref(boardId) {
    return '../jig/index.html?' + (DEMO ? 'demo&' : '') + 'new=1' + (boardId ? '&board=' + encodeURIComponent(boardId) : '');
  }
  // New editable project: a sketch in Jig for one of these boards (only those Jig can build for).
  function jigNewRow(ids) {
    if (!ids.length) return '';
    return '<div class="fl-row">' + ids.map(function (id) {
      var n = boards()[id].name;
      return '<a class="btn" href="' + esc(jigNewHref(id)) + '" title="Open Jig, the online editor, with a new sketch for ' + esc(n) + '">New editable project' + (ids.length > 1 ? ' for ' + esc(n) : '') + '…</a>';
    }).join('') + '</div>';
  }
  function jigRows() {
    var j = S.jig;
    if (!j || j.state === 'none' || (j.state === 'ok' && !j.items.length && !canEdit())) return '';
    var head = '<div class="fl-sec"><span class="side-label">From Jig</span><span class="fl-muted fl-sec-note">' +
      (canEdit() ? '<a href="' + esc(jigNewHref('')) + '" title="Start a sketch in Jig, the online editor">+ New in Jig</a>' : 'Firmware editor') + '</span></div>';
    if (j.state === 'loading') return head + '<div class="side-empty">Reading Jig’s builds…</div>';
    if (j.state === 'error') return head + '<div class="side-empty">Couldn’t read Jig’s builds: ' + esc(j.error) + '</div>';
    var q = ($('#fw-search').value || '').trim().toLowerCase(), cur = S.view === 'local' && S.local && S.local.jig ? S.local.jig.key : '';
    var list = j.items.filter(function (x) { return !q || (x.name + ' ' + x.boardName).toLowerCase().indexOf(q) >= 0; });
    if (!list.length) return q ? '' : head + '<div class="side-empty">No passing builds yet.</div>';
    return head + list.map(function (x) {
      var sub = [x.boardName, 'build ' + x.key.split('/')[1].slice(0, 7), x.at ? fmtDate(x.at) : ''].filter(Boolean).join(' · ');
      return '<button class="proj' + (cur === x.key ? ' active' : '') + '" data-act="open-jig" data-jig="' + esc(x.key) + '" title="' + esc(x.name + ': its newest passing build in Jig') + '">' + FW_ICON +
        '<span class="proj-body"><span class="proj-name">' + esc(x.name) + '</span><span class="proj-sub">' + esc(sub) + '</span></span></button>';
    }).join('');
  }
  function jigHint(j) {
    var known = boards()[j.board];
    return '<div class="hint"><b>From Jig</b>' + esc(j.name) + ', build ' + esc(j.commit.slice(0, 8)) + '. Its SHA-256 was checked against the build record.' +
      (j.board && !known ? ' Jig built it for “' + esc(j.board) + '”, which isn’t in your firmware list: pick its board below.' : '') +
      ' <a href="../jig/index.html?' + (DEMO ? 'demo&' : '') + 'project=' + encodeURIComponent(j.project) + '">Back to Jig</a></div>';
  }

  // Released projects: Signoff FW's targets, grouped by their project (the FW review's meta.project), each target's
  // releases under it, newest first. Read only here: they're edited in Signoff FW.
  function fwrRows() {
    var f = S.fwr, head = '<div class="fl-sec"><span class="side-label">Released projects</span><span class="fl-muted fl-sec-note">Signoff FW</span></div>';
    if (!f || (f.state === 'ok' && !f.targets.length)) return '';
    if (f.state === 'loading') return head + '<div class="side-empty">Reading Signoff FW releases…</div>';
    if (f.state === 'error') return head + '<div class="side-empty">Couldn’t read Signoff FW releases: ' + esc(f.error) + '</div>';
    var q = ($('#fw-search').value || '').trim().toLowerCase(), closed = closedGroups(), curKey = S.view === 'release' ? S.relKey : S.view === 'local' && S.local && S.local.release ? S.local.release.key : '';
    var groups = {}, order = [];
    f.targets.forEach(function (t) {
      var list = t.releases.filter(relShown).filter(function (r) { return !q || (t.project + ' ' + t.name + ' ' + r.version).toLowerCase().indexOf(q) >= 0; }).slice().reverse();
      if (!list.length) return;
      var pname = t.project || 'No project';
      if (!groups[pname]) { groups[pname] = []; order.push(pname); }
      groups[pname].push({ t: t, list: list });
    });
    if (!order.length) return q ? '' : head;
    return head + order.sort().map(function (pname) {
      var gid = 'fwp:' + pname, items = groups[pname], n = items.reduce(function (a, x) { return a + x.list.length; }, 0);
      var holds = items.some(function (x) { return x.list.some(function (r) { return curKey === x.t.id + '/' + r.id; }); }), open = !closed[gid] || !!q || holds;
      return '<div class="side-group"><button class="side-group-head" data-act="toggle-group" data-group="' + esc(gid) + '" aria-expanded="' + open + '">' + CHEV +
        '<span class="side-group-name" title="A project in Signoff FW">' + esc(pname) + '</span><span class="side-group-count">' + n + '</span></button>' +
        (open ? items.map(function (x) {
          var t = x.t;
          return '<div class="fl-target">' + esc(t.name) + '</div>' + x.list.map(function (r) {
            var key = t.id + '/' + r.id, sub = [FL.fwr.LABEL[r.state], r.via === 'passthrough' ? 'through a passthrough' : r.kind.toUpperCase(), I.fmtBytes(r.size)].join(' · ');
            return '<button class="proj fl-rel-row ' + r.state + (curKey === key ? ' active' : '') + '" data-act="open-rel" data-rel="' + esc(key) + '" title="' + esc(t.name + ' ' + r.version + (r.withdrawnWhy ? ': withdrawn, ' + r.withdrawnWhy : '')) + '">' + FW_ICON +
              '<span class="proj-body"><span class="proj-name">' + esc(r.version) + '</span><span class="proj-sub">' + esc(sub) + '</span></span></button>';
          }).join('');
        }).join('') : '') + '</div>';
    }).join('');
  }
  // The banner over a release's page, or over the file it opened as: where it's from, its state, and why it
  // was withdrawn.
  function relBanner(x) {
    var st = x.state || x.rel.state, why = x.withdrawnWhy || (x.rel && x.rel.withdrawnWhy) || '';
    return (st === 'withdrawn' ? '<div class="hint fl-warn"><b>▲ Withdrawn</b>' + esc(why || 'This release was withdrawn.') + ' Flash it only if you mean to.</div>' : '') +
      (st === 'draft' ? '<div class="hint"><b>Draft</b>Not released yet: for the bench. Only FTEs see it.</div>' : '');
  }
  function releaseHtml() {
    var x = relOf(S.relKey);
    if (!x) return homeHtml();
    var t = x.target, r = x.rel;
    var h = '<div class="page"><div class="page-head"><div class="page-head-text"><div class="eyebrow">Signoff FW · ' + esc(t.name) + '</div>' +
      '<h1 class="page-title">' + esc(t.name + ' ' + r.version) + '</h1><div class="page-sub"><span class="chips">' + relState(r) +
      '<span class="chip">' + esc(r.kind.toUpperCase() + ' · ' + I.fmtBytes(r.size)) + '</span>' +
      '<span class="chip">' + esc(r.via === 'passthrough' ? 'Through a passthrough' + (r.board ? ' · ' + r.board : '') : 'Its own USB' + (r.board ? ' · ' + r.board : '')) + '</span>' +
      (r.releasedAt ? '<span class="chip">Released ' + esc(r.releasedAt) + '</span>' : '') +
      '<span class="chip fl-mono" title="SHA-256 ' + esc(r.sha256) + '">' + esc(r.sha256.slice(0, 12)) + '</span></span></div></div>' +
      (S.fwr.demo ? '' : '<div class="fl-row fl-head-acts"><a class="btn btn-plain" href="' + esc(FL.fwr.reviewUrl(t, r)) + '">Open in Signoff FW</a></div>') + '</div>';
    h += relBanner(x);
    if (r.via !== 'passthrough') {
      h += S.rel && S.rel.error ? '<div class="hint fl-bad"><b>Couldn’t get the release</b>' + esc(S.rel.error) + '<div class="fl-row"><button class="btn btn-primary" data-act="open-rel" data-rel="' + esc(S.relKey) + '">Try again</button></div></div>'
        : '<div class="hint"><b>Getting the release</b>Reading ' + esc(r.kind.toUpperCase()) + ' from ' + esc(t.repo) + ' and checking its SHA-256…</div>';
      return h + '</div>';
    }
    // A passthrough release goes on a system's remote: pick one, or start one.
    var list = systemsOn() ? readSystems() : [];
    h += '<div class="card fl-pad"><h3 class="fl-sys-edit-title">Put it on a passthrough system</h3>' +
      '<p class="note">This build reaches its board through another board’s passthrough. Pick the system whose remote it’s for' + (r.board ? ' (the bootloader there should answer “' + esc(r.board) + '”)' : '') + '; the system keeps this release until you switch it.</p>' +
      (systemsOn() ? '<div class="fl-rel-systems">' + list.map(function (sys) {
        var cur = sys.remote && sys.remote.release ? sys.remote.release.version + ' from Signoff FW' : sys.remote && sys.remote.file ? sys.remote.file.name : 'No file yet';
        return '<button class="btn" data-act="rel-to-sys" data-sys="' + esc(sys.id) + '">' + esc(sys.name) + ' <span class="fl-muted">· now ' + esc(cur) + '</span></button>';
      }).join('') + '<button class="btn btn-primary" data-act="rel-to-sys" data-sys="">New passthrough system</button></div>'
        : '<p class="note">Passthrough systems are for FTEs for now.</p>') + '</div>';
    return h + '</div>';
  }

  // ?fw=<board>/<id> opens one firmware. Read once at start: renders while loading rewrite the address.
  var linked = /[?&]fw=([a-z0-9_-]+)\/([a-z0-9_-]+)/.exec(location.search);
  function restoreFromUrl() {
    if (linked && S.view === 'home') { S.view = 'fw'; S.fwId = linked[2] + '@' + linked[1]; }
    linked = null;
  }
  function setUrl() {
    var c = current(), q = [];
    if (DEMO) q.push(DEMO_PROBE === 'h5' ? 'demo=h5' : 'demo');
    if (S.tab !== 'serial') q.push('tab=' + S.tab);
    if (c && !c.fw.local) q.push('fw=' + c.fw.board + '/' + c.fw.id);
    var rk = S.view === 'release' ? S.relKey : S.view === 'local' && S.local && S.local.release ? S.local.release.key : wantRel;
    if (rk) q.push('release=' + rk);
    var jk = S.view === 'local' && S.local && S.local.jig ? S.local.jig.key : wantJig || S.jigBusy;
    if (jk) q.push('jig=' + jk);
    try { history.replaceState(null, '', location.pathname + (q.length ? '?' + q.join('&') : '')); } catch (e) { /* file:// */ }
  }

  // ── Rendering ──
  function render() {
    renderSide();
    renderAccount();
    var v = $('#view'), c = current();
    if ((S.view === 'fw' || S.view === 'local') && !c) S.view = 'home';
    if (S.view === 'system' && (!S.sys || (!S.loading && !systemsOn()))) S.view = 'home';
    if (S.view === 'people' && !S.loading && !(S.catalog && S.catalog.fte)) S.view = 'home';
    renderTabs();
    if (S.loading && linked) return;   // keep ?fw= in the address until the list is here
    if (S.view === 'release' && !relOf(S.relKey) && !(S.fwr && S.fwr.state === 'loading')) S.view = 'home';
    if (S.view === 'project' && !projectByKey(S.projKey) && !S.loading) S.view = 'home';
    v.innerHTML = S.view === 'home' ? homeHtml() : S.view === 'people' ? peopleHtml() : S.view === 'system' ? systemHtml(current()) : S.view === 'release' ? releaseHtml() : S.view === 'project' ? projectHtml() : fwHtml(current());
    if (S.tab === 'console') renderConsole();
    // The probe draws itself; it's redrawn here only when its tab opens, so a sync or a fetch finishing
    // never wipes what's typed in its fields.
    if (S.tab === 'probe' && !probeWas) showProbe();
    probeWas = S.tab === 'probe';
    $('#people-link').hidden = !(S.catalog && S.catalog.fte && !DEMO);
    $('#people-link').classList.toggle('active', S.view === 'people' && S.tab === 'serial');
    document.title = (S.tab === 'probe' ? 'Debug probe · ' : S.tab === 'console' ? 'Console · ' : c ? c.fw.name + ' · ' : '') + 'Flasher';
    setUrl();
  }

  // ── The tabs across the top, and what's connected on the current one ──
  var TABS = [
    ['serial', 'Serial bootloader', 'Serial', '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5v10"/><path d="M7 5.5l3-3 3 3"/><rect x="6" y="12.5" width="8" height="5" rx="1.2"/></svg>'],
    ['probe', 'Debug probe', 'Probe', '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 10h4l2-4.5 3 9 2-4.5h4"/></svg>'],
    ['console', 'Console', 'Console', '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M6 8l2.5 2L6 12M10.5 12.5h3.5"/></svg>']
  ];
  function probeStatus() { return FL.probeApp && FL.probeApp.status ? FL.probeApp.status() : { on: false, text: 'No probe' }; }
  function renderTabs() {
    var ps = probeStatus(), cs = S.con || {};
    $('#toptabs').innerHTML = TABS.map(function (t) {
      var live = t[0] === 'console' ? (cs.open || cs.paused ? '<span class="fl-live' + (cs.paused ? ' paused' : '') + '" title="' + (cs.paused ? 'Paused for a flash' : 'Connected') + '"></span>' : '')
        : t[0] === 'probe' && ps.on ? '<span class="fl-live" title="Connected"></span>' : '';
      return '<button role="tab" data-act="top-tab" data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '" aria-selected="' + (S.tab === t[0]) + '">' +
        t[3] + '<span class="fl-tab-long">' + t[1] + '</span><span class="fl-tab-short">' + t[2] + '</span>' + live + '</button>';
    }).join('');
    ['serial', 'probe', 'console'].forEach(function (k) { $('[data-pane="' + k + '"]').hidden = S.tab !== k; });
    // The chip beside the tabs: what this tab is connected to.
    var tone = '', text;
    if (S.tab === 'probe') { tone = ps.busy ? 'busy' : ps.on ? 'ok' : ''; text = ps.text; }
    else if (S.tab === 'console') { tone = cs.paused || cs.connecting ? 'busy' : cs.open ? 'ok' : ''; text = cs.paused ? 'Paused for a flash' : cs.open ? (cs.name || 'Serial port') + ' · ' + S.conBaud + ' baud' : cs.connecting ? 'Connecting…' : 'No port open'; }
    else { var r = S.run; tone = r && r.busy ? 'busy' : r && r.ok ? 'ok' : r && r.error ? 'error' : ''; text = r && r.busy ? (r.phase || 'Working…') : r && r.ok ? 'Done' : r && r.error ? r.errorTitle : 'No board'; }
    $('#conn').innerHTML = '<span class="sync-dot"' + (tone ? ' data-tone="' + tone + '"' : '') + '></span>' + esc(text);
  }

  // The sidebar, as in Signoff EE: firmware grouped by project, each group folding (kept per browser),
  // with a search over projects, boards, and firmware.
  var GROUPS_KEY = (DEMO ? 'flasher.demo.' : 'flasher.v1.') + 'closedGroups';
  function closedGroups() { try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function toggleGroup(pid) {
    var c = closedGroups(); if (c[pid]) delete c[pid]; else c[pid] = 1;
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(c)); } catch (e) { /* storage blocked */ }
    renderSide();
  }
  var FW_ICON = '<span class="fl-proj-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="12" rx="2.2"/><path d="M11 6.6 8.4 10.3h3.3L9.2 13.6"/></svg></span>';
  function renderSide() {
    var list = $('#fw-list'), h = '', q = ($('#fw-search').value || '').trim().toLowerCase();
    if (S.catalog || readDrafts().length || (systemsOn() && readSystems().length)) h = workingRows(q);
    else if (S.loading) h = '<div class="side-empty">Loading firmware…</div>';
    else if (!DEMO && !C.auth.token()) h = '<div class="side-empty">Projects’ firmware is private: <a href="#" data-act="account">sign in</a> to see what’s shared with you. A file, the probe, and the console work without it.</div>';
    // A file from this computer, always first: it works signed out.
    var fileRow = '<button class="proj fl-file-row' + (S.view === 'local' ? ' active' : '') + '" data-act="' + (S.local ? 'open-local' : 'open-file') + '" title="Flash a .bin file from this computer">' +
      '<span class="fl-proj-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5H5.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M11.5 2.5V7H16"/></svg></span>' +
      '<span class="proj-body"><span class="proj-name">' + esc(S.local ? S.local.name : 'A file from this computer') + '</span><span class="proj-sub">' +
      esc(S.local ? I.fmtBytes(S.local.bytes.length) : '.bin, .hex, or .elf; or drop it here') + '</span></span></button>';
    list.innerHTML = fileRow + h + fwrRows() + jigRows();
    var pl = document.querySelector('.side-tools [data-internal]');
    if (pl) pl.hidden = !(DEMO || (S.catalog && S.catalog.fte));
  }

  // The Dovetail Signoff links fold to a row of icons, as in Signoff EE (setupToolsFold there):
  // the chevron opens them, and they fold again 10 s after the pointer or keyboard leaves.
  var TOOLS_FOLD_MS = 10000;
  function setupToolsFold(tools) {
    var head = tools.querySelector('.side-head');
    if (!head || tools.dataset.fold) return;
    tools.dataset.fold = '1';
    var label = head.textContent.trim() || 'Dovetail Signoff';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'side-tools-toggle';
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>' +
      '<span class="side-label">' + esc(label) + '</span>';
    head.textContent = '';
    head.appendChild(btn);
    var timer = null;
    function inUse() { return tools.matches(':hover') || !!tools.querySelector(':focus-visible'); }
    function stop() { if (timer) { clearTimeout(timer); timer = null; } }
    function arm() { stop(); if (!tools.classList.contains('folded') && !inUse()) timer = setTimeout(function () { set(true); }, TOOLS_FOLD_MS); }
    function set(folded) {
      tools.classList.toggle('folded', folded);
      var tip = (folded ? 'Show ' : 'Hide ') + label + ' tools';
      btn.setAttribute('aria-expanded', String(!folded));
      btn.title = tip; btn.setAttribute('aria-label', tip);
      if (folded) stop(); else arm();
    }
    btn.addEventListener('click', function () { set(!tools.classList.contains('folded')); });
    tools.addEventListener('mouseenter', stop);
    tools.addEventListener('mouseleave', function () { setTimeout(arm, 0); });
    tools.addEventListener('focusin', function () { if (inUse()) stop(); });
    tools.addEventListener('focusout', function () { setTimeout(arm, 0); });
    set(true);
  }

  // The sync pill, as in Signoff EE: line 1 is the state and when it last synced, line 2 the GitHub ID.
  // A click syncs (signs in when signed out); the gear beside it opens Settings.
  function relTime(t) {
    var m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  }
  function renderAccount() {
    var dot = $('#account-dot'), t = $('#account-title'), s = $('#account-sub'), pill = $('#account-pill');
    s.classList.remove('sync-who');
    var who = S.catalog && S.catalog.login ? '@' + S.catalog.login : '';
    // Before the first sync after a sign-in, the sign-in itself says who it is. Never the data repo:
    // the suite's pills read as the wrong account that way (Chris, 2026-11-13).
    var signedAs = !who && window.SignoffAuth ? window.SignoffAuth.status().login : '';
    if (signedAs) who = '@' + signedAs;
    function line2(fallback) { s.textContent = who || fallback; if (who) s.classList.add('sync-who'); }
    pill.classList.toggle('is-syncing', !!S.syncing);
    if (DEMO) { dot.dataset.tone = 'ok'; t.textContent = 'Demo'; s.textContent = 'Made-up firmware, simulated board'; pill.title = 'Demo mode'; return; }
    var tok = C.auth.token();
    if (!tok) { dot.dataset.tone = 'idle'; t.textContent = 'Not signed in'; s.textContent = 'Click to sign in'; pill.title = 'Sign in to GitHub to list firmware'; return; }
    pill.title = 'Sync the firmware list with GitHub' + (S.catalog ? ' · ' + S.catalog.firmware.length + ' firmware, ' + (S.catalog.fte ? 'FTE: every project' : 'the projects shared with you') : '');
    if (S.syncing) { dot.dataset.tone = 'busy'; t.textContent = 'Syncing…'; line2('Checking your token'); return; }
    if (S.error || S.syncError) { dot.dataset.tone = 'error'; t.textContent = 'Sync failed'; s.textContent = 'Click to try again'; pill.title = S.error || S.syncError; return; }
    dot.dataset.tone = S.syncedAt ? 'ok' : 'idle';
    t.textContent = S.syncedAt ? 'Synced ' + relTime(S.syncedAt) : 'Not synced yet';
    line2('Click to sync');
  }
  setInterval(function () { if (!S.syncing) renderAccount(); }, 60000);


  function browserNote() {
    if (DEMO) return '';
    var usb = !!navigator.usb, serial = !!navigator.serial;
    if (usb && serial) return '';
    if (!window.isSecureContext) return '<div class="hint fl-warn"><b>Needs https</b>Browsers only allow USB access from https pages or localhost. Open Flasher from its GitHub Pages address.</div>';
    return '<div class="hint fl-warn"><b>Use Chrome or Edge</b>This browser can’t reach USB devices' + (usb ? ' over serial' : '') +
      '. Flashing needs WebUSB and Web Serial, which Chrome and Edge have on Windows, macOS, and Linux (Firefox and Safari don’t).</div>';
  }

  // Home: the banner and the flash tool with nothing picked yet (Chris, 2026-11-17), as the Debug probe
  // tab shows its tool before a probe is connected. The firmware is picked in the sidebar.
  function homeHtml() {
    var h = '<div class="page"><div class="page-head"><div class="page-head-text"><div class="eyebrow">Serial bootloader</div>' +
      '<h1 class="page-title">Flash a board</h1><div class="page-sub">Pick the firmware, plug the board in by USB, and flash it from Chrome or Edge. Everything runs in the browser, with no IDE or programming software to install.</div></div></div>';
    h += browserNote();
    var c = S.catalog;
    if (S.jigBusy) h += '<div class="hint"><b>Getting the Jig build</b>Reading ' + esc(S.jigBusy.split('/')[0]) + ', build ' + esc(S.jigBusy.split('/')[1].slice(0, 8)) + ', and checking its SHA-256…</div>';
    if (S.loading) h += '<div class="hint"><b>Loading</b>Reading the firmware list from ' + esc(DEMO ? 'the demo' : FL.config.owner + '/' + FL.config.repo) + '…</div>';
    else if (!DEMO && !C.auth.token()) {
      h += '<div class="hint fl-signin"><b>Projects’ firmware is private</b>Sign in with the GitHub access you use for Signoff to see the projects shared with you. A file from this computer, the Debug probe, and the Console work without it.' +
        '<div class="fl-row">' + (ghAuth() ? '<button class="btn btn-primary" data-act="gh-signin">Sign in with GitHub</button><button class="btn" data-act="account">Use a token…</button>'
          : '<button class="btn btn-primary" data-act="account">Sign in…</button>') + '<a class="fl-demo-link" href="?demo">Or try the demo</a></div></div>';
    } else if (S.error && S.errorCode === 'none' && S.fwr && S.fwr.targets && S.fwr.targets.length) {
      h += '<div class="hint"><b>Releases from Signoff FW</b>The firmware targets shared with you in Signoff FW are in the list on the left.</div>';
    } else if (S.error) {
      if (S.invites && S.invites.length) {
        h += '<div class="hint fl-warn"><b>An invitation is waiting</b>' + esc(S.error) + '<div class="fl-row">' +
          S.invites.map(function (i) { return '<button class="btn btn-primary" data-act="accept-invite" data-id="' + esc(i.id) + '">Accept ' + esc(i.repo) + '</button>'; }).join('') + '</div></div>';
      } else {
        h += '<div class="hint fl-bad"><b>Couldn’t read the firmware list</b>' + esc(S.error) +
          '<div class="fl-row"><button class="btn btn-primary" data-act="reload">Try again</button><button class="btn" data-act="account">GitHub sign-in…</button></div></div>';
      }
    } else if (c) {
      if (c.invites && c.invites.length) {
        h += '<div class="hint fl-warn"><b>Invitation waiting</b>You’ve been given more firmware on GitHub. Accept to see it here.<div class="fl-row">' +
          c.invites.map(function (i) { return '<button class="btn btn-primary" data-act="accept-invite" data-id="' + esc(i.id) + '">Accept ' + esc(i.repo) + '</button>'; }).join('') + '</div></div>';
      }
      if (c.problems.length) h += '<details class="guide"><summary>' + c.problems.length + ' entr' + (c.problems.length === 1 ? 'y' : 'ies') + ' in manifest.json skipped</summary><ul>' + c.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></details>';
      if (!c.firmware.length) h += '<div class="hint"><b>Nothing published yet</b>' + esc(c.source) + ' has no firmware in its manifest.</div>';
    }
    h += emptyToolHtml();
    if (c && c.firmware.length) h += '<p class="note fl-foot">' + c.firmware.length + ' firmware from ' + esc(c.source) + (c.updated ? ', updated ' + esc(fmtDate(c.updated)) : '') + '. Every file is checked against its SHA-256 before it’s flashed.</p>';
    return h + '</div>';
  }
  // The flash panel before anything is picked: the route, the steps, and a Flash button waiting.
  function emptyToolHtml() {
    var route = FL.route.html({
      nodes: [{ icon: 'pc', name: 'This computer', status: 'Ready', on: true }, { icon: 'board', name: 'The board', status: 'Nothing picked yet' }],
      links: [false], note: 'Pick firmware to flash', cells: FL.route.passes(24, 0, 0, 0),
      legend: [['unk', 'Not written yet'], ['erased', 'Erased'], ['diff', 'Written'], ['done', 'Read back and checked']]
    });
    return '<div class="card fl-panel' + (detailsHidden() ? ' terse' : '') + '"><div class="fl-tabs" role="tablist"><button role="tab" class="on" aria-selected="true">Flash</button>' + detailsBtn() + '</div><div class="fl-tab-body">' + route +
      '<div class="fl-flash"><p class="fl-intro">Pick the firmware in the list on the left' + (S.catalog || DEMO ? '' : ' (once signed in)') + ', or flash a <b>.bin</b> file from this computer.</p>' +
      '<ol class="fl-steps">' +
      '<li class="fl-step"><span class="fl-num">1</span><div><div class="fl-step-title">Pick the firmware</div><div class="fl-step-sub">From a project in the list, or a file. A project’s firmware knows its board and how to restart it.</div>' +
      '<div class="fl-row"><button class="btn" data-act="open-file">Open a file…</button><span class="fl-muted">or drop a .bin, .hex, or .elf anywhere on the page</span></div></div></li>' +
      '<li class="fl-step"><span class="fl-num">2</span><div><div class="fl-step-title">Put the board in update mode</div><div class="fl-step-sub">Flasher restarts it over USB when its firmware listens for that; otherwise BOOT0 and reset, by hand.</div></div></li>' +
      '<li class="fl-step"><span class="fl-num">3</span><div><div class="fl-step-title">Write, check, and run it</div><div class="fl-step-sub">Flasher erases the board, writes the firmware, reads it back to check every byte, and starts it.</div></div></li>' +
      '</ol><div class="fl-row"><button class="btn btn-primary" disabled title="Pick firmware first">Flash board</button><span class="fl-muted">Pick firmware first.</span></div></div></div></div>';
  }
  function fwHtml(c) {
    var fw = c.fw, b = c.board, run = S.run && S.run.key === runKey() ? S.run : null;
    var h = '<div class="page"><div class="page-head"><div class="page-head-text"><div class="eyebrow">' + esc(b.name) + '</div>' +
      '<h1 class="page-title">' + esc(fw.name) + '</h1><div class="page-sub"><span class="chips">' +
      '<span class="chip">' + esc(b.kind === 'bridge' ? I.fmtBytes(fw.size) + (fw.units && fw.units.length ? ' in ' + fw.units.length + ' blocks' : '') : I.fmtBytes(fw.size) + ' of ' + I.fmtBytes(b.flash.size)) + '</span>' +
      (fw.built ? '<span class="chip">Built ' + esc(fmtDate(fw.built)) + '</span>' : '') +
      (fw.source && fw.source.sha ? '<span class="chip" title="' + esc(fw.source.repo + ' ' + fw.source.path) + '">' + esc((fw.source.repo || '').split('/').pop() + ' @ ' + fw.source.sha.slice(0, 7)) + '</span>' : '') +
      (fw.source && fw.source.dirty ? '<span class="chip fl-chip-warn" title="The checkout it was built from had uncommitted changes">Uncommitted changes</span>' : '') +
      '<span class="chip fl-mono" title="SHA-256 ' + esc(fw.sha256) + '">' + esc(fw.sha256.slice(0, 12)) + '</span></span></div></div></div>';
    h += browserNote();
    if (fw.local && S.local && S.local.release) {
      var lr = S.local.release;
      h += '<div class="hint"><b>From Signoff FW</b>' + esc(lr.target + ' ' + lr.version) + ', ' + esc(FL.fwr.LABEL[lr.state].toLowerCase()) + '. Its SHA-256 was checked when it was read.</div>' + relBanner(lr);
    }
    if (fw.local && S.local && S.local.jig) h += jigHint(S.local.jig);
    if (fw.local) {
      // Every board, those reached through another board's passthrough too (a .hex or .elf is split into its blocks).
      var opts = Object.keys(boards()).map(function (id) { return '<option value="' + esc(id) + '"' + (S.local.boardId === id ? ' selected' : '') + '>' + esc(boards()[id].name) + (boards()[id].kind === 'bridge' ? ' (through its passthrough)' : '') + '</option>'; }).join('');
      h += '<div class="card fl-pad"><div class="field"><label for="local-board">Board</label><select class="input" id="local-board" data-change="local-board">' + opts +
        '<option value=""' + (S.local.boardId && boards()[S.local.boardId] ? '' : ' selected') + '>' + esc(I.GENERIC.name) + '</option></select></div>' +
        '<p class="note">' + (b.kind === 'bridge' ? 'Flasher splits the file into ' + esc(b.name) + '’s blocks, compares each with the board, and writes only the ones that differ.'
          : 'The board decides the checks (flash size, RAM) and how it’s put in update mode.') + (S.catalog ? '' : ' Sign in to choose one of Dovetail’s boards.') + '</p>' +
        '<div class="fl-row"><button class="btn" data-act="open-file">Open another file…</button></div></div>';
    } else if (fw.description || canEdit()) {
      // Collapsible; the choice is kept for this browser (flasher.v1.about). FTEs edit the name and project in its
      // header (docs/working-projects.md); the fields stop the click so the card doesn't fold.
      h += '<details class="card fl-about" data-toggle="about"' + (aboutOpen() ? ' open' : '') + '><summary><span class="fl-about-title">About this firmware</span>' +
        (canEdit() ? fwEditHtml(fw) : '<span class="fl-about-sum">' + esc(fw.summary || '') + '</span>') +
        '<svg class="fl-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></summary>' +
        '<div class="fl-desc">' + (canEdit() && fw.summary ? '<p><b>' + esc(fw.summary) + '</b></p>' : '') + esc(fw.description || (fw.uploadedBy ? 'Uploaded by ' + fw.uploadedBy + (fw.published ? ', ' + fmtDate(fw.published) : '') + '.' : '')) + '</div></details>';
    }
    // One panel: the update. The board's console is the Console tab.
    h += '<div class="card fl-panel' + (detailsHidden() ? ' terse' : '') + '"><div class="fl-tabs" role="tablist"><button role="tab" class="on" aria-selected="true">' + esc(b.kind === 'bridge' ? BRIDGE_TAB : 'Flash') + '</button>' + detailsBtn() + '</div>' +
      '<div class="fl-tab-body">' + (b.kind === 'bridge' ? bridgeHtml(c, run) : flashHtml(c, run)) + '</div></div>';
    return h + '</div>';
  }

  // The ⓘ at the top right of a flash panel hides its explanations (the intro and each step's text),
  // leaving the route, the step titles, and the buttons (Chris, 2026-11-17). Kept per browser.
  var DETAILS_KEY = 'flasher.v1.detailsHidden';
  function detailsHidden() { try { return localStorage.getItem(DETAILS_KEY) === '1'; } catch (e) { return false; } }
  function detailsBtn() {
    var off = detailsHidden(), tip = off ? 'Show the details' : 'Hide the details';
    return '<button type="button" class="icon-btn fl-details-btn' + (off ? '' : ' on') + '" data-act="toggle-details" aria-pressed="' + !off + '" title="' + tip + '" aria-label="' + tip + '">' +
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5"/><circle cx="10" cy="6.2" r=".6" fill="currentColor"/></svg></button>';
  }

  // ── The route diagram above each update (assets/route.js) ──
  function cellCount(bytes) { return Math.max(8, Math.min(48, Math.ceil((bytes || 0) / 4096) || 24)); }
  function directRoute(c, run) {
    var b = c.board, generic = b.id === I.GENERIC.id, bname = generic ? 'The board' : b.name;
    var pc = 'Ready', bs = generic ? 'Not connected yet' : b.run ? 'Running its firmware' : 'Not connected yet', link = false, pcLive = false, bLive = false, good = false;
    if (run) {
      if (run.ok) { pc = 'Done'; bs = 'Running ' + c.fw.name; good = true; }
      else if (run.error) { pc = 'Stopped'; bs = run.step === 'write' ? 'Still in update mode' : bs; }
      else if (run.waitPick) { pc = 'Waiting for you to pick it'; bs = run.step === 'restart' ? bs : 'In update mode?'; }
      else if (run.step === 'restart') { pc = 'Restarting the board'; bs = 'Going into update mode'; link = pcLive = bLive = true; }
      else if (run.step === 'write') { pc = (run.phase || 'Writing').split(' · ')[0]; bs = 'Update mode (DFU)'; link = pcLive = bLive = true; }
      else if (run.step === 'start') { pc = 'Starting it'; bs = 'Restarting'; link = pcLive = bLive = true; }
    }
    var size = bytesFor && bytesFor.key === runKey() ? bytesFor.bytes.length : c.fw.size, n = cellCount(size), fr = (run && run.frac) || {};
    var cells = run && run.ok ? FL.route.passes(n, 1, 1, 1) : FL.route.passes(n, fr.erase || 0, fr.write || 0, fr.verify || 0);
    var note = run && run.busy && run.phase ? run.phase : run && run.ok ? I.fmtBytes(run.bytes || size) + ' written and read back' : I.fmtBytes(size) + ', drawn as ' + n + ' blocks';
    return FL.route.html({
      nodes: [{ icon: 'pc', name: 'This computer', status: pc, on: true, live: pcLive, good: good }, { icon: 'board', name: bname, status: bs, on: link || good, live: bLive, good: good }],
      links: [link], note: note, cells: cells, cellsLabel: 'The image in ' + n + ' blocks',
      legend: [['unk', 'Not written yet'], ['erased', 'Erased'], ['diff', 'Written'], ['done', 'Read back and checked']]
    });
  }
  function bridgeRoute(c, run) { return FL.route.html(bridgeModel(c, run)); }
  function bridgeModel(c, run) {
    var b = c.board, units = (b.system && S.sys.units) || c.fw.units || [];
    // The host by its board's name when the manifest has that board (its firmware's USB id), else by its port's.
    var bs = boards(), hostId = Object.keys(bs).filter(function (id) { return bs[id].kind !== 'bridge' && (bs[id].runs || []).some(function (r) { return b.runs.some(function (t) { return t.vid === r.vid && t.pid === r.pid; }); }); })[0];
    var host = b.hostName || (hostId ? bs[hostId].name : FL.serial.portNames(b.runs, 'The host board'));
    var ph = !run ? 'idle' : run.ok ? 'done' : run.error ? 'stopped' : run.waitPick ? 'pick' : run.step === 'restart' ? 'knock' : run.step === 'start' ? 'leave' : 'pass';
    var st = {
      idle: ['Ready', 'Its own firmware', 'Its own firmware · no USB'],
      knock: ['Knocking at ' + b.touchBaud + ' baud', 'Opening its passthrough', 'Its own firmware · no USB'],
      pick: ['Waiting for you to pick it', 'Passthrough?', 'Its bootloader?'],
      pass: [(run && run.phase || 'Talking to the board').split(' · ')[0], 'Passthrough', 'Bootloader'],
      leave: ['Saying goodbye', 'Back to its own firmware', 'Restarting'],
      done: ['Done', 'Its own firmware', 'Running ' + c.fw.name],
      stopped: ['Stopped', run && run.begun ? 'Passthrough closed' : 'Its own firmware', run && run.begun ? 'Waiting in its bootloader' : 'Its own firmware · no USB']
    }[ph];
    var usb = ph === 'knock' || ph === 'pass' || ph === 'leave', uart = ph === 'pass';
    var cells = (run && run.cells) || units.map(function () { return 'unk'; });
    if (run && run.ok && !run.compareOnly) cells = cells.map(function (s) { return s === 'unk' ? 'same' : s === 'diff' || s === 'now' ? 'done' : s; });
    var n = run && run.cells ? run.cells.filter(function (s) { return s === 'diff' || s === 'now' || s === 'done'; }).length : 0;
    var note = run && run.busy && run.phase ? run.phase : run && run.ok && run.result ? (run.result.changed.length ? run.result.changed.length + ' of ' + units.length + ' blocks ' + (run.compareOnly ? 'differ' : 'rewritten') : 'Already up to date') :
      units.length ? units.length + ' blocks, ' + I.fmtBytes(c.fw.size) : c.fw.split ? 'The blocks come from the board: its bootloader says what its flash is' : I.fmtBytes(c.fw.size);
    return ({
      nodes: [{ icon: 'pc', name: 'This computer', status: st[0], on: true, live: usb, good: ph === 'done' },
        { icon: 'host', name: host, status: st[1], on: usb || uart, live: uart || ph === 'knock' },
        { icon: 'target', name: b.name, status: st[2], on: uart || ph === 'done', live: uart, good: ph === 'done' && !run.compareOnly }],
      links: [usb, uart], note: note, cells: cells, cellsLabel: units.length + ' blocks, ' + n + ' different',
      legend: [['unk', 'Not checked yet'], ['same', 'Same, left alone'], ['diff', 'Differs'], ['done', 'Rewritten and read back']]
    });
  }

  var ABOUT_KEY = 'flasher.v1.about';
  function aboutOpen() { try { return localStorage.getItem(ABOUT_KEY) !== 'closed'; } catch (e) { return true; } }

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
    var h = '<div class="fl-flash">';
    if (chk && chk.errors.length) h += '<div class="hint fl-bad"><b>This image can’t be flashed</b>' + chk.errors.map(esc).join('<br>') + '</div>';
    if (chk && chk.warnings.length) h += '<div class="hint fl-warn"><b>Check</b>' + chk.warnings.map(esc).join('<br>') + '</div>';
    // A file flashed as any STM32 tries the restart too, on whichever serial port is picked (Chris,
    // 2026-11-17): an Arduino-style board answers; if none does, the board is put in update mode by hand.
    var generic = b.id === I.GENERIC.id;
    var canTouch = !!((b.run || generic) && (DEMO || navigator.serial)), byHand = !canTouch || S.skipTouch;
    var dfuName = b.dfu.name || 'DFU in FS Mode';
    h = '<div id="fl-route-box">' + directRoute(c, run) + '</div>' + h;
    h += '<p class="fl-intro">Connect the board to USB and click <b>Flash board</b>. When first connected, Chrome may ask you to pick the board twice. After that flashing is one click.</p>';
    h += '<ol class="fl-steps">';
    h += '<li class="fl-step ' + stepState(run, 'restart') + '"><span class="fl-num">1</span><div><div class="fl-step-title">Put the board in update mode</div>' +
      (canTouch && !S.skipTouch
        ? (generic
          ? '<div class="fl-step-sub">Flasher tries to restart the board into update mode. Chrome shows a list of serial ports: pick the board’s and click <b>Connect</b>. A board whose firmware listens for a 1200-baud restart (Arduino-style boards do) goes into update mode on its own. If it doesn’t answer, Flasher says so and shows the BOOT0 steps.</div>'
          : '<div class="fl-step-sub">Flasher restarts the board so it can take new firmware. <i>First time:</i> Chrome shows a list. Pick <b>' + esc(FL.serial.portNames(b.runs, 'the board')) + '</b> and click <b>Connect</b>.' +
            (detachIds(b).length ? ' If the board runs <b>' + detachIds(b).map(function (x) { return esc(x.name || hex4(x.vid) + ':' + hex4(x.pid)); }).join('</b> or <b>') + '</b> instead, close that list, click <b>Pick…</b>, and choose it there: Flasher restarts it over USB.' : '') + '</div>')
        : '<div class="fl-step-sub">Press these on the board, then click <b>Flash board</b>:</div>' + buttonsHtml(b)) +
      (canTouch ? '<label class="fl-check"><input type="checkbox" data-change="skip"' + (S.skipTouch ? ' checked' : '') + (busy ? ' disabled' : '') + '> ' +
        (generic ? 'The board is already in update mode (BOOT0 held at reset), or runs no firmware' : 'The board isn’t running firmware (new, blank, or stuck)') + '</label>' : '') +
      '</div></li>';
    h += '<li class="fl-step ' + stepState(run, 'write') + '"><span class="fl-num">2</span><div><div class="fl-step-title">Write the firmware</div>' +
      '<div class="fl-step-sub"><i>First time:</i> Chrome shows ' + (byHand ? 'a' : 'a second') + ' list. Pick <b>' + esc(dfuName) + '</b> and click <b>Connect</b>. Flasher erases the board, writes the firmware, and reads it back to check every byte.</div>' +
      '</div></li>';
    h += '<li class="fl-step ' + stepState(run, 'start') + '"><span class="fl-num">3</span><div><div class="fl-step-title">Run it</div>' +
      '<div class="fl-step-sub">The board restarts and runs the new firmware. Nothing to do.</div></div></li>';
    h += '</ol>';
    if (run && run.error) h += '<div class="hint fl-bad"><b>' + esc(run.errorTitle || 'The flash stopped') + '</b>' + esc(run.error) + (run.errorHelp ? '<div class="fl-help">' + run.errorHelp + '</div>' : '') + '</div>';
    if (run && run.ok) h += '<div class="hint fl-good"><b>Done</b>' + esc(c.fw.name) + ' is on the board and running (' + esc(I.fmtBytes(run.bytes)) + ', ' + run.pages + ' pages, verified) in ' + (run.ms / 1000).toFixed(1) + ' s.</div>';
    h += '<div class="fl-row">';
    var blocked = (chk && chk.errors.length) || (!DEMO && !navigator.usb) || !S.bytesReady;
    if (run && run.waitPick && !busy) h += '<button class="btn btn-primary" data-act="pick-dfu">' + esc(pickLabel(b)) + '</button>';
    else h += '<button class="btn btn-primary" data-act="flash"' + (busy || blocked ? ' disabled' : '') + '>' + (busy ? 'Flashing…' : run && run.ok ? 'Flash again' : 'Flash board') + '</button>';
    if (run && run.ok && b.run && (DEMO || navigator.serial) && !(S.con && (S.con.open || S.con.paused))) h += '<button class="btn" data-act="console-board">Open its console</button>';
    if (!S.bytesReady && !S.bytesError) h += '<span class="fl-muted">Fetching the image…</span>';
    if (S.bytesError) h += '<span class="fl-muted fl-bad-text">' + esc(S.bytesError) + '</span>';
    h += '</div>';
    if (run && run.log.length) h += '<details class="fl-log"' + (run.error ? ' open' : '') + '><summary>Details</summary><div class="log">' + run.log.map(function (l) { return '<div class="' + (l.cls || '') + '">' + esc(l.text) + '</div>'; }).join('') + '</div></details>';
    h += '<details class="guide fl-manual"><summary>Board not in Chrome’s list?</summary><p>Close the Arduino IDE and any serial monitor, try another USB cable (some only charge), or set up the <a href="#" data-act="driver">Windows driver</a>.</p>' +
      '<p class="fl-muted">For the curious: update mode is the chip’s USB bootloader (DFU, USB ' + hex4(b.dfu.vid) + ':' + hex4(b.dfu.pid) + '), built into its ROM, so a failed flash can always be retried.</p></details>';
    return h + '</div>';
  }

  // The board's own steps into update mode, pressed by hand.
  function buttonsHtml(b) {
    var steps = b.manualDfu.length ? b.manualDfu : I.GENERIC.manualDfu;
    return '<ol class="fl-buttons">' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
  }
  function manualHtml(b) {
    return '<p>Press these on the board, then tick “The board isn’t running firmware” and click <b>Flash board</b> again:</p>' + buttonsHtml(b) +
      '<p>A failed or interrupted flash can always be retried this way. If “' + esc(b.dfu.name || 'DFU in FS Mode') + '” never appears in Chrome’s list on Windows, set up the <a href="#" data-act="driver">Windows driver</a>.</p>';
  }

  // ── The Console tab: any serial port, a terminal filling the page (Chris, 2026-11-17) ──
  var BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
  function conBoards() {   // the boards whose ports the list can be narrowed to (signed in)
    var bs = boards(); return Object.keys(bs).filter(function (id) { return bs[id].runs && bs[id].runs.length; }).map(function (id) { return bs[id]; });
  }
  function renderConsole() {
    var box = $('#console-view'), st = S.con || {};
    var termFocused = document.activeElement && document.activeElement.id === 'term-in';
    var tone = st.open ? 'ok' : st.connecting || st.paused ? 'busy' : st.error ? 'error' : 'idle';
    var label = st.paused ? 'Paused while the board is flashed; it reopens after' : st.open ? 'Connected to ' + (st.name || 'the port') + ' at ' + S.conBaud + ' baud' : st.connecting ? 'Connecting…' : st.error ? st.error : 'Not connected';
    var cb = conBoards(), locked = st.open || st.connecting || st.paused;
    var h = '<div class="fl-con-page"><div class="fl-con-strip">' +
      (st.open || st.paused ? '<button class="btn" data-act="console-close">Disconnect</button>'
        : '<button class="btn btn-primary" data-act="console"' + (st.connecting ? ' disabled' : '') + '>Choose a port…</button>') +
      (cb.length ? '<select class="input" data-change="con-filter" title="Which ports Chrome lists"' + (locked ? ' disabled' : '') + '><option value="">Any serial port</option>' +
        cb.map(function (b) { return '<option value="' + esc(b.id) + '"' + (S.conFilter === b.id ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('') + '</select>' : '') +
      '<select class="input" data-change="con-baud" title="Baud rate"' + (locked ? ' disabled' : '') + '>' + BAUDS.map(function (r) { return '<option' + (r === S.conBaud ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select>' +
      '<span class="sync-dot" data-tone="' + tone + '"></span><span class="fl-con-status">' + esc(label) + '</span><span class="fl-grow"></span>' +
      '<button class="btn" data-act="term-clear" title="Clear this window (the board isn’t told)">Clear</button>' +
      '<button class="btn" data-act="term-save" title="Save everything in this window as a text file">Save log…</button></div>' +
      '<div class="fl-con-body"><div class="fl-term" id="term"><pre id="term-out">' + term.html(false) + '</pre>' +
      // The keys go through a hidden field, as in xterm.js: special keys arrive as keydowns, and text
      // from a phone keyboard, dictation, or an input method arrives as input.
      '<textarea class="fl-term-in" id="term-in" aria-label="Console: keys go to the board" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea></div>' +
      '<p class="note">Any USB serial device: a board running its firmware, a USB-UART cable, or a probe’s virtual COM port. Click in the console and type: every key goes to the device as you type. Up and Down recall history, Tab completes, and Ctrl-L clears on a board whose console edits its own line. ' +
      'Ctrl-C copies when text is selected, and otherwise goes to the device. Flashing the same board from the Serial bootloader tab pauses the console and reopens it after.</p></div></div>';
    box.innerHTML = h;
    drawTerm(); var tb = $('#term'); if (tb) tb.scrollTop = tb.scrollHeight;
    if (termFocused) focusTerm();
  }

  // ── The image for the current firmware ──
  var bytesFor = null;   // { key, bytes }
  function runKey() { var c = current(); return c ? (c.fw.local ? 'local:' + c.fw.sha256 : c.fw.id + '@' + c.fw.board) + '|' + c.board.id : ''; }
  function prepareBytes() {
    var c = current(), key = runKey();
    S.check = null; S.bytesReady = false; S.bytesError = '';
    if (!c) return;
    if (c.board.kind === 'bridge') { S.bytesReady = true; return; }
    var flat = null;
    if (c.fw.local && S.local.segments) {
      var base = (c.board.flash || I.GENERIC.flash).base;
      flat = FL.files.flatten(S.local.segments);
      if (flat.addr !== base) { S.bytesError = 'This file starts at ' + I.hex(flat.addr) + ', and ' + (c.board.id === I.GENERIC.id ? 'the board' : c.board.name) + '’s flash starts at ' + I.hex(base) + '.'; return; }
    }
    var got = c.fw.local ? Promise.resolve(flat ? flat.data : S.local.bytes) : bytesFor && bytesFor.key === key ? Promise.resolve(bytesFor.bytes) : S.catalog.fetch(c.fw);
    got.then(function (bytes) {
      if (runKey() !== key) return;
      if (!c.fw.local && c.fw.kind === 'file' && c.fw.format !== 'bin') {
        var fl = FL.files.flatten(FL.files.parse(c.fw.path, bytes).segments);
        if (fl.addr !== c.board.flash.base) { S.bytesError = c.fw.name + ' starts at ' + I.hex(fl.addr) + ', and ' + c.board.name + '’s flash starts at ' + I.hex(c.board.flash.base) + '.'; render(); return; }
        bytes = fl.data;
      }
      bytesFor = { key: key, bytes: bytes };
      S.check = I.check(bytes, c.board); S.bytesReady = true; render();
      if (S.tab === 'probe') probeTakes();
    }, function (e) {
      if (runKey() !== key) return;
      S.bytesError = e.code === 'mismatch' ? 'The file in the repo doesn’t match its recorded SHA-256, so it won’t be flashed. Publish it again.' : (e.message || String(e));
      render();
      if (S.tab === 'probe') probeTakes();
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
  // Firmware with no serial port but a DFU runtime interface (the board's `detach` ids): restarted
  // into the bootloader with DFU detach over WebUSB (FL.dfuse.detach) instead of the touch.
  function detachIds(b) { return b.detach || []; }
  function isDetach(b, d) { return detachIds(b).some(function (x) { return d.vendorId === x.vid && d.productId === x.pid; }); }
  function findDetach(b) {
    if (DEMO || !navigator.usb || !detachIds(b).length) return Promise.resolve(null);
    return navigator.usb.getDevices().then(function (list) {
      return list.filter(function (d) { return isDetach(b, d); })[0] || null;
    });
  }
  // The Pick button's words: the bootloader, and before a detach, the firmware that takes one.
  function pickLabel(b) {
    var names = [b.dfu.name || 'DFU in FS Mode'];
    if (!(S.run && S.run.detached)) names = names.concat(detachIds(b).map(function (x) { return x.name || hex4(x.vid) + ':' + hex4(x.pid); }));
    return 'Pick ' + names.join(' or ');
  }
  function detachThenWait(dev, b) {
    log('Found the board running ' + (dev.productName || 'firmware without a serial port') + '.');
    return D.detach(dev, { log: function (t) { log(t); } }).then(function () {
      log('Waiting for the board to come back in update mode…');
      return waitDfu(b, 6000);
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
    if (DEMO) return Promise.resolve(demoBoard.running ? FL.fakeusb.serialPort(b.run ? { vid: b.run.vid, pid: b.run.pid } : { vid: 0x2341, pid: 0x8036 }) : null);
    return navigator.serial.getPorts().then(function (ports) {
      var mine = ports.filter(function (p) { return FL.serial.matches(p.getInfo(), b.runs); });
      if (mine.length === 1) return mine[0];
      return navigator.serial.requestPort({ filters: FL.serial.filters(b.runs) });
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
    // A console open on this board holds its serial port, and the restart request needs it: it pauses,
    // and reopens when the flash is over (resumeConsole).
    var closing = pauseConsoleFor(b);
    upd();
    var touched = false, generic = b.id === I.GENERIC.id;
    closing.catch(function () {}).then(function () { return findDfu(b); }).then(function (dev) {
      if (dev) { log('Found the board already in update mode (' + dev.productName + ').'); return dev; }
      if (S.skipTouch) return null;
      // A board running firmware that takes DFU detach (and this browser may already open it).
      return findDetach(b).then(function (rt) {
        if (rt) return detachThenWait(rt, b).then(function (d) { touched = true; return d; });
        if (!(b.run || generic) || (!DEMO && !navigator.serial)) return null;
        return pickSerial(b).then(function (port) {
          if (!port) {
            log(detachIds(b).length
              ? 'No serial port picked; the next list also offers the board running ' + detachIds(b).map(function (x) { return x.name || 'its other firmware'; }).join(' or ') + ' (click Pick… if Chrome doesn’t show it).'
              : 'No running board picked; looking for one already in update mode.');
            return null;
          }
          var baud = b.touchBaud || 1200;
          log('Restarting the board into its bootloader (' + baud + '-baud touch)…');
          return FL.serial.touch(port, { baud: baud }).then(function () {
            touched = true;
            if (DEMO) setTimeout(function () { demoBoard.running = false; }, 700);
            log('Waiting for the board to come back in update mode…');
            return waitDfu(b, 6000);
          });
        });
      });
    }).then(function (dev) {
      // This browser has opened the board's update mode before, so it would have been found by
      // now: the board restarted but never came back on USB.
      if (!dev && touched && dfuKnown(b)) {
        if (generic) throw Object.assign(new Error('Flasher sent the restart, but no board came back in update mode.'), { code: 'noanswer' });
        throw Object.assign(new Error('The board restarted but didn’t come back in update mode.'), { code: 'gone' });
      }
      S.run.step = 'write';
      if (dev) return writeTo(dev, c);
      return askForDfu(c, true, touched);
    }).catch(function (e) { stopWith(e, c); });
  }

  // The DFU device picker. Called from the Flash click (which may no longer count as a click by
  // the time we get here) or from "Pick DFU in FS Mode" (a fresh one).
  // Whether this browser has opened this board's update mode before (it then needs no picker, so a
  // board that doesn't show up within the wait isn't there).
  function dfuKeyOf(b) { return (DEMO ? 'flasher.demo.' : 'flasher.v1.') + 'dfuOk.' + b.dfu.vid + ':' + b.dfu.pid; }
  function dfuKnown(b) { try { return localStorage.getItem(dfuKeyOf(b)) === '1'; } catch (e) { return false; } }
  function dfuSeen(b) { try { localStorage.setItem(dfuKeyOf(b), '1'); } catch (e) { /* storage blocked */ } }

  function askForDfu(c, first, touched) {
    var b = c.board;
    if (DEMO) {
      if (demoBoard.running) return stopWith(Object.assign(new Error('No board in update mode was found.'), { code: 'none' }), c);
      return writeTo(demoDevice(), c);
    }
    // The list also offers firmware that takes DFU detach, so a board running it can be picked here.
    var filters = [{ vendorId: b.dfu.vid, productId: b.dfu.pid }].concat(detachIds(b).map(function (x) { return { vendorId: x.vid, productId: x.pid }; }));
    return navigator.usb.requestDevice({ filters: filters }).then(function (dev) {
      S.run.waitPick = false;
      if (!isDetach(b, dev)) return writeTo(dev, c);
      S.run.busy = true; upd();
      return detachThenWait(dev, b).then(function (d) {
        S.run.detached = true;
        if (d) return writeTo(d, c);
        // Not opened in this browser before: Chrome wants a click before it lists the bootloader.
        return askForDfu(c, true, true);
      });
    }, function (e) {
      // On the automatic first ask, Chrome may refuse to show its list without a fresh click: with a
      // SecurityError, or, right after another list closed (the serial one), with a NotFoundError.
      // Either way offer the Pick button; only a list opened from that button and closed is "none".
      if (e && (e.name === 'SecurityError' || e.name === 'NotFoundError') && first) {
        S.run.busy = false; S.run.waitPick = true;
        var pick = '“' + pickLabel(b) + '”';
        log(touched
          ? 'The board was asked to restart into update mode. Click ' + pick + ' and choose it. If Chrome’s list is empty, the board didn’t come back: press its reset button and flash again.'
          : 'Click ' + pick + ' and choose the board in update mode.');
        upd(); return;
      }
      if (e && e.name === 'NotFoundError') e = Object.assign(new Error('No board in update mode was chosen.'), { code: 'none' });
      throw e;
    }).catch(function (e) { stopWith(e, c); });
  }

  function writeTo(dev, c) {
    var b = c.board, bytes = bytesFor.bytes, base = b.flash.base;
    S.run.busy = true; S.run.waitPick = false; S.run.step = 'write'; S.run.phase = 'Connecting…'; upd();
    var dfu = new D.Dfuse(dev, { log: function (t) { log(t); }, fallbackLayout: b.layout });
    dfuSeen(b);
    var W ={ erase: [0, 0.15, 'Erasing'], write: [0.15, 0.6, 'Writing'], verify: [0.75, 0.25, 'Verifying'] };
    var lastDraw = 0;
    return dfu.open().then(function () {
      var seg = D.segmentAt(dfu.layout, base);
      var top = dfu.layout.segments.reduce(function (m, s) { return s.writable && s.end > m ? s.end : m; }, 0);
      if (!seg) throw D.DfuError('The device’s flash doesn’t start at ' + D.hex(base) + '. Is this the right board?', 'range');
      if (top - base !== b.flash.size && !c.fw.local) log('Note: ' + b.name + ' should have ' + I.fmtBytes(b.flash.size) + ' of flash; this device reports ' + I.fmtBytes(top - base) + '.', 'err');
      if (bytes.length > top - base) throw D.DfuError('The image (' + I.fmtBytes(bytes.length) + ') is larger than this device’s flash (' + I.fmtBytes(top - base) + ').', 'range');
      log('Erasing, writing, and verifying ' + bytes.length + ' bytes at ' + D.hex(base) + '…');
      S.run.frac = { erase: 0, write: 0, verify: 0 };
      return dfu.flash(base, bytes, function (p) {
        var w = W[p.phase], f = p.total ? p.done / p.total : 0; S.run.pct = w[0] + w[1] * f;
        S.run.frac[p.phase] = f;
        if (p.phase !== 'erase') S.run.frac.erase = 1;
        if (p.phase === 'verify') S.run.frac.write = 1;
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
      S.run.busy = false; S.run.ok = true; S.run.doneAt = Date.now(); S.run.ms = S.run.doneAt - S.run.t0;
      // The board now runs what was just written, so the next flash starts with the restart
      // request again (left ticked, the DFU list would be empty).
      S.skipTouch = false;
      upd();
      resumeConsole();
    }).catch(function (e) { dfu.close(); throw e; });
  }

  // Redraw just the route and its block map while writing, without rebuilding the page.
  function drawProgress() {
    var box = $('#fl-route-box'), c = current();
    if (!box || !c) return upd();
    box.innerHTML = c.board.system ? sysDiagram(c, S.run) : c.board.kind === 'bridge' ? bridgeRoute(c, S.run) : directRoute(c, S.run);
    renderTabs();
  }

  function stopWith(e, c) {
    var run = S.run, b = c.board;
    if (!run) return;
    run.busy = false; run.waitPick = false;
    var win = /Windows/.test(navigator.userAgent), name = e && e.name, msg = (e && e.message) || String(e);
    run.errorTitle = 'The flash stopped'; run.errorHelp = '';
    if (e && (e.code === 'noanswer' || (e.code === 'none' && b.id === I.GENERIC.id && !S.skipTouch))) {
      // A file flashed as any STM32: the restart was tried, and no board came back in update mode.
      run.errorTitle = 'The board didn’t answer the restart';
      run.error = msg + ' Its firmware may not listen for a 1200-baud restart, or it isn’t running. Put it in update mode by hand, then click “It’s in update mode”.';
      run.errorHelp = '<ol class="fl-buttons">' + I.GENERIC.manualDfu.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
        '<div class="fl-row"><button class="btn btn-primary" data-act="flash-byhand">It’s in update mode</button></div>';
    } else if (e && e.code === 'none') {
      run.errorTitle = 'No board in update mode';
      run.error = msg + (S.skipTouch && b.run
        ? ' “The board isn’t running firmware” is ticked, so Flasher didn’t ask the board to restart. If it is running firmware, untick that box and flash again.'
        : ' If the board was running, its firmware may not answer the restart request (or it’s blank).');
      run.errorHelp = '<details open><summary>Put it in update mode by hand</summary>' + manualHtml(b) + '</details>';
    } else if (e && e.code === 'gone') {
      run.errorTitle = 'The board didn’t come back';
      run.error = msg + ' It has dropped off USB, which some firmware does now and then as it restarts. Press the board’s reset button (or unplug it and plug it back in), then flash again.';
      run.errorHelp = '<details><summary>Or put it in update mode by hand</summary>' + manualHtml(b) + '</details>';
    } else if (e && e.code === 'busy') {
      run.error = msg;
    } else if (name === 'SecurityError' || /access denied/i.test(msg)) {
      run.errorTitle = 'The browser couldn’t open the board';
      run.error = msg + (win ? ' On Windows this usually means the board isn’t on the WinUSB driver, or another program (STM32CubeProgrammer, the Arduino IDE) has it open.' : ' Another program may have it open.');
      run.errorHelp = '<a href="#" data-act="driver">Windows driver help</a>';
    } else if (name === 'NetworkError' || name === 'NotFoundError' || /disconnected|lost/i.test(msg)) {
      run.errorTitle = 'The board disconnected';
      run.error = msg + ' Check the cable, put the board in update mode by hand, and flash again. A half-written flash is fine: update mode is built into the chip and can’t be erased.';
    } else {
      run.error = msg;
    }
    log(run.errorTitle + ': ' + msg, 'err');
    upd();
    resumeConsole();
  }

  // ── Bridge boards: updated through another board's USB passthrough (assets/sboot.js) ──
  // 1. The host board's firmware gets the touchBaud touch and reopens its USB as a passthrough to
  //    the board's bootloader (a new serial port, b.bridge). 2. Flasher compares every erase unit's
  //    CRC and writes only those that differ. 3. GO starts the new firmware, and opening the
  //    passthrough at exitBaud sends the host back to its own firmware.
  var BRIDGE_TAB = 'Update through passthrough';
  var demoBridge = { up: false, ports: {} };   // up: the demo host's passthrough is open; ports: each board's simulated one
  // A passthrough system's port is remembered by the system (its USB id is learned when it first answers INFO).
  function bridgeKeyOf(b) { return (DEMO ? 'flasher.demo.' : 'flasher.v1.') + 'bridgeOk.' + (b.system ? b.id : b.bridge.vid + ':' + b.bridge.pid); }
  function bridgeKnown(b) { try { return localStorage.getItem(bridgeKeyOf(b)) === '1'; } catch (e) { return false; } }
  function bridgeSeen(b) { try { localStorage.setItem(bridgeKeyOf(b), '1'); } catch (e) { /* storage blocked */ } }
  function demoBridgePort(c) {
    var b = c.board;
    if (!demoBridge.ports[b.id]) {
      // A passthrough system reaches the demo display as a real chip would answer (its layout from INFO). A file from
      // this computer holds no demo id: the simulated board starts from that board's published release.
      var simId = c.fw.local ? (S.catalog.firmware.filter(function (f) { return f.board === (b.system ? 'tstat-display' : b.id); })[0] || {}).id : c.fw.id;
      var sim = b.system ? S.catalog.demoSystemSim(simId, b.linkBaud) : S.catalog.demoDisplay(simId);
      var ids = b.system ? S.catalog.DEMO_PASSTHROUGH : b.bridge;
      demoBridge.ports[b.id] = FL.fakebridge.port(sim, { vid: ids.vid, pid: ids.pid, exitBaud: b.exitBaud, onExit: function () {
        demoBridge.up = false;
        // The host restarts the display into its own firmware; the next passthrough boots it again.
        setTimeout(function () { sim.running = false; sim.booted = false; sim.begun = false; sim.baud = b.linkBaud; }, 0);
      } });
    }
    return demoBridge.ports[b.id];
  }
  function findBridge(c) {
    var b = c.board;
    // In the demo, as in Chrome, the page sees the passthrough only once it has been picked.
    if (DEMO) return Promise.resolve(demoBridge.up && bridgeKnown(b) ? demoBridgePort(c) : null);
    if (!navigator.serial) return Promise.resolve(null);
    // With no USB id (a passthrough system that hasn't answered yet), only a pick finds it: Flasher never probes ports.
    if (!b.bridge) return Promise.resolve(null);
    return navigator.serial.getPorts().then(function (ports) {
      return ports.filter(function (x) { return FL.serial.matches(x.getInfo(), b.bridge); })[0] || null;
    });
  }
  function waitBridge(c, ms) {
    var until = Date.now() + ms;
    function again() { return findBridge(c).then(function (p) { return p || (Date.now() > until ? null : FL.serial.sleep(250).then(again)); }); }
    return again();
  }

  function bridgeState(run, step) {
    if (!run) return '';
    var order = ['restart', 'connect', 'write', 'start'], at = order.indexOf(run.step), me = order.indexOf(step);
    if (run.ok) return run.compareOnly && step === 'start' ? '' : 'done';
    if (me < at) return 'done';
    if (me === at) return run.error ? 'bad' : run.busy || run.waitPick ? 'now' : '';
    return '';
  }

  function bridgeHtml(c, run) {
    var b = c.board, busy = run && run.busy, host = b.hostName || FL.serial.portNames(b.runs, 'the host board'), via = (b.bridge && b.bridge.name) || 'the passthrough';
    var h = (b.system ? '' : '<div id="fl-route-box">' + bridgeRoute(c, run) + '</div>') + '<div class="fl-flash">';
    h += '<p class="fl-intro">This board has no USB port of its own. Plug in the board it’s connected to (Chrome lists it as <b>' + esc(host) + '</b>) and click <b>Update board</b>. ' +
      'Flasher reaches this board’s bootloader through it, compares every block, and writes only the ones that differ. <b>Compare only</b> changes nothing.</p>';
    h += '<ol class="fl-steps">';
    h += '<li class="fl-step ' + bridgeState(run, 'restart') + '"><span class="fl-num">1</span><div><div class="fl-step-title">Open the passthrough</div>' +
      '<div class="fl-step-sub">Flasher asks ' + esc(host) + ' to pass its USB through to this board. <i>First time:</i> Chrome shows a list. Pick <b>' + esc(host) + '</b> and click <b>Connect</b>. It refuses while its output is on.</div></div></li>';
    h += '<li class="fl-step ' + bridgeState(run, 'connect') + '"><span class="fl-num">2</span><div><div class="fl-step-title">Connect to the bootloader</div>' +
      '<div class="fl-step-sub"><i>First time:</i> Chrome shows a second list. Pick <b>' + esc(via) + '</b>' + (b.bridge ? '' : ', the port that appeared after step 1,') + ' and click <b>Connect</b>.' +
      (b.system ? ' Flasher checks it answers as a bootloader before using it, and remembers it.' : '') + '</div></div></li>';
    h += '<li class="fl-step ' + bridgeState(run, 'write') + '"><span class="fl-num">3</span><div><div class="fl-step-title">' + (run && run.compareOnly ? 'Compare' : 'Compare and write') + '</div>' +
      '<div class="fl-step-sub">Every block’s checksum is compared with the board’s; the ones that differ are erased, written, and read back.</div>' +
      '</div></li>';
    h += '<li class="fl-step ' + bridgeState(run, 'start') + '"><span class="fl-num">4</span><div><div class="fl-step-title">Run it</div>' +
      '<div class="fl-step-sub">This board starts its firmware, and ' + esc(host) + ' goes back to its own. Nothing to do.</div></div></li>';
    h += '</ol>';
    if (run && run.error) h += '<div class="hint fl-bad"><b>' + esc(run.errorTitle || 'The update stopped') + '</b>' + esc(run.error) + '</div>';
    if (run && run.ok) h += '<div class="hint fl-good"><b>' + esc(run.doneTitle) + '</b>' + esc(run.doneText) + '</div>';
    h += '<div class="fl-row">';
    if (c.fw.error) h += '<div class="hint fl-bad"><b>This file can’t be written to ' + esc(b.name) + '</b>' + esc(c.fw.error) + '</div>';
    // A file split once the board answers (fw.split) is ready as soon as it's picked.
    var blocked = (!DEMO && !navigator.serial) || !!c.fw.error || !(c.fw.split || (c.fw.units && c.fw.units.length));
    if (run && run.waitPick && !busy) h += '<button class="btn btn-primary" data-act="pick-bridge">Pick ' + esc(via) + '</button>';
    else {
      h += '<button class="btn btn-primary" data-act="bridge-update"' + (busy || blocked ? ' disabled' : '') + '>' + (busy && !run.compareOnly ? 'Updating…' : run && run.ok && !run.compareOnly ? 'Update again' : 'Update board') + '</button>';
      h += '<button class="btn" data-act="bridge-compare"' + (busy || blocked ? ' disabled' : '') + '>' + (busy && run.compareOnly ? 'Comparing…' : 'Compare only') + '</button>';
    }
    h += '</div>';
    if (run && run.log.length) h += '<details class="fl-log"' + (run.error ? ' open' : '') + '><summary>Details</summary><div class="log">' + run.log.map(function (l) { return '<div class="' + (l.cls || '') + '">' + esc(l.text) + '</div>'; }).join('') + '</div></details>';
    h += '<details class="guide fl-manual"><summary>Not in Chrome’s list?</summary><p>Close any other program using ' + esc(host) + '’s serial port (a terminal, the Arduino IDE’s Serial Monitor, another Flasher tab), and try another USB cable. ' +
      'If ' + esc(host) + ' isn’t running firmware that has the passthrough, flash that first.</p>' +
      '<p class="fl-muted">For the curious: the passthrough is ' + esc(host) + '’s USB serial port reopened as a pipe onto this board’s bootloader' + (b.bridge ? ' (USB ' + hex4(b.bridge.vid) + ':' + hex4(b.bridge.pid) + ')' : '') + '. ' +
      'An interrupted update is safe: this board waits in its bootloader until an update finishes, so run it again.</p></details>';
    return h + '</div>';
  }

  function startBridge(compareOnly) {
    var c = current();
    if (!c || c.board.kind !== 'bridge' || (S.run && S.run.busy)) return;
    var b = c.board, host = b.hostName || FL.serial.portNames(b.runs, 'the host board');
    if (c.fw.error) return;
    S.run = { key: runKey(), busy: true, step: 'restart', log: [], pct: 0, phase: '', t0: Date.now(), compareOnly: !!compareOnly };
    var closing = pauseConsoleFor(b);
    upd();
    closing.catch(function () {}).then(function () { return findBridge(c); }).then(function (port) {
      if (port) { log('The passthrough is already open.'); return port; }
      return pickSerial(b).then(function (hostPort) {
        // None picked: the passthrough may already be open (a cancelled pick, a page reloaded mid-way),
        // and then only its own list finds it.
        if (!hostPort) { log('No ' + host + ' was picked; it may already have its passthrough open.'); return null; }
        S.run.hostInfo = hostPort.getInfo ? hostPort.getInfo() : null;   // never to be taken for the passthrough
        log('Asking ' + host + ' to open its passthrough (' + b.touchBaud + '-baud touch)…');
        return FL.serial.touch(hostPort, { baud: b.touchBaud }).then(function () {
          if (DEMO) setTimeout(function () { demoBridge.up = true; }, 600);
          log('Waiting for the passthrough port…');
          // A system's passthrough that hasn't answered yet has no id to look for: straight to the pick.
          if (b.system && !b.bridge && !(DEMO && bridgeKnown(b))) return null;
          return waitBridge(c, bridgeKnown(b) ? 15000 : 5000);
        });
      }).then(function (p2) {
        if (p2) return p2;
        // Not found: this browser hasn't been allowed the passthrough port yet (its list needs a fresh
        // click), or the host didn't open it. Chrome's list tells which.
        S.run.busy = false; S.run.waitPick = true; S.run.step = 'connect';
        log('Click “Pick ' + ((b.bridge && b.bridge.name) || 'the passthrough') + '” and choose it. If Chrome’s list is empty, ' + host + ' didn’t open it: it refuses while its output is on.');
        upd(); return null;
      });
    }).then(function (port) { if (port) return runBridge(port, c); }).catch(function (e) { stopBridge(e, c); });
  }

  function pickBridge() {
    var c = current(); if (!c || !S.run) return;
    var b = c.board;
    S.run.busy = true; S.run.waitPick = false; upd();
    var got = DEMO ? Promise.resolve(demoBridge.up ? demoBridgePort(c) : null)
      : navigator.serial.requestPort(b.bridge ? { filters: FL.serial.filters(b.bridge) } : {}).catch(function (e) { if (e && e.name === 'NotFoundError') return null; throw e; });
    got.then(function (port) {
      if (!port) throw Object.assign(new Error('No passthrough port was chosen.'), { code: 'nobridge' });
      return runBridge(port, c);
    }).catch(function (e) { stopBridge(e, c); });
  }

  function runBridge(port, c) {
    var b = c.board, run = S.run, lastDraw = 0, failure = null, answered = false;
    run.busy = true; run.waitPick = false; run.step = 'connect'; run.phase = 'Connecting…'; upd();
    var link = new FL.sboot.Link(port), units = c.fw.units || [];
    run.cells = units.map(function () { return 'unk'; });
    function unitAt(addr) { for (var i = 0; i < units.length; i++) if (addr >= units[i].addr && addr < units[i].addr + units[i].size) return i; return -1; }
    function progress(p) {
      if (p.phase === 'connect') return;
      // The file was split once the board said what its flash is: now the block map has its blocks.
      if (p.phase === 'layout') { units = p.units; run.cells = units.map(function () { return 'unk'; }); if (b.system) S.sys.units = units; drawProgress(); return; }
      if (run.step !== 'write') { run.step = 'write'; upd(); }
      var f = p.total ? p.done / p.total : 0;
      // The block map: each block as it's compared, then written, then read back.
      if (p.phase === 'compare' && p.index >= 0) run.cells[p.index] = p.differs ? 'diff' : 'same';
      if (p.phase === 'write' && p.addr != null) { var wi = unitAt(p.addr); if (wi >= 0 && run.cells[wi] !== 'done') run.cells[wi] = 'now'; }
      if (p.phase === 'checked') { var ci = unitAt(p.addr); if (ci >= 0) run.cells[ci] = 'done'; drawProgress(); return; }
      if (p.phase === 'compare') { run.pct = run.compareOnly ? f : 0.1 * f; run.phase = 'Comparing · ' + p.done + ' of ' + p.total + ' blocks'; }
      if (p.phase === 'download') { run.pct = 0.1 + 0.05 * f; run.phase = 'Downloading · file ' + (p.done + 1) + ' of ' + p.total; }
      if (p.phase === 'write') {
        run.begun = true; run.pct = 0.15 + 0.85 * f;
        var secs = (Date.now() - (run.writeT0 || (run.writeT0 = Date.now()))) / 1000, left = p.done ? secs * (p.total - p.done) / p.done : 0;
        run.phase = 'Writing · ' + I.fmtBytes(p.done) + ' of ' + I.fmtBytes(p.total) + (p.done && left > 2 ? ' · about ' + Math.ceil(left) + ' s left' : '');
      }
      var now = Date.now(); if (now - lastDraw > 80 || p.done === p.total) { lastDraw = now; drawProgress(); }
    }
    return link.open(b.linkBaud).then(function () {
      log('Connected to ' + ((b.bridge && b.bridge.name) || 'the passthrough') + ' at ' + (b.linkBaud / 1e6) + ' Mbaud.');
      return FL.sboot.update(link, c.fw.split ? { parts: [] } : { units: c.fw.units, parts: c.fw.parts, commit: c.fw.commit }, {
        expect: b.expect, fastBaud: b.fastBaud, compareOnly: run.compareOnly, log: log, progress: progress,
        onInfo: function (info) {
          // Only a port that answered as a bootloader is the passthrough; only it gets the exit touch.
          answered = true; bridgeSeen(b);
          if (b.system) learnPassthrough(port, info, run.hostInfo);
        },
        split: c.fw.split ? function (info) {
          // A Signoff FW release names the board it's for; a bootloader that names another stops here, before
          // anything is compared or written. An older bootloader names none: it's said, and the update goes on.
          var want = c.fw.wantBoard;
          if (want && info.board && info.board !== want) throw new Error('The board answered as “' + info.board + '”, and ' + c.fw.name + ' is for “' + want + '”. Nothing was written.');
          if (want && !info.board) log('Its bootloader doesn’t say which board it is, so Flasher can’t check that ' + c.fw.name + ' (for “' + want + '”) fits it.');
          var lay = I.layoutFromInfo(info);
          log('Its flash, from the bootloader: ' + lay.chip + ', application ' + I.hex(info.appBase) + ' to ' + I.hex(info.appEnd) +
            (info.qspiSize ? ', external flash ' + I.fmtBytes(info.qspiSize) + ' in ' + I.fmtBytes(lay.regions[1].unit) + ' blocks' + (lay.qspiBlockGuessed ? ' (its block size assumed: this bootloader doesn’t report it)' : '') : '') +
            (info.board ? '; board “' + info.board + '”' : '') + '.');
          var img = I.unitsImage(c.fw.segments, lay, FL.sboot.crc32);
          log('Split ' + c.fw.name + ' into ' + img.units.length + ' blocks (' + I.fmtBytes(img.size) + ').');
          return img;
        } : null,
        fetchPart: function (part) {
          if (c.fw.local) return Promise.resolve(part.bytes);
          log('Downloading ' + part.path.split('/').pop() + ' (' + I.fmtBytes(part.size) + ')…');
          return S.catalog.fetch({ repo: c.fw.repo, path: part.path, sha256: part.sha256 });
        }
      });
    }).then(function (res) { run.result = res; }, function (e) { failure = e; }).then(function () {
      // Always leave the passthrough: the host goes back to its own firmware and restarts this board.
      // After a failed write the board stays in its bootloader until an update finishes.
      // The exit touch goes only to a port known to be the passthrough (its USB id, or it answered INFO): a 1200-baud
      // open resets many USB-serial boards into their bootloaders.
      run.step = 'start'; run.phase = 'Leaving the passthrough…'; upd();
      if (!FL.sboot.exitAllowed({ answered: answered, system: b.system, bridge: b.bridge, portInfo: port.getInfo ? port.getInfo() : null })) {
        log('That port never answered as a bootloader, so it wasn’t sent the exit touch.');
        return link.close();
      }
      return link.close().then(function () {
        return port.open({ baudRate: b.exitBaud }).then(function () { return port.close(); });
      }).catch(function () {}).then(function () { log('Left the passthrough (' + b.exitBaud + '-baud touch).'); });
    }).then(function () {
      if (failure) throw failure;
      var res = run.result, n = res.changed.length, total = units.length;
      run.busy = false; run.ok = true; run.doneAt = Date.now(); run.ms = run.doneAt - run.t0;
      if (run.compareOnly) {
        run.doneTitle = n ? n + ' of ' + total + ' blocks differ' : 'Already up to date';
        run.doneText = n ? I.fmtBytes(res.bytes) + ' would be written. Nothing was changed; click Update board to write them.' : 'The board already has ' + c.fw.name + '. Nothing was changed.';
        if (res.info.record === FL.sboot.RECORD.INCOMPLETE) run.doneText += ' The last update on the board was left unfinished, so it waits in its bootloader: Update board finishes it.';
      } else if (res.upToDate) {
        run.doneTitle = 'Already up to date'; run.doneText = 'The board already had ' + c.fw.name + ': nothing was written, and it’s running.';
      } else {
        run.doneTitle = 'Done';
        run.doneText = c.fw.name + ' is on the board and running: ' + n + ' of ' + total + ' blocks written and checked (' + I.fmtBytes(res.written) + ') in ' + (run.ms / 1000).toFixed(1) + ' s.';
      }
      log(run.doneTitle + '.', 'ok');
      upd();
      resumeConsole();
    }).catch(function (e) { stopBridge(e, c); });
  }

  function stopBridge(e, c) {
    var run = S.run, b = c.board, host = b.hostName || FL.serial.portNames(b.runs, 'the host board');
    if (!run) return;
    run.busy = false; run.waitPick = false;
    var msg = (e && e.message) || String(e), code = e && e.code;
    if (code === 'layout') { run.errorTitle = 'This file doesn’t fit the board'; run.error = msg + ' Nothing on the board was changed.'; log(run.errorTitle + ': ' + msg, 'err'); upd(); resumeConsole(); return; }
    if (code === 'silent' && b.system && !b.bridge) msg += ' Was that the passthrough? Pick the port that appeared after the knock.';
    run.errorTitle = run.compareOnly ? 'The compare stopped' : 'The update stopped';
    if (code === 'nohost') run.error = msg + ' Plug it in, close any program using its serial port, and try again.';
    else if (code === 'nobridge') {
      run.errorTitle = 'No passthrough';
      run.error = msg + ' It refuses while its output is on: turn that off and try again. If it’s running firmware without the passthrough, flash that first.';
    } else if (code === 'busy') run.error = msg;
    else if (code === 'wrong') { run.errorTitle = 'Wrong board'; run.error = msg; }
    else run.error = msg + (run.begun ? ' The board waits in its bootloader until an update finishes, so click Update board again.' : ' Nothing on the board was changed.');
    log(run.errorTitle + ': ' + msg, 'err');
    upd();
    resumeConsole();
  }

  // ── Passthrough systems (docs/releases-and-passthrough.md; FTEs and ?demo only) ──
  // A host board that stays running its own firmware with the passthrough, the link's rates, and a remote board
  // whose .hex or .elf is split once its bootloader's INFO says what its flash is (FL.image.layoutFromInfo). No
  // manifest entry. Kept in this browser only (Chris, 2026-11-17): the list in localStorage, each remote's file
  // in IndexedDB. A system's firmware is a reference, so a project firmware or a Signoff FW release can stand in
  // for the file later.
  var SYS_KEY = (DEMO ? 'flasher.demo.' : 'flasher.v1.') + 'systems', SYS_DB = DEMO ? 'flasher-demo-systems' : 'flasher-systems';
  var LINK = { touchBaud: 2400, linkBaud: 1000000, fastBaud: 4000000, exitBaud: 1200 };
  function systemsOn() { return DEMO || !!(S.catalog && S.catalog.fte); }
  // Each system names the account it was made with (the engine's tokenTag), so another account signed in here never
  // sees it; Sign out forgets them all, their files too (forgetSystems).
  function sysTag() { return DEMO ? 'demo' : tagOf(C.auth.token()); }
  function allSystems() {
    try { var l = JSON.parse(localStorage.getItem(SYS_KEY) || '[]'); return Array.isArray(l) ? l.filter(function (x) { return x && x.v === 1 && /^[a-z0-9]{4,24}$/.test(x.id || ''); }) : []; }
    catch (e) { return []; }
  }
  function readSystems() { var t = sysTag(); return t ? allSystems().filter(function (x) { return x.tag === t; }) : []; }
  function forgetSystems() {
    try { localStorage.removeItem(SYS_KEY); } catch (e) { /* storage blocked */ }
    try { indexedDB.deleteDatabase(SYS_DB); } catch (e) { /* blocked */ }
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* storage blocked */ }
    if (S.view === 'system') S.view = 'home';
    S.sys = null;
  }
  function storeSystem(sys) {
    sys.at = Date.now(); sys.tag = sysTag();
    var list = allSystems().filter(function (x) { return x.id !== sys.id; });
    list.unshift(sys);
    try { localStorage.setItem(SYS_KEY, JSON.stringify(list.slice(0, 12))); } catch (e) { /* storage blocked: this visit only */ }
  }
  function newSystem() {
    return { v: 1, id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: 'Passthrough system', at: Date.now(),
      host: { name: '', usb: [] }, link: Object.assign({}, LINK), remote: { name: '', file: null, seen: null }, learned: null };
  }
  /* The remote's file bytes, in IndexedDB beside the list (a build can be megabytes). Resolves null when blocked. */
  function idbFile(op, id, val) {
    return new Promise(function (resolve) {
      var req;
      try { req = indexedDB.open(SYS_DB, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = function () { req.result.createObjectStore('files'); };
      req.onerror = function () { resolve(null); };
      req.onsuccess = function () {
        try {
          var db = req.result, tx = db.transaction('files', op === 'get' ? 'readonly' : 'readwrite'), st = tx.objectStore('files');
          var r = op === 'get' ? st.get(id) : op === 'put' ? st.put(val, id) : st.delete(id);
          r.onsuccess = function () { resolve(op === 'get' ? r.result || null : true); };
          r.onerror = function () { resolve(null); };
          tx.oncomplete = function () { db.close(); };
        } catch (e) { resolve(null); }
      };
    });
  }
  function relDay(t) { var d = Math.round((Date.now() - t) / 86400000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago'; }
  function openSystem(id, project) {
    if (S.run && S.run.busy) return toast('Wait for the update to finish.');
    var sys = id ? readSystems().filter(function (x) { return x.id === id; })[0] : null, fresh = !sys;
    if (!sys) { sys = newSystem(); if (project) sys.project = project; storeSystem(sys); }
    S.sys = { sys: sys, file: null, block: fresh ? 'remote' : '', units: null, loading: !!(sys.remote && sys.remote.file) };
    if (S.tab === 'console') S.tab = 'serial';
    select('system');
    if (S.sys.loading) idbFile('get', sys.id).then(function (rec) {
      if (!S.sys || S.sys.sys.id !== sys.id) return;
      S.sys.loading = false;
      if (S.sys.file) return render();   // a release or file put on it meanwhile wins
      if (rec && rec.bytes) return parseSystemFile(rec.name, new Uint8Array(rec.bytes)).then(function (f) { if (S.sys && S.sys.sys.id === sys.id) { S.sys.file = f; render(); } }, function () { render(); });
      render();
    });
  }
  // ── Working projects (docs/working-projects.md) ──
  // Flasher's own projects: the manifests' projects (flasher_data and the shared review-flasher-* repos), each with
  // its images and saved systems, plus projects made here and not saved yet (kept in this browser, Save or
  // Discard). FTEs edit and save; every write goes through FL.access (one commit on the head it read). The demo
  // keeps its edits in this tab.
  var DRAFT_KEY = (DEMO ? 'flasher.demo.' : 'flasher.v1.') + 'draftProjects';
  var PID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  function canEdit() { return DEMO || !!(S.catalog && S.catalog.fte); }
  function readDrafts() {
    var t = sysTag();
    try { var l = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]'); return Array.isArray(l) ? l.filter(function (x) { return x && x.tag === t && PID.test(x.id || ''); }) : []; }
    catch (e) { return []; }
  }
  function writeDrafts(list) {
    var t = sysTag();
    try {
      var all = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]');
      all = (Array.isArray(all) ? all : []).filter(function (x) { return x && x.tag !== t; }).concat(list.map(function (x) { return Object.assign({}, x, { tag: t }); }));
      localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
    } catch (e) { /* storage blocked: this visit only */ }
  }
  function ctxNow() { return { token: C.auth.token(), login: S.catalog && S.catalog.login }; }
  function savedSystem(id) { return ((S.catalog && S.catalog.systems) || []).filter(function (x) { return x.id === id; })[0] || null; }

  /* Every Working project, sorted by name: { key, pid, name, repo, draft, firmware, systems (saved), local (this
     browser's unsaved systems) }. Keys: 'p:<id>' saved, 'd:<id>' not saved, 'u:' unsorted (systems made outside
     any project, not saved). */
  function workingProjects() {
    var c = S.catalog, out = {}, list = [];
    function get(key, name, extra) {
      if (!out[key]) { out[key] = Object.assign({ key: key, name: name, firmware: [], systems: [], local: [] }, extra || {}); list.push(out[key]); }
      return out[key];
    }
    if (c) {
      Object.keys(c.projects || {}).forEach(function (pid) { get('p:' + pid, c.projects[pid].name, { pid: pid, repo: c.projects[pid].repo }); });
      c.firmware.forEach(function (f) { get('p:' + f.project, f.project, { pid: f.project, repo: f.repo }).firmware.push(f); });
      (c.systems || []).forEach(function (x) { get(x.project ? 'p:' + x.project : 'n:' + x.repo, x.project || 'No project', { pid: x.project, repo: x.repo }).systems.push(x); });
    }
    readDrafts().forEach(function (d) { get('d:' + d.id, d.name, { pid: d.id, draft: true }); });
    if (systemsOn()) readSystems().forEach(function (sys) {
      if (sys.saved && savedSystem(sys.id)) return;   // listed with the saved ones, marked if edited here
      var p = sys.project && (out['p:' + sys.project] || out['d:' + sys.project]);
      (p || get('u:', 'Unsorted', { unsorted: true, draft: true })).local.push(sys);
    });
    return list.sort(function (a, b) { return (a.unsorted ? 1 : 0) - (b.unsorted ? 1 : 0) || a.name.localeCompare(b.name); });
  }
  function projectByKey(key) { return workingProjects().filter(function (p) { return p.key === key; })[0] || null; }
  function projectCount(p) { return p.firmware.length + p.systems.length + p.local.length; }
  var SYS_ICON = '<span class="fl-proj-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="6" width="6" height="8" rx="1.3"/><rect x="12.5" y="6" width="6" height="8" rx="1.3"/><path d="M7.5 10h5"/><path d="M10 8.2v3.6"/></svg></span>';
  var CHEV = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function sysRow(id, name, sub, on, act, mark) {
    return '<button class="proj fl-sys-row' + (on ? ' active' : '') + '" data-act="' + act + '" data-sys="' + esc(id) + '">' + SYS_ICON +
      '<span class="proj-body"><span class="proj-name">' + esc(name) + (mark ? ' <span class="fl-unsaved">' + esc(mark) + '</span>' : '') + '</span><span class="proj-sub">' + esc(sub) + '</span></span></button>';
  }
  function workingRows(q) {
    var bs = boards(), closed = closedGroups(), curSys = S.view === 'system' && S.sys ? S.sys.sys.id : '';
    var h = '<div class="fl-sec"><span class="side-label">Working projects</span>' + (canEdit() ? '<button class="fl-sec-add" data-act="proj-new" title="A new project, kept in this browser until you save it">+ New project</button>' : '') + '</div>';
    var list = workingProjects(), shown = 0;
    list.forEach(function (p) {
      var match = function (t) { return !q || (p.name + ' ' + t).toLowerCase().indexOf(q) >= 0; };
      var fws = p.firmware.filter(function (f) { return match(f.name + ' ' + (bs[f.board] ? bs[f.board].name : '')); });
      var syss = p.systems.filter(function (x) { return match(x.name); }), locs = p.local.filter(function (x) { return match(x.name); });
      if (q && !fws.length && !syss.length && !locs.length && !match('')) return;
      shown++;
      var holds = (S.view === 'project' && S.projKey === p.key) || fws.some(function (f) { return S.view === 'fw' && S.fwId === f.id + '@' + f.board; }) ||
        syss.concat(locs).some(function (x) { return x.id === curSys; });
      var open = !closed[p.key] || !!q || holds, many = {};
      fws.forEach(function (f) { many[f.board] = 1; });
      fws.sort(function (x, y) { return ((bs[x.board] || {}).name + x.name).localeCompare((bs[y.board] || {}).name + y.name); });
      h += '<div class="side-group"><div class="fl-group-row' + (S.view === 'project' && S.projKey === p.key ? ' on' : '') + '">' +
        '<button class="side-group-head" data-act="toggle-group" data-group="' + esc(p.key) + '" aria-expanded="' + open + '" aria-label="Fold ' + esc(p.name) + '">' + CHEV +
        '<span class="side-group-name">' + esc(p.name) + '</span>' + (p.draft ? '<span class="fl-unsaved">Not saved</span>' : '') + '<span class="side-group-count">' + projectCount(p) + '</span></button>' +
        '<button class="fl-group-open" data-act="proj-open" data-proj="' + esc(p.key) + '" title="Open the project">›</button></div>' +
        (open ? fws.map(function (f) {
          var key = f.id + '@' + f.board, on = S.view === 'fw' && S.fwId === key, b = bs[f.board];
          var sub = [Object.keys(many).length > 1 && b ? b.name : '', I.fmtBytes(f.size), f.built ? fmtDate(f.built) : f.published ? fmtDate(f.published) : ''].filter(Boolean).join(' · ');
          return '<button class="proj' + (on ? ' active' : '') + '" data-act="open-fw" data-fw="' + esc(key) + '" title="' + esc(f.summary || f.name) + '">' + FW_ICON +
            '<span class="proj-body"><span class="proj-name">' + esc(f.name) + '</span><span class="proj-sub">' + esc(sub) + '</span></span></button>';
        }).join('') + syss.map(function (x) {
          var local = readSystems().filter(function (s) { return s.id === x.id; })[0];
          return sysRow(x.id, (local && local.name) || x.name, 'Passthrough system' + (x.remote.release ? ' · ' + x.remote.release.version : x.remote.file ? ' · ' + x.remote.file.name : ''),
            curSys === x.id, 'sys-open-saved', local && local.dirty ? 'Edited' : '');
        }).join('') + locs.map(function (x) {
          return sysRow(x.id, x.name, 'Passthrough system · ' + (x.remote && x.remote.file ? x.remote.file.name : 'no file yet'), curSys === x.id, 'sys-open', 'Not saved');
        }).join('') : '') + '</div>';
    });
    if (!shown) h += '<div class="side-empty">' + (q ? 'No matching firmware.' : S.loading ? 'Loading firmware…' : 'No projects yet.') + '</div>';
    return h;
  }

  // ── The project page ──
  function projectHtml() {
    var p = projectByKey(S.projKey);
    if (!p) return homeHtml();
    var ed = canEdit(), repo = p.repo || FL.access.dataFull(), bs = boards();
    var where = p.unsorted ? 'Passthrough systems made outside a project. Save one to put it in a project.' : p.draft ? 'Kept in this browser until you save it' + (DEMO ? '' : ' to ' + repo) + '.' : 'Saved in ' + (DEMO ? 'the demo' : repo) + '.';
    var h = '<div class="page"><div class="page-head"><div class="page-head-text"><div class="eyebrow">Working project' + (p.draft && !p.unsorted ? ' · not saved' : '') + '</div>' +
      (ed && !p.unsorted ? '<input class="page-title fl-sys-title" data-change="proj-name" value="' + esc(p.name) + '" aria-label="Project name">' : '<h1 class="page-title">' + esc(p.name) + '</h1>') +
      '<div class="page-sub">' + esc(where) + '</div></div>' +
      (ed && !p.unsorted ? '<div class="fl-row fl-head-acts">' + (p.draft ? '<button class="btn" data-act="proj-discard">Discard</button><button class="btn btn-primary" data-act="proj-save">Save project</button>'
        : '<button class="btn btn-plain" data-act="proj-delete">Delete project</button>') + '</div>' : '') + '</div>';
    // Images
    h += '<div class="card fl-pad fl-proj-card"><h3 class="fl-sys-edit-title">Images</h3>' + (p.firmware.length ? '<div class="fl-proj-list">' + p.firmware.map(function (f) {
      return '<button class="fl-proj-item" data-act="open-fw" data-fw="' + esc(f.id + '@' + f.board) + '"><b>' + esc(f.name) + '</b><span>' + esc([bs[f.board] ? bs[f.board].name : f.board, I.fmtBytes(f.size), f.kind === 'file' ? f.format.toUpperCase() + ' uploaded here' : ''].filter(Boolean).join(' · ')) + '</span></button>';
    }).join('') + '</div>' : '<p class="note">No images yet.</p>') +
      (ed && !p.unsorted ? (p.draft ? '<p class="note">Save the project first, then upload images and define boards for it.</p>'
        : '<div class="fl-row"><button class="btn" data-act="proj-upload">Upload an image…</button><button class="btn btn-plain" data-act="proj-board">Define a board…</button></div>') : '') + '</div>';
    // Systems
    var sysList = p.systems.map(function (x) { return { id: x.id, name: x.name, act: 'sys-open-saved', sub: 'Saved' }; })
      .concat(p.local.map(function (x) { return { id: x.id, name: x.name, act: 'sys-open', sub: 'Not saved' }; }));
    h += '<div class="card fl-pad fl-proj-card"><h3 class="fl-sys-edit-title">Passthrough systems</h3>' + (sysList.length ? '<div class="fl-proj-list">' + sysList.map(function (x) {
      return '<button class="fl-proj-item" data-act="' + x.act + '" data-sys="' + esc(x.id) + '"><b>' + esc(x.name) + '</b><span>' + esc(x.sub) + '</span></button>';
    }).join('') + '</div>' : '<p class="note">No systems yet.</p>') +
      (systemsOn() ? '<div class="fl-row"><button class="btn" data-act="proj-sys-new">New passthrough system</button></div>' : '') + '</div>';
    // Boards of a saved project
    if (!p.draft) {
      var mine = Object.keys(bs).filter(function (id) { return bs[id].project === p.pid; });
      if (mine.length) h += '<div class="card fl-pad fl-proj-card"><h3 class="fl-sys-edit-title">Boards</h3><div class="fl-proj-list">' + mine.map(function (id) {
        var b = bs[id];
        return '<div class="fl-proj-item static"><b>' + esc(b.name) + '</b><span>' + esc([b.mcu, b.kind === 'bridge' ? 'through a passthrough' : b.flash ? I.fmtBytes(b.flash.size) + ' flash' : ''].filter(Boolean).join(' · ')) + '</span></div>';
      }).join('') + '</div>' +
        // Jig (../jig/docs/design.md, *Flasher*): a new sketch for one of these boards, edited and built online.
        jigNewRow(mine.filter(function (id) { return ed && S.jig && (S.jig.boards || []).indexOf(id) >= 0; })) + '</div>';
    }
    return h + '</div>';
  }

  // ── Writes (FL.access in real use; the demo changes its catalog in this tab) ──
  function demoNote() { toast('Saved in this tab: the demo keeps everything in the browser.'); }
  function busyWrite(what, fn) {
    if (S.writing) { toast('Wait for the save in progress.'); return Promise.resolve(false); }
    S.writing = what; render();
    return Promise.resolve().then(fn).then(function () { S.writing = ''; if (DEMO) { demoNote(); render(); return true; } return load().then(function () { toast(what + ': saved'); return true; }); },
      function (e) { S.writing = ''; render(); toast(what + ': ' + (e.code === 'moved' ? 'someone else saved at the same time three times running; try again.' : e.message || e)); return false; });
  }
  function demoCatalog() { return S.catalog; }
  function writeProject(pid, name, repo) {
    if (DEMO) { demoCatalog().projects[pid] = { name: name, repo: 'the demo' }; return Promise.resolve(); }
    return FL.access.saveProject(ctxNow(), repo, pid, name);
  }
  function writeSystem(sys, repo, file) {
    if (DEMO) {
      var c = demoCatalog(), rec = { id: sys.id, name: sys.name, project: sys.project, host: JSON.parse(JSON.stringify(sys.host)), link: JSON.parse(JSON.stringify(sys.link)),
        remote: { name: sys.remote.name, file: sys.remote.file ? { name: sys.remote.file.name, sha256: sys.remote.file.sha256, size: sys.remote.file.size, paths: [] } : null, release: sys.remote.release || null }, repo: 'the demo' };
      c.systems = (c.systems || []).filter(function (x) { return x.id !== sys.id; }).concat([rec]);
      return Promise.resolve();
    }
    return FL.access.saveSystem(ctxNow(), repo, { id: sys.id, name: sys.name, project: sys.project, host: sys.host, link: sys.link,
      remote: { name: sys.remote.name, release: sys.remote.release || null }, by: S.catalog && S.catalog.login, keepFile: !file && !sys.remote.release }, file);
  }

  function newProject() {
    if (!canEdit()) return;
    var name = prompt('Name the new project. It stays in this browser until you save it.', '');
    if (name === null || !name.trim()) return;
    var d = { id: FL.access.newId('p'), name: name.trim().slice(0, 80), at: Date.now() };
    writeDrafts(readDrafts().concat([d]));
    S.projKey = 'd:' + d.id; select('project');
    return d;
  }
  function renameProject(name) {
    var p = projectByKey(S.projKey); name = String(name || '').trim().slice(0, 80);
    if (!p || !name || name === p.name || p.unsorted) return render();
    if (p.draft) { writeDrafts(readDrafts().map(function (d) { return d.id === p.pid ? Object.assign(d, { name: name }) : d; })); render(); return; }
    busyWrite('Renaming the project', function () { return writeProject(p.pid, name, p.repo); });
  }
  /* Save a project made here: its name, then each of its systems (with their files). */
  function saveDraftProject(p) {
    var repo = FL.access.dataFull();
    return busyWrite('Saving ' + p.name, function () {
      return writeProject(p.pid, p.name, repo).then(function () {
        return p.local.reduce(function (chain, sys) { return chain.then(function () { return saveOneSystem(sys, repo); }); }, Promise.resolve());
      }).then(function () { writeDrafts(readDrafts().filter(function (d) { return d.id !== p.pid; })); S.projKey = 'p:' + p.pid; });
    });
  }
  function discardProject(p) {
    var n = p.local.length;
    if (!confirm('Discard “' + p.name + '”' + (n ? ' and its ' + n + ' unsaved system' + (n === 1 ? '' : 's') : '') + '? Nothing in GitHub changes.')) return;
    writeDrafts(readDrafts().filter(function (d) { return d.id !== p.pid; }));
    dropLocalSystems(p.local.map(function (x) { return x.id; }));
    select('home'); toast('Discarded');
  }
  function deleteProject(p) {
    var what = [p.firmware.length && p.firmware.length + ' image' + (p.firmware.length === 1 ? '' : 's'), p.systems.length && p.systems.length + ' system' + (p.systems.length === 1 ? '' : 's')].filter(Boolean).join(' and ');
    var shared = !DEMO && S.catalog && S.catalog.roster && SM.sharedRepo(S.catalog.roster, p.pid);
    if (shared) return toast('“' + p.name + '” is shared in ' + shared + '. Take everyone off it in People & access first.');
    if (!confirm('Delete “' + p.name + '”' + (what ? ', with its ' + what : '') + ', from ' + (DEMO ? 'the demo' : p.repo) + '? Its files stay in the repository’s history.')) return;
    busyWrite('Deleting ' + p.name, function () {
      if (DEMO) {
        var c = demoCatalog();
        c.firmware = c.firmware.filter(function (f) { return f.project !== p.pid; });
        c.systems = (c.systems || []).filter(function (x) { return x.project !== p.pid; });
        Object.keys(c.boards).forEach(function (bid) { if (c.boards[bid].project === p.pid && !c.firmware.some(function (f) { return f.board === bid; })) delete c.boards[bid]; });
        delete c.projects[p.pid];
        return;
      }
      return FL.access.removeEntries(ctxNow(), p.repo, { project: p.pid, label: p.name });
    }).then(function (ok) { if (ok) { dropLocalSystems(p.systems.map(function (x) { return x.id; })); select('home'); } });
  }
  function dropLocalSystems(ids) {
    if (!ids.length) return;
    try { localStorage.setItem(SYS_KEY, JSON.stringify(allSystems().filter(function (x) { return ids.indexOf(x.id) < 0; }))); } catch (e) { /* storage blocked */ }
    ids.forEach(function (id) { idbFile('delete', id); });
    if (S.sys && ids.indexOf(S.sys.sys.id) >= 0) S.sys = null;
  }

  // ── Systems: Save (asking which project when it has none), Discard changes, Delete ──
  function saveOneSystem(sys, repo) {
    var withFile = sys.remote.file && !sys.remote.release && !(sys.saved && sys.saved.fileSha === sys.remote.file.sha256);
    var fileP = withFile ? idbFile('get', sys.id).then(function (rec) {
      if (!rec || !rec.bytes) throw new Error('This browser no longer has ' + sys.remote.file.name + '. Open the file again, then save.');
      return { name: rec.name, bytes: new Uint8Array(rec.bytes) };
    }) : Promise.resolve(null);
    return fileP.then(function (file) { return writeSystem(sys, repo, file); }).then(function () {
      sys.saved = { repo: repo, fileSha: sys.remote.file ? sys.remote.file.sha256 : '', at: Date.now() }; sys.dirty = false;
      storeSystem(sys);
    });
  }
  function saveSystemNow() {
    if (!S.sys || !canEdit()) return;
    var sys = S.sys.sys;
    if (sys.saved) return busyWrite('Saving ' + sys.name, function () { return saveOneSystem(sys, sys.saved.repo); });
    var p = sys.project && (projectByKey('p:' + sys.project) || projectByKey('d:' + sys.project));
    if (p && !p.unsorted) return saveInto(p);
    pickProjectSheet('Save “' + sys.name + '” in a project', function (key) { var q = projectByKey(key); if (q) { sys.project = q.pid; storeSystem(sys); saveInto(q); } });
    function saveInto(q) {
      if (q.draft) return saveDraftProject(Object.assign({}, q, { local: q.local.filter(function (x) { return x.id === sys.id; }).length ? q.local : q.local.concat([sys]) }));
      return busyWrite('Saving ' + sys.name, function () { return saveOneSystem(sys, q.repo); });
    }
  }
  function discardSystemChanges() {
    if (!S.sys || !S.sys.sys.saved) return;
    if (!confirm('Discard your changes to “' + S.sys.sys.name + '”? It goes back to the saved one.')) return;
    var id = S.sys.sys.id; dropLocalSystems([id]); openSavedSystem(id);
  }
  function deleteSavedSystem() {
    var sys = S.sys && S.sys.sys; if (!sys || !sys.saved) return;
    if (!confirm('Delete “' + sys.name + '” from ' + (DEMO ? 'the demo' : sys.saved.repo) + '? Its file stays in the repository’s history; nothing on any board changes.')) return;
    busyWrite('Deleting ' + sys.name, function () {
      if (DEMO) { demoCatalog().systems = (demoCatalog().systems || []).filter(function (x) { return x.id !== sys.id; }); return; }
      return FL.access.removeEntries(ctxNow(), sys.saved.repo, { system: sys.id, label: sys.name });
    }).then(function (ok) { if (ok) { dropLocalSystems([sys.id]); select('home'); } });
  }
  /* Open a saved system: this browser's copy when it has one (maybe edited), else a copy of the saved one with
     its file (or its Signoff FW release) read again. */
  function openSavedSystem(id) {
    if (readSystems().some(function (x) { return x.id === id; })) return openSystem(id);
    var x = savedSystem(id); if (!x) return;
    var sys = newSystem();
    Object.assign(sys, { id: x.id, name: x.name, project: x.project, host: { name: x.host.name, usb: x.host.usb.slice() }, link: Object.assign({}, x.link), learned: null,
      remote: { name: x.remote.name, file: x.remote.file ? { name: x.remote.file.name, sha256: x.remote.file.sha256, size: x.remote.file.size } : null, seen: null },
      saved: { repo: x.repo, fileSha: x.remote.file ? x.remote.file.sha256 : '', at: Date.now() }, dirty: false });
    if (x.remote.release) sys.remote.release = Object.assign({}, x.remote.release);
    storeSystem(sys);
    var got = x.remote.file && S.catalog.fetchSystemFile ? S.catalog.fetchSystemFile(x).then(function (bytes) { return idbFile('put', id, { name: x.remote.file.name, bytes: bytes }); })
      : x.remote.release ? (function () {
        var r = relOf(x.remote.release.review + '/' + x.remote.release.release);
        return r ? fetchRel(r).then(function (f) {
          sys.remote.file = { name: f.name, sha256: f.sha256, size: f.bytes.length }; storeSystem(sys);
          return idbFile('put', id, { name: f.name, bytes: f.bytes });
        }) : Promise.resolve();
      })() : Promise.resolve();
    got.then(function () { openSystem(id); }, function (e) { toast('Couldn’t read its file: ' + (e.message || e)); openSystem(id); });
  }
  function pickProjectSheet(title, done) {
    var list = workingProjects().filter(function (p) { return !p.unsorted; });
    sheet('<div class="sheet-head"><h2>' + esc(title) + '</h2><p>Pick the project it belongs to.</p></div><div class="sheet-body"><div class="pick-grid" id="pp-list">' +
      list.map(function (p, i) { return '<button type="button" class="pick' + (i === 0 ? ' on' : '') + '" data-act="ppick" data-ppick="' + esc(p.key) + '"><b>' + esc(p.name) + '</b><span>' + (p.draft ? 'Not saved: saved with it' : DEMO ? 'the demo' : esc(p.repo)) + '</span></button>'; }).join('') +
      '<button type="button" class="pick' + (list.length ? '' : ' on') + '" data-act="ppick" data-ppick="new"><b>New project…</b><span>Named next</span></button></div></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-act="sheet-close">Cancel</button><button class="btn btn-primary" data-act="pp-ok">Save</button></div>');
    pickDone = function () {
      var on = document.querySelector('#pp-list .pick.on'); closeSheet();
      if (!on) return;
      if (on.dataset.ppick === 'new') { var d = newProject(); if (d) done('d:' + d.id); return; }
      done(on.dataset.ppick);
    };
  }
  var pickDone = null;

  // ── Uploading an image and defining a board (a saved project) ──
  function uploadSheet(file) {
    var p = projectByKey(S.projKey); if (!p || p.draft) return;
    var bs = boards(), ids = Object.keys(bs).filter(function (id) { return (bs[id].repo || 'the demo') === (p.repo || 'the demo') || DEMO; });
    var fmt = FL.access.fileFormat(file.name);
    if (!fmt) return toast('An image is a .bin, .hex, or .elf.');
    sheet('<div class="sheet-head"><h2>Upload ' + esc(file.name) + '</h2><p>Into “' + esc(p.name) + '”, as it is (' + esc(I.fmtBytes(file.size)) + '). Flasher checks it against its board each time it flashes it.</p></div><div class="sheet-body">' +
      '<div class="field"><label for="up-name">Name</label><input class="input" id="up-name" value="' + esc(file.name.replace(/\.[^.]+$/, '')) + '" maxlength="80"></div>' +
      '<div class="field"><label for="up-board">Board</label><select class="input" id="up-board">' + ids.map(function (id) { return '<option value="' + esc(id) + '"' + (bs[id].project === p.pid ? ' selected' : '') + '>' + esc(bs[id].name) + (bs[id].kind === 'bridge' ? ' (through its passthrough: .hex or .elf)' : '') + '</option>'; }).join('') + '</select>' +
      (ids.length ? '' : '<div class="hint-text">Define a board first.</div>') + '</div>' +
      '<div class="row2"><div class="field"><label for="up-repo">Built from (repo)</label><input class="input" id="up-repo" placeholder="Optional: owner/name" maxlength="100"></div><div class="field"><label for="up-sha">Commit</label><input class="input" id="up-sha" placeholder="Optional" maxlength="40"></div></div>' +
      '<div class="field"><label for="up-sum">Summary</label><input class="input" id="up-sum" placeholder="Optional: what this build is" maxlength="400"></div></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-act="sheet-close">Cancel</button><button class="btn btn-primary" data-act="up-ok"' + (ids.length ? '' : ' disabled') + '>Upload</button></div>', true);
    upFile = file;
  }
  var upFile = null;
  function uploadNow() {
    var p = projectByKey(S.projKey), file = upFile; if (!p || !file) return;
    var val = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };
    var img = { name: file.name, title: val('up-name') || file.name, board: val('up-board'), project: p.pid, summary: val('up-sum'), by: S.catalog && S.catalog.login,
      source: { repo: val('up-repo'), sha: /^[0-9a-f]{7,40}$/i.test(val('up-sha')) ? val('up-sha').toLowerCase() : '' } };
    var b = boards()[img.board];
    if (!b) return toast('Pick the board.');
    if (b.kind === 'bridge' && /\.bin$/i.test(file.name)) return toast('A board behind a passthrough needs a .hex or .elf: a .bin has no addresses.');
    closeSheet();
    file.arrayBuffer().then(function (buf) {
      img.bytes = new Uint8Array(buf);
      busyWrite('Uploading ' + img.title, function () {
        if (DEMO) {
          return I.sha256(img.bytes).then(function (h) {
            var c = demoCatalog(), id = FL.access.newId('i'), fmt = FL.access.fileFormat(file.name), f = { id: id, board: img.board, kind: 'file', format: fmt, name: img.title, summary: img.summary, description: '',
              size: img.bytes.length, sha256: h, path: 'firmware/' + img.board + '/' + id + '.' + fmt, paths: [], project: p.pid, repo: 'the demo', source: { repo: img.source.repo, sha: img.source.sha, path: '', dirty: false }, edited: {} };
            demoFiles[id] = img.bytes; c.firmware.push(f);
          });
        }
        return FL.access.uploadImage(ctxNow(), p.repo, img);
      });
    });
  }
  var demoFiles = {};
  function boardSheet() {
    var p = projectByKey(S.projKey); if (!p || p.draft) return;
    sheet('<div class="sheet-head"><h2>Define a board</h2><p>For “' + esc(p.name) + '”. A board reached through another board’s passthrough needs no entry: make a passthrough system instead.</p></div><div class="sheet-body">' +
      '<div class="row2"><div class="field"><label for="bd-name">Name</label><input class="input" id="bd-name" maxlength="80" placeholder="Main board"></div><div class="field"><label for="bd-mcu">MCU</label><input class="input" id="bd-mcu" maxlength="60" placeholder="STM32G431"></div></div>' +
      '<div class="row2"><div class="field"><label for="bd-fbase">Flash base</label><input class="input fl-mono" id="bd-fbase" value="0x08000000"></div><div class="field"><label for="bd-fsize">Flash size</label><input class="input fl-mono" id="bd-fsize" placeholder="0x20000"></div></div>' +
      '<div class="row2"><div class="field"><label for="bd-rbase">RAM base</label><input class="input fl-mono" id="bd-rbase" value="0x20000000"></div><div class="field"><label for="bd-rsize">RAM size</label><input class="input fl-mono" id="bd-rsize" placeholder="0x8000"></div></div>' +
      '<div class="row2"><div class="field"><label for="bd-run">Its firmware’s USB id <span class="fl-muted">(optional)</span></label><input class="input fl-mono" id="bd-run" placeholder="0483:5740"><div class="hint-text">Takes the 1200-baud restart. Without it the board goes into update mode by hand.</div></div>' +
      '<div class="field"><label for="bd-runname">Its USB product name</label><input class="input" id="bd-runname" maxlength="80" placeholder="Optional"></div></div>' +
      '<div class="field"><label for="bd-dfu">ROM bootloader’s USB id</label><input class="input fl-mono" id="bd-dfu" value="0483:DF11"></div>' +
      '<div class="field"><label for="bd-steps">Update mode by hand (one step a line)</label><textarea class="input" id="bd-steps" rows="3" placeholder="Hold BOOT0.&#10;Press and release reset.&#10;Release BOOT0."></textarea></div>' +
      '<div class="field"><label for="bd-notes">Notes</label><input class="input" id="bd-notes" maxlength="400" placeholder="Optional"></div></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-act="sheet-close">Cancel</button><button class="btn btn-primary" data-act="bd-ok">Save board</button></div>', true);
  }
  function boardNow() {
    var p = projectByKey(S.projKey); if (!p) return;
    var val = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };
    var ids = function (t) { var u = parseUsb(t).ids[0]; return u ? { vid: '0x' + hex4(u.vid), pid: '0x' + hex4(u.pid) } : null; };
    var name = val('bd-name'); if (!name) return toast('Name the board.');
    var bid = SM.slugify(name).slice(0, 40) || 'board', n = 2;
    while (boards()[bid]) bid = SM.slugify(name).slice(0, 36) + '-' + n++;
    var b = { name: name, mcu: val('bd-mcu'), project: p.pid, flash: { base: val('bd-fbase'), size: val('bd-fsize') }, ram: { base: val('bd-rbase'), size: val('bd-rsize') },
      dfu: Object.assign(ids(val('bd-dfu')) || {}, { name: 'DFU in FS Mode' }), notes: val('bd-notes'),
      manualDfu: val('bd-steps').split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 8) };
    var run = ids(val('bd-run'));
    if (run) { b.run = Object.assign(run, { name: val('bd-runname') }); b.touchBaud = 1200; }
    var problems = [];
    if (!I.cleanBoard(bid, b, problems)) return toast(problems.join(' '));
    closeSheet();
    busyWrite('Saving board ' + name, function () {
      if (DEMO) { var c = demoCatalog(), cb = I.cleanBoard(bid, b, []); cb.repo = 'the demo'; cb.project = p.pid; c.boards[bid] = cb; return; }
      return FL.access.saveBoard(ctxNow(), p.repo, bid, b);
    });
  }

  // ── An image's Name and Project (the About card), FTEs ──
  function fwEditFor(f) { var k = f.id + '@' + f.board; if (!S.fwEdit || S.fwEdit.key !== k) S.fwEdit = { key: k, name: f.name, project: f.project }; return S.fwEdit; }
  function fwEditHtml(f) {
    if (!canEdit() || f.local) return '';
    var e = fwEditFor(f), changed = e.name !== f.name || e.project !== f.project, list = workingProjects().filter(function (p) { return !p.unsorted; });
    return '<div class="fl-fw-edit"><input class="input" data-change="fw-name" value="' + esc(e.name) + '" aria-label="Image name" maxlength="80" title="Name">' +
      '<select class="input" data-change="fw-project" aria-label="Project" title="Project">' + list.map(function (p) {
        var other = !DEMO && !p.draft && p.repo && p.repo !== f.repo;
        return '<option value="' + esc(p.pid) + '"' + (p.pid === e.project ? ' selected' : '') + '>' + esc(p.name) + (p.draft ? ' (not saved)' : other ? ' (moves its board)' : '') + '</option>';
      }).join('') + '<option value="__new">New project…</option></select>' +
      (changed ? '<button class="btn" data-act="fw-discard">Discard</button><button class="btn btn-primary" data-act="fw-save"' + (S.writing ? ' disabled' : '') + '>Save</button>' : '') + '</div>';
  }
  function fwSave() {
    var c = current(); if (!c || c.fw.local) return;
    var f = c.fw, e = fwEditFor(f), list = workingProjects();
    var target = list.filter(function (p) { return !p.unsorted && p.pid === e.project; })[0];
    var name = e.name.trim() || f.name, nameChanged = name !== f.name, projChanged = e.project !== f.project;
    if (!nameChanged && !projChanged) return;
    if (projChanged && !target) return toast('Pick the project.');
    var others = S.catalog.firmware.filter(function (x) { return x.board === f.board && x !== f; });
    var cross = !DEMO && projChanged && !target.draft && target.repo !== f.repo;
    if (cross && !confirm('“' + target.name + '” is in ' + target.repo + '. Moving there takes the board “' + (boards()[f.board] || {}).name + '”' + (others.length ? ' and its ' + others.length + ' other image' + (others.length === 1 ? '' : 's') : '') + ' too. Move them?')) return;
    busyWrite('Saving ' + name, function () {
      if (DEMO) {
        if (target && target.draft) { demoCatalog().projects[target.pid] = { name: target.name, repo: 'the demo' }; writeDrafts(readDrafts().filter(function (d) { return d.id !== target.pid; })); }
        f.name = name; if (projChanged) f.project = e.project; f.edited = { name: f.edited && f.edited.name || nameChanged, project: f.edited && f.edited.project || projChanged };
        return;
      }
      var ctx = ctxNow(), chain = Promise.resolve();
      if (projChanged && target.draft) chain = chain.then(function () { return FL.access.saveProject(ctx, f.repo, target.pid, target.name); }).then(function () { writeDrafts(readDrafts().filter(function (d) { return d.id !== target.pid; })); });
      if (cross) {
        chain = chain.then(function () { return FL.access.moveBoard(ctx, f.repo, target.repo, f.board, target.pid); });
        if (nameChanged) chain = chain.then(function () { return FL.access.editFirmware(ctx, target.repo, f.id, f.board, { name: name }); });
        return chain;
      }
      return chain.then(function () { return FL.access.editFirmware(ctx, f.repo, f.id, f.board, { name: nameChanged ? name : null, project: projChanged ? e.project : null }); });
    }).then(function (ok) { if (ok) S.fwEdit = null; render(); });
  }

  function systemChanged() { if (S.sys) { if (S.sys.sys.saved) S.sys.sys.dirty = true; storeSystem(S.sys.sys); render(); } }
  function deleteSystem() {
    if (!S.sys || (S.run && S.run.busy)) return;
    if (!confirm('Discard “' + S.sys.sys.name + '”? It was never saved, so it goes from this browser with its file; nothing on any board changes.')) return;
    var id = S.sys.sys.id;
    try { localStorage.setItem(SYS_KEY, JSON.stringify(allSystems().filter(function (x) { return x.id !== id; }))); } catch (e) { /* storage blocked */ }
    idbFile('delete', id); S.sys = null; select('home'); toast('Removed');
  }
  function parseUsb(text) {
    var out = [], bad = [];
    String(text || '').split(/[\s,;]+/).filter(Boolean).forEach(function (t) {
      var m = /^(?:0x)?([0-9a-f]{1,4}):(?:0x)?([0-9a-f]{1,4})$/i.exec(t);
      if (m) out.push({ vid: parseInt(m[1], 16), pid: parseInt(m[2], 16) }); else bad.push(t);
    });
    return { ids: out.slice(0, 8), bad: bad };
  }
  function systemField(k, v) {
    var sys = S.sys && S.sys.sys; if (!sys) return;
    if (k === 'name') sys.name = String(v).trim().slice(0, 80) || 'Passthrough system';
    else if (k === 'host-name') sys.host.name = String(v).trim().slice(0, 80);
    else if (k === 'host-usb') { var u = parseUsb(v); sys.host.usb = u.ids; if (u.bad.length) toast('Not a USB id: ' + u.bad.join(', ') + '. Use vid:pid in hex, like 0483:5740.'); }
    else if (k === 'remote-name') sys.remote.name = String(v).trim().slice(0, 80);
    else if (/^(touch|link|fast|exit)Baud$/.test(k)) {
      var n = parseInt(v, 10);
      if (n >= 300 && n <= 12000000) sys.link[k] = n; else toast('A rate from 300 to 12000000 baud.');
      if (sys.link.touchBaud === sys.link.exitBaud || sys.link.linkBaud === sys.link.exitBaud || sys.link.fastBaud === sys.link.exitBaud) toast('The exit rate must differ from the others, or the host would leave the passthrough.');
    }
    S.run = null; systemChanged();
  }
  /* A .hex or .elf for the remote: it needs addresses, since the image can span internal and external flash. */
  function parseSystemFile(name, bytes) {
    if (/\.bin$/i.test(name)) return Promise.reject(new Error('A .bin has no addresses. Use the .hex or .elf the build makes.'));
    var img;
    try { img = FL.files.parse(name, bytes); } catch (e) { return Promise.reject(e); }
    if (img.needsBase || !img.segments || !img.segments.length) return Promise.reject(new Error('That file has no addresses. Use the .hex or .elf the build makes.'));
    return I.sha256(bytes).then(function (h) { return { name: name, bytes: bytes, segments: img.segments, sha256: h, size: img.segments.reduce(function (n, sg) { return n + sg.data.length; }, 0) }; });
  }
  function setSystemFile(f) {
    if (!f || !S.sys) return;
    if (S.run && S.run.busy) return toast('Wait for the update to finish.');
    if (f.size > 64 * 1048576) return toast('That file is over 64 MB; it isn’t firmware for these boards.');
    f.arrayBuffer().then(function (buf) { setSystemBytes(f.name, new Uint8Array(buf), null); });
  }
  /* The remote's firmware: a file's bytes, or a Signoff FW release's (release: { repo, review, release, version,
     sha256, board }, kept on the system as its reference; a file picked later replaces it). */
  function setSystemBytes(name, bytes, release) {
    var sys = S.sys && S.sys.sys;
    if (!sys) return Promise.resolve();
    return parseSystemFile(name, bytes).then(function (file) {
      if (!S.sys || S.sys.sys !== sys) return;
      if (release && file.sha256 !== release.sha256) throw new Error('The release’s bytes don’t match its SHA-256.');
      S.sys.file = file; S.sys.units = null; S.run = null;
      sys.remote.file = { name: file.name, sha256: file.sha256, size: file.bytes.length };
      if (release) sys.remote.release = release; else delete sys.remote.release;
      if (!sys.remote.name) sys.remote.name = release ? release.target : file.name.replace(/\.[^.]+$/, '');
      idbFile('put', sys.id, { name: file.name, bytes: file.bytes }).then(function (ok) { if (!ok) toast('This browser won’t keep the file; open it again next visit.'); });
      systemChanged();
    }).catch(function (e) { toast(name + ': ' + (e.message || e)); });
  }
  /* Put a Signoff FW release on a system's remote (sysId '' for a new system): read it, check it, keep the reference. */
  function releaseToSystem(key, sysId) {
    var x = relOf(key);
    if (!x || x.rel.via !== 'passthrough') return;
    if (S.run && S.run.busy) return toast('Wait for the update to finish.');
    toast('Getting ' + relLabel(x) + '…');
    fetchRel(x).then(function (f) {
      openSystem(sysId || null);
      if (!S.sys) return;
      S.sys.block = 'remote';
      return setSystemBytes(f.name, f.bytes, { repo: x.target.repo, review: x.target.id, release: x.rel.id, version: x.rel.version, target: x.target.name, sha256: x.rel.sha256, board: x.rel.board })
        .then(function () { toast('The remote now has ' + relLabel(x)); });
    }, function (e) { toast('Couldn’t get ' + relLabel(x) + ': ' + (e.message || e)); });
  }
  /* The release a system's remote names, from the list this token reads now (null if it's gone or hidden). */
  function sysRelease(sys) {
    var r = sys && sys.remote && sys.remote.release;
    return r ? relOf(r.review + '/' + r.release) : null;
  }
  // The passthrough releases a remote can take: Released ones (and drafts for FTEs), newest first.
  function remoteReleaseOptions() {
    var out = [];
    ((S.fwr && S.fwr.targets) || []).forEach(function (t) {
      t.releases.slice().reverse().forEach(function (r) {
        if (r.via === 'passthrough' && relShown(r) && r.state !== 'withdrawn') out.push({ key: t.id + '/' + r.id, label: t.name + ' ' + r.version + (r.state === 'draft' ? ' (draft)' : '') + (r.board ? ' · ' + r.board : '') });
      });
    });
    return out;
  }
  /* ?demo: the display's firmware lives in a ready-made passthrough system (Chris, 2026-11-17), not the list: the Main
     PCBA as the host, the Display & Sensor Board as the remote, and its 1.4.0 build. Made once per browser; removing
     it keeps it removed (flasher.demo.systemSeeded). */
  var DEMO_SYS_ID = 'sdemodisplay';
  function seedDemoSystem(c) {
    try { if (localStorage.getItem('flasher.demo.systemSeeded')) return; localStorage.setItem('flasher.demo.systemSeeded', '1'); } catch (e) { return; }
    if (!c.demoDisplayHex || readSystems().some(function (x) { return x.id === DEMO_SYS_ID; })) return;
    var bytes = new TextEncoder().encode(c.demoDisplayHex()), name = 'display-1.4.0.hex';
    I.sha256(bytes).then(function (h) {
      var sys = newSystem();
      sys.id = DEMO_SYS_ID; sys.name = 'Thermostat display'; sys.project = 'thermostat';
      sys.host = { name: 'Smart Thermostat Main PCBA', usb: [{ vid: 0x0483, pid: 0x5740 }] };
      sys.remote = { name: 'Display & Sensor Board', file: { name: name, sha256: h, size: bytes.length }, seen: null };
      return idbFile('put', sys.id, { name: name, bytes: bytes }).then(function () { storeSystem(sys); renderSide(); });
    });
  }
  /* ?demo: the made-up display's current release as a .hex, as the build would write it. */
  function demoSystemFile() {
    var text = S.catalog && S.catalog.demoDisplayHex ? S.catalog.demoDisplayHex() : '';
    if (!text) return;
    setSystemFile(new File([text], 'display-1.4.0.hex', { type: 'text/plain' }));
  }
  /* The passthrough answered INFO: remember its USB id with the system, so later visits find it without a pick,
     and what the board said about itself. */
  function learnPassthrough(port, info, hostInfo) {
    var sys = S.sys && S.sys.sys, pi = port.getInfo ? port.getInfo() : null; if (!sys) return;
    if (FL.sboot.learnable(pi, hostInfo, sys.host.usb)) sys.learned = { vid: pi.usbVendorId, pid: pi.usbProductId };
    else { sys.learned = null; log('Its passthrough port has the host’s own USB id, so Flasher won’t remember it: it’s picked each time.'); }
    var chip = FL.sectors && FL.sectors.chip(info.device);
    sys.remote.seen = { board: info.board || '', chip: chip ? chip.name : I.hex(info.device, 3), version: (info.version >> 8) + '.' + (info.version & 0xFF), at: Date.now() };
    storeSystem(sys);
  }
  function systemBoard(sys) {
    var host = sys.host || {}, ln = sys.link || LINK;
    return {
      id: 'system-' + sys.id, kind: 'bridge', system: true, name: sys.remote.name || 'The remote board', hostName: host.name || '',
      runs: (host.usb || []).map(function (u) { return { vid: u.vid, pid: u.pid, name: host.name || '' }; }),
      touchBaud: ln.touchBaud, linkBaud: ln.linkBaud, fastBaud: ln.fastBaud, exitBaud: ln.exitBaud,
      bridge: sys.learned ? { vid: sys.learned.vid, pid: sys.learned.pid, name: '' } : null,
      expect: {}, units: null, manualDfu: [], flash: null, ram: null, dfu: null
    };
  }
  function systemFw() {
    var f = S.sys.file, rr = S.sys.sys.remote.release, fw = { id: 'system', local: true, kind: 'units', split: true, wantBoard: rr && rr.board || '', name: f ? f.name : 'No file yet', size: f ? f.size : 0, sha256: f ? f.sha256 : '', segments: f ? f.segments : null, units: S.sys.units || [], parts: [] };
    if (!f) fw.error = S.sys.loading ? 'Reading the file kept in this browser…' : 'Open the remote’s .hex or .elf first.';
    return fw;
  }
  function hexId(u) { return hex4(u.vid) + ':' + hex4(u.pid); }

  /* The system's diagram: this computer, the host, the link, and the remote, the three blocks clickable to set
     them up, each showing its state during an update; the block map under it (FL.route.blocks). */
  function sysDiagram(c, run) {
    var m = bridgeModel(c, run), sys = S.sys.sys, sel = S.sys.block, f = S.sys.file, IC = FL.route.icons, ln = sys.link;
    var pcNode = m.nodes[0], hostNode = m.nodes[1], remNode = m.nodes[2];
    function stat(n) { return '<span class="fl-sys-status' + (n.live ? ' live' : '') + (n.good ? ' good' : '') + '">' + esc(n.status) + '</span>'; }
    function block(key, node, icon, kicker, name, sub) {
      return '<button type="button" class="fl-sys-block' + (sel === key ? ' sel' : '') + (node.on ? ' on' : '') + '" data-act="sys-block" data-block="' + key + '" aria-expanded="' + (sel === key) + '">' +
        '<span class="fl-sys-kick">' + IC[icon] + esc(kicker) + '</span><span class="fl-sys-name">' + esc(name) + '</span><span class="fl-sys-sub">' + esc(sub) + '</span>' + stat(node) + '</button>';
    }
    var hostSub = (sys.host.usb || []).length ? 'USB ' + sys.host.usb.map(hexId).join(', ') : 'Any port you pick',
      remSub = f ? (sys.remote.release ? sys.remote.release.version + ' from Signoff FW · ' : '') + f.name + ' · ' + I.fmtBytes(f.size) : S.sys.loading ? 'Reading its file…' : 'No .hex or .elf yet';
    if (sys.remote.seen && sys.remote.seen.chip) remSub += ' · ' + sys.remote.seen.chip;
    var h = '<div class="fl-sys">' + (m.note ? '<div class="fl-route-note">' + esc(m.note) + '</div>' : '') + '<div class="fl-sys-chain">' +
      '<div class="fl-sys-pc' + (pcNode.on ? ' on' : '') + '"><span class="fl-sys-kick">' + IC.pc + 'This computer</span>' + stat(pcNode) + '</div>' +
      '<span class="fl-sys-wire' + (m.links[0] ? ' on' : '') + '"><span class="fl-sys-wire-label">USB</span></span>' +
      block('host', hostNode, 'host', 'Host · the bridge', sys.host.name || 'The host board', hostSub) +
      '<span class="fl-sys-wire' + (m.links[1] ? ' on' : '') + '"><button type="button" class="fl-sys-link' + (sel === 'link' ? ' sel' : '') + '" data-act="sys-block" data-block="link" aria-expanded="' + (sel === 'link') + '">' +
        'Link · ' + (ln.linkBaud / 1e6) + (ln.fastBaud ? '–' + (ln.fastBaud / 1e6) : '') + ' Mbaud</button></span>' +
      block('remote', remNode, 'target', 'Remote', sys.remote.name || 'The remote board', remSub) +
      '</div>' + FL.route.blocks(m) + '</div>';
    return h;
  }
  // The remote's firmware from Signoff FW: a pick of the passthrough releases this token reads.
  function remoteReleaseField(sys, dis) {
    var opts = remoteReleaseOptions(), cur = sys.remote.release ? sys.remote.release.review + '/' + sys.remote.release.release : '';
    if (!opts.length && !cur) return '';
    if (cur && !opts.some(function (o) { return o.key === cur; })) opts.unshift({ key: cur, label: sys.remote.release.target + ' ' + sys.remote.release.version + ' (not listed now)' });
    return '<div class="field"><label for="sys-rel">Or a release from Signoff FW</label><select class="input" id="sys-rel" data-change="fwrel-remote"' + dis + '>' +
      '<option value=""' + (cur ? '' : ' selected') + '>' + (cur ? 'Keep it, or pick another…' : 'Pick a release…') + '</option>' +
      opts.map(function (o) { return '<option value="' + esc(o.key) + '"' + (o.key === cur ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select>' +
      '<div class="hint-text">The system keeps the release it’s given; it never switches by itself.</div></div>';
  }
  // Under the remote: the release it holds, and a newer Released one of the same target if there is one.
  function remoteReleaseNote(sys) {
    var r = sys.remote.release;
    if (!r) return '';
    var x = sysRelease(sys), newer = x && FL.fwr.newerThan(x.target, x.rel);
    var h = '<p class="note">From Signoff FW: ' + esc(r.target + ' ' + r.version) + (x ? ', ' + esc(FL.fwr.LABEL[x.rel.state].toLowerCase()) : S.fwr && S.fwr.state === 'ok' ? ' (no longer listed for you)' : '') +
      (r.board ? '. Its board answers “' + esc(r.board) + '”; Flasher stops if another board does' : '') + '.</p>';
    if (x && x.rel.state === 'withdrawn') h += '<div class="hint fl-warn"><b>▲ Withdrawn</b>' + esc(x.rel.withdrawnWhy || 'This release was withdrawn.') + '</div>';
    if (newer) h += '<div class="hint fl-rel-newer"><b>' + esc(newer.version) + ' is out</b>A newer release of ' + esc(x.target.name) + ' was released' + (newer.releasedAt ? ' on ' + esc(newer.releasedAt) : '') + '.' +
      '<div class="fl-row"><button class="btn btn-primary" data-act="rel-to-sys" data-rel="' + esc(x.target.id + '/' + newer.id) + '" data-sys="' + esc(sys.id) + '">Switch to ' + esc(newer.version) + '</button></div></div>';
    return h;
  }
  function sysEditor() {
    var sys = S.sys.sys, sel = S.sys.block, busy = S.run && S.run.busy, dis = busy ? ' disabled' : '';
    if (sel === 'host') return '<div class="card fl-pad fl-sys-edit"><h3 class="fl-sys-edit-title">Host · the bridge</h3>' +
      '<p class="note">The host keeps running its own firmware, which has the passthrough. Flasher knocks at ' + sys.link.touchBaud + ' baud on the port you pick, and it reopens its USB as a pipe onto the remote’s bootloader.</p>' +
      '<div class="fl-sys-fields"><div class="field"><label for="sys-host-name">Name</label><input class="input" id="sys-host-name" data-change="sys-host-name" value="' + esc(sys.host.name) + '" placeholder="The host board"' + dis + '></div>' +
      '<div class="field"><label for="sys-host-usb">USB ids <span class="fl-muted">(optional)</span></label><input class="input fl-mono" id="sys-host-usb" data-change="sys-host-usb" value="' + esc((sys.host.usb || []).map(hexId).join(', ')) + '" placeholder="0483:5740"' + dis + '>' +
      '<div class="hint-text">Only narrow Chrome’s list to the host’s ports. Leave empty to pick from every port.</div></div></div></div>';
    if (sel === 'link') return '<div class="card fl-pad fl-sys-edit"><h3 class="fl-sys-edit-title">Link</h3>' +
      '<p class="note">The serial bootloader protocol’s rates. Change them only if the host’s firmware uses others.</p><div class="fl-sys-fields">' +
      [['touchBaud', 'Knock (opens the passthrough)'], ['linkBaud', 'Link'], ['fastBaud', 'Fast (after SET_BAUD)'], ['exitBaud', 'Exit (back to its own firmware)']].map(function (r) {
        return '<div class="field"><label for="sys-' + r[0] + '">' + r[1] + '</label><input class="input fl-mono" type="number" min="300" max="12000000" id="sys-' + r[0] + '" data-change="sys-' + r[0] + '" value="' + sys.link[r[0]] + '"' + dis + '></div>';
      }).join('') + '</div><div class="fl-row"><button class="btn btn-plain" data-act="sys-link-reset"' + dis + '>Use the protocol’s rates</button>' +
      (sys.learned ? '<button class="btn btn-plain" data-act="sys-forget-port"' + dis + '>Forget the passthrough port (USB ' + esc(hexId(sys.learned)) + ')</button>' : '') + '</div></div>';
    if (sel === 'remote') {
      var f = S.sys.file, seen = sys.remote.seen;
      return '<div class="card fl-pad fl-sys-edit"><h3 class="fl-sys-edit-title">Remote</h3>' +
        '<p class="note">A <b>.hex</b> or <b>.elf</b>: the image can span internal and external flash, so it needs its addresses. When the board answers, its bootloader says what its flash is, and Flasher splits the file into its blocks then.</p>' +
        '<div class="fl-sys-fields"><div class="field"><label for="sys-remote-name">Name</label><input class="input" id="sys-remote-name" data-change="sys-remote-name" value="' + esc(sys.remote.name) + '" placeholder="The remote board"' + dis + '></div>' +
        '<div class="field"><label>Firmware</label><div class="fl-row fl-sys-file">' + (f ? '<span class="chip fl-mono" title="SHA-256 ' + esc(f.sha256) + '">' + esc(f.name) + ' · ' + esc(I.fmtBytes(f.size)) + '</span>' : '') +
        '<button class="btn" data-act="sys-file"' + dis + '>' + (f ? 'Another file…' : 'Open a .hex or .elf…') + '</button>' +
        (DEMO ? '<button class="btn btn-plain" data-act="sys-demo-file"' + dis + '>Use the demo display’s build</button>' : '') + '</div>' +
        '<div class="hint-text">Or drop it anywhere on the page.</div></div>' + remoteReleaseField(sys, dis) + '</div>' + remoteReleaseNote(sys) +
        (seen ? '<p class="note">Last answered: ' + esc([seen.board ? '“' + seen.board + '”' : '', seen.chip, 'bootloader ' + seen.version].filter(Boolean).join(', ')) + ', ' + esc(relDay(seen.at)) + '.</p>' : '') + '</div>';
    }
    return '';
  }
  function systemHtml(c) {
    var sys = S.sys.sys, run = S.run && S.run.key === runKey() ? S.run : null, busy = run && run.busy;
    var sp = sys.project && (projectByKey('p:' + sys.project) || projectByKey('d:' + sys.project)), ed = canEdit() && !busy && !S.writing;
    var kept = sys.saved ? 'saved in ' + (sp ? sp.name : 'its project') + (sys.dirty ? ' · edited here, not saved' : '') : 'not saved' + (sp ? ' · in ' + sp.name : '');
    var acts = sys.saved ? (sys.dirty ? '<button class="btn" data-act="sys-discard"' + (ed ? '' : ' disabled') + '>Discard changes</button><button class="btn btn-primary" data-act="sys-save"' + (ed ? '' : ' disabled') + '>Save</button>' : '') +
        '<button class="btn btn-plain" data-act="sys-delete-saved"' + (ed ? '' : ' disabled') + '>Delete</button>'
      : (canEdit() ? '<button class="btn btn-primary" data-act="sys-save"' + (ed ? '' : ' disabled') + '>Save…</button>' : '') + '<button class="btn btn-plain" data-act="sys-delete"' + (busy ? ' disabled' : '') + '>Discard</button>';
    var h = '<div class="page"><div class="page-head"><div class="page-head-text"><div class="eyebrow">Passthrough system · ' + esc(kept) + '</div>' +
      '<input class="page-title fl-sys-title" data-change="sys-name" value="' + esc(sys.name) + '" aria-label="System name"' + (busy ? ' disabled' : '') + '>' +
      '<div class="page-sub">' + esc((sys.host.name || 'The host board') + ' passes its USB through to ' + (sys.remote.name || 'the remote board') + '. Click a block to set it up.') + '</div></div>' +
      '<div class="fl-row fl-head-acts">' + acts + '</div></div>';
    h += browserNote();
    h += '<div class="card fl-pad fl-sys-card"><div id="fl-route-box">' + sysDiagram(c, run) + '</div></div>';
    h += sysEditor();
    h += '<div class="card fl-panel' + (detailsHidden() ? ' terse' : '') + '"><div class="fl-tabs" role="tablist"><button role="tab" class="on" aria-selected="true">' + esc(BRIDGE_TAB) + '</button>' + detailsBtn() + '</div>' +
      '<div class="fl-tab-body">' + bridgeHtml(c, run) + '</div></div>';
    return h + '</div>';
  }

  // ── Console: a terminal on the board's serial port (assets/term.js draws it) ──
  var con = null, term = new FL.term.Screen(), drawQueued = false;
  function drawTerm() {
    drawQueued = false;
    var box = $('#term'), out = $('#term-out');
    if (!box || !out) return;
    var atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 6;
    out.innerHTML = term.html(document.activeElement === $('#term-in') && !!(S.con && S.con.open));
    if (atEnd) box.scrollTop = box.scrollHeight;
  }
  function queueDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(drawTerm); } }
  function termAdd(t) { term.write(t); queueDraw(); }
  function focusTerm() { var inp = $('#term-in'); if (inp) { inp.focus({ preventScroll: true }); queueDraw(); } }

  // opts.board: list only that board's ports (after a flash). opts.resume: reopen the port a flash paused,
  // by its USB id, without asking (the board comes back as a new port).
  function openConsole(opts) {
    opts = opts || {};
    if (S.con && (S.con.open || S.con.connecting)) return;
    var b = opts.board || boards()[S.conFilter] || null, ids = b && b.runs && b.runs.length ? b.runs : null;
    if (opts.baud) S.conBaud = opts.baud;
    S.con = { open: false, connecting: true, error: '', name: opts.resume ? opts.resume.name : '' }; render();
    var done = function () { S.con.connecting = false; S.con.open = true; S.con.error = ''; S.con.paused = false; render(); if (S.tab === 'console') focusTerm(); };
    var closed = function (why) {
      var pausing = S.con && S.con.pausing;
      if (S.con && !pausing) { S.con.open = false; S.con.connecting = false; S.con.error = why || ''; }
      if (why !== null && !pausing) termAdd('\r\n[disconnected]\r\n');
      con = null; render();
    };
    if (DEMO) {
      var sh = FL.fakeusb.shell({
        name: 'tstat', banner: 'Acme Thermostat console' + (opts.resume ? ', after the flash' : '') + '. Type help; Tab completes.', onData: termAdd,
        commands: {
          status: function () { return 'OK heat off  cool off  T=21.4 °C  RH=38 %  24VAC ok'; },
          relay: function (a) { return /^(heat|cool)$/.test(a[0] || '') && /^(on|off)$/.test(a[1] || '') ? 'OK ' + a[0] + ' relay ' + a[1] : 'ERR usage: relay heat|cool on|off'; },
          info: function () { var c = current(); return 'OK ' + (c ? c.fw.name : 'Thermostat Firmware') + ', made up for the demo'; }
        }
      });
      S.con.name = 'Acme Thermostat (demo)';
      con = { demo: true, send: function (t) { sh.input(t); return Promise.resolve(); }, close: function () { sh.stop(); closed(''); return Promise.resolve(); } };
      setTimeout(function () { done(); sh.start(); }, opts.resume ? 700 : 250);
      return;
    }
    if (!navigator.serial) { S.con = { error: 'This browser has no Web Serial: use Chrome or Edge.' }; render(); return; }
    var want = opts.resume ? [opts.resume.info] : ids, waitUntil = opts.resume ? Date.now() + 8000 : opts.board ? Date.now() + 5000 : 0;
    function known() {
      return navigator.serial.getPorts().then(function (ports) {
        if (!want) return null;
        var m = ports.filter(function (x) { var i = x.getInfo(); return want.some(function (w) { return w && i.usbVendorId === (w.usbVendorId != null ? w.usbVendorId : w.vid) && i.usbProductId === (w.usbProductId != null ? w.usbProductId : w.pid); }); });
        return m.length === 1 || opts.resume ? m[0] || null : null;
      });
    }
    function find() {
      return known().then(function (p) {
        if (p) return p;
        if (Date.now() < waitUntil) return FL.serial.sleep(300).then(find);
        if (opts.resume) throw Object.assign(new Error('The board didn’t come back on its serial port after the flash. Choose it again.'), { name: 'Gone' });
        return navigator.serial.requestPort(ids ? { filters: FL.serial.filters(ids) } : {});
      });
    }
    find().then(function (port) {
      var info = port.getInfo ? port.getInfo() : {}, which = (ids || []).filter(function (r) { return FL.serial.matches(info, r); })[0];
      if (S.con) S.con.name = which && which.name ? which.name : opts.resume && opts.resume.name ? opts.resume.name :
        info.usbVendorId != null ? 'USB serial ' + hex4(info.usbVendorId) + ':' + hex4(info.usbProductId) : 'Serial port';
      con = new FL.serial.Console(termAdd, function () { closed(''); });
      return con.open(port, S.conBaud).then(function () { if (opts.resume) termAdd('\r\n[reopened after the flash]\r\n'); done(); });
    }).catch(function (e) {
      con = null;
      S.con = { open: false, connecting: false, error: e.name === 'NotFoundError' ? 'No port chosen' : e.name === 'SecurityError' ? 'Click Choose a port to pick it' : e.name === 'Gone' ? e.message
        : 'Couldn’t open the port: another program has it (the Arduino IDE’s Serial Monitor?)' };
      render();
    });
  }
  function closeConsole() { var k = con; con = null; if (S.con) S.con.paused = false; return k ? k.close() : Promise.resolve(); }
  // A flash needs the board's serial port: a console open on it lets go for the flash and reopens after.
  // A console on another device (a USB-UART cable, say) stays open.
  function pauseConsoleFor(b) {
    if (!con || !S.con || !S.con.open) return Promise.resolve(false);
    var info = !con.demo && con.port && con.port.getInfo ? con.port.getInfo() : {};
    var same = con.demo || b.id === I.GENERIC.id || FL.serial.matches(info, b.runs || []);
    if (!same) return Promise.resolve(false);
    var keep = { info: info, baud: S.conBaud, name: S.con.name };
    S.con.pausing = true;
    return closeConsole().then(function () {
      S.con = { paused: true, resume: keep, name: keep.name };
      termAdd('\r\n[paused: flashing from the Serial bootloader tab]\r\n'); render();
      return true;
    });
  }
  function resumeConsole() {
    if (!(S.con && S.con.paused && S.con.resume)) return;
    var r = S.con.resume; S.con = null;
    openConsole({ resume: r, baud: r.baud });
  }

  // ── People & access (FTEs; assets/access.js does the GitHub side) ──
  var SM = window.Signoff.model, A = FL.access;
  var ROLES = [['fte', 'FTE'], ['client', 'Client'], ['contractor', 'Contractor']];
  var P = { map: null, loading: false };   // map: { repoFull: { login: 'yes' | 'invited' } }
  function ctx() { return { token: C.auth.token(), login: S.catalog.login }; }
  function owner() { return FL.config.owner.toLowerCase(); }
  function isOwner() { return S.catalog && S.catalog.login === owner(); }
  function roster() { return S.catalog.roster; }
  function projects() { return (S.catalog && S.catalog.projects) || {}; }
  function sharedRepos() {
    var r = roster(), out = [];
    Object.keys(r.shared || {}).forEach(function (id) { var x = SM.sharedRepo(r, id); if (x && out.indexOf(x) < 0) out.push(x); });
    return out;
  }
  // The repos a person needs: an FTE, flasher_data and every shared repo; anyone else, their projects' repos.
  function needs(u) {
    if (u.role === 'fte') return [A.dataFull()].concat(sharedRepos());
    return (u.projects || []).map(function (pid) { return SM.sharedRepo(roster(), pid); }).filter(Boolean);
  }
  function loadAccess() {
    if (P.loading || !S.catalog || !S.catalog.fte) return;
    P.loading = true;
    A.accessMap(ctx(), [A.dataFull()].concat(sharedRepos())).then(function (m) { P.map = m; P.loading = false; if (S.view === 'people') render(); },
      function () { P.loading = false; });
  }
  function accessCell(u) {
    if (u.login === owner()) return '<span class="muted">Owner</span>';
    var unshared = u.role !== 'fte' ? (u.projects || []).filter(function (pid) { return !SM.sharedRepo(roster(), pid); }) : [];
    if (!P.map) return '<span class="muted">' + (P.loading ? 'Checking…' : '—') + '</span>';
    var missing = [], invited = [];
    needs(u).forEach(function (r) { var st = P.map[r] && P.map[r][u.login]; if (st === 'invited') invited.push(r); else if (st !== 'yes') missing.push(r); });
    var fix = ' <button class="btn btn-plain fl-small" data-act="fix-access" data-login="' + esc(u.login) + '">Fix</button>';
    if (missing.length || unshared.length) {
      return '<span class="fl-bad-text">Missing ' + esc(missing.map(function (r) { return r.split('/')[1]; }).concat(unshared.map(function (p) { return (projects()[p] || {}).name || p; })).join(', ')) + '</span>' + fix;
    }
    if (invited.length) return '<span class="muted">Invited; not accepted yet</span>';
    return needs(u).length ? '<span class="fl-good-text">Has access</span>' : '<span class="muted">Nothing yet</span>';
  }

  function peopleHtml() {
    if (!S.catalog || !S.catalog.fte) return '<div class="page"><div class="card empty"><h2>People &amp; access</h2><p>Only FTEs, who can open ' + esc(A.dataFull()) + ', manage who can flash what.</p></div></div>';
    if (!P.map && !P.loading) loadAccess();
    var people = SM.liveUsers(roster()), pj = projects();
    var h = '<div class="page"><div class="page-head"><div class="page-head-text"><div class="eyebrow">People &amp; access · ' + esc(FL.config.owner) + '</div>' +
      '<h1 class="page-title">Flasher</h1><div class="page-sub">FTEs can flash every project. Clients and contractors can flash only the projects shared with them, each in its own private repository.</div></div>' +
      '<div class="fl-row fl-head-acts"><button class="btn" data-act="refresh-access">Refresh</button><button class="btn btn-primary" data-act="add-person">Add person</button></div></div>';
    if (!isOwner()) h += '<div class="hint">Only <b>' + esc(FL.config.owner) + '</b> can create repositories and invite people while they’re in a personal account. You can edit this list; the owner applies the access with Fix.</div>';
    if (!people.length) {
      h += '<div class="card fl-pad"><b>No one is listed yet.</b> Add yourself and the other FTEs first, then clients and contractors. ' +
        '<button class="btn btn-plain" data-act="add-self">Add me (@' + esc(S.catalog.login) + ') as FTE</button></div>';
    } else {
      h += '<div class="card table-scroll"><table class="table people"><thead><tr><th>Person</th><th>Role</th><th>Projects</th><th>GitHub access</th><th></th></tr></thead><tbody>' +
        people.map(function (u) {
          var projs = u.role === 'fte' ? '<span class="muted">All projects</span>'
            : ((u.projects || []).map(function (id) { return '<span class="chip">' + esc((pj[id] || {}).name || id) + '</span>'; }).join(' ') || '<span class="muted">None yet</span>') +
              ' <button class="btn btn-plain fl-small" data-act="person-projects" data-login="' + esc(u.login) + '">Edit</button>';
          return '<tr><td><div>' + esc(u.name || u.login) + (u.login === S.catalog.login ? ' <span class="muted">(you)</span>' : '') + '</div><div class="muted">@' + esc(u.login) + '</div></td>' +
            '<td><div class="seg">' + ROLES.map(function (r) {
              return '<button class="' + (u.role === r[0] ? 'on' : '') + '" data-act="person-role" data-login="' + esc(u.login) + '" data-role="' + r[0] + '">' + r[1] + '</button>';
            }).join('') + '</div></td><td>' + projs + '</td><td>' + accessCell(u) + '</td>' +
            '<td>' + (u.login === S.catalog.login ? '' : '<button class="btn btn-plain fl-small" data-act="remove-person" data-login="' + esc(u.login) + '">Remove</button>') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    var ids = Object.keys(pj).sort(function (a, b) { return pj[a].name.localeCompare(pj[b].name); });
    if (ids.length) {
      h += '<h2 class="section-title">Projects</h2><div class="card table-scroll"><table class="table people"><thead><tr><th>Project</th><th>Repository</th><th>Clients and contractors</th></tr></thead><tbody>' +
        ids.map(function (id) {
          var repo = SM.sharedRepo(roster(), id) || pj[id].repo;
          var who = people.filter(function (u) { return SM.isOutside(u) && (u.projects || []).indexOf(id) >= 0; }).map(function (u) { return esc(u.name || u.login); }).join(', ');
          return '<tr><td>' + esc(pj[id].name) + '</td><td><a href="https://github.com/' + esc(repo) + '" target="_blank" rel="noopener">' + esc(repo) + '</a>' +
            (repo === A.dataFull() ? ' <span class="muted">(FTEs only)</span>' : '') + '</td><td>' + (who || '<span class="muted">None</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    h += '<p class="note fl-foot">Projects no one outside has been given live in <b>' + esc(A.dataFull()) + '</b>, which only FTEs can open. Giving a client or contractor a project moves its firmware into its own private <b>' + A.PREFIX + '…</b> repository and invites them to that one only; publishing then goes there. FTEs are invited to every one. ' +
      'On a personal account every collaborator can push to the repositories they’re on.</p></div>';
    return h;
  }

  // A sheet that shows progress, then a Close button.
  function busySheet(title) {
    sheet('<div class="sheet-head"><h2>' + esc(title) + '</h2></div><div class="sheet-body"><div class="log" id="busy-log"></div></div><div class="sheet-foot" id="busy-foot"><span class="fl-muted">Working…</span></div>');
    var logEl = $('#busy-log');
    return {
      log: function (t, cls) { var d = document.createElement('div'); if (cls) d.className = cls; d.textContent = t; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; },
      done: function (ok) { $('#busy-foot').innerHTML = '<span class="' + (ok ? 'fl-good-text' : 'fl-bad-text') + '">' + (ok ? 'Done' : 'Stopped') + '</span><span class="spacer"></span><button class="btn btn-primary" data-act="sheet-close">Close</button>'; }
    };
  }
  // Run a change: write the People list, then the GitHub side; reload; report failures.
  function apply(title, change) {
    var b = busySheet(title);
    return Promise.resolve().then(function () { return change(b.log); }).then(function (failed) {
      (failed || []).forEach(function (f) { b.log('Couldn’t change @' + f.login + ' on ' + f.repo + ': ' + f.message, 'err'); });
      b.log('Saved.', 'ok'); b.done(!(failed || []).length);
    }, function (e) { b.log(e.message || String(e), 'err'); b.done(false); })
      .then(function () { P.map = null; return load(); });
  }
  function setPerson(login, fields) {
    var r = roster(), prev = r.users[login] || { login: login, name: '', role: 'contractor', projects: [] };
    r.users[login] = SM.stamp(Object.assign({}, prev, fields, { login: login }), S.catalog.login);
  }
  function save(log, what) {
    log('Saving the People list…');
    return A.saveRoster(ctx(), roster(), 'Flasher: ' + what).then(function (merged) { S.catalog.roster = merged; });
  }
  // Grant what a person's role and projects call for: share unshared projects, then invite.
  function grant(login, log) {
    var u = roster().users[login], failed = [];
    if (!u || u.deleted || login === owner()) return Promise.resolve(failed);
    var todo = u.role === 'fte' ? [] : (u.projects || []).filter(function (pid) { return !SM.sharedRepo(roster(), pid); });
    return todo.reduce(function (chain, pid) {
      return chain.then(function () {
        log('Moving “' + ((projects()[pid] || {}).name || pid) + '” into its own repository…');
        return A.share(ctx(), roster(), pid, log).then(function (res) { S.catalog.roster = res.roster; failed = failed.concat(res.failed); });
      });
    }, Promise.resolve()).then(function () {
      return Promise.all(needs(roster().users[login]).map(function (r) { return A.invite(ctx(), r, [login], log); }));
    }).then(function (lists) { return failed.concat.apply(failed, lists); });
  }
  function take(login, repos, log) {
    return Promise.all(repos.map(function (r) { return A.revoke(ctx(), r, [login], log); })).then(function (lists) { return [].concat.apply([], lists); });
  }

  function personSheet(login) {
    var u = login ? roster().users[login] : null, pj = projects(), role = u ? u.role : 'contractor', picked = u ? (u.projects || []).slice() : [];
    var ids = Object.keys(pj).sort(function (a, b) { return pj[a].name.localeCompare(pj[b].name); });
    sheet('<div class="sheet-head"><h2>' + (u ? esc(u.name || u.login) : 'Add person') + '</h2><p>' + (u ? 'Choose the projects ' + (u.role === 'client' ? 'this client sees' : 'this contractor works on') + '. Each one is shared through its own private repository.' : 'They need a free GitHub account. Use their GitHub username.') + '</p></div>' +
      '<div class="sheet-body">' +
      (u ? '' : '<div class="row2"><div class="field"><label for="p-name">Name</label><input class="input" id="p-name" placeholder="First Last"></div>' +
        '<div class="field"><label for="p-login">GitHub username</label><input class="input" id="p-login" placeholder="username" autocomplete="off"></div></div>' +
        '<div class="field"><span class="field-label">Role</span><div class="seg full" id="p-role">' +
        '<button type="button" data-act="prole" data-prole="fte">FTE: every project</button><button type="button" data-act="prole" data-prole="client">Client: chosen projects</button><button type="button" class="on" data-act="prole" data-prole="contractor">Contractor: chosen projects</button></div></div>') +
      '<div class="field" id="p-projects-field"' + (role === 'fte' ? ' hidden' : '') + '><span class="field-label">Projects</span><div class="pick-grid" id="p-projects">' +
      (ids.length ? ids.map(function (id) {
        return '<button type="button" class="pick' + (picked.indexOf(id) >= 0 ? ' on' : '') + '" data-act="ppick" data-ppick="' + esc(id) + '"><b>' + esc(pj[id].name) + '</b><span>' + (SM.sharedRepo(roster(), id) ? 'Shared' : 'FTEs only so far') + '</span></button>';
      }).join('') : '<p class="note">No projects yet: publish firmware first.</p>') + '</div></div></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-act="sheet-close">Cancel</button><button class="btn btn-primary" data-act="person-save" data-login="' + esc(login || '') + '">' + (u ? 'Save' : 'Add') + '</button></div>');
  }

  function personSave(login) {
    var chosen = Array.prototype.map.call(document.querySelectorAll('#p-projects .pick.on'), function (x) { return x.dataset.ppick; });
    if (login) {
      var before = (roster().users[login].projects || []).slice();
      closeSheet();
      return apply('Projects for @' + login, function (log) {
        setPerson(login, { projects: chosen });
        return save(log, 'projects for @' + login).then(function () {
          var gone = before.filter(function (p) { return chosen.indexOf(p) < 0; }).map(function (p) { return SM.sharedRepo(roster(), p); }).filter(Boolean);
          return take(login, gone, log).then(function (f1) { return grant(login, log).then(function (f2) { return f1.concat(f2); }); });
        });
      });
    }
    var l = ($('#p-login').value || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(l)) { $('#p-login').focus(); return toast('Enter their GitHub username'); }
    var on = document.querySelector('#p-role .on'), role = on ? on.dataset.prole : 'contractor', name = ($('#p-name').value || '').trim() || l;
    closeSheet();
    return apply('Adding @' + l, function (log) {
      setPerson(l, { name: name, role: role, projects: role === 'fte' ? [] : chosen, deleted: false });
      return save(log, 'add @' + l).then(function () { return grant(l, log); });
    });
  }

  function setRole(login, role) {
    var u = roster().users[login]; if (!u || u.role === role) return;
    var was = needs(u);
    return apply('@' + login + ' is now ' + (role === 'fte' ? 'an FTE' : 'a ' + role), function (log) {
      setPerson(login, { role: role });
      return save(log, '@' + login + ' role').then(function () {
        var now = needs(roster().users[login]);
        return take(login, was.filter(function (r) { return now.indexOf(r) < 0; }), log).then(function (f1) { return grant(login, log).then(function (f2) { return f1.concat(f2); }); });
      });
    });
  }

  function removePerson(login) {
    var u = roster().users[login]; if (!u) return;
    sheet('<div class="sheet-head"><h2>Remove @' + esc(login) + '?</h2><p>They lose access to ' + esc(needs(u).join(', ') || 'nothing yet') + '. The firmware stays.</p></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-act="sheet-close">Cancel</button><button class="btn btn-danger" data-act="remove-confirm" data-login="' + esc(login) + '">Remove</button></div>');
  }
  function removeConfirm(login) {
    var repos = needs(roster().users[login]).concat([A.dataFull()]).filter(function (r, i, a) { return a.indexOf(r) === i; });
    closeSheet();
    return apply('Removing @' + login, function (log) {
      setPerson(login, { deleted: true });
      return save(log, 'remove @' + login).then(function () { return take(login, repos, log); });
    });
  }

  // ── Sheets ──
  function sheet(html, wide) {
    var root = $('#sheet-root');
    root.innerHTML = '<div class="sheet-wrap" data-act="sheet-bg"><div class="sheet' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div></div>';
    var f = root.querySelector('input, button'); if (f) f.focus();
  }
  function closeSheet() {
    var root = $('#sheet-root');
    // Settings previews a theme as it's picked; closing without saving puts the saved one back.
    if (root.dataset.theme0 !== undefined) { applyTheme(readTheme()); delete root.dataset.theme0; delete root.dataset.theme; }
    root.innerHTML = '';
  }

  // Sign in with GitHub (the engine's auth.js), where this site has a GitHub App; null where it hasn't.
  function ghAuth() {
    var A = !DEMO && window.SignoffAuth;
    if (!A) return null;
    var st = A.status();
    return st.available || st.signedIn ? st : null;
  }
  function ghSignIn(btn) {
    if (btn) btn.disabled = true;
    window.SignoffAuth.signIn(location.href).catch(function (e) { if (btn) btn.disabled = false; toast(e.message); });
  }
  // The GitHub tag of whoever is signed in: a sign-in's refresh replaces the token, not the person.
  function whoTag() { var t = C.auth.token(); return t && window.Signoff && window.Signoff.model ? window.Signoff.model.tokenTag(t) : t ? 'x' : ''; }

  function accountSheet() {
    if (DEMO) return sheet('<div class="sheet-head"><h2>Demo</h2><p>The demo needs no sign-in. Its firmware is made up and flashes a board simulated in this page.</p></div><div class="sheet-foot"><a class="btn" href="./">Leave the demo</a><button class="btn btn-primary" data-act="sheet-close">Done</button></div>');
    // Laid out like Signoff EE's Settings (Chris, 2026-11-10). The name field is kept but hidden:
    // Flasher puts no name on anything, and it never writes the suite's settings except the theme.
    var tok = C.auth.token(), remembered = false, user = '';
    try { remembered = !!localStorage.getItem('signoff.token'); } catch (e) { /* storage blocked */ }
    try { user = (JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}).user || ''; } catch (e) { /* unreadable */ }
    var theme0 = readTheme(), c = S.catalog, cfg = FL.config;
    var auth = ghAuth(), viaSignIn = !!(auth && auth.signedIn);
    function tokenFields() {
      return '<details class="guide"' + (tok || auth ? '' : ' open') + '><summary>New to GitHub? Set up in four steps</summary><ol>' +
      '<li>Create a free account at <a href="https://github.com/signup" target="_blank" rel="noopener">github.com/signup</a>.</li>' +
      '<li>Send your username to your Dovetail contact.</li>' +
      '<li><a href="https://github.com/settings/tokens/new?scopes=repo&amp;description=Dovetail%20Signoff" target="_blank" rel="noopener">Create a token</a> (the link fills in the settings; pick an expiry and click <i>Generate token</i>).</li>' +
      '<li>Paste the token below and click <b>Save &amp; sync</b>. Flasher shows any invitations waiting for you, with an Accept button.</li></ol></details>' +
      '<div class="field"><label for="tok">Access token</label><input class="input" id="tok" type="password" value="' + esc(tok) + '" placeholder="ghp_… or github_pat_…" autocomplete="off" spellcheck="false">' +
      '<p class="note">Kept in this browser and sent only to api.github.com. It’s the token every Signoff tool here shares, so signing in to Signoff EE signs you in here too. Collaborators use a classic token with the <b>repo</b> scope. The account owner can use a fine-grained token with <b>All repositories</b> and <b>Contents</b> and <b>Administration</b> set to read and write; sharing a project creates a new repository, which a token limited to selected repositories can’t reach.</p></div>' +
      '<label class="check"><input type="checkbox" id="tok-remember"' + (remembered || !tok ? ' checked' : '') + '> Remember the token after closing the browser (avoid on shared computers)</label>';
    }
    sheet('<form data-submit="sign-in"><div class="sheet-head"><h2>Settings</h2><p>Firmware comes from private GitHub repositories, so everyone flashes the same published images.</p></div>' +
      '<div class="sheet-body">' +
      '<div class="field" hidden><label for="s-user">Your name</label><input class="input" id="s-user" value="' + esc(user) + '" placeholder="First Last" readonly></div>' +
      '<div class="field"><span class="field-label">Appearance</span><div class="seg full" id="s-theme">' + [['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(function (t) {
        return '<button type="button" class="' + (theme0 === t[0] ? 'on' : '') + '" data-theme="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field-label" style="margin-top:20px;font-size:13px;color:var(--text);font-weight:600">Signoff Repository Access</div>' +
      (tok && c && c.login ? '<p class="note" style="margin:0 0 12px">Signed in ' + (viaSignIn ? 'with GitHub ' : '') + 'as <b>' + esc(c.login) + '</b> · ' +
        (c.fte ? 'FTE: you see all firmware' : 'Client or contractor: you see the projects shared with you') + '</p>' : '') +
      // The token is the second way in: a gray button beside Sign in that drops its panel down.
      (viaSignIn ? '' : auth ? '<div class="signin-row"><button type="button" class="btn btn-primary" data-act="gh-signin">Sign in with GitHub</button>' +
        '<button type="button" class="btn token-toggle" data-act="token-toggle" aria-expanded="' + !!tok + '" aria-controls="s-token-panel">Use a token instead</button></div>' +
        '<p class="note" style="margin:0 0 12px">Uses your GitHub login, with its two-factor step. No token to create or keep track of.</p>' +
        '<div class="token-panel" id="s-token-panel"' + (tok ? '' : ' hidden') + '>' + tokenFields() + '</div>' : tokenFields()) +
      '<details class="guide" style="margin-top:14px"><summary>Repositories</summary>' +
      '<div class="row2" style="margin-top:10px"><div class="field"><label>Account or organization</label><input class="input" value="' + esc(cfg.owner) + '" readonly></div>' +
      '<div class="field"><label>Branch</label><input class="input" value="' + esc(cfg.branch) + '" readonly></div></div>' +
      '<div class="row2"><div class="field"><label>Data repo (FTEs)</label><input class="input" value="' + esc(cfg.repo) + '" readonly></div>' +
      '<div class="field"><label>Shared projects start with</label><input class="input" value="review-flasher-" readonly></div></div>' +
      '<p class="note">Flasher’s repositories are fixed in assets/catalog.js.</p></details>' +
      '<div class="log" id="s-log" hidden></div>' +
      '</div><div class="sheet-foot"><button class="btn" type="button" data-act="test-conn">Test connection</button>' + (tok ? '<button class="btn" type="button" data-act="sign-out" title="' + (viaSignIn ? 'Sign out of GitHub in every Signoff tool in this browser' : 'Remove the GitHub token every Signoff tool in this browser shares') + '">Sign out</button>' : '') + '<span class="spacer"></span>' +
      '<button class="btn" type="button" data-act="settings-cancel">Cancel</button><button class="btn btn-primary" type="submit">Save &amp; sync</button></div></form>');
    var w = $('#sheet-root');
    w.dataset.theme0 = theme0;
    w.querySelector('#s-theme').addEventListener('click', function (e) {
      var b = e.target.closest('[data-theme]'); if (!b) return;
      w.querySelectorAll('#s-theme button').forEach(function (x) { x.classList.toggle('on', x === b); });
      w.dataset.theme = b.dataset.theme; applyTheme(b.dataset.theme);
    });
    var t = w.querySelector('#tok'); if (t) t.focus();
  }

  function settingsLog(text, cls) {
    var l = $('#s-log'); if (!l) return;
    l.hidden = false; l.innerHTML += '<div class="' + (cls || '') + '">' + esc(text) + '</div>'; l.scrollTop = 1e6;
  }
  function testConnection() {
    var field = $('#tok'), tok = field ? field.value.replace(/\s+/g, '') : C.auth.token();
    if (!tok) { settingsLog('Paste a token first.', 'err'); return; }
    settingsLog('Checking your token…');
    FL.access.load({ token: tok }).then(function (r) {
      if (!r.login) throw new Error((r.errors && r.errors[0]) || 'GitHub didn’t accept the token.');
      settingsLog('Signed in as ' + r.login, 'ok');
      settingsLog(r.fte ? 'Data repo ' + FL.config.owner + '/' + FL.config.repo + ': OK (FTE access)' : 'Data repo ' + FL.config.owner + '/' + FL.config.repo + ': no access (fine for clients and contractors)', r.fte ? 'ok' : '');
      var n = r.repos.length - (r.fte ? 1 : 0);
      settingsLog(n + ' shared project repo' + (n === 1 ? '' : 's') + ' reachable', 'ok');
      if (r.invites.length) settingsLog(r.invites.length + ' invitation' + (r.invites.length === 1 ? '' : 's') + ' waiting — accept after saving');
      (r.errors || []).forEach(function (e) { settingsLog(e, 'err'); });
    }).catch(function (e) { settingsLog(e.message, 'err'); });
  }

  function driverSheet() {
    sheet('<div class="sheet-head"><h2>Windows driver help</h2><p>Chrome and Edge reach a USB device on Windows only when it uses Windows’ WinUSB driver. A board in update mode (the chip’s DFU bootloader, listed as “DFU in FS Mode”, USB 0483:DF11) needs it once per computer. The board’s serial port needs nothing.</p></div>' +
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
  // Picking firmware never closes the console (it's its own tab now). On the probe tab the pick stays
  // there and becomes the probe's image; from the console it opens the Serial bootloader tab.
  function select(view, key) {
    if (S.run && S.run.busy) return toast('Wait for the flash to finish.');
    resumeConsole();   // a flash left waiting at a picker had paused it
    S.view = view; S.fwId = key || ''; S.run = null;
    if (S.tab === 'console' || view === 'people' || view === 'home') S.tab = 'serial';
    document.body.querySelector('.app').classList.remove('nav-open');
    prepareBytes(); render(); $('#main').scrollTop = 0;
    if (S.tab === 'probe') probeTakes();
  }

  // ── The Debug probe tab: assets/probe/, loaded the first time the tab opens ──
  var PROBE_FILES = ['stlink', 'jlink', 'target', 'stm32', 'svd', 'fakeprobe', 'app'];
  var probeLoading = null, probeWas = false;
  function loadProbe() {
    if (FL.probeApp) return Promise.resolve();
    if (probeLoading) return probeLoading;
    var v = FL.VERSION ? '?v=' + FL.VERSION : '';
    probeLoading = PROBE_FILES.reduce(function (p, f) {
      return p.then(function () {
        return new Promise(function (ok, fail) {
          var s = document.createElement('script'); s.src = 'assets/probe/' + f + '.js' + v;
          s.onload = ok; s.onerror = function () { fail(new Error('Couldn’t load the probe (' + f + '.js).')); };
          document.body.appendChild(s);
        });
      });
    }, Promise.resolve());
    return probeLoading;
  }
  function showProbe() {
    if (FL.probeApp) return FL.probeApp.show();
    var box = $('#probe-view');
    if (!box.innerHTML) box.innerHTML = '<div class="page"><p class="fl-muted">Loading the probe…</p></div>';
    loadProbe().then(function () {
      FL.probeApp.mount(box, { demo: DEMO ? (DEMO_PROBE === 'h5' ? 'h5' : 'g0') : null, image: currentImage, changed: renderTabs, toast: toast });
      probeTakes();
      if (S.tab === 'probe') FL.probeApp.show();
    }, function (e) { box.innerHTML = '<div class="page"><div class="hint fl-bad"><b>The probe didn’t load</b>' + esc(e.message) + '</div></div>'; });
  }
  // The firmware picked in the sidebar, for the probe to program: { name, bytes, base, from } or { why }.
  function currentImage() {
    var c = current();
    if (!c) return null;
    if (c.board.kind === 'bridge') return { why: c.fw.name + ' is for a board updated through another board’s passthrough: it’s in blocks, not one image. Program it from the Serial bootloader tab.' };
    if (!S.bytesReady || !bytesFor || bytesFor.key !== runKey()) return { why: S.bytesError || 'Fetching ' + c.fw.name + '…', waiting: !S.bytesError };
    return { name: c.fw.local ? c.fw.name : c.fw.name + '.bin', title: c.fw.name, bytes: bytesFor.bytes, base: (c.board.flash || I.GENERIC.flash).base,
      from: c.fw.local ? 'this computer' : 'GitHub', board: c.board.id === I.GENERIC.id ? '' : c.board.name, mcu: c.board.mcu || '' };
  }
  function probeTakes() { if (FL.probeApp && FL.probeApp.offer) FL.probeApp.offer(); }

  function sideCollapsed(on) {
    var app = $('#app');
    if (matchMedia('(max-width: 860px)').matches) { app.classList.toggle('nav-open'); return; }
    var v = on === undefined ? !app.classList.contains('side-collapsed') : on;
    app.classList.toggle('side-collapsed', v);
    try { localStorage.setItem(SIDE_KEY, v ? '1' : ''); } catch (e) { /* storage blocked */ }
  }

  document.addEventListener('click', function (ev) {
    if (ev.target === $('#app') && $('#app').classList.contains('nav-open')) { $('#app').classList.remove('nav-open'); ev.stopPropagation(); return; }
    if (ev.target.closest('#probe-view')) return;   // the probe handles its own (assets/probe/app.js)
    var el = ev.target.closest('[data-act]'); if (!el) return;
    var act = el.dataset.act;
    if (act === 'sheet-bg' && ev.target !== el) return;
    if (el.tagName === 'A' && act !== 'home') ev.preventDefault();
    switch (act) {
      case 'home': ev.preventDefault(); select('home'); break;
      case 'open-fw': select('fw', el.dataset.fw); break;
      case 'open-local': select('local'); break;
      case 'sys-new': openSystem(null); break;
      case 'sys-open-saved': openSavedSystem(el.dataset.sys); break;
      case 'sys-save': saveSystemNow(); break;
      case 'sys-discard': discardSystemChanges(); break;
      case 'sys-delete-saved': deleteSavedSystem(); break;
      case 'proj-new': newProject(); break;
      case 'proj-open': S.projKey = el.dataset.proj; select('project'); break;
      case 'proj-save': { var ps = projectByKey(S.projKey); if (ps && ps.draft) saveDraftProject(ps); break; }
      case 'proj-discard': { var pd = projectByKey(S.projKey); if (pd && pd.draft) discardProject(pd); break; }
      case 'proj-delete': { var px = projectByKey(S.projKey); if (px && !px.draft) deleteProject(px); break; }
      case 'proj-sys-new': { var pn = projectByKey(S.projKey); openSystem(null, pn && !pn.unsorted ? pn.pid : ''); break; }
      case 'proj-upload': $('#proj-file-input').click(); break;
      case 'proj-board': boardSheet(); break;
      case 'up-ok': uploadNow(); break;
      case 'bd-ok': boardNow(); break;
      case 'pp-ok': if (pickDone) pickDone(); break;
      case 'fw-save': ev.preventDefault(); fwSave(); break;
      case 'fw-discard': ev.preventDefault(); S.fwEdit = null; render(); break;
      case 'sys-open': openSystem(el.dataset.sys); break;
      case 'sys-block': if (S.sys) { S.sys.block = S.sys.block === el.dataset.block ? '' : el.dataset.block; render(); } break;
      case 'sys-file': if (S.run && S.run.busy) toast('Wait for the update to finish.'); else $('#sys-file-input').click(); break;
      case 'sys-demo-file': demoSystemFile(); break;
      case 'open-rel': openRelease(el.dataset.rel); break;
      case 'open-jig': openJig(el.dataset.jig); break;
      case 'rel-to-sys': releaseToSystem(el.dataset.rel || S.relKey, el.dataset.sys || ''); break;
      case 'sys-link-reset': if (S.sys) { S.sys.sys.link = Object.assign({}, LINK); systemChanged(); } break;
      case 'sys-forget-port': if (S.sys) { S.sys.sys.learned = null; systemChanged(); toast('Flasher will ask for the passthrough port again'); } break;
      case 'sys-delete': deleteSystem(); break;
      case 'open-file': if (S.run && S.run.busy) toast('Wait for the flash to finish.'); else $('#file-input').click(); break;
      case 'flash': startFlash(); break;
      case 'bridge-update': startBridge(false); break;
      case 'bridge-compare': startBridge(true); break;
      case 'pick-bridge': pickBridge(); break;
      case 'pick-dfu': { var c = current(); if (c && S.run) { S.run.busy = true; S.run.waitPick = false; upd(); askForDfu(c, false); } break; }
      case 'toggle-details': {
        var hide = !detailsHidden();
        try { localStorage.setItem(DETAILS_KEY, hide ? '1' : ''); } catch (e) { /* storage blocked: this view only */ }
        document.querySelectorAll('.fl-panel').forEach(function (x) { x.classList.toggle('terse', hide); });
        document.querySelectorAll('.fl-details-btn').forEach(function (x) {
          var tip = hide ? 'Show the details' : 'Hide the details';
          x.classList.toggle('on', !hide); x.setAttribute('aria-pressed', String(!hide)); x.title = tip; x.setAttribute('aria-label', tip);
        });
        break;
      }
      case 'flash-byhand': S.skipTouch = true; S.run = null; startFlash(); break;
      case 'console': openConsole(); break;
      case 'console-board': { var cb = current(); S.tab = 'console'; openConsole(cb ? { board: cb.board } : {}); break; }
      case 'console-close': closeConsole().then(function () { if (S.con) S.con = { error: '' }; render(); }); break;
      case 'term-clear': term.clear(); queueDraw(); focusTerm(); break;
      case 'term-save': {
        var text = term.text ? term.text() : ($('#term-out') || {}).textContent || '';
        var url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })), a = document.createElement('a');
        a.href = url; a.download = 'console-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        break;
      }
      case 'top-tab':
        S.tab = el.dataset.tab; document.body.querySelector('.app').classList.remove('nav-open');
        render(); $('#main').scrollTop = 0;
        if (S.tab === 'console' && S.con && S.con.open) focusTerm();
        break;
      case 'account': accountSheet(); break;
      case 'sync': if (!DEMO && C.auth.token()) load(); else accountSheet(); break;
      case 'driver': driverSheet(); break;
      case 'sheet-bg': case 'sheet-close': closeSheet(); break;
      case 'test-conn': testConnection(); break;
      case 'settings-cancel': closeSheet(); break;
      case 'sign-out':
        if (!confirm('Sign out of this browser? This removes the GitHub token every Signoff tool here shares, so Signoff EE, ME, FW, PL, and Fabcheck sign out too. Flasher also forgets the passthrough systems and their files kept here.')) break;
        (window.SignoffAuth ? window.SignoffAuth.signOut() : Promise.resolve()).catch(function () { /* cleared below */ }).then(function () {
          C.auth.clear(); forgetKept(); forgetSystems(); try { localStorage.removeItem('flasher.v1.fwReleases'); localStorage.removeItem('flasher.v1.jigBuilds'); } catch (e) { /* storage blocked */ } S.fwr = null; S.jig = null; closeSheet(); S.catalog = null; S.syncedAt = 0; S.view = S.local ? 'local' : 'home'; load(); toast('Signed out');
        });
        break;
      case 'gh-signin': ghSignIn(el); break;
      case 'token-toggle': {
        var panel = $('#s-token-panel'); if (!panel) break;
        var opening = panel.hidden;
        panel.hidden = !opening; el.setAttribute('aria-expanded', String(opening));
        var tf = opening && panel.querySelector('#tok'); if (tf && !tf.value) tf.focus();
        break;
      }
      case 'reload': load(); break;
      case 'toggle-group': toggleGroup(el.dataset.group); break;
      case 'people': select('people'); loadAccess(); break;
      case 'refresh-access': P.map = null; loadAccess(); render(); break;
      case 'add-person': personSheet(''); break;
      case 'add-self': apply('Adding you', function (log) { setPerson(S.catalog.login, { name: S.catalog.login, role: 'fte', projects: [], deleted: false }); return save(log, 'add @' + S.catalog.login); }); break;
      case 'person-projects': personSheet(el.dataset.login); break;
      case 'person-save': personSave(el.dataset.login); break;
      case 'person-role': setRole(el.dataset.login, el.dataset.role); break;
      case 'remove-person': removePerson(el.dataset.login); break;
      case 'remove-confirm': removeConfirm(el.dataset.login); break;
      case 'fix-access': { var fl = el.dataset.login; apply('Access for @' + fl, function (log) { return grant(fl, log); }); break; }
      case 'prole': {
        document.querySelectorAll('#p-role button').forEach(function (x) { x.classList.toggle('on', x === el); });
        $('#p-projects-field').hidden = el.dataset.prole === 'fte';
        break;
      }
      case 'ppick': if (el.closest('#pp-list')) { Array.prototype.forEach.call(document.querySelectorAll('#pp-list .pick'), function (x) { x.classList.toggle('on', x === el); }); } else el.classList.toggle('on'); break;
      case 'accept-invite':
        new window.Signoff.GitHubAccount(C.auth.token()).acceptInvitation(el.dataset.id).then(function () { toast('Invitation accepted'); load(); }, function (e) { toast('Couldn’t accept it: ' + e.message); });
        break;
      case 'theme': { var t = isDark(readTheme()) ? 'light' : 'dark'; writeTheme(t); applyTheme(t); break; }
      case 'nav': sideCollapsed(); break;
    }
  }, true);

  document.addEventListener('change', function (ev) {
    var k = ev.target.dataset && ev.target.dataset.change;
    if (k === 'skip') { S.skipTouch = ev.target.checked; render(); }
    if (k === 'local-board') { S.local.boardId = ev.target.value; S.run = null; prepareBytes(); render(); }
    if (k === 'con-baud') { S.conBaud = +ev.target.value; render(); }
    if (k === 'con-filter') { S.conFilter = ev.target.value; render(); }
    if (k && k.indexOf('sys-') === 0) systemField(k.slice(4), ev.target.value);
    if (k === 'fwrel-remote' && ev.target.value && S.sys) releaseToSystem(ev.target.value, S.sys.sys.id);
    if (k === 'proj-name') renameProject(ev.target.value);
    if (k === 'fw-name' && S.fwEdit) { S.fwEdit.name = ev.target.value.slice(0, 80); render(); }
    if (k === 'fw-project' && S.fwEdit) {
      if (ev.target.value === '__new') { var d = newProject(); if (d) { S.fwEdit.project = d.id; select('fw', S.fwEdit.key); } else render(); }
      else { S.fwEdit.project = ev.target.value; render(); }
    }
  });

  document.addEventListener('submit', function (ev) {
    var k = ev.target.dataset.submit; if (!k) return;
    ev.preventDefault();
    if (k === 'sign-in') {
      var root = $('#sheet-root'), field = $('#tok'), was = C.auth.token();
      if (root.dataset.theme) writeTheme(root.dataset.theme);
      if (!field) { closeSheet(); load(); return; }
      var t = field.value.trim();
      if (!t) { if (was) { $('#tok').focus(); toast('Paste a token, or use Sign out'); } else closeSheet(); return; }
      C.auth.set(t, $('#tok-remember').checked); closeSheet(); load();
    }
  });

  document.addEventListener('keydown', function (ev) {
    // A probe confirmation (data-x buttons) answers Escape itself: closing it here would leave its operation waiting.
    if (ev.key === 'Escape' && $('#sheet-root').innerHTML && !$('#sheet-root [data-x]')) { closeSheet(); return; }
    if (ev.target && ev.target.id === 'term-in') {
      // The console: keys go to the board as a terminal sends them.
      var sel = String(window.getSelection ? window.getSelection() : '');
      var bytes = FL.term.keyBytes(ev, !!sel);
      if (bytes !== null && con && S.con && S.con.open) {
        ev.preventDefault();
        con.send(bytes).catch(function (e) { toast('Couldn’t send: ' + e.message); });
      }
      return;
    }
    var typing = /INPUT|TEXTAREA|SELECT/.test((ev.target.tagName || ''));
    if (ev.key === '[' && !typing && !ev.ctrlKey && !ev.metaKey) sideCollapsed();
  });

  // Pasted text goes to the board as typed, with line ends as Enter.
  document.addEventListener('paste', function (ev) {
    if (!(ev.target && ev.target.id === 'term-in') || !con || !(S.con && S.con.open)) return;
    ev.preventDefault();
    var text = (ev.clipboardData && ev.clipboardData.getData('text')) || '';
    if (text) con.send(text.replace(/\r?\n/g, '\r')).catch(function (e) { toast('Couldn’t send: ' + e.message); });
  });
  // The cursor shows only while the console has focus.
  document.addEventListener('focusin', function (ev) { if (ev.target.id === 'term-in') queueDraw(); });
  document.addEventListener('focusout', function (ev) { if (ev.target.id === 'term-in') queueDraw(); });
  // Text that came without a keydown (phone keyboards, dictation, input methods): send it as typed.
  document.addEventListener('input', function (ev) {
    if (ev.target.id !== 'term-in') return;
    var text = ev.target.value; ev.target.value = '';
    if (text && con && S.con && S.con.open) con.send(text.replace(/\r?\n/g, '\r')).catch(function (e) { toast('Couldn’t send: ' + e.message); });
  });
  // A click in the console puts the keys there, unless it was to select text to copy.
  document.addEventListener('mouseup', function (ev) {
    if (!ev.target.closest || !ev.target.closest('#term')) return;
    if (!String(window.getSelection ? window.getSelection() : '')) focusTerm();
  });
  document.addEventListener('toggle', function (ev) {
    if (ev.target.dataset && ev.target.dataset.toggle === 'about') {
      try { localStorage.setItem(ABOUT_KEY, ev.target.open ? 'open' : 'closed'); } catch (e) { /* storage blocked */ }
    }
  }, true);

  // A file from this computer: a .bin, or a .hex or .elf (FL.files reads their addresses), picked or dropped.
  function openLocal(f) {
    if (!f) return;
    if (S.run && S.run.busy) return toast('Wait for the flash to finish.');
    if (f.size > 64 * 1048576) return toast('That file is over 64 MB; it isn’t firmware for these boards.');
    f.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf), segments = null;
      if (!/\.bin$/i.test(f.name)) {
        try { var img = FL.files.parse(f.name, bytes); if (!img.needsBase) segments = img.segments; }
        catch (e) { return toast(f.name + ': ' + e.message); }
      }
      if (!segments && bytes.length > 16 * 1048576) return toast('That .bin is over 16 MB; it isn’t firmware for these boards.');
      return I.sha256(bytes).then(function (h) { openLocalBytes(f.name, bytes, h, null, null, segments); });
    });
  }
  /* Bytes to flash as a file: a picked or dropped one, or a Signoff FW release (release: { key, target, version,
     state, withdrawnWhy, base }; boardId: the board its release names, '' for Any STM32). */
  function openLocalBytes(name, bytes, sha256, boardId, release, segments) {
    if (segments === undefined) {
      segments = null;
      if (!/\.bin$/i.test(name)) {
        try { var img = FL.files.parse(name, bytes); if (!img.needsBase) segments = img.segments; }
        catch (e) { return toast(name + ': ' + e.message); }
      }
    }
    var ids = Object.keys(boards());
    var bid = boardId != null ? boardId : S.local && boards()[S.local.boardId] ? S.local.boardId : ids.length === 1 ? ids[0] : '';
    // A release's .bin names its flash address; Flasher writes a .bin at its board's flash base, so they must agree.
    var b = boards()[bid] || I.GENERIC;
    if (release && release.base && !segments && b.flash && parseInt(release.base, 16) !== b.flash.base) {
      return toast(name + ' goes to ' + release.base + ', and ' + b.name + '’s flash starts at ' + I.hex(b.flash.base) + '. Release a .hex or .elf instead.');
    }
    S.local = { name: name, bytes: bytes, segments: segments, sha256: sha256, boardId: bid, release: release || null };
    unitsFor = null;
    if (S.tab === 'console') S.tab = 'serial';
    select('local');
  }
  $('#file-input').addEventListener('change', function () { var f = this.files && this.files[0]; this.value = ''; openLocal(f); });
  // A passthrough system's remote has its own picker, for a .hex or .elf only.
  $('#proj-file-input').addEventListener('change', function () { var f = this.files && this.files[0]; this.value = ''; if (f && S.view === 'project') uploadSheet(f); });
  $('#sys-file-input').addEventListener('change', function () { var f = this.files && this.files[0]; this.value = ''; if (S.view === 'system') setSystemFile(f); });
  // Drag and drop: a file dropped on the page opens as Open a file does; on the Debug probe tab, in the probe.
  function draggingFiles(ev) { return ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') >= 0; }
  var dragDepth = 0;
  document.addEventListener('dragenter', function (ev) { if (!draggingFiles(ev)) return; dragDepth++; document.body.classList.add('fl-dropping'); });
  document.addEventListener('dragleave', function (ev) { if (!draggingFiles(ev)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('fl-dropping'); } });
  document.addEventListener('dragover', function (ev) { if (draggingFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('drop', function (ev) {
    if (!draggingFiles(ev)) return;
    ev.preventDefault(); dragDepth = 0; document.body.classList.remove('fl-dropping');
    var f = ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f) return;
    if (S.tab === 'probe' && $('#pb-file')) {
      var dt = new DataTransfer(); dt.items.add(f); $('#pb-file').files = dt.files; $('#pb-file').dispatchEvent(new Event('change'));
      return;
    }
    if (S.view === 'system' && S.tab === 'serial') return setSystemFile(f);   // a system's remote takes it
    openLocal(f);
  });

  // Never leave mid-flash: the board would be left half-written (recoverable, but slow).
  window.addEventListener('beforeunload', function (ev) { if ((S.run && S.run.busy) || probeStatus().busy) { ev.preventDefault(); ev.returnValue = ''; } });
  // Another tab signing in or out (Signoff EE, say) changes what this page can read.
  var seenTag = whoTag();
  window.addEventListener('storage', function (ev) {
    if ((ev.key !== 'signoff.token' && ev.key !== 'signoff.login') || DEMO || (S.run && S.run.busy)) return;
    var tag = whoTag();
    if (tag !== seenTag) { seenTag = tag; load(); }
  });

  // ── Start ──
  applyTheme(readTheme());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { applyTheme(readTheme()); });
  try { if (localStorage.getItem(SIDE_KEY)) $('#app').classList.add('side-collapsed'); } catch (e) { /* storage blocked */ }
  $('#version').textContent = FL.VERSION ? 'v' + FL.VERSION : '';
  setupToolsFold($('#side-tools'));
  $('#fw-search').addEventListener('input', renderSide);
  $('#main').addEventListener('scroll', function () { $('#toolbar').classList.toggle('scrolled', $('#main').scrollTop > 60); }, { passive: true });
  if (DEMO) {
    var banner = $('#demo-banner');
    banner.innerHTML = 'Demo: the made-up Smart Thermostat for Acme Climate. Flashing goes to a board simulated in this page, and the Debug probe tab to a simulated ST-LINK with ' +
      (DEMO_PROBE === 'h5' ? 'an STM32H563 (<a href="?demo&tab=probe">try the G0B1</a>)' : 'an STM32G0B1 (<a href="?demo=h5&tab=probe">try the H563</a>)') + '; nothing touches USB. <a href="./">Leave the demo</a>';
    banner.hidden = false; document.body.classList.add('has-banner');
    document.querySelectorAll('[data-demo-href]').forEach(function (a) { a.href = a.getAttribute('href') + '?demo'; });
  }
  FL.app = { state: S, load: load, render: render, demoBoard: demoBoard, currentImage: currentImage, renderTabs: renderTabs };
  load();
  // Accepted from the suite's invitations card (signoff/assets/invites.js): read the list again.
  window.addEventListener('signoff:invites-accepted', function () { if (!DEMO) load(); });
})(window.FL = window.FL || {});
