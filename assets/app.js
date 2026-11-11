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
    tab: 'flash',                      // the firmware panel's tab: 'flash' | 'console'
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
    if (DEMO) { S.loading = true; render(); return C.loadDemo().then(done, fail); }
    var tok = C.auth.token();
    if (!tok) { S.catalog = null; S.loading = false; S.syncing = false; render(); return Promise.resolve(); }
    // Another account (signed in here or in another tab) never sees the last one's list.
    if (S.catalog && S.catalogTag !== tagOf(tok)) { S.catalog = null; S.syncedAt = 0; S.check = null; S.bytesReady = false; bytesFor = null; }
    if (S.syncing) return S.syncing;
    S.catalogTag = tagOf(tok);
    if (!S.catalog) {
      var kept = readKept(tok);
      if (kept) {
        try { S.catalog = C.fromKept(kept.loaded, tok); S.syncedAt = kept.at; restoreFromUrl(); if (current()) prepareBytes(); }
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
      // A flash under way keeps the bytes it has; a list that changed under the open firmware fetches it again.
      if (current() && !(S.run && S.run.busy) && !(S.bytesReady && bytesFor && bytesFor.key === runKey())) prepareBytes();
      render();
    }
    function fail(e) {
      if (S.catalog && !DEMO && e.code !== 'none' && e.code !== 'invited') { S.syncError = e.message || String(e); S.loading = false; render(); return; }
      if (e.code === 'none' || e.code === 'invited') forgetKept();
      S.catalog = e.catalog || null; S.invites = e.invites || []; S.loading = false; S.error = e.message || String(e); render();
    }
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
    if (S.view === 'people' && !S.loading && !(S.catalog && S.catalog.fte)) S.view = 'home';
    if (S.loading && linked) return;   // keep ?fw= in the address until the list is here
    var termFocused = document.activeElement && document.activeElement.id === 'term-in';
    v.innerHTML = S.view === 'home' ? homeHtml() : S.view === 'people' ? peopleHtml() : fwHtml(current());
    if ($('#term')) { drawTerm(); var tb = $('#term'); tb.scrollTop = tb.scrollHeight; if (termFocused) focusTerm(); }
    $('#people-link').hidden = !(S.catalog && S.catalog.fte && !DEMO);
    $('#people-link').classList.toggle('active', S.view === 'people');
    $('#toolbar-title').textContent = c ? c.fw.name : S.view === 'people' ? 'People & access' : 'Flasher';
    document.title = (c ? c.fw.name + ' · ' : '') + 'Flasher';
    setUrl();
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
    if (S.catalog) {
      var bs = boards(), pj = S.catalog.projects || {}, closed = closedGroups(), groups = {};
      S.catalog.firmware.forEach(function (f) {
        var b = bs[f.board], pid = (b && b.project) || f.board, pname = (pj[pid] && pj[pid].name) || (b && b.name) || pid;
        if (q && [f.name, f.summary, b && b.name, pname].join(' ').toLowerCase().indexOf(q) < 0) return;
        (groups[pid] = groups[pid] || { name: pname, list: [], boards: {} }).list.push(f);
        groups[pid].boards[f.board] = 1;
      });
      h = Object.keys(groups).sort(function (a, b) { return groups[a].name.localeCompare(groups[b].name); }).map(function (pid) {
        var g = groups[pid], many = Object.keys(g.boards).length > 1;
        var holds = g.list.some(function (f) { return S.view === 'fw' && S.fwId === f.id + '@' + f.board; });
        var open = !closed[pid] || !!q || holds;
        g.list.sort(function (x, y) { return (bs[x.board].name + x.name).localeCompare(bs[y.board].name + y.name); });
        return '<div class="side-group"><button class="side-group-head" data-act="toggle-group" data-group="' + esc(pid) + '" aria-expanded="' + open + '">' +
          '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '<span class="side-group-name">' + esc(g.name) + '</span><span class="side-group-count">' + g.list.length + '</span></button>' +
          (open ? g.list.map(function (f) {
            var key = f.id + '@' + f.board, on = S.view === 'fw' && S.fwId === key;
            var sub = [many ? bs[f.board].name : '', I.fmtBytes(f.size), f.built ? fmtDate(f.built) : ''].filter(Boolean).join(' · ');
            return '<button class="proj' + (on ? ' active' : '') + '" data-act="open-fw" data-fw="' + esc(key) + '" title="' + esc(f.summary || f.name) + '">' + FW_ICON +
              '<span class="proj-body"><span class="proj-name">' + esc(f.name) + '</span><span class="proj-sub">' + esc(sub) + '</span></span></button>';
          }).join('') : '') + '</div>';
      }).join('');
      if (!h) h = '<div class="side-empty">' + (q ? 'No matching firmware.' : 'No firmware yet.') + '</div>';
    } else if (S.loading) h = '<div class="side-empty">Loading firmware…</div>';
    else if (!DEMO && !C.auth.token()) h = '<div class="side-empty">Sign in to see firmware.</div>';
    if (S.local) {
      h += '<div class="side-group"><div class="side-group-head fl-static-head"><span class="side-group-name">From this computer</span></div>' +
        '<button class="proj' + (S.view === 'local' ? ' active' : '') + '" data-act="open-local">' + FW_ICON + '<span class="proj-body"><span class="proj-name">' + esc(S.local.name) +
        '</span><span class="proj-sub">' + esc(I.fmtBytes(S.local.bytes.length)) + '</span></span></button></div>';
    }
    list.innerHTML = h;
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
    function line2(fallback) { s.textContent = who || fallback; if (who) s.classList.add('sync-who'); }
    pill.classList.toggle('is-syncing', !!S.syncing);
    if (DEMO) { dot.dataset.tone = 'ok'; t.textContent = 'Demo'; s.textContent = 'Made-up firmware, simulated board'; pill.title = 'Demo mode'; return; }
    var tok = C.auth.token();
    if (!tok) { dot.dataset.tone = 'idle'; t.textContent = 'Not signed in'; s.textContent = 'Click to sign in'; pill.title = 'Sign in to GitHub to list firmware'; return; }
    pill.title = 'Sync the firmware list with GitHub' + (S.catalog ? ' · ' + S.catalog.firmware.length + ' firmware, ' + (S.catalog.fte ? 'FTE: every project' : 'the projects shared with you') : '');
    if (S.syncing) { dot.dataset.tone = 'busy'; t.textContent = 'Syncing…'; line2(FL.config.repo); return; }
    if (S.error || S.syncError) { dot.dataset.tone = 'error'; t.textContent = 'Sync failed'; s.textContent = 'Click to try again'; pill.title = S.error || S.syncError; return; }
    dot.dataset.tone = S.syncedAt ? 'ok' : 'idle';
    t.textContent = S.syncedAt ? 'Synced ' + relTime(S.syncedAt) : 'Not synced yet';
    line2('Click to sync');
  }
  setInterval(function () { if (!S.syncing) renderAccount(); }, 60000);

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
        '<div class="fl-row fl-center">' + (ghAuth() ? '<button class="btn btn-primary" data-act="gh-signin">Sign in with GitHub</button><button class="btn" data-act="account">Use a token…</button>'
          : '<button class="btn btn-primary" data-act="account">Sign in…</button>') + '<button class="btn" data-act="open-file">Open a .bin file…</button></div>' +
        '<p class="note">Just looking? <a href="?demo">Try the demo</a>, which flashes a simulated board.</p></div></div>';
    }
    if (S.error) {
      if (S.invites && S.invites.length) {
        return h + '<div class="hint fl-warn"><b>An invitation is waiting</b>' + esc(S.error) + '</div><div class="fl-row">' +
          S.invites.map(function (i) { return '<button class="btn btn-primary" data-act="accept-invite" data-id="' + esc(i.id) + '">Accept ' + esc(i.repo) + '</button>'; }).join('') + '</div></div>';
      }
      return h + '<div class="hint fl-bad"><b>Couldn’t read the firmware list</b>' + esc(S.error) + '</div>' +
        '<div class="fl-row"><button class="btn btn-primary" data-act="reload">Try again</button><button class="btn" data-act="account">GitHub sign-in…</button><button class="btn" data-act="open-file">Open a .bin file…</button></div></div>';
    }
    if (!S.catalog) return h + '</div>';
    var c = S.catalog;
    if (c.invites && c.invites.length) {
      h += '<div class="hint fl-warn"><b>Invitation waiting</b>You’ve been given more firmware on GitHub. Accept to see it here.<div class="fl-row">' +
        c.invites.map(function (i) { return '<button class="btn btn-primary" data-act="accept-invite" data-id="' + esc(i.id) + '">Accept ' + esc(i.repo) + '</button>'; }).join('') + '</div></div>';
    }
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
      '<span class="chip">' + esc(b.kind === 'bridge' ? I.fmtBytes(fw.size) + ' in ' + fw.units.length + ' blocks' : I.fmtBytes(fw.size) + ' of ' + I.fmtBytes(b.flash.size)) + '</span>' +
      (fw.built ? '<span class="chip">Built ' + esc(fmtDate(fw.built)) + '</span>' : '') +
      (fw.source && fw.source.sha ? '<span class="chip" title="' + esc(fw.source.repo + ' ' + fw.source.path) + '">' + esc((fw.source.repo || '').split('/').pop() + ' @ ' + fw.source.sha.slice(0, 7)) + '</span>' : '') +
      (fw.source && fw.source.dirty ? '<span class="chip fl-chip-warn" title="The checkout it was built from had uncommitted changes">Uncommitted changes</span>' : '') +
      '<span class="chip fl-mono" title="SHA-256 ' + esc(fw.sha256) + '">' + esc(fw.sha256.slice(0, 12)) + '</span></span></div></div></div>';
    h += browserNote();
    if (fw.local) {
      var opts = Object.keys(boards()).filter(function (id) { return boards()[id].kind !== 'bridge'; }).map(function (id) { return '<option value="' + esc(id) + '"' + (S.local.boardId === id ? ' selected' : '') + '>' + esc(boards()[id].name) + '</option>'; }).join('');
      h += '<div class="card fl-pad"><div class="field"><label for="local-board">Board</label><select class="input" id="local-board" data-change="local-board">' + opts +
        '<option value=""' + (S.local.boardId && boards()[S.local.boardId] ? '' : ' selected') + '>' + esc(I.GENERIC.name) + '</option></select></div>' +
        '<p class="note">The board decides the checks (flash size, RAM) and how it’s put in update mode.' + (S.catalog ? '' : ' Sign in to choose one of Dovetail’s boards.') + '</p></div>';
    } else if (fw.description) {
      // Collapsible; the choice is kept for this browser (flasher.v1.about).
      h += '<details class="card fl-about" data-toggle="about"' + (aboutOpen() ? ' open' : '') + '><summary><span class="fl-about-title">About this firmware</span>' +
        '<span class="fl-about-sum">' + esc(fw.summary || '') + '</span>' +
        '<svg class="fl-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></summary>' +
        '<div class="fl-desc">' + esc(fw.description) + '</div></details>';
    }
    // One panel: Flash, and the board's console beside it when the board has a serial port.
    if (b.kind === 'bridge') {
      return h + '<div class="card fl-panel"><div class="fl-tabs" role="tablist"><button role="tab" class="on" aria-selected="true">' + esc(BRIDGE_TAB) + '</button></div>' +
        '<div class="fl-tab-body">' + bridgeHtml(c, run) + '</div></div></div>';
    }
    var tabs = !!(b.run && (DEMO || navigator.serial));
    if (!tabs) S.tab = 'flash';
    h += '<div class="card fl-panel">';
    if (tabs) {
      var live = S.con && S.con.open;
      h += '<div class="fl-tabs" role="tablist">' +
        '<button role="tab" data-act="tab" data-tab="flash" class="' + (S.tab === 'flash' ? 'on' : '') + '" aria-selected="' + (S.tab === 'flash') + '">Flash</button>' +
        '<button role="tab" data-act="tab" data-tab="console" class="' + (S.tab === 'console' ? 'on' : '') + '" aria-selected="' + (S.tab === 'console') + '">Console' +
        (live ? '<span class="fl-live" title="Connected"></span>' : '') + '</button></div>';
    }
    h += '<div class="fl-tab-body">' + (S.tab === 'console' ? consoleHtml(c) : flashHtml(c, run)) + '</div></div>';
    return h + '</div>';
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
    var canTouch = !!(b.run && (DEMO || navigator.serial)), byHand = !canTouch || S.skipTouch;
    var dfuName = b.dfu.name || 'DFU in FS Mode';
    h += '<p class="fl-intro">Connect the board to USB and click <b>Flash board</b>. When first connected, Chrome may ask you to pick the board twice. After that flashing is one click.</p>';
    h += '<ol class="fl-steps">';
    h += '<li class="fl-step ' + stepState(run, 'restart') + '"><span class="fl-num">1</span><div><div class="fl-step-title">Put the board in update mode</div>' +
      (canTouch && !S.skipTouch
        ? '<div class="fl-step-sub">Flasher restarts the board so it can take new firmware. <i>First time:</i> Chrome shows a list. Pick <b>' + esc(FL.serial.portNames(b.runs, 'the board')) + '</b> and click <b>Connect</b>.</div>'
        : '<div class="fl-step-sub">Press these on the board, then click <b>Flash board</b>:</div>' + buttonsHtml(b)) +
      (canTouch ? '<label class="fl-check"><input type="checkbox" data-change="skip"' + (S.skipTouch ? ' checked' : '') + (busy ? ' disabled' : '') + '> The board isn’t running firmware (new, blank, or stuck)</label>' : '') +
      '</div></li>';
    h += '<li class="fl-step ' + stepState(run, 'write') + '"><span class="fl-num">2</span><div><div class="fl-step-title">Write the firmware</div>' +
      '<div class="fl-step-sub"><i>First time:</i> Chrome shows ' + (byHand ? 'a' : 'a second') + ' list. Pick <b>' + esc(dfuName) + '</b> and click <b>Connect</b>. Flasher erases the board, writes the firmware, and reads it back to check every byte.</div>' +
      (run && (run.step === 'write' || run.ok) ? '<div class="busy-bar fl-bar"><i style="width:' + Math.round((run.ok ? 1 : run.pct || 0) * 100) + '%"></i></div><div class="fl-step-sub fl-phase">' + esc(run.ok ? 'Written and checked' : run.phase || '') + '</div>' : '') +
      '</div></li>';
    h += '<li class="fl-step ' + stepState(run, 'start') + '"><span class="fl-num">3</span><div><div class="fl-step-title">Run it</div>' +
      '<div class="fl-step-sub">The board restarts and runs the new firmware. Nothing to do.</div></div></li>';
    h += '</ol>';
    if (run && run.error) h += '<div class="hint fl-bad"><b>' + esc(run.errorTitle || 'The flash stopped') + '</b>' + esc(run.error) + (run.errorHelp ? '<div class="fl-help">' + run.errorHelp + '</div>' : '') + '</div>';
    if (run && run.ok) h += '<div class="hint fl-good"><b>Done</b>' + esc(c.fw.name) + ' is on the board and running (' + esc(I.fmtBytes(run.bytes)) + ', ' + run.pages + ' pages, verified) in ' + (run.ms / 1000).toFixed(1) + ' s.</div>';
    h += '<div class="fl-row">';
    var blocked = (chk && chk.errors.length) || (!DEMO && !navigator.usb) || !S.bytesReady;
    if (run && run.waitPick && !busy) h += '<button class="btn btn-primary" data-act="pick-dfu">Pick ' + esc(b.dfu.name || 'DFU in FS Mode') + '</button>';
    else h += '<button class="btn btn-primary" data-act="flash"' + (busy || blocked ? ' disabled' : '') + '>' + (busy ? 'Flashing…' : run && run.ok ? 'Flash again' : 'Flash board') + '</button>';
    if (run && run.ok && b.run && (DEMO || navigator.serial)) h += '<button class="btn" data-act="console">Open console</button>';
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

  function consoleHtml(c) {
    var st = S.con || {}, busy = S.run && S.run.busy;
    var tone = st.open ? 'ok' : st.connecting ? 'busy' : st.error ? 'error' : 'idle';
    var label = st.open ? 'Connected to ' + (st.name || FL.serial.portNames(c.board.runs, 'the board')) : st.connecting ? 'Connecting…' : st.error ? st.error : 'Not connected';
    return '<div class="fl-con-bar"><span class="sync-dot" data-tone="' + tone + '"></span><span class="fl-con-status">' + esc(label) + '</span><span class="fl-grow"></span>' +
      (st.open ? '<button class="btn" data-act="console-close">Disconnect</button>'
        : '<button class="btn btn-primary" data-act="console"' + (st.connecting || busy ? ' disabled' : '') + '>Connect</button>') +
      '<button class="btn" data-act="term-clear" title="Clear this window (the board isn’t told)">Clear</button></div>' +
      '<div class="fl-term" id="term"><pre id="term-out">' + term.html(false) + '</pre>' +
      // The keys go through a hidden field, as in xterm.js: special keys arrive as keydowns, and text
      // from a phone keyboard, dictation, or an input method arrives as input.
      '<textarea class="fl-term-in" id="term-in" aria-label="Console: keys go to the board" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea></div>' +
      '<p class="note">Click in the console and type: every key goes to the board, which echoes it and edits the line. On a board whose console edits its own line, Up and Down recall history, Tab completes, and Ctrl-L or <b>clear</b> clears. ' +
      'Ctrl-C copies when text is selected, and otherwise goes to the board. The port opens at 115200 baud, never 1200, which would restart the board into its bootloader. Close the Arduino IDE’s Serial Monitor first: only one program can have the port.</p>';
  }

  // ── The image for the current firmware ──
  var bytesFor = null;   // { key, bytes }
  function runKey() { var c = current(); return c ? (c.fw.local ? 'local:' + c.fw.sha256 : c.fw.id + '@' + c.fw.board) + '|' + c.board.id : ''; }
  function prepareBytes() {
    var c = current(), key = runKey();
    S.check = null; S.bytesReady = false; S.bytesError = '';
    if (!c) return;
    if (c.board.kind === 'bridge') { S.bytesReady = true; return; }
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
    // A console left open holds the board's serial port, and the restart request needs it.
    var closing = closeConsole();
    S.con = null; S.tab = 'flash';
    upd();
    var touched = false;
    closing.catch(function () {}).then(function () { return findDfu(b); }).then(function (dev) {
      if (dev) { log('Found the board already in update mode (' + dev.productName + ').'); return dev; }
      if (S.skipTouch || !b.run || (!DEMO && !navigator.serial)) return null;
      return pickSerial(b).then(function (port) {
        if (!port) { log('No running board picked; looking for one already in update mode.'); return null; }
        log('Restarting the board into its bootloader (' + b.touchBaud + '-baud touch)…');
        return FL.serial.touch(port, { baud: b.touchBaud }).then(function () {
          touched = true;
          if (DEMO) setTimeout(function () { demoBoard.running = false; }, 700);
          log('Waiting for the board to come back in update mode…');
          return waitDfu(b, 6000);
        });
      });
    }).then(function (dev) {
      // This browser has opened the board's update mode before, so it would have been found by
      // now: the board restarted but never came back on USB.
      if (!dev && touched && dfuKnown(b)) throw Object.assign(new Error('The board restarted but didn’t come back in update mode.'), { code: 'gone' });
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
    return navigator.usb.requestDevice({ filters: [{ vendorId: b.dfu.vid, productId: b.dfu.pid }] }).then(function (dev) {
      S.run.waitPick = false; return writeTo(dev, c);
    }, function (e) {
      if (e && e.name === 'SecurityError' && first) {
        // The browser wants a fresh click before it shows its list.
        S.run.busy = false; S.run.waitPick = true;
        var pick = '“Pick ' + (b.dfu.name || 'DFU in FS Mode') + '”';
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
      S.run.busy = false; S.run.ok = true; S.run.doneAt = Date.now(); S.run.ms = S.run.doneAt - S.run.t0;
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
  }

  // ── Bridge boards: updated through another board's USB passthrough (assets/sboot.js) ──
  // 1. The host board's firmware gets the touchBaud touch and reopens its USB as a passthrough to
  //    the board's bootloader (a new serial port, b.bridge). 2. Flasher compares every erase unit's
  //    CRC and writes only those that differ. 3. GO starts the new firmware, and opening the
  //    passthrough at exitBaud sends the host back to its own firmware.
  var BRIDGE_TAB = 'Update through passthrough';
  var demoBridge = { up: false, sim: null, port: null };
  function bridgeKeyOf(b) { return (DEMO ? 'flasher.demo.' : 'flasher.v1.') + 'bridgeOk.' + b.bridge.vid + ':' + b.bridge.pid; }
  function bridgeKnown(b) { try { return localStorage.getItem(bridgeKeyOf(b)) === '1'; } catch (e) { return false; } }
  function bridgeSeen(b) { try { localStorage.setItem(bridgeKeyOf(b), '1'); } catch (e) { /* storage blocked */ } }
  function demoBridgePort(c) {
    var b = c.board;
    if (!demoBridge.sim) {
      var sim = demoBridge.sim = S.catalog.demoDisplay(c.fw.id);
      demoBridge.port = FL.fakebridge.port(sim, { vid: b.bridge.vid, pid: b.bridge.pid, exitBaud: b.exitBaud, onExit: function () {
        demoBridge.up = false;
        // The host restarts the display into its own firmware; the next passthrough boots it again.
        setTimeout(function () { sim.running = false; sim.booted = false; sim.begun = false; sim.baud = b.linkBaud; }, 0);
      } });
    }
    return demoBridge.port;
  }
  function findBridge(c) {
    var b = c.board;
    // In the demo, as in Chrome, the page sees the passthrough only once it has been picked.
    if (DEMO) return Promise.resolve(demoBridge.up && bridgeKnown(b) ? demoBridgePort(c) : null);
    if (!navigator.serial) return Promise.resolve(null);
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
    var b = c.board, busy = run && run.busy, host = FL.serial.portNames(b.runs, 'the host board'), via = b.bridge.name || 'the passthrough';
    var h = '<div class="fl-flash">';
    h += '<p class="fl-intro">This board has no USB port of its own. Plug in the board it’s connected to (Chrome lists it as <b>' + esc(host) + '</b>) and click <b>Update board</b>. ' +
      'Flasher reaches this board’s bootloader through it, compares every block, and writes only the ones that differ. <b>Compare only</b> changes nothing.</p>';
    h += '<ol class="fl-steps">';
    h += '<li class="fl-step ' + bridgeState(run, 'restart') + '"><span class="fl-num">1</span><div><div class="fl-step-title">Open the passthrough</div>' +
      '<div class="fl-step-sub">Flasher asks ' + esc(host) + ' to pass its USB through to this board. <i>First time:</i> Chrome shows a list. Pick <b>' + esc(host) + '</b> and click <b>Connect</b>. It refuses while its output is on.</div></div></li>';
    h += '<li class="fl-step ' + bridgeState(run, 'connect') + '"><span class="fl-num">2</span><div><div class="fl-step-title">Connect to the bootloader</div>' +
      '<div class="fl-step-sub"><i>First time:</i> Chrome shows a second list. Pick <b>' + esc(via) + '</b> and click <b>Connect</b>.</div></div></li>';
    h += '<li class="fl-step ' + bridgeState(run, 'write') + '"><span class="fl-num">3</span><div><div class="fl-step-title">' + (run && run.compareOnly ? 'Compare' : 'Compare and write') + '</div>' +
      '<div class="fl-step-sub">Every block’s checksum is compared with the board’s; the ones that differ are erased, written, and read back.</div>' +
      (run && (run.step === 'write' || run.ok) ? '<div class="busy-bar fl-bar"><i style="width:' + Math.round((run.ok ? 1 : run.pct || 0) * 100) + '%"></i></div><div class="fl-step-sub fl-phase">' + esc(run.ok ? (run.compareOnly ? 'Compared' : 'Written and checked') : run.phase || '') + '</div>' : '') +
      '</div></li>';
    h += '<li class="fl-step ' + bridgeState(run, 'start') + '"><span class="fl-num">4</span><div><div class="fl-step-title">Run it</div>' +
      '<div class="fl-step-sub">This board starts its firmware, and ' + esc(host) + ' goes back to its own. Nothing to do.</div></div></li>';
    h += '</ol>';
    if (run && run.error) h += '<div class="hint fl-bad"><b>' + esc(run.errorTitle || 'The update stopped') + '</b>' + esc(run.error) + '</div>';
    if (run && run.ok) h += '<div class="hint fl-good"><b>' + esc(run.doneTitle) + '</b>' + esc(run.doneText) + '</div>';
    h += '<div class="fl-row">';
    var blocked = (!DEMO && !navigator.serial) || !(c.fw.units && c.fw.units.length);
    if (run && run.waitPick && !busy) h += '<button class="btn btn-primary" data-act="pick-bridge">Pick ' + esc(via) + '</button>';
    else {
      h += '<button class="btn btn-primary" data-act="bridge-update"' + (busy || blocked ? ' disabled' : '') + '>' + (busy && !run.compareOnly ? 'Updating…' : run && run.ok && !run.compareOnly ? 'Update again' : 'Update board') + '</button>';
      h += '<button class="btn" data-act="bridge-compare"' + (busy || blocked ? ' disabled' : '') + '>' + (busy && run.compareOnly ? 'Comparing…' : 'Compare only') + '</button>';
    }
    h += '</div>';
    if (run && run.log.length) h += '<details class="fl-log"' + (run.error ? ' open' : '') + '><summary>Details</summary><div class="log">' + run.log.map(function (l) { return '<div class="' + (l.cls || '') + '">' + esc(l.text) + '</div>'; }).join('') + '</div></details>';
    h += '<details class="guide fl-manual"><summary>Not in Chrome’s list?</summary><p>Close any other program using ' + esc(host) + '’s serial port (a terminal, the Arduino IDE’s Serial Monitor, another Flasher tab), and try another USB cable. ' +
      'If ' + esc(host) + ' isn’t running firmware that has the passthrough, flash that first.</p>' +
      '<p class="fl-muted">For the curious: the passthrough is ' + esc(host) + '’s USB serial port reopened as a pipe onto this board’s bootloader (USB ' + hex4(b.bridge.vid) + ':' + hex4(b.bridge.pid) + '). ' +
      'An interrupted update is safe: this board waits in its bootloader until an update finishes, so run it again.</p></details>';
    return h + '</div>';
  }

  function startBridge(compareOnly) {
    var c = current();
    if (!c || c.board.kind !== 'bridge' || (S.run && S.run.busy)) return;
    var b = c.board, host = FL.serial.portNames(b.runs, 'the host board');
    S.run = { key: runKey(), busy: true, step: 'restart', log: [], pct: 0, phase: '', t0: Date.now(), compareOnly: !!compareOnly };
    var closing = closeConsole();
    S.con = null; upd();
    closing.catch(function () {}).then(function () { return findBridge(c); }).then(function (port) {
      if (port) { log('The passthrough is already open.'); return port; }
      return pickSerial(b).then(function (hostPort) {
        // None picked: the passthrough may already be open (a cancelled pick, a page reloaded mid-way),
        // and then only its own list finds it.
        if (!hostPort) { log('No ' + host + ' was picked; it may already have its passthrough open.'); return null; }
        log('Asking ' + host + ' to open its passthrough (' + b.touchBaud + '-baud touch)…');
        return FL.serial.touch(hostPort, { baud: b.touchBaud }).then(function () {
          if (DEMO) setTimeout(function () { demoBridge.up = true; }, 600);
          log('Waiting for the passthrough port…');
          return waitBridge(c, bridgeKnown(b) ? 15000 : 5000);
        });
      }).then(function (p2) {
        if (p2) return p2;
        // Not found: this browser hasn't been allowed the passthrough port yet (its list needs a fresh
        // click), or the host didn't open it. Chrome's list tells which.
        S.run.busy = false; S.run.waitPick = true; S.run.step = 'connect';
        log('Click “Pick ' + (b.bridge.name || 'the passthrough') + '” and choose it. If Chrome’s list is empty, ' + host + ' didn’t open it: it refuses while its output is on.');
        upd(); return null;
      });
    }).then(function (port) { if (port) return runBridge(port, c); }).catch(function (e) { stopBridge(e, c); });
  }

  function pickBridge() {
    var c = current(); if (!c || !S.run) return;
    var b = c.board;
    S.run.busy = true; S.run.waitPick = false; upd();
    var got = DEMO ? Promise.resolve(demoBridge.up ? demoBridgePort(c) : null)
      : navigator.serial.requestPort({ filters: FL.serial.filters(b.bridge) }).catch(function (e) { if (e && e.name === 'NotFoundError') return null; throw e; });
    got.then(function (port) {
      if (!port) throw Object.assign(new Error('No passthrough port was chosen.'), { code: 'nobridge' });
      return runBridge(port, c);
    }).catch(function (e) { stopBridge(e, c); });
  }

  function runBridge(port, c) {
    var b = c.board, run = S.run, lastDraw = 0, failure = null;
    run.busy = true; run.waitPick = false; run.step = 'connect'; run.phase = 'Connecting…'; upd();
    bridgeSeen(b);
    var link = new FL.sboot.Link(port);
    function progress(p) {
      if (p.phase === 'connect') return;
      if (run.step !== 'write') { run.step = 'write'; upd(); }
      var f = p.total ? p.done / p.total : 0;
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
      log('Connected to ' + (b.bridge.name || 'the passthrough') + ' at ' + (b.linkBaud / 1e6) + ' Mbaud.');
      return FL.sboot.update(link, { units: c.fw.units, parts: c.fw.parts, commit: c.fw.commit }, {
        expect: b.expect, fastBaud: b.fastBaud, compareOnly: run.compareOnly, log: log, progress: progress,
        fetchPart: function (part) {
          log('Downloading ' + part.path.split('/').pop() + ' (' + I.fmtBytes(part.size) + ')…');
          return S.catalog.fetch({ repo: c.fw.repo, path: part.path, sha256: part.sha256 });
        }
      });
    }).then(function (res) { run.result = res; }, function (e) { failure = e; }).then(function () {
      // Always leave the passthrough: the host goes back to its own firmware and restarts this board.
      // After a failed write the board stays in its bootloader until an update finishes.
      run.step = 'start'; run.phase = 'Leaving the passthrough…'; upd();
      return link.close().then(function () {
        return port.open({ baudRate: b.exitBaud }).then(function () { return port.close(); });
      }).catch(function () {}).then(function () { log('Left the passthrough (' + b.exitBaud + '-baud touch).'); });
    }).then(function () {
      if (failure) throw failure;
      var res = run.result, n = res.changed.length, total = c.fw.units.length;
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
    }).catch(function (e) { stopBridge(e, c); });
  }

  function stopBridge(e, c) {
    var run = S.run, b = c.board, host = FL.serial.portNames(b.runs, 'the host board');
    if (!run) return;
    run.busy = false; run.waitPick = false;
    var msg = (e && e.message) || String(e), code = e && e.code;
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

  function openConsole() {
    var c = current(); if (!c || !c.board.run || (S.con && (S.con.open || S.con.connecting))) return;
    var b = c.board, key = runKey();
    S.tab = 'console'; S.con = { open: false, connecting: true, error: '' }; render();
    var done = function () { if (runKey() !== key) return; S.con.connecting = false; S.con.open = true; S.con.error = ''; render(); focusTerm(); };
    var closed = function (why) {
      if (S.con) { S.con.open = false; S.con.connecting = false; S.con.error = why || ''; }
      if (why !== null) termAdd('\r\n[disconnected]\r\n');
      con = null; if (runKey() === key) render();
    };
    if (DEMO) {
      var sh = FL.fakeusb.shell({
        name: 'tstat', banner: 'Acme Thermostat console (' + c.fw.name + '). Type help; Tab completes.', onData: termAdd,
        commands: {
          status: function () { return 'OK heat off  cool off  T=21.4 °C  RH=38 %  24VAC ok'; },
          relay: function (a) { return /^(heat|cool)$/.test(a[0] || '') && /^(on|off)$/.test(a[1] || '') ? 'OK ' + a[0] + ' relay ' + a[1] : 'ERR usage: relay heat|cool on|off'; },
          info: function () { return 'OK ' + c.fw.name + ', made up for the demo'; }
        }
      });
      con = { send: function (t) { sh.input(t); return Promise.resolve(); }, close: function () { sh.stop(); closed(''); return Promise.resolve(); } };
      setTimeout(function () { done(); sh.start(); }, 250);
      return;
    }
    // A port the browser already allows is used at once. Just after a flash the board is still coming
    // back, so wait a few seconds for it first. Otherwise ask (the browser's list needs this click).
    var waitUntil = S.run && S.run.ok && Date.now() - S.run.doneAt < 8000 ? Date.now() + 5000 : 0;
    function known() {
      return navigator.serial.getPorts().then(function (ports) {
        return ports.filter(function (x) { return FL.serial.matches(x.getInfo(), b.runs); })[0] || null;
      });
    }
    function find() {
      return known().then(function (p) {
        if (p) return p;
        if (Date.now() < waitUntil) return FL.serial.sleep(300).then(find);
        return navigator.serial.requestPort({ filters: FL.serial.filters(b.runs) });
      });
    }
    find().then(function (port) {
      // Name the firmware that answered, when the board can run more than one.
      var info = port.getInfo ? port.getInfo() : {}, which = b.runs.filter(function (r) { return FL.serial.matches(info, r); })[0];
      if (S.con && which && which.name) S.con.name = which.name;
      con = new FL.serial.Console(termAdd, function () { closed(''); });
      return con.open(port).then(done);
    }).catch(function (e) {
      con = null;
      if (S.con) {
        S.con.connecting = false; S.con.open = false;
        S.con.error = e.name === 'NotFoundError' ? 'No port chosen' : e.name === 'SecurityError' ? 'Click Connect to choose the port'
          : 'Couldn’t open the port: another program has it (the Arduino IDE’s Serial Monitor?)';
      }
      if (runKey() === key) render();
    });
  }
  function closeConsole() { var k = con; con = null; return k ? k.close() : Promise.resolve(); }

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
  function select(view, key) {
    if (S.run && S.run.busy) return toast('Wait for the flash to finish.');
    closeConsole();
    S.view = view; S.fwId = key || ''; S.run = null; S.con = null; S.tab = 'flash'; term = new FL.term.Screen();
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
      case 'bridge-update': startBridge(false); break;
      case 'bridge-compare': startBridge(true); break;
      case 'pick-bridge': pickBridge(); break;
      case 'pick-dfu': { var c = current(); if (c && S.run) { S.run.busy = true; S.run.waitPick = false; upd(); askForDfu(c, false); } break; }
      case 'console': openConsole(); break;
      case 'console-close': closeConsole(); break;
      case 'term-clear': term.clear(); queueDraw(); focusTerm(); break;
      case 'tab':
        S.tab = el.dataset.tab === 'console' ? 'console' : 'flash'; render();
        if (S.tab === 'console' && S.con && S.con.open) focusTerm();
        break;
      case 'account': accountSheet(); break;
      case 'sync': if (!DEMO && C.auth.token()) load(); else accountSheet(); break;
      case 'driver': driverSheet(); break;
      case 'sheet-bg': case 'sheet-close': closeSheet(); break;
      case 'test-conn': testConnection(); break;
      case 'settings-cancel': closeSheet(); break;
      case 'sign-out':
        if (!confirm('Sign out of this browser? This removes the GitHub token every Signoff tool here shares, so Signoff EE, ME, FW, PL, and Fabcheck sign out too.')) break;
        (window.SignoffAuth ? window.SignoffAuth.signOut() : Promise.resolve()).catch(function () { /* cleared below */ }).then(function () {
          C.auth.clear(); forgetKept(); closeSheet(); S.catalog = null; S.syncedAt = 0; S.view = S.local ? 'local' : 'home'; load(); toast('Signed out');
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
      case 'ppick': el.classList.toggle('on'); break;
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
    if (ev.key === 'Escape' && $('#sheet-root').innerHTML) { closeSheet(); return; }
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
    banner.innerHTML = 'Demo: the made-up Smart Thermostat for Acme Climate. Flashing goes to a board simulated in this page; nothing touches USB. <a href="./">Leave the demo</a>';
    banner.hidden = false; document.body.classList.add('has-banner');
    document.querySelectorAll('[data-demo-href]').forEach(function (a) { a.href = a.getAttribute('href') + '?demo'; });
  }
  FL.app = { state: S, load: load, render: render, demoBoard: demoBoard };
  load();
})(window.FL = window.FL || {});
