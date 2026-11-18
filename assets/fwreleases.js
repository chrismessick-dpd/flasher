/* Firmware releases from Signoff FW (../fw_design_review/docs/releases.md): a second firmware source beside
   the manifest. FW sharing decides who sees them: Flasher lists every FW review repo the token opens
   (fw_design_review_data for FTEs, and the review-fw-* repos shared with this person), and from each review
   file only its summary.releases. A release's release.json and file are read when it's picked, and the file
   is refused unless its SHA-256 matches. Drafts are listed for FTEs only (the page decides; GitHub doesn't).

   ?demo: the Smart Thermostat's firmware (Signoff FW's fdemo3, three releases over USB) and the display's
   firmware, a passthrough release for a passthrough system's remote. Their bytes are made here. */
(function (FL) {
  'use strict';
  var SG = window.Signoff;
  var CFG = FL.fwConfig = { owner: 'chrismessick-dpd', dataRepo: 'fw_design_review_data', prefix: 'review-fw-', branch: 'main', app: '../fw_design_review/index.html' };
  var STATES = ['draft', 'released', 'withdrawn'], LABEL = { draft: 'Draft', released: 'Released', withdrawn: 'Withdrawn' };
  var ID = /^[A-Za-z0-9_-]{1,64}$/, HEX64 = /^[0-9a-f]{64}$/, BOARD = /^[a-z0-9][a-z0-9_-]{0,47}$/;
  var CACHE_KEY = 'flasher.v1.fwReleases';

  function str(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }
  function store(full, ctx) {
    var p = full.split('/');
    return new SG.GitHubStore({ owner: p[0], repo: p[1], branch: CFG.branch, dataPath: '', token: ctx.token }, ctx.fetch);
  }
  /* One summary.releases entry as it's safe to use, or null. Anyone who can write the review's repo wrote it. */
  function cleanRelease(r, reviewId) {
    if (!r || typeof r !== 'object' || !ID.test(r.id || '')) return null;
    var path = 'releases/' + reviewId + '/' + r.id + '/release.json', sha = String(r.sha256 || '').toLowerCase();
    if (r.path !== path || !HEX64.test(sha)) return null;
    var kind = ['elf', 'hex', 'bin'].indexOf(r.kind) >= 0 ? r.kind : '';
    if (!kind) return null;
    return { id: r.id, version: str(r.version, 40) || '?', state: STATES.indexOf(r.state) >= 0 ? r.state : 'draft', releasedAt: str(r.releasedAt, 10),
      via: r.via === 'passthrough' ? 'passthrough' : 'usb', board: BOARD.test(r.board || '') ? r.board : '', kind: kind,
      size: Math.max(0, Math.floor(+r.size) || 0), sha256: sha, path: path, withdrawnWhy: r.state === 'withdrawn' ? str(r.withdrawnWhy, 400) : '' };
  }
  /* A review file as Flasher keeps it: { id, name, project, releases } or null (no releases, or not a review). */
  function slim(doc) {
    if (!doc || typeof doc !== 'object' || !doc.meta || !ID.test(doc.id || '') || doc.meta.deleted) return null;
    var s = doc.summary || {}, rel = (Array.isArray(s.releases) ? s.releases : []).slice(-100).map(function (r) { return cleanRelease(r, doc.id); }).filter(Boolean);
    if (!rel.length) return null;
    return { id: doc.id, name: str(doc.meta.name, 120) || 'Firmware', project: str(doc.meta.project, 80), archived: !!doc.meta.archived, releases: rel };
  }
  function readCache() { try { var c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); return c && c.v === 1 && c.blobs ? c.blobs : {}; } catch (e) { return {}; } }
  function writeCache(blobs) { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, blobs: blobs })); } catch (e) { /* storage full or blocked */ } }

  /* One repo's targets: its review files' releases, each blob read once (cached by its git SHA). */
  function readRepo(full, ctx, cache, used) {
    var st = store(full, ctx);
    return st.snapshot().then(function (snap) {
      var files = snap.entries.filter(function (e) { return e.type === 'blob' && /^projects\/[A-Za-z0-9_-]+\.json$/.test(e.path); });
      var out = [];
      return files.reduce(function (chain, e) {
        return chain.then(function () {
          if (Object.prototype.hasOwnProperty.call(cache, e.sha)) { used[e.sha] = cache[e.sha]; if (cache[e.sha]) out.push(cache[e.sha]); return; }
          return st.blobBytes(e.sha).then(function (b) {
            var t = null;
            try { t = slim(JSON.parse(new TextDecoder().decode(b))); } catch (err) { t = null; }
            used[e.sha] = t; if (t) out.push(t);
          });
        });
      }, Promise.resolve()).then(function () {
        return out.map(function (t) { return Object.assign({ repo: full }, t); });
      });
    });
  }

  /* Every target with releases this token can open. Resolves { targets, errors, fte }. A repo that can't be
     read is listed in errors; the rest still load. fte: the token opens fw_design_review_data. */
  function load(ctx) {
    var acct = new SG.GitHubAccount(ctx.token, ctx.fetch), cache = readCache(), used = {}, out = { targets: [], errors: [], fte: false };
    var dataFull = CFG.owner + '/' + CFG.dataRepo;
    function one(full) {
      return readRepo(full, ctx, cache, used).then(function (t) { out.targets = out.targets.concat(t); return true; }, function (e) {
        if (full === dataFull && e.status === 404) return false;   // not an FTE: only shared targets
        out.errors.push(full + ': ' + (e.message || e)); return false;
      });
    }
    return one(dataFull).then(function (fte) {
      out.fte = fte;
      return acct.listRepos(CFG.owner, CFG.prefix).catch(function (e) { out.errors.push('Listing shared targets: ' + (e.message || e)); return []; });
    }).then(function (names) {
      return names.reduce(function (chain, n) { return chain.then(function () { return one(CFG.owner + '/' + n); }); }, Promise.resolve());
    }).then(function () {
      writeCache(used);
      out.targets.sort(function (a, b) { return a.name.localeCompare(b.name); });
      return out;
    });
  }

  /* A release's file: its release.json, then the file (joined from its parts), checked against the SHA-256 the
     review's summary gives. Resolves { name, kind, bytes, sha256, load: { via, board, base } }. */
  function fetchRelease(target, rel, ctx) {
    var st = store(target.repo, ctx), dir = 'releases/' + target.id + '/' + rel.id + '/';
    return st.readBytes(rel.path).then(function (b) {
      if (!b) { var e0 = new Error('Release ' + rel.version + '’s release.json isn’t in ' + target.repo + '.'); e0.code = 'missing'; throw e0; }
      var j = JSON.parse(new TextDecoder().decode(b)), f = j && j.file || {};
      var name = typeof f.name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/.test(f.name) ? f.name : '';
      if (!name || f.path !== dir + name || String(f.sha256 || '').toLowerCase() !== rel.sha256) throw new Error('Release ' + rel.version + '’s release.json doesn’t match the review.');
      var parts = Array.isArray(f.parts) ? f.parts : null;
      if (parts && !parts.every(function (p, i) { return p === dir + name + '.' + ('00' + (i + 1)).slice(-3); })) throw new Error('Release ' + rel.version + '’s parts aren’t where they should be.');
      return st.readVerified(parts && parts.length ? parts : f.path, rel.sha256).then(function (bytes) {
        var l = j.load || {};
        return { name: name, kind: rel.kind, bytes: bytes, sha256: rel.sha256,
          load: { via: rel.via, board: rel.board, base: typeof l.base === 'string' && /^0x[0-9A-Fa-f]{1,8}$/.test(l.base) ? l.base : '' } };
      });
    }).catch(function (e) {
      if (e.code === 'mismatch') e.message = 'The stored file doesn’t match its recorded SHA-256, so it won’t be flashed.';
      throw e;
    });
  }

  /* The newer Released build of the same target, if there is one. */
  function newerThan(target, rel) {
    var list = target.releases.filter(function (r) { return r.state === 'released'; }), last = list[list.length - 1];
    var i = target.releases.map(function (r) { return r.id; }).indexOf(rel.id), j = last ? target.releases.indexOf(last) : -1;
    return last && last.id !== rel.id && j > i ? last : null;
  }
  function reviewUrl(target, rel) { return CFG.app + '?project=' + encodeURIComponent(target.id) + (rel ? '&item=' + encodeURIComponent(rel.id) : ''); }

  // ── The demo ──
  // An ELF32 (ARM, one PT_LOAD segment at addr), as a build writes it; enough for FL.files.parse.
  function makeElf(addr, data) {
    var out = new Uint8Array(84 + data.length), dv = new DataView(out.buffer);
    out.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
    dv.setUint16(16, 2, true); dv.setUint16(18, 40, true); dv.setUint32(20, 1, true); dv.setUint32(24, (addr + 0x1C1) >>> 0, true);
    dv.setUint32(28, 52, true); dv.setUint32(36, 0x05000000, true); dv.setUint16(40, 52, true); dv.setUint16(42, 32, true); dv.setUint16(44, 1, true); dv.setUint16(46, 40, true);
    dv.setUint32(52, 1, true); dv.setUint32(56, 84, true); dv.setUint32(60, addr, true); dv.setUint32(64, addr, true);
    dv.setUint32(68, data.length, true); dv.setUint32(72, data.length, true); dv.setUint32(76, 5, true); dv.setUint32(80, 4, true);
    out.set(data, 84);
    return out;
  }
  var DEMO_TARGETS = [
    { id: 'fdemo3', name: 'Thermostat Firmware', project: 'Smart Thermostat', board: 'tstat-main', via: 'usb', releases: [
      { id: 'r3-0', version: '0.8.0', state: 'withdrawn', days: 7, file: 'tstat-main-0.8.0.elf', seed: 31, size: 90112 },
      { id: 'r3-1', version: '0.9.0', state: 'released', days: 3, file: 'tstat-main-0.9.0.elf', seed: 37, size: 94208 },
      { id: 'r3-2', version: '0.9.1', state: 'draft', days: 0, file: 'tstat-main-0.9.1.hex', seed: 41, size: 94976 }] },
    { id: 'fdemo-display', name: 'Display Firmware', project: 'Smart Thermostat', board: 'tstat-display', via: 'passthrough', releases: [
      { id: 'rd-0', version: '1.4.0', state: 'released', days: 2, file: 'display-1.4.0.hex' }] }
  ];
  /* The demo's targets and their files, for the catalog the demo loaded (its boards and its display build). */
  function loadDemo(catalog) {
    var files = {};
    var all = DEMO_TARGETS.map(function (t) {
      return Promise.all(t.releases.map(function (d) {
        var bytes;
        if (t.via === 'passthrough') bytes = new TextEncoder().encode(catalog.demoDisplayHex());
        else {
          var b = catalog.boards[t.board], img = FL.catalog.makeImage(d.size, d.seed, b);
          bytes = /\.hex$/.test(d.file) ? new TextEncoder().encode(FL.files.toHex([{ addr: b.flash.base, data: img }])) : makeElf(b.flash.base, img);
        }
        return FL.image.sha256(bytes).then(function (sha) {
          var rel = { id: d.id, version: d.version, state: d.state, releasedAt: d.state === 'draft' ? '' : new Date(Date.now() - d.days * 86400000).toISOString().slice(0, 10),
            via: t.via, board: t.board, kind: d.file.split('.').pop(), size: bytes.length, sha256: sha, path: 'releases/' + t.id + '/' + d.id + '/release.json' };
          files[t.id + '/' + d.id] = { name: d.file, kind: rel.kind, bytes: bytes, sha256: sha, load: { via: t.via, board: t.board, base: '' } };
          if (d.state === 'withdrawn') rel.withdrawnWhy = 'The display flickers after an OTA reboot; use 0.9.0.';
          return rel;
        });
      })).then(function (rels) { return { repo: 'the demo', id: t.id, name: t.name, project: t.project, archived: false, releases: rels }; });
    });
    return Promise.all(all).then(function (targets) {
      return { targets: targets, errors: [], fte: true, demo: true,
        fetch: function (target, rel) { var f = files[target.id + '/' + rel.id]; return f ? Promise.resolve(Object.assign({}, f, { bytes: f.bytes.slice() })) : Promise.reject(new Error('Not in the demo.')); } };
    });
  }

  FL.fwr = { load: load, loadDemo: loadDemo, fetchRelease: fetchRelease, cleanRelease: cleanRelease, slim: slim, newerThan: newerThan,
    reviewUrl: reviewUrl, makeElf: makeElf, LABEL: LABEL, config: CFG };
})(window.FL = window.FL || {});
